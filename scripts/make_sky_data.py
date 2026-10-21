#!/usr/bin/env python3
"""Build the star data of the street view's planetarium sky.

Writes custom_components/satellite_spotter/frontend/sat-stars.js: the
naked-eye stars of the Yale Bright Star Catalogue (5th ed.), brightest first,
with IAU names for the brightest, and the 88 IAU constellations as stick
figures through those stars, with label positions. The attribution and the
d3-celestial licence go into the module's header comment.

Sources, each checked against a pinned SHA-256 digest:

  - Yale Bright Star Catalogue, 5th Revised Ed. (Hoffleit & Warren 1991),
    VizieR V/50 (CDS, Strasbourg). No licence terms are attached to it.
  - IAU Catalog of Star Names (IAU WGSN), Creative Commons Attribution 4.0.
  - d3-celestial data, (c) 2015 Olaf Frohn, BSD-3-Clause (pinned commit),
    for the constellation figures (after the IAU / Sky & Telescope charts,
    CC BY 3.0) and label positions. Its star positions come from Hipparcos
    (ESA, CC BY-NC 3.0 IGO) and are only used to find which Bright Star
    Catalogue star each figure vertex is; none of them is written out.

With --reference it also writes tests/js/helpers/street-skyfield.mjs, the
positions Skyfield (JPL DE421) gives for the Sun, the Moon, the planets and
some of these stars at a set of dates and places, which sat-astro.js is tested
against. That needs skyfield and de421.bsp (in --ephemeris-dir, downloaded
there when missing).

  python -I scripts/make_sky_data.py [--cache DIR] [--limit 5.5]
  python -I scripts/make_sky_data.py --reference --ephemeris-dir DIR
"""

from __future__ import annotations

import argparse
from datetime import datetime
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import ssl
import sys
import tempfile
import textwrap
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
OUT_JS = ROOT / "custom_components" / "satellite_spotter" / "frontend" / "sat-stars.js"
OUT_REFERENCE = ROOT / "tests" / "js" / "helpers" / "street-skyfield.mjs"

D3C_COMMIT = "7e720a3de062059d4c5400a379146a601d9010e0"  # 2022-07-05, the latest
D3C = f"https://raw.githubusercontent.com/ofrohn/d3-celestial/{D3C_COMMIT}"
SOURCES = {
    "catalog.gz": (
        "https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz",
        "3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed",
    ),
    "IAU-CSN.txt": (
        "https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt",
        "84fac0c90f1b19abc491c2793469e0caa7b003ad1bc93a790ca41147010d0eb0",
    ),
    "constellations.json": (
        f"{D3C}/data/constellations.json",
        "ab4ae692027cbc042c0d6791a84456a65eb7c55656107fd00c58ff6e55d4d8b2",
    ),
    "constellations.lines.json": (
        f"{D3C}/data/constellations.lines.json",
        "294f66bef5d5cf50b1e17f16d2efa1d97a15131612c68dd935adef6e7373e13c",
    ),
    "d3-celestial-LICENSE": (
        f"{D3C}/LICENSE",
        "a8c79239001ad4bea243d1796b85084e1fc39309c5c5a663930a1b46320254c6",
    ),
}

MERGE_ARCSEC = 60  # components closer than this are one point of light to the eye
NAME_LIMIT = 2.1  # proper names for stars at least this bright (includes Polaris)
MATCH_DEG = 0.05  # largest offset between a figure vertex and its catalogue star

BSC5_CITATION = (
    "Hoffleit D., Warren Jr W.H., The Bright Star Catalogue, 5th Revised Ed. "
    "(Preliminary Version), Astronomical Data Center, NSSDC/ADC (1991); "
    "VizieR catalogue V/50, CDS, Strasbourg, France"
)
IAU_CSN_CITATION = (
    "IAU Catalog of Star Names, IAU Working Group on Star Names (WGSN), "
    "https://www.iau.org/public/themes/naming_stars/, CC BY 4.0"
)
D3C_COPYRIGHT = "Copyright (c) 2015, Olaf Frohn"
FIGURES_CITATION = (
    f"d3-celestial ({D3C_COPYRIGHT}, BSD-3-Clause, https://github.com/ofrohn/d3-celestial), "
    "after the IAU constellation charts by the IAU and Sky & Telescope magazine "
    "(Roger Sinnott & Rick Fienberg), CC BY 3.0"
)

# B-V by spectral class (start and end of the class), for the few stars without photometry.
SPECTRAL_BV = {
    "O": (-0.33, -0.30),
    "B": (-0.30, -0.02),
    "A": (0.0, 0.27),
    "F": (0.30, 0.56),
    "G": (0.58, 0.79),
    "K": (0.81, 1.39),
    "M": (1.40, 1.70),
}

# Dates and places of the Skyfield reference: eclipses, a great conjunction,
# both hemispheres, the tropics and the poles.
REFERENCE_PLACES = {
    "denver": (39.74, -104.99, 1609),
    "sydney": (-33.87, 151.21, 58),
    "tromso": (69.65, 18.96, 10),
    "quito": (-0.18, -78.47, 2850),
    "london": (51.48, -0.0015, 46),
    "tokyo": (35.68, 139.69, 40),
    "cape_town": (-33.92, 18.42, 0),
    "mcmurdo": (-77.85, 166.67, 10),
}
REFERENCE_DATES = [
    "2010-01-01T00:00:00Z",
    "2020-12-21T18:00:00Z",  # Jupiter-Saturn conjunction
    "2024-04-08T18:18:00Z",  # total solar eclipse, North America
    "2026-01-15T03:30:00Z",
    "2026-03-20T18:00:00Z",
    "2026-06-21T21:15:00Z",
    "2026-10-17T02:00:00Z",
    "2027-08-02T10:07:00Z",  # total solar eclipse, North Africa
    "2030-12-25T05:45:00Z",
    "2035-06-15T12:00:00Z",
]
REFERENCE_STARS = [
    "Sirius",
    "Canopus",
    "Arcturus",
    "Vega",
    "Capella",
    "Rigel",
    "Betelgeuse",
    "Polaris",
    "Acrux",
    "Deneb",
    "Fomalhaut",
    "Altair",
]
SIGMA_OCTANTIS = (317.2, -88.96)  # the southern pole star, 5.5 mag, found by position
REFERENCE_PLANETS = {
    "mercury": "mercury",
    "venus": "venus",
    "mars": "mars",
    "jupiter": "jupiter barycenter",
    "saturn": "saturn barycenter",
}


# ---------------------------------------------------------------------------- sources


def tls_context() -> ssl.SSLContext:
    """Verified TLS; with certifi's CA bundle when it is installed (python.org builds ship none)."""
    try:
        import certifi  # noqa: PLC0415 - optional
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def fetch(cache: Path, name: str, allow_changed: bool) -> bytes:
    """A source file from the cache, else downloaded into it, checked against its digest."""
    url, digest = SOURCES[name]
    path = cache / name
    if not path.exists():
        print(f"downloading {url}", file=sys.stderr)
        request = urllib.request.Request(url, headers={"User-Agent": "satellite-spotter-build/1"})
        with urllib.request.urlopen(request, timeout=60, context=tls_context()) as response:
            path.write_bytes(response.read())
    data = path.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != digest:
        message = f"{name}: sha256 {actual} differs from the pinned {digest}"
        if not allow_changed:
            sys.exit(f"{message}; review the change, then rerun with --allow-changed")
        print(f"warning: {message}", file=sys.stderr)
    return data


# ---------------------------------------------------------------------------- stars


def unit(ra: float, dec: float) -> tuple[float, float, float]:
    a, d = math.radians(ra), math.radians(dec)
    return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))


def separation(a: tuple, b: tuple) -> float:
    """Angle between two unit vectors, in degrees."""
    cross = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    return math.degrees(
        math.atan2(math.hypot(*cross), sum(x * y for x, y in zip(a, b, strict=True)))
    )


def bv_from_spectrum(spectrum: str) -> float | None:
    match = re.search(r"([OBAFGKM])(\d(?:\.\d)?)?", spectrum)
    if not match:
        return None
    lo, hi = SPECTRAL_BV[match[1]]
    return lo + (hi - lo) * float(match[2] or 5) / 10


def parse_bsc5(raw: bytes) -> list[dict]:
    """Stars of the Bright Star Catalogue (byte layout in VizieR V/50 ReadMe)."""
    stars = []
    for text in gzip.decompress(raw).decode("ascii", "replace").splitlines():
        line = text.ljust(197)
        if not line[75:77].strip() or not line[102:107].strip():
            continue  # the 14 retired entries (novae, clusters, galaxies) have no data
        if line[107] == "H" and re.match(r"(?:[R-Z]{1,2}|V\d+) ", line[51:60]):
            # Old Harvard magnitude at maximum of a large-amplitude variable, far
            # brighter than it usually is: T CrB (2.0, the 1866 nova; ~10 between
            # eruptions), R Hor and T UMa (Miras).
            print(
                f"skipping HR {line[0:4].strip()} ({line[51:60].strip()}, "
                f"V {line[102:107].strip()} at maximum)",
                file=sys.stderr,
            )
            continue
        ra = 15 * (int(line[75:77]) + int(line[77:79]) / 60 + float(line[79:83]) / 3600)
        dec = int(line[84:86]) + int(line[86:88]) / 60 + int(line[88:90]) / 3600
        if line[83] == "-":
            dec = -dec
        bv = line[109:114].strip()
        stars.append(
            {
                "hr": int(line[0:4]),
                "ra": ra,
                "dec": dec,
                "v": float(line[102:107]),
                "bv": float(bv) if bv else None,
                "sp": line[127:147].strip(),
            }
        )
    return stars


def merge_close(stars: list[dict], arcsec: float) -> list[dict]:
    """Merge components closer than `arcsec`: summed flux at the photocentre."""
    limit = arcsec / 3600
    for s in stars:
        s["xyz"] = unit(s["ra"], s["dec"])
    order = sorted(range(len(stars)), key=lambda i: stars[i]["dec"])
    parent = list(range(len(stars)))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for k, i in enumerate(order):
        for j in order[k + 1 : k + 50]:  # the next few in declination are the only candidates
            if stars[j]["dec"] - stars[i]["dec"] > limit:
                break
            if separation(stars[i]["xyz"], stars[j]["xyz"]) < limit:
                parent[root(j)] = root(i)
    groups: dict[int, list[dict]] = {}
    for i, s in enumerate(stars):
        groups.setdefault(root(i), []).append(s)

    merged = []
    for members in groups.values():
        members.sort(key=lambda s: s["v"])
        flux = [10 ** (-0.4 * s["v"]) for s in members]
        total = sum(flux)
        x, y, z = (
            sum(f * s["xyz"][k] for f, s in zip(flux, members, strict=True)) for k in range(3)
        )
        bvs = [(f, s["bv"]) for f, s in zip(flux, members, strict=True) if s["bv"] is not None]
        bv = sum(f * b for f, b in bvs) / sum(f for f, _ in bvs) if bvs else None
        if bv is None:
            bv = bv_from_spectrum(members[0]["sp"])
        ra = math.degrees(math.atan2(y, x)) % 360
        dec = math.degrees(math.atan2(z, math.hypot(x, y)))
        merged.append(
            {
                "hr": [s["hr"] for s in members],  # brightest first
                "ra": ra,
                "dec": dec,
                "v": -2.5 * math.log10(total),
                "bv": bv,
                "xyz": unit(ra, dec),
            }
        )
    return merged


def parse_iau_names(text: str) -> dict[int, str]:
    """IAU proper names by HR number. The first 18 columns hold the ASCII name."""
    names = {}
    for line in text.splitlines():
        if not line.strip() or line[0] in "#$":
            continue
        match = re.search(r"\bHR (\d+)\b", line[18:])
        if match:
            names[int(match[1])] = line[:18].strip()
    return names


class Grid:
    """Stars bucketed by whole degrees of declination, for nearest-star lookups."""

    def __init__(self, stars: list[dict]):
        self.stars = stars
        self.bands: dict[int, list[int]] = {}
        for i, s in enumerate(stars):
            self.bands.setdefault(math.floor(s["dec"]), []).append(i)

    def nearest(self, ra: float, dec: float) -> tuple[int, float]:
        xyz = unit(ra, dec)
        best, best_sep = -1, 180.0
        for band in range(math.floor(dec) - 1, math.floor(dec) + 2):
            for i in self.bands.get(band, ()):
                sep = separation(xyz, self.stars[i]["xyz"])
                if sep < best_sep:
                    best, best_sep = i, sep
        return best, best_sep


def rounded(value: float, digits: int):
    value = round(value, digits)
    return int(value) if value == int(value) else value  # 5.0 -> 5, -0.0 -> 0


def build(cache: Path, limit: float, allow_changed: bool) -> dict:
    """The stars, their names and the constellation figures, from the pinned sources."""
    bsc5 = parse_bsc5(fetch(cache, "catalog.gz", allow_changed))
    names = parse_iau_names(fetch(cache, "IAU-CSN.txt", allow_changed).decode("utf-8"))
    labels = json.loads(fetch(cache, "constellations.json", allow_changed))["features"]
    figures = json.loads(fetch(cache, "constellations.lines.json", allow_changed))["features"]
    license_text = fetch(cache, "d3-celestial-LICENSE", allow_changed).decode("utf-8").strip()

    stars = merge_close(bsc5, MERGE_ARCSEC)
    grid = Grid(stars)
    print(
        f"{len(bsc5)} catalogue stars, {len(stars)} after merging pairs closer than "
        f'{MERGE_ARCSEC}"',
        file=sys.stderr,
    )

    # Figure vertices to catalogue stars (all magnitudes: some figures use faint stars).
    if [f["id"] for f in figures] != [f["id"] for f in labels]:
        sys.exit("constellations.json and constellations.lines.json are not in the same order")
    used, worst = set(), (0.0, "")
    figure_stars = []
    for feature in figures:
        polylines = []
        for line in feature["geometry"]["coordinates"]:
            polyline = []
            for lon, lat in line:
                i, sep = grid.nearest(lon % 360, lat)
                if sep > MATCH_DEG:
                    sys.exit(
                        f"{feature['id']}: no catalogue star within {MATCH_DEG} deg of {lon}, {lat}"
                    )
                if sep > worst[0]:
                    worst = (sep, f"{feature['id']} HR {stars[i]['hr'][0]}")
                if not polyline or polyline[-1] != i:
                    polyline.append(i)
                used.add(i)
            if len(polyline) > 1:
                polylines.append(polyline)
        figure_stars.append(polylines)
    print(
        f'figure vertices matched within {worst[0] * 3600:.1f}" (worst: {worst[1]})',
        file=sys.stderr,
    )

    keep = sorted(
        (i for i, s in enumerate(stars) if s["v"] <= limit or i in used),
        key=lambda i: (stars[i]["v"], stars[i]["ra"]),
    )
    index = {old: new for new, old in enumerate(keep)}
    fainter = sum(1 for i in keep if stars[i]["v"] > limit)
    missing_bv = sum(1 for i in keep if stars[i]["bv"] is None)

    rows, named = [], []
    for new, old in enumerate(keep):
        s = stars[old]
        bv = s["bv"] if s["bv"] is not None else 1.6  # carbon and S stars without photometry
        rows.append([rounded(s["ra"], 2), rounded(s["dec"], 2), rounded(s["v"], 1), rounded(bv, 1)])
        if s["v"] <= NAME_LIMIT:
            name = next((names[hr] for hr in s["hr"] if hr in names), None)
            if name:
                named.append([new, name])

    constellations = []
    for label, polylines in zip(labels, figure_stars, strict=True):
        props = label["properties"]
        lon, lat = label["geometry"]["coordinates"]
        constellations.append(
            {
                "id": label["id"],
                "name": props["name"],
                "rank": int(props["rank"]),
                "label": [rounded(lon % 360, 2), rounded(lat, 2)],
                "lines": [[index[i] for i in polyline] for polyline in polylines],
            }
        )

    print(
        f"{len(rows)} stars ({fainter} fainter than {limit} for the figures, "
        f"{missing_bv} without B-V), {len(named)} named, {len(constellations)} figures, "
        f"{sum(len(p) for c in constellations for p in c['lines'])} figure vertices",
        file=sys.stderr,
    )
    about = (
        f"Stars to V {limit} (plus {fainter} fainter ones used by constellation figures) from "
        f'the Yale Bright Star Catalogue, 5th ed., pairs closer than {MERGE_ARCSEC}" merged, '
        "brightest first."
    )
    return {
        "about": about,
        "rows": rows,
        "named": named,
        "constellations": constellations,
        "license": license_text,
    }


# ---------------------------------------------------------------------------- output


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def comment(text: str, width: int = 100) -> list[str]:
    """Text as the lines of a /** */ comment, paragraphs kept, wrapped to `width`."""
    out = []
    for paragraph in text.split("\n"):
        if not paragraph.strip():
            out.append(" *")
            continue
        indent = re.match(r"\s*", paragraph)[0]
        out.extend(
            f" * {line}"
            for line in textwrap.wrap(
                paragraph.strip(),
                width - 3 - len(indent),
                initial_indent=indent,
                subsequent_indent=indent,
                break_on_hyphens=False,
            )
        )
    return out


def write_js(path: Path, data: dict) -> None:
    """sat-stars.js: the data as JavaScript, the attribution and licence in its header."""
    header = "\n".join(
        [
            "Stars and constellations of the street view's planetarium sky. Generated by",
            "scripts/make_sky_data.py from the sources below: do not edit by hand.",
            "",
            data["about"],
            "",
            "STARS: positions (J2000), V magnitudes and B-V colours: " + BSC5_CITATION + ".",
            "STAR_NAMES: " + IAU_CSN_CITATION + ".",
            "CONSTELLATIONS: figures and label positions from " + FIGURES_CITATION + ".",
            "The d3-celestial licence follows.",
            "",
            data["license"],
        ]
    )
    rows = data["rows"]
    lines = ["/**", *comment(header), " */", ""]
    lines += [
        "/** How many stars STARS holds. */",
        f"export const STAR_COUNT = {len(rows)};",
        "",
        "/**",
        " * Right ascension and declination (J2000, degrees), V magnitude and B-V colour index",
        " * of every star, brightest first, flat: [ra, dec, mag, bv, ra, dec, mag, bv, …].",
        " */",
        "export const STARS = [",
        *(",".join(dumps(x) for x in row) + "," for row in rows),
        "];",
        "",
        "/** IAU proper names of the brightest stars: [index into STARS, name]. */",
        f"export const STAR_NAMES = {dumps(data['named'])};",
        "",
        "/**",
        " * The 88 IAU constellations (Serpens twice: Caput and Cauda): the stick figure as",
        " * polylines of indices into STARS, the label position (J2000 [ra, dec], degrees) and",
        " * how prominent the label is, rank 1 (most) to 3.",
        " */",
        "export const CONSTELLATIONS = [",
        *(dumps(c) + "," for c in data["constellations"]),
        "];",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
    size = path.stat().st_size
    print(
        f"{path.name}: {size} bytes, {len(gzip.compress(path.read_bytes(), 9))} gzipped",
        file=sys.stderr,
    )


# ---------------------------------------------------------------------------- reference


def write_reference(data: dict, ephemeris_dir: Path, out: Path) -> None:
    """Skyfield's Sun, Moon, planets and stars at the reference dates and places, for the tests."""
    from skyfield import __version__ as skyfield_version  # noqa: PLC0415 - optional
    from skyfield.api import Loader, Star, wgs84  # noqa: PLC0415
    from skyfield.earthlib import refract  # noqa: PLC0415
    from skyfield.magnitudelib import planetary_magnitude  # noqa: PLC0415
    from skyfield.trigonometry import position_angle_of  # noqa: PLC0415

    def r(x: float, digits: int = 4) -> float:
        return round(float(x), digits)

    flat = [x for row in data["rows"] for x in row]
    index = {name: i for i, name in data["named"]}
    picked = {name: (flat[index[name] * 4], flat[index[name] * 4 + 1]) for name in REFERENCE_STARS}
    ra0, dec0 = SIGMA_OCTANTIS
    i = min(
        range(len(flat) // 4),
        key=lambda i: (flat[i * 4] - ra0) ** 2 + (flat[i * 4 + 1] - dec0) ** 2,
    )
    picked["sigma Octantis"] = (flat[i * 4], flat[i * 4 + 1])

    load = Loader(str(ephemeris_dir), verbose=False)
    ts = load.timescale(builtin=True)
    eph = load("de421.bsp")
    earth, sun, moon = eph["earth"], eph["sun"], eph["moon"]
    places = list(REFERENCE_PLACES)

    cases = []
    for k, iso in enumerate(REFERENCE_DATES):
        t = ts.from_datetime(datetime.fromisoformat(iso.replace("Z", "+00:00")))
        geocentre = earth.at(t)
        g_moon = geocentre.observe(moon).apparent()
        g_sun = geocentre.observe(sun).apparent()
        moon_ra, moon_dec, moon_dist = g_moon.radec(epoch="date")
        sun_ra, sun_dec, sun_dist = g_sun.radec(epoch="date")
        for place in (places[k % 8], places[(k + 3) % 8], places[(k + 6) % 8]):
            lat, lon, height = REFERENCE_PLACES[place]
            here = (earth + wgs84.latlon(lat, lon, elevation_m=height)).at(t)
            case = {
                "time": iso,
                "place": place,
                "observer": {"latitude": lat, "longitude": lon, "elevation": height},
                "gmst": r(t.gmst * 15),
                "stars": [],
                "planets": [],
            }
            for name, (ra, dec) in picked.items():
                alt, az, _ = (
                    here.observe(Star(ra_hours=ra / 15, dec_degrees=dec)).apparent().altaz()
                )
                case["stars"].append(
                    {
                        "name": name,
                        "ra": ra,
                        "dec": dec,
                        "azimuth": r(az.degrees),
                        "elevation": r(alt.degrees),
                    }
                )
            t_sun = here.observe(sun).apparent()
            alt, az, _ = t_sun.altaz()
            case["sun"] = {
                "azimuth": r(az.degrees),
                "elevation": r(alt.degrees),
                "ra": r(sun_ra._degrees),
                "dec": r(sun_dec.degrees),
                "distance": r(sun_dist.au, 8),
            }
            t_moon = here.observe(moon).apparent()
            alt, az, dist = t_moon.altaz()
            lit = position_angle_of(
                t_moon.altaz(), t_sun.altaz()
            ).degrees  # counterclockwise from up
            limb = position_angle_of(g_moon.radec(epoch="date"), g_sun.radec(epoch="date")).degrees
            case["moon"] = {
                "azimuth": r(az.degrees),
                "elevation": r(alt.degrees),
                "distance": r(dist.km, 1),
                "geocentric": {
                    "ra": r(moon_ra._degrees),
                    "dec": r(moon_dec.degrees),
                    "distance": r(moon_dist.km, 1),
                },
                "fraction": r(g_moon.fraction_illuminated(sun)),
                "phaseAngle": r(g_moon.phase_angle(sun).degrees),
                "positionAngle": r(limb),
                "litSide": r((360 - lit) % 360),
            }
            for name, target in REFERENCE_PLANETS.items():
                body = eph[target]
                alt, az, _ = here.observe(body).apparent().altaz()
                astrometric = geocentre.observe(body)
                ra, dec, dist = astrometric.radec()
                case["planets"].append(
                    {
                        "name": name,
                        "azimuth": r(az.degrees),
                        "elevation": r(alt.degrees),
                        "ra": r(ra._degrees),
                        "dec": r(dec.degrees),
                        "distance": r(dist.au, 8),
                        "magnitude": r(planetary_magnitude(astrometric), 3),
                    }
                )
            cases.append(case)

    heights = [-1, -0.5, 0, 0.5, 1, 2, 3, 5, 10, 20, 30, 45, 60, 80, 89]
    refraction = [[h, r(refract(h, 10.0, 1010.0) - h)] for h in heights]
    about = (
        f"Skyfield {skyfield_version} with JPL DE421: apparent positions, no refraction. "
        "Generated by scripts/make_sky_data.py --reference; do not edit by hand."
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        "// Reference positions for the tests of sat-astro.js (tests/js/astro.test.mjs).\n"
        f'export default {{"about":{dumps(about)},\n'
        f'"refraction":{dumps({"temperature": 10, "pressure": 1010, "samples": refraction})},\n'
        '"cases":[\n' + ",\n".join(dumps(case) for case in cases) + "\n]};\n",
        encoding="utf-8",
    )
    print(f"{len(cases)} reference cases written to {out}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", maxsplit=1)[0])
    parser.add_argument("--out", type=Path, default=OUT_JS, help="the module to write")
    parser.add_argument(
        "--cache", type=Path, help="download directory (default: a new temporary one)"
    )
    parser.add_argument(
        "--limit", type=float, default=5.5, help="faintest V magnitude (default 5.5)"
    )
    parser.add_argument(
        "--allow-changed", action="store_true", help="accept sources whose digest changed"
    )
    parser.add_argument(
        "--reference", action="store_true", help="also write the Skyfield test reference"
    )
    parser.add_argument("--reference-out", type=Path, default=OUT_REFERENCE)
    parser.add_argument("--ephemeris-dir", type=Path, help="where de421.bsp is (or goes)")
    args = parser.parse_args()
    cache = args.cache or Path(tempfile.mkdtemp(prefix="sky-sources-"))
    cache.mkdir(parents=True, exist_ok=True)
    data = build(cache, args.limit, args.allow_changed)
    write_js(args.out, data)
    if args.reference:
        if not args.ephemeris_dir:
            parser.error("--reference needs --ephemeris-dir")
        write_reference(data, args.ephemeris_dir, args.reference_out)


if __name__ == "__main__":
    main()
