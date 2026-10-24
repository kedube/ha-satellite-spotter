"""The websocket API the panel and the cards use: every command, its payload, limits and errors."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
import itertools
from typing import Any
from unittest.mock import AsyncMock

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util
from pysatellitespotter import CatalogError
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.catalog import async_get_catalog
from custom_components.satellite_spotter.const import (
    CONF_GOOGLE_API_KEY,
    CONF_MAPILLARY_TOKEN,
    CONF_STREET_SOURCE,
    CONF_STREET_VIEW,
    DOMAIN,
)
from custom_components.satellite_spotter.coordinator import SatellitePass
from custom_components.satellite_spotter.entity import compass
from custom_components.satellite_spotter.frontend import (
    build_passes_payload,
    pass_track_payload,
)

from .common import FIRST_PASS_ID, NOW, UTRECHT, advance

DIRECTIONS = {compass(22.5 * i) for i in range(16)}
PASS_KEYS = {
    "id", "title", "kind", "start", "end", "duration", "magnitude", "bright", "before_sunset",
    "limiting_magnitude", "cloud_cover", "satellite_count", "train", "peak", "transits",
}  # fmt: skip
TRANSIT_KEYS = {
    "norad_id", "name", "kind", "start", "end", "magnitude", "brightest_time", "rise",
    "brightest", "set", "peak", "start_reason", "end_reason", "intrinsic_magnitude", "model",
    "prediction", "period_s", "info_url", "confidence",
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
    assert result["computed_at"] == int(NOW.timestamp())
    assert (result["paused"], result["paused_days"], result["paused_error"]) == (None,) * 3
    assert result["location"] == {
        "entry_id": init_integration.entry_id,
        "title": "Home",
        **UTRECHT,
    }
    assert result["settings"] == {
        "max_magnitude": 3.0,
        "cloud_cover": True,
        "alert_lead_minutes": 15,
        "units": "auto",
        "days": 5,
        "min_elevation": 10,
    }
    catalog = result["catalog"]
    assert catalog["updated"] == int(NOW.timestamp())
    assert catalog["version"] == 1
    assert catalog["satellites"] == 22
    assert 0 < catalog["median_epoch_age_days"] < 1

    passes = result["passes"]
    assert len(passes) == 64
    assert len({p["id"] for p in passes}) == 64
    assert [p["start"] for p in passes] == sorted(p["start"] for p in passes)
    assert _no_negative_zero(passes)
    first = passes[0]
    assert first.keys() == PASS_KEYS
    assert first["id"] == FIRST_PASS_ID
    assert first["title"] == "BlueWalker 3"
    assert first["kind"] == "satellite"
    assert first["start"] == 1791659316
    assert first["duration"] == first["end"] - first["start"]
    assert (first["magnitude"], first["bright"], first["cloud_cover"]) == (0.3, True, 20)
    assert (first["satellite_count"], first["train"]) == (1, False)
    for p in passes:
        assert p["start"] < p["end"]
        assert p["kind"] in KINDS
        assert isinstance(p["start"], int)
        assert p["start"] <= p["peak"]["time"] <= p["end"]
        assert p["peak"]["direction"] in DIRECTIONS
        assert len(p["transits"]) == p["satellite_count"]
        assert p["peak"]["elevation"] == max(t["peak"]["elevation"] for t in p["transits"])
        assert p["id"] == f"{p['transits'][0]['norad_id']}-{p['start']}"
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
    assert kinds["SL-4 R/B"] == "rocket"
    assert kinds["BREEZE-M DEB (TANK)"] == "debris"
    assert kinds["BlueWalker 3"] == "satellite"
    group = next(p for p in passes if p["title"] == "SL-4 R/B +1")
    assert group["satellite_count"] == 2
    assert [t["name"] for t in group["transits"]] == ["SL-4 R/B", "SAOCOM 1-A"]


async def test_pass_track(ws: Any, init_integration: MockConfigEntry) -> None:
    """A pass from below the horizon to below it again, every two seconds."""
    p = init_integration.runtime_data.data.passes[0]
    msg = await ws("pass_track", pass_id=p.id)
    assert msg["success"], msg
    result = msg["result"]
    assert result["pass_id"] == p.id
    assert result["step"] == 2
    (transit,) = result["transits"]
    t = p.primary
    assert transit["norad_id"] == 53807
    assert transit["name"] == "BlueWalker 3"
    assert transit["kind"] == "satellite"
    assert transit["offset_s"] == 0
    assert transit["visible_start"] == int(t.start.timestamp())
    assert transit["visible_end"] == int(t.end.timestamp())

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
            assert lit and el >= 10 and mag <= 3.0  # rounded
            # Drawn where the countdown says it is visible (give or take a few seconds).
            assert transit["visible_start"] - 6 <= when <= transit["visible_end"] + 6
    # The library's own look angles (from interpolated positions) agree within a degree.
    start_row = next(row for row in rows if row[0] == transit["visible_start"])
    assert abs(start_row[6] - t.rise.elevation) < 1
    assert abs((start_row[5] - t.rise.azimuth + 180) % 360 - 180) < 1

    # The Sun every 30 s, all the way.
    sun = result["sun"]
    assert sun[0][0] == rows[0][0] and rows[-1][0] - 30 < sun[-1][0] <= rows[-1][0]
    assert {b[0] - a[0] for a, b in itertools.pairwise(sun)} == {30}
    # Two hours after sunset: the Sun well below the north-west horizon, sinking.
    assert -30 < sun[-1][2] < sun[0][2] < -12
    assert 280 < sun[0][1] < 330


async def test_pass_track_of_a_group(ws: Any, init_integration: MockConfigEntry) -> None:
    p = next(p for p in init_integration.runtime_data.data.passes if p.id == "39679-1791693714")
    msg = await ws("pass_track", pass_id=p.id, step=5)
    result = msg["result"]
    assert result["step"] == 5
    first, second = result["transits"]
    assert (first["name"], second["name"]) == ("SL-4 R/B", "SAOCOM 1-A")
    assert first["offset_s"] == 0
    assert second["offset_s"] == round(
        (p.group.transits[1].brightest_time - p.group.transits[0].brightest_time).total_seconds()
    )
    for transit in result["transits"]:
        assert transit["rows"]
        assert {
            b[0] - a[0] for a, b in zip(transit["rows"], transit["rows"][1:], strict=False)
        } == {5}


def _group(p: SatellitePass, names: list[str]) -> SatellitePass:
    """Satellites following the pass's first, 15 s apart, named as given."""
    t = p.primary
    members = [
        replace(
            t,
            satellite=replace(t.satellite, name=name, norad_id=70000 + i),
            start=t.start + timedelta(seconds=15 * i),
            end=t.end + timedelta(seconds=15 * i),
            brightest_time=t.brightest_time + timedelta(seconds=15 * i),
        )
        for i, name in enumerate(names)
    ]
    return SatellitePass(
        id=p.id,
        group=replace(p.group, transits=members),
        cloud_cover=None,
        shapes=p.shapes * len(names),
        peak=p.peak,
    )


async def test_trains_share_the_first_path(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    """The first six of a Starlink train get rows; the rest follow the first, offset_s later."""
    coordinator = init_integration.runtime_data
    p = coordinator.data.passes[0]
    names = [f"STARLINK-{1000 + i}" for i in range(8)]
    names.insert(7, "ISS")
    train = _group(p, names)
    result = await hass.async_add_executor_job(
        pass_track_payload, train, coordinator.observer, 2.0, 3.0
    )
    transits = result["transits"]
    assert [x["offset_s"] for x in transits] == [15 * i for i in range(9)]
    # Another satellite in the train is on an orbit of its own: it keeps its rows.
    assert [x["rows"] is not None for x in transits] == [True] * 6 + [False, True, False]
    for member in transits:
        assert member["horizon_rise"] < member["visible_start"] < member["horizon_set"]
    # The time-shifted copies rise and set with the first, offset_s later.
    assert transits[6]["horizon_rise"] == transits[0]["horizon_rise"] + 90
    assert transits[8]["horizon_set"] == transits[0]["horizon_set"] + 120

    # A group that is not a train: everyone on their own path.
    group = _group(p, ["BlueWalker 3", *names[:8]])
    result = await hass.async_add_executor_job(
        pass_track_payload, group, coordinator.observer, 2.0, 3.0
    )
    assert all(x["rows"] for x in result["transits"])


async def test_pass_track_finds_a_pass_by_an_old_id(
    ws: Any, init_integration: MockConfigEntry
) -> None:
    """New orbital elements move a pass by seconds; a page opened before still finds it."""
    p = init_integration.runtime_data.data.passes[0]
    norad_id, start = p.id.split("-")
    msg = await ws("pass_track", pass_id=f"{norad_id}-{int(start) - 90}")
    assert msg["success"], msg
    assert msg["result"]["pass_id"] == p.id
    for pass_id in (
        f"{norad_id}-{int(start) - 200}",
        f"25544-{start}",
        "nonsense",
        "1-99999999999",
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
    """Backwards, over-long, out-of-range and far-off windows are refused."""
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
    catalog = async_get_catalog(hass)
    assert result["start"] == int(NOW.timestamp()) // 60 * 60
    assert (result["step"], result["count"], result["catalog_version"]) == (60, 11, 1)
    assert result["ids"] == [s.norad_id for s in catalog.satellites]
    assert len(result["pos"]) == len(result["lit"]) == 22
    for row, lit in zip(result["pos"], result["lit"], strict=True):
        assert len(row) == 33
        assert len(lit) == 11
        assert set(lit) <= {"0", "1"}
        for lat, lon, alt in zip(row[::3], row[1::3], row[2::3], strict=True):
            assert -90 <= lat <= 90 and -180 <= lon <= 180
            assert round(lat, 2) == lat and round(lon, 2) == lon
            assert isinstance(alt, int) and 150 < alt < 40000
    iss = result["pos"][result["ids"].index(25544)]
    assert 400 < iss[2] < 440

    # Pages asking around the same time share one computation, kept as the
    # JSON sent: a fraction of the memory of the lists it was built from.
    cached = len(catalog.cache)
    msg = await ws("positions", start=(NOW + timedelta(seconds=30)).isoformat())
    assert msg["result"] == result
    assert len(catalog.cache) == cached
    assert all(isinstance(value, bytes) for value in catalog.cache.values())

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
    assert result["version"] == 1
    satellites = {s["norad_id"]: s for s in result["satellites"]}
    assert len(satellites) == 22
    iss = satellites[25544]
    assert iss.keys() == {
        "norad_id", "name", "kind", "magnitude", "model", "epoch", "period_s", "perigee_km",
        "apogee_km", "inclination", "info_url",
    }  # fmt: skip
    assert (iss["name"], iss["kind"], iss["magnitude"], iss["model"]) == ("ISS", "iss", -2.3, None)
    assert 5500 < iss["period_s"] < 5600
    assert 400 < iss["perigee_km"] <= iss["apogee_km"] < 440
    assert iss["inclination"] == 51.6
    assert iss["info_url"] == "https://en.wikipedia.org/wiki/International_Space_Station"
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


@pytest.mark.parametrize(
    ("kind", "fields"),
    [
        ("passes", {}),
        ("pass_track", {"pass_id": FIRST_PASS_ID}),
        (
            "track",
            {"norad_id": 25544, "start": "2026-10-10T19:00:00Z", "end": "2026-10-10T20:00:00Z"},
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
    mock_pysatellitespotter: dict[str, AsyncMock],
) -> None:
    """Orbit data too old to trust: no passes, and the reason why."""
    mock_pysatellitespotter["fetch_site_catalog"].side_effect = CatalogError("HTTP 503")
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
    assert result["catalog"]["satellites"] == 22

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
