/* =============================================================================
 * canvas.js - yard preview rendering + interaction, coverage heatmap rendering.
 *
 * THE Y-FLIP LIVES HERE. State stores yard feet with a bottom-left origin (y up).
 * This module is the only place that converts to screen pixels (y down):
 *     screenY = offY + (yard.heightFt - y) * scale
 * Everything drawn goes through that flip (toPx); every pointer position comes
 * back through the inverse (fromPx), so the model never sees canvas coordinates.
 *
 * Phase 2 adds the interaction engine (PLAN.md tasks 11-14):
 *   - drag-to-move heads (mouse + touch via Pointer Events)
 *   - radius + arc-start/arc-end drag handles on the selected head, with snapping
 *     (1 ft position/radius, 5 degrees arc) and Alt for free movement
 *   - polygon drawing/editing for yard zones (tinted) and dead spaces (hatched)
 *   - background reference image: upload/compress, opacity, rotation, drag,
 *     two-point scale calibration
 * ========================================================================== */

import { getState, saveState, zoneColorFor, fmt, uid, clamp } from "./state.js";
import { arcSpan, headPrecipRate, colorForValue, norm360, bearingTo } from "./coverage.js";
import { isCoarse, isNarrow } from "./viewport.js";

/* ------------------------------- module state ----------------------------- */

let deps = { getSelectedHeadId: () => null, selectHead: () => {}, refreshTables: () => {} };
let lastHeatData = null;
let mode = "select"; // select | yardzone | deadspace | calibrate | bgmove
let tf = { scale: 1, offX: 0, offY: 0 }; // current yard-canvas transform
let drag = null;
let draftPolygon = null;    // { kind, points: [[x,y],...] } while drawing
let calibPoints = [];       // yard-feet points collected during calibration
let selectedArea = null;    // { kind:'yardzone'|'deadspace', id }
const bgCache = { url: null, img: null };

// Hit-target sizes are chosen once at module load from the pointer type
// (PLAN.md task 47): coarse (touch) fingertips need bigger slop than a mouse.
// Fine pointers resolve to the historical 12/10/10, so desktop is unchanged.
const COARSE_POINTER = isCoarse();
const HANDLE_HIT_PX = COARSE_POINTER ? 22 : 12;
const HEAD_HIT_PX = COARSE_POINTER ? 18 : 10;
const VERTEX_HIT_PX = COARSE_POINTER ? 18 : 10;
// Drawn markers scale up on coarse pointers so the visible target matches the
// (larger) hit target; 1x on fine pointers keeps desktop pixel-identical.
const MARKER_SCALE = COARSE_POINTER ? 1.5 : 1;
// Static canvas heights from the HTML attributes; restored above the narrow
// breakpoint so rotating a tablet back across it returns to the desktop size.
const YARD_CANVAS_H = 560;
const HEAT_CANVAS_H = 480;
const AREA_PALETTE = ["#4caf50", "#2980b9", "#e67e22", "#8e44ad", "#16a085", "#c0392b"];

// Aspect-fit canvas height for narrow viewports (PLAN.md task 45): match the
// yard's aspect ratio inside the available width, bounded so it neither
// collapses nor eats the whole screen. Mirrors computeTransform's 20px margin.
function responsiveCanvasHeight(canvas, staticH) {
  if (!isNarrow()) return staticH;
  const yard = getState().yard;
  const inner = (canvas.clientWidth || canvas.width) - 20;
  const fit = Math.round(inner * yard.heightFt / yard.widthFt) + 20;
  return clamp(fit, 240, Math.round(window.innerHeight * 0.65));
}

export function initCanvas(d) {
  deps = Object.assign(deps, d || {});
  attachYardInteractions();
  attachHeatHover();
  window.addEventListener("keydown", onKeyDown);
}

export function getMode() { return mode; }
export function setMode(m) {
  mode = m;
  // Leaving/entering a mode abandons any in-progress draft.
  draftPolygon = null;
  calibPoints = [];
  if (m !== "select") selectedArea = null;
  const tip = document.getElementById("yardTip");
  if (tip) tip.style.display = "none";
  drawYardCanvas();
}

/* --------------------------- coordinate transform ------------------------- */

function computeTransform(canvas) {
  const state = getState();
  const w = state.yard.widthFt, h = state.yard.heightFt;
  const availW = canvas.clientWidth || canvas.width;
  const availH = canvas.height;
  const scale = Math.min((availW - 20) / w, (availH - 20) / h);
  tf = { scale, offX: (availW - w * scale) / 2, offY: (availH - h * scale) / 2 };
  return tf;
}

function toPx(x, y) {
  const h = getState().yard.heightFt;
  return [tf.offX + x * tf.scale, tf.offY + (h - y) * tf.scale];
}
function fromPx(px, py) {
  const h = getState().yard.heightFt;
  return [(px - tf.offX) / tf.scale, h - (py - tf.offY) / tf.scale];
}
function pointerFeet(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return fromPx(e.clientX - rect.left, e.clientY - rect.top);
}

/* ------------------------------- geometry --------------------------------- */

function bearingPointFeet(head, r, bearingDeg) {
  const b = bearingDeg * Math.PI / 180;
  return [head.x + r * Math.sin(b), head.y + r * Math.cos(b)];
}
function headHandlesPx(head) {
  const span = arcSpan(head.arcStartDeg, head.arcEndDeg);
  const mid = head.arcStartDeg + span / 2;
  return {
    radius: toPx(...bearingPointFeet(head, head.radiusFt, mid)),
    arcStart: toPx(...bearingPointFeet(head, head.radiusFt, head.arcStartDeg)),
    arcEnd: toPx(...bearingPointFeet(head, head.radiusFt, head.arcEndDeg)),
  };
}
function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > pt[1]) !== (yj > pt[1])) &&
      (pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function centroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}
function snap(v, step, free) { return free ? v : Math.round(v / step) * step; }
function snapAngle(v, free) { return free ? norm360(v) : norm360(Math.round(v / 5) * 5); }

function allAreas() {
  const s = getState();
  return [
    ...s.yardZones.map((z) => ({ kind: "yardzone", obj: z })),
    ...s.deadSpaces.map((d) => ({ kind: "deadspace", obj: d })),
  ];
}

/* -------------------------------- rendering ------------------------------- */

export function drawYardCanvas() {
  const state = getState();
  const canvas = document.getElementById("yardCanvas");
  if (!canvas || !canvas.offsetParent) return;
  canvas.width = canvas.clientWidth;
  canvas.height = responsiveCanvasHeight(canvas, YARD_CANVAS_H);
  const ctx = canvas.getContext("2d");
  computeTransform(canvas);
  const selId = deps.getSelectedHeadId();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const w = state.yard.widthFt, h = state.yard.heightFt;
  const boxW = w * tf.scale, boxH = h * tf.scale;

  drawBackground(ctx);

  ctx.fillStyle = state.background.imageDataUrl ? "rgba(244,250,246,0.15)" : "#f4faf6";
  ctx.fillRect(tf.offX, tf.offY, boxW, boxH);
  ctx.strokeStyle = "#8fb8a0"; ctx.lineWidth = 1.5;
  ctx.strokeRect(tf.offX, tf.offY, boxW, boxH);

  const gridToggle = document.getElementById("toggleGrid");
  if (gridToggle && gridToggle.checked) {
    ctx.strokeStyle = "rgba(140,170,150,.25)"; ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += 10) line(ctx, toPx(x, 0), toPx(x, h));
    for (let y = 0; y <= h; y += 10) line(ctx, toPx(0, y), toPx(w, y));
  }

  drawAreas(ctx);
  drawHeads(ctx, selId);
  if (selId && mode === "select") drawHandles(ctx, state.heads.find((x) => x.id === selId));
  drawDraft(ctx);
  drawCalibration(ctx);
}

function line(ctx, a, b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
function pathPolygon(ctx, ptsPx) {
  ctx.beginPath();
  ptsPx.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function drawBackground(ctx) {
  const bg = getState().background;
  if (!bg.imageDataUrl) return;
  const img = ensureBgImage(bg.imageDataUrl);
  if (!img || !img.complete || !img.naturalWidth) return;
  const sfp = bg.scaleFtPerPx || (getState().yard.widthFt / img.naturalWidth);
  const wFt = img.naturalWidth * sfp, hFt = img.naturalHeight * sfp;
  const [tlx, tly] = toPx(bg.offsetXFt, bg.offsetYFt + hFt); // image top-left on screen
  const wPx = wFt * tf.scale, hPx = hFt * tf.scale;
  ctx.save();
  ctx.globalAlpha = bg.opacity == null ? 0.5 : bg.opacity;
  if (bg.rotationDeg) {
    const cx = tlx + wPx / 2, cy = tly + hPx / 2;
    ctx.translate(cx, cy); ctx.rotate(bg.rotationDeg * Math.PI / 180); ctx.translate(-cx, -cy);
  }
  ctx.drawImage(img, tlx, tly, wPx, hPx);
  ctx.restore();
}

function ensureBgImage(url) {
  if (bgCache.url === url && bgCache.img) return bgCache.img;
  const img = new Image();
  img.onload = () => drawYardCanvas();
  img.src = url;
  bgCache.url = url; bgCache.img = img;
  return img;
}

function drawAreas(ctx) {
  const state = getState();
  state.yardZones.forEach((z) => {
    const ptsPx = z.polygon.map(([x, y]) => toPx(x, y));
    if (ptsPx.length < 2) return;
    const sel = selectedArea && selectedArea.kind === "yardzone" && selectedArea.id === z.id;
    pathPolygon(ctx, ptsPx);
    ctx.fillStyle = hexA(z.color || "#4caf50", 0.16); ctx.fill();
    ctx.strokeStyle = z.color || "#4caf50"; ctx.lineWidth = sel ? 3 : 1.8; ctx.stroke();
    label(ctx, centroid(ptsPx), z.name || "Zone", z.color || "#2c3e50");
    if (sel) drawVertices(ctx, ptsPx, z.color || "#4caf50");
  });
  state.deadSpaces.forEach((d) => {
    const ptsPx = d.polygon.map(([x, y]) => toPx(x, y));
    if (ptsPx.length < 2) return;
    const sel = selectedArea && selectedArea.kind === "deadspace" && selectedArea.id === d.id;
    pathPolygon(ctx, ptsPx);
    ctx.fillStyle = "rgba(120,130,125,0.12)"; ctx.fill();
    drawHatch(ctx, ptsPx);
    ctx.strokeStyle = "#7f8c8d"; ctx.lineWidth = sel ? 3 : 1.4; pathPolygon(ctx, ptsPx); ctx.stroke();
    label(ctx, centroid(ptsPx), d.label || d.kind || "Dead space", "#3c4a44");
    if (sel) drawVertices(ctx, ptsPx, "#7f8c8d");
  });
}

function drawHatch(ctx, ptsPx) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of ptsPx) { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
  ctx.save();
  pathPolygon(ctx, ptsPx); ctx.clip();
  ctx.strokeStyle = "rgba(90,100,95,0.45)"; ctx.lineWidth = 1;
  const span = maxy - miny;
  for (let x0 = minx - span; x0 < maxx; x0 += 8) {
    ctx.beginPath(); ctx.moveTo(x0, miny); ctx.lineTo(x0 + span, maxy); ctx.stroke();
  }
  ctx.restore();
}

function drawVertices(ctx, ptsPx, color) {
  const half = 4 * MARKER_SCALE;
  ptsPx.forEach(([x, y]) => {
    ctx.beginPath(); ctx.rect(x - half, y - half, half * 2, half * 2);
    ctx.fillStyle = "#fff"; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  });
}

function label(ctx, [x, y], text, color) {
  ctx.font = "600 11px sans-serif"; ctx.fillStyle = color;
  ctx.textAlign = "center"; ctx.fillText(text, x, y);
  ctx.textAlign = "start";
}

function drawHeads(ctx, selId) {
  const state = getState();
  const radiusToggle = document.getElementById("toggleRadius");
  const showRadius = radiusToggle ? radiusToggle.checked : true;
  state.heads.forEach((head) => {
    const [hx, hy] = toPx(head.x, head.y);
    const r = head.radiusFt * tf.scale;
    const color = zoneColorFor(head.sprinklerZoneId);
    const isSel = head.id === selId;
    if (showRadius) {
      ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.globalAlpha = 0.25; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
    }
    const startCanvas = (head.arcStartDeg - 90) * Math.PI / 180;
    const span = arcSpan(head.arcStartDeg, head.arcEndDeg);
    const endCanvas = ((head.arcStartDeg + span) - 90) * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.arc(hx, hy, r, startCanvas, endCanvas, false); ctx.closePath();
    ctx.fillStyle = color; ctx.globalAlpha = isSel ? 0.42 : 0.22; ctx.fill(); ctx.globalAlpha = 1;
    if (head.needsReplacement) {
      ctx.beginPath(); ctx.arc(hx, hy, (isSel ? 6 : 4) + 4, 0, Math.PI * 2);
      ctx.strokeStyle = "#d98c1a"; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(hx, hy, isSel ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = isSel ? "#1a2420" : color; ctx.fill();
    if (isSel) { ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke(); }
    ctx.fillStyle = "#1a2420"; ctx.font = "11px sans-serif";
    ctx.fillText(head.id + (head.needsReplacement ? " ⚠" : ""), hx + 7, hy - 7);
  });
}

function drawHandles(ctx, head) {
  if (!head) return;
  const hs = headHandlesPx(head);
  const draw = (p, fill) => {
    ctx.beginPath(); ctx.arc(p[0], p[1], 6 * MARKER_SCALE, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
  };
  const [hx, hy] = toPx(head.x, head.y);
  ctx.setLineDash([4, 3]); ctx.strokeStyle = "#647169"; ctx.lineWidth = 1;
  line(ctx, [hx, hy], hs.radius); ctx.setLineDash([]);
  draw(hs.radius, "#238a53");   // radius handle (green)
  draw(hs.arcStart, "#1c6fa8"); // arc start (blue)
  draw(hs.arcEnd, "#d98c1a");   // arc end (amber)
}

function drawDraft(ctx) {
  if (!draftPolygon) return;
  const ptsPx = draftPolygon.points.map(([x, y]) => toPx(x, y));
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = draftPolygon.kind === "deadspace" ? "#7f8c8d" : "#238a53";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ptsPx.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.setLineDash([]);
  ptsPx.forEach(([x, y], i) => {
    ctx.beginPath(); ctx.arc(x, y, i === 0 ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? "#238a53" : "#fff";
    ctx.fill(); ctx.strokeStyle = "#238a53"; ctx.lineWidth = 1.5; ctx.stroke();
  });
}

function drawCalibration(ctx) {
  if (mode !== "calibrate" || calibPoints.length === 0) return;
  const ptsPx = calibPoints.map(([x, y]) => toPx(x, y));
  ctx.strokeStyle = "#c0392b"; ctx.lineWidth = 2;
  if (ptsPx.length === 2) line(ctx, ptsPx[0], ptsPx[1]);
  ptsPx.forEach((p) => {
    ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, Math.PI * 2);
    ctx.fillStyle = "#c0392b"; ctx.fill();
  });
}

/* ------------------------------ interaction ------------------------------- */

function attachYardInteractions() {
  const canvas = document.getElementById("yardCanvas");
  const tip = document.getElementById("yardTip");
  if (!canvas) return;
  canvas.style.touchAction = "none"; // let Pointer Events own drag gestures

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [fx, fy] = pointerFeet(canvas, e);
    if (mode === "select") return onSelectDown(canvas, e, fx, fy);
    if (mode === "yardzone" || mode === "deadspace") return onDrawDown(fx, fy);
    if (mode === "calibrate") return onCalibrateDown(fx, fy);
    if (mode === "bgmove") return onBgDown(fx, fy);
  });

  canvas.addEventListener("pointermove", (e) => {
    const [fx, fy] = pointerFeet(canvas, e);
    if (drag) { onDragMove(fx, fy, e.altKey); return; }
    if (mode === "select") updateHoverTip(canvas, tip, e);
  });

  const end = (e) => {
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (drag) { drag = null; saveState(); deps.refreshTables(); }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  canvas.addEventListener("dblclick", (e) => {
    const [fx, fy] = pointerFeet(canvas, e);
    if (mode === "yardzone" || mode === "deadspace") { closeDraft(); return; }
    if (mode === "select") { const v = hitVertexPx(canvas, e); if (v) deleteVertex(v); }
  });
}

function onSelectDown(canvas, e, fx, fy) {
  const selId = deps.getSelectedHeadId();
  const head = getState().heads.find((x) => x.id === selId);
  // 1) handles on the already-selected head
  if (head) {
    const h = handleAtPx(canvas, e, head);
    if (h) { drag = { kind: h, headId: head.id }; return; }
  }
  // 2) a head marker
  const hit = headAtPx(canvas, e);
  if (hit) {
    deps.selectHead(hit.id);
    const grabF = pointerFeet(canvas, e);
    drag = { kind: "move", headId: hit.id, dx: grabF[0] - hit.x, dy: grabF[1] - hit.y };
    return;
  }
  // 3) a polygon vertex
  const v = hitVertexPx(canvas, e);
  if (v) { drag = { kind: "vertex", area: v }; selectedArea = { kind: v.kind, id: v.id }; drawYardCanvas(); return; }
  // 4) inside a polygon -> select that area
  const area = areaAt([fx, fy]);
  selectedArea = area ? { kind: area.kind, id: area.obj.id } : null;
  if (deps.getSelectedHeadId()) deps.selectHead(null);
  drawYardCanvas();
}

function onDragMove(fx, fy, alt) {
  const state = getState();
  if (drag.kind === "vertex") {
    const poly = polyFor(drag.area);
    if (poly) poly[drag.area.index] = [snap(fx, 1, alt), snap(fy, 1, alt)];
    drawYardCanvas(); return;
  }
  if (drag.kind === "bg") {
    state.background.offsetXFt = snap(fx - drag.dx, 1, alt);
    state.background.offsetYFt = snap(fy - drag.dy, 1, alt);
    drawYardCanvas(); return;
  }
  const head = state.heads.find((x) => x.id === drag.headId);
  if (!head) return;
  if (drag.kind === "move") {
    head.x = snap(fx - drag.dx, 1, alt);
    head.y = snap(fy - drag.dy, 1, alt);
  } else if (drag.kind === "radius") {
    head.radiusFt = Math.max(0, snap(Math.hypot(fx - head.x, fy - head.y), 1, alt));
  } else if (drag.kind === "arcStart") {
    head.arcStartDeg = snapAngle(bearingTo(fx - head.x, fy - head.y), alt);
  } else if (drag.kind === "arcEnd") {
    head.arcEndDeg = snapAngle(bearingTo(fx - head.x, fy - head.y), alt);
  }
  drawYardCanvas();
}

function onDrawDown(fx, fy) {
  if (!draftPolygon) draftPolygon = { kind: mode, points: [] };
  const pts = draftPolygon.points;
  const [pxN, pyN] = toPx(fx, fy);
  // clicking near the first vertex closes the polygon
  if (pts.length >= 3) {
    const [px0, py0] = toPx(...pts[0]);
    if (Math.hypot(pxN - px0, pyN - py0) < VERTEX_HIT_PX) { closeDraft(); return; }
  }
  // ignore a click coincident with the last vertex (e.g. the second down of a
  // double-click, which is handled by the dblclick->close path instead)
  if (pts.length) {
    const [pxL, pyL] = toPx(...pts[pts.length - 1]);
    if (Math.hypot(pxN - pxL, pyN - pyL) < VERTEX_HIT_PX) return;
  }
  pts.push([Math.round(fx), Math.round(fy)]); // 1 ft grid for polygon vertices
  drawYardCanvas();
}

function closeDraft() {
  if (!draftPolygon || draftPolygon.points.length < 3) { draftPolygon = null; drawYardCanvas(); return; }
  const state = getState();
  if (draftPolygon.kind === "yardzone") {
    const color = AREA_PALETTE[state.yardZones.length % AREA_PALETTE.length];
    state.yardZones.push({ id: uid("yz"), name: "Area " + (state.yardZones.length + 1), color, polygon: draftPolygon.points });
  } else {
    state.deadSpaces.push({ id: uid("ds"), label: "Dead space " + (state.deadSpaces.length + 1), kind: "other", polygon: draftPolygon.points });
  }
  draftPolygon = null;
  mode = "select";
  saveState();
  deps.refreshTables();
  drawYardCanvas();
}

function onCalibrateDown(fx, fy) {
  calibPoints.push([fx, fy]);
  if (calibPoints.length === 2) {
    const distFt = Math.hypot(calibPoints[1][0] - calibPoints[0][0], calibPoints[1][1] - calibPoints[0][1]);
    const answer = prompt("Real-world distance between the two points, in feet:");
    const known = parseFloat(answer);
    const bg = getState().background;
    if (known > 0 && distFt > 0 && bg.imageDataUrl) {
      const img = ensureBgImage(bg.imageDataUrl);
      const oldSfp = bg.scaleFtPerPx || (getState().yard.widthFt / (img.naturalWidth || 1));
      const factor = known / distFt;
      // scale the image so the measured span equals `known` ft, keeping point A fixed
      const a = calibPoints[0];
      bg.offsetXFt = a[0] - factor * (a[0] - bg.offsetXFt);
      bg.offsetYFt = a[1] - factor * (a[1] - bg.offsetYFt);
      bg.scaleFtPerPx = oldSfp * factor;
      saveState();
    } else if (!bg.imageDataUrl) {
      alert("Upload a background image before calibrating its scale.");
    }
    calibPoints = [];
    mode = "select";
    deps.refreshTables();
  }
  drawYardCanvas();
}

function onBgDown(fx, fy) {
  const bg = getState().background;
  if (!bg.imageDataUrl) { alert("Upload a background image first."); return; }
  drag = { kind: "bg", dx: fx - bg.offsetXFt, dy: fy - bg.offsetYFt };
}

/* ------------------------------- hit tests -------------------------------- */

function localXY(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}
function headAtPx(canvas, e) {
  const [mx, my] = localXY(canvas, e);
  for (const head of getState().heads) {
    const [hx, hy] = toPx(head.x, head.y);
    if (Math.hypot(mx - hx, my - hy) < HEAD_HIT_PX) return head;
  }
  return null;
}
function handleAtPx(canvas, e, head) {
  const [mx, my] = localXY(canvas, e);
  const hs = headHandlesPx(head);
  for (const key of ["radius", "arcStart", "arcEnd"]) {
    if (Math.hypot(mx - hs[key][0], my - hs[key][1]) < HANDLE_HIT_PX) return key;
  }
  return null;
}
function hitVertexPx(canvas, e) {
  const [mx, my] = localXY(canvas, e);
  for (const { kind, obj } of allAreas()) {
    for (let i = 0; i < obj.polygon.length; i++) {
      const [px, py] = toPx(...obj.polygon[i]);
      if (Math.hypot(mx - px, my - py) < VERTEX_HIT_PX) return { kind, id: obj.id, index: i };
    }
  }
  return null;
}
function areaAt(ptFeet) {
  // dead space wins over yard zone (PLAN.md 6.6)
  const s = getState();
  for (const d of s.deadSpaces) if (pointInPolygon(ptFeet, d.polygon)) return { kind: "deadspace", obj: d };
  for (const z of s.yardZones) if (pointInPolygon(ptFeet, z.polygon)) return { kind: "yardzone", obj: z };
  return null;
}
function polyFor(area) {
  const obj = (area.kind === "yardzone" ? getState().yardZones : getState().deadSpaces).find((o) => o.id === area.id);
  return obj ? obj.polygon : null;
}

function deleteVertex(v) {
  const list = v.kind === "yardzone" ? getState().yardZones : getState().deadSpaces;
  const obj = list.find((o) => o.id === v.id);
  if (!obj) return;
  if (obj.polygon.length <= 3) {
    // deleting would leave a degenerate polygon: remove the whole area
    const idx = list.indexOf(obj); list.splice(idx, 1);
    selectedArea = null;
  } else {
    obj.polygon.splice(v.index, 1);
  }
  saveState(); deps.refreshTables(); drawYardCanvas();
}

function onKeyDown(e) {
  if (e.key === "Escape") {
    if (draftPolygon || calibPoints.length) { draftPolygon = null; calibPoints = []; mode = "select"; deps.refreshTables(); drawYardCanvas(); }
  } else if ((e.key === "Delete" || e.key === "Backspace") && selectedArea) {
    const t = document.activeElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    deleteArea(selectedArea.kind, selectedArea.id);
  }
}

export function deleteArea(kind, id) {
  const state = getState();
  if (kind === "yardzone") state.yardZones = state.yardZones.filter((z) => z.id !== id);
  else state.deadSpaces = state.deadSpaces.filter((d) => d.id !== id);
  if (selectedArea && selectedArea.id === id) selectedArea = null;
  saveState(); deps.refreshTables(); drawYardCanvas();
}

function updateHoverTip(canvas, tip, e) {
  if (!tip) return;
  const hit = headAtPx(canvas, e);
  const [mx, my] = localXY(canvas, e);
  if (hit) {
    tip.style.display = "block"; tip.style.left = mx + "px"; tip.style.top = my + "px";
    const flag = hit.needsReplacement ? " · needs replacement" : "";
    tip.textContent = `${hit.id} · ${hit.ratedGpm} GPM · r=${hit.radiusFt}ft · ${fmt(headPrecipRate(hit), 2)} in/hr${flag}`;
  } else {
    tip.style.display = "none";
  }
}

/* --------------------------- background helpers ---------------------------- */

// Downscale + JPEG-compress an uploaded image to keep localStorage small
// (PLAN.md 1.3: max ~1600px long edge, quality ~0.8).
export function compressImageFile(file, maxEdge = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
        const cw = Math.max(1, Math.round(img.naturalWidth * scale));
        const ch = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas"); c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(img, 0, 0, cw, ch);
        resolve({ dataUrl: c.toDataURL("image/jpeg", quality), width: cw, height: ch });
      };
      img.onerror = reject; img.src = fr.result;
    };
    fr.onerror = reject; fr.readAsDataURL(file);
  });
}

/* -------------------------------- heatmap --------------------------------- */

export function drawHeatmap(data) {
  const state = getState();
  const canvas = document.getElementById("heatCanvas");
  if (!canvas || !canvas.offsetParent) return;
  lastHeatData = data;
  canvas.width = canvas.clientWidth;
  canvas.height = responsiveCanvasHeight(canvas, HEAT_CANVAS_H);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const filterEl = document.getElementById("coverageZoneFilter");
  const filter = filterEl ? filterEl.value : "all";
  const grid = filter === "all" ? data.grid : (data.zoneGrids[filter] || data.grid);

  const w = state.yard.widthFt, h = state.yard.heightFt;
  const availW = canvas.clientWidth || canvas.width, availH = canvas.height;
  const scale = Math.min((availW - 20) / w, (availH - 20) / h);
  const offX = (availW - w * scale) / 2, offY = (availH - h * scale) / 2;
  const cellPx = data.cell * scale;

  const targets = state.sprinklerZones.filter((z) => z.weeklyTargetIn > 0).map((z) => z.weeklyTargetIn);
  const targetRef = targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : 1.0;
  // Per-cycle color reference: target depth divided by the average cycles/week
  // across zones (schedules now vary per zone, so there's no single global input).
  const cyclesVals = Object.values(data.zoneCycles || {}).filter((v) => v > 0);
  const avgCycles = cyclesVals.length ? cyclesVals.reduce((a, b) => a + b, 0) / cyclesVals.length : 3.5;
  const ref = (targetRef / avgCycles) || 0.3;

  // Paint the water-depth color for EVERY cell, including dead-space cells, so you
  // can see how much water is landing where it shouldn't (PLAN.md task 33). Dead
  // cells are then overlaid with a diagonal hatch (below); they remain excluded
  // from coverage.js stats/rollups, this is rendering-only.
  for (let r = 0; r < data.rows; r++) {
    for (let c = 0; c < data.cols; c++) {
      const x = offX + c * cellPx;
      const y = offY + (data.rows - 1 - r) * cellPx; // y-flip: grid row 0 is bottom
      ctx.fillStyle = colorForValue(grid[r][c], ref);
      ctx.fillRect(x, y, cellPx + 0.5, cellPx + 0.5);
    }
  }
  if (data.deadMask) {
    ctx.save();
    ctx.fillStyle = deadHatchPattern(ctx);
    for (let r = 0; r < data.rows; r++) {
      for (let c = 0; c < data.cols; c++) {
        if (!data.deadMask[r][c]) continue;
        const x = offX + c * cellPx;
        const y = offY + (data.rows - 1 - r) * cellPx;
        ctx.fillRect(x, y, cellPx + 0.5, cellPx + 0.5);
      }
    }
    ctx.restore();
  }
  ctx.strokeStyle = "#8fb8a0"; ctx.lineWidth = 1.5;
  ctx.strokeRect(offX, offY, data.cols * cellPx, data.rows * cellPx);

  canvas._grid = grid; canvas._offX = offX; canvas._offY = offY;
  canvas._cellPx = cellPx; canvas._data = data;
}

// Diagonal-hatch pattern for dead-space cells on the heatmap, built once from a
// small offscreen tile (~8px repeat, semi-transparent gray) so the underlying
// water-depth color reads through (PLAN.md task 33).
let hatchPattern = null;
function deadHatchPattern(ctx) {
  if (hatchPattern) return hatchPattern;
  const size = 8;
  const off = document.createElement("canvas");
  off.width = size; off.height = size;
  const octx = off.getContext("2d");
  octx.strokeStyle = "rgba(70,80,75,0.55)";
  octx.lineWidth = 1.5;
  octx.beginPath();
  octx.moveTo(0, size); octx.lineTo(size, 0);            // main diagonal
  octx.moveTo(-2, 2); octx.lineTo(2, -2);                // corner wraps for a seamless tile
  octx.moveTo(size - 2, size + 2); octx.lineTo(size + 2, size - 2);
  octx.stroke();
  hatchPattern = ctx.createPattern(off, "repeat");
  return hatchPattern;
}

export function redrawHeatmap() { if (lastHeatData) drawHeatmap(lastHeatData); }
export function getLastHeatData() { return lastHeatData; }

function attachHeatHover() {
  const canvas = document.getElementById("heatCanvas");
  const tip = document.getElementById("heatTip");
  if (!canvas || !tip) return;
  canvas.addEventListener("mousemove", (e) => {
    if (!canvas._grid) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const c = Math.floor((mx - canvas._offX) / canvas._cellPx);
    const screenRow = Math.floor((my - canvas._offY) / canvas._cellPx);
    const r = canvas._data.rows - 1 - screenRow;
    if (r < 0 || c < 0 || r >= canvas._data.rows || c >= canvas._data.cols) { tip.style.display = "none"; return; }
    const v = canvas._grid[r][c];
    const dead = canvas._data.deadMask && canvas._data.deadMask[r] && canvas._data.deadMask[r][c];
    tip.style.display = "block"; tip.style.left = mx + "px"; tip.style.top = my + "px";
    tip.textContent = `${fmt(v, 3)} in this cycle${dead ? " (dead space)" : ""}`;
  });
  canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}

/* ------------------------------- color util ------------------------------- */

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(76,175,80,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
