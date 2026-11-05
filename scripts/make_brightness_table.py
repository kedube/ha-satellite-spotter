#!/usr/bin/env python3
"""Build the table of how bright each satellite is.

Writes custom_components/satellite_spotter/brightness.csv: one standard magnitude
for each object on orbit that could reach naked-eye brightness, and which source
it came from. A standard magnitude is for 1000 km and half lit by the Sun, as
Mini-MegaTORTORA defines it, which is what the predictions' formula takes.
Starlinks are left out: their brightness comes from a published model instead
(celestrak.py). The first source below that has a value wins:

  override  scripts/brightness_overrides.csv: values added by hand, each with
            the citation it came from.
  score     For BlueWalker and SpaceMobile only, at this point: MMT has seen them
            too little since they unfolded. See below.
  mmt       Mini-MegaTORTORA's satellite list: each object's median standard magnitude,
            used with its team's permission. HEADER below has the citations.
            http://mmt.favor2.info/satellites/download
  mccants  Mike McCants's qs.mag file, plus 0.75, which is 2.5 log10(2): it gives
            magnitudes at 100% illumination. Then a small offset by kind of object
            (see MCCANTS_TO_MMT). https://www.mmccants.org/programs/qsmag.zip
  score     The IAU CPS SCORE repository of observations (CC BY 4.0): the median
            over each object's checked observations, turned into standard
            magnitudes. Nothing of an observation but this median is kept.
            https://score.cps.iau.org
  stellarium  Stellarium's satellite list (GPL), where it does not just repeat
            McCants's value. Often out of date, so checked against the object's
            size. https://stellarium.org
  family    The median of the object's family ("CZ-2C R/B", say) in MMT's list, or
            else in McCants's: the same hardware, so not for debris.

Physical sizes from Jonathan McDowell's GCAT (CC BY 4.0) check SCORE and Stellarium's
values, but become no values themselves: estimates from size were too rough to list
passes by.
https://planet4589.org/space/gcat

A published mean for a whole constellation checks them too, where there is one.

CelesTrak's SATCAT says what is on orbit, how low it comes, and each name.
https://celestrak.org/pub/satcat.csv

Only objects in CelesTrak's answers to the integration's queries (QUERIES in
celestrak.py, FORMAT=csv) are kept: the integration has no orbit for the others,
so their values would be published for nothing.

docs/updating-brightness.md has the steps for both of the commands below.

To bring the table up to date with MMT's list, as the Brightness workflow does each week:

  python -I scripts/make_brightness_table.py --update --download-mmt

That needs no other source. It downloads the list, SATCAT and CelesTrak's answers (once, so
not twice in two hours, as CelesTrak refuses that), takes every value it can from the list,
and keeps the table's other values as they are. --mmt reads a list saved earlier instead.

To build the table from all its sources, from files you downloaded (keep them out of the
repository: SCORE's raw file names observers and where they stood):

  python -I scripts/make_brightness_table.py --mmt satellites_list.txt --qsmag qs.mag \\
      --score observations.csv --stellarium satellites.json --gcat satcat.tsv \\
      --gcat satcat100k.tsv --satcat satcat.csv --elements visual.csv \\
      --elements rocket_bodies.csv --elements active.csv
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from collections.abc import Iterable
import csv
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import io
import json
import math
from pathlib import Path
import re
import statistics
import subprocess
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "custom_components" / "satellite_spotter" / "brightness.csv"
OVERRIDES = ROOT / "scripts" / "brightness_overrides.csv"

SATCAT_URL = "https://celestrak.org/pub/satcat.csv"
GP_URL = "https://celestrak.org/NORAD/elements/gp.php"
# The queries the integration makes (QUERIES in celestrak.py).
ELEMENT_QUERIES = ({"GROUP": "visual"}, {"NAME": "R/B"}, {"GROUP": "active"})
USER_AGENT = "SatelliteSpotter-table-builder (+https://github.com/kedube/ha-satellite-spotter)"
MMT_URL = "http://mmt.favor2.info/satellites/download"
# Its server only answers requests with a referer, to keep scrapers out. MMT's team gave us
# this one, and agreed to a script fetching the list about once a week.
MMT_REFERER = "http://mmt.favor2.info"
# A list that moves this share of the table's values by this many magnitudes is more likely
# wrong than new.
LARGE_CHANGE = 1.0
MOST_LARGE_CHANGES = 0.25
# An object can reach the catalogue days after its launch, with the table updated in between.
CATALOGUING_DAYS = 30

# From McCants's 100% illumination to the half illumination of a standard magnitude.
# ResolveSky documents the same conversion, https://resolvesky.com.
MCCANTS_OFFSET = 0.75
# What McCants's values need besides, by kind of object: the median of MMT's value minus
# McCants's plus 0.75, where both have one. SATCAT's OBJECT_TYPE; anything else counts as "PAY".
MCCANTS_TO_MMT = {"R/B": 0.55, "PAY": 0.04, "DEB": 0.15}
# What MMT has seen too little of since they unfolded, so that observers' values come first.
NOT_FROM_MMT = ("BLUEBIRD", "BLUEWALKER", "SPACEMOBILE")
# How much brighter than half lit an object is fully lit, by the predictions' formula.
FULLY_LIT_GAIN = 2.5 * math.log10(2)
# How bright an object must be able to get: the magnitude it would reach straight
# overhead at its perigee, fully lit, before the air dims it. It leaves room above the
# default cutoff of 2.25, for those who choose to look for fainter ones.
BRIGHTEST_LIMIT = 3.0
MIN_PERIGEE_KM = 100.0

MIN_OBSERVATIONS = 5
MIN_FAMILY = 3
# Beyond this phase angle the formula says little about the real object.
MAX_PHASE_DEG = 140.0
# Nothing in orbit beats this at 1000 km: the ISS is about -2. SCORE holds
# misidentified objects, whose values come out absurdly bright.
BRIGHTEST_PLAUSIBLE = -3.0
# A median this far from what the object's size suggests is more likely a
# misidentification than a discovery.
MAX_FROM_SIZE = 4.0
# The same goes for a satellite's median against the published mean of its constellation,
# all built alike: the mean and standard deviation by family, and how many of those to allow.
# Qianfan: 5.24 at 1000 km and 0.72 (Mallama & Cole 2025, arXiv:2507.00107, table 1). That
# still has the phase in it; as a standard magnitude it is 0.15 fainter, the difference
# between the medians of SCORE's Qianfan observations with and without it.
PUBLISHED_MEANS = {"QIANFAN": (5.24 + 0.15, 0.72)}
MAX_FROM_PUBLISHED = 2.0

HEADER = """\
# How bright each satellite is: standard magnitude, at 1000 km and half lit by the Sun.
# Built on {date} by scripts/make_brightness_table.py. Do not edit: add to
# scripts/brightness_overrides.csv and rebuild.
#
# Sources, in the "source" column:
#   mmt      The median standard magnitude in the satellite list of Mini-MegaTORTORA (MMT-9),
#            http://mmt.favor2.info/satellites, used with its team's permission.
#            Karpov et al. 2016, "Massive photometry of low-altitude artificial satellites on
#            Mini-Mega-TORTORA", Revista Mexicana de Astronomía y Astrofísica (Serie de
#            Conferencias) Vol. 48, pp. 112-113.
#            The telescope: Beskin et al. 2017, "Wide-field optical monitoring with
#            Mini-MegaTORTORA (MMT-9) multichannel high temporal resolution telescope",
#            Astrophysical Bulletin, Volume 72, Issue 1, pp. 81-92.
#   mccants  qs.mag by Mike McCants, plus 0.75 and an offset by kind of object.
#            https://www.mmccants.org/
#   score    Medians computed from SCORE, IAU CPS, CC BY 4.0, changed by being turned into
#            standard magnitudes and reduced to one value. https://score.cps.iau.org
#   stellarium  The satellite list of Stellarium, GPL. https://stellarium.org
#   family   The median of objects of the same name, in MMT's list or else in McCants's.
#   override Added by hand, with its citation in scripts/brightness_overrides.csv.
# score and stellarium were checked against physical sizes in GCAT by Jonathan C. McDowell,
# CC BY 4.0, https://planet4589.org/space/gcat, and Qianfan's against Mallama & Cole 2025,
# https://arxiv.org/abs/2507.00107.
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


def read_mmt(text: str) -> dict[int, float]:
    """Read MMT's satellite list: the median standard magnitude by NORAD number."""
    lines = text.splitlines()
    median = "StdMag_Clear_Median"
    header = next((ln.lstrip("# ").split() for ln in lines if ln[:1] == "#" and median in ln), [])
    if not {"Catalogue", "Id", median} <= set(header):
        raise ValueError("This is not MMT's satellite list: it has no column of medians")
    values: dict[int, float] = {}
    rows = csv.reader(
        (line for line in lines if line.strip() and line[0] != "#"),
        delimiter=" ",
        skipinitialspace=True,
    )
    for fields in rows:
        # Objects without a NORAD number have numbers of their own, which mean nothing here.
        if len(fields) != len(header) or fields[header.index("Catalogue")] != "NORAD":
            continue
        magnitude = number(fields[header.index(median)])
        if magnitude is not None and fields[header.index("Id")].isdigit():
            values[int(fields[header.index("Id")])] = magnitude
    return values


def read_mccants(text: str) -> dict[int, float]:
    """Read qs.mag: the catalog number in columns 1-5 and the magnitude in 34-37."""
    values: dict[int, float] = {}
    for line in text.splitlines()[1:]:
        if line[:5].strip().isdigit() and (magnitude := number(line[33:37])) is not None:
            values[int(line[:5])] = magnitude
    return values


def intrinsic(apparent: float, range_km: float, phase_deg: float) -> float | None:
    """Turn an observed magnitude into a standard one: the predictions' formula run backwards.

    Removes the distance and the phase, but not the air's dimming: magnitudes
    calibrated against nearby stars have that cancelled already.
    """
    if range_km <= 0 or not 0 < phase_deg <= MAX_PHASE_DEG:
        return None
    lit = 1 + math.cos(math.radians(phase_deg))
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


def plausible(magnitude: float, estimate: float | None, family: str = "") -> bool:
    """Whether an observed value could be right, given the object's size and constellation."""
    if magnitude < BRIGHTEST_PLAUSIBLE:
        return False
    if family in PUBLISHED_MEANS:
        mean, deviation = PUBLISHED_MEANS[family]
        if abs(magnitude - mean) > MAX_FROM_PUBLISHED * deviation:
            return False
    return estimate is None or abs(magnitude - estimate) <= MAX_FROM_SIZE


def family_of(name: str) -> str:
    """Drop what tells an object from its siblings: "OBJECT-12B (X)" is "OBJECT"."""
    name = re.sub(r"\(.*?\)", "", name.upper()).strip()
    if "R/B" in name:
        return name
    return re.sub(r"[\s-]*[\dA-Z]*\d[\dA-Z]*$", "", name).strip() or name


def family_medians(values: dict[int, float], satcat: dict[int, dict[str, str]]) -> dict[str, float]:
    """The median value of each family big enough to have one, without debris."""
    families: dict[str, list[float]] = defaultdict(list)
    for norad, magnitude in values.items():
        record = satcat.get(norad, {})
        name = record.get("OBJECT_NAME")
        if name and record.get("OBJECT_TYPE") != "DEB" and not name.startswith(NOT_FROM_MMT):
            families[family_of(name)].append(magnitude)
    return {
        name: statistics.median(found)
        for name, found in families.items()
        if len(found) >= MIN_FAMILY
    }


def brightest_reachable(magnitude: float, perigee_km: float) -> float:
    """The magnitude an object would reach straight overhead at its perigee, fully lit."""
    return magnitude + 5 * math.log10(max(perigee_km, MIN_PERIGEE_KM) / 1000) - FULLY_LIT_GAIN


def from_mccants(magnitude: float, record: dict[str, str]) -> float:
    """Turn a value from McCants's list into a standard magnitude."""
    offset = MCCANTS_TO_MMT.get(record.get("OBJECT_TYPE", ""), MCCANTS_TO_MMT["PAY"])
    return magnitude + MCCANTS_OFFSET + offset


def on_orbit(record: dict[str, str]) -> bool:
    """Whether an object is around the Earth with current orbital elements."""
    return (
        not record.get("DECAY_DATE")
        and not record.get("DATA_STATUS_CODE")
        and record.get("ORBIT_CENTER") == "EA"
    )


def build(
    mmt: dict[int, float],
    mccants: dict[int, float],
    score: dict[int, float],
    stellarium: dict[int, float],
    gcat: dict[int, dict[str, str]],
    satcat: dict[int, dict[str, str]],
    overrides: dict[int, float],
    elements: set[int] | None = None,
) -> list[Row]:
    """Choose each object's magnitude, and keep those that could get bright enough.

    With ``elements``, only those objects: the ones the integration has an orbit for.
    """
    constants = size_constants(mccants, gcat, satcat)
    mmt_families = family_medians(mmt, satcat)
    mccants_families = family_medians(mccants, satcat)
    rows = []
    for norad, record in sorted(satcat.items()):
        name = record.get("OBJECT_NAME", "")
        perigee = number(record.get("PERIGEE", ""))
        if perigee is None or not on_orbit(record) or name.upper().startswith("STARLINK"):
            continue
        if elements is not None and norad not in elements:
            continue
        estimate = size_estimate(norad, gcat, constants)
        family_name = family_of(name)
        observed = norad in score and plausible(score[norad], estimate, family_name)
        if norad in overrides:
            magnitude, source = overrides[norad], "override"
        elif observed and name.startswith(NOT_FROM_MMT):
            magnitude, source = score[norad], "score"
        elif norad in mmt:
            magnitude, source = mmt[norad], "mmt"
        elif norad in mccants:
            magnitude, source = from_mccants(mccants[norad], record), "mccants"
        elif observed:
            magnitude, source = score[norad], "score"
        elif norad in stellarium and plausible(stellarium[norad], estimate, family_name):
            magnitude, source = stellarium[norad], "stellarium"
        elif record.get("OBJECT_TYPE") == "DEB":
            continue
        elif family_name in mmt_families:
            magnitude, source = mmt_families[family_name], "family"
        elif family_name in mccants_families:
            magnitude, source = from_mccants(mccants_families[family_name], record), "family"
        else:
            continue
        if brightest_reachable(magnitude, perigee) < BRIGHTEST_LIMIT:
            rows.append(Row(norad, round(magnitude, 2), source, name))
    return rows


def update(
    mmt: dict[int, float],
    table: dict[int, tuple[float, str]],
    satcat: dict[int, dict[str, str]],
    elements: set[int],
    built: str,
) -> list[Row]:
    """Bring a table up to date with a newer list from MMT, in the same order as build().

    The other sources' values stay as they are, and an object MMT has dropped keeps
    its last value. An object new to orbit needs a value in the list, or a family there.
    An older object without a row was left out for being faint, so only one launched
    since the table was built (``built``, a date), or just before, can take its family's value.
    """
    families = family_medians(mmt, satcat)
    since = (datetime.fromisoformat(built) - timedelta(days=CATALOGUING_DAYS)).date().isoformat()
    rows = []
    for norad, record in sorted(satcat.items()):
        name = record.get("OBJECT_NAME", "")
        perigee = number(record.get("PERIGEE", ""))
        if perigee is None or not on_orbit(record) or name.upper().startswith("STARLINK"):
            continue
        if norad not in elements:
            continue
        known = table.get(norad)
        new = record.get("LAUNCH_DATE", "") >= since
        family = None
        if (new or known) and record.get("OBJECT_TYPE") != "DEB":
            family = families.get(family_of(name))
        if known and (
            known[1] == "override" or (known[1] == "score" and name.startswith(NOT_FROM_MMT))
        ):
            magnitude, source = known
        elif norad in mmt:
            magnitude, source = mmt[norad], "mmt"
        elif known and known[1] != "family":
            magnitude, source = known
        elif family is not None:
            magnitude, source = family, "family"
        elif known:
            magnitude, source = known
        else:
            continue
        if brightest_reachable(magnitude, perigee) < BRIGHTEST_LIMIT:
            rows.append(Row(norad, round(magnitude, 2), source, name))
    return rows


def read_table(path: Path) -> dict[int, tuple[float, str]]:
    """Read a table written by write_table: each object's magnitude and source."""
    with path.open(encoding="utf-8", newline="") as handle:
        lines = (line for line in handle if not line.startswith("#"))
        return {
            int(row["norad_id"]): (float(row["magnitude"]), row["source"])
            for row in csv.DictReader(lines)
        }


def read_built(path: Path) -> str:
    """Read the date a table was built, from its header."""
    found = re.search(r"Built on (\d{4}-\d{2}-\d{2})", read_text(path))
    if found is None:
        raise ValueError(f"{path} does not say when it was built")
    return found.group(1)


def download(url: str, *, referer: str | None = None) -> str:
    """Download a file, naming this script. Any error stops everything.

    With curl, as Python installed on a Mac often cannot verify secure connections.
    """
    command = ["curl", "--fail", "--silent", "--show-error", "--max-time", "120", "-A", USER_AGENT]
    if referer is not None:
        command += ["--referer", referer]
    result = subprocess.run([*command, url], capture_output=True, check=True)
    return result.stdout.decode("utf-8", errors="replace")


def download_satcat() -> dict[int, dict[str, str]]:
    """Download SATCAT, by NORAD number."""
    rows = csv.DictReader(download(SATCAT_URL).splitlines())
    return {int(row["NORAD_CAT_ID"]): row for row in rows}


def download_elements() -> set[int]:
    """Download the objects CelesTrak answers the integration's queries with."""
    found: set[int] = set()
    for query in ELEMENT_QUERIES:
        url = f"{GP_URL}?{urllib.parse.urlencode({**query, 'FORMAT': 'csv'})}"
        found |= read_elements(download(url))
    return found


def read_elements(text: str) -> set[int]:
    """Read the NORAD numbers from one of CelesTrak's answers, in CSV."""
    return {int(row["NORAD_CAT_ID"]) for row in csv.DictReader(text.splitlines())}


def table_text(rows: Iterable[Row], date: str) -> str:
    """Return the table, with the attribution its sources ask for at the top."""
    out = io.StringIO(newline="")
    out.write(HEADER.format(date=date))
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(("norad_id", "magnitude", "source", "name"))
    for row in rows:
        writer.writerow((row.norad_id, f"{row.magnitude:.2f}", row.source, row.name))
    return out.getvalue()


def write_table(rows: Iterable[Row], path: Path, date: str) -> None:
    """Write the table."""
    path.write_text(table_text(rows, date), encoding="utf-8", newline="")


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


def report(rows: list[Row], path: Path) -> None:
    counts: dict[str, int] = defaultdict(int)
    for row in rows:
        counts[row.source] += 1
    print(f"{path}: {len(rows)} objects, {dict(sorted(counts.items()))}")


def mmt_list(args: argparse.Namespace) -> str:
    """Return MMT's list: downloaded, or from the file given."""
    return download(MMT_URL, referer=MMT_REFERER) if args.download_mmt else read_text(args.mmt)


def _reason(err: Exception) -> object:
    detail = getattr(err, "stderr", None)
    return detail.decode(errors="replace").strip() if detail else err


def run_update(args: argparse.Namespace) -> None:
    """Bring the table at args.out up to date with MMT's list."""
    # First, so that a refusal here uses up none of CelesTrak's allowance.
    try:
        mmt = read_mmt(mmt_list(args))
    except (OSError, subprocess.CalledProcessError) as err:
        sys.exit(f"Stopped, and the table is unchanged: no list from MMT: {_reason(err)}")
    table = read_table(args.out)
    try:
        if args.satcat:
            with args.satcat.open(encoding="utf-8", newline="") as handle:
                satcat = {int(row["NORAD_CAT_ID"]): row for row in csv.DictReader(handle)}
        else:
            satcat = download_satcat()
        if args.elements:
            elements = {n for path in args.elements for n in read_elements(read_text(path))}
        else:
            elements = download_elements()
    except (OSError, subprocess.CalledProcessError) as err:
        sys.exit(
            f"Stopped, and the table is unchanged: {_reason(err)}\n"
            "CelesTrak refuses a repeat download: if it answered 403, wait two hours."
        )
    built = read_built(args.out)
    rows = update(mmt, table, satcat, elements, built)
    # A list that went wrong should not cost the table what it has.
    if len(rows) < len(table) / 2:
        sys.exit(f"Stopped: only {len(rows)} objects, where the table has {len(table)}.")
    moves = [abs(row.magnitude - table[row.norad_id][0]) for row in rows if row.norad_id in table]
    large = sum(move > LARGE_CHANGE for move in moves)
    if large > len(table) * MOST_LARGE_CHANGES:
        sys.exit(f"Stopped: {large} of {len(table)} values would move by over {LARGE_CHANGE}.")
    # Not even the date, so that a week with nothing new has nothing to propose.
    if table_text(rows, built) == read_text(args.out):
        print("Nothing has changed, so the table stays as it is.")
        return
    write_table(rows, args.out, datetime.now(UTC).date().isoformat())
    added = {row.norad_id for row in rows} - set(table)
    gone = set(table) - {row.norad_id for row in rows}
    print(f"{len(added)} objects added, {len(gone)} gone.")
    changed = sum(move > 0.005 for move in moves)
    print(f"{changed} values changed, the largest by {max(moves, default=0.0):.2f}.")
    report(rows, args.out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--mmt", type=Path, help="MMT's satellites_list.txt, saved earlier")
    source.add_argument(
        "--download-mmt",
        action="store_true",
        help="download MMT's list: about once a week at most, as its team agreed",
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="bring the table up to date with MMT's list alone, keeping its other values",
    )
    parser.add_argument("--qsmag", type=Path, help="McCants's qs.mag")
    parser.add_argument("--score", type=Path, help="SCORE's observations as CSV")
    parser.add_argument("--stellarium", type=Path, help="Stellarium's satellites.json")
    parser.add_argument("--gcat", type=Path, action="append", help="GCAT's satcat.tsv (repeatable)")
    parser.add_argument("--satcat", type=Path, help="CelesTrak's satcat.csv")
    parser.add_argument(
        "--elements",
        type=Path,
        action="append",
        help="CelesTrak's answer to one of the integration's queries, as CSV (repeatable)",
    )
    parser.add_argument("--overrides", type=Path, default=OVERRIDES)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    csv.field_size_limit(10**7)
    if args.update:
        run_update(args)
        return
    missing = [
        f"--{name}"
        for name in ("qsmag", "score", "stellarium", "gcat", "satcat", "elements")
        if not getattr(args, name)
    ]
    if missing:
        parser.error(f"a full build needs {', '.join(missing)}; or use --update")

    with args.score.open(encoding="utf-8", errors="replace", newline="") as handle:
        score = read_score(csv.DictReader(handle))
    with args.satcat.open(encoding="utf-8", newline="") as handle:
        satcat = {int(row["NORAD_CAT_ID"]): row for row in csv.DictReader(handle)}
    gcat: dict[int, dict[str, str]] = {}
    for path in args.gcat:
        gcat.update(read_gcat(read_text(path)))

    mmt = read_mmt(mmt_list(args))
    mccants = read_mccants(read_text(args.qsmag))
    stellarium = read_stellarium(read_text(args.stellarium), mccants)
    elements = {norad for path in args.elements for norad in read_elements(read_text(path))}
    rows = build(
        mmt, mccants, score, stellarium, gcat, satcat, read_overrides(args.overrides), elements
    )
    write_table(rows, args.out, datetime.now(UTC).date().isoformat())
    report(rows, args.out)


if __name__ == "__main__":
    main()
