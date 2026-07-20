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
    """One system Weather Adj. for a group. Returns (shown, raw); (None, None)
    when it can't be computed. shown = max(0, round(raw*10)/10) - rounded to the
    nearest 10%, floored at 0%, NO upper cap (11.8 fix 2)."""
    if combined is None or not (avg_eff_per_cycle > 0):
        return None, None
    raw = combined / avg_eff_per_cycle
    return max(0.0, round(raw * 10) / 10), raw


def watering_day_groups(dates, is_system_day):
    """Group visible days by system watering day (decision a; 11.8 lead-in fix).
    Twin of forecast.js wateringDayGroups. A group only STARTS at a system
    watering day; any non-watering day before the first one is its own solo
    lead-in entry. Returns list of (start, end, lead_in) tuples."""
    groups = []
    i = 0
    n = len(dates)
    while i < n:
        if is_system_day(dates[i]):
            j = i + 1
            while j < n and not is_system_day(dates[j]):
                j += 1
            groups.append((i, j - 1, False))
            i = j
        else:
            groups.append((i, i, True))
            i += 1
    return groups


SIGNIFICANT_CONTRIBUTION_SHARE = 0.25  # PLAN 12 decision (b)


def avg_effective_watering_per_cycle(zones, yard_zone_cells, zone_grids, grid, notdead_cells):
    """Python twin of forecast.js avgEffectiveWateringPerCycle (Phase 12 rule).
    Works on hand-built per-cell fixtures rather than real geometry.

      zones          : list of {id, effectiveWateringPct}
      yard_zone_cells: list of cell-lists [(r,c),...], one per yard zone (non-dead)
      zone_grids     : {zone_id: {(r,c): applied depth}}
      grid           : {(r,c): combined applied depth, all zones}
      notdead_cells  : iterable of (r,c) - the own-avg universe for the fallback

    Each sprinkler zone's per-cycle figure = mean of the Avg in/cycle of the yard
    zones it contributes >= 25% of the applied water to; else its own avg in/cycle
    over all non-dead cells (pre-Phase-12 fallback). Scaled by Effective Watering %,
    then averaged across zones.
    """
    if not zones:
        return 0
    yz_avg = []
    for cells in yard_zone_cells:
        yz_avg.append(sum(grid[c] for c in cells) / len(cells) if cells else 0)

    per_zone = []
    for z in zones:
        zg = zone_grids.get(z["id"])
        relevant = []
        for yi, cells in enumerate(yard_zone_cells):
            if zg is None or not cells:
                continue
            z_sum = sum(zg.get(c, 0) for c in cells)
            total_sum = sum(grid[c] for c in cells)
            if total_sum > 0 and z_sum / total_sum >= SIGNIFICANT_CONTRIBUTION_SHARE:
                relevant.append(yz_avg[yi])
        if relevant:
            avg_per_cycle = sum(relevant) / len(relevant)
        elif zg:
            own = [zg.get(c, 0) for c in notdead_cells]
            avg_per_cycle = sum(own) / len(own) if own else 0
        else:
            avg_per_cycle = 0
        eff = z.get("effectiveWateringPct", 80)
        per_zone.append(avg_per_cycle * (eff / 100))
    return sum(per_zone) / len(per_zone)


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

    def test_no_upper_cap_only_rounded_to_ten_percent(self):
        # 11.8 fix 2: a very high need passes through uncapped (300%), not 150%.
        shown, raw = seasonal_adjustment(3.0, 1.0)
        assert raw == pytest.approx(3.0)
        assert shown == pytest.approx(3.0)
        # Rounding to the nearest 10% still applies: 2.37 -> 2.4.
        shown2, _ = seasonal_adjustment(2.37, 1.0)
        assert shown2 == pytest.approx(2.4)

    def test_none_when_no_denominator_or_no_combined(self):
        assert seasonal_adjustment(0.3, 0) == (None, None)
        assert seasonal_adjustment(None, 0.3) == (None, None)


class TestCombinedNetNeed:
    def test_sums_group_and_propagates_missing(self):
        needs = [0.1, 0.2, 0.3, None, 0.4]
        assert combined_net_need(needs, 0, 2) == pytest.approx(0.6)
        assert combined_net_need(needs, 2, 4) is None  # a None day poisons the group


class TestWateringDayGroups:
    def test_grouping_is_union_of_schedules_not_either_alone(self):
        import datetime
        # A week starting Monday. Zone A waters Wednesdays, Zone B waters Fridays.
        monday = datetime.date(2026, 7, 20)  # a Monday
        dates = [monday + datetime.timedelta(days=i) for i in range(7)]

        def sched(days):
            return lambda d: d.weekday() in days

        is_a, is_b = sched([2]), sched([4])  # Wed, Fri (Mon=0)
        is_system = lambda d: is_a(d) or is_b(d)  # decision a: any zone

        union = watering_day_groups(dates, is_system)
        # Mon/Tue are lead-ins; groups start at Wed and Fri.
        assert union == [(0, 0, True), (1, 1, True), (2, 3, False), (4, 6, False)]
        # The union grouping matches NEITHER zone's own schedule grouping.
        assert watering_day_groups(dates, is_a) == [(0, 0, True), (1, 1, True), (2, 6, False)]
        assert watering_day_groups(dates, is_b) == [(0, 0, True), (1, 1, True), (2, 2, True), (3, 3, True), (4, 6, False)]
        assert union != watering_day_groups(dates, is_a)
        assert union != watering_day_groups(dates, is_b)

    def test_lead_in_day_is_solo_not_merged_forward(self):
        # 11.8 fix 3: today (index 0) is non-watering, tomorrow (1) waters. Today
        # must be its own solo lead-in entry, never merged into the next group.
        dates = list(range(5))
        is_system = lambda d: d == 1
        groups = watering_day_groups(dates, is_system)
        assert groups[0] == (0, 0, True)    # today: solo lead-in
        assert groups[1] == (1, 4, False)   # watering group starts AT tomorrow
        assert groups == [(0, 0, True), (1, 4, False)]

    def test_first_day_watering_has_no_lead_in(self):
        dates = list(range(4))
        is_system = lambda d: d in (0, 2)
        assert watering_day_groups(dates, is_system) == [(0, 1, False), (2, 3, False)]


class TestYardZoneContribution:
    def test_25_percent_share_is_inclusive_boundary(self):
        # One yard zone Y of 4 equal cells (combined depth 1.0 each -> Avg 1.0).
        cells = [(0, 0), (0, 1), (0, 2), (0, 3)]
        grid = {c: 1.0 for c in cells}
        zones = [{"id": "z1", "effectiveWateringPct": 80}]

        # Exactly 25% share: z1 supplies 1.0 of the 4.0 total over Y -> counts,
        # so its figure is Y's own Avg in/cycle (1.0), not z1's own diffuse avg.
        zg_at = {(0, 0): 1.0, (0, 1): 0.0, (0, 2): 0.0, (0, 3): 0.0}
        at = avg_effective_watering_per_cycle(zones, [cells], {"z1": zg_at}, grid, cells)
        assert at == pytest.approx(1.0 * 0.80)  # 0.8, from Y's Avg (not 0.25*0.8)

        # Just below 25% (0.9/4 = 0.225): does NOT count -> falls back to z1's own
        # avg over all non-dead cells (0.9/4 = 0.225).
        zg_below = {(0, 0): 0.9, (0, 1): 0.0, (0, 2): 0.0, (0, 3): 0.0}
        below = avg_effective_watering_per_cycle(zones, [cells], {"z1": zg_below}, grid, cells)
        assert below == pytest.approx(0.225 * 0.80)  # 0.18, fallback path

    def test_averages_only_the_yard_zones_it_significantly_touches(self):
        # Three disjoint single-cell yard zones with Avg in/cycle 2, 4, 10.
        y1, y2, y3 = [(0, 0)], [(0, 1)], [(0, 2)]
        grid = {(0, 0): 2.0, (0, 1): 4.0, (0, 2): 10.0}
        # z1 fully supplies Y1 and Y2 (share 1.0) but only 10% of Y3.
        zg = {(0, 0): 2.0, (0, 1): 4.0, (0, 2): 1.0}
        zones = [{"id": "z1", "effectiveWateringPct": 100}]
        result = avg_effective_watering_per_cycle(
            zones, [y1, y2, y3], {"z1": zg}, grid, [(0, 0), (0, 1), (0, 2)])
        # Mean of Y1 and Y2's Avg (2 and 4) = 3.0; Y3's 10 is excluded.
        assert result == pytest.approx(3.0)

    def test_no_yard_zones_falls_back_to_own_avg(self):
        # Phase 11 behavior: no yard zones -> zone's own avg in/cycle over non-dead.
        notdead = [(0, 0), (0, 1)]
        zg = {(0, 0): 3.0, (0, 1): 1.0}  # own avg = 2.0
        zones = [{"id": "z1", "effectiveWateringPct": 50}]
        result = avg_effective_watering_per_cycle(zones, [], {"z1": zg}, {}, notdead)
        assert result == pytest.approx(2.0 * 0.50)  # 1.0
