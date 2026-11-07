"""The websocket API the panel and the cards use: every command, its payload, limits and errors."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
import itertools
import json
from typing import Any
from unittest.mock import AsyncMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryDisabler, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter import track
from custom_components.satellite_spotter.catalog import async_shared_catalog
from custom_components.satellite_spotter.celestrak import CatalogError
from custom_components.satellite_spotter.const import (
    CONF_GOOGLE_API_KEY,
    CONF_MAPILLARY_TOKEN,
    CONF_STREET_SOURCE,
    CONF_STREET_VIEW,
    DOMAIN,
    PASS_TRACK_MAX_STEP,
    POSITIONS_BURST,
    POSITIONS_REFILL_SECONDS,
    TRACK_EPOCH_RANGE,
)
from custom_components.satellite_spotter.coordinator import ListedPass
from custom_components.satellite_spotter.entity import compass
from custom_components.satellite_spotter.frontend import (
    DATA_FRONTEND,
    _number,
    build_passes_payload,
    pass_json,
    pass_track_payload,
    positions_json,
    track_step,
)
from custom_components.satellite_spotter.predict import Sighting

from .common import (
    DENVER,
    FIRST_PASS_ID,
    HONOLULU,
    NOW,
    add_location,
    advance,
    cloud_percent,
    listed,
    sighting,
)

DIRECTIONS = {compass(22.5 * i) for i in range(16)}
PASS_KEYS = {
    "id", "title", "kind", "start", "end", "duration", "magnitude", "bright", "rating", "sun_up",
    "cloud_cover", "satellite_count", "train", "peak", "transits",
}  # fmt: skip
TRANSIT_KEYS = {
    "norad_id", "name", "kind", "start", "end", "magnitude", "brightest_time", "rise",
    "brightest", "set", "peak", "start_reason", "end_reason",
    "period_s", "about_url", "confidence",
}  # fmt: skip
KINDS = {"iss", "tiangong", "hubble", "starlink", "rocket", "debris", "satellite"}


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    """Set the clock before the fixtures that sign in, so their tokens are valid then."""
    freezer.move_to(NOW)


@pytest.fixture
async def ws(hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client) -> Any:
    """Send a command, return the whole reply."""
    client = await hass_ws_client(hass)

    async def send(kind: str, **fields: Any) -> dict[str, Any]:
        await client.send_json_auto_id({"type": f"{DOMAIN}/{kind}", **fields})
        return await client.receive_json()

    return send


def _rows_are_whole_seconds(rows: list[list[Any]]) -> bool:
    return all(isinstance(row[0], int) for row in rows)


def _no_negative_zero(value: Any) -> bool:
    if isinstance(value, dict):
        return all(_no_negative_zero(v) for v in value.values())
    if isinstance(value, list):
        return all(_no_negative_zero(v) for v in value)
    return not (isinstance(value, float) and value == 0 and repr(value) == "-0.0")


async def test_locations(ws: Any, init_integration: MockConfigEntry) -> None:
    msg = await ws("locations")
    assert msg["result"] == [
        {"entry_id": init_integration.entry_id, "title": "Home", "show_in_sidebar": True}
    ]


async def test_passes(hass: HomeAssistant, ws: Any, init_integration: MockConfigEntry) -> None:
    msg = await ws("passes", entry_id=init_integration.entry_id)
    assert msg["success"], msg
    result = msg["result"]
    coordinator = init_integration.runtime_data
    # The pure builder, as the development fixtures use it.
    assert result == build_passes_payload(coordinator, NOW)

    assert result["generated_at"] == int(NOW.timestamp())
    assert result["server_time"] == NOW.timestamp()
    assert (result["paused"], result["paused_days"], result["paused_error"]) == (None,) * 3
    assert result["location"] == {
        "entry_id": init_integration.entry_id,
        "title": "Home",
        **HONOLULU,
    }
    assert result["settings"] == {
        "units": "auto",
        "days": 5,
        "min_elevation": 10,
    }
    catalog = result["catalog"]
    assert catalog["updated"] == int(NOW.timestamp())
    assert catalog["version"] == int(NOW.timestamp())
    assert catalog["satellites"] == 48

    passes = result["passes"]
    assert len(passes) == 17
    assert len({p["id"] for p in passes}) == 17
    assert [p["start"] for p in passes] == sorted(p["start"] for p in passes)
    assert _no_negative_zero(passes)
    first = passes[0]
    assert first.keys() == PASS_KEYS
    assert first["id"] == FIRST_PASS_ID
    assert first["title"] == "ISS"
    assert first["kind"] == "iss"
    assert first["start"] == 1793806752
    assert first["duration"] == first["end"] - first["start"]
    assert (first["magnitude"], first["bright"]) == (-0.9, True)
    # The forecast for the hour after the pass begins.
    assert first["cloud_cover"] == cloud_percent(first["start"] + 3600)
    assert (first["satellite_count"], first["train"]) == (1, None)
    for p in passes:
        assert p["start"] < p["end"]
        assert p["kind"] in KINDS
        assert isinstance(p["start"], int)
        assert p["start"] <= p["peak"]["time"] <= p["end"]
        assert p["peak"]["direction"] in DIRECTIONS
        assert len(p["transits"]) == p["satellite_count"]
        assert p["peak"]["elevation"] == max(t["peak"]["elevation"] for t in p["transits"])
        assert p["id"] == str(p["start"])
        for t in p["transits"]:
            assert t.keys() == TRANSIT_KEYS
            assert t["start"] <= t["brightest_time"] < t["end"]
            assert t["start"] <= t["peak"]["time"] < t["end"]
            # The highest point of the window, never below where it starts or ends.
            assert (
                t["peak"]["elevation"] >= max(t["rise"]["elevation"], t["set"]["elevation"]) - 0.5
            )
            assert t["start_reason"] in {"rise", "shadow", "sky"}
            assert t["end_reason"] in {"set", "shadow", "sky"}
            assert t["confidence"] in {"high", "medium", "low"}
            assert t["kind"] in KINDS
            for point in ("rise", "brightest", "set", "peak"):
                assert t[point]["direction"] in DIRECTIONS
                assert 10 <= t[point]["elevation"] <= 90
    kinds = {t["name"]: t["kind"] for p in passes for t in p["transits"]}
    assert kinds["ISS"] == "iss"
    assert kinds["Hubble"] == "hubble"
    assert kinds["Tiangong"] == "tiangong"
    group = next(p for p in passes if p["title"] == "ISS +1")
    assert group["satellite_count"] == 2
    assert [t["name"] for t in group["transits"]] == ["ISS", "Hubble"]


async def test_pass_track(ws: Any, init_integration: MockConfigEntry) -> None:
    """A pass from below the horizon to below it again, every two seconds."""
    p = init_integration.runtime_data.data.passes[0]
    msg = await ws("pass_track", pass_id=p.id)
    assert msg["success"], msg
    result = msg["result"]
    assert result["pass_id"] == p.id
    assert result["step"] == 2
    (transit,) = result["transits"]
    t = p.lead
    assert transit["norad_id"] == 25544
    assert transit["name"] == "ISS"
    assert transit["kind"] == "iss"
    assert transit["visible_start"] == int(t.appears.time.timestamp())
    assert transit["visible_end"] == int(t.vanishes.time.timestamp())

    rows = transit["rows"]
    assert all(len(row) == 10 for row in rows)
    assert _rows_are_whole_seconds(rows)
    assert {row[0] - rows[0][0] for row in rows} == set(range(0, len(rows) * 2, 2))
    # Aligned to the visible start, so the countdown and the drawing agree.
    assert (transit["visible_start"] - rows[0][0]) % 2 == 0
    # Below the horizon at both ends, above it in between.
    assert rows[0][6] < 0 < rows[1][6]
    assert rows[-1][6] < 0 < rows[-2][6]
    assert all(row[6] > 0 for row in rows[1:-1])
    assert (transit["horizon_rise"], transit["horizon_set"]) == (rows[0][0], rows[-1][0])
    assert transit["horizon_rise"] < transit["visible_start"] < transit["visible_end"]
    assert transit["visible_end"] < transit["horizon_set"]
    for when, _lat, _lon, alt, lit, az, el, distance, mag, vis in rows:
        assert 300 < alt < 800
        assert lit in (0, 1)
        assert vis in (0, 1)
        assert 0 <= az < 360
        assert distance > 0
        assert (mag is None) == (not lit or el <= 0)
        if vis:
            assert lit and el >= 10 and mag <= 2.3  # rounded
            # Drawn where the countdown says it is visible (give or take a few seconds).
            assert transit["visible_start"] - 6 <= when <= transit["visible_end"] + 6
    # The search's look angles agree with the rows' within a degree.
    start_row = next(row for row in rows if row[0] == transit["visible_start"])
    assert abs(start_row[6] - t.appears.elevation) < 1
    assert abs((start_row[5] - t.appears.azimuth + 180) % 360 - 180) < 1

    # The Sun every 30 s, all the way.
    sun = result["sun"]
    assert sun[0][0] == rows[0][0] and rows[-1][0] - 30 < sun[-1][0] <= rows[-1][0]
    assert {b[0] - a[0] for a, b in itertools.pairwise(sun)} == {30}
    # An hour before sunrise in Honolulu: the Sun below the eastern horizon, climbing.
    assert -20 < sun[0][2] < sun[-1][2] < -8
    assert 90 < sun[0][1] < 130


async def test_pass_track_of_a_group(ws: Any, init_integration: MockConfigEntry) -> None:
    p = next(p for p in init_integration.runtime_data.data.passes if p.count == 2)
    msg = await ws("pass_track", pass_id=p.id, step=5)
    result = msg["result"]
    assert result["step"] == 5
    first, second = result["transits"]
    assert (first["name"], second["name"]) == ("ISS", "Hubble")
    for transit in result["transits"]:
        assert transit["rows"]
        assert {
            b[0] - a[0] for a, b in zip(transit["rows"], transit["rows"][1:], strict=False)
        } == {5}


def _group(p: ListedPass, names: list[str]) -> ListedPass:
    """Satellites following the pass's first, 15 s apart, named as given."""
    t = p.lead
    members = [
        replace(
            t,
            satellite=replace(t.satellite, name=name, norad_id=70000 + i),
            appears=t.appears._replace(time=t.appears.time + timedelta(seconds=15 * i)),
            brightest=t.brightest._replace(time=t.brightest.time + timedelta(seconds=15 * i)),
            vanishes=t.vanishes._replace(time=t.vanishes.time + timedelta(seconds=15 * i)),
        )
        for i, name in enumerate(names)
    ]
    return ListedPass(
        id=p.id,
        sightings=members,
        cloud_cover=None,
        shapes=p.shapes * len(names),
        peak=p.peak,
    )


async def test_big_groups_get_coarser_paths(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    """Everyone has a path of their own, as those flying together need not share an orbit."""
    coordinator = init_integration.runtime_data
    p = coordinator.data.passes[0]
    names = [f"STARLINK-{1000 + i}" for i in range(8)]
    names.insert(7, "ISS")
    result = await hass.async_add_executor_job(
        pass_track_payload, _group(p, names), coordinator.observer, 2.0, 3.0
    )
    transits = result["transits"]
    assert all(x["rows"] for x in transits)
    steps = [{b[0] - a[0] for a, b in itertools.pairwise(x["rows"])} for x in transits]
    assert steps == [{2}] * 6 + [{PASS_TRACK_MAX_STEP}] * 3
    for member in transits:
        assert member["horizon_rise"] < member["visible_start"] < member["horizon_set"]


@pytest.mark.parametrize(
    ("names", "count"),
    [
        ([f"STARLINK-{i}" for i in range(6)], 6),
        # Named after a brighter rocket, and still a train.
        (["CZ-2C R/B", *(f"STARLINK-{i}" for i in range(6))], 6),
        (["CZ-2C R/B", *(f"STARLINK-{i}" for i in range(5))], None),
        ([f"STARLINK-{i}" for i in range(5)], None),
        ([f"CZ-2C R/B {i}" for i in range(9)], None),
    ],
)
async def test_a_train_is_a_matter_of_how_many_starlinks(
    init_integration: MockConfigEntry, names: list[str], count: int | None
) -> None:
    group = _group(init_integration.runtime_data.data.passes[0], names)
    payload = pass_json(group)
    assert (payload["train"] and payload["train"]["count"]) == count
    assert payload["satellite_count"] == len(names)


def _line(
    count: int, object_id: str, *, first: int = 0, height: float = 20.0, seconds: float = 60
) -> list[Sighting]:
    """Starlinks of one launch, 30 s apart, each 1 degree higher than the one before."""
    return [
        sighting(
            NOW + timedelta(seconds=30 * i),
            seconds,
            name=f"STARLINK-{first + i}",
            norad_id=1000 + first + i,
            peak_magnitude=2.5,
            appears=(200.0, 10.0),
            best_view=(73.0, height + i),
            disappears=(330.0, 10.0),
            object_id=f"{object_id}{chr(ord('A') + i)}",
        )
        for i in range(count)
    ]


def test_a_train_is_measured_by_its_line_alone() -> None:
    # As over Sydney, with a rocket as well: neither it nor the older Starlink is in the line.
    stray = sighting(
        NOW,
        34,
        name="STARLINK-1134",
        norad_id=1134,
        peak_magnitude=2.8,
        best_view=(50.0, 85.0),
        object_id="2020-006K",
    )
    rocket = sighting(
        NOW + timedelta(seconds=600),
        53,
        name="CZ-2C R/B",
        norad_id=7777,
        peak_magnitude=1.9,
        best_view=(69.0, 21.0),
        object_id="2022-132C",
    )
    payload = pass_json(listed(*_line(6, "2026-246"), stray, rocket))
    assert payload["kind"] == "rocket"
    assert payload["peak"]["elevation"] == 85.0
    assert payload["duration"] == 653
    train = payload["train"]
    assert train["count"] == 6
    assert train["peak"]["elevation"] == 25.0
    assert train["peak"]["direction"] == compass(73.0)
    assert train["duration"] == 30 * 5 + 60
    assert (train["from"], train["to"]) == (compass(200.0), compass(330.0))
    # The rocket keeps its own path, for those who look at it.
    assert payload["transits"][0]["rise"]["direction"] == compass(270.0)


def test_a_train_s_path_is_that_of_the_brightest_of_its_line() -> None:
    line = _line(6, "2026-246")
    line[3].peak_magnitude = 1.5
    line[3] = replace(
        line[3],
        appears=line[3].appears._replace(azimuth=90.0),
        vanishes=line[3].vanishes._replace(azimuth=180.0),
    )
    # A rocket outshines them all, so that the line's brightest is neither first nor the pass's.
    rocket = sighting(NOW, name="CZ-2C R/B", norad_id=7777, peak_magnitude=1.0)
    train = pass_json(listed(rocket, *line))["train"]
    assert (train["from"], train["to"]) == (compass(90.0), compass(180.0))


def test_too_few_of_any_one_launch_are_not_a_train() -> None:
    stray = _line(1, "2020-006", first=50)
    assert pass_json(listed(*_line(5, "2026-246"), *stray))["train"] is None


def test_the_train_is_the_launch_with_the_most_in_the_pass() -> None:
    fewer = _line(6, "2026-244", first=50, height=70.0)
    train = pass_json(listed(*fewer, *_line(7, "2026-246")))["train"]
    assert train["count"] == 7
    assert train["peak"]["elevation"] == 26.0


def test_starlinks_of_no_known_launch_count_together() -> None:
    line = [
        replace(
            s,
            satellite=replace(
                s.satellite,
                elements={k: v for k, v in s.satellite.elements.items() if k != "OBJECT_ID"},
            ),
        )
        for s in _line(6, "2026-246")
    ]
    assert line[0].satellite.launch == ""
    assert pass_json(listed(*line))["train"]["count"] == 6


def test_a_train_past_the_shapes_listed_goes_by_the_pass_s_highest() -> None:
    rocket = sighting(
        NOW, name="CZ-2C R/B", norad_id=7777, peak_magnitude=1.0, best_view=(69.0, 40.0)
    )
    p = listed(rocket, *_line(6, "2026-246"))
    train = pass_json(replace(p, shapes=p.shapes[:1]))["train"]
    assert train["count"] == 6
    assert train["peak"]["elevation"] == 40.0


async def test_pass_track_finds_a_pass_by_an_old_id(
    ws: Any, init_integration: MockConfigEntry
) -> None:
    """New orbital elements move a pass by seconds; a page opened before still finds it."""
    p = init_integration.runtime_data.data.passes[0]
    msg = await ws("pass_track", pass_id=str(int(p.id) - 90))
    assert msg["success"], msg
    assert msg["result"]["pass_id"] == p.id
    for pass_id in (
        str(int(p.id) - 200),
        "nonsense",
        "99999999999",
    ):
        msg = await ws("pass_track", pass_id=pass_id)
        assert msg["error"]["code"] == "unknown_pass", pass_id


@pytest.mark.parametrize("step", [0.5, 11, "fast"])
async def test_pass_track_limits(ws: Any, step: Any) -> None:
    msg = await ws("pass_track", pass_id=FIRST_PASS_ID, step=step)
    assert msg["error"]["code"] == "invalid_format"


async def test_track(ws: Any) -> None:
    """Any satellite's ground track, for its orbit and the approach before a pass."""
    start = NOW
    msg = await ws(
        "track",
        norad_id=25544,
        start=start.isoformat(),
        end=(start + timedelta(hours=2)).isoformat(),
    )
    assert msg["success"], msg
    result = msg["result"]
    assert result["norad_id"] == 25544
    assert result["step"] == 30
    track = result["track"]
    assert len(track) == 241
    assert track[0][0] == int(start.timestamp())
    assert _rows_are_whole_seconds(track)
    for _t, lat, lon, alt, lit in track:
        assert -52 < lat < 52 and -180 <= lon <= 180 and 380 < alt < 460 and lit in (0, 1)
    # The station crosses into and out of Earth's shadow once per orbit.
    assert {row[4] for row in track} == {0, 1}

    # Long spans are thinned to stay within the point limit.
    msg = await ws(
        "track", norad_id="25544", start=start.isoformat(),
        end=(start + timedelta(days=7)).isoformat(), step=1,
    )  # fmt: skip
    assert msg["success"], msg
    assert len(msg["result"]["track"]) <= 6000
    assert msg["result"]["step"] == 101


@pytest.mark.parametrize(
    ("begin", "end"),
    [
        (NOW, NOW - timedelta(hours=1)),
        (NOW, NOW + timedelta(days=7, seconds=1)),
        ("9999-12-30T00:00:00+00:00", "9999-12-31T00:00:00+00:00"),
        ("9999-12-31T00:00:00+00:00", "9999-12-31T23:00:00-05:00"),
        ("0001-01-01T00:10:00+01:00", "0001-01-02T00:00:00+00:00"),
        ("1990-01-01T00:00:00+00:00", "1990-01-01T02:00:00+00:00"),
        ("now", "later"),
    ],
)
async def test_track_windows(ws: Any, begin: Any, end: Any) -> None:
    """Backward, over-long, out-of-range and far-off windows are refused."""
    msg = await ws(
        "track",
        norad_id=25544,
        start=begin if isinstance(begin, str) else begin.isoformat(),
        end=end if isinstance(end, str) else end.isoformat(),
    )
    assert msg["error"]["code"] == "invalid_format", msg


async def test_track_of_an_unknown_satellite(ws: Any) -> None:
    msg = await ws(
        "track", norad_id=99999, start=NOW.isoformat(), end=(NOW + timedelta(hours=1)).isoformat()
    )
    assert msg["error"] == {
        "code": "unknown_satellite",
        "message": "Satellite 99999 is not in the catalog",
    }


async def test_positions(hass: HomeAssistant, ws: Any) -> None:
    """Every satellite of the catalog over the next ten minutes, for the globe's cloud."""
    msg = await ws("positions")
    assert msg["success"], msg
    result = msg["result"]
    catalog = async_shared_catalog(hass)
    assert result["start"] == int(NOW.timestamp()) // 60 * 60
    assert (result["step"], result["count"]) == (60, 11)
    assert result["catalog_version"] == int(NOW.timestamp())
    assert result["ids"] == [s.norad_id for s in catalog.satellites]
    assert len(result["pos"]) == len(result["lit"]) == 48
    for row, lit in zip(result["pos"], result["lit"], strict=True):
        assert len(row) == 33
        assert len(lit) == 11
        assert set(lit) <= {"0", "1"}
        for lat, lon, alt in zip(row[::3], row[1::3], row[2::3], strict=True):
            assert -90 <= lat <= 90 and -180 <= lon <= 180
            assert round(lat, 2) == lat and round(lon, 2) == lon
            # The catalog's highest orbit, a Falcon 9 stage's, reaches about 69,000 km.
            assert isinstance(alt, int) and 150 < alt < 70000
    iss = result["pos"][result["ids"].index(25544)]
    assert 400 < iss[2] < 440

    # Pages asking around the same time share one computation, kept as the
    # JSON sent: a fraction of the memory of the lists it was built from.
    cached = len(catalog._cache)
    msg = await ws("positions", start=(NOW + timedelta(seconds=30)).isoformat())
    assert msg["result"] == result
    assert len(catalog._cache) == cached
    assert all(isinstance(value, bytes) for value in catalog._cache.values())

    msg = await ws("positions", start=NOW.isoformat(), span=0, step=10)
    assert (msg["result"]["count"], msg["result"]["step"]) == (1, 10)
    assert len(msg["result"]["pos"][0]) == 3

    # The most the globe asks for: an hour of a simulated pass, a minute apart.
    msg = await ws("positions", start=NOW.isoformat(), span=3600, step=60)
    assert msg["result"]["count"] == 61
    assert len(msg["result"]["pos"][0]) == 3 * 61


@pytest.mark.parametrize(
    "fields",
    [
        {"span": 3601},
        {"span": -1},
        {"step": 9},
        {"step": 301},
        # More than 61 times, each with the whole catalog.
        {"span": 3600, "step": 30},
        {"span": 601, "step": 10},
        {"start": "9999-12-31T00:00:00+00:00"},
        {"start": "2026-01-01T00:00:00+00:00"},
        {"start": "soon"},
    ],
)
async def test_positions_limits(ws: Any, fields: dict[str, Any]) -> None:
    msg = await ws("positions", **fields)
    assert msg["error"]["code"] == "invalid_format", msg


async def test_catalog(hass: HomeAssistant, ws: Any) -> None:
    msg = await ws("catalog")
    assert msg["success"], msg
    result = msg["result"]
    assert result["updated"] == int(NOW.timestamp())
    assert result["version"] == int(NOW.timestamp())
    satellites = {s["norad_id"]: s for s in result["satellites"]}
    assert len(satellites) == 48
    assert satellites[23405]["kind"] == "rocket"
    assert satellites[31598]["kind"] == "satellite"
    assert satellites[44725]["kind"] == "starlink"
    iss = satellites[25544]
    assert iss.keys() == {
        "norad_id", "name", "kind", "magnitude", "epoch", "period_s", "inclination", "about_url",
    }  # fmt: skip
    assert (iss["name"], iss["kind"], iss["magnitude"]) == ("ISS", "iss", -0.5)
    assert 5500 < iss["period_s"] < 5600
    assert iss["inclination"] == 51.6
    assert iss["about_url"] == "https://en.wikipedia.org/wiki/International_Space_Station"
    assert dt_util.utc_from_timestamp(iss["epoch"]) < NOW
    # Built once per catalog.
    again = await ws("catalog")
    assert again["result"] == result


async def test_street(hass: HomeAssistant, ws: Any, init_integration: MockConfigEntry) -> None:
    """Where the street photos come from, and the keys the browser fetches them with."""
    msg = await ws("street", entry_id=init_integration.entry_id)
    assert msg["result"] == {"source": "auto", "mapillary_token": None, "google_api_key": None}
    hass.config_entries.async_update_entry(
        init_integration,
        options={
            CONF_STREET_VIEW: {
                CONF_STREET_SOURCE: "google",
                CONF_GOOGLE_API_KEY: "AIza-key",
                CONF_MAPILLARY_TOKEN: "MLY|1|2",
            }
        },
    )
    await hass.async_block_till_done()
    msg = await ws("street")
    assert msg["result"] == {
        "source": "google",
        "mapillary_token": "MLY|1|2",
        "google_api_key": "AIza-key",
    }
    # Options from a newer version, or typed by hand, are checked.
    hass.config_entries.async_update_entry(
        init_integration, options={CONF_STREET_VIEW: {CONF_STREET_SOURCE: "bing"}}
    )
    await hass.async_block_till_done()
    assert (await ws("street"))["result"]["source"] == "auto"


async def test_street_hides_keys_from_non_admin(
    hass: HomeAssistant,
    init_integration: MockConfigEntry,
    hass_read_only_access_token: str,
    hass_ws_client: Any,
) -> None:
    hass.config_entries.async_update_entry(
        init_integration,
        options={
            CONF_STREET_VIEW: {
                CONF_STREET_SOURCE: "google",
                CONF_GOOGLE_API_KEY: "AIza-key",
                CONF_MAPILLARY_TOKEN: "MLY|1|2",
            }
        },
    )
    await hass.async_block_till_done()
    client = await hass_ws_client(hass, access_token=hass_read_only_access_token)
    for fields in ({}, {"entry_id": init_integration.entry_id}):
        await client.send_json_auto_id({"type": f"{DOMAIN}/street", **fields})
        msg = await client.receive_json()
        assert msg["success"], msg
        assert msg["result"] == {
            "source": "google",
            "mapillary_token": None,
            "google_api_key": None,
        }


@pytest.mark.parametrize(
    ("kind", "fields"),
    [
        ("passes", {}),
        ("pass_track", {"pass_id": FIRST_PASS_ID}),
        (
            "track",
            {"norad_id": 25544, "start": "2026-11-04T19:00:00Z", "end": "2026-11-04T20:00:00Z"},
        ),
        ("positions", {}),
        ("catalog", {}),
        ("street", {}),
    ],
)
async def test_unknown_and_removed_locations(
    hass: HomeAssistant,
    ws: Any,
    init_integration: MockConfigEntry,
    kind: str,
    fields: dict[str, Any],
) -> None:
    msg = await ws(kind, entry_id="nope", **fields)
    assert msg["error"]["code"] == "unknown_location"
    msg = await ws(kind, entry_id=init_integration.entry_id, **fields)
    assert msg["success"], msg

    await hass.config_entries.async_remove(init_integration.entry_id)
    await hass.async_block_till_done()
    for request in ({"entry_id": init_integration.entry_id}, {}):
        msg = await ws(kind, **request, **fields)
        assert msg["error"] == {
            "code": "not_found",
            "message": "No Satellite Spotter location is set up",
        }


async def test_paused_predictions(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    ws: Any,
    init_integration: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """Orbit data too old to trust: no passes, and the reason why."""
    mock_downloads["fetch_catalog"].side_effect = CatalogError("HTTP 503")
    later = NOW + timedelta(days=15)
    # Past the age limit, even before the next refresh notices.
    freezer.move_to(later)
    payload = build_passes_payload(init_integration.runtime_data, later)
    assert payload["paused"] == "Orbit data is 15 days old"
    assert payload["paused_days"] == 15
    assert payload["paused_error"] is None
    assert payload["passes"] == []

    # The refresh fails, and its reason is passed on.
    await advance(hass, freezer, later)
    msg = await ws("passes")
    result = msg["result"]
    assert "15 days old and could not be refreshed" in result["paused"]
    assert "HTTP 503" in result["paused"]
    assert result["paused_days"] == 15
    assert result["paused_error"] == "HTTP 503"
    assert result["passes"] == []
    assert result["catalog"]["satellites"] == 48

    # Nor can a pass be drawn from them; the catalog itself is still described.
    for kind, fields in (
        ("pass_track", {"pass_id": FIRST_PASS_ID}),
        ("track", {"norad_id": 25544, "start": later.isoformat(),
                   "end": (later + timedelta(hours=1)).isoformat()}),
        ("positions", {}),
    ):  # fmt: skip
        msg = await ws(kind, **fields)
        assert msg["error"] == {"code": "stale_catalog", "message": result["paused"]}, kind
    assert (await ws("catalog"))["success"]


async def test_times_are_unix_seconds(ws: Any) -> None:
    """Whole seconds stay integers; nothing in the payloads is an ISO string."""
    result = (await ws("passes"))["result"]

    def times(value: Any, key: str = "") -> list[Any]:
        if isinstance(value, dict):
            return [x for k, v in value.items() for x in times(v, k)]
        if isinstance(value, list):
            return [x for v in value for x in times(v, key)]
        return [value] if key in {"start", "end", "time", "brightest_time"} else []

    found = times(result["passes"])
    assert found
    assert all(isinstance(t, int) for t in found)
    assert all(datetime.fromtimestamp(t).year == 2026 for t in found)


async def test_the_drawing_uses_the_same_cutoff_as_the_list(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    """Otherwise a Starlink past the cutoff would be listed, but not drawn as visible."""
    coordinator = init_integration.runtime_data
    p = coordinator.data.passes[0]

    def named(name: str) -> Any:
        sighting = replace(p.lead, satellite=replace(p.lead.satellite, name=name))
        return replace(p, sightings=[sighting])

    with patch(
        "custom_components.satellite_spotter.frontend.track.pass_track", return_value=None
    ) as drawn:
        pass_track_payload(named("STARLINK-1"), coordinator.observer, 2.0, 2.25)
        assert drawn.call_args.args[5] == 3.0
        pass_track_payload(named("SOME SAT"), coordinator.observer, 2.0, 2.25)
        assert drawn.call_args.args[5] == 2.25


# --- Why a card has nothing to show --------------------------------------------


async def _asked_for_passes(hass: HomeAssistant, hass_ws_client: Any, **fields: Any) -> Any:
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/passes", **fields})
    return await client.receive_json()


async def test_a_location_retrying_says_what_it_waits_for_until_it_is_disabled(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], hass_ws_client: Any
) -> None:
    mock_downloads["fetch_catalog"].side_effect = CatalogError("HTTP 500")
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    for fields in ({}, {"entry_id": entry.entry_id}):
        msg = await _asked_for_passes(hass, hass_ws_client, **fields)
        assert not msg["success"]
        assert msg["error"] == {"code": "not_ready", "message": "No satellite catalog: HTTP 500"}

    await hass.config_entries.async_set_disabled_by(entry.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    msg = await _asked_for_passes(hass, hass_ws_client)
    assert msg["error"] == {"code": "location_disabled", "message": "This location is disabled"}


async def test_a_card_on_a_disabled_location_is_told_and_recovers_when_it_is_enabled(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: Any
) -> None:
    cabin = await add_location(hass, DENVER, title="Cabin", unique_id="39.7400_-104.9900")
    assert init_integration.state is cabin.state is ConfigEntryState.LOADED
    await hass.config_entries.async_set_disabled_by(cabin.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    msg = await _asked_for_passes(hass, hass_ws_client, entry_id=cabin.entry_id)
    assert msg["error"] == {"code": "location_disabled", "message": "This location is disabled"}

    await hass.config_entries.async_set_disabled_by(cabin.entry_id, None)
    await hass.async_block_till_done()
    msg = await _asked_for_passes(hass, hass_ws_client, entry_id=cabin.entry_id)
    assert msg["result"]["location"]["title"] == "Cabin"


async def test_a_card_is_not_left_waiting_for_a_setup_that_failed(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], hass_ws_client: Any
) -> None:
    with patch(
        "custom_components.satellite_spotter.SatelliteSpotterCoordinator",
        side_effect=RuntimeError("boom"),
    ):
        entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_ERROR
    for fields in ({}, {"entry_id": entry.entry_id}):
        msg = await _asked_for_passes(hass, hass_ws_client, **fields)
        assert msg["error"] == {
            "code": "setup_failed",
            "message": "Setup failed; see the Home Assistant log",
        }

    # A card showing whichever location comes first does wait, while another is on its way.
    cabin = MockConfigEntry(domain=DOMAIN, title="Cabin", data=dict(DENVER))
    cabin.add_to_hass(hass)
    cabin.mock_state(hass, ConfigEntryState.SETUP_RETRY, "No satellite catalog: HTTP 500")
    msg = await _asked_for_passes(hass, hass_ws_client)
    assert msg["error"] == {"code": "not_ready", "message": "No satellite catalog: HTTP 500"}


@pytest.mark.parametrize(
    ("state", "reason", "code", "message"),
    [
        (ConfigEntryState.SETUP_ERROR, "Boom", "setup_failed", "Boom; see the Home Assistant log"),
        (
            ConfigEntryState.MIGRATION_ERROR,
            None,
            "setup_failed",
            "Setup failed; see the Home Assistant log",
        ),
        (
            ConfigEntryState.FAILED_UNLOAD,
            "Unload failed",
            "setup_failed",
            "Unload failed; see the Home Assistant log",
        ),
        (ConfigEntryState.NOT_LOADED, None, "not_ready", "Starting up"),
        (ConfigEntryState.SETUP_IN_PROGRESS, None, "not_ready", "Starting up"),
        (ConfigEntryState.UNLOAD_IN_PROGRESS, None, "not_ready", "Starting up"),
        (ConfigEntryState.SETUP_RETRY, "Busy", "not_ready", "Busy"),
    ],
)
async def test_each_state_a_location_can_be_in_gets_its_own_answer(
    hass: HomeAssistant,
    hass_ws_client: Any,
    state: ConfigEntryState,
    reason: str | None,
    code: str,
    message: str,
) -> None:
    assert await async_setup_component(hass, DOMAIN, {})
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    entry.mock_state(hass, state, reason)
    msg = await _asked_for_passes(hass, hass_ws_client)
    assert msg["error"] == {"code": code, "message": message}


async def test_a_location_added_back_is_told_of_the_catalog_it_has_now(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    hass_ws_client: Any,
) -> None:
    """Pages keep a catalog while its version is current: a new one must not reuse the number."""

    async def described() -> Any:
        await client.send_json_auto_id({"type": f"{DOMAIN}/catalog"})
        return (await client.receive_json())["result"]

    entry = await add_location(hass)
    client = await hass_ws_client(hass)
    first = await described()
    assert len(first["satellites"]) == 48

    # Long enough after the download for the stored copy to go with the last location.
    freezer.move_to(NOW + timedelta(hours=3))
    await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    mock_downloads["fetch_catalog"].return_value = mock_downloads["fetch_catalog"].return_value[:3]
    await add_location(hass)

    second = await described()
    assert len(second["satellites"]) == 3
    assert second["version"] != first["version"]


# --- Limits and rounding -------------------------------------------------------


async def test_positions_are_those_of_the_times_they_say(hass: HomeAssistant, ws: Any) -> None:
    result = (await ws("positions"))["result"]
    catalog = async_shared_catalog(hass)
    index = result["ids"].index(25544)
    sample = 5
    where = track.positions([catalog.satrecs()[index]], [result["start"] + sample * result["step"]])
    row = result["pos"][index]
    assert row[3 * sample] == round(float(where.latitude[0, 0]), 2)
    assert row[3 * sample + 1] == round(float(where.longitude[0, 0]), 2)


@pytest.mark.parametrize(("past", "allowed"), [(0, True), (1, False)])
async def test_positions_are_for_times_within_range_of_now(
    ws: Any, past: int, allowed: bool
) -> None:
    start = NOW + TRACK_EPOCH_RANGE + timedelta(seconds=past)
    msg = await ws("positions", start=start.isoformat(), span=0)
    assert msg["success"] is allowed


@pytest.mark.parametrize(
    ("seconds", "asked", "step"),
    [
        # Just over 100 s for each of the most points a track can have.
        pytest.param(5999 * 100 + 1, 1.0, 101, id="widened"),
        pytest.param(5999 * 100, 1.0, 100, id="just fits at that spacing"),
        pytest.param(5999 * 100, 200.0, 200.0, id="wider than it need be, as asked"),
    ],
)
def test_a_long_track_is_spaced_to_stay_within_its_points(
    seconds: int, asked: float, step: float
) -> None:
    assert track_step(NOW, NOW + timedelta(seconds=seconds), asked) == step


@pytest.mark.parametrize("value", [-0.04, -0.0, 0.04])
def test_rounded_numbers_are_never_negative_zero(value: float) -> None:
    assert str(_number(value, 1)) == "0.0"


def test_a_number_that_is_not_there_stays_not_there() -> None:
    assert _number(None, 1) is None
    assert _number(float("nan"), 1) is None
    assert _number(float("inf"), 1) is None


# A burst of requests for positions.


async def test_a_burst_of_requests_for_positions_runs_out(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: Any
) -> None:
    client = await hass_ws_client(hass)
    clock = [1000.0]
    with patch("custom_components.satellite_spotter.frontend.time.monotonic", lambda: clock[0]):
        replies = []
        for _ in range(POSITIONS_BURST + 3):
            await client.send_json_auto_id({"type": f"{DOMAIN}/positions"})
            replies.append(await client.receive_json())
        assert all(reply["success"] for reply in replies[:POSITIONS_BURST])
        assert all(
            reply["error"]["code"] == "too_many_requests" for reply in replies[POSITIONS_BURST:]
        )
        # One more, every so often.
        clock[0] += POSITIONS_REFILL_SECONDS
        await client.send_json_auto_id({"type": f"{DOMAIN}/positions"})
        assert (await client.receive_json())["success"]
        await client.send_json_auto_id({"type": f"{DOMAIN}/positions"})
        assert not (await client.receive_json())["success"]


async def test_the_budget_is_each_users_own(
    hass: HomeAssistant,
    init_integration: MockConfigEntry,
    hass_ws_client: Any,
    hass_read_only_access_token: str,
) -> None:
    client = await hass_ws_client(hass)
    for _ in range(POSITIONS_BURST + 1):
        await client.send_json_auto_id({"type": f"{DOMAIN}/positions"})
        last = await client.receive_json()
    assert not last["success"]
    other = await hass_ws_client(hass, hass_read_only_access_token)
    await other.send_json_auto_id({"type": f"{DOMAIN}/positions"})
    assert (await other.receive_json())["success"]


async def test_the_same_positions_asked_for_at_once_are_worked_out_once(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: Any
) -> None:
    client = await hass_ws_client(hass)
    with patch(
        "custom_components.satellite_spotter.frontend.positions_json", wraps=positions_json
    ) as worked_out:
        for _ in range(5):
            await client.send_json_auto_id({"type": f"{DOMAIN}/positions", "span": 120})
        replies = [await client.receive_json() for _ in range(5)]
    assert all(reply["success"] for reply in replies)
    assert len({json.dumps(reply["result"]) for reply in replies}) == 1
    assert worked_out.call_count == 1
    assert not hass.data[DATA_FRONTEND].positions_jobs


async def test_a_failure_working_out_positions_is_reported_to_everyone_waiting(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client: Any
) -> None:
    client = await hass_ws_client(hass)
    with patch(
        "custom_components.satellite_spotter.frontend.positions_json",
        side_effect=ValueError("no"),
    ):
        for _ in range(2):
            await client.send_json_auto_id({"type": f"{DOMAIN}/positions", "span": 180})
        replies = [await client.receive_json() for _ in range(2)]
    assert not any(reply["success"] for reply in replies)
    assert not hass.data[DATA_FRONTEND].positions_jobs
