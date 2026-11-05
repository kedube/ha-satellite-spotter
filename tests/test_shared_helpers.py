"""The shared helpers mean what they say: other test modules rely on them."""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import AsyncMock

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.celestrak import build_catalog
from custom_components.satellite_spotter.const import DEFAULT_BRIGHTNESS_CUTOFF, PREDICTION_LOOKBACK
from custom_components.satellite_spotter.coordinator import predict_passes
from custom_components.satellite_spotter.predict import Satellite
from custom_components.satellite_spotter.track import Observer

from .common import (
    DENVER,
    FIRST_PASS_ID,
    HONOLULU,
    INTEGRATION,
    NOW,
    ROOT,
    advance,
    cloud_forecast,
    cloud_percent,
    gp_csv,
    satellites,
)


def test_paths_are_the_repository_and_the_integration() -> None:
    assert (ROOT / "pyproject.toml").is_file()
    assert (INTEGRATION / "manifest.json").is_file()


def test_locations_hold_config_entry_data() -> None:
    assert HONOLULU == {"latitude": 21.3069, "longitude": -157.8583, "elevation": 5.0}
    assert DENVER == {"latitude": 39.74, "longitude": -104.99, "elevation": 1609.0}


def test_satellites_are_fresh_each_call() -> None:
    first, second = satellites(), satellites()
    assert first == second
    assert first is not second
    assert first[0] is not second[0]


def test_first_pass_id_is_the_first_pass_predicted_from_now() -> None:
    passes = predict_passes(
        satellites(),
        Observer(HONOLULU["latitude"], HONOLULU["longitude"], HONOLULU["elevation"]),
        start=NOW - PREDICTION_LOOKBACK,
        faintest=DEFAULT_BRIGHTNESS_CUTOFF,
        forecast=None,
    )
    assert passes[0].id == FIRST_PASS_ID


async def test_first_pass_id_is_what_a_location_reports(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    state = hass.states.get("sensor.home_next_visible_pass")
    assert state is not None
    assert state.attributes["pass_id"] == FIRST_PASS_ID


def test_gp_csv_fills_gaps_with_zero_and_ignores_extras() -> None:
    text = gp_csv([{"OBJECT_NAME": "A", "NORAD_CAT_ID": 7, "SOMETHING_ELSE": "dropped"}])
    header, row = text.strip().split("\n")
    assert "SOMETHING_ELSE" not in header
    values = dict(zip(header.split(","), row.split(","), strict=True))
    assert values["OBJECT_NAME"] == "A"
    assert values["NORAD_CAT_ID"] == "7"
    assert values["BSTAR"] == "0"
    assert "dropped" not in row


def test_gp_csv_is_read_by_the_catalog_builder() -> None:
    iss = satellites()[1]
    assert iss.name == "ISS"
    built = build_catalog([gp_csv([dict(iss.elements), dict(iss.elements)])])
    assert [sat.norad_id for sat in built] == [iss.norad_id]
    assert isinstance(built[0], Satellite)
    assert built[0].elements["MEAN_MOTION"] == iss.elements["MEAN_MOTION"]


def test_cloud_forecast_covers_the_days_predicted() -> None:
    forecast = cloud_forecast()
    for hours in range(-1, 5 * 24 + 2):
        moment = NOW + timedelta(hours=hours)
        hour = (int(moment.timestamp()) // 3600 + 1) * 3600
        assert forecast.after(moment) == cloud_percent(hour)
    assert {cloud_percent(hour * 3600) for hour in range(101)} == set(range(101))


async def test_advance_moves_the_clock_and_runs_what_is_due(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    freezer.move_to(NOW)
    ran = []

    async def in_the_background() -> None:
        ran.append("background")

    @callback
    def due(_when: object) -> None:
        ran.append("timer")
        hass.async_create_background_task(in_the_background(), "test background")

    async_call_later(hass, 60, due)
    await advance(hass, freezer, NOW + timedelta(seconds=59))
    assert dt_util.utcnow() == NOW + timedelta(seconds=59)
    assert ran == []
    await advance(hass, freezer, NOW + timedelta(seconds=60))
    assert ran == ["timer", "background"]


async def test_mock_downloads_answer_with_the_catalog(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    assert await mock_downloads["fetch_catalog"](hass) == satellites()
    assert (await mock_downloads["fetch_forecast"]()).after(NOW) is not None
