"""The search for passes, the grouping, and the tables against the papers they come from."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import numpy as np
import pytest
from sgp4 import omm
from sgp4.api import Satrec

from custom_components.satellite_spotter import track
from custom_components.satellite_spotter.predict import (
    Flyover,
    Moment,
    Satellite,
    Sighting,
    cutoff_for,
    find_sightings,
    group_sightings,
    read_catalog,
    write_catalog,
)

from .common import DENVER, HONOLULU, NOW, satellites

START = NOW.replace(second=0) - timedelta(minutes=5)
HONOLULU_SKY = track.Observer(*HONOLULU.values())
DENVER_SKY = track.Observer(*DENVER.values())


def _sighting(sat: Satellite, start: datetime, seconds: int = 300, **changes: Any) -> Sighting:
    fields: dict[str, Any] = {
        "satellite": sat,
        "appears": Moment(start, 0.0, 10.0),
        "brightest": Moment(start + timedelta(seconds=seconds // 2), 90.0, 45.0),
        "vanishes": Moment(start + timedelta(seconds=seconds), 180.0, 10.0),
        "peak_magnitude": 2.0,
        "sky_limit": 4.0,
        "sun_up": False,
    }
    return Sighting(**(fields | changes))


def _sat(norad_id: int, name: str) -> Satellite:
    return Satellite.from_elements(
        {**satellites()[0].elements, "NORAD_CAT_ID": norad_id}, 2.0, name=name
    )


# --- The tables, against what they cite ---------------------------------------


def _dimming_at(zenith_distance: float, height_m: float = 0.0) -> float:
    observer = track.Observer(0.0, 0.0, height_m)
    return float(
        np.interp(
            np.radians(90 - zenith_distance), track._EXTINCTION_ELEVATIONS, observer.extinctions
        )
    )


@pytest.mark.parametrize(
    ("zenith_distance", "columns"),
    [
        (10, (0.32, 0.27, 0.23, 0.17, 0.14)),
        (45, (0.45, 0.37, 0.32, 0.24, 0.19)),
        (70, (0.93, 0.77, 0.65, 0.50, 0.40)),
        (80, (1.79, 1.49, 1.26, 0.96, 0.77)),
        (85, (3.28, 2.73, 2.32, 1.76, 1.41)),
        (90, (12.68, 10.56, 8.97, 6.80, 5.47)),
    ],
)
def test_extinction_is_green_1992_table_ic(
    zenith_distance: float, columns: tuple[float, ...]
) -> None:
    """Every height, "summer": http://www.icq.eps.harvard.edu/ICQExtinct.html."""
    for height_m, dimming in zip((0, 500, 1000, 2000, 3000), columns, strict=True):
        assert _dimming_at(zenith_distance, height_m) == pytest.approx(dimming)


def test_extinction_between_and_beyond_the_tables_heights() -> None:
    assert _dimming_at(80, 1500) == pytest.approx((1.26 + 0.96) / 2)
    # Higher than the table goes, or below sea level: its nearest column.
    assert _dimming_at(80, 5000) == pytest.approx(0.77)
    assert _dimming_at(80, -400) == pytest.approx(1.79)


def test_extinction_is_used_from_the_observers_height() -> None:
    """Straight up, 1000 km away, fully lit: only the air differs."""
    sat = Satellite.from_elements(satellites()[0].elements, 3.0)
    for height_m, dimming in ((0.0, 0.32), (2000.0, 0.17)):
        observer = track.Observer(0.0, 0.0, height_m)
        position = (observer.position + 1e6 * observer.normal)[None, :]
        sun = position - 1e11 * observer.normal
        assert track.photometry(sat, observer, position, sun).magnitude[0] == pytest.approx(
            3.0 - 2.5 * np.log10(2) + dimming
        )


@pytest.mark.parametrize(
    ("sun_zenith_distance", "lowest", "highest"),
    [(50, -3.5, -2.5), (90, -1.6, -0.8), (95.2, 0.5, 1.5), (97.5, 2.5, 3.5), (100, 3.7, 4.3)],
)
def test_sky_limit_follows_weaver_1947_figure_2(
    sun_zenith_distance: float, lowest: float, highest: float
) -> None:
    """Read off the figure, as far as a figure can be read."""
    limit = float(track.limiting_magnitude(np.radians(sun_zenith_distance)))
    assert lowest <= limit <= highest


def test_sky_limit_keeps_to_the_two_departures_from_weaver() -> None:
    """Brighter in full daylight than the figure's -3.2, and no fainter than 4 in the dark."""
    assert float(track.limiting_magnitude(np.radians(0.0))) == -4.0
    assert float(track.limiting_magnitude(np.radians(150.0))) == 4.0


@pytest.mark.parametrize(
    ("model", "phase", "at_1000km"),
    [
        # Mallama et al. 2025, table 1: 3.365 + 0.06376 a - 1.716e-4 a^2 - 1.139e-6 a^3.
        ("starlink-dtc", 90.0, 3.365 + 5.7384 - 1.38996 - 0.83033),
        # The same, moved by the means at 1000 km: 6.47 in mitigation, 4.58 while raising.
        ("starlink-raising", 90.0, 3.365 + 5.7384 - 1.38996 - 0.83033 - 1.89),
        # Outside the phase angles it was fitted to, it holds the nearest.
        ("starlink-dtc", 170.0, 3.365 + 9.8828 - 4.12271 - 4.24158),
    ],
)
def test_starlink_models(model: str, phase: float, at_1000km: float) -> None:
    magnitude = track._starlink_at_1000_km(model, np.array([phase]))
    assert magnitude[0] == pytest.approx(at_1000km, abs=1e-3)


def test_the_standard_magnitude_is_for_half_lit() -> None:
    """At the reference distance: as it says at phase 90, and twice the light at phase 0."""
    sat = Satellite.from_elements(satellites()[0].elements, 3.0)
    # The satellite straight up, 1000 km away, and the Sun far off.
    observer = track.Observer(0.0, 0.0)
    up = observer.normal
    position = (observer.position + 1e6 * up)[None, :]
    behind = position - 1e11 * up
    aside = position + 1e11 * observer.east
    full = track.photometry(sat, observer, position, behind).magnitude[0]
    half = track.photometry(sat, observer, position, aside).magnitude[0]
    zenith = float(observer.extinctions[-1])
    assert half == pytest.approx(3.0 + zenith)
    assert full == pytest.approx(3.0 + zenith - 2.5 * np.log10(2))


# --- The search ---------------------------------------------------------------


def _every_visible_second(sat: Satellite, observer: track.Observer, days: float) -> np.ndarray:
    first = START.timestamp()
    ts = first + np.arange(0.0, days * 86400)
    pos = track.propagate([sat.sgp4_record()], ts)[0]
    with np.errstate(invalid="ignore"):
        return ts[track.visible(track.photometry(sat, observer, pos, track.sun_at(ts)), 3.0)]


@pytest.mark.parametrize("norad_id", [25544, 39679, 53807])
def test_finds_what_checking_every_second_finds(norad_id: int) -> None:
    """The once-a-minute search misses nothing worth listing, and the passes are exact."""
    sat = next(s for s in satellites() if s.norad_id == norad_id)
    expected = _every_visible_second(sat, HONOLULU_SKY, 5)
    found = find_sightings([sat], HONOLULU_SKY, start=START, faintest=3.0)
    listed = np.concatenate(
        [np.arange(t.appears.time.timestamp(), t.vanishes.time.timestamp()) for t in found]
        or [np.array([])]
    )
    assert set(listed) <= set(expected)
    # Only what falls between the search's samples can be left out: under a minute at a time.
    missing = np.setdiff1d(expected, listed)
    stretches = np.split(missing, np.flatnonzero(np.diff(missing) > 1) + 1)
    assert all(len(stretch) < 60 for stretch in stretches)


def test_pass_times_do_not_depend_on_when_the_search_began() -> None:
    """The same pass has the same id, whichever two-hourly run found it."""
    catalog = satellites()
    first = find_sightings(catalog, HONOLULU_SKY, start=START, days=2)
    # Half a minute out of step, so every once-a-minute sample falls somewhere else.
    later = find_sightings(
        catalog, HONOLULU_SKY, start=START + timedelta(minutes=17, seconds=30), days=2
    )

    def times(found: list[Sighting], since: datetime) -> set[tuple[int, datetime, datetime]]:
        # Those under a minute can fall between the samples of either search.
        return {
            (s.satellite.norad_id, s.appears.time, s.vanishes.time)
            for s in found
            if s.appears.time > since and s.vanishes.time - s.appears.time >= timedelta(minutes=1)
        }

    since = START + timedelta(minutes=20)
    assert times(first, since) - times(later, since) == set()


def test_sorted_with_the_catalogs_order_breaking_ties() -> None:
    catalog = satellites()
    sightings = find_sightings(catalog, DENVER_SKY, start=START)
    order = {id(s): i for i, s in enumerate(catalog)}
    keys = [(t.appears.time, order[id(t.satellite)]) for t in sightings]
    assert sightings and keys == sorted(keys)


@pytest.mark.parametrize("height_m", [0.0, 3000.0])
def test_never_brighter_than_the_bound(height_m: float) -> None:
    """The bound decides who is searched, so it must really be a bound, from any height."""
    observer = track.Observer(DENVER_SKY.latitude, DENVER_SKY.longitude, height_m)
    for sat in satellites():
        bound = track.brightest_possible(sat, observer)
        for t in find_sightings([sat], observer, start=START, faintest=9.0):
            assert t.peak_magnitude >= bound


def test_the_bound_allows_for_thinner_air() -> None:
    """Otherwise a mountain would skip satellites it can see, however clear its sky."""
    sat = satellites()[0]
    sea_level = track.brightest_possible(sat, track.Observer(0.0, 0.0, 0.0))
    high = track.brightest_possible(sat, track.Observer(0.0, 0.0, 3000.0))
    assert sea_level - high == pytest.approx(0.32 - 0.14)


def test_a_higher_site_sees_more_and_brighter() -> None:
    """The same place and sky through less air, which is all that height changes here."""
    catalog = satellites()
    latitude, longitude = DENVER_SKY.latitude, DENVER_SKY.longitude
    low = find_sightings(catalog, track.Observer(latitude, longitude, 0.0), start=START)
    high = find_sightings(catalog, track.Observer(latitude, longitude, 3000.0), start=START)
    assert len(high) > len(low)
    for t in low:
        same = next(
            h
            for h in high
            if h.satellite.norad_id == t.satellite.norad_id
            and h.appears.time <= t.vanishes.time
            and t.appears.time <= h.vanishes.time
        )
        assert same.peak_magnitude < t.peak_magnitude
        assert (
            same.vanishes.time - same.appears.time
            >= t.vanishes.time - t.appears.time - timedelta(seconds=5)
        )


def test_a_satellite_with_no_brightness_is_skipped() -> None:
    sat = Satellite.from_elements(satellites()[0].elements, None)
    assert track.brightest_possible(sat, DENVER_SKY) == float("inf")
    assert find_sightings([sat], DENVER_SKY, start=START) == []


def test_fainter_cutoff_finds_more() -> None:
    catalog = satellites()
    strict = find_sightings(catalog, DENVER_SKY, start=START, faintest=1.0)
    relaxed = find_sightings(catalog, DENVER_SKY, start=START, faintest=4.0)
    assert len(strict) < len(relaxed)
    assert all(t.peak_magnitude < 1.0 for t in strict)


def test_a_pass_cut_off_by_the_end_of_the_search_is_left_for_the_next_run() -> None:
    sat = next(s for s in satellites() if s.norad_id == 53807)
    first = find_sightings([sat], DENVER_SKY, start=START)[0]
    during = (
        first.appears.time + (first.vanishes.time - first.appears.time) / 2 - START
    ).total_seconds() / 86400
    cut = find_sightings([sat], DENVER_SKY, start=START, days=during)
    assert first.appears.time not in {t.appears.time for t in cut}


def test_a_pass_under_way_begins_at_the_start_of_the_search() -> None:
    sat = next(s for s in satellites() if s.norad_id == 53807)
    long = next(
        t
        for t in find_sightings([sat], DENVER_SKY, start=START)
        if t.vanishes.time - t.appears.time > timedelta(minutes=3)
    )
    during = long.appears.time.replace(second=0) + timedelta(minutes=2)
    (now, *_) = find_sightings([sat], DENVER_SKY, start=during)
    assert now.appears.time == during
    assert now.vanishes.time == long.vanishes.time


def test_elements_that_stop_working_cost_only_their_satellite() -> None:
    """SGP4 fails partway for a decaying orbit; the others are still predicted."""
    catalog = satellites()
    good = len(find_sightings(catalog, DENVER_SKY, start=START))
    dying = Satellite.from_elements(
        {**catalog[0].elements, "NORAD_CAT_ID": 90001, "MEAN_MOTION": "17.5", "BSTAR": "0.5"}, 2.0
    )
    assert len(find_sightings([*catalog, dying], DENVER_SKY, start=START)) >= good


def test_temporary_catalog_numbers_can_be_propagated() -> None:
    """New launches have nine-digit numbers, which SGP4's records have no room for."""
    fields = {**satellites()[0].elements, "NORAD_CAT_ID": "799501755"}
    sat = Satellite.from_elements(fields, 2.0)
    assert sat.norad_id == 799501755
    assert np.isfinite(track.propagate([sat.sgp4_record()], np.array([NOW.timestamp()]))).all()


# --- Grouping -----------------------------------------------------------------


def test_passes_a_minute_apart_are_one_group_and_longer_are_not() -> None:
    a, b, c = _sat(1, "A"), _sat(2, "B"), _sat(3, "C")
    groups = group_sightings(
        [
            _sighting(c, NOW + timedelta(seconds=361 + 61 + 300)),
            _sighting(a, NOW),
            # Starts 60 seconds after A ends: still together.
            _sighting(b, NOW + timedelta(seconds=360)),
        ]
    )
    assert [[t.satellite.name for t in g.sightings] for g in groups] == [["A", "B"], ["C"]]


def test_a_group_ends_with_its_last_satellite_not_its_first() -> None:
    a, b, c = _sat(1, "A"), _sat(2, "B"), _sat(3, "C")
    groups = group_sightings(
        [
            _sighting(a, NOW, seconds=600),
            _sighting(b, NOW + timedelta(seconds=10), seconds=20),
            _sighting(c, NOW + timedelta(seconds=650)),
        ]
    )
    assert len(groups) == 1
    assert groups[0].end == NOW + timedelta(seconds=950)


def test_a_flyover_takes_the_extremes_of_its_sightings() -> None:
    a, b = _sat(1, "A"), _sat(2, "B")
    group = Flyover(
        [
            _sighting(a, NOW, peak_magnitude=2.0, sky_limit=4.0, sun_up=True),
            _sighting(b, NOW, peak_magnitude=0.5, sky_limit=3.0),
        ]
    )
    assert (group.peak_magnitude, group.sky_limit, group.sun_up) == (0.5, 3.0, True)
    assert group.count == 2
    assert group.lead.satellite.name == "B"


def test_a_flyover_is_named_after_its_brightest_satellite() -> None:
    """What is reported of a flyover is true of the satellite it names."""
    group = Flyover(
        [
            _sighting(_sat(1, "STARLINK-1"), NOW, peak_magnitude=2.2),
            _sighting(_sat(2, "Tiangong"), NOW + timedelta(seconds=30), peak_magnitude=-2.1),
            _sighting(_sat(3, "STARLINK-3"), NOW + timedelta(seconds=60), peak_magnitude=2.4),
        ]
    )
    assert group.title == "Tiangong +2"
    assert group.lead.peak_magnitude == group.peak_magnitude == -2.1
    # The rest stay in order of appearance, and the flyover still starts with the first.
    names = [sighting.satellite.name for sighting in group.sightings]
    assert names == ["Tiangong", "STARLINK-1", "STARLINK-3"]
    assert group.start == NOW


def test_the_first_to_appear_names_a_flyover_of_equals() -> None:
    group = Flyover(
        [
            _sighting(_sat(1, "A"), NOW, peak_magnitude=1.0),
            _sighting(_sat(2, "B"), NOW + timedelta(seconds=30), peak_magnitude=1.0),
        ]
    )
    assert group.title == "A +1"


def test_a_lone_satellite_is_just_its_name() -> None:
    assert Flyover([_sighting(_sat(1, "ISS"), NOW)]).title == "ISS"


@pytest.mark.parametrize("name", ["Starlink 1 B", "STARLINK-1234"])
def test_stray_starlinks_are_dropped_and_a_train_is_kept(name: str) -> None:
    starlinks = [_sat(100 + i, f"{name}{i}") for i in range(5)]
    other = _sat(1, "HST")

    alone = group_sightings([_sighting(starlinks[0], NOW)])
    assert alone == []

    together = group_sightings([_sighting(other, NOW), _sighting(starlinks[0], NOW)])
    assert [[t.satellite.name for t in g.sightings] for g in together] == [["HST"]]

    four = group_sightings([_sighting(s, NOW) for s in starlinks[:4]])
    assert four == []

    train = group_sightings([_sighting(other, NOW)] + [_sighting(s, NOW) for s in starlinks])
    assert train[0].count == 6


def test_dropping_starlinks_redoes_the_group() -> None:
    """A Starlink's end or brightness says nothing about what is left."""
    other, starlink = _sat(1, "HST"), _sat(100, "STARLINK-1")
    (group,) = group_sightings(
        [_sighting(other, NOW), _sighting(starlink, NOW, seconds=900, peak_magnitude=-1.0)]
    )
    assert group.end == NOW + timedelta(seconds=300)
    assert group.peak_magnitude == 2.0


@pytest.mark.parametrize(
    ("changes", "bright"),
    [
        ({"peak_magnitude": 0.4}, True),
        # Not brighter than magnitude 0.5.
        ({"peak_magnitude": 0.5}, False),
        # Not 3 magnitudes clear of what the sky shows.
        ({"peak_magnitude": 0.4, "sky_limit": 3.3}, False),
        ({"peak_magnitude": 0.4, "sun_up": True}, False),
    ],
)
def test_bright(changes: dict[str, Any], bright: bool) -> None:
    assert Flyover([_sighting(_sat(1, "A"), NOW, **changes)]).bright is bright


# --- The stored catalog -------------------------------------------------------


def test_catalog_survives_storage() -> None:
    catalog = satellites()
    again = read_catalog(write_catalog(catalog))
    assert [(s.norad_id, s.name, s.standard_magnitude, s.curve, s.epoch) for s in again] == [
        (s.norad_id, s.name, s.standard_magnitude, s.curve, s.epoch) for s in catalog
    ]


def test_starlink_model_without_a_magnitude_survives_storage() -> None:
    sat = Satellite.from_elements(
        satellites()[0].elements, curve="starlink-raising", name="STARLINK-1"
    )
    (again,) = read_catalog(write_catalog([sat]))
    assert (again.standard_magnitude, again.curve, again.name) == (
        None,
        "starlink-raising",
        "STARLINK-1",
    )


# --- Starlinks ----------------------------------------------------------------


def test_starlinks_are_listed_past_the_cutoff() -> None:
    assert cutoff_for(_sat(2, "STARLINK-1"), 2.25) == 3.0
    assert cutoff_for(_sat(1, "SOME SAT"), 2.25) == 2.25


def test_the_search_keeps_to_the_starlink_cutoff() -> None:
    """A Starlink's sightings at a cutoff are those of anything else at 0.75 fainter."""
    elements = next(s for s in satellites() if s.norad_id == 53807).elements
    starlink = Satellite.from_elements(elements, curve="starlink-raising", name="STARLINK-1")
    found = find_sightings([starlink], DENVER_SKY, start=START, faintest=2.25)
    assert found
    assert all(t.peak_magnitude < 3.0 for t in found)
    assert any(t.peak_magnitude >= 2.25 for t in found)


def test_the_sgp4_record_is_the_one_its_own_reader_builds() -> None:
    """The elements go straight to sgp4init; sgp4's reader for them must agree on every number."""
    fields = (
        "jdsatepoch", "jdsatepochF", "bstar", "ndot", "nddot", "ecco",
        "argpo", "inclo", "mo", "no_kozai", "nodeo", "satnum",
    )  # fmt: skip
    for sat in satellites():
        record = sat.sgp4_record()
        theirs = Satrec()
        omm.initialize(
            theirs,
            {
                "CLASSIFICATION_TYPE": "U",
                "OBJECT_ID": "",
                "ELEMENT_SET_NO": "0",
                "REV_AT_EPOCH": "0",
                "EPHEMERIS_TYPE": "0",
                **sat.elements,
                "EPOCH": sat.epoch.strftime("%Y-%m-%dT%H:%M:%S.%f"),
            },
        )
        for field in fields:
            assert getattr(record, field) == pytest.approx(
                getattr(theirs, field), rel=1e-14, abs=1e-30
            ), (sat.name, field)


def test_a_temporary_number_is_left_out_of_the_record() -> None:
    elements = {**satellites()[0].elements, "NORAD_CAT_ID": "270123456"}
    assert Satellite.from_elements(elements, 2.0).sgp4_record().satnum == 0
