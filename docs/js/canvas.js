/* =============================================================================
 * canvas.js - yard preview + coverage heatmap rendering, coordinate transforms,
 * hover tooltips.
 *
 * THE Y-FLIP LIVES HERE. State stores yard feet with a bottom-left origin (y up).
 * This module is the only place that converts to screen pixels (y down):
 *     screenY = offY + (yard.heightFt - y) * scale
 * Everything drawn - heads, arcs, grid, heatmap cells - goes through that flip so
 * the picture matches the original top-left-origin app pixel-for-pixel after a
 * v1->v2 migration.
 *
 * Phase 1 keeps v1's interaction model (hover tooltip only). Drag-to-move and
 * hit-testing arrive in Phase 2 (tasks 11-13).
 * ========================================================================== */

import { getState, zoneColorFor, fmt } from "./state.js";
import { arcSpan, headPrecipRate, colorForValue } from "./coverage.js";

let getSelectedHeadId = () => null;
let lastHeatData = null;

export function initCanvas(deps) {
  if (deps && deps.getSelectedHeadId) getSelectedHeadId = deps.getSelectedHeadId;
  attachYardHover();
  attachHeatHover();
}

/* --------------------------- coordinate transform ------------------------- */

function canvasScale(canvas) {
  const state = getState();
  const w = state.yard.widthFt, h = state.yard.heightFt;
  const availW = canvas.clientWidth || canvas.width;
  const availH = canvas.height;
  const scale = Math.min((availW - 20) / w, (availH - 20) / h);
  const offX = (availW - w * scale) / 2;
  const offY = (availH - h * scale) / 2;
  return { scale, offX, offY };
}

// Yard feet (bottom-left origin, y up) -> screen pixels (y down).
function makeToPx(offX, offY, scale) {
  const h = getState().yard.heightFt;
  return (x, y) => [offX + x * scale, offY + (h - y) * scale];
}

/* ------------------------------ yard canvas ------------------------------- */

export function drawYardCanvas() {
  const state = getState();
  const canvas = document.getElementById("yardCanvas");
  if (!canvas || !canvas.offsetParent) return; // hidden tab
  canvas.width = canvas.clientWidth;
  const ctx = canvas.getContext("2d");
  const { scale, offX, offY } = canvasScale(canvas);
  const toPx = makeToPx(offX, offY, scale);
  const selId = getSelectedHeadId();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const w = state.yard.widthFt, h = state.yard.heightFt;
  const boxW = w * scale, boxH = h * scale;

  // yard boundary
  ctx.fillStyle = "#f4faf6";
  ctx.fillRect(offX, offY, boxW, boxH);
  ctx.strokeStyle = "#8fb8a0"; ctx.lineWidth = 1.5;
  ctx.strokeRect(offX, offY, boxW, boxH);

  // grid
  const gridToggle = document.getElementById("toggleGrid");
  if (gridToggle && gridToggle.checked) {
    ctx.strokeStyle = "rgba(140,170,150,.25)"; ctx.lineWidth = 1;
    const step = 10;
    for (let x = 0; x <= w; x += step) {
      const [px0, py0] = toPx(x, 0), [px1, py1] = toPx(x, h);
      ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(px1, py1); ctx.stroke();
    }
    for (let y = 0; y <= h; y += step) {
      const [px0, py0] = toPx(0, y), [px1, py1] = toPx(w, y);
      ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(px1, py1); ctx.stroke();
    }
  }

  const radiusToggle = document.getElementById("toggleRadius");
  const showRadius = radiusToggle ? radiusToggle.checked : true;

  state.heads.forEach((head) => {
    const [hx, hy] = toPx(head.x, head.y);
    const r = head.radiusFt * scale;
    const color = zoneColorFor(head.sprinklerZoneId);
    const isSel = head.id === selId;

    if (showRadius) {
      ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.globalAlpha = 0.25; ctx.lineWidth = 1;
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // arc wedge. Bearing 0 = North = up on screen -> canvas angle = bearing - 90.
    // This is unchanged from v1 because the screen is always y-down; the y-flip
    // only moves the head's pixel origin, not the compass-to-screen mapping.
    const startCanvas = (head.arcStartDeg - 90) * Math.PI / 180;
    const span = arcSpan(head.arcStartDeg, head.arcEndDeg);
    const endCanvas = ((head.arcStartDeg + span) - 90) * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.arc(hx, hy, r, startCanvas, endCanvas, false);
    ctx.closePath();
    ctx.fillStyle = color; ctx.globalAlpha = isSel ? 0.42 : 0.22;
    ctx.fill();
    ctx.globalAlpha = 1;

    // needs-replacement marker (task 9): amber ring around the head.
    if (head.needsReplacement) {
      ctx.beginPath(); ctx.arc(hx, hy, (isSel ? 6 : 4) + 4, 0, Math.PI * 2);
      ctx.strokeStyle = "#d98c1a"; ctx.lineWidth = 2; ctx.stroke();
    }

    // head marker
    ctx.beginPath(); ctx.arc(hx, hy, isSel ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = isSel ? "#1a2420" : color;
    ctx.fill();
    if (isSel) { ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke(); }

    // label
    ctx.fillStyle = "#1a2420"; ctx.font = "11px sans-serif";
    let label = head.id;
    if (head.needsReplacement) label += " ⚠"; // warning sign
    ctx.fillText(label, hx + 7, hy - 7);
  });

  canvas._toPx = toPx;
  canvas._scale = scale;
}

function attachYardHover() {
  const canvas = document.getElementById("yardCanvas");
  const tip = document.getElementById("yardTip");
  if (!canvas || !tip) return;
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let hit = null;
    for (const head of getState().heads) {
      const [hx, hy] = canvas._toPx ? canvas._toPx(head.x, head.y) : [0, 0];
      if (Math.hypot(mx - hx, my - hy) < 8) { hit = head; break; }
    }
    if (hit) {
      tip.style.display = "block";
      tip.style.left = mx + "px"; tip.style.top = my + "px";
      const flag = hit.needsReplacement ? " · needs replacement" : "";
      tip.textContent = `${hit.id} · ${hit.ratedGpm} GPM · r=${hit.radiusFt}ft · ${fmt(headPrecipRate(hit), 2)} in/hr${flag}`;
    } else {
      tip.style.display = "none";
    }
  });
  canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}

/* -------------------------------- heatmap --------------------------------- */

export function drawHeatmap(data) {
  const state = getState();
  const canvas = document.getElementById("heatCanvas");
  if (!canvas || !canvas.offsetParent) return;
  lastHeatData = data;
  canvas.width = canvas.clientWidth;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const filterEl = document.getElementById("coverageZoneFilter");
  const filter = filterEl ? filterEl.value : "all";
  const grid = filter === "all" ? data.grid : (data.zoneGrids[filter] || data.grid);

  const { scale, offX, offY } = canvasScale(canvas);
  const cellPx = data.cell * scale;

  const targets = state.sprinklerZones.filter((z) => z.weeklyTargetIn > 0).map((z) => z.weeklyTargetIn);
  const targetRef = targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : 1.0;
  const cyclesEl = document.getElementById("cyclesPerWeek");
  const cyclesPerWeek = (cyclesEl ? +cyclesEl.value : 3) || 1;

  for (let r = 0; r < data.rows; r++) {
    for (let c = 0; c < data.cols; c++) {
      const v = grid[r][c];
      // y-flip: grid row 0 is the bottom of the yard; draw it at the bottom.
      const x = offX + c * cellPx;
      const y = offY + (data.rows - 1 - r) * cellPx;
      ctx.fillStyle = colorForValue(v, targetRef / cyclesPerWeek || 0.3);
      ctx.fillRect(x, y, cellPx + 0.5, cellPx + 0.5);
    }
  }

  ctx.strokeStyle = "#8fb8a0"; ctx.lineWidth = 1.5;
  ctx.strokeRect(offX, offY, data.cols * cellPx, data.rows * cellPx);

  canvas._grid = grid; canvas._offX = offX; canvas._offY = offY;
  canvas._cellPx = cellPx; canvas._data = data;
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
    // invert the y-flip to recover the grid row from the screen position
    const screenRow = Math.floor((my - canvas._offY) / canvas._cellPx);
    const r = canvas._data.rows - 1 - screenRow;
    if (r < 0 || c < 0 || r >= canvas._data.rows || c >= canvas._data.cols) {
      tip.style.display = "none"; return;
    }
    const v = canvas._grid[r][c];
    tip.style.display = "block";
    tip.style.left = mx + "px"; tip.style.top = my + "px";
    tip.textContent = `${fmt(v, 3)} in this cycle`;
  });
  canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}
