#!/usr/bin/env python3
"""Migrate an old v1 localStorage/JSON config to schema v2.

This is the Python twin of the v1->v2 migration in docs/js/state.js
(migrateV1toV2). The two intentionally duplicate the same rules; if you change
one, change the other and re-run the tests. See PLAN.md section 3.

Usage:
    python scripts/migrate_v1_config.py in_v1.json [out_v2.json]

If out path is omitted, writes <in>.v2.json next to the input. The output is
validated against schema/config.schema.json before it is written.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_config import validate_obj  # noqa: E402

SCHEMA_VERSION = 2


def clamp(v, a, b):
    return max(a, min(b, v))


def evenly_spaced_weekdays(n):
    """N weekdays evenly spaced starting Monday (Mon=0..Sun=6). N=3 -> [0,2,5]."""
    spacing = 7 / n
    return sorted({round(i * spacing) % 7 for i in range(int(n))})


def cycles_to_schedule(value):
    """v1 raw cycles-per-week number -> schema v2 schedule (four-mode model)."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = 3.0
    if v == 7:
        return {"mode": "every_day"}
    if v == 3.5:
        # No source for odd-vs-even in v1; default odd and flag for the UI.
        return {"mode": "odd_even", "oddEvenChoice": "odd", "_needsOddEvenChoice": True}
    n = int(clamp(round(v) or 3, 1, 7))
    return {"mode": "days_of_week", "daysOfWeek": evenly_spaced_weekdays(n)}


def infer_head_type(notes):
    """Only set a type when the note gives an explicit hint (PLAN.md 3, step 3)."""
    n = str(notes or "").lower()
    if any(k in n for k in ("rotor", "rotary", "mp rotator", "mprotator", "rotate")):
        return "rotary"
    if any(k in n for k in ("spray", "fixed", "pop-up", "popup", "mist")):
        return "fixed"
    return None


def migrate(v1):
    yard = v1.get("yard", {}) or {}
    height_ft = float(yard.get("height") or 60)
    width_ft = float(yard.get("width") or 80)
    cell = float(yard.get("cellSize") or 2)

    forecast_v1 = v1.get("forecast", {}) or {}
    schedule = cycles_to_schedule(forecast_v1.get("wateringDays", 3))

    id_map = {}
    sprinkler_zones = []
    for i, z in enumerate(v1.get("zones", []) or []):
        new_id = f"sz{i + 1}"
        id_map[z.get("id")] = new_id
        supply = z.get("gpmAvail")
        sprinkler_zones.append({
            "id": new_id,
            "name": str(z.get("name", f"Zone {i + 1}")),
            "supplyGpm": supply if (isinstance(supply, (int, float)) and supply > 0) else None,
            "runTimeMin": float(z.get("runMin") or 0),
            "weeklyTargetIn": float(z.get("targetIn") or 0),
            "schedule": json.loads(json.dumps(schedule)),
        })

    first_zone_id = sprinkler_zones[0]["id"] if sprinkler_zones else "sz1"

    heads = []
    for h in v1.get("heads", []) or []:
        head = {
            "id": str(h.get("id") or ""),
            "sprinklerZoneId": id_map.get(h.get("zone"), first_zone_id),
            "x": float(h.get("x") or 0),
            "y": height_ft - float(h.get("y") or 0),  # step 1: flip y to bottom-left origin
            "radiusFt": float(h.get("radius") or 0),
            "arcStartDeg": float(h.get("arcStart") or 0),
            "arcEndDeg": float(h.get("arcEnd") or 0),
            "ratedGpm": float(h.get("gpm") or 0),
            "nozzleFamily": "",
            "brand": "",
            "model": "",
            "nozzle": "",
            "riserHeightIn": None,
            "needsReplacement": False,
            "notes": str(h.get("notes") or ""),
        }
        t = infer_head_type(h.get("notes"))
        if t:
            head["type"] = t
        heads.append(head)

    def num_or_none(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    runoff = forecast_v1.get("runoffEff")
    forecast = {
        "latitude": num_or_none(forecast_v1.get("lat")),
        "longitude": num_or_none(forecast_v1.get("lon")),
        "windowDays": 7,
        "efficiencyPct": round(runoff * 100) if isinstance(runoff, (int, float)) else 80,
    }

    out = {
        "schemaVersion": SCHEMA_VERSION,
        "yard": {"widthFt": width_ft, "heightFt": height_ft, "cellSizeFt": cell},
        "sprinklerZones": sprinkler_zones or _default_zones(),
        "yardZones": [],
        "deadSpaces": [],
        "heads": heads,
        "background": {"imageDataUrl": None, "scaleFtPerPx": None,
                       "offsetXFt": 0, "offsetYFt": 0, "rotationDeg": 0, "opacity": 0.5},
        "forecast": forecast,
        "sync": {"enabled": False, "endpointUrl": None, "userKey": None, "lastSyncedAt": None},
        # Belt-and-suspenders backup, kept in the exported file (PLAN.md 3, step 6).
        "_v1Backup": v1,
    }
    return out


def _default_zones():
    return [{
        "id": f"sz{i + 1}", "name": f"Zone {i + 1}", "supplyGpm": 10,
        "runTimeMin": 20, "weeklyTargetIn": 1.0,
        "schedule": {"mode": "n_per_week", "nPerWeek": 3},
    } for i in range(6)]


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    in_path = Path(argv[1])
    out_path = Path(argv[2]) if len(argv) > 2 else in_path.with_suffix(".v2.json")

    with open(in_path) as f:
        v1 = json.load(f)

    v2 = migrate(v1)
    errors = validate_obj(v2)
    if errors:
        print("Migration produced an INVALID v2 config:")
        for e in errors:
            print(f"  - {e}")
        return 1

    with open(out_path, "w") as f:
        json.dump(v2, f, indent=2)
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
