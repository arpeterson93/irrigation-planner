/* =============================================================================
 * coverage.js - precipitation-rate math, arc geometry, heatmap grid + stats.
 *
 * The pure formulas here (arcSpan, angleInArc, headArea, headPrecipRate) are the
 * JS twins of tests/test_coverage_math.py, which pins them to golden values from
 * the original Google Sheet. Change one side, change the other, re-run pytest.
 *
 * Coordinate contract: heads and grid cells are in yard feet, bottom-left origin,
 * y increasing UP. Bearings are 0 = North (+y), increasing CLOCKWISE (East = 90 =
 * +x). Effective-GPM supply scaling is NOT applied here yet; that lands in Phase 3
 * (task 15). Phase 1 uses ratedGpm directly, matching v1 behavior exactly.
 * ========================================================================== */

import { getState, zoneById } from "./state.js";

export function norm360(a) { return ((a % 360) + 360) % 360; }

export function arcSpan(start, end) {
  start = norm360(start); end = norm360(end);
  if (start === end) return 360;
  return norm360(end - start);
}

export function angleInArc(angle, start, end) {
  angle = norm360(angle); start = norm360(start); end = norm360(end);
  if (start === end) return true;
  if (start < end) return angle >= start - 1e-9 && angle <= end + 1e-9;
  return angle >= start - 1e-9 || angle <= end + 1e-9;
}

export function headArea(head) {
  const span = arcSpan(head.arcStartDeg, head.arcEndDeg);
  return Math.PI * head.radiusFt * head.radiusFt * (span / 360);
}

// Precipitation rate for a head, in/hr: 96.3 * GPM / sector area (sq ft).
export function headPrecipRate(head) {
  const area = headArea(head);
  if (area <= 0) return 0;
  return 96.3 * head.ratedGpm / area;
}

// Bearing (0 = North = +y, clockwise) from head to a point, in yard (y-up) space.
export function bearingTo(dx, dy) {
  return norm360(Math.atan2(dx, dy) * 180 / Math.PI);
}

export function computeCoverage() {
  const state = getState();
  const t0 = performance.now();
  const cell = state.yard.cellSizeFt;
  const cols = Math.max(1, Math.round(state.yard.widthFt / cell));
  const rows = Math.max(1, Math.round(state.yard.heightFt / cell));

  // grid[r][c] = total inches per cycle (all zones). r indexes the y band,
  // r = 0 at the BOTTOM (y-up); canvas.js flips it for the screen.
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const zoneGrids = {};
  state.sprinklerZones.forEach((z) => {
    zoneGrids[z.id] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  });

  const headMeta = state.heads.map((h) => ({ h, rate: headPrecipRate(h) }));

  for (let r = 0; r < rows; r++) {
    const cy = (r + 0.5) * cell;
    for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * cell;
      for (const { h, rate } of headMeta) {
        if (rate <= 0) continue;
        const dx = cx - h.x, dy = cy - h.y;
        const dist = Math.hypot(dx, dy);
        if (dist > h.radiusFt) continue;
        const bearing = bearingTo(dx, dy);
        if (!angleInArc(bearing, h.arcStartDeg, h.arcEndDeg)) continue;
        const z = zoneById(h.sprinklerZoneId);
        const inchesThisCycle = rate * ((z ? z.runTimeMin : 0) / 60);
        if (zoneGrids[h.sprinklerZoneId]) zoneGrids[h.sprinklerZoneId][r][c] += inchesThisCycle;
        grid[r][c] += inchesThisCycle;
      }
    }
  }

  const t1 = performance.now();
  return { rows, cols, cell, grid, zoneGrids, ms: t1 - t0 };
}

export function statsFromGrid(gridArr, cellArea, cyclesPerWeek) {
  const vals = [];
  for (const row of gridArr) for (const v of row) if (v > 1e-6) vals.push(v);
  if (vals.length === 0) return { min: 0, med: 0, max: 0, avg: 0, sqft: 0, avgWeekly: 0 };
  vals.sort((a, b) => a - b);
  const min = vals[0], max = vals[vals.length - 1];
  const med = vals[Math.floor(vals.length / 2)];
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { min, med, max, avg, sqft: vals.length * cellArea, avgWeekly: avg * cyclesPerWeek };
}

/* ------------------------------ heat colors ------------------------------- */

export function lerpColor(a, b, k) {
  const r = Math.round(a[0] + (b[0] - a[0]) * k);
  const g = Math.round(a[1] + (b[1] - a[1]) * k);
  const bl = Math.round(a[2] + (b[2] - a[2]) * k);
  return `rgb(${r},${g},${bl})`;
}

export function colorForValue(v, maxRef) {
  if (v <= 0) return "rgba(200,210,204,0.25)";
  const t = Math.max(0, Math.min(v / maxRef, 1.6));
  if (t <= 0.5) {
    const k = t / 0.5; return lerpColor([233, 243, 238], [47, 169, 104], k);
  } else if (t <= 1) {
    const k = (t - 0.5) / 0.5; return lerpColor([47, 169, 104], [217, 140, 26], k);
  }
  const k = Math.max(0, Math.min((t - 1) / 0.6, 1));
  return lerpColor([217, 140, 26], [192, 57, 43], k);
}
