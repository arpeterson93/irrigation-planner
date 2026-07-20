"""Tests for the v1->v2 migration (PLAN.md task 8).

Exercises scripts/migrate_v1_config.py against tests/fixtures/sample_config_v1.json
and asserts the output both conforms to schema/config.schema.json and reproduces
the specific rules in PLAN.md section 3 (y-flip, field renames, schedule
derivation, efficiency-as-percent, head-type inference from notes).
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from migrate_v1_config import migrate, cycles_to_schedule, infer_head_type  # noqa: E402
from validate_config import validate_obj  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "sample_config_v1.json"

with open(FIXTURE) as f:
    V1 = json.load(f)


@pytest.fixture(scope="module")
def v2():
    return migrate(V1)


class TestSchemaConformance:
    def test_migrated_output_is_schema_valid(self, v2):
        errors = validate_obj(v2)
        assert errors == [], "schema errors:\n" + "\n".join(errors)

    def test_schema_version_stamped(self, v2):
        assert v2["schemaVersion"] == 2


class TestCoordinateFlip:
    def test_y_is_flipped_to_bottom_left_origin(self, v2):
        # H1 was y=5 from the top in an 60ft-tall yard -> 55 from the bottom.
        h1 = next(h for h in v2["heads"] if h["id"] == "H1")
        assert h1["y"] == pytest.approx(60 - 5)

    def test_x_is_unchanged(self, v2):
        h1 = next(h for h in v2["heads"] if h["id"] == "H1")
        assert h1["x"] == pytest.approx(5)


class TestFieldRenames:
    def test_head_fields_renamed(self, v2):
        h1 = next(h for h in v2["heads"] if h["id"] == "H1")
        assert h1["radiusFt"] == pytest.approx(39)
        assert h1["arcStartDeg"] == pytest.approx(0)
        assert h1["arcEndDeg"] == pytest.approx(90)
        assert h1["ratedGpm"] == pytest.approx(2.91)
        assert h1["sprinklerZoneId"] == "sz1"

    def test_zone_fields_renamed(self, v2):
        z1 = v2["sprinklerZones"][0]
        assert z1["runTimeMin"] == pytest.approx(20)
        assert z1["weeklyTargetIn"] == pytest.approx(1.0)
        assert z1["supplyGpm"] == pytest.approx(9.5)

    def test_zero_supply_becomes_null(self, v2):
        # Zone 3 had gpmAvail 0 (v1 "unknown") -> null in v2.
        z3 = v2["sprinklerZones"][2]
        assert z3["supplyGpm"] is None


class TestScheduleDerivation:
    def test_watering_days_3_becomes_days_of_week(self, v2):
        # wateringDays=3 -> 3 evenly-spaced weekdays from Monday ([0,2,5]).
        for z in v2["sprinklerZones"]:
            assert z["schedule"]["mode"] == "days_of_week"
            assert z["schedule"]["daysOfWeek"] == [0, 2, 5]

    def test_seven_maps_to_every_day(self):
        assert cycles_to_schedule(7) == {"mode": "every_day"}

    def test_three_point_five_maps_to_odd_even(self):
        s = cycles_to_schedule(3.5)
        assert s["mode"] == "odd_even"
        assert s["oddEvenChoice"] == "odd"


class TestForecastMigration:
    def test_effective_rainfall_stored_as_percent(self, v2):
        # Phase 11: the old runoffEff (0.8) carries forward as Effective Rainfall %.
        assert v2["forecast"]["effectiveRainfallPct"] == 80
        assert "efficiencyPct" not in v2["forecast"]

    def test_lat_lon_parsed_to_numbers(self, v2):
        assert v2["forecast"]["latitude"] == pytest.approx(39.7456)
        assert v2["forecast"]["longitude"] == pytest.approx(-97.0892)


class TestHeadTypeInference:
    def test_rotor_note_infers_rotary(self, v2):
        h1 = next(h for h in v2["heads"] if h["id"] == "H1")
        assert h1.get("type") == "rotary"

    def test_spray_note_infers_fixed(self, v2):
        h3 = next(h for h in v2["heads"] if h["id"] == "H3")
        assert h3.get("type") == "fixed"

    def test_no_hint_leaves_type_unset(self, v2):
        # H2 and H4 have no type hint in notes; must NOT silently guess.
        h2 = next(h for h in v2["heads"] if h["id"] == "H2")
        assert "type" not in h2

    def test_infer_head_type_unit(self):
        assert infer_head_type("MP Rotator nozzle") == "rotary"
        assert infer_head_type("pop-up spray") == "fixed"
        assert infer_head_type("") is None


class TestBackup:
    def test_v1_backup_preserved(self, v2):
        assert v2["_v1Backup"]["yard"]["width"] == 80
