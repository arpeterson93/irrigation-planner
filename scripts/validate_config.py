#!/usr/bin/env python3
"""Validate a Sprinkler Simulator config file against schema/config.schema.json.

Usage:
    python scripts/validate_config.py path/to/config.json [more.json ...]

Exits non-zero if any file fails validation. Used by the migration scripts and
(optionally) CI to guarantee migrated output conforms to schema v2.
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft7Validator

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema" / "config.schema.json"


def load_schema():
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def validate_obj(obj, schema=None):
    """Return a list of human-readable error strings (empty == valid)."""
    schema = schema or load_schema()
    validator = Draft7Validator(schema)
    errors = sorted(validator.iter_errors(obj), key=lambda e: list(e.path))
    return [f"{'/'.join(str(p) for p in e.path) or '<root>'}: {e.message}" for e in errors]


def validate_file(path, schema=None):
    with open(path) as f:
        obj = json.load(f)
    return validate_obj(obj, schema)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    schema = load_schema()
    ok = True
    for path in argv[1:]:
        errors = validate_file(path, schema)
        if errors:
            ok = False
            print(f"INVALID: {path}")
            for e in errors:
                print(f"  - {e}")
        else:
            print(f"OK: {path}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
