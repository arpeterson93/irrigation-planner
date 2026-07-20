"""
Golden tests for the forecast math: Hargreaves-Samani ET0 (unchanged),
cycles-per-week baseline (unchanged), and the Phase 11 rework - Kc/ETc, net need
(floored, then Irrigation Need % scaled), combined net need over watering-day
groups, and one system-wide seasonal adjustment.

The Phase 11 helpers here are Python twins of docs/js/forecast.js (etcIn,
netNeedIn, combinedNetNeed, seasonalAdjustmentRaw, wateringDayGroups); keep both
sides in sync. hargreavesET0 is asserted against a hand-checked reference case.
"""
import json
import math
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures" / "golden_spreadsheet_values.json"

with open(FIXTURES) as f:
    GOLDEN = json.load(f)


def clamp(v, a, b):
    return max(a, min(b, v))


def hargreaves_et0_mm_day(lat_deg, tmax_c, tmin_c, day_of_year):
    """Hargreaves-Samani reference evapotranspiration, returns mm/day."""
    lat = math.radians(lat_deg)
    j = day_of_year
    dr = 1 + 0.033 * math.cos(2 * math.pi / 365 * j)
    delta = 0.409 * math.sin(2 * math.pi / 365 * j - 1.39)
    ws = math.acos(clamp(-math.tan(lat) * math.tan(delta), -1, 1))
    gsc = 0.0820
    ra = (24 * 60 / math.pi) * gsc * dr * (
        ws * math.sin(lat) * math.sin(delta) + math.cos(lat) * math.cos(delta) * math.sin(ws)
    )  # MJ/m2/day
    ra_mm = 0.408 * ra  # equivalent evaporation, mm/day
    tmean = (tmax_c + tmin_c) / 2
    diff = max(0, tmax_c - tmin_c)
    return 0.0023 * ra_mm * (tmean + 17.8) * math.sqrt(diff)


def baseline_daily_need_in(weekly_target_in, cycles_per_week):
    """Schema v2: baseline is always derived, never a manually maintained field."""
    if cycles_per_week <= 0:
        return 0
    return weekly_target_in / cycles_per_week


# --- Phase 11 pure helpers (twins of forecast.js) -------------------------- #

def etc_in(et0_in, kc):
    """Crop water use: ETc = ET0 x Kc (None if ET0 is unknown)."""
    return None if et0_in is None else et0_in * kc


def net_need_in(et0_in, rain_in, kc, eff_rain_pct, irr_need_pct):
    """max(0, ETc - rain x effRain%) x irrigationNeed% - floored at zero BEFORE
    the Irrigation Need % scalar (Phase 11 11.1 row 6). None if data is missing."""
    if et0_in is None or rain_in is None:
        return None
    etc = et0_in * kc
    return max(0.0, etc - rain_in * (eff_rain_pct / 100)) * (irr_need_pct / 100)


def combined_net_need(day_needs, start, end):
    """Sum a group's per-day net needs; None if any day in range is None."""
    total = 0.0
    for i in range(start, end + 1):
        if day_needs[i] is None:
            return None
        total += day_needs[i]
    return total


def seasonal_adjustment(combined, avg_eff_per_cycle):
    """One system adjustment for a group. Returns (shown, raw); (None, None) when
    it can't be computed. shown = clamp(round(raw*10)/10, 0, 1.5)."""
    if combined is None or not (avg_eff_per_cycle > 0):
        return None, None
    raw = combined / avg_eff_per_cycle
    return clamp(round(raw * 10) / 10, 0, 1.5), raw


def watering_day_groups(dates, is_system_day):
    """Group visible days by system watering day (decision a). Twin of
    forecast.js wateringDayGroups. Returns list of (start, end) index pairs."""
    groups = []
    gs = 0
    for i in range(1, len(dates)):
        if is_system_day(dates[i]):
            groups.append((gs, i - 1))
            gs = i
    groups.append((gs, len(dates) - 1))
    return groups


class TestHargreavesET0:
    @pytest.mark.parametrize("case", GOLDEN["hargreaves_et0_cases"], ids=lambda c: c["label"])
    def test_et0_matches_golden(self, case):
        et0_mm = hargreaves_et0_mm_day(
            case["latitudeDeg"], case["tmaxC"], case["tminC"], case["dayOfYear"]
        )
        assert et0_mm == pytest.approx(case["expectedEt0MmDay"], rel=1e-2)

        et0_in = et0_mm / 25.4
        assert et0_in == pytest.approx(case["expectedEt0InDay"], rel=1e-2)

    @pytest.mark.parametrize("case", GOLDEN["hargreaves_et0_cases"], ids=lambda c: c["label"])
    def test_et0_within_sanity_range(self, case):
        """
        Broad sanity check independent of the precise golden value: peak-season ET0
        for most of the continental US should land roughly in this band. Guards
        against a unit-conversion or sign error surviving a refactor.
        """
        et0_mm = hargreaves_et0_mm_day(
            case["latitudeDeg"], case["tmaxC"], case["tminC"], case["dayOfYear"]
        )
        et0_in = et0_mm / 25.4
        lo, hi = case["sanityRangeInDay"]
        assert lo <= et0_in <= hi


class TestBaselineDailyNeed:
    def test_every_day_schedule(self):
        assert baseline_daily_need_in(weekly_target_in=1.0, cycles_per_week=7.0) == pytest.approx(1 / 7)

    def test_odd_even_schedule(self):
        assert baseline_daily_need_in(weekly_target_in=1.0, cycles_per_week=3.5) == pytest.approx(1 / 3.5)

    def test_days_of_week_schedule(self):
        # Four-mode model: three chosen weekdays -> 3.0 cycles/week (PLAN.md 7.1).
        assert baseline_daily_need_in(weekly_target_in=1.5, cycles_per_week=3) == pytest.approx(0.5)

    def test_zero_cycles_does_not_divide_by_zero(self):
        assert baseline_daily_need_in(weekly_target_in=1.0, cycles_per_week=0) == 0


class TestNetNeed:
    def test_kc_scales_et0_into_etc(self):
        # ETc = ET0 x Kc; July Kc default 0.94.
        assert etc_in(0.30, 0.94) == pytest.approx(0.282)
        assert etc_in(None, 0.94) is None

    def test_rain_fully_covers_need_floors_at_zero(self):
        # Phase 11: heavy rain floors net need at exactly 0 (never negative, which
        # the old per-zone formula could reach).
        net = net_need_in(et0_in=0.2, rain_in=1.0, kc=1.0, eff_rain_pct=60, irr_need_pct=100)
        assert net == 0.0

    def test_floor_applies_before_scalar(self):
        # ETc - effective rain is negative here; must read as 0, not a negative
        # number scaled by the Irrigation Need %.
        net = net_need_in(et0_in=0.30, rain_in=0.50, kc=0.90, eff_rain_pct=60, irr_need_pct=100)
        assert net == 0.0

    def test_hot_dry_day_is_full_etc_scaled_by_irrigation_need(self):
        # No rain: net need = ETc x irrigationNeed%.
        assert net_need_in(0.30, 0.0, 1.0, 60, 100) == pytest.approx(0.30)
        assert net_need_in(0.30, 0.0, 1.0, 60, 50) == pytest.approx(0.15)

    def test_more_effective_rainfall_never_increases_need(self):
        low = net_need_in(0.30, 0.20, 1.0, 60, 100)
        high = net_need_in(0.30, 0.20, 1.0, 100, 100)
        assert high <= low

    def test_missing_data_returns_none(self):
        assert net_need_in(None, 0.2, 1.0, 60, 100) is None
        assert net_need_in(0.3, None, 1.0, 60, 100) is None


class TestSeasonalAdjustment:
    def test_rounded_to_nearest_ten_percent(self):
        # raw = 0.339 / 0.3 = 1.13 -> rounds to 1.1 (110%), not 113%.
        shown, raw = seasonal_adjustment(0.339, 0.3)
        assert raw == pytest.approx(1.13)
        assert shown == pytest.approx(1.1)

    def test_clamped_at_150_percent_and_flags_over_cap(self):
        shown, raw = seasonal_adjustment(1.0, 0.1)
        assert shown == pytest.approx(1.5)
        assert raw > 1.5  # over-cap: the UI marks the group with a ▲

    def test_none_when_no_denominator_or_no_combined(self):
        assert seasonal_adjustment(0.3, 0) == (None, None)
        assert seasonal_adjustment(None, 0.3) == (None, None)


class TestCombinedNetNeed:
    def test_sums_group_and_propagates_missing(self):
        needs = [0.1, 0.2, 0.3, None, 0.4]
        assert combined_net_need(needs, 0, 2) == pytest.approx(0.6)
        assert combined_net_need(needs, 2, 4) is None  # a None day poisons the group

    def test_grouping_is_union_of_schedules_not_either_alone(self):
        import datetime
        # A week starting Monday. Zone A waters Wednesdays, Zone B waters Fridays.
        monday = datetime.date(2026, 7, 20)  # a Monday
        dates = [monday + datetime.timedelta(days=i) for i in range(7)]
        zone_a = {"daysOfWeek": [2]}  # Wed (Mon=0)
        zone_b = {"daysOfWeek": [4]}  # Fri

        def sched(z):
            return lambda d: d.weekday() in z["daysOfWeek"]

        is_a, is_b = sched(zone_a), sched(zone_b)
        is_system = lambda d: is_a(d) or is_b(d)  # decision a: any zone

        union = watering_day_groups(dates, is_system)
        assert union == [(0, 1), (2, 3), (4, 6)]
        # The union grouping matches NEITHER zone's own schedule grouping.
        assert watering_day_groups(dates, is_a) == [(0, 1), (2, 6)]
        assert watering_day_groups(dates, is_b) == [(0, 3), (4, 6)]
        assert union != watering_day_groups(dates, is_a)
        assert union != watering_day_groups(dates, is_b)
