#!/usr/bin/env python3
"""Migrate the original Google Sheet export (CSV) into a schema v2 config.

  ⚠ COLUMN NAMES ARE ASSUMED. The real "Sprinkler Simulator - Future" sheet was
  not available as a machine-readable export at build time, so the COLUMN_MAP
  below is a best-effort guess based on the v1 field set. Reconcile it against an
  actual CSV export before trusting a bulk run: open the CSV, confirm the header
  names, and adjust COLUMN_MAP. Everything downstream (v2 shape, y-flip, schedule
  derivation) is solid; only the header->field mapping is provisional.

Usage:
    python scripts/migrate_sheet_export.py heads.csv [out_v2.json] \
        [--yard-width 80] [--yard-height 60] [--origin top-left|bottom-left]

One CSV row per head. Zones are inferred from the zone column; per-zone run time /
target / supply are taken from the first row seen for each zone. Output is
validated against schema/config.schema.json before writing.
"""
import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_config import validate_obj  # noqa: E402
from migrate_v1_config import infer_head_type, evenly_spaced_weekdays  # noqa: E402

SCHEMA_VERSION = 2

# Assumed header name -> internal field. Edit the LEFT side to match a real export.
COLUMN_MAP = {
    "zone": "zone",
    "zone name": "zone_name",
    "x": "x",
    "y": "y",
    "radius": "radius",
    "arc start": "arc_start",
    "arc end": "arc_end",
    "gpm": "gpm",
    "run time": "run_min",
    "target": "target_in",
    "available gpm": "gpm_avail",
    "notes": "notes",
}


def _get(row_norm, field, default=None):
    return row_norm.get(field, default)


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def load_rows(csv_path):
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        rows = []
        for raw in reader:
            norm = {}
            for header, value in raw.items():
                key = COLUMN_MAP.get((header or "").strip().lower())
                if key:
                    norm[key] = value
            rows.append(norm)
        return rows


def build_v2(rows, yard_width, yard_height, origin):
    zones = {}          # zone label -> zone dict
    zone_order = []
    heads = []

    for r in rows:
        zlabel = str(_get(r, "zone", "1")).strip() or "1"
        if zlabel not in zones:
            new_id = f"sz{len(zone_order) + 1}"
            zone_order.append(zlabel)
            zones[zlabel] = {
                "id": new_id,
                "name": str(_get(r, "zone_name") or f"Zone {len(zone_order)}"),
                "supplyGpm": (_num(_get(r, "gpm_avail"), None)
                              if _get(r, "gpm_avail") not in (None, "") else None),
                "runTimeMin": _num(_get(r, "run_min"), 20),
                "weeklyTargetIn": _num(_get(r, "target_in"), 1.0),
                "effectiveWateringPct": 80,  # Phase 11 decision b
                "schedule": {"mode": "days_of_week", "daysOfWeek": evenly_spaced_weekdays(3)},
            }

        y_raw = _num(_get(r, "y"))
        # Store y-up (bottom-left origin). If the sheet used a top-left origin, flip.
        y = (yard_height - y_raw) if origin == "top-left" else y_raw

        head = {
            "id": f"H{len(heads) + 1}",
            "sprinklerZoneId": zones[zlabel]["id"],
            "x": _num(_get(r, "x")),
            "y": y,
            "radiusFt": _num(_get(r, "radius")),
            "arcStartDeg": _num(_get(r, "arc_start")),
            "arcEndDeg": _num(_get(r, "arc_end"), 360),
            "ratedGpm": _num(_get(r, "gpm")),
            "brand": "", "model": "", "nozzle": "",
            "riserHeightIn": None, "needsReplacement": False,
            "notes": str(_get(r, "notes") or ""),
        }
        t = infer_head_type(head["notes"])
        if t:
            head["type"] = t
        heads.append(head)

    sprinkler_zones = [zones[z] for z in zone_order] or [{
        "id": "sz1", "name": "Zone 1", "supplyGpm": 10, "runTimeMin": 20,
        "weeklyTargetIn": 1.0, "effectiveWateringPct": 80,
        "schedule": {"mode": "days_of_week", "daysOfWeek": evenly_spaced_weekdays(3)},
    }]

    return {
        "schemaVersion": SCHEMA_VERSION,
        "yard": {"widthFt": float(yard_width), "heightFt": float(yard_height), "cellSizeFt": 2},
        "sprinklerZones": sprinkler_zones,
        "yardZones": [],
        "deadSpaces": [],
        "heads": heads,
        "background": {"imageDataUrl": None, "scaleFtPerPx": None,
                       "offsetXFt": 0, "offsetYFt": 0, "rotationDeg": 0, "opacity": 0.5},
        "forecast": {"latitude": None, "longitude": None, "windowDays": 7,
                     "effectiveRainfallPct": 60, "irrigationNeedPct": 100,
                     "kc": {"1": 1.0, "2": 1.0, "3": 1.0, "4": 1.04, "5": 0.95, "6": 0.88,
                            "7": 0.94, "8": 0.86, "9": 0.74, "10": 0.75, "11": 1.0, "12": 1.0}},
        "sync": {"enabled": False, "endpointUrl": None, "userKey": None, "lastSyncedAt": None},
    }


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv_path")
    parser.add_argument("out_path", nargs="?")
    parser.add_argument("--yard-width", type=float, default=80)
    parser.add_argument("--yard-height", type=float, default=60)
    parser.add_argument("--origin", choices=["top-left", "bottom-left"], default="top-left",
                        help="Origin the sheet used for Y. v1 used top-left; v2 stores bottom-left.")
    args = parser.parse_args(argv[1:])

    rows = load_rows(args.csv_path)
    v2 = build_v2(rows, args.yard_width, args.yard_height, args.origin)

    errors = validate_obj(v2)
    if errors:
        print("Sheet migration produced an INVALID v2 config:")
        for e in errors:
            print(f"  - {e}")
        return 1

    out_path = Path(args.out_path) if args.out_path else Path(args.csv_path).with_suffix(".v2.json")
    with open(out_path, "w") as f:
        json.dump(v2, f, indent=2)
    print(f"Wrote {out_path} ({len(v2['heads'])} heads, {len(v2['sprinklerZones'])} zones)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
