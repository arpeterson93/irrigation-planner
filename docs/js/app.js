/* =============================================================================
 * app.js - bootstrapping, tab wiring, top-level state, form/table rendering.
 *
 * This is the composition root. It owns UI-only state (which head is selected)
 * and wires the pure/render modules (state, coverage, canvas, forecast) to the
 * DOM. The math and geometry live in their own modules; this file is glue.
 * ========================================================================== */

import {
  getState, setState, defaultState, loadState, saveState, exportJSON, importJSONFile,
  coerceToV2, uid, clamp, fmt, escapeHtml, zoneColorFor, zoneById, MAX_ZONES, SEEDED_KEY, makeZone,
} from "./state.js";
import { isSyncConfigured, pullFromCloud, pushToCloud } from "./sync.js";
import {
  computeCoverage, statsOverCells, avgOverCells, pointInPolygon,
  zoneRatedGpm, zoneScaleFactor, headPrecipRate, polygonAreaSqFt,
} from "./coverage.js";
import {
  initCanvas, drawYardCanvas, drawHeatmap, redrawHeatmap, getLastHeatData,
  setMode, getMode, deleteArea, compressImageFile,
} from "./canvas.js";
import { effectiveCyclesPerWeek, scheduleLabel } from "./schedule.js";
import { buildGridCsv, parseGridCsv } from "./gridcsv.js";
import { zoneFlowGpm, estimateGallons } from "./usage.js";
import {
  bindForecastForm, bindForecastFormValuesOnly, attachForecastActions, renderForecast,
} from "./forecast.js";
import { isNarrow, isCoarse, onViewportChange } from "./viewport.js";

/* ------------------------------- UI state --------------------------------- */

let selectedHeadId = null;

const NUMERIC_HEAD_FIELDS = ["x", "y", "radiusFt", "arcStartDeg", "arcEndDeg", "ratedGpm"];
const DEAD_SPACE_KINDS = ["house", "patio", "deck", "driveway", "pool", "bed", "other"];

// Shared selection entry point used by both the heads table and the canvas.
// Highlights the head's table row and redraws the canvas, but deliberately does
// NOT scroll the page: dragging a head on the canvas used to jerk the page to the
// table row (PLAN.md task 43 amends task 11's "scrolls to its table row").
function selectHead(id) {
  selectedHeadId = id;
  renderHeadsTable();
  drawYardCanvas();
  updateEditHeadButton();
}

// Re-render every table/list from current state. Called after canvas edits commit.
function refreshTables() {
  renderZoneTable();
  renderHeadsTable();
  renderAreaLists();
  renderUsage();
  renderForecast();
  updateModeUI();
}

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
  c.addEventListener("change", () => { const y = getState().yard; y.cellSizeFt = clamp(+c.value || 1, 1, 10); c.value = y.cellSizeFt; saveState(); });
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
      <td class="schedule-cell">${escapeHtml(scheduleLabel(z.schedule))} <span class="muted">· ${effectiveCyclesPerWeek(z.schedule).toFixed(1)}/wk</span> <button class="btn-light btn-sm" data-act="editSched">Edit</button></td>
      <td><button class="btn-light btn-sm" data-act="flow">Flow…</button></td>
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
    tr.querySelector('[data-act="editSched"]').addEventListener("click", () => openScheduleModal(z.id));
    tr.querySelector('[data-act="flow"]').addEventListener("click", () => openFlowModal(z.id));
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

// Sequential head ids: H1, H2, ... Scan existing /^H(\d+)$/ ids, take max+1
// (start at 1). Legacy random-suffix ids (from uid("H")) stay valid and are just
// skipped by the scan (PLAN.md task 34).
function nextHeadId(state) {
  let max = 0;
  (state || getState()).heads.forEach((h) => {
    const m = /^H(\d+)$/.exec(h.id);
    if (m) max = Math.max(max, +m[1]);
  });
  return "H" + (max + 1);
}

function addHead(defaults) {
  const state = getState();
  const firstZone = state.sprinklerZones[0];
  const h = Object.assign({
    id: nextHeadId(state),
    sprinklerZoneId: firstZone ? firstZone.id : "sz1",
    x: Math.round(state.yard.widthFt / 2),
    y: Math.round(state.yard.heightFt / 2),
    radiusFt: 15, arcStartDeg: 0, arcEndDeg: 360, ratedGpm: 2.0,
    brand: "", model: "", nozzle: "", riserHeightIn: null,
    needsReplacement: false, notes: "",
  }, defaults || {});
  state.heads.push(h);
  saveState();
  renderHeadsTable();
  drawYardCanvas();
}

function typeOptions(selected) {
  const opts = [["", "Unset"], ["rotary", "Rotary"], ["fixed", "Fixed"]];
  return opts.map(([v, label]) => `<option value="${v}" ${(selected || "") === v ? "selected" : ""}>${label}</option>`).join("");
}

// Entry point for both head-list surfaces. Below the 700px breakpoint the heads
// render as a card-per-head list (usable on a phone); at wider widths the full
// 17-column table (PLAN.md task 46). CSS toggles which container is visible; we
// render only the visible one, and onViewportChange re-invokes this on a flip.
function renderHeadsTable() {
  if (isNarrow()) renderHeadsCards();
  else renderHeadsRows();
  updateHeadTypeNudge();
  updateHeadsListSummary();
}

// Keep the narrow-only collapse toggle's label showing the current head count so
// it stays useful at a glance while collapsed (PLAN.md Phase 9, task 51). The
// summary is CSS-hidden above 700px, so this text is only ever seen on narrow.
function updateHeadsListSummary() {
  const summary = document.getElementById("headsListSummary");
  if (!summary) return;
  const n = getState().heads.length;
  summary.textContent = `${n} head${n === 1 ? "" : "s"} - tap to show/hide`;
}

// Shared field wiring for a single head control, used identically by the table
// rows, the mobile cards, and the tap-to-edit modal (PLAN.md tasks 46, 48) so
// updateHeadField / saveState / selection / structural re-render never drift.
// syncList=true re-renders the head list on EVERY change: used only by the modal,
// whose inputs live in separate DOM from the list, so re-rendering the cards
// behind it keeps them fresh without clobbering the field being edited. Inline
// list edits pass false so a keystroke in a cell isn't torn out mid-edit.
function attachHeadFieldHandlers(inp, h, syncList) {
  inp.addEventListener("change", () => {
    updateHeadField(h, inp.dataset.f, inp);
    saveState();
    const structural = ["sprinklerZoneId", "type", "needsReplacement"].indexOf(inp.dataset.f) !== -1;
    if (structural || syncList) renderHeadsTable();
    drawYardCanvas();
    updateHeadTypeNudge();
    renderUsage();
  });
  inp.addEventListener("focus", () => { selectedHeadId = h.id; drawYardCanvas(); updateEditHeadButton(); });
}

function deleteHead(id) {
  const state = getState();
  state.heads = state.heads.filter((x) => x.id !== id);
  if (selectedHeadId === id) selectedHeadId = null;
  saveState(); renderHeadsTable(); drawYardCanvas(); updateHeadTypeNudge(); renderUsage();
  updateEditHeadButton();
}

function renderHeadsRows() {
  const state = getState();
  const tbody = document.querySelector("#headsTable tbody");
  tbody.innerHTML = "";
  const colCount = document.querySelectorAll("#headsTable thead th").length;

  if (state.heads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty">No heads yet. Click "+ Add head" to start mapping your yard.</td></tr>`;
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
      <td><select data-f="type">${typeOptions(h.type)}</select>${sanityFlagHtml(h)}</td>
      <td><input type="number" data-f="x" value="${h.x}" step="1" style="width:60px;"></td>
      <td><input type="number" data-f="y" value="${h.y}" step="1" style="width:60px;"></td>
      <td><input type="number" data-f="radiusFt" value="${h.radiusFt}" step="1" min="0" style="width:60px;"></td>
      <td><input type="number" data-f="arcStartDeg" value="${h.arcStartDeg}" step="5" min="0" max="360" style="width:60px;"></td>
      <td><input type="number" data-f="arcEndDeg" value="${h.arcEndDeg}" step="5" min="0" max="360" style="width:60px;"></td>
      <td><input type="number" data-f="ratedGpm" value="${h.ratedGpm}" step="0.1" min="0" style="width:60px;"></td>
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
      selectHead(h.id);
    });
    tr.querySelectorAll("input,select").forEach((inp) => attachHeadFieldHandlers(inp, h));
    tr.querySelector('[data-act="del"]').addEventListener("click", () => deleteHead(h.id));
    tbody.appendChild(tr);
  });
}

// Mobile head cards (PLAN.md task 46, decision (b)): geometry fields visible,
// audit fields behind a native <details>More expander. Every control keeps its
// data-f attribute and the shared attachHeadFieldHandlers wiring, so editing,
// saving, and selection behave exactly like the table path.
function renderHeadsCards() {
  const state = getState();
  const wrap = document.getElementById("headsCards");
  if (!wrap) return;
  wrap.innerHTML = "";

  if (state.heads.length === 0) {
    wrap.innerHTML = `<div class="empty">No heads yet. Click "+ Add head" to start mapping your yard.</div>`;
    return;
  }

  state.heads.forEach((h) => {
    const card = document.createElement("div");
    card.className = "head-card" + (h.id === selectedHeadId ? " selected" : "");
    card.dataset.id = h.id;
    const zoneOpts = state.sprinklerZones.map((z, i) =>
      `<option value="${z.id}" ${z.id === h.sprinklerZoneId ? "selected" : ""}>${i + 1}</option>`).join("");
    card.innerHTML = `
      <div class="head-card-head">
        <span class="zone-swatch" style="background:${zoneColorFor(h.sprinklerZoneId)}"></span>
        <input type="text" data-f="id" value="${escapeHtml(h.id)}" class="hc-id" aria-label="Head ID">
        <select data-f="sprinklerZoneId" class="hc-zone" aria-label="Zone">${zoneOpts}</select>
        <button class="btn-danger btn-sm" data-act="del" aria-label="Delete head">✕</button>
      </div>
      <div class="field-row">
        <div class="field"><label>Type</label><select data-f="type">${typeOptions(h.type)}</select></div>
        <div class="field"><label>X (ft)</label><input type="number" data-f="x" value="${h.x}" step="1" inputmode="decimal"></div>
        <div class="field"><label>Y (ft)</label><input type="number" data-f="y" value="${h.y}" step="1" inputmode="decimal"></div>
        <div class="field"><label>Radius (ft)</label><input type="number" data-f="radiusFt" value="${h.radiusFt}" step="1" min="0" inputmode="decimal"></div>
        <div class="field"><label>Arc start°</label><input type="number" data-f="arcStartDeg" value="${h.arcStartDeg}" step="5" min="0" max="360" inputmode="decimal"></div>
        <div class="field"><label>Arc end°</label><input type="number" data-f="arcEndDeg" value="${h.arcEndDeg}" step="5" min="0" max="360" inputmode="decimal"></div>
        <div class="field"><label>GPM</label><input type="number" data-f="ratedGpm" value="${h.ratedGpm}" step="0.1" min="0" inputmode="decimal"></div>
      </div>
      <div class="hc-flag">${sanityFlagHtml(h)}</div>
      <details class="hc-more">
        <summary>More</summary>
        <div class="field-row">
          <div class="field"><label>Brand</label><input type="text" data-f="brand" value="${escapeHtml(h.brand || "")}"></div>
          <div class="field"><label>Model</label><input type="text" data-f="model" value="${escapeHtml(h.model || "")}"></div>
          <div class="field"><label>Nozzle</label><input type="text" data-f="nozzle" value="${escapeHtml(h.nozzle || "")}"></div>
          <div class="field"><label>Riser (in)</label><input type="number" data-f="riserHeightIn" value="${h.riserHeightIn == null ? "" : h.riserHeightIn}" step="1" min="0" inputmode="decimal" placeholder="-"></div>
          <div class="field"><label>Replace?</label><input type="checkbox" data-f="needsReplacement" ${h.needsReplacement ? "checked" : ""} style="width:auto;"></div>
          <div class="field"><label>Notes</label><input type="text" data-f="notes" value="${escapeHtml(h.notes || "")}" placeholder="e.g. corner rotor"></div>
        </div>
      </details>
    `;
    card.addEventListener("click", (e) => {
      const t = e.target.tagName;
      if (t === "INPUT" || t === "BUTTON" || t === "SELECT" || t === "OPTION" || t === "SUMMARY") return;
      if (e.target.closest("summary")) return; // don't hijack the expander toggle
      selectHead(h.id);
    });
    card.querySelectorAll("input,select").forEach((inp) => attachHeadFieldHandlers(inp, h));
    card.querySelector('[data-act="del"]').addEventListener("click", (e) => { e.stopPropagation(); deleteHead(h.id); });
    wrap.appendChild(card);
  });
}

function updateHeadField(head, f, el) {
  if (f === "needsReplacement") head.needsReplacement = el.checked;
  else if (f === "type") { if (el.value) head.type = el.value; else delete head.type; }
  else if (f === "riserHeightIn") head.riserHeightIn = el.value === "" ? null : (+el.value || 0);
  else if (f === "sprinklerZoneId") head.sprinklerZoneId = el.value;
  else if (NUMERIC_HEAD_FIELDS.indexOf(f) !== -1) head[f] = +el.value || 0;
  else head[f] = el.value; // id, brand, model, nozzle, notes
}

// Migration nudge (PLAN.md section 3 step 3): prompt the user to set head types
// rather than silently guessing rotary vs fixed.
function updateHeadTypeNudge() {
  const nudge = document.getElementById("headTypeNudge");
  if (nudge) {
    const anyUnset = getState().heads.some((h) => !h.type);
    nudge.style.display = anyUnset ? "block" : "none";
  }
  updateHeadWarnings();
}

function sanityFlagHtml(head) {
  const f = headSanityFlag(head);
  return f ? ` <span class="sanity-flag" title="${escapeHtml(f)}">⚠</span>` : "";
}

/* ------------------------- yard zones / dead spaces ----------------------- */

function renderAreaLists() {
  const state = getState();

  const yzBody = document.querySelector("#yardZoneTable tbody");
  yzBody.innerHTML = "";
  state.yardZones.forEach((z) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="color" data-f="color" value="${z.color || "#4caf50"}" style="width:38px; padding:2px;"></td>
      <td><input type="text" data-f="name" value="${escapeHtml(z.name || "")}" style="min-width:110px;"></td>
      <td>${z.polygon.length}</td>
      <td>${fmt(polygonAreaSqFt(z.polygon), 0)}</td>
      <td><button class="btn-danger btn-sm" data-act="del">✕</button></td>
    `;
    tr.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", () => {
      z[inp.dataset.f] = inp.value; saveState(); drawYardCanvas();
    }));
    tr.querySelector('[data-act="del"]').addEventListener("click", () => deleteArea("yardzone", z.id));
    yzBody.appendChild(tr);
  });
  toggleEmpty("yardZoneTable", "yardZoneEmpty", state.yardZones.length === 0);

  const dsBody = document.querySelector("#deadSpaceTable tbody");
  dsBody.innerHTML = "";
  state.deadSpaces.forEach((d) => {
    const tr = document.createElement("tr");
    const kindOpts = DEAD_SPACE_KINDS.map((k) => `<option value="${k}" ${d.kind === k ? "selected" : ""}>${k}</option>`).join("");
    tr.innerHTML = `
      <td><input type="text" data-f="label" value="${escapeHtml(d.label || "")}" style="min-width:110px;"></td>
      <td><select data-f="kind">${kindOpts}</select></td>
      <td>${d.polygon.length}</td>
      <td>${fmt(polygonAreaSqFt(d.polygon), 0)}</td>
      <td><button class="btn-danger btn-sm" data-act="del">✕</button></td>
    `;
    tr.querySelectorAll("input,select").forEach((inp) => inp.addEventListener("change", () => {
      d[inp.dataset.f] = inp.value; saveState(); drawYardCanvas();
    }));
    tr.querySelector('[data-act="del"]').addEventListener("click", () => deleteArea("deadspace", d.id));
    dsBody.appendChild(tr);
  });
  toggleEmpty("deadSpaceTable", "deadSpaceEmpty", state.deadSpaces.length === 0);
}

function toggleEmpty(tableId, emptyId, isEmpty) {
  const wrap = document.getElementById(tableId).closest(".table-wrap");
  const empty = document.getElementById(emptyId);
  if (wrap) wrap.style.display = isEmpty ? "none" : "";
  if (empty) empty.style.display = isEmpty ? "block" : "none";
}

/* ------------------------------ canvas modes ------------------------------ */

const MODE_HINTS = {
  select: "Drag a head to move it; select one for radius/arc handles. Drag a polygon vertex to reshape; double-click a vertex to delete it; click an area then press Delete to remove it.",
  yardzone: "Click to drop vertices for a yard zone. Click the first vertex again or double-click to finish. Esc cancels.",
  deadspace: "Click to drop vertices for a dead space. Click the first vertex again or double-click to finish. Esc cancels.",
  calibrate: "Click two points a known real-world distance apart, then enter that distance in feet.",
  bgmove: "Drag on the canvas to reposition the background image.",
};

function updateModeUI() {
  const m = getMode();
  document.querySelectorAll("#canvasTools .mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  const hint = document.getElementById("canvasHint");
  if (hint) hint.textContent = MODE_HINTS[m] || "";
}

function wireCanvasTools() {
  document.querySelectorAll("#canvasTools .mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => { setMode(btn.dataset.mode); updateModeUI(); });
  });
  const edit = document.getElementById("btnEditHead");
  if (edit) edit.addEventListener("click", () => openEditHeadModal(selectedHeadId));
}

/* --------------------------- background controls -------------------------- */

function bindBackgroundValues() {
  const bg = getState().background;
  const op = document.getElementById("bgOpacity");
  const rot = document.getElementById("bgRotation");
  if (op) op.value = bg.opacity == null ? 0.5 : bg.opacity;
  if (rot) rot.value = bg.rotationDeg || 0;
  updateFirstRunHint();
}

const FIRST_RUN_KEY = "sprinklerFirstRunDismissed";
function updateFirstRunHint() {
  const el = document.getElementById("firstRunHint");
  if (!el) return;
  const dismissed = localStorage.getItem(FIRST_RUN_KEY);
  const hasBg = !!getState().background.imageDataUrl;
  el.style.display = (!dismissed && !hasBg) ? "flex" : "none";
}

function wireBackgroundControls() {
  document.getElementById("btnBgUpload").addEventListener("click", () => document.getElementById("bgFile").click());
  document.getElementById("bgFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    compressImageFile(file).then(({ dataUrl, width }) => {
      const bg = getState().background;
      bg.imageDataUrl = dataUrl;
      if (bg.scaleFtPerPx == null) bg.scaleFtPerPx = getState().yard.widthFt / width; // default: image spans yard width
      saveState(); drawYardCanvas();
    }).catch(() => alert("Couldn't read that image file."));
  });
  document.getElementById("bgOpacity").addEventListener("input", (e) => {
    getState().background.opacity = +e.target.value; saveState(); drawYardCanvas();
  });
  document.getElementById("bgRotation").addEventListener("change", (e) => {
    getState().background.rotationDeg = +e.target.value || 0; saveState(); drawYardCanvas();
  });
  document.getElementById("btnBgRemove").addEventListener("click", () => {
    // Keep calibration numbers (scale/offset/rotation) so re-attaching is easy (PLAN.md 6.3).
    getState().background.imageDataUrl = null; saveState(); drawYardCanvas();
  });
}

/* --------------------------------- modals --------------------------------- */

function openModal(html) {
  const box = document.getElementById("modalBox");
  box.innerHTML = html;
  document.getElementById("modalOverlay").style.display = "flex";
  return box;
}
function closeModal() {
  document.getElementById("modalOverlay").style.display = "none";
  document.getElementById("modalBox").innerHTML = "";
}
function wireModal() {
  const overlay = document.getElementById("modalOverlay");
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.style.display !== "none") closeModal(); });
}

// After a coverage-affecting change (schedule, supply), recompute if a heatmap
// already exists so weekly rollups stay consistent; otherwise just refresh tables.
function refreshAfterModelChange() {
  refreshTables();
  if (getLastHeatData()) recomputeAndRender();
}

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function openScheduleModal(zoneId) {
  const z = zoneById(zoneId);
  if (!z) return;
  const s = z.schedule || {};
  const todayIso = new Date().toISOString().slice(0, 10);
  openModal(`
    <h3>Schedule: ${escapeHtml(z.name)}</h3>
    <div class="field">
      <label>Watering pattern</label>
      <select id="schedMode">
        <option value="every_day">Every day</option>
        <option value="odd_even">Odd / even calendar days</option>
        <option value="days_of_week">Specific days of the week</option>
        <option value="interval">Every N days</option>
      </select>
    </div>
    <div id="schedDetail"></div>
    <div class="hint" id="schedCycles"></div>
    <div class="modal-actions">
      <button class="btn-light btn-sm" id="schedCancel">Cancel</button>
      <button class="btn-light btn-sm" id="schedCopyAll" title="Apply this schedule to every zone at once (one-time copy)">Copy to all zones</button>
      <button class="btn-primary btn-sm" id="schedSave">Save</button>
    </div>
  `);
  const modeSel = document.getElementById("schedMode");
  modeSel.value = s.mode || "days_of_week";

  const detail = document.getElementById("schedDetail");
  const cyclesHint = document.getElementById("schedCycles");

  function renderDetail() {
    const m = modeSel.value;
    if (m === "odd_even") {
      detail.innerHTML = `<div class="field"><label>Which dates</label>
        <select id="schedOdd"><option value="odd">Odd dates (1st, 3rd, ...)</option><option value="even">Even dates (2nd, 4th, ...)</option></select></div>`;
      document.getElementById("schedOdd").value = s.oddEvenChoice || "odd";
    } else if (m === "days_of_week") {
      const chosen = new Set(s.daysOfWeek || []);
      detail.innerHTML = `<label>Days</label><div class="dow-row">${DOW_LABELS.map((d, i) =>
        `<label><input type="checkbox" data-dow="${i}" ${chosen.has(i) ? "checked" : ""}>${d}</label>`).join("")}</div>`;
    } else if (m === "interval") {
      detail.innerHTML = `<div class="field-row">
        <div class="field"><label>Every N days</label><input type="number" id="schedN" min="1" max="30" step="1" value="${s.intervalDays || 2}"></div>
        <div class="field"><label>Starting on</label><input type="date" id="schedAnchor" value="${s.anchorDate || todayIso}"></div></div>`;
    } else {
      detail.innerHTML = "";
    }
    updateCyclesHint();
  }
  function collect() {
    const m = modeSel.value;
    if (m === "every_day") return { mode: "every_day" };
    if (m === "odd_even") return { mode: "odd_even", oddEvenChoice: document.getElementById("schedOdd").value };
    if (m === "days_of_week") {
      const days = Array.from(detail.querySelectorAll("input[data-dow]:checked")).map((c) => +c.dataset.dow).sort((a, b) => a - b);
      return { mode: "days_of_week", daysOfWeek: days };
    }
    return { mode: "interval", intervalDays: Math.max(1, +document.getElementById("schedN").value || 2), anchorDate: document.getElementById("schedAnchor").value || todayIso };
  }
  function updateCyclesHint() {
    let cycles = 0;
    try { cycles = effectiveCyclesPerWeek(collect()); } catch (e) { cycles = 0; }
    cyclesHint.textContent = `Effective cycles per week: ${cycles.toFixed(1)}`;
  }

  modeSel.addEventListener("change", renderDetail);
  detail.addEventListener("change", updateCyclesHint);
  detail.addEventListener("input", updateCyclesHint);
  renderDetail();

  function validateCollected(sched) {
    if (sched.mode === "days_of_week" && sched.daysOfWeek.length === 0) { alert("Pick at least one day of the week."); return false; }
    return true;
  }

  document.getElementById("schedCancel").addEventListener("click", closeModal);
  document.getElementById("schedSave").addEventListener("click", () => {
    const sched = collect();
    if (!validateCollected(sched)) return;
    z.schedule = sched;
    saveState();
    closeModal();
    refreshAfterModelChange();
  });
  // One-time copy (PLAN.md task 31): deep-copy this schedule into every zone. Not a
  // persistent link; zones can be edited independently afterward.
  document.getElementById("schedCopyAll").addEventListener("click", () => {
    const sched = collect();
    if (!validateCollected(sched)) return;
    const zones = getState().sprinklerZones;
    if (!confirm(`Apply this schedule to all ${zones.length} zones? This overwrites each zone's current schedule.`)) return;
    zones.forEach((zone) => { zone.schedule = JSON.parse(JSON.stringify(sched)); });
    saveState();
    closeModal();
    refreshAfterModelChange();
  });
}

function openFlowModal(zoneId) {
  const z = zoneById(zoneId);
  if (!z) return;
  openModal(`
    <h3>Measure flow: ${escapeHtml(z.name)}</h3>
    <p class="hint">Run this zone and measure at your water meter, then compute the delivered GPM and apply it as the zone's supply.</p>
    <div class="field">
      <label>Method</label>
      <select id="flowMethod">
        <option value="gallons">Gallons over a timed interval</option>
        <option value="revs">Meter revolutions x gallons-per-revolution</option>
      </select>
    </div>
    <div id="flowInputs"></div>
    <div class="calc-out" id="flowOut">GPM: -</div>
    <div class="modal-actions">
      <button class="btn-light btn-sm" id="flowCancel">Cancel</button>
      <button class="btn-primary btn-sm" id="flowApply">Apply as supply GPM</button>
    </div>
  `);
  const method = document.getElementById("flowMethod");
  const inputs = document.getElementById("flowInputs");
  const out = document.getElementById("flowOut");
  let gpm = 0;

  function renderInputs() {
    if (method.value === "gallons") {
      inputs.innerHTML = `<div class="field-row">
        <div class="field"><label>Meter before</label><input type="number" id="fBefore" min="0" step="0.1"></div>
        <div class="field"><label>Meter after</label><input type="number" id="fAfter" min="0" step="0.1"></div>
        <div class="field"><label>Over minutes</label><input type="number" id="fMin" min="0" step="0.1"></div></div>`;
    } else {
      inputs.innerHTML = `<div class="field-row">
        <div class="field"><label>Revolutions</label><input type="number" id="fRevs" min="0" step="0.1"></div>
        <div class="field"><label>Gal / revolution</label><input type="number" id="fGpr" min="0" step="0.01"></div>
        <div class="field"><label>Over minutes</label><input type="number" id="fMin" min="0" step="0.1"></div></div>`;
    }
    inputs.querySelectorAll("input").forEach((i) => i.addEventListener("input", compute));
    compute();
  }
  function compute() {
    const mins = +(document.getElementById("fMin") || {}).value || 0;
    if (method.value === "gallons") {
      const before = +(document.getElementById("fBefore") || {}).value || 0;
      const after = +(document.getElementById("fAfter") || {}).value || 0;
      const g = after - before; // guard against after <= before below (gpm stays 0)
      gpm = (mins > 0 && g > 0) ? g / mins : 0;
    } else {
      const revs = +(document.getElementById("fRevs") || {}).value || 0;
      const gpr = +(document.getElementById("fGpr") || {}).value || 0;
      gpm = mins > 0 ? (revs * gpr) / mins : 0;
    }
    out.textContent = `GPM: ${gpm > 0 ? gpm.toFixed(2) : "-"}`;
  }
  method.addEventListener("change", renderInputs);
  renderInputs();

  document.getElementById("flowCancel").addEventListener("click", closeModal);
  document.getElementById("flowApply").addEventListener("click", () => {
    if (!(gpm > 0)) { alert("Enter values that produce a positive GPM first."); return; }
    z.supplyGpm = +gpm.toFixed(2);
    saveState();
    closeModal();
    refreshAfterModelChange();
  });
}

/* --------------------------- edit-head modal (touch) --------------------- */

// The "Edit head" button is the precision path promised in PLAN.md 6.7 and built
// in task 48: only meaningful when a head is selected AND the device is coarse-
// pointer or narrow (fingertips can't hit exact arc/radius handle pixels). Fine-
// pointer desktop never sees it, honoring the desktop-untouched constraint.
function updateEditHeadButton() {
  const btn = document.getElementById("btnEditHead");
  if (!btn) return;
  const show = !!selectedHeadId && (isCoarse() || isNarrow());
  btn.style.display = show ? "" : "none";
}

// Precision editor for the selected head. Edits apply live on change through the
// exact same attachHeadFieldHandlers pipeline as the table/cards, so the single
// action is "Close" (no OK/Cancel semantics to drift). Number inputs get
// inputmode="decimal" for a numeric phone keyboard.
function openEditHeadModal(headId) {
  const state = getState();
  const h = state.heads.find((x) => x.id === headId);
  if (!h) return;
  const zoneOpts = state.sprinklerZones.map((z, i) =>
    `<option value="${z.id}" ${z.id === h.sprinklerZoneId ? "selected" : ""}>${i + 1}</option>`).join("");
  const box = openModal(`
    <h3>Edit head ${escapeHtml(h.id)}</h3>
    <p class="hint">Changes apply live. Drag handles on the canvas still work for rough moves; use these fields for exact arc and radius values.</p>
    <div class="field-row" id="editHeadFields">
      <div class="field"><label>Zone</label><select data-f="sprinklerZoneId">${zoneOpts}</select></div>
      <div class="field"><label>Type</label><select data-f="type">${typeOptions(h.type)}</select></div>
      <div class="field"><label>X (ft)</label><input type="number" data-f="x" value="${h.x}" step="1" inputmode="decimal"></div>
      <div class="field"><label>Y (ft)</label><input type="number" data-f="y" value="${h.y}" step="1" inputmode="decimal"></div>
      <div class="field"><label>Radius (ft)</label><input type="number" data-f="radiusFt" value="${h.radiusFt}" step="1" min="0" inputmode="decimal"></div>
      <div class="field"><label>Arc start°</label><input type="number" data-f="arcStartDeg" value="${h.arcStartDeg}" step="5" min="0" max="360" inputmode="decimal"></div>
      <div class="field"><label>Arc end°</label><input type="number" data-f="arcEndDeg" value="${h.arcEndDeg}" step="5" min="0" max="360" inputmode="decimal"></div>
      <div class="field"><label>GPM</label><input type="number" data-f="ratedGpm" value="${h.ratedGpm}" step="0.1" min="0" inputmode="decimal"></div>
    </div>
    <div class="modal-actions">
      <button class="btn-primary btn-sm" id="editHeadClose">Close</button>
    </div>
  `);
  box.querySelectorAll("#editHeadFields input, #editHeadFields select").forEach((inp) => attachHeadFieldHandlers(inp, h, true));
  document.getElementById("editHeadClose").addEventListener("click", closeModal);
}

/* ---------------------------- head-type warnings -------------------------- */

const PRECIP_RANGES = { fixed: [1.3, 2.0], rotary: [0.4, 0.9] };

// Soft sanity check: is a head's rated precip rate far outside the typical band
// for its nozzle type? (PLAN.md task 17b.) Returns a message or null.
function headSanityFlag(head) {
  if (!head.type || !PRECIP_RANGES[head.type]) return null;
  const rate = headPrecipRate(head);
  if (rate <= 0) return null;
  const [lo, hi] = PRECIP_RANGES[head.type];
  if (rate < lo * 0.5 || rate > hi * 1.5) {
    return `Precip ${fmt(rate, 2)} in/hr is well outside the typical ${lo}-${hi} in/hr for ${head.type} heads; rated GPM or arc may be misentered.`;
  }
  return null;
}

function updateHeadWarnings() {
  const state = getState();
  const msgs = [];
  state.sprinklerZones.forEach((z) => {
    const types = new Set(state.heads.filter((h) => h.sprinklerZoneId === z.id && h.type).map((h) => h.type));
    if (types.has("rotary") && types.has("fixed")) {
      msgs.push(`Zone "${escapeHtml(z.name)}" mixes rotary and fixed heads. They run at very different precipitation rates, causing uneven watering; consider separating them or matching nozzles.`);
    }
  });
  const flagged = state.heads.filter((h) => headSanityFlag(h)).length;
  if (flagged) msgs.push(`${flagged} head(s) have a precip rate outside the typical range for their type (marked with a warning sign in the table).`);

  const banner = document.getElementById("headWarnings");
  if (!banner) return;
  if (msgs.length) {
    banner.style.display = "block";
    banner.innerHTML = `<b>Coverage warnings</b><ul>${msgs.map((m) => `<li>${m}</li>`).join("")}</ul>`;
  } else {
    banner.style.display = "none";
  }
}

/* ------------------------------ cloud sync -------------------------------- */

function openSyncModal() {
  const s = getState().sync;
  openModal(`
    <h3>Cloud sync</h3>
    <p class="hint">Optional. Save your yard config to a shared Google Sheet and reload it on another device. The satellite image stays on this device; everything else syncs. Sync is preconfigured; just enter your own key below. Setup instructions: apps-script/DEPLOY.md.</p>
    <div class="field"><label>Your key</label><input type="text" id="syncKey" placeholder="e.g. blue-otter-4821" value="${escapeHtml(s.userKey || "")}"></div>
    <label style="display:flex; align-items:center; gap:8px; font-weight:600;"><input type="checkbox" id="syncEnabled" ${s.enabled ? "checked" : ""} style="width:auto;"> Auto-load from cloud when the app opens</label>
    <div class="hint" id="syncStatus" style="margin-top:8px;">${s.lastSyncedAt ? ("Last synced " + escapeHtml(s.lastSyncedAt)) : "Not synced yet."}</div>
    <div class="modal-actions">
      <button class="btn-light btn-sm" id="syncClose">Close</button>
      <button class="btn-light btn-sm" id="syncLoad">Load from cloud</button>
      <button class="btn-primary btn-sm" id="syncSave">Save to cloud</button>
    </div>
  `);
  const persist = () => {
    const sy = getState().sync;
    sy.userKey = document.getElementById("syncKey").value.trim() || null;
    sy.enabled = document.getElementById("syncEnabled").checked;
    saveState();
  };
  document.getElementById("syncKey").addEventListener("change", persist);
  document.getElementById("syncEnabled").addEventListener("change", persist);
  document.getElementById("syncClose").addEventListener("click", closeModal);
  document.getElementById("syncSave").addEventListener("click", () => { persist(); doSaveToCloud(); });
  document.getElementById("syncLoad").addEventListener("click", () => { persist(); doLoadFromCloud(); });
}

function setSyncStatus(msg) { const el = document.getElementById("syncStatus"); if (el) el.textContent = msg; }

async function doSaveToCloud() {
  if (!isSyncConfigured(getState())) { alert("Enter your key first."); return; }
  setSyncStatus("Saving to cloud...");
  try {
    let res = await pushToCloud(getState().sync.lastSyncedAt);
    if (res.conflict) {
      const overwrite = confirm("The cloud copy is newer than your last sync.\n\nOK = overwrite it with this device's data.\nCancel = load the cloud copy instead.");
      if (overwrite) { res = await pushToCloud(res.updatedAt); }
      else { applyCloudConfig(res.config, res.updatedAt); setSyncStatus("Loaded the cloud copy."); return; }
    }
    if (res.error) throw new Error(res.error);
    getState().sync.lastSyncedAt = res.updatedAt; saveState();
    setSyncStatus("Saved " + res.updatedAt);
  } catch (err) {
    console.error(err); setSyncStatus("Save failed: " + err.message);
    alert("Cloud save failed: " + err.message);
  }
}

async function doLoadFromCloud() {
  if (!isSyncConfigured(getState())) { alert("Enter your key first."); return; }
  setSyncStatus("Loading from cloud...");
  try {
    const res = await pullFromCloud();
    if (res.error === "not_found") { setSyncStatus("No cloud copy exists for this key yet."); return; }
    if (res.error) throw new Error(res.error);
    if (!res.config) { setSyncStatus("The cloud copy was empty."); return; }
    applyCloudConfig(res.config, res.updatedAt);
    setSyncStatus("Loaded " + res.updatedAt);
  } catch (err) {
    console.error(err); setSyncStatus("Load failed: " + err.message);
    alert("Cloud load failed: " + err.message);
  }
}

function applyCloudConfig(config, updatedAt) {
  const local = getState();
  const incoming = coerceToV2(config);
  if (!incoming) { alert("The cloud config was unreadable."); return; }
  incoming.background.imageDataUrl = local.background.imageDataUrl; // keep local-only image
  incoming.sync = Object.assign({}, local.sync, { lastSyncedAt: updatedAt }); // keep local endpoint/key
  setState(incoming);
  saveState(true);
  selectedHeadId = null;
  renderAll();
}

async function autoPullOnLoad() {
  const s = getState().sync;
  if (!(s.enabled && isSyncConfigured(getState()))) return;
  try {
    const res = await pullFromCloud();
    if (res && res.config && res.updatedAt && res.updatedAt !== s.lastSyncedAt) {
      if (confirm("A cloud copy of your config is available (updated " + res.updatedAt + "). Load it now? Your local copy stays until you overwrite it.")) {
        applyCloudConfig(res.config, res.updatedAt);
      }
    }
  } catch (err) {
    console.warn("auto-pull failed", err);
  }
}

/* ------------------------------- coverage --------------------------------- */

function recomputeAndRender() {
  const data = computeCoverage();
  document.getElementById("computeTime").textContent = `computed in ${fmt(data.ms, 0)}ms`;
  drawHeatmap(data);
  renderZoneSummary(data);
}

function cellInPolygon(data, r, c, poly) {
  return pointInPolygon([(c + 0.5) * data.cell, (r + 0.5) * data.cell], poly);
}

function renderZoneSummary(data) {
  const state = getState();
  const groupEl = document.getElementById("summaryGroupBy");
  const groupBy = groupEl ? groupEl.value : "sprinkler";
  const table = document.getElementById("zoneSummaryTable");
  const notDead = (r, c) => !data.deadMask[r][c];

  if (groupBy === "yard") {
    let rows = "";
    state.yardZones.forEach((yz) => {
      const inZone = (r, c) => notDead(r, c) && cellInPolygon(data, r, c, yz.polygon);
      const st = statsOverCells(data.grid, data.cell, inZone);
      const weeklyAvg = avgOverCells(data.weeklyGrid, inZone);
      rows += `<tr>
        <td><span class="zone-swatch" style="background:${yz.color || "#4caf50"}"></span>${escapeHtml(yz.name)}</td>
        <td>${fmt(st.sqft, 0)}</td>
        <td>${fmt(st.min, 2)}</td><td>${fmt(st.med, 2)}</td><td>${fmt(st.max, 2)}</td>
        <td>${fmt(st.avg, 2)}</td><td>${fmt(weeklyAvg, 2)}</td>
      </tr>`;
    });
    if (!state.yardZones.length) rows = `<tr><td colspan="7" class="empty">No yard zones defined. Draw one with the "+ Yard zone" tool on the preview. Overlapping zones each count the shared cells.</td></tr>`;
    table.innerHTML = `<thead><tr><th>Yard zone</th><th>Sq ft</th><th>Min in/cycle</th><th>Med in/cycle</th><th>Max in/cycle</th><th>Avg in/cycle</th><th>Avg in/wk</th></tr></thead><tbody>${rows}</tbody>`;
  } else {
    let rows = "";
    state.sprinklerZones.forEach((z) => {
      const heads = state.heads.filter((h) => h.sprinklerZoneId === z.id);
      const rated = zoneRatedGpm(heads);
      const factor = zoneScaleFactor(z, heads);
      const over = factor < 1;
      const cycles = effectiveCyclesPerWeek(z.schedule);
      const zg = data.zoneGrids[z.id]; // may be absent if data predates this zone
      const st = zg ? statsOverCells(zg, data.cell, notDead) : { min: 0, med: 0, max: 0, avg: 0, sqft: 0, count: 0 };
      const weeklyAvg = st.avg * cycles;
      const scaleBadge = over
        ? ` <span class="badge warnflag" title="Supply ${fmt(z.supplyGpm, 1)} GPM is below the ${fmt(rated, 1)} GPM rated total; each head scaled x${factor.toFixed(2)}">x${factor.toFixed(2)}</span>`
        : "";
      rows += `<tr>
        <td><span class="zone-swatch" style="background:${zoneColorFor(z.id)}"></span>${escapeHtml(z.name)}</td>
        <td>${heads.length}</td>
        <td>${fmt(rated, 2)}${scaleBadge}</td>
        <td>${fmt(st.min, 2)}</td><td>${fmt(st.med, 2)}</td><td>${fmt(st.max, 2)}</td>
        <td title="${escapeHtml(`target ${fmt(z.weeklyTargetIn, 2)}"/wk at ${cycles.toFixed(1)} cycles/wk`)}">${fmt(weeklyAvg, 2)}</td>
        <td>${st.avg > 0 ? `<span class="badge ${Math.abs(weeklyAvg - z.weeklyTargetIn) <= z.weeklyTargetIn * 0.25 ? "ok" : "bad"}">${weeklyAvg >= z.weeklyTargetIn ? "on/over" : "under"}</span>` : "–"}</td>
      </tr>`;
    });
    table.innerHTML = `<thead><tr><th>Zone</th><th>Heads</th><th>Rated GPM</th><th>Min in/cycle</th><th>Med in/cycle</th><th>Max in/cycle</th><th>Avg in/wk</th><th>Status</th></tr></thead><tbody>${rows}</tbody>`;
  }

  // System stats (Peak Zone GPM removed per task 16).
  let coveredCells = 0, deadCells = 0;
  for (let r = 0; r < data.rows; r++) {
    for (let c = 0; c < data.cols; c++) {
      if (data.deadMask[r][c]) { deadCells++; continue; }
      if (data.grid[r][c] > 1e-6) coveredCells++;
    }
  }
  const cellArea = data.cell * data.cell;
  document.getElementById("systemStats").innerHTML = `
    <div class="stat"><div class="v">${state.heads.length}</div><div class="l">Total heads</div></div>
    <div class="stat"><div class="v">${fmt(coveredCells * cellArea, 0)}</div><div class="l">Sq ft covered</div></div>
    <div class="stat"><div class="v">${fmt(deadCells * cellArea, 0)}</div><div class="l">Dead space (sq ft)</div></div>
  `;
}

/* --------------------------- water usage estimate ------------------------- */

function renderUsage() {
  const state = getState();
  const tbody = document.querySelector("#usageTable tbody");
  if (!tbody) return;
  let wk = 0, mo = 0;
  const rows = state.sprinklerZones.map((z) => {
    const heads = state.heads.filter((h) => h.sprinklerZoneId === z.id);
    const flow = zoneFlowGpm(z, heads);
    const g = estimateGallons(z, heads);
    wk += g.gallonsPerWeek; mo += g.gallonsPerMonth;
    return `<tr>
      <td><span class="zone-swatch" style="background:${zoneColorFor(z.id)}"></span>${escapeHtml(z.name)}</td>
      <td>${fmt(flow, 2)}</td>
      <td>${effectiveCyclesPerWeek(z.schedule).toFixed(1)}</td>
      <td>${fmt(g.gallonsPerWeek, 0)}</td>
      <td>${fmt(g.gallonsPerMonth, 0)}</td>
    </tr>`;
  }).join("");
  tbody.innerHTML = rows +
    `<tr><td><b>Total</b></td><td></td><td></td><td><b>${fmt(wk, 0)}</b></td><td><b>${fmt(mo, 0)}</b></td></tr>`;
}

/* ---------------------------- save / load UI ------------------------------ */

function wireHeaderActions() {
  document.getElementById("btnExport").addEventListener("click", exportJSON);
  document.getElementById("btnImportTrigger").addEventListener("click", () => document.getElementById("btnImport").click());
  // Task 51: About-tab twins of Export/Import so the actions stay reachable when
  // the narrow header hides them; same handlers, same hidden file input.
  document.getElementById("btnExportAbout").addEventListener("click", exportJSON);
  document.getElementById("btnImportTriggerAbout").addEventListener("click", () => document.getElementById("btnImport").click());
  document.getElementById("btnImport").addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) importJSONFile(e.target.files[0], () => { selectedHeadId = null; renderAll(); });
    e.target.value = "";
  });
  // Task 59: CSV grid export/import for yard zones and dead spaces.
  document.getElementById("btnGridExport").addEventListener("click", () => {
    const csv = buildGridCsv(getState());
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `sprinkler-simulator-yard-grid-${stamp}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
  document.getElementById("btnGridImportTrigger").addEventListener("click", () => document.getElementById("btnGridImport").click());
  document.getElementById("btnGridImport").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      let parsed;
      try {
        parsed = parseGridCsv(ev.target.result, getState());
      } catch (err) {
        alert(err.message);
        return;
      }
      const state = getState();
      const n = parsed.yardZones.length + parsed.deadSpaces.length;
      if (!confirm(`Replace the current ${state.yardZones.length} yard zone(s) and ${state.deadSpaces.length} dead space(s) with the ${n} area(s) from this file?`)) return;
      state.yardZones = parsed.yardZones;
      state.deadSpaces = parsed.deadSpaces;
      saveState(true);
      renderAreaLists();
      drawYardCanvas();
    };
    reader.readAsText(file);
  });
  document.getElementById("btnNew").addEventListener("click", () => {
    if (confirm("Start a new blank project? This clears the yard, zones, and heads currently loaded (your saved data stays in this browser until you overwrite it; export first if unsure).")) {
      setState(defaultState());
      selectedHeadId = null;
      saveState(true);
      renderAll();
    }
  });
  document.getElementById("btnAddHead").addEventListener("click", () => addHead());
  document.getElementById("btnAddZone").addEventListener("click", addZone);
  document.getElementById("btnSync").addEventListener("click", openSyncModal);
  document.getElementById("firstRunDismiss").addEventListener("click", () => {
    localStorage.setItem(FIRST_RUN_KEY, "1"); updateFirstRunHint();
  });
  document.getElementById("btnRecompute").addEventListener("click", recomputeAndRender);
  document.getElementById("coverageZoneFilter").addEventListener("change", redrawHeatmap);
  document.getElementById("summaryGroupBy").addEventListener("change", () => { const d = getLastHeatData(); if (d) renderZoneSummary(d); });
}

/* --------------------------------- render --------------------------------- */

function renderAll() {
  bindYardFormValuesOnly();
  renderZoneTable();
  renderHeadsTable();
  renderAreaLists();
  renderUsage();
  bindBackgroundValues();
  updateModeUI();
  drawYardCanvas();
  bindForecastFormValuesOnly();
  renderForecast();
}

/* ---------------------------------- init ---------------------------------- */

function init() {
  const loaded = loadState();
  if (loaded) setState(loaded);

  wireTabs();
  wireHeaderActions();
  wireCanvasTools();
  wireBackgroundControls();
  wireModal();
  bindYardForm();
  bindForecastForm();
  attachForecastActions();
  initCanvas({ getSelectedHeadId: () => selectedHeadId, selectHead, refreshTables });

  renderZoneTable();
  renderHeadsTable();
  renderAreaLists();
  renderUsage();
  bindBackgroundValues();
  updateModeUI();

  // Seed a couple of example heads on the first-ever load so the canvas isn't empty.
  const state = getState();
  if (state.heads.length === 0 && !localStorage.getItem(SEEDED_KEY)) {
    const zid = state.sprinklerZones[0] ? state.sprinklerZones[0].id : "sz1";
    addHead({ id: "H1", sprinklerZoneId: zid, x: 15, y: 50, radiusFt: 20, arcStartDeg: 0, arcEndDeg: 360, ratedGpm: 2.5 });
    addHead({ id: "H2", sprinklerZoneId: zid, x: 45, y: 50, radiusFt: 22, arcStartDeg: 0, arcEndDeg: 360, ratedGpm: 2.5 });
    localStorage.setItem(SEEDED_KEY, "1");
  }

  drawYardCanvas();
  updateEditHeadButton();
  document.getElementById("saveStatus").textContent = "Loaded";

  window.addEventListener("resize", () => { drawYardCanvas(); redrawHeatmap(); });

  // Crossing the layout (700px) or interaction (pointer) signal re-renders the
  // affected surfaces: table<->cards, canvas height, the edit-head button
  // (PLAN.md task 44). Same calls as the resize listener, plus the head list.
  onViewportChange(() => {
    renderHeadsTable();
    drawYardCanvas();
    redrawHeatmap();
    updateEditHeadButton();
    // Task 51: above 700px the collapse toggle is hidden and can't be reopened,
    // so force the head list open when leaving narrow (covers a tablet resized
    // or rotated across the breakpoint while collapsed). Desktop stays fully shown.
    if (!isNarrow()) {
      const sec = document.getElementById("headsListSection");
      if (sec) sec.open = true;
    }
  });

  autoPullOnLoad(); // no-op unless sync is enabled + configured
}

init();
