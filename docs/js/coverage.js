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
import { effectiveCyclesPerWeek } from "./schedule.js";

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
  return headPrecipRateFor(head, head.ratedGpm);
}
export function headPrecipRateFor(head, gpm) {
  const area = headArea(head);
  if (area <= 0) return 0;
  return 96.3 * gpm / area;
}

/* --------------------- effective GPM (supply-limited) --------------------- */
// PLAN.md section 3: if a zone's measured supply is less than the sum of its
// heads' rated GPM, every head is scaled down proportionally so the zone's
// delivered flow matches the supply. Otherwise heads run at their rated GPM.

export function zoneRatedGpm(headsInZone) {
  return headsInZone.reduce((s, h) => s + (Number(h.ratedGpm) || 0), 0);
}
export function zoneScaleFactor(zone, headsInZone) {
  const R = zoneRatedGpm(headsInZone);
  if (zone.supplyGpm != null && zone.supplyGpm > 0 && R > 0 && zone.supplyGpm < R) return zone.supplyGpm / R;
  return 1;
}
export function effectiveGpm(head, factor) {
  return (Number(head.ratedGpm) || 0) * factor;
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
  const weeklyGrid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const zoneGrids = {};
  const zoneCycles = {};
  state.sprinklerZones.forEach((z) => {
    zoneGrids[z.id] = Array.from({ length: rows }, () => new Array(cols).fill(0));
    zoneCycles[z.id] = effectiveCyclesPerWeek(z.schedule);
  });

  // Precompute each head's effective (supply-scaled) precip rate.
  const headsByZone = {};
  state.sprinklerZones.forEach((z) => (headsByZone[z.id] = []));
  state.heads.forEach((h) => { if (headsByZone[h.sprinklerZoneId]) headsByZone[h.sprinklerZoneId].push(h); });
  const factors = {};
  state.sprinklerZones.forEach((z) => (factors[z.id] = zoneScaleFactor(z, headsByZone[z.id])));

  const headMeta = state.heads.map((h) => {
    const f = factors[h.sprinklerZoneId] != null ? factors[h.sprinklerZoneId] : 1;
    return { h, rate: headPrecipRateFor(h, effectiveGpm(h, f)) };
  });

  for (let r = 0; r < rows; r++) {
    const cy = (r + 0.5) * cell;
    for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * cell;
      for (const { h, rate } of headMeta) {
        if (rate <= 0) continue;
        const dx = cx - h.x, dy = cy - h.y;
        if (Math.hypot(dx, dy) > h.radiusFt) continue;
        if (!angleInArc(bearingTo(dx, dy), h.arcStartDeg, h.arcEndDeg)) continue;
        const z = zoneById(h.sprinklerZoneId);
        const inchesThisCycle = rate * ((z ? z.runTimeMin : 0) / 60);
        if (zoneGrids[h.sprinklerZoneId]) {
          zoneGrids[h.sprinklerZoneId][r][c] += inchesThisCycle;
          weeklyGrid[r][c] += inchesThisCycle * (zoneCycles[h.sprinklerZoneId] || 0);
        }
        grid[r][c] += inchesThisCycle;
      }
    }
  }

  // Dead-space mask: a cell whose center falls in any dead-space polygon is
  // excluded from turf stats and drawn neutral/hatched (PLAN.md task 16).
  const deadMask = Array.from({ length: rows }, () => new Array(cols).fill(false));
  if (state.deadSpaces.length) {
    for (let r = 0; r < rows; r++) {
      const cy = (r + 0.5) * cell;
      for (let c = 0; c < cols; c++) {
        const cx = (c + 0.5) * cell;
        deadMask[r][c] = state.deadSpaces.some((d) => pointInPolygon([cx, cy], d.polygon));
      }
    }
  }

  const t1 = performance.now();
  return { rows, cols, cell, grid, weeklyGrid, zoneGrids, zoneCycles, factors, deadMask, ms: t1 - t0 };
}

// Shoelace area of a polygon in square feet (PLAN.md task 36). `polygon` is a
// list of [x,y] yard-feet vertices; winding direction is irrelevant (abs value).
export function polygonAreaSqFt(polygon) {
  if (!polygon || polygon.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    a += (polygon[j][0] + polygon[i][0]) * (polygon[j][1] - polygon[i][1]);
  }
  return Math.abs(a) / 2;
}

export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const hit = ((yi > pt[1]) !== (yj > pt[1])) &&
      (pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) || 1e-12) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

// Stats over the cells selected by includeFn(r,c). Returns per-cycle summary.
export function statsOverCells(grid, cell, includeFn) {
  const vals = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (!includeFn(r, c)) continue;
      const v = grid[r][c];
      if (v > 1e-6) vals.push(v);
    }
  }
  if (!vals.length) return { min: 0, med: 0, max: 0, avg: 0, sqft: 0, count: 0 };
  vals.sort((a, b) => a - b);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { min: vals[0], med: vals[Math.floor(vals.length / 2)], max: vals[vals.length - 1], avg, sqft: vals.length * cell * cell, count: vals.length };
}

// Average of a grid over selected cells (used for weekly rollups; includes zeros
// among covered cells is avoided by only averaging cells that received water).
export function avgOverCells(grid, includeFn) {
  let sum = 0, n = 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (!includeFn(r, c)) continue;
      if (grid[r][c] > 1e-6) { sum += grid[r][c]; n++; }
    }
  }
  return n ? sum / n : 0;
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
