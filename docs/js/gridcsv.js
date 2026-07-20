/* =============================================================================
 * gridcsv.js - CSV grid import/export for yard zones and dead spaces (PLAN.md
 * section 10 / tasks 56-60).
 *
 * A second, spreadsheet-based path alongside the freehand polygon tools: export
 * the yard as a 1-square-foot CSV grid, fill in cells by hand, re-upload, and
 * turn the grid back into yardZones/deadSpaces entries via rectangle
 * decomposition.
 *
 * This module is PURE: data in, data out, no DOM access, so it can be unit
 * tested in isolation the same way tests/ exercises the other pure modules. Its
 * Python twin is tests/test_gridcsv.py - change one side, change the other.
 *
 * Grid contract (PLAN.md 10.1): 1 cell = 1 square foot, W = round(widthFt),
 * H = round(heightFt). Row 1 is the header (blank corner, then 1..W). Row 2 is
 * the FAR/top edge (y = H); the last data row is y = 1, the near edge. This
 * mirrors canvas.js toPx's flip (pixel-up is feet-up), so the sheet reads the
 * same way the canvas draws.
 * ========================================================================== */

import { pointInPolygon } from "./coverage.js";
import { uid } from "./state.js";

// Mirrors canvas.js:49 AREA_PALETTE; kept as a local copy so this module stays
// DOM-free (importing canvas.js would pull in matchMedia at load). Keep the two
// in sync if the palette changes.
const AREA_PALETTE = ["#4caf50", "#2980b9", "#e67e22", "#8e44ad", "#16a085", "#c0392b"];

/* --------------------------------- export --------------------------------- */

// Quote a legend field only when it contains a comma, quote, or newline (RFC-4180
// style). Cell tokens never need quoting; only free-text names/labels can.
function csvField(s) {
  s = String(s == null ? "" : s);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Token for the cell whose center is (x-0.5, y-0.5) feet. Dead space wins over
// yard zone on overlap (matches renderZoneSummary's notDead()); first match in
// array order wins within each list (overlapping same-type shapes are lossy).
function cellToken(x, y, state) {
  const pt = [x - 0.5, y - 0.5];
  const ds = state.deadSpaces || [];
  for (let i = 0; i < ds.length; i++) {
    if (pointInPolygon(pt, ds[i].polygon)) return "d" + (i + 1);
  }
  const yz = state.yardZones || [];
  for (let i = 0; i < yz.length; i++) {
    if (pointInPolygon(pt, yz[i].polygon)) return "y" + (i + 1);
  }
  return "";
}

export function buildGridCsv(state) {
  const W = Math.round(state.yard.widthFt);
  const H = Math.round(state.yard.heightFt);
  const EOL = "\r\n";
  const lines = [];

  // Header row: blank corner, then 1..W.
  const header = [""];
  for (let x = 1; x <= W; x++) header.push(String(x));
  lines.push(header.join(","));

  // Data rows: y = H (far/top edge) down to y = 1 (near edge).
  for (let y = H; y >= 1; y--) {
    const row = [String(y)];
    for (let x = 1; x <= W; x++) row.push(cellToken(x, y, state));
    lines.push(row.join(","));
  }

  // Legend footer (export only; import ignores everything past row H+1). One
  // blank separator row, then one line per entry.
  lines.push("");
  (state.yardZones || []).forEach((z, i) => {
    lines.push("y" + (i + 1) + "," + csvField(z.name || ""));
  });
  (state.deadSpaces || []).forEach((d, i) => {
    lines.push("d" + (i + 1) + "," + csvField((d.label || "") + " (" + (d.kind || "other") + ")"));
  });

  return lines.join(EOL) + EOL;
}

/* --------------------------------- import --------------------------------- */

// Minimal RFC-4180-ish parse: splits into rows/fields honoring double-quoted
// fields (so a spreadsheet-quoted legend name won't derail the grid). Enough for
// import, where grid cells are simple y1/d2 tokens with no embedded commas.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else if (ch === "\r") {
      // swallow; the \n (or EOF below) closes the row
    } else {
      field += ch;
    }
  }
  // Flush the trailing field/row unless the text ended exactly on a newline.
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Split a token's cell set into 4-connected regions (flood fill). Genuinely
// disjoint blocks of the same token become separate objects; a single connected
// region always stays one object regardless of its shape (task 61). Returns an
// array of cell-sets, one per contiguous component.
function connectedComponents(cellSet) {
  const unvisited = new Set(cellSet);
  const comps = [];
  while (unvisited.size) {
    const start = unvisited.values().next().value;
    unvisited.delete(start);
    const comp = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const [x, y] = stack.pop().split(",").map(Number);
      for (const nk of [(x + 1) + "," + y, (x - 1) + "," + y, x + "," + (y + 1), x + "," + (y - 1)]) {
        if (unvisited.has(nk)) { unvisited.delete(nk); comp.add(nk); stack.push(nk); }
      }
    }
    comps.push(comp);
  }
  return comps;
}

// Shoelace SIGNED area (CCW positive). coverage.js's polygonAreaSqFt takes the
// absolute value, so it can't distinguish outer boundary (CCW) from hole (CW);
// this local helper keeps the sign for that test.
function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// Drop vertices where the path continues straight, so a run of grid cells along
// one edge collapses to a single segment (one corner) instead of one vertex per
// foot. Axis-aligned input, so "straight" is a zero cross product.
function collapseCollinear(pts) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (cross !== 0) out.push(cur); // keep only true corners
  }
  return out;
}

// Turn one 4-connected component's cell set into a single polygon ring via
// edge-cancellation boundary tracing (a standard raster-to-polygon technique).
// Interior shared edges cancel; the surviving directed edges form the outer
// boundary. Any hole (a dead space carved out, or blank/other-token cells inside
// the shape) is filled into the outer silhouette - the same "ignore holes"
// simplification task 58 already accepted, still safe because dead-space masking
// happens independently of yard-zone polygon shape everywhere it's used.
function traceComponent(cells) {
  const edges = new Set();
  const addEdge = (a, b) => {
    const key = a + ">" + b;
    const rev = b + ">" + a;
    if (edges.has(rev)) edges.delete(rev); // interior edge shared by two cells
    else edges.add(key);
  };
  for (const c of cells) {
    const [x, y] = c.split(",").map(Number);
    const bl = (x - 1) + "," + (y - 1), br = x + "," + (y - 1);
    const tr = x + "," + y, tl = (x - 1) + "," + y;
    addEdge(bl, br); // bottom
    addEdge(br, tr); // right
    addEdge(tr, tl); // top
    addEdge(tl, bl); // left
  }

  // Index surviving edges by start point, then chain them end-to-start into
  // closed loops (more than one loop only when the component has a hole).
  const startMap = new Map();
  for (const key of edges) {
    const [a] = key.split(">");
    if (!startMap.has(a)) startMap.set(a, []);
    startMap.get(a).push(key);
  }
  const remaining = new Set(edges);
  const loops = [];
  while (remaining.size) {
    let cur = remaining.values().next().value;
    const startPt = cur.split(">")[0];
    const ring = [];
    while (cur && remaining.has(cur)) {
      remaining.delete(cur);
      const end = cur.split(">")[1];
      ring.push(end.split(",").map(Number));
      if (end === startPt) break;
      const outs = startMap.get(end) || [];
      cur = outs.find((k) => remaining.has(k));
    }
    loops.push(ring);
  }

  // Keep the outer boundary (positive/CCW). A pinch that yields two positive
  // loops is a documented edge case: keep the larger by area.
  let best = null, bestArea = 0;
  for (const ring of loops) {
    const area = signedArea(ring);
    if (area > bestArea) { bestArea = area; best = ring; }
  }
  const corners = collapseCollinear(best || loops[0]);
  // Rotate to start at the bottom-left-most corner (min y, then min x) so the
  // output is deterministic: a rectangle reproduces the same vertex order as the
  // rest of the app's rect() helper, and round-trips stay stable.
  let mi = 0;
  for (let i = 1; i < corners.length; i++) {
    if (corners[i][1] < corners[mi][1] ||
        (corners[i][1] === corners[mi][1] && corners[i][0] < corners[mi][0])) mi = i;
  }
  return corners.slice(mi).concat(corners.slice(0, mi));
}

export function parseGridCsv(text, state) {
  const W = Math.round(state.yard.widthFt);
  const H = Math.round(state.yard.heightFt);

  const rows = parseCsv(text);
  if (!rows.length) throw new Error("The CSV file appears to be empty.");

  // File's apparent width: header cells after column A, trailing blanks trimmed.
  const headerCells = rows[0].slice(1);
  while (headerCells.length && String(headerCells[headerCells.length - 1]).trim() === "") headerCells.pop();
  const fileW = headerCells.length;

  // File's apparent height: leading data rows whose column A is a positive
  // integer (stops at the blank separator / legend, never scanning past it).
  let fileH = 0;
  for (let i = 1; i < rows.length; i++) {
    if (/^\d+$/.test(String(rows[i][0] || "").trim())) fileH++;
    else break;
  }

  if (fileW !== W) {
    throw new Error(`CSV is ${fileW} wide but the yard is set to ${W} ft wide. Resize the yard or fix the CSV, then re-upload.`);
  }
  if (fileH !== H) {
    throw new Error(`CSV is ${fileH} tall but the yard is set to ${H} ft tall. Resize the yard or fix the CSV, then re-upload.`);
  }

  // Header must read 1..W exactly.
  for (let x = 1; x <= W; x++) {
    if (String(headerCells[x - 1]).trim() !== String(x)) {
      throw new Error(`CSV header column ${x + 1} should be "${x}" but is "${String(headerCells[x - 1]).trim()}".`);
    }
  }
  // Column A must descend H..1 (row 2 = y=H, last data row = y=1).
  for (let r = 0; r < H; r++) {
    const expected = H - r;
    const label = String(rows[1 + r][0] || "").trim();
    if (label !== String(expected)) {
      throw new Error(`CSV row ${r + 2} should be labeled ${expected} in column A but is "${label}".`);
    }
  }

  // Validate every non-blank cell and build per-token cell sets.
  const masks = new Map(); // token -> Set of "x,y"
  for (let r = 0; r < H; r++) {
    const y = H - r;
    const row = rows[1 + r];
    for (let x = 1; x <= W; x++) {
      const raw = String(row[x] || "").trim();
      if (raw === "") continue;
      if (!/^[yd]\d+$/i.test(raw)) {
        throw new Error(`Cell at x=${x}, y=${y} has invalid value "${raw}". Use blank, a y<number> (yard zone), or a d<number> (dead space).`);
      }
      // Normalize case and any leading zeros: "Y01" -> "y1".
      const token = raw[0].toLowerCase() + String(parseInt(raw.slice(1), 10));
      if (!masks.has(token)) masks.set(token, new Set());
      masks.get(token).add(x + "," + y);
    }
  }

  // Sort tokens by numeric suffix ascending so numbering is stable across an
  // export/import/export round-trip.
  const yTokens = [];
  const dTokens = [];
  for (const token of masks.keys()) {
    const n = parseInt(token.slice(1), 10);
    if (token[0] === "y") yTokens.push(n); else dTokens.push(n);
  }
  yTokens.sort((a, b) => a - b);
  dTokens.sort((a, b) => a - b);

  const yardZones = [];
  for (const n of yTokens) {
    // One object per contiguous region (task 61); disjoint blocks still split.
    const comps = connectedComponents(masks.get("y" + n));
    // Preserve the current entry's name/color for this token number when it
    // exists (stable round-trip); default for a genuinely new number.
    const existing = (state.yardZones || [])[n - 1];
    const name = existing ? existing.name : "Area " + n;
    const color = (existing && existing.color) ? existing.color : AREA_PALETTE[(n - 1) % AREA_PALETTE.length];
    for (const comp of comps) {
      yardZones.push({ id: uid("yz"), name, color, polygon: traceComponent(comp) });
    }
  }

  const deadSpaces = [];
  for (const n of dTokens) {
    const comps = connectedComponents(masks.get("d" + n));
    const existing = (state.deadSpaces || [])[n - 1];
    const label = existing ? existing.label : "Dead space " + n;
    // The grid can't express `kind`; keep the existing kind or default to
    // "other" (editable afterward in the Dead spaces table).
    const kind = existing ? (existing.kind || "other") : "other";
    for (const comp of comps) {
      deadSpaces.push({ id: uid("ds"), label, kind, polygon: traceComponent(comp) });
    }
  }

  return { yardZones, deadSpaces };
}
