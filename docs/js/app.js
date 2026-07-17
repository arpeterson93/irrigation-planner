/* =============================================================================
 * app.js - bootstrapping, tab wiring, top-level state, form/table rendering.
 *
 * This is the composition root. It owns UI-only state (which head is selected)
 * and wires the pure/render modules (state, coverage, canvas, forecast) to the
 * DOM. The math and geometry live in their own modules; this file is glue.
 * ========================================================================== */

import {
  getState, setState, defaultState, loadState, saveState, exportJSON, importJSONFile,
  uid, clamp, fmt, escapeHtml, zoneColorFor, MAX_ZONES, SEEDED_KEY, makeZone,
} from "./state.js";
import { computeCoverage, statsFromGrid } from "./coverage.js";
import { initCanvas, drawYardCanvas, drawHeatmap, redrawHeatmap, getLastHeatData } from "./canvas.js";
import {
  bindForecastForm, bindForecastFormValuesOnly, attachForecastActions,
} from "./forecast.js";

/* ------------------------------- UI state --------------------------------- */

let selectedHeadId = null;

const NUMERIC_HEAD_FIELDS = ["x", "y", "radiusFt", "arcStartDeg", "arcEndDeg", "ratedGpm"];

/* --------------------------------- tabs ----------------------------------- */

function wireTabs() {
  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "yard") drawYardCanvas();
      if (btn.dataset.tab === "coverage") redrawHeatmap();
    });
  });
}

/* ----------------------------- yard dimensions ---------------------------- */

function bindYardForm() {
  const w = document.getElementById("yardWidth");
  const h = document.getElementById("yardHeight");
  const c = document.getElementById("cellSize");
  bindYardFormValuesOnly();
  // Handlers read getState() live so they keep working after New/Import swaps state.
  w.addEventListener("change", () => { const y = getState().yard; y.widthFt = clamp(+w.value || 80, 5, 1000); w.value = y.widthFt; saveState(); drawYardCanvas(); });
  h.addEventListener("change", () => { const y = getState().yard; y.heightFt = clamp(+h.value || 60, 5, 1000); h.value = y.heightFt; saveState(); drawYardCanvas(); });
  c.addEventListener("change", () => { const y = getState().yard; y.cellSizeFt = clamp(+c.value || 2, 0.5, 10); c.value = y.cellSizeFt; saveState(); });
}

function bindYardFormValuesOnly() {
  const state = getState();
  document.getElementById("yardWidth").value = state.yard.widthFt;
  document.getElementById("yardHeight").value = state.yard.heightFt;
  document.getElementById("cellSize").value = state.yard.cellSizeFt;
}

/* -------------------------------- zones ----------------------------------- */

function nextZoneId() {
  const used = new Set(getState().sprinklerZones.map((z) => z.id));
  for (let i = 1; i <= MAX_ZONES + 1; i++) { if (!used.has("sz" + i)) return "sz" + i; }
  return uid("sz");
}

function renderZoneTable() {
  const state = getState();
  const tbody = document.querySelector("#zoneTable tbody");
  tbody.innerHTML = "";
  const canRemove = state.sprinklerZones.length > 1;

  state.sprinklerZones.forEach((z, idx) => {
    const heads = state.heads.filter((h) => h.sprinklerZoneId === z.id);
    const removable = canRemove && heads.length === 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="zone-swatch" style="background:${zoneColorFor(z.id)}"></span>Zone ${idx + 1}</td>
      <td><input type="text" data-f="name" value="${escapeHtml(z.name)}" style="min-width:100px;"></td>
      <td><input type="number" data-f="runTimeMin" value="${z.runTimeMin}" min="0" max="180" step="1" style="width:70px;"></td>
      <td><input type="number" data-f="weeklyTargetIn" value="${z.weeklyTargetIn}" min="0" max="10" step="0.1" style="width:70px;"></td>
      <td><input type="number" data-f="supplyGpm" value="${z.supplyGpm == null ? "" : z.supplyGpm}" min="0" max="100" step="0.5" style="width:70px;" placeholder="auto"></td>
      <td>${removable ? `<button class="btn-danger btn-sm" data-act="delZone" title="Remove empty zone">✕</button>` : ""}</td>
    `;
    tr.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const f = inp.dataset.f;
        if (f === "name") z.name = inp.value;
        else if (f === "supplyGpm") z.supplyGpm = inp.value === "" ? null : (+inp.value || 0);
        else z[f] = +inp.value || 0;
        saveState();
        renderAll();
      });
    });
    const del = tr.querySelector('[data-act="delZone"]');
    if (del) del.addEventListener("click", () => removeZone(z.id));
    tbody.appendChild(tr);
  });

  // Coverage zone filter mirrors the zone list.
  const sel = document.getElementById("coverageZoneFilter");
  const cur = sel.value;
  sel.innerHTML = `<option value="all">All zones (one full cycle)</option>` +
    state.sprinklerZones.map((z, i) => `<option value="${z.id}">Zone ${i + 1} only, ${escapeHtml(z.name)}</option>`).join("");
  sel.value = state.sprinklerZones.some((z) => z.id === cur) ? cur : "all";

  const addBtn = document.getElementById("btnAddZone");
  if (addBtn) addBtn.disabled = state.sprinklerZones.length >= MAX_ZONES;
}

function addZone() {
  const state = getState();
  if (state.sprinklerZones.length >= MAX_ZONES) return;
  const zone = makeZone(state.sprinklerZones.length);
  zone.id = nextZoneId();
  zone.name = "Zone " + (state.sprinklerZones.length + 1);
  state.sprinklerZones.push(zone);
  saveState();
  renderAll();
}

function removeZone(id) {
  const state = getState();
  if (state.sprinklerZones.length <= 1) return;
  if (state.heads.some((h) => h.sprinklerZoneId === id)) {
    alert("This zone still has heads assigned. Reassign or delete them first.");
    return;
  }
  if (!confirm("Remove this zone?")) return;
  state.sprinklerZones = state.sprinklerZones.filter((z) => z.id !== id);
  saveState();
  renderAll();
}

/* --------------------------------- heads ---------------------------------- */

function addHead(defaults) {
  const state = getState();
  const firstZone = state.sprinklerZones[0];
  const h = Object.assign({
    id: uid("H"),
    sprinklerZoneId: firstZone ? firstZone.id : "sz1",
    x: Math.round(state.yard.widthFt / 2),
    y: Math.round(state.yard.heightFt / 2),
    radiusFt: 15, arcStartDeg: 0, arcEndDeg: 360, ratedGpm: 2.0,
    nozzleFamily: "", brand: "", model: "", nozzle: "", riserHeightIn: null,
    needsReplacement: false, notes: "",
  }, defaults || {});
  state.heads.push(h);
  saveState();
  renderHeadsTable();
  drawYardCanvas();
}

function typeOptions(selected) {
  const opts = [["", "unset"], ["rotary", "rotary"], ["fixed", "fixed"]];
  return opts.map(([v, label]) => `<option value="${v}" ${(selected || "") === v ? "selected" : ""}>${label}</option>`).join("");
}

function renderHeadsTable() {
  const state = getState();
  const tbody = document.querySelector("#headsTable tbody");
  tbody.innerHTML = "";
  const colCount = document.querySelectorAll("#headsTable thead th").length;

  if (state.heads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty">No heads yet. Click "+ Add head" to start mapping your yard.</td></tr>`;
    updateHeadTypeNudge();
    return;
  }

  state.heads.forEach((h) => {
    const tr = document.createElement("tr");
    tr.dataset.id = h.id;
    if (h.id === selectedHeadId) tr.style.background = "var(--green-100)";
    const zoneOpts = state.sprinklerZones.map((z, i) =>
      `<option value="${z.id}" ${z.id === h.sprinklerZoneId ? "selected" : ""}>${i + 1}</option>`).join("");
    tr.innerHTML = `
      <td><span class="zone-swatch" style="background:${zoneColorFor(h.sprinklerZoneId)}"></span></td>
      <td><input type="text" data-f="id" value="${escapeHtml(h.id)}" style="width:60px;"></td>
      <td><select data-f="sprinklerZoneId">${zoneOpts}</select></td>
      <td><input type="number" data-f="x" value="${h.x}" step="0.5" style="width:60px;"></td>
      <td><input type="number" data-f="y" value="${h.y}" step="0.5" style="width:60px;"></td>
      <td><input type="number" data-f="radiusFt" value="${h.radiusFt}" step="0.5" min="0" style="width:60px;"></td>
      <td><input type="number" data-f="arcStartDeg" value="${h.arcStartDeg}" step="5" min="0" max="360" style="width:60px;"></td>
      <td><input type="number" data-f="arcEndDeg" value="${h.arcEndDeg}" step="5" min="0" max="360" style="width:60px;"></td>
      <td><input type="number" data-f="ratedGpm" value="${h.ratedGpm}" step="0.1" min="0" style="width:60px;"></td>
      <td><select data-f="type">${typeOptions(h.type)}</select></td>
      <td><input type="text" data-f="nozzleFamily" value="${escapeHtml(h.nozzleFamily || "")}" style="width:100px;" placeholder="e.g. MP Rotator"></td>
      <td><input type="text" data-f="brand" value="${escapeHtml(h.brand || "")}" style="width:80px;"></td>
      <td><input type="text" data-f="model" value="${escapeHtml(h.model || "")}" style="width:80px;"></td>
      <td><input type="text" data-f="nozzle" value="${escapeHtml(h.nozzle || "")}" style="width:70px;"></td>
      <td><input type="number" data-f="riserHeightIn" value="${h.riserHeightIn == null ? "" : h.riserHeightIn}" step="1" min="0" style="width:56px;" placeholder="-"></td>
      <td class="replace-cell"><input type="checkbox" data-f="needsReplacement" ${h.needsReplacement ? "checked" : ""} style="width:auto;"></td>
      <td><input type="text" data-f="notes" value="${escapeHtml(h.notes || "")}" style="width:90px;" placeholder="e.g. corner rotor"></td>
      <td><button class="btn-danger btn-sm" data-act="del">✕</button></td>
    `;
    tr.addEventListener("click", (e) => {
      const t = e.target.tagName;
      if (t === "INPUT" || t === "BUTTON" || t === "SELECT") return;
      selectedHeadId = h.id; renderHeadsTable(); drawYardCanvas();
    });
    tr.querySelectorAll("input,select").forEach((inp) => {
      inp.addEventListener("change", () => {
        updateHeadField(h, inp.dataset.f, inp);
        saveState();
        const structural = ["sprinklerZoneId", "type", "needsReplacement"].indexOf(inp.dataset.f) !== -1;
        if (structural) renderHeadsTable();
        drawYardCanvas();
        updateHeadTypeNudge();
      });
      inp.addEventListener("focus", () => { selectedHeadId = h.id; drawYardCanvas(); });
    });
    tr.querySelector('[data-act="del"]').addEventListener("click", () => {
      state.heads = state.heads.filter((x) => x.id !== h.id);
      saveState(); renderHeadsTable(); drawYardCanvas(); updateHeadTypeNudge();
    });
    tbody.appendChild(tr);
  });
  updateHeadTypeNudge();
}

function updateHeadField(head, f, el) {
  if (f === "needsReplacement") head.needsReplacement = el.checked;
  else if (f === "type") { if (el.value) head.type = el.value; else delete head.type; }
  else if (f === "riserHeightIn") head.riserHeightIn = el.value === "" ? null : (+el.value || 0);
  else if (f === "sprinklerZoneId") head.sprinklerZoneId = el.value;
  else if (NUMERIC_HEAD_FIELDS.indexOf(f) !== -1) head[f] = +el.value || 0;
  else head[f] = el.value; // id, nozzleFamily, brand, model, nozzle, notes
}

// Migration nudge (PLAN.md section 3 step 3): prompt the user to set head types
// rather than silently guessing rotary vs fixed.
function updateHeadTypeNudge() {
  const nudge = document.getElementById("headTypeNudge");
  if (!nudge) return;
  const anyUnset = getState().heads.some((h) => !h.type);
  nudge.style.display = anyUnset ? "block" : "none";
}

/* ------------------------------- coverage --------------------------------- */

function recomputeAndRender() {
  const data = computeCoverage();
  document.getElementById("computeTime").textContent = `computed in ${fmt(data.ms, 0)}ms`;
  drawHeatmap(data);
  renderZoneSummary(data);
}

function renderZoneSummary(data) {
  const state = getState();
  const tbody = document.querySelector("#zoneSummaryTable tbody");
  tbody.innerHTML = "";
  const cyclesEl = document.getElementById("cyclesPerWeek");
  const cyclesPerWeek = (cyclesEl ? +cyclesEl.value : 3) || 1;
  const cellArea = data.cell * data.cell;
  let totalGpm = 0, anyOver = false;

  state.sprinklerZones.forEach((z) => {
    const heads = state.heads.filter((h) => h.sprinklerZoneId === z.id);
    const gpm = heads.reduce((s, h) => s + (+h.ratedGpm || 0), 0);
    totalGpm = Math.max(totalGpm, gpm);
    const st = statsFromGrid(data.zoneGrids[z.id], cellArea, cyclesPerWeek);
    const over = z.supplyGpm != null && z.supplyGpm > 0 && gpm > z.supplyGpm;
    if (over) anyOver = true;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="zone-swatch" style="background:${zoneColorFor(z.id)}"></span>${escapeHtml(z.name)}</td>
      <td>${heads.length}</td>
      <td>${fmt(gpm, 2)} ${over ? `<span class="badge bad" title="Exceeds available GPM">over</span>` : ""}</td>
      <td>${fmt(st.min, 2)}</td>
      <td>${fmt(st.med, 2)}</td>
      <td>${fmt(st.max, 2)}</td>
      <td>${fmt(st.avgWeekly, 2)} <span class="muted">/ target ${fmt(z.weeklyTargetIn, 2)}</span></td>
      <td>${st.avg > 0 ? `<span class="badge ${Math.abs(st.avgWeekly - z.weeklyTargetIn) <= z.weeklyTargetIn * 0.25 ? "ok" : "bad"}">${st.avgWeekly >= z.weeklyTargetIn ? "on/over" : "under"}</span>` : "–"}</td>
    `;
    tbody.appendChild(tr);
  });

  const totalHeads = state.heads.length;
  const coveredCells = data.grid.flat().filter((v) => v > 1e-6).length;
  const sqftCovered = coveredCells * cellArea;
  document.getElementById("systemStats").innerHTML = `
    <div class="stat"><div class="v">${totalHeads}</div><div class="l">Total heads</div></div>
    <div class="stat"><div class="v">${fmt(sqftCovered, 0)}</div><div class="l">Sq ft covered</div></div>
    <div class="stat ${anyOver ? "warn" : ""}"><div class="v">${fmt(totalGpm, 1)}</div><div class="l">Peak zone GPM</div></div>
  `;
}

/* ---------------------------- save / load UI ------------------------------ */

function wireHeaderActions() {
  document.getElementById("btnExport").addEventListener("click", exportJSON);
  document.getElementById("btnImportTrigger").addEventListener("click", () => document.getElementById("btnImport").click());
  document.getElementById("btnImport").addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) importJSONFile(e.target.files[0], () => { selectedHeadId = null; renderAll(); });
    e.target.value = "";
  });
  document.getElementById("btnNew").addEventListener("click", () => {
    if (confirm("Start a new blank project? This clears the yard, zones, and heads currently loaded (your saved data stays in this browser until you overwrite it; export first if unsure).")) {
      setState(defaultState());
      selectedHeadId = null;
      saveState(true);
      renderAll();
    }
  });
  document.getElementById("btnAddHead").addEventListener("click", () => addHead({ id: uid("H") }));
  document.getElementById("btnAddZone").addEventListener("click", addZone);
  document.getElementById("btnRecompute").addEventListener("click", recomputeAndRender);
  document.getElementById("coverageZoneFilter").addEventListener("change", redrawHeatmap);
  document.getElementById("cyclesPerWeek").addEventListener("change", () => { const d = getLastHeatData(); if (d) renderZoneSummary(d); });
}

/* --------------------------------- render --------------------------------- */

function renderAll() {
  bindYardFormValuesOnly();
  renderZoneTable();
  renderHeadsTable();
  drawYardCanvas();
  bindForecastFormValuesOnly();
}

/* ---------------------------------- init ---------------------------------- */

function init() {
  const loaded = loadState();
  if (loaded) setState(loaded);

  wireTabs();
  wireHeaderActions();
  bindYardForm();
  bindForecastForm();
  attachForecastActions();
  initCanvas({ getSelectedHeadId: () => selectedHeadId });

  renderZoneTable();
  renderHeadsTable();

  // Seed a couple of example heads on the first-ever load so the canvas isn't empty.
  const state = getState();
  if (state.heads.length === 0 && !localStorage.getItem(SEEDED_KEY)) {
    const zid = state.sprinklerZones[0] ? state.sprinklerZones[0].id : "sz1";
    addHead({ id: "H1", sprinklerZoneId: zid, x: 15, y: 50, radiusFt: 20, arcStartDeg: 0, arcEndDeg: 360, ratedGpm: 2.5, notes: "example; edit or delete me" });
    addHead({ id: "H2", sprinklerZoneId: zid, x: 45, y: 50, radiusFt: 22, arcStartDeg: 0, arcEndDeg: 360, ratedGpm: 2.5, notes: "example; edit or delete me" });
    localStorage.setItem(SEEDED_KEY, "1");
  }

  drawYardCanvas();
  document.getElementById("saveStatus").textContent = "Loaded";

  window.addEventListener("resize", () => { drawYardCanvas(); redrawHeatmap(); });
}

init();
