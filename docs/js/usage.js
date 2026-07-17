/* =============================================================================
 * usage.js - water usage estimator (PLAN.md section 3).
 *
 * Pure functions only; the Coverage-tab UI card that consumes them is wired in
 * Phase 4 (task 23). estimateGallons() is deliberately separate from the reserved
 * estimateCost() seam so a future rate schedule can bolt on without reworking the
 * gallons math.
 * ========================================================================== */

import { effectiveCyclesPerWeek } from "./schedule.js";

const WEEKS_PER_MONTH = 4.345;

// Flow actually delivered by a zone: capped at its measured supply if that limits
// the sum of head ratings. min(supplyGpm ?? Infinity, sum(ratedGpm)).
export function zoneFlowGpm(zone, heads) {
  const rated = heads.reduce((s, h) => s + (Number(h.ratedGpm) || 0), 0);
  const supply = (zone.supplyGpm == null) ? Infinity : Number(zone.supplyGpm);
  return Math.min(supply, rated);
}

// Gallons for one zone. cyclesPerWeek defaults to the zone's own schedule.
export function estimateGallons(zone, heads, cyclesPerWeek) {
  const cycles = (cyclesPerWeek == null) ? effectiveCyclesPerWeek(zone.schedule) : cyclesPerWeek;
  const flow = zoneFlowGpm(zone, heads);
  const gallonsPerWeek = flow * (Number(zone.runTimeMin) || 0) * cycles;
  return { gallonsPerWeek, gallonsPerMonth: gallonsPerWeek * WEEKS_PER_MONTH };
}

// Total across all zones. `headsByZone` maps zone id -> array of that zone's heads.
export function estimateTotalGallons(zones, headsByZone) {
  let week = 0, month = 0;
  for (const z of zones) {
    const g = estimateGallons(z, headsByZone[z.id] || []);
    week += g.gallonsPerWeek; month += g.gallonsPerMonth;
  }
  return { gallonsPerWeek: week, gallonsPerMonth: month };
}

// Reserved extension seam (PLAN.md section 3). Intentionally unimplemented in the
// current phases; a rateSchedule key will drive this later without touching the
// gallons math above.
export function estimateCost() {
  throw new Error("estimateCost() is a reserved seam; not implemented yet (see PLAN.md section 3).");
}
