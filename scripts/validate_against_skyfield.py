"""Cross-check track.py's geometry against Skyfield and a JPL ephemeris.

Usage (from the repository root, with skyfield installed):

    python scripts/validate_against_skyfield.py --elements omm.xml --ephemeris de421.bsp

``--elements`` is a CelesTrak OMM XML file (FORMAT=XML). Without it the script
downloads the current ISS elements. ``--ephemeris`` defaults to de421.bsp,
which Skyfield downloads (~17 MB) if it is missing.

track.py places the satellites the globe and the street view draw: positions,
look angles, sub-points and the Sun. Here they are compared with Skyfield at
random instants, for several observers. With ``--write-fixture`` the Skyfield
results are saved for tests/test_track.py, so the test suite needs neither
Skyfield nor the ephemeris.

Sunlight differs on purpose: like See A Satellite Tonight, track.py requires
the Sun's rays to clear 15 km of atmosphere, where Skyfield's Earth is a bare
sphere. Disagreements are counted only away from the shadow's edge.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime, timedelta
import importlib.util
import io
import json
import math
from pathlib import Path
import random
import sys
import urllib.request

import numpy as np
from sgp4 import omm
from sgp4.api import Satrec
from skyfield.api import EarthSatellite, Loader, wgs84

CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=XML"
TRACK = Path(__file__).resolve().parents[1] / "custom_components/satellite_spotter/track.py"
OBSERVERS = {
    "boston": (42.36, -71.06, 10.0),
    "denver": (39.74, -104.99, 1609.0),
    "london": (51.51, -0.13, 11.0),
    "sydney": (-33.87, 151.21, 58.0),
    "quito": (-0.18, -78.47, 2850.0),
    "reykjavik": (64.15, -21.94, 20.0),
}
# Seconds either side of an instant where the two shadow models may disagree.
SHADOW_EDGE_S = 25.0


def load_track():
    """Import track.py on its own (the integration's package needs Home Assistant)."""
    spec = importlib.util.spec_from_file_location("satellite_spotter_track", TRACK)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def angle_between(az1: float, el1: float, az2: float, el2: float) -> float:
    """Great-circle separation of two sky directions, in degrees."""
    a1, e1, a2, e2 = map(math.radians, (az1, el1, az2, el2))
    c = math.sin(e1) * math.sin(e2) + math.cos(e1) * math.cos(e2) * math.cos(a1 - a2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--elements", type=Path)
    parser.add_argument("--ephemeris", default="de421.bsp")
    parser.add_argument("--days", type=float, default=10)
    parser.add_argument("--instants", type=int, default=300)
    parser.add_argument("--write-fixture", type=Path)
    args = parser.parse_args()

    if args.elements:
        payload = args.elements.read_bytes()
    else:
        with urllib.request.urlopen(CELESTRAK_URL, timeout=30) as resp:
            payload = resp.read()
    (fields,) = omm.parse_xml(io.StringIO(payload.decode()))
    satrec = Satrec()
    omm.initialize(satrec, fields)
    track = load_track()

    eph_path = Path(args.ephemeris).resolve()
    load = Loader(str(eph_path.parent))
    eph = load(eph_path.name)
    ts = load.timescale(builtin=True)
    sat = EarthSatellite.from_satrec(satrec, ts)

    epoch = datetime.fromisoformat(fields["EPOCH"]).replace(tzinfo=UTC)
    start = epoch.replace(microsecond=0) + timedelta(hours=1)
    end = start + timedelta(days=args.days)
    print(f"Elements epoch {epoch.isoformat()}  window {start} .. {end}")

    fixture = {
        "elements_xml": payload.decode(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "observers": {},
    }
    rng = random.Random(25544)
    failures = 0
    for name, (lat, lon, elev) in OBSERVERS.items():
        topos = wgs84.latlon(lat, lon, elevation_m=elev)
        observer_at = eph["earth"] + topos
        observer = track.Observer(lat, lon, elev)
        span = args.days * 86400
        times = np.array(
            sorted(start.timestamp() + rng.uniform(0, span) for _ in range(args.instants))
        )
        pos = track.propagate([satrec], times)[0]
        azimuth, elevation, distance = track.look(observer, pos)
        lat_deg, lon_deg, alt_km = track.geodetic(pos)
        sun = track.sun_at(times)
        _, sun_elevation, _ = track.look(observer, sun)
        lit = track.sunlit(pos, sun - pos)

        pointing, range_err, sun_err, sub_err, alt_err = [], [], [], [], []
        shadow_mismatch, instants = 0, []
        for i, when in enumerate(times):
            t = ts.from_datetime(datetime.fromtimestamp(when, UTC))
            alt, az, dist = (sat - topos).at(t).altaz()
            sf_sun = observer_at.at(t).observe(eph["sun"]).apparent().altaz()[0].degrees
            sf_lit = bool(sat.at(t).is_sunlit(eph))
            sp = wgs84.geographic_position_of(sat.at(t))
            pointing.append(angle_between(azimuth[i], elevation[i], az.degrees, alt.degrees))
            range_err.append(abs(distance[i] / 1000 - dist.km))
            sun_err.append(abs(sun_elevation[i] - sf_sun))
            sub_err.append(
                max(
                    abs(lat_deg[i] - sp.latitude.degrees),
                    abs((lon_deg[i] - sp.longitude.degrees + 180) % 360 - 180),
                )
            )
            alt_err.append(abs(alt_km[i] - sp.elevation.km))
            if bool(lit[i]) != sf_lit:
                near = when + np.array([-SHADOW_EDGE_S, SHADOW_EDGE_S])
                edge_pos = track.propagate([satrec], near)[0]
                edge = track.sunlit(edge_pos, track.sun_at(near) - edge_pos)
                shadow_mismatch += len(set(edge.tolist())) == 1
            instants.append(
                {
                    "time": float(when),
                    "azimuth": az.degrees,
                    "elevation": alt.degrees,
                    "range_km": dist.km,
                    "sun_elevation": sf_sun,
                    "sunlit": sf_lit,
                    "latitude": sp.latitude.degrees,
                    "longitude": sp.longitude.degrees,
                    "altitude_km": sp.elevation.km,
                }
            )
        print(
            f"{name:>10}: pointing max {max(pointing):.4f} deg | range max {max(range_err):.3f} km"
            f" | sun max {max(sun_err):.4f} deg | sub-point max {max(sub_err):.4f} deg"
            f" | height max {max(alt_err):.3f} km"
            f" | sunlit disagreements away from the shadow's edge {shadow_mismatch}"
        )
        if max(pointing) > 0.05 or max(sun_err) > 0.05 or max(sub_err) > 0.05:
            failures += 1
        if max(range_err) > 0.5 or max(alt_err) > 0.5 or shadow_mismatch:
            failures += 1
        fixture["observers"][name] = {
            "latitude": lat,
            "longitude": lon,
            "elevation_m": elev,
            "instants": rng.sample(instants, 40),
        }

    if args.write_fixture:
        args.write_fixture.write_text(json.dumps(fixture, separators=(",", ":")))
        print(f"Wrote {args.write_fixture}")
    print("PASS" if not failures else f"FAIL ({failures} checks)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
