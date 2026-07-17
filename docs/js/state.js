/* =============================================================================
 * state.js - schema v2 owner: default shape, v1->v2 migration, localStorage
 * autosave, JSON export/import, and a few generic helpers shared app-wide.
 *
 * Geometry contract (PLAN.md section 3): all stored coordinates are in YARD FEET
 * with origin (0,0) at the BOTTOM-LEFT and y increasing upward. The canvas layer
 * (canvas.js) is the ONLY place that flips y for the screen. No stored coordinate
 * is ever in canvas/pixel space.
 * ========================================================================== */

export const SCHEMA_VERSION = 2;
export const STORAGE_KEY = "sprinklerSimState_v2";
export const LEGACY_STORAGE_KEY = "sprinklerSimState_v1";
export const SEEDED_KEY = "sprinklerSimState_v2_seeded";

export const MAX_ZONES = 12;
export const INITIAL_ZONES = 6;

// 12 distinct zone colors (v1 shipped the first six; the rest extend the palette
// so all 12 controllable zones stay visually separable).
export const ZONE_COLORS = [
  "#2fa968", "#1c6fa8", "#d98c1a", "#8e44ad", "#c0392b", "#16a085",
  "#e67e22", "#2c3e50", "#27ae60", "#2980b9", "#f39c12", "#7f8c8d",
];

/* ----------------------------- generic helpers ---------------------------- */

export function uid(prefix) { return prefix + Math.random().toString(36).slice(2, 7); }
export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
export function fmt(n, d) {
  if (n === null || n === undefined || isNaN(n)) return "–"; // en dash placeholder
  return Number(n).toFixed(d === undefined ? 2 : d);
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ------------------------------- the state -------------------------------- */

let state = defaultState();
export function getState() { return state; }
export function setState(next) { state = next; return state; }

export function defaultBackground() {
  return { imageDataUrl: null, scaleFtPerPx: null, offsetXFt: 0, offsetYFt: 0, rotationDeg: 0, opacity: 0.5 };
}
export function defaultForecast() {
  return { latitude: null, longitude: null, windowDays: 7, efficiencyPct: 80 };
}
export function defaultSync() {
  return { enabled: false, endpointUrl: null, userKey: null, lastSyncedAt: null };
}
export function defaultSchedule() {
  // Mirrors v1's default cycles-per-week of 3 (see migration note below).
  return { mode: "n_per_week", nPerWeek: 3 };
}

export function makeZone(index) {
  return {
    id: "sz" + (index + 1),
    name: "Zone " + (index + 1),
    supplyGpm: 10,
    runTimeMin: 20,
    weeklyTargetIn: 1.0,
    schedule: defaultSchedule(),
  };
}

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    yard: { widthFt: 80, heightFt: 60, cellSizeFt: 2 },
    sprinklerZones: Array.from({ length: INITIAL_ZONES }, (_, i) => makeZone(i)),
    yardZones: [],
    deadSpaces: [],
    heads: [],
    background: defaultBackground(),
    forecast: defaultForecast(),
    sync: defaultSync(),
  };
}

/* ----------------------------- zone lookups ------------------------------- */

export function zoneById(id) { return state.sprinklerZones.find((z) => z.id === id); }
export function zoneIndex(id) { return state.sprinklerZones.findIndex((z) => z.id === id); }
export function zoneColorFor(id) {
  const i = zoneIndex(id);
  return ZONE_COLORS[(i < 0 ? 0 : i) % ZONE_COLORS.length];
}

/* ------------------------------- migration -------------------------------- */

// Detect a v1-shaped blob: it has yard.width/height and zones with runMin.
function looksLikeV1(raw) {
  return raw && raw.yard && (raw.yard.width !== undefined || raw.yard.height !== undefined)
    && Array.isArray(raw.zones);
}

// Convert v1's single raw cycles-per-week number into a schema-v2 schedule.
// (PLAN.md section 3 step 4.) v1 had no per-zone schedule; the only persisted
// cycles-like value is forecast.wateringDays, so that is the source.
export function cyclesToSchedule(value) {
  const v = Number(value);
  if (v === 7) return { mode: "every_day" };
  if (v === 3.5) return { mode: "odd_even", oddEvenChoice: "odd", _needsOddEvenChoice: true };
  const n = clamp(Math.round(v) || 3, 1, 7);
  return { mode: "n_per_week", nPerWeek: n };
}

// Best-effort head type from v1 free-text notes. PLAN.md section 3 step 3 says
// NOT to silently guess rotary vs fixed, so we only set type when the note gives
// an explicit hint; otherwise leave it undefined and flag for a UI nudge.
function inferHeadType(notes) {
  const n = String(notes || "").toLowerCase();
  if (/rotor|rotary|mp\s?rotator|rotate/.test(n)) return "rotary";
  if (/spray|fixed|pop-?up|mist/.test(n)) return "fixed";
  return undefined;
}

export function migrateV1toV2(v1) {
  const heightFt = Number(v1.yard.height) || 60;
  const widthFt = Number(v1.yard.width) || 80;

  const sched = cyclesToSchedule(v1.forecast ? v1.forecast.wateringDays : 3);

  const idMap = new Map(); // old int zone id -> new string id
  const sprinklerZones = (v1.zones || []).map((z, i) => {
    const newId = "sz" + (i + 1);
    idMap.set(z.id, newId);
    const supply = z.gpmAvail;
    return {
      id: newId,
      name: z.name != null ? String(z.name) : "Zone " + (i + 1),
      supplyGpm: (typeof supply === "number" && supply > 0) ? supply : null,
      runTimeMin: Number(z.runMin) || 0,
      weeklyTargetIn: Number(z.targetIn) || 0,
      schedule: JSON.parse(JSON.stringify(sched)),
    };
  });

  const firstZoneId = sprinklerZones.length ? sprinklerZones[0].id : "sz1";

  const heads = (v1.heads || []).map((h) => {
    const type = inferHeadType(h.notes);
    return {
      id: h.id != null ? String(h.id) : uid("H"),
      sprinklerZoneId: idMap.get(h.zone) || firstZoneId,
      x: Number(h.x) || 0,
      y: heightFt - (Number(h.y) || 0), // step 1: flip y to bottom-left origin
      radiusFt: Number(h.radius) || 0,
      arcStartDeg: Number(h.arcStart) || 0,
      arcEndDeg: Number(h.arcEnd) || 0,
      ratedGpm: Number(h.gpm) || 0,
      ...(type ? { type } : {}),
      nozzleFamily: "",
      brand: "",
      model: "",
      nozzle: "",
      riserHeightIn: null,
      needsReplacement: false,
      notes: h.notes != null ? String(h.notes) : "",
    };
  });

  const fc = v1.forecast || {};
  const forecast = {
    latitude: parseFloat(fc.lat),
    longitude: parseFloat(fc.lon),
    windowDays: 7,
    efficiencyPct: (typeof fc.runoffEff === "number") ? Math.round(fc.runoffEff * 100) : 80,
  };
  if (isNaN(forecast.latitude)) forecast.latitude = null;
  if (isNaN(forecast.longitude)) forecast.longitude = null;

  const out = {
    schemaVersion: SCHEMA_VERSION,
    yard: { widthFt, heightFt, cellSizeFt: Number(v1.yard.cellSize) || 2 },
    sprinklerZones: sprinklerZones.length ? sprinklerZones : defaultState().sprinklerZones,
    yardZones: [],
    deadSpaces: [],
    heads,
    background: defaultBackground(),
    forecast,
    sync: defaultSync(),
    // Belt-and-suspenders backup (PLAN.md section 3 step 6). Held in memory and
    // written into the first export; stripped before it touches localStorage.
    _v1Backup: JSON.parse(JSON.stringify(v1)),
  };
  return out;
}

// Fill in any missing top-level keys so older/partial v2 blobs stay valid.
export function normalizeV2(raw) {
  const d = defaultState();
  const out = Object.assign({}, raw);
  out.schemaVersion = SCHEMA_VERSION;
  out.yard = Object.assign({ cellSizeFt: 2 }, d.yard, raw.yard || {});
  out.sprinklerZones = Array.isArray(raw.sprinklerZones) && raw.sprinklerZones.length
    ? raw.sprinklerZones : d.sprinklerZones;
  out.yardZones = Array.isArray(raw.yardZones) ? raw.yardZones : [];
  out.deadSpaces = Array.isArray(raw.deadSpaces) ? raw.deadSpaces : [];
  out.heads = Array.isArray(raw.heads) ? raw.heads : [];
  out.background = Object.assign(defaultBackground(), raw.background || {});
  out.forecast = Object.assign(defaultForecast(), raw.forecast || {});
  out.sync = Object.assign(defaultSync(), raw.sync || {});
  return out;
}

// Entry point: take any saved/imported blob and return a normalized v2 object.
export function coerceToV2(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.schemaVersion === SCHEMA_VERSION) return normalizeV2(raw);
  if (looksLikeV1(raw)) return migrateV1toV2(raw);
  return null;
}

/* ------------------------------ persistence ------------------------------- */

export function loadState() {
  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY);
    if (rawV2) {
      const parsed = coerceToV2(JSON.parse(rawV2));
      if (parsed) return parsed;
    }
    const rawV1 = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (rawV1) {
      const migrated = coerceToV2(JSON.parse(rawV1));
      if (migrated) return migrated;
    }
  } catch (e) {
    console.warn("Failed to load saved state", e);
  }
  return null;
}

let saveTimer = null;
export function saveState(immediate) {
  const status = document.getElementById("saveStatus");
  if (status) status.textContent = "Saving…";
  clearTimeout(saveTimer);
  const doSave = () => {
    try {
      // _v1Backup is intentionally not persisted to localStorage (PLAN.md 3.6).
      const { _v1Backup, ...persistable } = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
      if (status) {
        status.textContent = "Saved " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
    } catch (e) {
      if (status) status.textContent = "Save failed (storage full?)";
      console.error(e);
    }
  };
  if (immediate) doSave(); else saveTimer = setTimeout(doSave, 400);
}

export function exportJSON() {
  // The first export after a migration carries _v1Backup; normal exports won't have it.
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `sprinkler-simulator-${stamp}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function importJSONFile(file, onDone) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      const v2 = coerceToV2(parsed);
      if (!v2) throw new Error("Not a recognizable Sprinkler Simulator project (v1 or v2).");
      setState(v2);
      saveState(true);
      if (onDone) onDone();
    } catch (err) {
      alert("Couldn't read that file as a Sprinkler Simulator project: " + err.message);
    }
  };
  reader.readAsText(file);
}
