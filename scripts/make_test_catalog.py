#!/usr/bin/env python3
"""Build tests/fixtures/catalog.json: a small catalog in the form the integration stores it.

Takes the integration's own catalog from saved CelesTrak answers to its queries (no network), and
keeps the three satellites the code names, then every 20th of the others by catalog number and
every 30th of the low Starlinks, so that the tests see each kind of object:

  python scripts/make_test_catalog.py visual.csv rocket_bodies.csv active.csv
"""

from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Imported after the path is set: the integration is not an installed package.
from custom_components.satellite_spotter.celestrak import build_catalog  # noqa: E402
from custom_components.satellite_spotter.predict import write_catalog  # noqa: E402

OUT = ROOT / "tests/fixtures/catalog.json"
NAMED = {20580, 25544, 48274}
OTHERS_EVERY = 20
STARLINKS_EVERY = 30


def main() -> None:
    """Write the fixture from the files named on the command line."""
    catalog = build_catalog(Path(name).read_text(encoding="utf-8") for name in sys.argv[1:])
    catalog.sort(key=lambda sat: sat.norad_id)
    named = [sat for sat in catalog if sat.norad_id in NAMED]
    starlinks = [sat for sat in catalog if sat.curve is not None]
    others = [sat for sat in catalog if sat.norad_id not in NAMED and sat.curve is None]
    kept = named + others[::OTHERS_EVERY] + starlinks[::STARLINKS_EVERY]
    OUT.write_text(json.dumps(write_catalog(kept), indent=1) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(kept)} satellites")


if __name__ == "__main__":
    main()
