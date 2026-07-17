/* =============================================================================
 * sync.js - optional Google Apps Script cloud-sync client.
 *
 * PLACEHOLDER for Phase 5 (tasks 24-26), which is gated behind an explicit
 * STOP/CONFIRM with Alex (PLAN.md section 4, Phase 5 header). Nothing here does
 * anything yet; the app is fully functional with sync disabled. The module exists
 * now only so the import graph and repo structure match PLAN.md section 2.
 *
 * When built, this will: read state.sync {enabled, endpointUrl, userKey}, POST
 * with Content-Type text/plain (no CORS preflight), GET ?key=..., and handle the
 * updatedAt conflict prompt. The satellite background image is never included in
 * the sync payload (PLAN.md section 1.2 carve-out).
 * ========================================================================== */

export function isSyncConfigured(state) {
  return !!(state && state.sync && state.sync.enabled && state.sync.endpointUrl && state.sync.userKey);
}

// No-op until Phase 5. Present so callers can be wired defensively.
export function initSync() { /* intentionally empty (Phase 5) */ }
