/* =============================================================================
 * schedule.js - watering-schedule resolution (schema v2, four-mode model).
 *
 * JS twin of tests/test_schedule.py; keep them in sync and re-run pytest.
 *
 * Modes (confirmed with Alex, extends PLAN.md section 3):
 *   every_day     -> waters daily                         (7.0 cycles/wk)
 *   odd_even      -> odd OR even CALENDAR dates            (3.5 cycles/wk)
 *   days_of_week  -> a chosen set of weekdays Mon..Sun     (count cycles/wk)
 *   interval      -> every N days from an anchor date      (7/N cycles/wk)
 * ========================================================================== */

const MS_PER_DAY = 86400000;
const DEFAULT_ANCHOR = "2000-01-03"; // a Monday; used when interval has no anchorDate

// Effective cycles per week. Always displayed to 1 decimal in the UI.
export function effectiveCyclesPerWeek(schedule) {
  const mode = schedule && schedule.mode;
  if (mode === "every_day") return 7.0;
  if (mode === "odd_even") return 3.5;
  if (mode === "days_of_week") return (schedule.daysOfWeek || []).length;
  if (mode === "interval") return schedule.intervalDays > 0 ? 7 / schedule.intervalDays : 0;
  throw new Error("unknown schedule mode: " + mode);
}

// Monday=0 .. Sunday=6 weekday for a JS Date (getDay() is Sun=0..Sat=6).
function mondayWeekday(date) { return (date.getDay() + 6) % 7; }

// Whole days between two dates, ignoring time-of-day (local midnight to midnight).
function dayNumber(date) {
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / MS_PER_DAY);
}

export function isScheduledDay(schedule, date) {
  const mode = schedule && schedule.mode;
  if (mode === "every_day") return true;

  if (mode === "odd_even") {
    const isOddDate = (date.getDate() % 2) === 1;
    return isOddDate === (schedule.oddEvenChoice === "odd");
  }

  if (mode === "days_of_week") {
    const days = schedule.daysOfWeek || [];
    return days.indexOf(mondayWeekday(date)) !== -1;
  }

  if (mode === "interval") {
    const n = schedule.intervalDays;
    if (!n || n <= 0) return false;
    const anchor = new Date((schedule.anchorDate || DEFAULT_ANCHOR) + "T00:00:00");
    const diff = dayNumber(date) - dayNumber(anchor);
    return (((diff % n) + n) % n) === 0;
  }

  throw new Error("unknown schedule mode: " + mode);
}

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function scheduleLabel(schedule) {
  const mode = schedule && schedule.mode;
  if (mode === "every_day") return "Every day";
  if (mode === "odd_even") return (schedule.oddEvenChoice === "even" ? "Even" : "Odd") + " days";
  if (mode === "days_of_week") {
    const days = (schedule.daysOfWeek || []).slice().sort((a, b) => a - b);
    return days.length ? days.map((d) => DOW_LABELS[d]).join(", ") : "No days";
  }
  if (mode === "interval") return "Every " + (schedule.intervalDays || "?") + " days";
  return "n/a";
}
