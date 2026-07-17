"""
Golden tests for the forecast/seasonal-adjustment math (Hargreaves-Samani ET0,
baseline daily need, adjustment percentage).

Re-implements the exact logic from legacy/sprinkler-simulator.html
(hargreavesET0, defaultBaselineDaily, renderForecastResult in the <script> block)
in Python, asserted against a hand-checked reference case.
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


def adjustment_pct(et0_in, rain_in, runoff_efficiency_pct, baseline_daily_need_in_):
    effective_rain_in = rain_in * (runoff_efficiency_pct / 100)
    net_need_in = (et0_in or 0) - effective_rain_in
    if baseline_daily_need_in_ <= 0:
        return 0, net_need_in
    return clamp(net_need_in / baseline_daily_need_in_, 0, 1.5), net_need_in


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

    def test_n_per_week_schedule(self):
        assert baseline_daily_need_in(weekly_target_in=1.5, cycles_per_week=3) == pytest.approx(0.5)

    def test_zero_cycles_does_not_divide_by_zero(self):
        assert baseline_daily_need_in(weekly_target_in=1.0, cycles_per_week=0) == 0


class TestAdjustmentPct:
    def test_rain_fully_covers_need_suggests_skip(self):
        pct, net = adjustment_pct(et0_in=0.2, rain_in=1.0, runoff_efficiency_pct=80, baseline_daily_need_in_=0.3)
        assert net <= 0
        assert pct == 0

    def test_hot_dry_day_suggests_full_or_over_watering(self):
        pct, net = adjustment_pct(et0_in=0.3, rain_in=0.0, runoff_efficiency_pct=80, baseline_daily_need_in_=0.3)
        assert net == pytest.approx(0.3)
        assert pct == pytest.approx(1.0)

    def test_adjustment_clamped_at_150_percent(self):
        pct, _ = adjustment_pct(et0_in=1.0, rain_in=0.0, runoff_efficiency_pct=80, baseline_daily_need_in_=0.1)
        assert pct == pytest.approx(1.5)

    def test_efficiency_expressed_as_percent_not_fraction(self):
        """Schema v2 stores efficiencyPct (e.g. 80), not a 0-1 fraction. Guard the conversion."""
        pct_at_80, _ = adjustment_pct(et0_in=0.3, rain_in=0.5, runoff_efficiency_pct=80, baseline_daily_need_in_=0.3)
        pct_at_100, _ = adjustment_pct(et0_in=0.3, rain_in=0.5, runoff_efficiency_pct=100, baseline_daily_need_in_=0.3)
        # More efficiency capture (100%) should never suggest *more* watering than 80%.
        assert pct_at_100 <= pct_at_80
