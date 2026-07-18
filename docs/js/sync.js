/* =============================================================================
 * sync.js - optional Google Apps Script cloud-sync client (PLAN.md Phase 5).
 *
 * Network + payload logic only; app.js owns the settings modal, the conflict
 * prompt, and applying a pulled config (it can re-render). The app is fully
 * functional with sync disabled/unconfigured - this is a bolt-on layer.
 *
 * Requests are shaped to avoid CORS preflight (PLAN.md 1.2): GET with a query
 * param, and POST with Content-Type text/plain (body is still a JSON string) and
 * no custom headers. fetch() follows the Apps Script 302 automatically.
 *
 * The satellite background image is NEVER sent (a Sheet cell caps at 50k chars);
 * calibration numbers travel so re-attaching the image on another device aligns.
 * ========================================================================== */

import { getState } from "./state.js";

export function isSyncConfigured(state) {
  const s = state || getState();
  return !!(s && s.sync && s.sync.endpointUrl && s.sync.userKey);
}

// The config object to send: strip the in-memory v1 backup and the local-only
// background image, keeping the calibration numbers.
export function buildPayloadConfig(state) {
  const s = state || getState();
  const { _v1Backup, ...rest } = s;
  const background = Object.assign({}, rest.background, { imageDataUrl: null });
  return Object.assign({}, rest, { background });
}

export async function pullFromCloud() {
  const sync = getState().sync;
  const sep = sync.endpointUrl.indexOf("?") >= 0 ? "&" : "?";
  const url = sync.endpointUrl + sep + "key=" + encodeURIComponent(sync.userKey);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json(); // { config, updatedAt } | { error }
}

export async function pushToCloud(baseUpdatedAt, note) {
  const state = getState();
  const sync = state.sync;
  const body = JSON.stringify({
    key: sync.userKey,
    config: buildPayloadConfig(state),
    baseUpdatedAt: baseUpdatedAt || null,
    note: note || "",
  });
  const res = await fetch(sync.endpointUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body,
    redirect: "follow",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json(); // { updatedAt } | { conflict, updatedAt, config } | { error }
}
