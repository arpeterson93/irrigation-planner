"""
Golden tests for the coverage math (precipitation rate, sector area, arc handling).

These re-implement the exact formulas from legacy/sprinkler-simulator.html
(functions headArea, headPrecipRate, arcSpan, angleInArc in the <script> block)
in Python, and assert them against values that were cross-checked against the
original Google Sheet ("Sprinkler Simulator - Future").

If a refactor changes these formulas in docs/js/coverage.js, this file is the
guardrail: update the JS, then come back here and confirm the golden values
still hold (or deliberately update the golden file with a documented reason).
"""
import json
import math
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures" / "golden_spreadsheet_values.json"

with open(FIXTURES) as f:
    GOLDEN = json.load(f)


def norm360(a):
    return a % 360


def arc_span(start_deg, end_deg):
    """Degrees swept clockwise from start to end. start == end means a full circle."""
    start, end = norm360(start_deg), norm360(end_deg)
    if start == end:
        return 360
    return norm360(end - start)


def angle_in_arc(angle_deg, start_deg, end_deg):
    """Whether a bearing (0 = North, clockwise) falls within [start, end], with wraparound."""
    angle, start, end = norm360(angle_deg), norm360(start_deg), norm360(end_deg)
    if start == end:
        return True
    if start < end:
        return start - 1e-9 <= angle <= end + 1e-9
    return angle >= start - 1e-9 or angle <= end + 1e-9


def head_area_sqft(radius_ft, arc_start_deg, arc_end_deg):
    span = arc_span(arc_start_deg, arc_end_deg)
    return math.pi * radius_ft ** 2 * (span / 360)


def head_precip_rate_in_hr(gpm, radius_ft, arc_start_deg, arc_end_deg):
    """96.3 * GPM / coverage area (sq ft) -> inches/hour. Standard irrigation formula."""
    area = head_area_sqft(radius_ft, arc_start_deg, arc_end_deg)
    if area <= 0:
        return 0
    return 96.3 * gpm / area


class TestArcSpan:
    @pytest.mark.parametrize("case", GOLDEN["arc_span_cases"], ids=lambda c: c["label"])
    def test_arc_span(self, case):
        got = arc_span(case["arcStartDeg"], case["arcEndDeg"])
        assert got == pytest.approx(case["expectedSpanDeg"])


class TestAngleInArc:
    def test_wraparound_cases(self):
        for case in GOLDEN["angle_in_arc_cases"]:
            got = angle_in_arc(case["testAngleDeg"], case["arcStartDeg"], case["arcEndDeg"])
            assert got == case["expectedInArc"], (
                f"angle={case['testAngleDeg']} arc=[{case['arcStartDeg']},{case['arcEndDeg']}] "
                f"expected {case['expectedInArc']}, got {got}"
            )


class TestHeadPrecipRate:
    @pytest.mark.parametrize("case", GOLDEN["head_precip_cases"], ids=lambda c: c["label"])
    def test_area_matches_golden(self, case):
        area = head_area_sqft(case["radiusFt"], case["arcStartDeg"], case["arcEndDeg"])
        assert area == pytest.approx(case["expectedAreaSqFt"], rel=1e-3)

    @pytest.mark.parametrize("case", GOLDEN["head_precip_cases"], ids=lambda c: c["label"])
    def test_precip_rate_matches_golden(self, case):
        rate = head_precip_rate_in_hr(
            case["gpm"], case["radiusFt"], case["arcStartDeg"], case["arcEndDeg"]
        )
        assert rate == pytest.approx(case["expectedPrecipRateInHr"], rel=1e-3)

    @pytest.mark.parametrize("case", GOLDEN["head_precip_cases"], ids=lambda c: c["label"])
    def test_session_water_matches_sheet(self, case):
        """This is the number that must match what the original spreadsheet reported."""
        rate = head_precip_rate_in_hr(
            case["gpm"], case["radiusFt"], case["arcStartDeg"], case["arcEndDeg"]
        )
        session_in = rate * (case["runTimeMin"] / 60)
        assert session_in == pytest.approx(case["expectedSessionWaterIn"], rel=1e-2)
        # Loose check against the sheet's own rounded display value (2 decimal places).
        assert round(session_in, 2) == pytest.approx(case["sheetReportedSessionWaterIn"], abs=0.005)


def effective_gpm(rated, supply, zone_total):
    """Phase 3 supply-limited scaling. Twin of coverage.js zoneScaleFactor/effectiveGpm."""
    if supply is not None and supply > 0 and zone_total > 0 and supply < zone_total:
        return rated * (supply / zone_total)
    return rated


class TestEffectiveGpm:
    @pytest.mark.parametrize("case", GOLDEN["effective_gpm_cases"], ids=lambda c: c["label"])
    def test_factor_and_effective_gpm(self, case):
        eff = effective_gpm(case["ratedGpm"], case["supplyGpm"], case["zoneRatedTotalGpm"])
        assert eff == pytest.approx(case["expectedEffectiveGpm"])
        factor = eff / case["ratedGpm"]
        assert factor == pytest.approx(case["expectedFactor"])

    @pytest.mark.parametrize(
        "case",
        [c for c in GOLDEN["effective_gpm_cases"] if "expectedPrecipRateInHr" in c],
        ids=lambda c: c["label"],
    )
    def test_precip_rate_uses_effective_gpm(self, case):
        eff = effective_gpm(case["ratedGpm"], case["supplyGpm"], case["zoneRatedTotalGpm"])
        rate = head_precip_rate_in_hr(eff, case["radiusFt"], case["arcStartDeg"], case["arcEndDeg"])
        assert rate == pytest.approx(case["expectedPrecipRateInHr"], rel=1e-3)

    def test_supply_limited_is_strictly_less_than_rated(self):
        eff = effective_gpm(3.0, 4.5, 6.0)
        assert eff < 3.0
