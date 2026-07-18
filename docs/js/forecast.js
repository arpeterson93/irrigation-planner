/* =============================================================================
 * forecast.js - NWS 7-day forecast, Hargreaves-Samani ET0, and the day-by-day
 * seasonal-adjustment table (PLAN.md Phase 4, tasks 20-22).
 *
 * hargreavesET0 is the JS twin of tests/test_forecast_math.py; keep them in sync.
 *
 * Everything downstream is derived, not manually entered:
 *   - baseline daily need   = zone.weeklyTargetIn / effectiveCyclesPerWeek(schedule)
 *   - net need (per day)     = ET0 - rain * efficiency
 *   - adjustment %           = clamp(netNeed / baseline, 0, 1.5)
 *   - suggested run time      = round(zone.runTimeMin * adjustment%)   [live from the zone]
 * Adjustment/run-time are shown only on that zone's scheduled watering days; other
 * days read "no watering". Days 5-7 are visually de-emphasized (note 6.5).
 * ========================================================================== */

import { getState, saveState, clamp, fmt, escapeHtml } from "./state.js";
import { zoneById } from "./state.js";
import { effectiveCyclesPerWeek, isScheduledDay } from "./schedule.js";

let lastForecast = null;

/* ------------------------------ form binding ------------------------------ */

export function bindForecastForm() {
  bindForecastFormValuesOnly();
  onChange("lat", (v) => { getState().forecast.latitude = parseNum(v); saveState(); });
  onChange("lon", (v) => { getState().forecast.longitude = parseNum(v); saveState(); });
  onChange("runoffEff", (v) => { getState().forecast.efficiencyPct = +v; saveState(); if (lastForecast) renderForecast(); });
  onChange("forecastZone", () => { if (lastForecast) renderForecast(); });
}

export function bindForecastFormValuesOnly() {
  const fc = getState().forecast;
  setVal("lat", fc.latitude != null ? fc.latitude : "");
  setVal("lon", fc.longitude != null ? fc.longitude : "");
  setVal("runoffEff", fc.efficiencyPct != null ? fc.efficiencyPct : 80);
  populateForecastZones();
}

export function populateForecastZones() {
  const sel = document.getElementById("forecastZone");
  if (!sel) return;
  const prev = sel.value;
  const zones = getState().sprinklerZones;
  sel.innerHTML = zones.map((z, i) => `<option value="${z.id}">Zone ${i + 1}: ${escapeHtml(z.name)}</option>`).join("");
  if (zones.some((z) => z.id === prev)) sel.value = prev;
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

/* --------------------------------- render --------------------------------- */

export function renderForecast() {
  if (!lastForecast) return;
  const state = getState();
  document.getElementById("forecastEmpty").style.display = "none";
  document.getElementById("forecastResult").style.display = "block";

  const zoneSel = document.getElementById("forecastZone");
  const zone = zoneById(zoneSel && zoneSel.value) || state.sprinklerZones[0];
  const eff = (+document.getElementById("runoffEff").value || 80) / 100;
  const cycles = zone ? effectiveCyclesPerWeek(zone.schedule) : 0;
  const baseline = (zone && cycles > 0) ? zone.weeklyTargetIn / cycles : 0;
  const days = lastForecast.days;

  const dim = (i) => (i >= 4 ? " class=\"dim\"" : ""); // days 5-7 lower confidence

  const headCells = days.map((d, i) =>
    `<th${dim(i)}>${i === 0 ? "Today" : d.date.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" })}</th>`).join("");

  const rowCells = (fn) => days.map((d, i) => `<td${dim(i)}>${fn(d, i)}</td>`).join("");

  const effPct = Math.round(eff * 100);
  const rainRow = rowCells((d) => d.rainIn == null ? "-" : fmt(d.rainIn, 2) + '"');
  const et0Row = rowCells((d) => d.et0In == null ? "-" : fmt(d.et0In, 2) + '"');
  const effRow = rowCells(() => effPct + "%");
  const netRow = rowCells((d) => {
    if (d.et0In == null || d.rainIn == null) return "-";
    return fmt(d.et0In - d.rainIn * eff, 2) + '"';
  });
  const adjRow = rowCells((d) => {
    if (!zone || !isScheduledDay(zone.schedule, d.date)) return `<span class="cell-muted">no watering</span>`;
    if (d.et0In == null || d.rainIn == null || baseline <= 0) return "-";
    const adj = clamp((d.et0In - d.rainIn * eff) / baseline, 0, 1.5);
    return fmt(adj * 100, 0) + "%";
  });
  const runRow = rowCells((d) => {
    if (!zone || !isScheduledDay(zone.schedule, d.date)) return `<span class="cell-muted">-</span>`;
    if (d.et0In == null || d.rainIn == null || baseline <= 0) return "-";
    const adj = clamp((d.et0In - d.rainIn * eff) / baseline, 0, 1.5);
    return `<b>${Math.round(zone.runTimeMin * adj)} min</b>`;
  });

  document.getElementById("forecastTable").innerHTML = `
    <thead><tr><th>Metric</th>${headCells}</tr></thead>
    <tbody>
      <tr><td>Forecast rain</td>${rainRow}</tr>
      <tr><td>ET0</td>${et0Row}</tr>
      <tr><td>Efficiency</td>${effRow}</tr>
      <tr><td>Net need (ET0 - rain x eff)</td>${netRow}</tr>
      <tr><td>Adjustment</td>${adjRow}</tr>
      <tr><td>Suggested run time</td>${runRow}</tr>
    </tbody>`;

  const cyclesTxt = zone ? cycles.toFixed(1) : "0.0";
  const failNote = lastForecast.failed ? "The NWS forecast couldn't be fetched, so rain and ET0 show as unknown; the schedule still displays. " : "";
  document.getElementById("forecastNote").textContent =
    `${failNote}Baseline daily need for ${zone ? zone.name : "this zone"} = weekly target ${zone ? fmt(zone.weeklyTargetIn, 2) : "-"}" / ${cyclesTxt} cycles = ${fmt(baseline, 3)}"/day. ` +
    "Efficiency is applied to rain (runoff/uptake). Adjustments appear only on this zone's scheduled watering days; days 5-7 are lower-confidence.";
}
