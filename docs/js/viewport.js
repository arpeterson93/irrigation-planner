/* =============================================================================
 * viewport.js - responsive signal module (PLAN.md Phase 8, task 44).
 *
 * Two INDEPENDENT signals for two different problems (PLAN.md 8.1):
 *
 *   - isNarrow(): matchMedia("(max-width: 700px)"). Governs LAYOUT decisions
 *     (head card list vs. table, responsive canvas height, chrome density).
 *     Layout is about available space, so viewport width is the honest signal.
 *     KEEP THE 700px LITERAL IN SYNC with the media queries in styles.css.
 *
 *   - isCoarse(): matchMedia("(pointer: coarse)"). Governs INTERACTION
 *     affordances (canvas hit-target size, the tap-to-edit head modal). A
 *     touchscreen laptop at desktop width reports a *fine* primary pointer and
 *     correctly keeps the precision drag handles; an iPad reports *coarse* and
 *     gets the bigger targets + modal. Width says nothing about either case.
 *
 * onViewportChange(cb) subscribes cb to both media queries' change events so the
 * app can re-render the affected surfaces when either signal flips (e.g. rotating
 * a tablet across the 700px line, or docking a tablet to a mouse).
 * ========================================================================== */

const narrowMQ = window.matchMedia("(max-width: 700px)");
const coarseMQ = window.matchMedia("(pointer: coarse)");

export function isNarrow() { return narrowMQ.matches; }
export function isCoarse() { return coarseMQ.matches; }

export function onViewportChange(cb) {
  const handler = () => cb();
  addMQListener(narrowMQ, handler);
  addMQListener(coarseMQ, handler);
}

function addMQListener(mq, handler) {
  if (mq.addEventListener) mq.addEventListener("change", handler);
  else if (mq.addListener) mq.addListener(handler); // older Safari fallback
}
