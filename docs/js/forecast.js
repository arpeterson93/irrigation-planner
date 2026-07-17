/* =============================================================================
 * forecast.js - NWS forecast fetch, Hargreaves-Samani ET0, and the seasonal
 * adjustment result.
 *
 * hargreavesET0 + the adjustment math are the JS twins of
 * tests/test_forecast_math.py. Keep them in sync with that file.
 *
 * Phase 1 scope: this preserves v1's single-shot "today's adjustment" behavior,
 * re-pointed at the v2 forecast fields (latitude/longitude/efficiencyPct - the
 * last now expressed and shown as a percent per schema v2). The full day-by-day
 * 7-day table, auto-derived per-zone baseline, and live run-time single-sourcing
 * are Phase 4 (tasks 20-22). rainWindow / wateringDays / baseline / etOverride are
 * kept working as forecast-local fields so nothing regresses in the meantime.
 * ========================================================================== */

import { getState, saveState, clamp, fmt, escapeHtml, zoneColorFor } from "./state.js";

let lastForecast = null;

/* ------------------------------ form binding ------------------------------ */

export function bindForecastForm() {
  bindForecastFormValuesOnly();
  const fc0 = getState().forecast;
  setVal("rainWindow", fc0.rainWindow || 48);
  setVal("runoffEff", fc0.efficiencyPct != null ? fc0.efficiencyPct : 80);
  setVal("wateringDays", fc0.wateringDays || 3);
  setVal("etOverride", fc0.etOverride != null ? fc0.etOverride : "");

  // Handlers read getState().forecast live so they survive a New/Import state swap.
  onChange("lat", (v) => { getState().forecast.latitude = parseNum(v); saveState(); });
  onChange("lon", (v) => { getState().forecast.longitude = parseNum(v); saveState(); });
  onChange("rainWindow", (v) => { getState().forecast.rainWindow = +v; saveState(); });
  onChange("runoffEff", (v) => { getState().forecast.efficiencyPct = +v; saveState(); });
  onChange("wateringDays", (v) => { getState().forecast.wateringDays = +v; saveState(); if (lastForecast) renderForecastResult(lastForecast); });
  onChange("baselineDaily", (v) => { getState().forecast.baselineDaily = +v || null; saveState(); if (lastForecast) renderForecastResult(lastForecast); });
  onChange("etOverride", (v) => { getState().forecast.etOverride = v === "" ? null : +v; saveState(); if (lastForecast) renderForecastResult(lastForecast); });
}

export function bindForecastFormValuesOnly() {
  const fc = getState().forecast;
  setVal("lat", fc.latitude != null ? fc.latitude : "");
  setVal("lon", fc.longitude != null ? fc.longitude : "");
  setVal("baselineDaily", fc.baselineDaily != null ? fc.baselineDaily : defaultBaselineDaily());
}

function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function onChange(id, fn) { const el = document.getElementById(id); if (el) el.addEventListener("change", (e) => fn(e.target.value)); }
function parseNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

export function defaultBaselineDaily() {
  const state = getState();
  const targets = state.sprinklerZones.filter((z) => z.weeklyTargetIn > 0).map((z) => z.weeklyTargetIn);
  const avgTarget = targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : 1.0;
  const daysEl = document.getElementById("wateringDays");
  const days = (daysEl ? +daysEl.value : 0) || getState().forecast.wateringDays || 3;
  return +(avgTarget / days).toFixed(3);
}

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
  document.getElementById("forecastEmpty").style.display = "block";
  document.getElementById("forecastResult").style.display = "none";

  try {
    const ptRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`);
    if (!ptRes.ok) throw new Error("points lookup failed (" + ptRes.status + ")");
    const pt = await ptRes.json();
    const gridUrl = pt.properties.forecastGridData;
    if (!gridUrl) throw new Error("No forecast grid for this location");

    const gridRes = await fetch(gridUrl);
    if (!gridRes.ok) throw new Error("grid data fetch failed (" + gridRes.status + ")");
    const gridData = await gridRes.json();
    const props = gridData.properties;

    const windowHrs = +document.getElementById("rainWindow").value;
    const now = new Date();
    const windowEnd = new Date(now.getTime() + windowHrs * 3600 * 1000);

    const rainMm = sumSeriesInWindow(props.quantitativePrecipitation, now, windowEnd);
    const rainIn = rainMm / 25.4;

    const tmaxC = maxSeriesInWindow(props.maxTemperature, now, windowEnd);
    const tminC = minSeriesInWindow(props.minTemperature, now, windowEnd);

    let et0In = null;
    if (tmaxC !== null && tminC !== null) {
      et0In = hargreavesET0(lat, tmaxC, tminC, now) / 25.4;
    }

    lastForecast = { lat, lon, rainIn, tmaxC, tminC, et0In, place: pt.properties.relativeLocation?.properties, windowHrs };
    if (statusEl) statusEl.textContent = "Updated " + now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    renderForecastResult(lastForecast);
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = "Failed";
    alert("Couldn't fetch the NWS forecast: " + err.message + "\n\nYou can still use the ET0 override field to enter numbers manually.");
  }
}

/* --------------------------- NWS series helpers --------------------------- */

function parseValidTime(vt) {
  const [startStr, durStr] = vt.split("/");
  const start = new Date(startStr);
  const dur = parseISODuration(durStr);
  const end = new Date(start.getTime() + dur * 1000);
  return { start, end };
}
function parseISODuration(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(d);
  if (!m) return 0;
  const days = +(m[1] || 0), hrs = +(m[2] || 0), mins = +(m[3] || 0);
  return days * 86400 + hrs * 3600 + mins * 60;
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
    if (v.value !== null && v.value !== undefined) total += v.value * frac;
  }
  return total;
}
function maxSeriesInWindow(series, winStart, winEnd) {
  if (!series || !series.values) return null;
  let best = null;
  for (const v of series.values) {
    const { start, end } = parseValidTime(v.validTime);
    if (end <= winStart || start >= winEnd) continue;
    if (v.value === null || v.value === undefined) continue;
    if (best === null || v.value > best) best = v.value;
  }
  return best;
}
function minSeriesInWindow(series, winStart, winEnd) {
  if (!series || !series.values) return null;
  let best = null;
  for (const v of series.values) {
    const { start, end } = parseValidTime(v.validTime);
    if (end <= winStart || start >= winEnd) continue;
    if (v.value === null || v.value === undefined) continue;
    if (best === null || v.value < best) best = v.value;
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

export function renderForecastResult(f) {
  const state = getState();
  document.getElementById("forecastEmpty").style.display = "none";
  document.getElementById("forecastResult").style.display = "block";

  const et0 = state.forecast.etOverride != null ? state.forecast.etOverride : f.et0In;
  const rain = f.rainIn;
  const effPct = +document.getElementById("runoffEff").value || 80;
  const effectiveRain = rain * (effPct / 100);
  const netNeed = (et0 || 0) - effectiveRain;
  const baseline = +document.getElementById("baselineDaily").value || defaultBaselineDaily();
  const adjPct = baseline > 0 ? clamp(netNeed / baseline, 0, 1.5) : 0;

  document.getElementById("forecastStats").innerHTML = `
    <div class="stat"><div class="v">${fmt(rain, 2)}"</div><div class="l">Forecast rain (${f.windowHrs}h)</div></div>
    <div class="stat"><div class="v">${et0 === null || et0 === undefined ? "–" : fmt(et0, 2) + '"'}</div><div class="l">ET0 ${state.forecast.etOverride != null ? "(override)" : "(estimate)"}</div></div>
    <div class="stat"><div class="v">${fmt(effectiveRain, 2)}"</div><div class="l">Effective rain</div></div>
    <div class="stat"><div class="v">${fmt(netNeed, 2)}"</div><div class="l">Net water need</div></div>
    <div class="stat"><div class="v">${fmt(adjPct * 100, 0)}%</div><div class="l">Suggested adjustment</div></div>
  `;

  const tbody = document.querySelector("#adjustedTable tbody");
  tbody.innerHTML = "";
  state.sprinklerZones.forEach((z) => {
    const adjMin = Math.round(z.runTimeMin * adjPct);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="zone-swatch" style="background:${zoneColorFor(z.id)}"></span>${escapeHtml(z.name)}</td>
      <td>${z.runTimeMin} min</td>
      <td>${fmt(adjPct * 100, 0)}%</td>
      <td><b>${adjMin} min</b></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("forecastNote").textContent = netNeed <= 0
    ? "Forecasted rain covers (or exceeds) estimated water need; consider skipping irrigation."
    : "Suggested run time = base run time × adjustment %. Adjust the baseline daily need above if this feels off for your area/season.";
}
