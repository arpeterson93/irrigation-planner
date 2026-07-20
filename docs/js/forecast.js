/* =============================================================================
 * forecast.js - NWS 7-day forecast, Hargreaves-Samani ET0, and the day-by-day
 * outlook table (PLAN.md Phase 4, tasks 20-22; reworked in Phase 11).
 *
 * hargreavesET0 is the JS twin of tests/test_forecast_math.py; keep them in sync.
 *
 * Phase 11 math (all derived, nothing manually entered):
 *   - Kc (per day)          = state.forecast.kc[month]          (12-month table)
 *   - ETc (per day)          = ET0 * Kc
 *   - Net need (per day)     = max(0, ETc - rain * effRain%) * irrigationNeed%
 *   - watering-day groups    = maximal runs between system watering days, where a
 *                              system watering day = ANY zone scheduled (decision a)
 *   - Combined net need      = sum of a group's per-day net needs
 *   - avgEffPerCycle         = mean over zones of (avg in/cycle from coverage) *
 *                              zone.effectiveWateringPct%
 *   - Weather Adj.           = max(0, round((combined / avgEffPerCycle)*10)/10)
 *                              ONE number per group for the whole system (not per
 *                              zone); rounded to the nearest 10%, no upper cap
 *   - zone minutes (per day) = round(zone.runTimeMin * groupAdj) on scheduled days
 *   - total runtime (per day)= sum of every zone's minutes that day
 * Combined Net Need and Weather Adj. render as one cell per group; a lead-in
 * (non-watering day before the first watering day) reads "no watering". Days 5-7
 * are de-emphasized (note 6.5).
 * ========================================================================== */

import { getState, saveState, clamp, fmt, escapeHtml } from "./state.js";
import { effectiveCyclesPerWeek, isScheduledDay } from "./schedule.js";
import { computeCoverage, statsOverCells, pointInArea } from "./coverage.js";

let lastForecast = null;

/* ------------------------------ form binding ------------------------------ */

export function bindForecastForm() {
  bindForecastFormValuesOnly();
  onChange("lat", (v) => { getState().forecast.latitude = parseNum(v); saveState(); });
  onChange("lon", (v) => { getState().forecast.longitude = parseNum(v); saveState(); });
  onChange("effRainPct", (v) => { getState().forecast.effectiveRainfallPct = +v; saveState(); if (lastForecast) renderForecast(); });
  onChange("irrigNeedPct", (v) => { getState().forecast.irrigationNeedPct = +v; saveState(); if (lastForecast) renderForecast(); });
  for (let m = 1; m <= 12; m++) {
    onChange("kc" + m, (v) => { getState().forecast.kc[m] = +v; saveState(); if (lastForecast) renderForecast(); });
  }
}

export function bindForecastFormValuesOnly() {
  const fc = getState().forecast;
  setVal("lat", fc.latitude != null ? fc.latitude : "");
  setVal("lon", fc.longitude != null ? fc.longitude : "");
  setVal("effRainPct", fc.effectiveRainfallPct != null ? fc.effectiveRainfallPct : 60);
  setVal("irrigNeedPct", fc.irrigationNeedPct != null ? fc.irrigationNeedPct : 100);
  for (let m = 1; m <= 12; m++) setVal("kc" + m, fc.kc && fc.kc[m] != null ? fc.kc[m] : 1.0);
}

function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function onChange(id, fn) { const el = document.getElementById(id); if (el) el.addEventListener("change", (e) => fn(e.target.value)); }
function parseNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

/* ------------------------------ NWS fetching ------------------------------ */

export function attachForecastActions() {
  const geo = document.getElementById("btnGeolocate");
  if (geo) geo.addEventListener("click", geolocate);
  const fetchBtn = document.getElementById("btnFetchForecast");
  if (fetchBtn) fetchBtn.addEventListener("click", fetchForecast);
}

function geolocate() {
  if (!navigator.geolocation) { alert("Geolocation isn't available in this browser."); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    setVal("lat", pos.coords.latitude.toFixed(4));
    setVal("lon", pos.coords.longitude.toFixed(4));
    const fc = getState().forecast;
    fc.latitude = +pos.coords.latitude.toFixed(4);
    fc.longitude = +pos.coords.longitude.toFixed(4);
    saveState();
  }, (err) => {
    alert("Couldn't get your location (" + err.message + "). Enter latitude/longitude manually instead.");
  });
}

async function fetchForecast() {
  const statusEl = document.getElementById("forecastStatus");
  const lat = parseFloat(document.getElementById("lat").value);
  const lon = parseFloat(document.getElementById("lon").value);
  if (isNaN(lat) || isNaN(lon)) { alert("Enter a valid latitude and longitude first."); return; }

  if (statusEl) { statusEl.style.display = "inline-flex"; statusEl.textContent = "Fetching…"; }

  try {
    const ptRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`);
    if (!ptRes.ok) throw new Error("points lookup failed (" + ptRes.status + ")");
    const pt = await ptRes.json();
    const gridUrl = pt.properties.forecastGridData;
    if (!gridUrl) throw new Error("No forecast grid for this location");

    const gridRes = await fetch(gridUrl);
    if (!gridRes.ok) throw new Error("grid data fetch failed (" + gridRes.status + ")");
    const props = (await gridRes.json()).properties;

    lastForecast = { lat, lon, days: buildDays(props, new Date(), lat), failed: false };
    if (statusEl) statusEl.textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    renderForecast();
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = "Forecast unavailable";
    // Task 22: still render the tab with rain/ET0 unknown so schedules stay visible.
    lastForecast = { lat, lon, days: buildDays(null, new Date(), lat), failed: true };
    renderForecast();
  }
}

// Build 7 daily buckets from `start` (today). NWS gridpoint precipitation is in mm
// and temperatures in degrees C; both are converted here.
function buildDays(props, start, lat) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dayEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i + 1);
    const rainMm = props ? sumSeriesInWindow(props.quantitativePrecipitation, dayStart, dayEnd) : null;
    const tmaxC = props ? maxSeriesInWindow(props.maxTemperature, dayStart, dayEnd) : null;
    const tminC = props ? minSeriesInWindow(props.minTemperature, dayStart, dayEnd) : null;
    let et0In = null;
    if (tmaxC != null && tminC != null) et0In = hargreavesET0(lat, tmaxC, tminC, dayStart) / 25.4;
    days.push({ date: dayStart, rainIn: rainMm == null ? null : rainMm / 25.4, tmaxC, tminC, et0In });
  }
  return days;
}

/* --------------------------- NWS series helpers --------------------------- */

function parseValidTime(vt) {
  const [startStr, durStr] = vt.split("/");
  const start = new Date(startStr);
  return { start, end: new Date(start.getTime() + parseISODuration(durStr) * 1000) };
}
function parseISODuration(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(d);
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60;
}
function sumSeriesInWindow(series, winStart, winEnd) {
  if (!series || !series.values) return 0;
  let total = 0;
  for (const v of series.values) {
    const { start, end } = parseValidTime(v.validTime);
    if (end <= winStart || start >= winEnd) continue;
    const ovStart = start < winStart ? winStart : start;
    const ovEnd = end > winEnd ? winEnd : end;
    const frac = (ovEnd - ovStart) / (end - start || 1);
    if (v.value != null) total += v.value * frac;
  }
  return total;
}
function maxSeriesInWindow(series, winStart, winEnd) { return extremeInWindow(series, winStart, winEnd, true); }
function minSeriesInWindow(series, winStart, winEnd) { return extremeInWindow(series, winStart, winEnd, false); }
function extremeInWindow(series, winStart, winEnd, wantMax) {
  if (!series || !series.values) return null;
  let best = null;
  for (const v of series.values) {
    const { start, end } = parseValidTime(v.validTime);
    if (end <= winStart || start >= winEnd) continue;
    if (v.value == null) continue;
    if (best === null || (wantMax ? v.value > best : v.value < best)) best = v.value;
  }
  return best;
}

// Hargreaves-Samani ET0, returns mm/day. Twin of tests/test_forecast_math.py.
export function hargreavesET0(latDeg, tmaxC, tminC, date) {
  const lat = latDeg * Math.PI / 180;
  const start = new Date(date.getFullYear(), 0, 0);
  const J = Math.floor((date - start) / 86400000);
  const dr = 1 + 0.033 * Math.cos(2 * Math.PI / 365 * J);
  const delta = 0.409 * Math.sin(2 * Math.PI / 365 * J - 1.39);
  const ws = Math.acos(clamp(-Math.tan(lat) * Math.tan(delta), -1, 1));
  const Gsc = 0.0820;
  const Ra = (24 * 60 / Math.PI) * Gsc * dr * (ws * Math.sin(lat) * Math.sin(delta) + Math.cos(lat) * Math.cos(delta) * Math.sin(ws));
  const RaMm = 0.408 * Ra;
  const tmean = (tmaxC + tminC) / 2;
  const diff = Math.max(0, tmaxC - tminC);
  return 0.0023 * RaMm * (tmean + 17.8) * Math.sqrt(diff);
}

/* ----------------------------- Phase 11 math ------------------------------ */
// Pure helpers, twins of tests/test_forecast_math.py. Keep both sides in sync.

export function etcIn(et0In, kc) {
  return et0In == null ? null : et0In * kc;
}

// Rain-adjusted crop need, floored at zero BEFORE the Irrigation Need % scalar.
export function netNeedIn(et0In, rainIn, kc, effRainPct, irrNeedPct) {
  if (et0In == null || rainIn == null) return null;
  const etc = et0In * kc;
  return Math.max(0, etc - rainIn * (effRainPct / 100)) * (irrNeedPct / 100);
}

// Sum a group's per-day net needs; null if any day in the group is null.
export function combinedNetNeed(dayNeeds, start, end) {
  let sum = 0;
  for (let i = start; i <= end; i++) {
    if (dayNeeds[i] == null) return null;
    sum += dayNeeds[i];
  }
  return sum;
}

// Raw system seasonal adjustment for a group; null when it can't be computed.
export function seasonalAdjustmentRaw(combined, avgEffPerCycle) {
  if (combined == null || !(avgEffPerCycle > 0)) return null;
  return combined / avgEffPerCycle;
}

// Cell-center point-in-area test (twin of app.js's cellInArea; small geometry
// helpers are duplicated per-module in this codebase rather than shared).
function cellInArea(data, r, c, obj) {
  return pointInArea([(c + 0.5) * data.cell, (r + 0.5) * data.cell], obj);
}

const SIGNIFICANT_CONTRIBUTION_SHARE = 0.25; // PLAN 12 decision (b)

// Weather Adj. denominator: mean over sprinkler zones of each zone's avg applied
// depth per cycle, scaled by its Effective Watering %. Phase 12 change (12.1):
// a sprinkler zone's per-cycle figure is now the average of the Avg in/cycle of
// the yard zones it *significantly* waters (>= 25% share of that yard zone's
// applied water, decision a/b), reusing the yard zone's own overall Avg in/cycle
// (all contributing zones combined, decision c) - the same number the Coverage
// tab's Yard-zone grouping shows. Falls back to the zone's own head coverage
// (pre-Phase-12 behavior) when no yard zone reaches the threshold.
export function avgEffectiveWateringPerCycle(state) {
  const data = computeCoverage(); // reads getState() itself
  const notDead = (r, c) => !data.deadMask[r][c];
  const zones = state.sprinklerZones;
  if (!zones.length) return 0;

  // Each yard zone's own non-dead cell list and overall Avg in/cycle (data.grid
  // = all zones combined), computed once and shared across sprinkler zones.
  const yzCells = state.yardZones.map((yz) => {
    const cells = [];
    for (let r = 0; r < data.rows; r++) {
      for (let c = 0; c < data.cols; c++) {
        if (notDead(r, c) && cellInArea(data, r, c, yz)) cells.push([r, c]);
      }
    }
    return cells;
  });
  const yzAvgPerCycle = yzCells.map((cells) => {
    if (!cells.length) return 0;
    let sum = 0;
    for (const [r, c] of cells) sum += data.grid[r][c];
    return sum / cells.length;
  });

  const perZone = zones.map((z) => {
    const zg = data.zoneGrids[z.id];
    // Yard zones this sprinkler zone significantly contributes to (decision a/b).
    const relevant = [];
    state.yardZones.forEach((yz, yi) => {
      const cells = yzCells[yi];
      if (!zg || !cells.length) return;
      let zSum = 0, totalSum = 0;
      for (const [r, c] of cells) { zSum += zg[r][c]; totalSum += data.grid[r][c]; }
      if (totalSum > 0 && zSum / totalSum >= SIGNIFICANT_CONTRIBUTION_SHARE) relevant.push(yzAvgPerCycle[yi]);
    });
    // Fallback: no yard zone reaches the threshold (none drawn, or this zone's
    // water is too diffuse to be significant anywhere) -> its own avg in/cycle.
    const avgPerCycle = relevant.length
      ? relevant.reduce((s, v) => s + v, 0) / relevant.length
      : (zg ? statsOverCells(zg, data.cell, notDead).avg : 0);
    return avgPerCycle * ((z.effectiveWateringPct != null ? z.effectiveWateringPct : 80) / 100);
  });
  return perZone.reduce((s, v) => s + v, 0) / perZone.length;
}

// Group the visible days by system watering day (PLAN 11.2, lead-in fix 11.8):
// a group only ever STARTS at a system watering day and runs to the day before
// the next one. Any non-watering day(s) before the first watering day in the
// window become their own solo `leadIn` entries, shown as "no watering" rather
// than merged forward into a group that would display a bogus combined value.
export function wateringDayGroups(days, isSystemDay) {
  const groups = [];
  let i = 0;
  while (i < days.length) {
    if (isSystemDay(days[i].date)) {
      let j = i + 1;
      while (j < days.length && !isSystemDay(days[j].date)) j++;
      groups.push({ start: i, end: j - 1, leadIn: false });
      i = j;
    } else {
      groups.push({ start: i, end: i, leadIn: true });
      i++;
    }
  }
  return groups;
}

/* --------------------------------- render --------------------------------- */

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(d) { return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`; }

export function renderForecast() {
  if (!lastForecast) return;
  const state = getState();
  document.getElementById("forecastEmpty").style.display = "none";
  document.getElementById("forecastResult").style.display = "block";

  const fc = state.forecast;
  const effRainPct = +document.getElementById("effRainPct").value || 0;
  const irrNeedPct = +document.getElementById("irrigNeedPct").value || 0;
  const kcOf = (date) => (fc.kc && fc.kc[date.getMonth() + 1] != null) ? +fc.kc[date.getMonth() + 1] : 1.0;
  const days = lastForecast.days;

  const dim = (i) => (i >= 4 ? " class=\"dim\"" : ""); // days 5-7 lower confidence

  const headCells = days.map((d, i) =>
    `<th${dim(i)}>${i === 0 ? "Today" : d.date.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" })}</th>`).join("");

  // Per-day derived values.
  const kcByDay = days.map((d) => kcOf(d.date));
  const etcByDay = days.map((d, i) => etcIn(d.et0In, kcByDay[i]));
  const netByDay = days.map((d, i) => netNeedIn(d.et0In, d.rainIn, kcByDay[i], effRainPct, irrNeedPct));

  // Zone-independent per-day rows: rain, ET0, Kc, ETc, Net need.
  const rowCells = (fn) => days.map((d, i) => `<td${dim(i)}>${fn(d, i)}</td>`).join("");
  const rainRow = rowCells((d) => d.rainIn == null ? "-" : fmt(d.rainIn, 2) + '"');
  const et0Row = rowCells((d) => d.et0In == null ? "-" : fmt(d.et0In, 2) + '"');
  const kcRow = rowCells((d, i) => fmt(kcByDay[i], 2));
  const etcRow = rowCells((d, i) => etcByDay[i] == null ? "-" : fmt(etcByDay[i], 2) + '"');
  const netRow = rowCells((d, i) => netByDay[i] == null ? "-" : fmt(netByDay[i], 2) + '"');

  // Watering-day grouping (decision a: a day counts if ANY zone is scheduled).
  const isSystemDay = (date) => state.sprinklerZones.some((z) => isScheduledDay(z.schedule, date));
  const groups = wateringDayGroups(days, isSystemDay);
  const avgEff = avgEffectiveWateringPerCycle(state);

  // Per-group combined net need + one system weather adjustment. Rounded to the
  // nearest 10% and floored at 0%, with NO upper cap (11.8 fix 2).
  const groupInfo = groups.map((g) => {
    const combined = combinedNetNeed(netByDay, g.start, g.end);
    const raw = seasonalAdjustmentRaw(combined, avgEff);
    const adj = raw == null ? null : Math.max(0, Math.round(raw * 10) / 10);
    return { ...g, combined, raw, adj };
  });

  // One cell per group. A lead-in day (non-watering day before the first
  // watering day in the window) reads "no watering", matching the zone rows;
  // otherwise a colspan cell spans the days the group covers.
  const groupRow = (fn) => groupInfo.map((g) => {
    const dimCls = g.start >= 4 ? " dim" : "";
    if (g.leadIn) return `<td class="cell-muted${dimCls}">no watering</td>`;
    const span = g.end - g.start + 1;
    const title = ` title="${shortDate(days[g.start].date)} - ${shortDate(days[g.end].date)}"`;
    return `<td colspan="${span}"${dimCls ? ` class="dim"` : ""}${title}>${fn(g)}</td>`;
  }).join("");
  const combinedRow = groupRow((g) => g.combined == null ? "-" : fmt(g.combined, 2) + '"');
  const adjRow = groupRow((g) => g.adj == null ? "-" : `${Math.round(g.adj * 100)}%`);

  // Minutes matrix: computed once, reused by the zone rows and the total row so
  // rounding never disagrees. null = not watering that day; number = minutes
  // (or null if the group's adjustment couldn't be computed).
  const groupOfDay = [];
  groupInfo.forEach((g, gi) => { for (let i = g.start; i <= g.end; i++) groupOfDay[i] = gi; });
  const zoneDayMinutes = state.sprinklerZones.map((z) => days.map((d, i) => {
    if (!isScheduledDay(z.schedule, d.date)) return { watering: false };
    const g = groupInfo[groupOfDay[i]];
    if (g.adj == null) return { watering: true, min: null };
    return { watering: true, min: Math.round(z.runTimeMin * g.adj) };
  }));

  const zoneRows = state.sprinklerZones.map((z, zi) => {
    const effW = z.effectiveWateringPct != null ? z.effectiveWateringPct : 80;
    const baseTip = `Zone ${zi + 1}: base run time ${z.runTimeMin} min · effective watering ${effW}% (minutes = base x the system seasonal adjustment above)`;
    const cells = days.map((d, i) => {
      const dimCls = i >= 4 ? " dim" : "";
      const cell = zoneDayMinutes[zi][i];
      if (!cell.watering) return `<td class="cell-muted${dimCls}">no watering</td>`;
      if (cell.min == null) return `<td class="${dimCls.trim()}">-</td>`;
      return `<td class="${("cell-run" + dimCls).trim()}"><b>${cell.min} min</b></td>`;
    }).join("");
    return `<tr><td title="${escapeHtml(baseTip)}">Zone ${zi + 1}</td>${cells}</tr>`;
  }).join("");

  // Total zones runtime per day: sum of every zone's minutes (0 when not
  // watering); "-" if a scheduled zone that day is missing its adjustment.
  const totalRow = days.map((d, i) => {
    const dimCls = i >= 4 ? " dim" : "";
    let sum = 0, unknown = false;
    zoneDayMinutes.forEach((zrow) => {
      const cell = zrow[i];
      if (cell.watering) { if (cell.min == null) unknown = true; else sum += cell.min; }
    });
    const val = unknown ? "-" : `<b>${sum} min</b>`;
    return `<td class="${dimCls.trim()}">${val}</td>`;
  }).join("");

  document.getElementById("forecastTable").innerHTML = `
    <thead><tr><th>Metric</th>${headCells}</tr></thead>
    <tbody>
      <tr><td>Forecast rain</td>${rainRow}</tr>
      <tr><td>ET0</td>${et0Row}</tr>
      <tr><td title="Crop coefficient by month; ETc = ET0 x Kc">Kc</td>${kcRow}</tr>
      <tr><td title="Crop water use = ET0 x Kc">ETc</td>${etcRow}</tr>
      <tr><td title="max(0, ETc - rain x effective-rainfall%) x irrigation-need%">Net need</td>${netRow}</tr>
      <tr><td title="Sum of net need across each watering-day group">Combined net need</td>${combinedRow}</tr>
      <tr><td title="One system-wide adjustment per group = combined net need / avg effective watering per cycle">Weather Adj.</td>${adjRow}</tr>
      ${zoneRows}
      <tr><td>Total zones runtime (min)</td>${totalRow}</tr>
    </tbody>`;

  const failNote = lastForecast.failed ? "The NWS forecast couldn't be fetched, so rain and ET0 show as unknown; the schedules and groupings still display. " : "";
  document.getElementById("forecastNote").textContent =
    `${failNote}Kc scales ET0 into crop water use (ETc = ET0 x Kc), looked up by each day's calendar month. Net need floors the rain-adjusted crop need at zero, then scales by the Irrigation Need %. ` +
    "Combined net need sums each watering-day group (a group runs between days on which any zone waters); the merged cell spans those days, and a non-watering day before the first watering day reads \"no watering\". Weather Adj. is one number for the whole system, not per zone: it is rounded to the nearest 10%, with no upper cap. Each zone row shows only its minutes (base run time x that adjustment) on its own watering days; the bottom row totals all zones' minutes per day. Days 5-7 are lower-confidence.";
}
