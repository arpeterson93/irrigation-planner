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

// Turn a token's cell set into 1+ axis-aligned rectangles via scanline run-merge
// (histogram rectangle decomposition): process y from H down to 1, match each
// row's contiguous x-runs against currently-open rectangles by (xStart,xEnd),
// extend matches, start new rectangles for unmatched runs, and close any open
// rectangle a row didn't touch. Handles disjoint blocks and holes automatically.
function decompose(cellSet, H) {
  const rects = [];
  let open = []; // { xStart, xEnd, yTop, yBot }
  for (let y = H; y >= 1; y--) {
    // Maximal contiguous x-runs present at this y.
    const present = [];
    for (const key of cellSet) {
      const parts = key.split(",");
      if (Number(parts[1]) === y) present.push(Number(parts[0]));
    }
    present.sort((a, b) => a - b);
    const runs = [];
    for (let k = 0; k < present.length; k++) {
      const start = present[k];
      let end = start;
      while (k + 1 < present.length && present[k + 1] === end + 1) { end = present[++k]; }
      runs.push([start, end]);
    }

    const newOpen = [];
    const matched = new Set();
    for (const [rs, re] of runs) {
      let found = -1;
      for (let i = 0; i < open.length; i++) {
        if (!matched.has(i) && open[i].xStart === rs && open[i].xEnd === re) { found = i; break; }
      }
      if (found >= 0) {
        matched.add(found);
        open[found].yBot = y; // extend downward
        newOpen.push(open[found]);
      } else {
        newOpen.push({ xStart: rs, xEnd: re, yTop: y, yBot: y });
      }
    }
    // Close any open rectangle this row didn't continue.
    for (let i = 0; i < open.length; i++) {
      if (!matched.has(i)) rects.push(open[i]);
    }
    open = newOpen;
  }
  for (const o of open) rects.push(o);
  return rects;
}

// Cell column c spans feet [c-1, c]; likewise rows. A rectangle covering columns
// xStart..xEnd and rows yBot..yTop spans feet [xStart-1, xEnd] x [yBot-1, yTop].
function rectPolygon(rc) {
  const x0 = rc.xStart - 1, x1 = rc.xEnd;
  const y0 = rc.yBot - 1, y1 = rc.yTop;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
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
    const rects = decompose(masks.get("y" + n), H);
    // Preserve the current entry's name/color for this token number when it
    // exists (stable round-trip); default for a genuinely new number.
    const existing = (state.yardZones || [])[n - 1];
    const name = existing ? existing.name : "Area " + n;
    const color = (existing && existing.color) ? existing.color : AREA_PALETTE[(n - 1) % AREA_PALETTE.length];
    for (const rc of rects) {
      yardZones.push({ id: uid("yz"), name, color, polygon: rectPolygon(rc) });
    }
  }

  const deadSpaces = [];
  for (const n of dTokens) {
    const rects = decompose(masks.get("d" + n), H);
    const existing = (state.deadSpaces || [])[n - 1];
    const label = existing ? existing.label : "Dead space " + n;
    // The grid can't express `kind`; keep the existing kind or default to
    // "other" (editable afterward in the Dead spaces table).
    const kind = existing ? (existing.kind || "other") : "other";
    for (const rc of rects) {
      deadSpaces.push({ id: uid("ds"), label, kind, polygon: rectPolygon(rc) });
    }
  }

  return { yardZones, deadSpaces };
}
