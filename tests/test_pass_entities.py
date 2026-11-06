"""What the sensors and binary sensors say, and how that changes as time passes."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import entity_registry as er
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter import track
from custom_components.satellite_spotter.binary_sensor import BINARY_SENSORS, PassBinarySensor
from custom_components.satellite_spotter.catalog import CatalogManager
from custom_components.satellite_spotter.celestrak import CatalogError, DownloadRefused
from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.coordinator import (
    ListedPass,
    LiveSatellite,
    SatelliteSpotterCoordinator,
)
from custom_components.satellite_spotter.device_tracker import SatellitePositionTracker
from custom_components.satellite_spotter.entity import (
    compass,
    confidence,
    magnitude,
    satellite_kind,
)
from custom_components.satellite_spotter.sensor import (
    PASS_SENSORS,
    OrbitalElementsEpochSensor,
    PassSensor,
    SatelliteElevationSensor,
    VisiblePassCountSensor,
)
from custom_components.satellite_spotter.track import SatellitePosition

from .common import (
    HONOLULU,
    NOW,
    add_location,
    advance,
    bright_pass,
    dim_pass,
    listed,
    made_up_satellite,
    satellites,
    sighting,
    with_epoch,
)

SECOND = timedelta(seconds=1)
NEXT_PASS = "sensor.home_next_visible_pass"
PEAK_ELEVATION = "sensor.home_next_visible_pass_peak_elevation"
BRIGHTNESS = "sensor.home_next_visible_pass_brightness"
DURATION = "sensor.home_next_visible_pass_duration"
CLOUD_COVER = "sensor.home_next_visible_pass_cloud_cover"
SATELLITE_NAME = "sensor.home_next_visible_satellite_name"
NEXT_BRIGHT = "sensor.home_next_bright_pass"
WITHIN_A_DAY = "sensor.home_visible_passes_next_24_hours"
ELEVATION = "sensor.home_satellite_elevation"
POSITION = "device_tracker.home_satellite_position"
EPOCH = "sensor.home_orbital_elements_epoch"
UNDER_WAY = "binary_sensor.home_satellite_visible_now"
VISIBLE_SOON = "binary_sensor.home_visible_pass_soon"
BRIGHT_SOON = "binary_sensor.home_bright_pass_soon"
CALENDAR = "calendar.home_visible_passes"
# How a timestamp sensor writes its state.
STAMP_FORMAT = "%Y-%m-%dT%H:%M:%S+00:00"


@pytest.fixture(autouse=True)
def _tracker_enabled() -> Iterator[None]:
    """Have the tracker too, which starts disabled for anyone else."""
    with patch.object(SatellitePositionTracker, "_attr_entity_registry_enabled_default", True):
        yield


def state_of(hass: HomeAssistant, entity_id: str) -> State:
    state = hass.states.get(entity_id)
    assert state is not None
    return state


def stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime(STAMP_FORMAT)


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


async def location_with(
    hass: HomeAssistant, predict_passes: MagicMock, *passes: ListedPass, **more: Any
) -> MockConfigEntry:
    predict_passes.return_value = list(passes)
    return await add_location(hass, **more)


# The next visible pass.


async def test_the_next_visible_pass_is_a_timestamp_of_the_next_start(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    p = dim_pass(NOW + timedelta(hours=1))
    await location_with(hass, predict_passes, p)
    state = state_of(hass, NEXT_PASS)
    assert state.state == stamp(p.start)
    assert state.attributes["device_class"] == "timestamp"


async def test_the_next_visible_pass_stays_until_it_ends_and_moves_on(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    first = dim_pass(NOW + timedelta(minutes=10), 60)
    second = dim_pass(NOW + timedelta(minutes=30), 60)
    await location_with(hass, predict_passes, first, second)

    # README: "When the next visible pass starts, or the one under way".
    await advance(hass, freezer, first.start + SECOND)
    assert state_of(hass, NEXT_PASS).state == stamp(first.start)
    assert state_of(hass, NEXT_PASS).attributes["pass_id"] == first.id

    await advance(hass, freezer, first.end)
    assert state_of(hass, NEXT_PASS).state == stamp(first.start)

    await advance(hass, freezer, first.end + SECOND)
    assert state_of(hass, NEXT_PASS).state == stamp(second.start)
    assert state_of(hass, NEXT_PASS).attributes["pass_id"] == second.id


async def test_with_no_pass_left_the_sensor_is_unknown_with_no_description(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(minutes=10), 60)
    await location_with(hass, predict_passes, p)
    await advance(hass, freezer, p.end + SECOND)
    state = state_of(hass, NEXT_PASS)
    assert state.state == "unknown"
    assert "pass_id" not in state.attributes


async def test_no_passes_at_all(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    await location_with(hass, predict_passes)
    for entity_id in (
        NEXT_PASS, PEAK_ELEVATION, BRIGHTNESS, DURATION, CLOUD_COVER, SATELLITE_NAME, NEXT_BRIGHT,
        ELEVATION,
    ):  # fmt: skip
        assert state_of(hass, entity_id).state == "unknown", entity_id
    assert state_of(hass, NEXT_PASS).attributes["upcoming"] == []
    assert state_of(hass, WITHIN_A_DAY).state == "0"
    for entity_id in (UNDER_WAY, VISIBLE_SOON, BRIGHT_SOON):
        assert state_of(hass, entity_id).state == "off", entity_id


async def test_the_description_has_what_the_readme_lists_worked_out_by_hand(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    start = datetime(2026, 11, 4, 16, 0, 0, tzinfo=UTC)
    p = listed(
        sighting(
            start,
            300,
            name="ISS",
            norad_id=25544,
            peak_magnitude=-2.46,
            appears=(270.0, 21.0),
            best_view=(315.0, 40.4),
            disappears=(45.0, 10.1),
        ),
        sighting(start + timedelta(seconds=30), 330, name="CZ-2C R/B", norad_id=7777),
        cloud_cover=12,
        reasons=("shadow", "set"),
    )
    await location_with(hass, predict_passes, p)
    attributes = state_of(hass, NEXT_PASS).attributes
    assert {key: attributes[key] for key in attributes if key not in COMMON_ATTRIBUTES} == {
        "pass_id": str(int(start.timestamp())),
        "pass_start": start,
        "pass_end": start + timedelta(seconds=360),
        "satellite": "ISS",
        "catalog_number": 25544,
        "kind": "iss",
        "about_url": "https://en.wikipedia.org/wiki/International_Space_Station",
        "satellite_count": 2,
        "satellites": ["ISS", "CZ-2C R/B"],
        "start": start,
        "start_direction": "W",
        "start_azimuth": 270.0,
        "start_elevation": 21.0,
        "peak": start + timedelta(seconds=150),
        "peak_direction": "NW",
        "peak_azimuth": 315.0,
        "peak_elevation": 40.4,
        "end": start + timedelta(seconds=300),
        "end_direction": "NE",
        "end_azimuth": 45.0,
        "end_elevation": 10.1,
        "duration_seconds": 300,
        "magnitude": -2.5,
        "bright": True,
        "rating": "great",
        "sun_up": False,
        "cloud_cover": 12,
        "appears_from_shadow": True,
        "disappears_into_shadow": False,
        "confidence": "high",
        "upcoming": [
            {
                "pass_id": str(int(start.timestamp())),
                "title": "ISS +1",
                "pass_start": start,
                "pass_end": start + timedelta(seconds=360),
                "satellite": "ISS",
                "start": start,
                "end": start + timedelta(seconds=300),
                "peak_elevation": 40.4,
                "peak_direction": "NW",
                "duration_seconds": 300,
                "magnitude": -2.5,
                "bright": True,
                "rating": "great",
                "cloud_cover": 12,
            }
        ],
    }


async def test_times_are_local_and_to_the_second(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    await hass.config.async_set_time_zone("Pacific/Honolulu")
    start = (NOW + timedelta(hours=1)).replace(microsecond=250000)
    await location_with(hass, predict_passes, dim_pass(start))
    attributes = state_of(hass, NEXT_PASS).attributes
    one = attributes["upcoming"][0]
    for moment in (attributes["start"], attributes["pass_start"], one["start"], one["pass_start"]):
        assert moment.microsecond == 0
        assert moment.utcoffset() == timedelta(hours=-10)


async def test_each_sensor_says_one_thing_about_the_next_visible_pass(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    start = NOW + timedelta(hours=1)
    p = listed(
        sighting(
            start,
            300,
            name="ISS",
            norad_id=25544,
            peak_magnitude=-2.46,
            best_view=(315.0, 40.44),
        ),
        cloud_cover=12,
    )
    await location_with(hass, predict_passes, p)

    elevation = state_of(hass, PEAK_ELEVATION)
    assert (elevation.state, elevation.attributes["unit_of_measurement"]) == ("40.4", "°")
    assert state_of(hass, BRIGHTNESS).state == "-2.5"
    assert "unit_of_measurement" not in state_of(hass, BRIGHTNESS).attributes
    duration = state_of(hass, DURATION)
    assert duration.attributes["device_class"] == "duration"
    # 300 seconds, shown in minutes.
    assert (float(duration.state), duration.attributes["unit_of_measurement"]) == (5.0, "min")
    cloud = state_of(hass, CLOUD_COVER)
    assert (cloud.state, cloud.attributes["unit_of_measurement"]) == ("12", "%")
    name = state_of(hass, SATELLITE_NAME)
    assert name.state == "ISS"
    assert name.attributes["catalog_number"] == 25544
    assert name.attributes["kind"] == "iss"
    assert name.attributes["about_url"].endswith("International_Space_Station")


async def test_the_sensors_describe_the_brightest_of_a_group(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    start = NOW + timedelta(hours=1)
    p = listed(
        sighting(start, 500, name="FAINT", norad_id=1, peak_magnitude=1.5, best_view=(90.0, 80.0)),
        sighting(start, 100, peak_magnitude=-1.0, best_view=(180.0, 30.0)),
    )
    await location_with(hass, predict_passes, p)
    assert state_of(hass, SATELLITE_NAME).state == "ISS"
    assert state_of(hass, PEAK_ELEVATION).state == "30.0"
    assert state_of(hass, BRIGHTNESS).state == "-1.0"
    assert float(state_of(hass, DURATION).state) == pytest.approx(100 / 60)
    # The upcoming list names the group, in a title of its own.
    assert state_of(hass, NEXT_PASS).attributes["upcoming"][0]["title"] == "ISS +1"


COMMON_ATTRIBUTES = {"attribution", "device_class", "friendly_name", "icon"}


async def test_the_description_is_of_the_brightest_when_it_appears_later(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    start = NOW + timedelta(hours=1)
    p = listed(
        sighting(start, 500, name="FAINT", norad_id=1, peak_magnitude=1.5, appears=(90.0, 10.0)),
        sighting(start + timedelta(seconds=100), 100, peak_magnitude=-1.0, appears=(180.0, 20.0)),
    )
    await location_with(hass, predict_passes, p)
    state = state_of(hass, NEXT_PASS)
    attributes = state.attributes
    assert attributes["satellite"] == "ISS"
    assert attributes["start_direction"] == "S"
    assert attributes["start"] == start + timedelta(seconds=100)
    assert attributes["duration_seconds"] == 100
    assert attributes["about_url"] == "https://en.wikipedia.org/wiki/International_Space_Station"
    # The state is when the first of them appears, and pass_end is when the last has gone.
    assert state.state == stamp(start)
    assert attributes["pass_start"] == start
    assert attributes["pass_end"] == start + timedelta(seconds=500)


async def test_no_forecast_for_a_pass_means_no_cloud_cover(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    await location_with(hass, predict_passes, dim_pass(NOW + timedelta(hours=1)))
    assert state_of(hass, NEXT_PASS).attributes["cloud_cover"] is None
    assert state_of(hass, CLOUD_COVER).state == "unknown"


async def test_satellites_list_at_most_fifteen_names_with_the_brightest_first(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    start = NOW + timedelta(hours=1)
    many = [
        sighting(start, 300, name=f"STARLINK-{n}", norad_id=n, peak_magnitude=2.0)
        for n in range(1, 17)
    ]
    many[5].peak_magnitude = 1.0
    await location_with(hass, predict_passes, listed(*many))
    attributes = state_of(hass, NEXT_PASS).attributes
    assert attributes["satellite_count"] == 16
    assert len(attributes["satellites"]) == 15
    assert attributes["satellites"][:2] == ["STARLINK-6", "STARLINK-1"]
    assert attributes["satellite"] == "STARLINK-6"


async def test_exactly_fifteen_satellites_are_all_named(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    start = NOW + timedelta(hours=1)
    many = [sighting(start, 300, name=f"S{n}", norad_id=n) for n in range(1, 16)]
    await location_with(hass, predict_passes, listed(*many))
    assert len(state_of(hass, NEXT_PASS).attributes["satellites"]) == 15


async def test_long_attributes_stay_out_of_the_recorder(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    await location_with(hass, predict_passes, bright_pass(NOW + timedelta(minutes=1)))
    for entity_id, attributes in (
        (NEXT_PASS, {"upcoming", "satellites", "about_url"}),
        (NEXT_BRIGHT, {"upcoming", "satellites", "about_url"}),
        (SATELLITE_NAME, {"about_url"}),
        (UNDER_WAY, {"satellites", "about_url"}),
        (VISIBLE_SOON, {"satellites", "about_url"}),
        (BRIGHT_SOON, {"satellites", "about_url"}),
        (ELEVATION, {"satellite", "catalog_number", "azimuth", "direction", "range_km", "sunlit"}),
        (POSITION, {"satellite", "catalog_number", "altitude_km", "sunlit"}),
    ):
        info = state_of(hass, entity_id).state_info
        assert info is not None
        assert attributes <= info["unrecorded_attributes"], entity_id


# The next bright pass.


async def test_the_next_bright_pass_passes_over_the_dim_ones(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    dim = dim_pass(NOW + timedelta(minutes=10), 60)
    bright = bright_pass(NOW + timedelta(minutes=30), 60)
    await location_with(hass, predict_passes, dim, bright)
    assert state_of(hass, NEXT_PASS).attributes["pass_id"] == dim.id
    state = state_of(hass, NEXT_BRIGHT)
    assert state.state == stamp(bright.start)
    assert state.attributes["pass_id"] == bright.id
    assert state.attributes["bright"] is True
    assert state.attributes["device_class"] == "timestamp"
    assert "upcoming" not in state.attributes

    await advance(hass, freezer, bright.end + SECOND)
    state = state_of(hass, NEXT_BRIGHT)
    assert state.state == "unknown"
    assert "pass_id" not in state.attributes


async def test_only_dim_passes_leave_it_unknown(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    await location_with(hass, predict_passes, dim_pass(NOW + timedelta(hours=1)))
    assert state_of(hass, NEXT_BRIGHT).state == "unknown"


# How many passes are coming.


async def test_the_count_is_of_what_is_under_way_or_starts_within_a_day(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    first = dim_pass(NOW + timedelta(minutes=30))
    second = dim_pass(NOW + timedelta(hours=24), name="SL-16 R/B", norad_id=22285)
    third = dim_pass(NOW + timedelta(hours=24) + SECOND, name="LATER", norad_id=3)
    await location_with(hass, predict_passes, first, second, third)
    state = state_of(hass, WITHIN_A_DAY)
    assert state.state == "2"
    assert state.attributes["unit_of_measurement"] == "passes"


async def test_a_pass_joins_the_count_a_day_ahead(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(hours=25, minutes=30))
    await location_with(hass, predict_passes, p)
    assert state_of(hass, WITHIN_A_DAY).state == "0"

    joins = p.start - timedelta(hours=24)
    await advance(hass, freezer, joins - SECOND)
    assert state_of(hass, WITHIN_A_DAY).state == "0"
    await advance(hass, freezer, joins + SECOND)
    assert state_of(hass, WITHIN_A_DAY).state == "1"


async def test_a_pass_leaves_the_count_when_it_ends_not_when_it_starts(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(minutes=10), 60)
    await location_with(hass, predict_passes, p)
    await advance(hass, freezer, p.start + SECOND)
    assert state_of(hass, WITHIN_A_DAY).state == "1"
    await advance(hass, freezer, p.end)
    assert state_of(hass, WITHIN_A_DAY).state == "1"
    await advance(hass, freezer, p.end + SECOND)
    assert state_of(hass, WITHIN_A_DAY).state == "0"


@pytest.mark.parametrize(("count", "listed_count"), [(20, 20), (21, 20)])
async def test_the_list_holds_twenty_while_the_count_has_them_all(
    hass: HomeAssistant,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
    count: int,
    listed_count: int,
) -> None:
    passes = [dim_pass(NOW + timedelta(minutes=10 * n), 60) for n in range(1, count + 1)]
    await location_with(hass, predict_passes, *passes)
    assert state_of(hass, WITHIN_A_DAY).state == str(count)
    ids = [one["pass_id"] for one in state_of(hass, NEXT_PASS).attributes["upcoming"]]
    assert ids == [p.id for p in passes[:listed_count]]


async def test_the_list_drops_a_pass_when_it_ends(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    first = dim_pass(NOW + timedelta(minutes=10), 60)
    second = dim_pass(NOW + timedelta(minutes=30), 60)
    await location_with(hass, predict_passes, first, second)
    await advance(hass, freezer, first.end + SECOND)
    upcoming = state_of(hass, NEXT_PASS).attributes["upcoming"]
    assert [one["pass_id"] for one in upcoming] == [second.id]


# On during a pass.


async def test_satellite_visible_now_turns_on_and_off_a_moment_after_the_change(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(minutes=10), 60)
    await location_with(hass, predict_passes, p)
    assert state_of(hass, UNDER_WAY).state == "off"
    assert "pass_id" not in state_of(hass, UNDER_WAY).attributes

    await advance(hass, freezer, p.start)
    assert state_of(hass, UNDER_WAY).state == "off"

    await advance(hass, freezer, p.start + SECOND)
    state = state_of(hass, UNDER_WAY)
    assert state.state == "on"
    assert state.attributes["pass_id"] == p.id
    assert state.attributes["satellite"] == "ISS"

    await advance(hass, freezer, p.end)
    assert state_of(hass, UNDER_WAY).state == "on"

    await advance(hass, freezer, p.end + SECOND)
    state = state_of(hass, UNDER_WAY)
    assert state.state == "off"
    assert "pass_id" not in state.attributes


# A pass soon.


async def test_visible_pass_soon_gives_notice_of_any_pass_until_it_ends(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(hours=1), 60)
    await location_with(hass, predict_passes, p)
    assert state_of(hass, VISIBLE_SOON).state == "off"
    assert "pass_id" not in state_of(hass, VISIBLE_SOON).attributes

    notice = p.start - timedelta(minutes=15)
    await advance(hass, freezer, notice)
    assert state_of(hass, VISIBLE_SOON).state == "off"

    await advance(hass, freezer, notice + SECOND)
    state = state_of(hass, VISIBLE_SOON)
    assert state.state == "on"
    assert state.attributes["pass_id"] == p.id
    # A dim pass is not a bright one.
    assert state_of(hass, BRIGHT_SOON).state == "off"

    await advance(hass, freezer, p.start + SECOND)
    assert state_of(hass, VISIBLE_SOON).state == "on"
    await advance(hass, freezer, p.end + SECOND)
    assert state_of(hass, VISIBLE_SOON).state == "off"


async def test_visible_pass_soon_stays_on_across_passes_closer_than_the_notice(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    first = dim_pass(NOW + timedelta(hours=1), 60)
    second = dim_pass(first.end + timedelta(minutes=5), 60)
    await location_with(hass, predict_passes, first, second)
    await advance(hass, freezer, first.end + SECOND)
    state = state_of(hass, VISIBLE_SOON)
    assert state.state == "on"
    assert state.attributes["pass_id"] == second.id


async def test_bright_pass_soon_is_on_from_the_notice_until_the_pass_ends(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = bright_pass(NOW + timedelta(hours=1), 60)
    await location_with(hass, predict_passes, p)
    assert state_of(hass, BRIGHT_SOON).state == "off"
    assert "pass_id" not in state_of(hass, BRIGHT_SOON).attributes

    notice = p.start - timedelta(minutes=15)
    await advance(hass, freezer, notice)
    assert state_of(hass, BRIGHT_SOON).state == "off"

    await advance(hass, freezer, notice + SECOND)
    state = state_of(hass, BRIGHT_SOON)
    assert state.state == "on"
    assert state.attributes["pass_id"] == p.id

    await advance(hass, freezer, p.start + SECOND)
    assert state_of(hass, BRIGHT_SOON).state == "on"

    await advance(hass, freezer, p.end + SECOND)
    state = state_of(hass, BRIGHT_SOON)
    assert state.state == "off"
    assert "pass_id" not in state.attributes


@pytest.mark.parametrize("minutes", [1, 240])
async def test_bright_pass_soon_follows_the_advance_notice_option(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
    minutes: int,
) -> None:
    p = bright_pass(NOW + timedelta(hours=5, minutes=30))
    await location_with(hass, predict_passes, p, options={"alert_lead_minutes": minutes})
    notice = p.start - timedelta(minutes=minutes)
    await advance(hass, freezer, notice - SECOND)
    assert state_of(hass, BRIGHT_SOON).state == "off"
    await advance(hass, freezer, notice)
    assert state_of(hass, BRIGHT_SOON).state == "off"
    await advance(hass, freezer, notice + SECOND)
    assert state_of(hass, BRIGHT_SOON).state == "on"


async def test_a_dim_pass_gives_no_notice(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(minutes=10), 60)
    await location_with(hass, predict_passes, p)
    await advance(hass, freezer, p.start + SECOND)
    assert state_of(hass, BRIGHT_SOON).state == "off"


async def test_the_notice_counts_from_when_the_bright_satellite_appears(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    # README: "On from the advance notice before a bright satellite appears".
    start = NOW + timedelta(hours=1)
    p = listed(
        sighting(start, 3000, name="FAINT", norad_id=1, peak_magnitude=1.8),
        sighting(start + timedelta(minutes=40), 100, peak_magnitude=-2.0),
    )
    await location_with(hass, predict_passes, p)
    notice = start + timedelta(minutes=25)
    await advance(hass, freezer, start + SECOND)
    assert state_of(hass, UNDER_WAY).state == "on"
    assert state_of(hass, BRIGHT_SOON).state == "off"
    await advance(hass, freezer, notice)
    assert state_of(hass, BRIGHT_SOON).state == "off"
    await advance(hass, freezer, notice + SECOND)
    assert state_of(hass, BRIGHT_SOON).state == "on"


# Availability.


async def test_paused_predictions_leave_only_the_epoch_sensor_available(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    await add_location(hass)
    predictions = (
        NEXT_PASS, PEAK_ELEVATION, BRIGHTNESS, DURATION, CLOUD_COVER, SATELLITE_NAME, NEXT_BRIGHT,
        WITHIN_A_DAY, ELEVATION, UNDER_WAY, VISIBLE_SOON, BRIGHT_SOON, CALENDAR,
    )  # fmt: skip
    for entity_id in predictions:
        assert state_of(hass, entity_id).state != "unavailable", entity_id

    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    await advance(hass, freezer, NOW + timedelta(days=20))

    for entity_id in predictions:
        assert state_of(hass, entity_id).state == "unavailable", entity_id
    state = state_of(hass, EPOCH)
    assert state.state == stamp(NOW)
    assert state.attributes["stale"] is True
    assert state.attributes["last_download_error"] == "no route"
    assert state.attributes["age_days"] == 20.0


# The epoch sensor.


async def test_the_epoch_sensor_says_how_old_the_orbits_are_and_when_they_came(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    epoch = NOW - timedelta(days=2, hours=12, minutes=30)
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, epoch) for s in satellites()]
    await add_location(hass)
    state = state_of(hass, EPOCH)
    assert state.state == stamp(epoch)
    assert state.attributes["device_class"] == "timestamp"
    assert state.attributes["downloaded"] == NOW
    assert state.attributes["catalog_size"] == 48
    assert state.attributes["age_days"] == 2.5
    assert state.attributes["stale"] is False
    assert state.attributes["last_download_error"] is None


async def test_the_epoch_sensor_reports_a_refusal_and_keeps_its_dates(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = DownloadRefused("HTTP 403")
    await advance(hass, freezer, NOW + timedelta(hours=12))
    state = state_of(hass, EPOCH)
    assert state.state == stamp(NOW)
    assert state.attributes["downloaded"] == NOW
    assert state.attributes["last_download_error"] == "HTTP 403"
    assert state.attributes["stale"] is False


async def test_the_epoch_sensor_follows_a_new_download(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    await add_location(hass)
    later = NOW + timedelta(hours=12)
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, later) for s in satellites()[:3]]
    await advance(hass, freezer, later)
    state = state_of(hass, EPOCH)
    assert state.state == stamp(later)
    assert state.attributes["downloaded"] == later
    assert state.attributes["catalog_size"] == 3


async def test_the_epoch_sensor_goes_on_saying_how_old_the_orbits_are_while_paused(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    """Home Assistant tells entities only of the first failure in a row, and passes run out."""
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    await advance(hass, freezer, NOW + timedelta(days=20))
    assert state_of(hass, EPOCH).attributes["age_days"] == 20.0

    mock_downloads["fetch_catalog"].side_effect = CatalogError("still no route")
    await advance(hass, freezer, NOW + timedelta(days=30))
    state = state_of(hass, EPOCH)
    assert state.attributes["age_days"] == 30.0
    assert state.attributes["last_download_error"] == "still no route"


async def test_the_upcoming_list_means_what_the_attributes_and_sensors_mean(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    start = NOW + timedelta(hours=1)
    later = start + timedelta(seconds=100)
    p = listed(
        sighting(start, 600, name="FAINT", norad_id=1, peak_magnitude=1.5, best_view=(90.0, 80.0)),
        sighting(later, 120, peak_magnitude=-1.0, best_view=(180.0, 30.0)),
    )
    await location_with(hass, predict_passes, p)
    attributes = state_of(hass, NEXT_PASS).attributes
    (one,) = attributes["upcoming"]
    # No key is both the brightest's and the group's: only the title is the list's own.
    assert one["title"] == "ISS +1"
    shared = set(one) - {"title"}
    assert {key: one[key] for key in shared} == {key: attributes[key] for key in shared}
    # Worked out by hand, so that the two cannot simply agree on the wrong thing.
    assert one["satellite"] == state_of(hass, SATELLITE_NAME).state == "ISS"
    assert (one["pass_start"], one["pass_end"]) == (start, start + timedelta(seconds=600))
    assert (one["start"], one["end"]) == (later, later + timedelta(seconds=120))
    assert one["duration_seconds"] == 120
    assert float(state_of(hass, DURATION).state) == pytest.approx(120 / 60)
    assert (one["peak_elevation"], one["peak_direction"]) == (30.0, "S")
    assert state_of(hass, PEAK_ELEVATION).state == "30.0"
    assert one["magnitude"] == -1.0


async def test_with_no_catalog_the_epoch_sensor_is_unavailable_and_says_so(
    hass: HomeAssistant,
) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    coordinator = SatelliteSpotterCoordinator(hass, entry, CatalogManager(hass))
    sensor = OrbitalElementsEpochSensor(coordinator, "orbital_elements_epoch")
    assert sensor.available is False
    assert sensor.native_value is None
    assert sensor.extra_state_attributes == {
        "downloaded": None,
        "catalog_size": 0,
        "age_days": None,
        "stale": False,
        "last_download_error": None,
    }
    await coordinator.async_shutdown()


async def test_before_any_predictions_the_entities_have_nothing_to_say(
    hass: HomeAssistant,
) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    coordinator = SatelliteSpotterCoordinator(hass, entry, CatalogManager(hass))
    assert VisiblePassCountSensor(coordinator, "visible_passes_next_24_hours").native_value == 0
    for description in PASS_SENSORS:
        sensor = PassSensor(coordinator, description)
        assert sensor.native_value is None
        assert not sensor.extra_state_attributes or sensor.extra_state_attributes == {
            "upcoming": []
        }
    for binary in BINARY_SENSORS:
        sensor = PassBinarySensor(coordinator, binary)
        assert sensor.is_on is False
        assert sensor.extra_state_attributes == {}
    elevation = SatelliteElevationSensor(coordinator, "satellite_elevation")
    assert elevation.native_value is None
    assert elevation.extra_state_attributes == {}
    await coordinator.async_shutdown()


async def test_a_location_stays_loaded_through_a_failed_refresh(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    await advance(hass, freezer, NOW + timedelta(days=20))
    assert entry.state is ConfigEntryState.LOADED


# The words a pass is described in.


@pytest.mark.parametrize(
    ("azimuth", "point"),
    [
        (0.0, "N"),
        (11.24, "N"),
        (11.25, "NNE"),
        (33.74, "NNE"),
        (33.75, "NE"),
        (45.0, "NE"),
        (67.5, "ENE"),
        (90.0, "E"),
        (112.5, "ESE"),
        (135.0, "SE"),
        (157.5, "SSE"),
        (180.0, "S"),
        (202.5, "SSW"),
        (225.0, "SW"),
        (247.5, "WSW"),
        (270.0, "W"),
        (292.5, "WNW"),
        (315.0, "NW"),
        (337.5, "NNW"),
        (348.74, "NNW"),
        (348.75, "N"),
        (359.99, "N"),
        (360.0, "N"),
        (375.0, "NNE"),
        (-11.25, "N"),
        (-11.26, "NNW"),
    ],
)
def test_compass_gives_the_nearest_of_sixteen_points(azimuth: float, point: str) -> None:
    assert compass(azimuth) == point


@pytest.mark.parametrize(
    ("value", "rounded"),
    [(-2.46, -2.5), (-2.44, -2.4), (1.26, 1.3), (0.0, 0.0), (2.04, 2.0)],
)
def test_magnitude_is_rounded_to_one_decimal(value: float, rounded: float) -> None:
    assert magnitude(value) == rounded


@pytest.mark.parametrize("value", [-0.04, -0.0, 0.04])
def test_magnitude_is_never_negative_zero(value: float) -> None:
    assert str(magnitude(value)) == "0.0"


@pytest.mark.parametrize(
    ("norad_id", "name", "kind"),
    [
        (25544, "ISS (ZARYA)", "iss"),
        (25544, "anything", "iss"),
        (48274, "CSS (TIANHE)", "tiangong"),
        (20580, "HST", "hubble"),
        (1, "STARLINK-1020", "starlink"),
        (1, "starlink-1020", "starlink"),
        (1, "SL-16 R/B", "rocket"),
        (1, "sl-16 r/b", "rocket"),
        (1, "DELTA 2 PKM", "rocket"),
        (1, "IUS AKM", "rocket"),
        (1, "COSMOS 2251 DEB", "debris"),
        (1, "cosmos deb", "debris"),
        (1, "LACROSSE 5", "satellite"),
    ],
)
def test_satellite_kind_says_what_it_is(norad_id: int, name: str, kind: str) -> None:
    assert satellite_kind(norad_id, name) == kind


@pytest.mark.parametrize(
    ("days", "expected"),
    [
        (0.0, "high"),
        (3.0, "high"),
        (3.0 + 1 / 86400, "medium"),
        (7.0, "medium"),
        (7.0 + 1 / 86400, "low"),
        (-3.0, "high"),
        (-3.0 - 1 / 86400, "medium"),
        (-7.0 - 1 / 86400, "low"),
    ],
)
def test_confidence_falls_with_distance_from_the_epoch(days: float, expected: str) -> None:
    # README: Medium confidence more than 3 days from the elements, Low beyond a week.
    sat = made_up_satellite(epoch=NOW)
    assert confidence(NOW + timedelta(seconds=round(days * 86400)), sat) == expected


# The satellite elevation sensor.


async def test_the_elevation_is_of_the_satellite_of_the_next_visible_pass(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    state = state_of(hass, ELEVATION)
    p = init_integration.runtime_data.next_visible_pass(NOW)
    assert state.attributes["satellite"] == p.lead.satellite.name == "ISS"
    assert state.attributes["catalog_number"] == 25544
    assert state.attributes["unit_of_measurement"] == "°"
    assert -90.0 <= float(state.state) <= 90.0
    assert state.attributes["direction"] == compass(state.attributes["azimuth"])
    assert state.attributes["range_km"] > 0
    assert isinstance(state.attributes["sunlit"], bool)


async def test_the_elevation_agrees_with_the_search_as_the_satellite_appears(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    p = init_integration.runtime_data.next_visible_pass(NOW)
    await advance(hass, freezer, p.lead.appears.time)
    state = state_of(hass, ELEVATION)
    assert float(state.state) == pytest.approx(p.lead.appears.elevation, abs=0.2)
    assert state.attributes["azimuth"] == pytest.approx(p.lead.appears.azimuth, abs=0.2)
    assert state.attributes["sunlit"] is True


async def test_the_elevation_is_looked_up_every_minute_and_every_ten_seconds_during_a_pass(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    before = state_of(hass, ELEVATION).state
    await advance(hass, freezer, NOW + timedelta(seconds=59))
    assert state_of(hass, ELEVATION).state == before
    await advance(hass, freezer, NOW + timedelta(seconds=60))
    assert state_of(hass, ELEVATION).state != before

    p = init_integration.runtime_data.next_visible_pass(NOW)
    during = p.start + timedelta(seconds=30)
    await advance(hass, freezer, during)
    await advance(hass, freezer, during + timedelta(seconds=60))
    before = state_of(hass, ELEVATION).state
    await advance(hass, freezer, during + timedelta(seconds=69))
    assert state_of(hass, ELEVATION).state == before
    await advance(hass, freezer, during + timedelta(seconds=70))
    assert state_of(hass, ELEVATION).state != before


async def test_the_elevation_moves_on_to_the_next_satellite_when_a_pass_ends(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    real = {sat.norad_id: sat for sat in satellites()}
    first = listed(replace(sighting(NOW + timedelta(minutes=10), 60), satellite=real[25544]))
    second = listed(
        replace(
            sighting(NOW + timedelta(minutes=30), 60, name="Hubble", norad_id=20580),
            satellite=real[20580],
        )
    )
    await location_with(hass, predict_passes, first, second)
    assert state_of(hass, ELEVATION).attributes["satellite"] == "ISS"
    await advance(hass, freezer, first.end + SECOND)
    # At once, with the other sensors, rather than at the next look.
    assert state_of(hass, ELEVATION).attributes["satellite"] == "Hubble"
    assert state_of(hass, SATELLITE_NAME).state == "Hubble"


async def test_the_elevation_says_nothing_of_a_satellite_sgp4_cannot_place(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    with patch("custom_components.satellite_spotter.track.satellite_position", return_value=None):
        await advance(hass, freezer, NOW + timedelta(seconds=60))
    assert init_integration.runtime_data.live is None
    state = state_of(hass, ELEVATION)
    assert state.state == "unknown"
    assert "satellite" not in state.attributes
    assert state_of(hass, POSITION).state == "unknown"


async def test_the_live_entities_round_what_they_say(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    coordinator = init_integration.runtime_data
    position = SatellitePosition(359.96, 42.26, 1234.5, 21.30694, -157.85834, 418.26, False)
    coordinator.live = LiveSatellite(made_up_satellite(), position)
    elevation = SatelliteElevationSensor(coordinator, "satellite_elevation")
    assert elevation.native_value == 42.3
    assert elevation.extra_state_attributes == {
        "satellite": "ISS",
        "catalog_number": 25544,
        "azimuth": 360.0,
        "direction": "N",
        "range_km": 1234,
        "sunlit": False,
    }
    tracker = SatellitePositionTracker(coordinator, "satellite_position")
    assert (tracker.latitude, tracker.longitude) == (21.3069, -157.8583)
    assert tracker.extra_state_attributes == {
        "satellite": "ISS",
        "catalog_number": 25544,
        "altitude_km": 418.3,
        "sunlit": False,
    }
    assert tracker.force_update is False


# The satellite position tracker.


async def test_the_tracker_is_at_the_point_beneath_the_satellite(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    coordinator = init_integration.runtime_data
    sat = coordinator.next_visible_pass(NOW).lead.satellite
    later = NOW + timedelta(seconds=60)
    await advance(hass, freezer, later)
    state = state_of(hass, POSITION)
    place = track.propagate([sat.sgp4_record()], [later.timestamp()])[0]
    latitude, longitude, altitude = track.geodetic(place[0])
    assert state.attributes["latitude"] == pytest.approx(float(latitude), abs=1e-3)
    assert state.attributes["longitude"] == pytest.approx(float(longitude), abs=1e-3)
    assert state.attributes["altitude_km"] == pytest.approx(float(altitude), abs=0.1)
    assert state.attributes["satellite"] == "ISS"
    assert state.attributes["catalog_number"] == 25544
    assert isinstance(state.attributes["sunlit"], bool)
    assert state.attributes["source_type"] == "gps"
    # Somewhere other than home, as Home Assistant reckons a tracker's state.
    assert state.state == "not_home"


async def test_the_tracker_moves_with_the_sensor(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    before = state_of(hass, POSITION).attributes["latitude"]
    await advance(hass, freezer, NOW + timedelta(seconds=59))
    assert state_of(hass, POSITION).attributes["latitude"] == before
    await advance(hass, freezer, NOW + timedelta(seconds=60))
    assert state_of(hass, POSITION).attributes["latitude"] != before


async def test_with_no_pass_the_tracker_has_nothing_to_say(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    await location_with(hass, predict_passes)
    state = state_of(hass, POSITION)
    assert state.state == "unknown"
    assert "latitude" not in state.attributes or state.attributes["latitude"] is None
    assert "satellite" not in state.attributes


async def test_paused_predictions_leave_the_tracker_unavailable(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    await advance(hass, freezer, NOW + timedelta(days=20))
    assert state_of(hass, POSITION).state == "unavailable"


# The live position they share.


async def test_each_look_is_one_piece_of_work_for_both_entities(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    with patch(
        "custom_components.satellite_spotter.track.satellite_position",
        wraps=track.satellite_position,
    ) as looked_up:
        await advance(hass, freezer, NOW + timedelta(seconds=60))
    looked_up.assert_called_once()


async def test_one_live_entity_disabled_leaves_the_other_moving(
    hass: HomeAssistant,
    entity_registry: er.EntityRegistry,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    entry = await add_location(hass)
    entity_registry.async_update_entity(ELEVATION, disabled_by=er.RegistryEntryDisabler.USER)
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    before = state_of(hass, POSITION).attributes["latitude"]
    await advance(hass, freezer, NOW + timedelta(seconds=60))
    assert state_of(hass, POSITION).attributes["latitude"] != before


async def test_with_both_live_entities_disabled_nothing_is_worked_out(
    hass: HomeAssistant,
    entity_registry: er.EntityRegistry,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    entry = await add_location(hass)
    for entity_id in (ELEVATION, POSITION):
        entity_registry.async_update_entity(entity_id, disabled_by=er.RegistryEntryDisabler.USER)
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get(ELEVATION) is None
    assert hass.states.get(POSITION) is None
    with patch("custom_components.satellite_spotter.track.satellite_position") as looked_up:
        await advance(hass, freezer, NOW + timedelta(minutes=5))
        await entry.runtime_data.async_refresh()
    looked_up.assert_not_called()
    assert entry.runtime_data.live is None


async def test_a_listener_going_leaves_the_others_listening(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass)
    coordinator = entry.runtime_data
    heard = MagicMock()
    remove = coordinator.async_add_live_listener(heard)
    await advance(hass, freezer, NOW + timedelta(seconds=60))
    heard.assert_called_once()
    remove()
    assert coordinator.live is not None, "the entities are still listening"


async def test_unloading_stops_the_looking(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    coordinator = init_integration.runtime_data
    await hass.config_entries.async_unload(init_integration.entry_id)
    await hass.async_block_till_done()
    assert coordinator.live is None
    with patch("custom_components.satellite_spotter.track.satellite_position") as looked_up:
        await advance(hass, freezer, NOW + timedelta(minutes=5))
    looked_up.assert_not_called()


async def test_a_shut_down_coordinator_does_not_look_again(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    coordinator = SatelliteSpotterCoordinator(hass, entry, CatalogManager(hass))
    remove = coordinator.async_add_live_listener(MagicMock())
    await coordinator.async_shutdown()
    with patch("custom_components.satellite_spotter.track.satellite_position") as looked_up:
        coordinator._async_look_up()
    looked_up.assert_not_called()
    remove()
