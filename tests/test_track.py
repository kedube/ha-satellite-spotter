"""track.py: what predict.py finds is what is drawn, and its geometry against Skyfield."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
import io
import math
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest
from sgp4 import omm
from sgp4.propagation import gstime

from custom_components.satellite_spotter import track
from custom_components.satellite_spotter.catalog import validate
from custom_components.satellite_spotter.predict import (
    Satellite,
    find_sightings,
    group_sightings,
)

from .common import DENVER, HONOLULU, NOW, satellites

PLACES = {
    "honolulu": tuple(HONOLULU.values()),
    "denver": tuple(DENVER.values()),
    "sydney": (-33.87, 151.21, 58.0),
}
START = NOW.replace(second=0) - timedelta(minutes=5)


@pytest.fixture(scope="module")
def catalog() -> list[Satellite]:
    return satellites()


@pytest.fixture(scope="module", params=sorted(PLACES))
def place(request: pytest.FixtureRequest) -> tuple[str, track.Observer]:
    return request.param, track.Observer(*PLACES[request.param])


@pytest.fixture(scope="module")
def sightings(catalog: list[Satellite], place: tuple[str, track.Observer]) -> list[Any]:
    _, observer = place
    return find_sightings(catalog, observer, start=START)


def _samples(sat: Satellite, start: float, end: float, step: float = 1.0) -> tuple[Any, Any, Any]:
    ts = np.arange(start, end, step)
    pos = track.propagate([sat.sgp4_record()], ts)[0]
    return ts, pos, track.sun_at(ts)


def test_visible_windows_match_the_predictions(
    place: tuple[str, track.Observer], sightings: list[Any]
) -> None:
    """What is drawn and what is listed come from the same sums: to the second."""
    name, observer = place
    assert sightings
    for t in sightings:
        start, end = t.appears.time.timestamp(), t.vanishes.time.timestamp()
        ts, pos, sun = _samples(t.satellite, start, end)
        ph = track.photometry(t.satellite, observer, pos, sun)
        assert track.visible(ph, 3.0).all(), (name, t.satellite.name)
        assert ph.magnitude.min() == pytest.approx(t.peak_magnitude), (name, t.satellite.name)
        assert ts[np.argmin(ph.magnitude)] == t.brightest.time.timestamp()


def test_sighting_shapes(place: tuple[str, track.Observer], sightings: list[Any]) -> None:
    """The highest point and why each window begins and ends."""
    _, observer = place
    for t in sightings:
        fallback = track.SkyPoint(0.0, 0.0, 0.0)
        shape = track.sighting_shape(
            t.satellite, observer, t.appears.time.timestamp(), t.vanishes.time.timestamp(), fallback
        )
        assert t.appears.time.timestamp() <= shape.peak.time < t.vanishes.time.timestamp()
        assert shape.peak.elevation >= max(t.appears.elevation, t.vanishes.elevation, 10) - 0.5
        assert shape.peak.elevation >= t.brightest.elevation - 0.5
        # The second before the pass, and the one that ends it.
        _, pos, sun = _samples(
            t.satellite, t.appears.time.timestamp() - 1, t.vanishes.time.timestamp() + 1
        )
        _, el, _ = track.look(observer, pos)
        lit = track.sunlit(pos, sun - pos)
        for reason, outside, horizon in (
            (shape.start_reason, 0, "rise"),
            (shape.end_reason, -1, "set"),
        ):
            if reason == horizon:
                assert el[outside] < 10
            elif reason == "shadow":
                assert el[outside] >= 10 and not lit[outside]
            else:
                assert reason == "sky"
                assert el[outside] >= 10 and lit[outside]


def test_the_formula_is_mmts_definition_run_backwards(catalog: list[Satellite]) -> None:
    """A standard magnitude is for 1000 km and half lit, so 2.5 log10(1 + cos phase) of phase."""
    sat = replace(catalog[0], standard_magnitude=3.0, curve=None)
    observer = track.Observer(*PLACES["denver"])
    seconds = START.timestamp() + np.arange(0.0, 86400.0, 60.0)
    places = track.propagate([sat.sgp4_record()], seconds)[0]
    sun = track.sun_at(seconds)
    light = track.photometry(sat, observer, places, sun)

    to_sat = places - observer.position
    to_sun = sun - places
    cos_phase = np.einsum("ij,ij->i", -to_sat, to_sun) / (
        np.linalg.norm(to_sat, axis=-1) * np.linalg.norm(to_sun, axis=-1)
    )
    air = np.interp(light.elevation, track._EXTINCTION_ELEVATIONS, observer.extinctions)
    expected = 3.0 + 5 * np.log10(light.distance / 1e6) - 2.5 * np.log10(1 + cos_phase) + air
    assert light.magnitude == pytest.approx(expected)


def test_reasons_cover_every_case(catalog: list[Satellite]) -> None:
    """Satellites rise into view, leave Earth's shadow, set and fade into it."""
    seen: set[tuple[str, str]] = set()
    for lat, lon, elev in PLACES.values():
        observer = track.Observer(lat, lon, elev)
        # With a fainter cutoff, as few are bright enough to show low down.
        for t in find_sightings(catalog, observer, start=START, faintest=6.0):
            shape = track.sighting_shape(
                t.satellite, observer, t.appears.time.timestamp(), t.vanishes.time.timestamp(),
                track.SkyPoint(0.0, 0.0, 0.0),
            )  # fmt: skip
            seen |= {("start", shape.start_reason), ("end", shape.end_reason)}
    assert seen >= {("start", "rise"), ("start", "shadow"), ("start", "sky"),
                    ("end", "shadow"), ("end", "sky")}  # fmt: skip


def test_pass_track_rows(catalog: list[Satellite]) -> None:
    observer = track.Observer(*PLACES["honolulu"])
    t = next(
        t for t in find_sightings(catalog, observer, start=START) if t.satellite.norad_id == 25544
    )
    start, end = t.appears.time.timestamp(), t.vanishes.time.timestamp()
    sky = track.pass_track(t.satellite, observer, start, end, 1.0, 2.25)
    assert sky is not None
    rows = sky.rows
    # Horizon to horizon (about ten minutes for the station), one second apart.
    assert 400 < len(rows) < 800
    assert rows[0][6] < 0 < rows[1][6] and rows[-1][6] < 0 < rows[-2][6]
    assert (sky.horizon_rise, sky.horizon_set) == (rows[0][0], rows[-1][0])
    shown = [row[0] for row in rows if row[9]]
    assert abs(shown[0] - start) <= 5 and abs(shown[-1] + 1 - end) <= 5
    # Sub-points and heights match the ground track of the same instants.
    ground = track.ground_rows(t.satellite.sgp4_record(), np.array([row[0] for row in rows[::50]]))
    for g, row in zip(ground, rows[::50], strict=True):
        assert g == row[:5]


def test_positions_and_shared_propagators(catalog: list[Satellite]) -> None:
    """All satellites at once place each as alone, and leave the shared records untouched."""
    satrecs = [s.sgp4_record() for s in catalog]
    before = [(r.t, r.error, r.no_kozai) for r in satrecs]
    ts = NOW.timestamp() + np.arange(0, 601, 60.0)
    many = track.positions(satrecs, ts)
    assert many.ok.all()
    assert [(r.t, r.error, r.no_kozai) for r in satrecs] == before
    for i, sat in enumerate(catalog):
        one = track.ground_rows(sat.sgp4_record(), ts)
        assert [row[1] for row in one] == pytest.approx(many.latitude[i].tolist(), abs=1e-4)
        assert [row[3] for row in one] == pytest.approx(many.altitude_km[i].tolist(), abs=0.05)
        assert [row[4] for row in one] == many.lit[i].astype(int).tolist()


def test_orbits(catalog: list[Satellite]) -> None:
    iss = next(s for s in catalog if s.norad_id == 25544)
    assert 92 * 60 < track.period_s(iss) < 94 * 60
    perigee, apogee = track.apsides_km(iss)
    assert 400 < perigee <= apogee < 440


def test_validation_drops_unusable_satellites(catalog: list[Satellite]) -> None:
    good = catalog[0]
    broken = [
        Satellite.from_elements(
            {**good.elements, "NORAD_CAT_ID": "90001", "ECCENTRICITY": "1.5"}, 2.0
        ),
        Satellite.from_elements(
            {**good.elements, "NORAD_CAT_ID": "90002", "MEAN_MOTION": "0"}, 2.0
        ),
        Satellite.from_elements(
            {k: v for k, v in good.elements.items() if k != "INCLINATION"}
            | {"NORAD_CAT_ID": "90003"},
            2.0,
        ),
        # Not finite: SGP4 and the orbit's formulas take these without an error.
        Satellite.from_elements(
            {**good.elements, "NORAD_CAT_ID": "90004", "MEAN_MOTION": "NaN"}, 2.0
        ),
        Satellite.from_elements(
            {**good.elements, "NORAD_CAT_ID": "90005", "ECCENTRICITY": "NaN"}, 2.0
        ),
        Satellite.from_elements(
            {**good.elements, "NORAD_CAT_ID": "90006", "INCLINATION": "NaN"}, 2.0
        ),
        Satellite.from_elements({**good.elements, "NORAD_CAT_ID": "90007"}, math.nan),
        Satellite.from_elements({**good.elements, "NORAD_CAT_ID": "90008"}, -math.inf),
    ]
    kept, satrecs, dropped = validate([*catalog, *broken])
    assert kept == catalog
    assert len(satrecs) == len(catalog)
    assert dropped == [str(90001 + i) for i in range(8)]
    # Predictions carry on from what is left.
    assert group_sightings(find_sightings(kept, track.Observer(*DENVER.values()), start=START))


def _iss_from_the_fixture(reference: dict[str, Any]) -> Satellite:
    (fields,) = omm.parse_xml(io.StringIO(reference["elements_xml"]))
    return Satellite.from_elements(fields, -2.3, name="ISS")


@pytest.mark.parametrize("name", ["boston", "denver", "london", "sydney", "quito", "reykjavik"])
def test_geometry_matches_skyfield(reference: dict[str, Any], name: str) -> None:
    """Look angles, sub-points and the Sun agree with Skyfield (DE421) at random instants."""
    sat = _iss_from_the_fixture(reference)
    o = reference["observers"][name]
    observer = track.Observer(o["latitude"], o["longitude"], o["elevation_m"])
    instants = o["instants"]
    ts = np.array([item["time"] for item in instants])
    pos = track.propagate([sat.sgp4_record()], ts)[0]
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
            # Skyfield's Earth is a sphere; here the ray must also clear
            # 15 km of atmosphere. They disagree only near the shadow's edge.
            near = track.propagate([sat.sgp4_record()], ts[i] + np.array([-25.0, 25.0]))[0]
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


def test_sidereal_time_is_the_one_sgp4_uses() -> None:
    ts = NOW.timestamp() + np.arange(0, 4 * 365 * 86400, 86400 * 3.37)
    theirs = np.array([gstime(jd + fr) for jd, fr in zip(*track.julian(ts), strict=True)])
    # Compared round the circle: 1e-8 radians is 6 cm at the equator.
    difference = (track._earth_turned(ts) - theirs + math.pi) % math.tau - math.pi
    assert np.abs(difference).max() < 1e-8


def test_turning_with_the_earth() -> None:
    inertial = np.array([[1.0, 0.0, 5.0], [0.0, 2.0, -5.0], [np.nan, np.nan, np.nan]])
    turned = track._earth_fixed(inertial, np.array([math.pi / 2, math.pi / 2, 1.0]))
    # The Earth turns east, so what stands still in space moves west over the ground.
    assert turned[0] == pytest.approx([0.0, -1.0, 5.0])
    assert turned[1] == pytest.approx([2.0, 0.0, -5.0])
    assert np.isnan(turned[2]).all()


def test_the_sun_matches_the_worked_example_in_its_source() -> None:
    """Meeus 1998, example 25.a, for 1992 October 13 at 0h: longitude 199.90988, 0.99766 AU."""
    ts = np.array([datetime(1992, 10, 13, tzinfo=UTC).timestamp()])
    x, y, z = track._earth_fixed(track.sun_at(ts), -track._earth_turned(ts))[0]
    # Back onto the ecliptic, by the example's date's mean obliquity.
    tilt = math.radians(23.4402298)
    longitude = math.degrees(math.atan2(y * math.cos(tilt) + z * math.sin(tilt), x))
    assert longitude % 360 == pytest.approx(199.90988 - 0.00569, abs=1e-4)
    assert math.sqrt(x * x + y * y + z * z) / track._METRES_PER_AU == pytest.approx(
        0.99766, abs=1e-5
    )


# Sunlight along +x, past a point this far behind the Earth's centre.
BEHIND = -7_000_000.0
SUN = np.array([[1e11, 0.0, 0.0]])
AIR = track._SUNLIGHT_CLEARS_M


@pytest.mark.parametrize(
    ("position", "lit"),
    [
        # Past the equator and past the pole, which is nearer the centre: clear of the
        # air that stops sunlight, or just inside it.
        ((BEHIND, track._EQUATOR_M + AIR + 1000, 0.0), True),
        ((BEHIND, track._EQUATOR_M + AIR - 1000, 0.0), False),
        ((BEHIND, 0.0, track._POLE_M + AIR + 1000), True),
        ((BEHIND, 0.0, track._POLE_M + AIR - 1000), False),
        # Straight behind the Earth, and straight in front of it.
        ((BEHIND, 0.0, 0.0), False),
        ((7_000_000.0, 0.0, 0.0), True),
        # Off to the side but sunward of the centre: the line leads away from the Earth.
        ((1000.0, track._EQUATOR_M + AIR + 1, 0.0), True),
        # Within the air itself, on the sunward side.
        ((track._EQUATOR_M + AIR - 1000, 0.0, 0.0), False),
    ],
)
def test_sunlight(position: tuple[float, float, float], lit: bool) -> None:
    point = np.array([position])
    assert track.sunlit(point, SUN - point).tolist() == [lit]


def test_sunlight_for_many_satellites_at_many_times() -> None:
    points = np.array([[[BEHIND, 0.0, 0.0], [7_000_000.0, 0.0, 0.0]]] * 3)
    assert track.sunlit(points, SUN - points).shape == (3, 2)
    assert not track.sunlit(np.array([[np.nan, 0.0, 0.0]]), SUN).any()


def test_satellite_position_says_where_a_satellite_is() -> None:
    sat = next(s for s in satellites() if s.norad_id == 25544)
    observer = track.Observer(*HONOLULU.values())
    when = NOW.timestamp()
    place = track.propagate([sat.sgp4_record()], [when])[0]
    azimuth, elevation, distance = track.look(observer, place)
    position = track.satellite_position(sat, observer, when)
    assert position is not None
    latitude, longitude, altitude = track.geodetic(place[0])
    assert position.latitude == pytest.approx(float(latitude))
    assert position.longitude == pytest.approx(float(longitude))
    assert position.altitude_km == pytest.approx(float(altitude))
    assert position.azimuth == pytest.approx(float(azimuth[0]))
    assert position.elevation == pytest.approx(float(elevation[0]))
    assert position.range_km == pytest.approx(float(distance[0]) / 1000.0)
    assert isinstance(position.sunlit, bool)


def test_the_position_of_a_satellite_sgp4_cannot_place_is_none() -> None:
    sat = next(s for s in satellites() if s.norad_id == 25544)
    observer = track.Observer(*HONOLULU.values())
    with patch.object(track, "propagate", return_value=np.full((1, 1, 3), np.nan)):
        assert track.satellite_position(sat, observer, NOW.timestamp()) is None
