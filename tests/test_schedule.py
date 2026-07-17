"""
Golden/spec tests for the watering schedule selector introduced in schema v2
(PLAN.md section 3: "every_day" | "odd_even" | "n_per_week", replacing the raw
cycles-per-week number input from v1).

These do not correspond to anything in the legacy file (v1 only had a plain
number input); they pin down the target behavior for docs/js/schedule.js
before it's built in Phase 1/3, so Opus has an unambiguous spec to implement
against instead of guessing at edge cases mid-build.
"""
import pytest


def effective_cycles_per_week(schedule):
    mode = schedule["mode"]
    if mode == "every_day":
        return 7.0
    if mode == "odd_even":
        return 3.5
    if mode == "n_per_week":
        return float(schedule["nPerWeek"])
    raise ValueError(f"unknown schedule mode: {mode}")


def is_scheduled_day(schedule, iso_date):
    """
    iso_date: a date-like object with .day (1-31) and .weekday() (Mon=0..Sun=6),
    e.g. a datetime.date. Used to decide whether the Forecast tab's day-by-day
    table should render an adjustment for that day.
    """
    mode = schedule["mode"]
    if mode == "every_day":
        return True
    if mode == "odd_even":
        is_odd_date = (iso_date.day % 2) == 1
        wants_odd = schedule["oddEvenChoice"] == "odd"
        return is_odd_date == wants_odd
    if mode == "n_per_week":
        days_of_week = schedule.get("daysOfWeek")
        if days_of_week:
            return iso_date.weekday() in days_of_week
        # No explicit days chosen: assume evenly spaced starting Monday (PLAN.md 6.2).
        n = schedule["nPerWeek"]
        if n <= 0:
            return False
        spacing = 7 / n
        # Monday = 0. A day is "scheduled" if it's the closest weekday to a multiple of spacing.
        scheduled_weekdays = {round(i * spacing) % 7 for i in range(int(n))}
        return iso_date.weekday() in scheduled_weekdays
    raise ValueError(f"unknown schedule mode: {mode}")


class TestEffectiveCyclesPerWeek:
    def test_every_day(self):
        assert effective_cycles_per_week({"mode": "every_day"}) == 7.0

    def test_odd_even_is_three_point_five(self):
        """This is the number explicitly called out as needing to display to 1 decimal."""
        assert effective_cycles_per_week({"mode": "odd_even", "oddEvenChoice": "odd"}) == 3.5

    def test_n_per_week(self):
        assert effective_cycles_per_week({"mode": "n_per_week", "nPerWeek": 4}) == 4.0

    def test_displayed_to_one_decimal(self):
        value = effective_cycles_per_week({"mode": "odd_even", "oddEvenChoice": "even"})
        assert f"{value:.1f}" == "3.5"


class TestOddEvenScheduledDays:
    def test_odd_dates_when_odd_chosen(self):
        import datetime
        schedule = {"mode": "odd_even", "oddEvenChoice": "odd"}
        assert is_scheduled_day(schedule, datetime.date(2026, 7, 1)) is True
        assert is_scheduled_day(schedule, datetime.date(2026, 7, 2)) is False

    def test_even_dates_when_even_chosen(self):
        import datetime
        schedule = {"mode": "odd_even", "oddEvenChoice": "even"}
        assert is_scheduled_day(schedule, datetime.date(2026, 7, 2)) is True
        assert is_scheduled_day(schedule, datetime.date(2026, 7, 1)) is False

    def test_month_boundary_can_give_consecutive_odd_days(self):
        """
        Documented ambiguity, PLAN.md 6.2: calendar odd/even (not strict alternation)
        means Jul 31 and Aug 1 are both odd dates, i.e. two scheduled days in a row.
        This test pins that this is the intended (if slightly surprising) behavior,
        not a bug, unless Alex asks for strict alternation instead.
        """
        import datetime
        schedule = {"mode": "odd_even", "oddEvenChoice": "odd"}
        assert is_scheduled_day(schedule, datetime.date(2026, 7, 31)) is True
        assert is_scheduled_day(schedule, datetime.date(2026, 8, 1)) is True


class TestNPerWeekScheduledDays:
    def test_explicit_days_of_week_respected(self):
        import datetime
        schedule = {"mode": "n_per_week", "nPerWeek": 2, "daysOfWeek": [1, 3]}  # Tue, Thu
        assert is_scheduled_day(schedule, datetime.date(2026, 7, 21)) is True   # Tuesday
        assert is_scheduled_day(schedule, datetime.date(2026, 7, 20)) is False  # Monday

    def test_falls_back_to_evenly_spaced_from_monday(self):
        import datetime
        schedule = {"mode": "n_per_week", "nPerWeek": 3}
        results = {
            d.weekday(): is_scheduled_day(schedule, d)
            for d in (datetime.date(2026, 7, 20) + datetime.timedelta(days=i) for i in range(7))
        }
        assert sum(results.values()) == 3
