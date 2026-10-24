"""track.py against the pysatellitespotter library, and its geometry against Skyfield."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import io
import math
from typing import Any

import numpy as np
from pysatellitespotter import Satellite, group_transits, predict_transits
import pytest
from sgp4 import omm

from custom_components.satellite_spotter import track
from custom_components.satellite_spotter.catalog import validate

from .common import DENVER, NOW, UTRECHT, satellites

PLACES = {
    "utrecht": tuple(UTRECHT.values()),
    "denver": tuple(DENVER.values()),
    "sydney": (-33.87, 151.21, 58.0),
}
START = NOW.replace(second=0) - timedelta(minutes=5)
# The library is a moving target: its private helpers are the reference for
# the port where they exist.
private = pytest.importorskip("pysatellitespotter.predict")
needs_private = pytest.mark.skipif(
    not all(
        hasattr(private, name) for name in ("_magnitudes", "_make_observer", "_sun_ecef", "_gmst")
    ),
    reason="pysatellitespotter no longer has the private helpers this port follows",
)


@pytest.fixture(scope="module")
def catalog() -> list[Satellite]:
    return satellites()


@pytest.fixture(scope="module", params=sorted(PLACES))
def place(request: pytest.FixtureRequest) -> tuple[str, track.Observer]:
    return request.param, track.Observer(*PLACES[request.param])


@pytest.fixture(scope="module")
def transits(catalog: list[Satellite], place: tuple[str, track.Observer]) -> list[Any]:
    _, observer = place
    return predict_transits(
        catalog, observer.latitude, observer.longitude, observer.elevation_m, start=START
    )


def _samples(sat: Satellite, start: float, end: float, step: float = 1.0) -> tuple[Any, Any, Any]:
    ts = np.arange(start, end, step)
    pos = track.propagate([sat.satrec()], ts)[0]
    return ts, pos, track.sun_at(ts)


@needs_private
def test_frames_and_sun_match_the_library() -> None:
    jd = 2461330.5 + np.linspace(0, 5, 101)
    assert np.array_equal(track.gmst(jd), private._gmst(jd))
    assert np.array_equal(track.sun_ecef(jd), private._sun_ecef(jd))
    for lat, lon, elev in PLACES.values():
        mine, theirs = track.Observer(lat, lon, elev), private._make_observer(lat, lon, elev)
        assert np.array_equal(mine.position, theirs.position)
        assert np.array_equal(mine.normal, theirs.normal)


@needs_private
def test_magnitudes_match_the_library(
    catalog: list[Satellite], place: tuple[str, track.Observer], transits: list[Any]
) -> None:
    """The port gives the library's magnitudes and visibility exactly, every second of a pass."""
    _, observer = place
    theirs_observer = private._make_observer(
        observer.latitude, observer.longitude, observer.elevation_m
    )
    assert transits
    compared = 0
    for t in transits:
        sat = t.satellite
        ts, pos, sun = _samples(sat, t.start.timestamp() - 600, t.end.timestamp() + 600)
        ph = track.photometry(sat, observer, pos, sun)
        mine = np.where(track.visible(ph), ph.magnitude, np.inf)
        n = len(ts)
        theirs, sun_angle = private._magnitudes(
            theirs_observer,
            pos,
            sun,
            np.full(n, np.inf if sat.magnitude is None else sat.magnitude),
            np.full(n, sat.model or "", dtype=object),
        )
        assert np.array_equal(np.isinf(mine), np.isinf(theirs)), sat.name
        finite = np.isfinite(mine)
        assert np.allclose(mine[finite], theirs[finite], rtol=0, atol=1e-9), sat.name
        assert np.allclose(ph.sun_angle, sun_angle, rtol=0, atol=1e-12)
        compared += n
    assert compared > 10_000


def test_visible_windows_match_the_predictions(
    place: tuple[str, track.Observer], transits: list[Any]
) -> None:
    """Exact positions agree with the library's (interpolated) windows within seconds."""
    name, observer = place
    for t in transits:
        ts, pos, sun = _samples(t.satellite, t.start.timestamp() - 120, t.end.timestamp() + 120)
        ph = track.photometry(t.satellite, observer, pos, sun)
        shown = np.flatnonzero(track.visible(ph, 3.0))
        brightest = ph.magnitude[np.argmin(np.abs(ts - t.brightest_time.timestamp()))]
        if 3.0 - t.min_magnitude < 0.1:
            # Borderline: barely under the cutoff, a second either way changes everything.
            continue
        assert len(shown), (name, t.satellite.name)
        assert abs(ts[shown[0]] - t.start.timestamp()) <= 5, (name, t.satellite.name)
        assert abs(ts[shown[-1]] + 1 - t.end.timestamp()) <= 5, (name, t.satellite.name)
        assert abs(brightest - t.min_magnitude) < 0.1, (name, t.satellite.name)


def test_transit_shapes(place: tuple[str, track.Observer], transits: list[Any]) -> None:
    """The highest point and why each window begins and ends."""
    _, observer = place
    for t in transits:
        fallback = track.SkyPoint(0.0, 0.0, 0.0)
        shape = track.transit_shape(
            t.satellite, observer, t.start.timestamp(), t.end.timestamp(), fallback
        )
        assert t.start.timestamp() <= shape.peak.time < t.end.timestamp()
        assert shape.peak.elevation >= max(t.rise.elevation, t.set.elevation, 10) - 0.5
        assert shape.peak.elevation >= t.brightest.elevation - 0.5
        ts, pos, sun = _samples(t.satellite, t.start.timestamp() - 8, t.end.timestamp() + 8)
        _, el, _ = track.look(observer, pos)
        lit = track.sunlit(pos, sun - pos)
        before, after = ts < t.start.timestamp(), ts >= t.end.timestamp()
        match shape.start_reason:
            case "rise":
                assert t.rise.elevation <= 10.5
            case "shadow":
                assert not lit[before].all()
            case "sky":
                assert lit[before].all() and t.rise.elevation > 10.2
        match shape.end_reason:
            case "set":
                assert t.set.elevation <= 10.5
            case "shadow":
                assert not lit[after].all()
            case "sky":
                assert lit[after].all() and el[after][0] > 10.2


def test_reasons_cover_every_case(catalog: list[Satellite]) -> None:
    """Satellites rise into view, leave Earth's shadow, set and fade into it."""
    seen: set[tuple[str, str]] = set()
    for lat, lon, elev in PLACES.values():
        observer = track.Observer(lat, lon, elev)
        for t in predict_transits(catalog, lat, lon, elev, start=START):
            shape = track.transit_shape(
                t.satellite, observer, t.start.timestamp(), t.end.timestamp(),
                track.SkyPoint(0.0, 0.0, 0.0),
            )  # fmt: skip
            seen |= {("start", shape.start_reason), ("end", shape.end_reason)}
    assert seen >= {("start", "rise"), ("start", "shadow"), ("start", "sky"),
                    ("end", "shadow"), ("end", "sky")}  # fmt: skip


def test_pass_track_rows(catalog: list[Satellite]) -> None:
    observer = track.Observer(*PLACES["denver"])
    t = next(
        t
        for t in predict_transits(catalog, *PLACES["denver"], start=START)
        if t.satellite.norad_id == 25544
    )
    start, end = t.start.timestamp(), t.end.timestamp()
    sky = track.pass_track(t.satellite, observer, start, end, 1.0, 3.0)
    assert sky is not None
    rows = sky.rows
    # Horizon to horizon (about ten minutes for the station), one second apart.
    assert 400 < len(rows) < 800
    assert rows[0][6] < 0 < rows[1][6] and rows[-1][6] < 0 < rows[-2][6]
    assert (sky.horizon_rise, sky.horizon_set) == (rows[0][0], rows[-1][0])
    shown = [row[0] for row in rows if row[9]]
    assert abs(shown[0] - start) <= 5 and abs(shown[-1] + 1 - end) <= 5
    # Sub-points and heights match the ground track of the same instants.
    ground = track.ground_rows(t.satellite.satrec(), np.array([row[0] for row in rows[::50]]))
    for g, row in zip(ground, rows[::50], strict=True):
        assert g == row[:5]


def test_positions_and_shared_propagators(catalog: list[Satellite]) -> None:
    """All satellites at once place each as alone, and leave the shared records untouched."""
    satrecs = [s.satrec() for s in catalog]
    before = [(r.t, r.error, r.no_kozai) for r in satrecs]
    ts = NOW.timestamp() + np.arange(0, 601, 60.0)
    many = track.positions(satrecs, ts)
    assert many.ok.all()
    assert [(r.t, r.error, r.no_kozai) for r in satrecs] == before
    for i, sat in enumerate(catalog):
        one = track.ground_rows(sat.satrec(), ts)
        assert [row[1] for row in one] == pytest.approx(many.latitude[i].tolist(), abs=1e-4)
        assert [row[3] for row in one] == pytest.approx(many.altitude_km[i].tolist(), abs=0.05)
        assert [row[4] for row in one] == many.lit[i].astype(int).tolist()


def test_orbits(catalog: list[Satellite]) -> None:
    iss = next(s for s in catalog if s.norad_id == 25544)
    assert 92 * 60 < track.period_s(iss) < 94 * 60
    perigee, apogee = track.apsides_km(iss)
    assert perigee == pytest.approx(iss.perigee_km)
    assert 400 < perigee <= apogee < 440


def test_validation_drops_unusable_satellites(catalog: list[Satellite]) -> None:
    good = catalog[0]
    broken = [
        Satellite.from_omm({**good.omm, "NORAD_CAT_ID": "90001", "ECCENTRICITY": "1.5"}, 2.0),
        Satellite.from_omm({**good.omm, "NORAD_CAT_ID": "90002", "MEAN_MOTION": "0"}, 2.0),
        Satellite.from_omm(
            {k: v for k, v in good.omm.items() if k != "INCLINATION"} | {"NORAD_CAT_ID": "90003"},
            2.0,
        ),
        # Not finite: SGP4 and the orbit's formulas take these without an error.
        Satellite.from_omm({**good.omm, "NORAD_CAT_ID": "90004", "MEAN_MOTION": "NaN"}, 2.0),
        Satellite.from_omm({**good.omm, "NORAD_CAT_ID": "90005", "ECCENTRICITY": "NaN"}, 2.0),
        Satellite.from_omm({**good.omm, "NORAD_CAT_ID": "90006", "INCLINATION": "NaN"}, 2.0),
        Satellite.from_omm({**good.omm, "NORAD_CAT_ID": "90007"}, math.nan),
        Satellite.from_omm({**good.omm, "NORAD_CAT_ID": "90008"}, -math.inf),
    ]
    kept, satrecs, dropped = validate([*catalog, *broken])
    assert kept == catalog
    assert len(satrecs) == len(catalog)
    assert dropped == [str(90001 + i) for i in range(8)]
    # The library predicts from what is left.
    observer = DENVER.values()
    assert group_transits(predict_transits(kept, *observer, start=START))


def _iss_from_the_fixture(reference: dict[str, Any]) -> Satellite:
    (fields,) = omm.parse_xml(io.StringIO(reference["elements_xml"]))
    return Satellite.from_omm(fields, -2.3, name="ISS")


@pytest.mark.parametrize("name", ["boston", "denver", "london", "sydney", "quito", "reykjavik"])
def test_geometry_matches_skyfield(reference: dict[str, Any], name: str) -> None:
    """Look angles, sub-points and the Sun agree with Skyfield (DE421) at random instants."""
    sat = _iss_from_the_fixture(reference)
    o = reference["observers"][name]
    observer = track.Observer(o["latitude"], o["longitude"], o["elevation_m"])
    instants = o["instants"]
    ts = np.array([item["time"] for item in instants])
    pos = track.propagate([sat.satrec()], ts)[0]
    azimuth, elevation, distance = track.look(observer, pos)
    lat, lon, alt = track.geodetic(pos)
    sun = track.sun_at(ts)
    _, sun_elevation, _ = track.look(observer, sun)
    lit = track.sunlit(pos, sun - pos)
    for i, item in enumerate(instants):
        assert _separation(azimuth[i], elevation[i], item["azimuth"], item["elevation"]) < 0.01
        assert distance[i] / 1000 == pytest.approx(item["range_km"], abs=0.5)
        assert lat[i] == pytest.approx(item["latitude"], abs=0.005)
        assert (lon[i] - item["longitude"] + 180) % 360 - 180 == pytest.approx(0, abs=0.005)
        assert alt[i] == pytest.approx(item["altitude_km"], abs=0.5)
        assert sun_elevation[i] == pytest.approx(item["sun_elevation"], abs=0.02)
        if bool(lit[i]) != item["sunlit"]:
            # Skyfield's Earth is a sphere; the website's ray must also clear
            # 15 km of atmosphere. They disagree only near the shadow's edge.
            near = track.propagate([sat.satrec()], ts[i] + np.array([-25.0, 25.0]))[0]
            edge = track.sunlit(near, track.sun_at(ts[i] + np.array([-25.0, 25.0])) - near)
            assert set(edge.tolist()) == {True, False}, (name, item["time"])


def _separation(az1: float, el1: float, az2: float, el2: float) -> float:
    a1, e1, a2, e2 = map(math.radians, (az1, el1, az2, el2))
    c = math.sin(e1) * math.sin(e2) + math.cos(e1) * math.cos(e2) * math.cos(a1 - a2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def test_unix_times() -> None:
    jd, fr = track.julian(np.array([0.0, 86400.5]))
    assert jd.tolist() == [2440587.5, 2440588.5]
    assert fr[1] == pytest.approx(0.5 / 86400)
    assert datetime(1970, 1, 1, tzinfo=UTC).timestamp() == 0
