/* =============================================================================
 * schedule.js - watering-schedule resolution (schema v2).
 *
 * This is the JS twin of tests/test_schedule.py. The two intentionally duplicate
 * the same logic (PLAN.md section 2 note): the Python pins the behavior to a spec,
 * this drives the app. Keep them in sync - if you change a rule here, change it
 * there and re-run pytest.
 *
 * Wired into the UI in Phase 3 (task 19) and the Forecast tab in Phase 4 (task 20).
 * ========================================================================== */

// Effective cycles per week for a zone's schedule. Always shown to 1 decimal.
export function effectiveCyclesPerWeek(schedule) {
  const mode = schedule && schedule.mode;
  if (mode === "every_day") return 7.0;
  if (mode === "odd_even") return 3.5;
  if (mode === "n_per_week") return Number(schedule.nPerWeek);
  throw new Error("unknown schedule mode: " + mode);
}

// Whether a given date is a watering day for this schedule. `date` is a JS Date.
export function isScheduledDay(schedule, date) {
  const mode = schedule && schedule.mode;
  if (mode === "every_day") return true;

  if (mode === "odd_even") {
    const isOddDate = (date.getDate() % 2) === 1;
    const wantsOdd = schedule.oddEvenChoice === "odd";
    return isOddDate === wantsOdd;
  }

  if (mode === "n_per_week") {
    // JS getDay(): Sun=0..Sat=6. We use Mon=0..Sun=6 to match the Python/plan spec.
    const weekday = (date.getDay() + 6) % 7;
    const daysOfWeek = schedule.daysOfWeek;
    if (daysOfWeek && daysOfWeek.length) {
      return daysOfWeek.indexOf(weekday) !== -1;
    }
    // No explicit days chosen: assume evenly spaced starting Monday (PLAN.md 6.2).
    const n = schedule.nPerWeek;
    if (n <= 0) return false;
    const spacing = 7 / n;
    const scheduledWeekdays = new Set();
    for (let i = 0; i < Math.floor(n); i++) scheduledWeekdays.add(Math.round(i * spacing) % 7);
    return scheduledWeekdays.has(weekday);
  }

  throw new Error("unknown schedule mode: " + mode);
}

// Short human label for a schedule, e.g. "Odd days" / "3×/week".
export function scheduleLabel(schedule) {
  const mode = schedule && schedule.mode;
  if (mode === "every_day") return "Every day";
  if (mode === "odd_even") return (schedule.oddEvenChoice === "even" ? "Even" : "Odd") + " days";
  if (mode === "n_per_week") return schedule.nPerWeek + "×/week";
  return "n/a";
}
