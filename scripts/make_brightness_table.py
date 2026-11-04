#!/usr/bin/env python3
"""Build the table of how bright each satellite is, from public sources.

Writes custom_components/satellite_spotter/brightness.csv: one standard
magnitude (at 1000 km, on the scale the predictions use) for each object on
orbit that could reach naked-eye brightness, and which source it came from.
Starlinks are left out: their brightness comes from a published model instead
(celestrak.py). The first source below that has a value wins:

  override  scripts/brightness_overrides.csv: values added by hand, each with
            the citation it came from.
  mccants   Mike McCants's qs.mag file, plus 0.75, which is 2.5 log10(2): it gives
            magnitudes at 100% illumination, the predictions' scale is for 50%.
            https://www.prismnet.com/~mmccants/programs/qsmag.zip
  score     The IAU CPS SCORE repository of observations (CC BY 4.0): the median
            over each object's checked observations, turned into intrinsic
            magnitudes. Nothing of an observation but this median is kept.
            https://score.cps.iau.org
  stellarium  Stellarium's satellite list (GPL), where it does not just repeat
            McCants's value. Often out of date, so checked against the object's
            size. https://stellarium.org
  family    The median McCants value of the object's family ("CZ-2C R/B", say):
            the same hardware, so not for debris.

Physical sizes from Jonathan McDowell's GCAT (CC BY 4.0) check SCORE and Stellarium's
values, but become no values themselves: estimates from size added few of the passes
the website lists, and more passes that it does not.
https://planet4589.org/space/gcat

CelesTrak's SATCAT says what is on orbit, how low it comes, and each name.
https://celestrak.org/pub/satcat.csv

The script reads files you downloaded; it downloads nothing. Keep them out of
the repository: SCORE's raw file names observers and where they stood.

  python -I scripts/make_brightness_table.py --qsmag qs.mag --score observations.csv \
      --stellarium satellites.json --gcat satcat.tsv --gcat satcat100k.tsv \\
      --satcat satcat.csv
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from collections.abc import Iterable
import csv
from dataclasses import dataclass
from datetime import UTC, datetime
import json
import math
from pathlib import Path
import re
import statistics

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "custom_components" / "satellite_spotter" / "brightness.csv"
OVERRIDES = ROOT / "scripts" / "brightness_overrides.csv"

# From McCants's 100% illumination to the half illumination of the predictions.
# ResolveSky documents the same conversion, https://resolvesky.com.
MCCANTS_OFFSET = 0.75
# How bright an object must be able to get: the magnitude it would reach
# straight overhead at its perigee, before the air dims it. The website's
# default cutoff is 3, about the faintest you can find from a suburb.
BRIGHTEST_LIMIT = 3.0
MIN_PERIGEE_KM = 100.0

MIN_OBSERVATIONS = 5
MIN_FAMILY = 3
# Beyond this phase angle the diffuse sphere says little about the real object.
MAX_PHASE_DEG = 140.0
# Nothing in orbit beats this at 1000 km: the ISS is about -2. SCORE holds
# misidentified objects, whose values come out absurdly bright.
BRIGHTEST_PLAUSIBLE = -3.0
# A median this far from what the object's size suggests is more likely a
# misidentification than a discovery.
MAX_FROM_SIZE = 4.0

HEADER = """\
# How bright each satellite is: standard magnitude at 1000 km, on the predictions' scale.
# Built on {date} by scripts/make_brightness_table.py. Do not edit: add to
# scripts/brightness_overrides.csv and rebuild.
#
# Sources, in the "source" column:
#   mccants  qs.mag by Mike McCants, plus 0.75. https://www.prismnet.com/~mmccants/
#   score    Medians computed from SCORE, IAU CPS, CC BY 4.0, changed by being turned into
#            intrinsic magnitudes and reduced to one value. https://score.cps.iau.org
#   stellarium  The satellite list of Stellarium, GPL. https://stellarium.org
#   family   The median McCants value of objects of the same name, plus 0.75.
#   override Added by hand, with its citation in scripts/brightness_overrides.csv.
# score and stellarium were checked against physical sizes in GCAT by Jonathan C. McDowell,
# CC BY 4.0. https://planet4589.org/space/gcat
# Objects on orbit, perigees and names: SATCAT, CelesTrak, https://celestrak.org, from
# US Space Force data published on https://www.space-track.org.
"""


@dataclass(frozen=True)
class Row:
    """One line of the table."""

    norad_id: int
    magnitude: float
    source: str
    name: str


def number(text: object) -> float | None:
    """Read a number; GCAT marks uncertain ones with a question mark."""
    try:
        value = float(str(text).strip().rstrip("?"))
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def read_mccants(text: str) -> dict[int, float]:
    """Read qs.mag: the catalog number in columns 1-5 and the magnitude in 34-37."""
    values: dict[int, float] = {}
    for line in text.splitlines()[1:]:
        if line[:5].strip().isdigit() and (magnitude := number(line[33:37])) is not None:
            values[int(line[:5])] = magnitude
    return values


def intrinsic(apparent: float, range_km: float, phase_deg: float) -> float | None:
    """Turn an observed magnitude into a standard one: the predictions' formula run backwards.

    Removes the distance and the diffuse sphere's phase term, but not the air's
    dimming: magnitudes calibrated against nearby stars have that cancelled already.
    """
    if range_km <= 0 or not 0 < phase_deg <= MAX_PHASE_DEG:
        return None
    phase = math.radians(phase_deg)
    lit = (math.sin(phase) + (math.pi - phase) * math.cos(phase)) / math.pi
    if lit <= 0:
        return None
    return apparent - 5 * math.log10(range_km / 1000) + 2.5 * math.log10(lit)


def read_score(rows: Iterable[dict[str, str]]) -> dict[int, float]:
    """Reduce SCORE's observations to the median of each object with enough of them."""
    observed: dict[int, list[float]] = defaultdict(list)
    for row in rows:
        if row.get("potentially_discrepant") == "True" or row.get("illuminated") != "True":
            continue
        norad = row.get("norad_cat_id", "").strip()
        apparent = number(row.get("apparent_magnitude", ""))
        range_km = number(row.get("range_to_sat_km_satchecker", ""))
        phase = number(row.get("phase_angle_deg_satchecker", ""))
        if not norad.isdigit() or apparent is None or range_km is None or phase is None:
            continue
        if (value := intrinsic(apparent, range_km, phase)) is not None:
            observed[int(norad)].append(value)
    return {
        norad: statistics.median(values)
        for norad, values in observed.items()
        if len(values) >= MIN_OBSERVATIONS
    }


def read_stellarium(text: str, mccants: dict[int, float]) -> dict[int, float]:
    """Read Stellarium's magnitudes, without those that only repeat McCants's value."""
    values: dict[int, float] = {}
    for key, satellite in json.loads(text)["satellites"].items():
        magnitude = satellite.get("stdMag")
        if key.isdigit() and magnitude not in (None, 99):
            norad = int(key)
            if norad not in mccants or abs(mccants[norad] - magnitude) > 0.01:
                values[norad] = float(magnitude)
    return values


def read_gcat(text: str) -> dict[int, dict[str, str]]:
    """Read one of GCAT's catalogs, whose header is the line starting #JCAT."""
    records: dict[int, dict[str, str]] = {}
    header: list[str] | None = None
    for line in text.splitlines():
        if line.startswith("#JCAT"):
            header = line.lstrip("#").split("\t")
        elif header and not line.startswith("#"):
            record = dict(zip(header, line.split("\t"), strict=False))
            if record.get("Satcat", "").strip().isdigit():
                records[int(record["Satcat"])] = record
    return records


def area(record: dict[str, str] | None) -> float | None:
    """Estimate the area an object shows: its body and panels, or a plate or sail's square."""
    if record is None:
        return None
    length, diameter = number(record.get("Length", "")), number(record.get("Diameter", ""))
    if not length or not diameter:
        return None
    span = number(record.get("Span", "")) or length
    shape = record.get("Shape", "").lower()
    if "plate" in shape or "sail" in shape:
        return span * span
    return length * diameter + max(span - length, 0.0) * diameter


def kind(record: dict[str, str]) -> str:
    """Rocket bodies reflect differently from everything else."""
    return "rocket" if record.get("Type", " ")[:1] == "R" else "other"


def size_constants(
    mccants: dict[int, float],
    gcat: dict[int, dict[str, str]],
    satcat: dict[int, dict[str, str]],
) -> dict[str, float]:
    """Fit how bright a square metre looks, per kind, on the objects McCants measured.

    Reflected light goes with area, so the slope of -2.5 is physics, not fitted.
    """
    groups: dict[str, list[float]] = defaultdict(list)
    for norad, magnitude in mccants.items():
        shown = area(gcat.get(norad))
        record = satcat.get(norad)
        if shown and record is not None and not record.get("DECAY_DATE"):
            groups[kind(gcat[norad])].append(magnitude + 2.5 * math.log10(shown))
    return {name: statistics.median(values) for name, values in groups.items()}


def size_estimate(
    norad: int, gcat: dict[int, dict[str, str]], constants: dict[str, float]
) -> float | None:
    """Estimate an intrinsic magnitude from the object's size."""
    shown = area(gcat.get(norad))
    constant = constants.get(kind(gcat[norad])) if shown else None
    if not shown or constant is None:
        return None
    return constant - 2.5 * math.log10(shown) + MCCANTS_OFFSET


def plausible(magnitude: float, estimate: float | None) -> bool:
    """Whether an observed value could be right, given the object's size."""
    if magnitude < BRIGHTEST_PLAUSIBLE:
        return False
    return estimate is None or abs(magnitude - estimate) <= MAX_FROM_SIZE


def family_of(name: str) -> str:
    """Drop what tells an object from its siblings: "OBJECT-12B (X)" is "OBJECT"."""
    name = re.sub(r"\(.*?\)", "", name.upper()).strip()
    if "R/B" in name:
        return name
    return re.sub(r"[\s-]*[\dA-Z]*\d[\dA-Z]*$", "", name).strip() or name


def family_medians(
    mccants: dict[int, float], satcat: dict[int, dict[str, str]]
) -> dict[str, float]:
    """The median McCants value of each family big enough to have one."""
    families: dict[str, list[float]] = defaultdict(list)
    for norad, magnitude in mccants.items():
        name = satcat.get(norad, {}).get("OBJECT_NAME")
        if name:
            families[family_of(name)].append(magnitude)
    return {
        name: statistics.median(values)
        for name, values in families.items()
        if len(values) >= MIN_FAMILY
    }


def brightest_reachable(magnitude: float, perigee_km: float) -> float:
    """The magnitude an object would reach straight overhead at its perigee."""
    return magnitude + 5 * math.log10(max(perigee_km, MIN_PERIGEE_KM) / 1000)


def on_orbit(record: dict[str, str]) -> bool:
    """Whether an object is around the Earth with current orbital elements."""
    return (
        not record.get("DECAY_DATE")
        and not record.get("DATA_STATUS_CODE")
        and record.get("ORBIT_CENTER") == "EA"
    )


def build(
    mccants: dict[int, float],
    score: dict[int, float],
    stellarium: dict[int, float],
    gcat: dict[int, dict[str, str]],
    satcat: dict[int, dict[str, str]],
    overrides: dict[int, float],
) -> list[Row]:
    """Choose each object's magnitude, and keep those that could get bright enough."""
    constants = size_constants(mccants, gcat, satcat)
    families = family_medians(mccants, satcat)
    rows = []
    for norad, record in sorted(satcat.items()):
        name = record.get("OBJECT_NAME", "")
        perigee = number(record.get("PERIGEE", ""))
        if perigee is None or not on_orbit(record) or name.upper().startswith("STARLINK"):
            continue
        estimate = size_estimate(norad, gcat, constants)
        family = families.get(family_of(name))
        if norad in overrides:
            magnitude, source = overrides[norad], "override"
        elif norad in mccants:
            magnitude, source = mccants[norad] + MCCANTS_OFFSET, "mccants"
        elif norad in score and plausible(score[norad], estimate):
            magnitude, source = score[norad], "score"
        elif norad in stellarium and plausible(stellarium[norad], estimate):
            magnitude, source = stellarium[norad], "stellarium"
        elif family is not None and record.get("OBJECT_TYPE") != "DEB":
            magnitude, source = family + MCCANTS_OFFSET, "family"
        else:
            continue
        if brightest_reachable(magnitude, perigee) < BRIGHTEST_LIMIT:
            rows.append(Row(norad, round(magnitude, 2), source, name))
    return rows


def write_table(rows: Iterable[Row], path: Path, date: str) -> None:
    """Write the table, with the attribution its sources ask for at the top."""
    with path.open("w", encoding="utf-8", newline="") as out:
        out.write(HEADER.format(date=date))
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow(("norad_id", "magnitude", "source", "name"))
        for row in rows:
            writer.writerow((row.norad_id, f"{row.magnitude:.2f}", row.source, row.name))


def read_overrides(path: Path) -> dict[int, float]:
    """Read the values added by hand; every one has to say where it came from."""
    with path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        if not row["citation"].strip():
            raise ValueError(f"Override for {row['norad_id']} has no citation")
    return {int(row["norad_id"]): float(row["magnitude"]) for row in rows}


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--qsmag", type=Path, required=True, help="McCants's qs.mag")
    parser.add_argument("--score", type=Path, required=True, help="SCORE's observations as CSV")
    parser.add_argument(
        "--stellarium", type=Path, required=True, help="Stellarium's satellites.json"
    )
    parser.add_argument(
        "--gcat", type=Path, action="append", required=True, help="GCAT's satcat.tsv (repeatable)"
    )
    parser.add_argument("--satcat", type=Path, required=True, help="CelesTrak's satcat.csv")
    parser.add_argument("--overrides", type=Path, default=OVERRIDES)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    csv.field_size_limit(10**7)
    with args.score.open(encoding="utf-8", errors="replace", newline="") as handle:
        score = read_score(csv.DictReader(handle))
    with args.satcat.open(encoding="utf-8", newline="") as handle:
        satcat = {int(row["NORAD_CAT_ID"]): row for row in csv.DictReader(handle)}
    gcat: dict[int, dict[str, str]] = {}
    for path in args.gcat:
        gcat.update(read_gcat(read_text(path)))

    mccants = read_mccants(read_text(args.qsmag))
    stellarium = read_stellarium(read_text(args.stellarium), mccants)
    rows = build(mccants, score, stellarium, gcat, satcat, read_overrides(args.overrides))
    write_table(rows, args.out, datetime.now(UTC).date().isoformat())
    counts: dict[str, int] = defaultdict(int)
    for row in rows:
        counts[row.source] += 1
    print(f"{args.out}: {len(rows)} objects, {dict(sorted(counts.items()))}")


if __name__ == "__main__":
    main()
