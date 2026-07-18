"""Spec tests for the four-mode watering schedule (schema v2).

Modes (confirmed with Alex, extends PLAN.md section 3):
  every_day | odd_even | days_of_week | interval

These pin the target behavior for docs/js/schedule.js (the two intentionally
duplicate the same logic). Mon=0..Sun=6 throughout.
"""
import datetime
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))


def effective_cycles_per_week(schedule):
    mode = schedule["mode"]
    if mode == "every_day":
        return 7.0
    if mode == "odd_even":
        return 3.5
    if mode == "days_of_week":
        return float(len(schedule.get("daysOfWeek", [])))
    if mode == "interval":
        n = schedule["intervalDays"]
        return 7 / n if n > 0 else 0.0
    raise ValueError(f"unknown schedule mode: {mode}")


DEFAULT_ANCHOR = datetime.date(2000, 1, 3)  # a Monday


def is_scheduled_day(schedule, d):
    mode = schedule["mode"]
    if mode == "every_day":
        return True
    if mode == "odd_even":
        return ((d.day % 2) == 1) == (schedule["oddEvenChoice"] == "odd")
    if mode == "days_of_week":
        return d.weekday() in schedule.get("daysOfWeek", [])
    if mode == "interval":
        n = schedule["intervalDays"]
        if n <= 0:
            return False
        anchor = (datetime.date.fromisoformat(schedule["anchorDate"])
                  if schedule.get("anchorDate") else DEFAULT_ANCHOR)
        return ((d - anchor).days % n) == 0
    raise ValueError(f"unknown schedule mode: {mode}")


class TestEffectiveCyclesPerWeek:
    def test_every_day(self):
        assert effective_cycles_per_week({"mode": "every_day"}) == 7.0

    def test_odd_even_is_three_point_five(self):
        assert effective_cycles_per_week({"mode": "odd_even", "oddEvenChoice": "odd"}) == 3.5

    def test_days_of_week_counts_days(self):
        assert effective_cycles_per_week({"mode": "days_of_week", "daysOfWeek": [0, 2, 4]}) == 3.0

    def test_interval_every_two_days(self):
        assert effective_cycles_per_week({"mode": "interval", "intervalDays": 2}) == 3.5

    def test_interval_every_three_days(self):
        assert effective_cycles_per_week({"mode": "interval", "intervalDays": 3}) == pytest.approx(7 / 3)

    def test_displayed_to_one_decimal(self):
        value = effective_cycles_per_week({"mode": "odd_even", "oddEvenChoice": "even"})
        assert f"{value:.1f}" == "3.5"


class TestOddEvenScheduledDays:
    def test_odd_dates_when_odd_chosen(self):
        s = {"mode": "odd_even", "oddEvenChoice": "odd"}
        assert is_scheduled_day(s, datetime.date(2026, 7, 1)) is True
        assert is_scheduled_day(s, datetime.date(2026, 7, 2)) is False

    def test_month_boundary_can_give_consecutive_odd_days(self):
        """Calendar odd/even (confirmed), not strict alternation: Jul 31 + Aug 1 are both odd."""
        s = {"mode": "odd_even", "oddEvenChoice": "odd"}
        assert is_scheduled_day(s, datetime.date(2026, 7, 31)) is True
        assert is_scheduled_day(s, datetime.date(2026, 8, 1)) is True


class TestDaysOfWeek:
    def test_explicit_days_respected(self):
        s = {"mode": "days_of_week", "daysOfWeek": [1, 3]}  # Tue, Thu
        assert is_scheduled_day(s, datetime.date(2026, 7, 21)) is True   # Tuesday
        assert is_scheduled_day(s, datetime.date(2026, 7, 20)) is False  # Monday


class TestInterval:
    def test_every_two_days_from_anchor(self):
        s = {"mode": "interval", "intervalDays": 2, "anchorDate": "2026-07-20"}
        assert is_scheduled_day(s, datetime.date(2026, 7, 20)) is True   # anchor
        assert is_scheduled_day(s, datetime.date(2026, 7, 21)) is False
        assert is_scheduled_day(s, datetime.date(2026, 7, 22)) is True

    def test_every_three_days_hits_expected_count_in_window(self):
        s = {"mode": "interval", "intervalDays": 3, "anchorDate": "2026-07-20"}
        scheduled = [is_scheduled_day(s, datetime.date(2026, 7, 20) + datetime.timedelta(days=i)) for i in range(9)]
        assert scheduled == [True, False, False, True, False, False, True, False, False]

    def test_interval_without_anchor_uses_default_monday(self):
        s = {"mode": "interval", "intervalDays": 7}
        # default anchor is a Monday; every 7 days lands on Mondays
        assert is_scheduled_day(s, datetime.date(2026, 7, 20)) is True   # a Monday
        assert is_scheduled_day(s, datetime.date(2026, 7, 21)) is False


class TestEvenlySpacedMigration:
    def test_n3_spacing(self):
        from migrate_v1_config import evenly_spaced_weekdays
        assert evenly_spaced_weekdays(3) == [0, 2, 5]

    def test_n2_spacing(self):
        from migrate_v1_config import evenly_spaced_weekdays
        assert evenly_spaced_weekdays(2) == [0, 4]
