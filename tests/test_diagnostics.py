"""Diagnostics: counts only, and nothing that gives away a location or a key."""

from __future__ import annotations

from datetime import timedelta
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.diagnostics import (
    get_diagnostics_for_config_entry,
)
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.satellite_spotter.catalog import CatalogManager
from custom_components.satellite_spotter.celestrak import CatalogError
from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.coordinator import SatelliteSpotterCoordinator
from custom_components.satellite_spotter.diagnostics import async_get_config_entry_diagnostics
from custom_components.satellite_spotter.weather import CloudCoverError

from .common import (
    FIRST_PASS_ID,
    HONOLULU,
    NOW,
    add_location,
    advance,
    bright_pass,
    dim_pass,
    listed,
    satellites,
    sighting,
    with_epoch,
)

REDACTED = "**REDACTED**"
GOOGLE_KEY = "AIzaVerySecret"
TOKEN = "MLY|1234|verysecret"


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


async def test_the_place_is_redacted_and_the_rest_is_counts_over_http(
    hass: HomeAssistant, hass_client: ClientSessionGenerator, init_integration: MockConfigEntry
) -> None:
    diagnostics: Any = await get_diagnostics_for_config_entry(hass, hass_client, init_integration)
    assert diagnostics["entry"] == {
        "latitude": REDACTED,
        "longitude": REDACTED,
        "elevation": REDACTED,
    }
    assert diagnostics["options"] == {}
    assert diagnostics["now"] == NOW.isoformat()
    assert diagnostics["last_update_success"] is True
    assert diagnostics["paused"] is None


async def test_nothing_gives_away_where_or_when(
    hass: HomeAssistant, hass_client: ClientSessionGenerator, init_integration: MockConfigEntry
) -> None:
    # diagnostics.py: the times and look angles of passes would reveal the location.
    diagnostics = await get_diagnostics_for_config_entry(hass, hass_client, init_integration)
    text = json.dumps(diagnostics)
    assert "21.3069" not in text
    assert "157.8583" not in text
    assert FIRST_PASS_ID not in text
    assert "azimuth" not in text
    assert "2026-11-04T15:39" not in text


async def test_keys_in_the_options_are_redacted(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    options = {
        "brightness_cutoff": 1.0,
        "street_view": {
            "street_source": "google",
            "google_api_key": GOOGLE_KEY,
            "mapillary_token": TOKEN,
        },
    }
    entry = await add_location(hass, options=options)
    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert diagnostics["options"] == {
        "brightness_cutoff": 1.0,
        "street_view": {
            "street_source": "google",
            "google_api_key": REDACTED,
            "mapillary_token": REDACTED,
        },
    }
    text = json.dumps(diagnostics)
    assert GOOGLE_KEY not in text
    assert TOKEN not in text


async def test_the_catalog_is_described(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    catalog = [
        with_epoch(sat, NOW - timedelta(days=days))
        for sat, days in zip(satellites()[:3], (1, 2.5, 7), strict=True)
    ]
    mock_downloads["fetch_catalog"].return_value = catalog
    entry = await add_location(hass)
    assert await async_get_config_entry_diagnostics(hass, entry) == {
        **(await async_get_config_entry_diagnostics(hass, entry)),
        "catalog": {
            "updated": NOW.isoformat(),
            "version": int(NOW.timestamp()),
            "satellites": 3,
            "median_epoch_age_days": 2.5,
            "oldest_epoch": (NOW - timedelta(days=7)).isoformat(),
            "newest_epoch": (NOW - timedelta(days=1)).isoformat(),
            "last_error": None,
        },
    }


async def test_the_age_has_two_decimals(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].return_value = [
        with_epoch(satellites()[0], NOW - timedelta(days=1, minutes=30))
    ]
    entry = await add_location(hass)
    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert diagnostics["catalog"]["median_epoch_age_days"] == 1.02


async def test_predictions_are_counted_worked_out_by_hand(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    predict_passes.return_value = [
        bright_pass(NOW + timedelta(hours=1)),
        dim_pass(NOW + timedelta(hours=2)),
        listed(
            sighting(NOW + timedelta(hours=3)),
            sighting(NOW + timedelta(hours=3), name="B", norad_id=2),
            sighting(NOW + timedelta(hours=3), name="C", norad_id=3),
        ),
    ]
    entry = await add_location(hass)
    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert diagnostics["predictions"] == {
        "searched_at": NOW.isoformat(),
        "catalog_version": int(NOW.timestamp()),
        "pass_count": 3,
        "bright_pass_count": 2,
        "sighting_count": 5,
        "cloud_forecast": {"enabled": True, "available": True},
    }


async def test_the_forecast_switched_off(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, options={"cloud_forecast": False})
    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert diagnostics["predictions"]["cloud_forecast"] == {"enabled": False, "available": False}


async def test_the_forecast_failing(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_forecast"].side_effect = CloudCoverError("down")
    entry = await add_location(hass)
    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert diagnostics["predictions"]["cloud_forecast"] == {"enabled": True, "available": False}


async def test_paused_predictions_say_why(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    entry = await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    later = NOW + timedelta(days=20)
    await advance(hass, freezer, later)
    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert diagnostics["last_update_success"] is False
    assert diagnostics["paused"]
    assert diagnostics["catalog"]["last_error"] == "no route"
    assert diagnostics["now"] == later.isoformat()


async def test_with_nothing_yet_there_is_nothing_to_say(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    coordinator = SatelliteSpotterCoordinator(hass, entry, CatalogManager(hass))
    entry.runtime_data = coordinator
    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert diagnostics["catalog"] == {
        "updated": None,
        "version": 0,
        "satellites": 0,
        "median_epoch_age_days": None,
        "oldest_epoch": None,
        "newest_epoch": None,
        "last_error": None,
    }
    assert "predictions" not in diagnostics
    await coordinator.async_shutdown()


async def test_a_location_still_retrying_setup_gets_a_report_of_the_catalog(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    report = await async_get_config_entry_diagnostics(hass, entry)
    assert report["state"] == "setup_retry"
    assert report["catalog"]["satellites"] == 0
    assert report["catalog"]["last_error"] == "no route"
    assert "predictions" not in report
    assert report["entry"]["latitude"] == REDACTED
