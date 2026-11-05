"""Setting up a location: the shared catalog, its storage and refreshes, paused predictions."""

from __future__ import annotations

from datetime import datetime, timedelta
from http import HTTPStatus
import json
import logging
import math
from typing import Any
from unittest.mock import AsyncMock, patch

from aiohttp import ClientResponseError, RequestInfo
from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryDisabler, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType, section
from homeassistant.helpers import entity_registry as er, issue_registry as ir
from homeassistant.helpers.selector import TextSelector
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import UpdateFailed
from homeassistant.setup import async_setup_component
from multidict import CIMultiDict, CIMultiDictProxy
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator
from yarl import URL

from custom_components.satellite_spotter.catalog import DATA_CATALOG, async_get_catalog
from custom_components.satellite_spotter.celestrak import (
    GP_URL,
    QUERIES,
    SUPPLEMENTAL_QUERY,
    SUPPLEMENTAL_URL,
    CatalogError,
    DownloadRefused,
)
from custom_components.satellite_spotter.const import (
    CATALOG_REFUSED_RETRY,
    CATALOG_STALE_UPSTREAM,
    CONF_ALERT_LEAD_MINUTES,
    CONF_CLOUD_COVER,
    CONF_GOOGLE_API_KEY,
    CONF_MAPILLARY_TOKEN,
    CONF_STREET_SOURCE,
    CONF_STREET_VIEW,
    DOMAIN,
    ISSUE_CATALOG_STALE,
    STORAGE_KEY,
    STORAGE_SAVE_DELAY,
)
from custom_components.satellite_spotter.coordinator import SatelliteSpotterCoordinator
from custom_components.satellite_spotter.diagnostics import async_get_config_entry_diagnostics
from custom_components.satellite_spotter.frontend import catalog_payload
from custom_components.satellite_spotter.predict import Satellite, read_catalog
from custom_components.satellite_spotter.street import GOOGLE_SESSION_URL, MAPILLARY_IMAGES_URL
from custom_components.satellite_spotter.weather import OPEN_METEO_URL, CloudCoverError

from .common import (
    DENVER,
    DENVER_ID,
    FIRST_PASS,
    HONOLULU,
    NOW,
    add_location,
    advance,
    aged,
    catalog_json,
    gp_csv,
    satellites,
    store_catalog,
)

# The fixture's elements are about 15.5 days old (median) by then.
STALE = NOW + timedelta(days=15)
# Home Assistant's own, taken before the tests' storage stands in for it.
STORE_REMOVE = Store.async_remove


def _stale_issue(hass: HomeAssistant) -> ir.IssueEntry | None:
    return ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_CATALOG_STALE)


def _other_location(**kwargs: Any) -> MockConfigEntry:
    return MockConfigEntry(domain=DOMAIN, title="Cabin", data=DENVER, unique_id=DENVER_ID, **kwargs)


async def test_setup_and_unload(hass: HomeAssistant, init_integration: MockConfigEntry) -> None:
    """The location loads, predicts, and unloads without leaving timers behind."""
    assert init_integration.state is ConfigEntryState.LOADED
    coordinator = init_integration.runtime_data
    assert coordinator.data.passes
    assert coordinator._unsub_boundary is not None
    assert await hass.config_entries.async_unload(init_integration.entry_id)
    assert init_integration.state is ConfigEntryState.NOT_LOADED
    assert coordinator._unsub_boundary is None


async def test_catalog_unavailable(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """Setup is retried while there is no catalog at all, and says why."""
    mock_downloads["fetch_catalog"].side_effect = CatalogError("boom")
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.SETUP_RETRY
    assert mock_config_entry.reason == "No satellite catalog: boom"


@pytest.mark.parametrize(
    ("stored", "key", "placeholders"),
    [
        # No catalog at all: the download fails.
        (None, "catalog_unavailable", {"error": "boom"}),
        # Downloaded an hour ago, and CelesTrak's data is just as old.
        (STALE - timedelta(hours=1), CATALOG_STALE_UPSTREAM, {"age": "15"}),
    ],
)
async def test_setup_errors_are_translatable(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
    stored: datetime | None,
    key: str,
    placeholders: dict[str, str],
) -> None:
    """Why a location cannot start comes with its translation, for the integration card."""
    freezer.move_to(STALE)
    if stored is not None:
        store_catalog(hass_storage, stored)
    mock_downloads["fetch_catalog"].side_effect = CatalogError("boom")
    mock_config_entry.add_to_hass(hass)
    coordinator = SatelliteSpotterCoordinator(hass, mock_config_entry, async_get_catalog(hass))
    await coordinator.async_refresh()
    await coordinator.async_shutdown()
    error = coordinator.last_exception
    assert isinstance(error, UpdateFailed)
    assert (error.translation_domain, error.translation_key) == (DOMAIN, key)
    assert error.translation_placeholders == placeholders


async def test_catalog_restored_from_storage(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """A stored catalog is used when it cannot be refreshed."""
    freezer.move_to(NOW)
    store_catalog(hass_storage, NOW - timedelta(days=1))
    mock_downloads["fetch_catalog"].side_effect = CatalogError("boom")
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.LOADED
    assert hass.states.get("sensor.home_next_pass").state == FIRST_PASS
    catalog = hass.states.get("sensor.home_catalog_updated")
    assert catalog.state == (NOW - timedelta(days=1)).isoformat()
    assert catalog.attributes["last_download_error"] == "boom"
    assert catalog.attributes["stale"] is False


async def test_unreadable_stored_catalog_is_downloaded(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A stored catalog that cannot be read does not block setup."""
    freezer.move_to(NOW)
    hass_storage[STORAGE_KEY] = {
        "version": 1,
        "key": STORAGE_KEY,
        "data": {"updated": NOW.isoformat(), "catalog": [{"magnitude": 1}]},
    }
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.LOADED
    mock_downloads["fetch_catalog"].assert_awaited_once()
    assert "Ignoring the stored satellite catalog" in caplog.text


async def test_fresh_stored_catalog_is_not_downloaded(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """A recently stored catalog saves a download after a restart."""
    freezer.move_to(NOW)
    store_catalog(hass_storage, NOW - timedelta(hours=1))
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.LOADED
    mock_downloads["fetch_catalog"].assert_not_awaited()


async def test_catalog_shared_and_stored(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """All locations share one catalog download, which is stored."""
    freezer.move_to(NOW)
    entries = [mock_config_entry, _other_location()]
    for entry in entries:
        await add_location(hass, entry)
    assert all(entry.state is ConfigEntryState.LOADED for entry in entries)
    mock_downloads["fetch_catalog"].assert_awaited_once()
    assert STORAGE_KEY not in hass_storage

    await advance(hass, freezer, NOW + timedelta(seconds=11))
    stored = hass_storage[STORAGE_KEY]["data"]
    assert stored["updated"] == NOW.isoformat()
    assert len(stored["catalog"]) == 22
    assert len(read_catalog(stored["catalog"])) == 22


async def test_catalog_goes_with_the_last_location(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """The stored catalog stays while any location is left, a disabled one included."""
    freezer.move_to(NOW)
    store_catalog(hass_storage, NOW - timedelta(hours=1))
    other = _other_location()
    for entry in (mock_config_entry, other):
        await add_location(hass, entry)
    await hass.config_entries.async_set_disabled_by(other.entry_id, ConfigEntryDisabler.USER)
    await hass.config_entries.async_remove(mock_config_entry.entry_id)
    await hass.async_block_till_done()
    assert STORAGE_KEY in hass_storage

    await hass.config_entries.async_remove(other.entry_id)
    await hass.async_block_till_done()
    assert STORAGE_KEY not in hass_storage
    assert DATA_CATALOG not in hass.data


async def test_catalog_save_is_cancelled_with_the_last_location(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """A catalog downloaded moments before its location goes is not saved after all."""
    freezer.move_to(NOW)
    await add_location(hass, mock_config_entry)
    assert STORAGE_KEY not in hass_storage
    # Home Assistant's own removal, which cancels the save still to come; the
    # tests' stand-in for it only drops what is stored.
    with patch.object(Store, "async_remove", STORE_REMOVE):
        await hass.config_entries.async_remove(mock_config_entry.entry_id)
        await hass.async_block_till_done()
    await advance(hass, freezer, NOW + timedelta(seconds=11))
    assert STORAGE_KEY not in hass_storage


@pytest.mark.usefixtures("init_integration")
async def test_cloud_cover_failure_is_tolerated(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """Passes are still predicted without a cloud cover forecast."""
    assert hass.states.get("sensor.home_next_pass").attributes["cloud_cover"] == 16
    mock_downloads["fetch_cloud_cover"].side_effect = CloudCoverError("boom")
    await advance(hass, freezer, NOW + timedelta(hours=2, seconds=1))
    assert mock_downloads["fetch_cloud_cover"].await_count == 2
    state = hass.states.get("sensor.home_next_pass")
    assert state.state not in ("unknown", "unavailable")
    assert state.attributes["cloud_cover"] is None


async def test_cloud_cover_can_be_switched_off(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """Without the option, Open-Meteo is never asked (it would learn the location)."""
    freezer.move_to(NOW)
    entry = MockConfigEntry(
        domain=DOMAIN, title="Home", data=HONOLULU, options={CONF_CLOUD_COVER: False}
    )
    await add_location(hass, entry)
    assert entry.state is ConfigEntryState.LOADED
    mock_downloads["fetch_cloud_cover"].assert_not_awaited()
    assert hass.states.get("sensor.home_next_pass").attributes["cloud_cover"] is None
    assert entry.runtime_data.data.cloud_cover is None


async def test_requests_identify_the_integration(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
) -> None:
    """The real download and parsing: CelesTrak and Open-Meteo, with our User-Agent."""
    freezer.move_to(NOW)
    for query in QUERIES:
        aioclient_mock.get(
            GP_URL,
            params={**query, "FORMAT": "csv"},
            text=gp_csv([e["elements"] for e in catalog_json()]),
        )
    aioclient_mock.get(
        SUPPLEMENTAL_URL, params={**SUPPLEMENTAL_QUERY, "FORMAT": "csv"}, text=gp_csv([])
    )
    start = int(NOW.replace(hour=0, minute=0).timestamp())
    aioclient_mock.get(
        OPEN_METEO_URL,
        json={
            "hourly": {
                "time": [start + 3600 * i for i in range(168)],
                "cloud_cover": [i % 100 for i in range(168)],
            }
        },
    )
    brightness = {int(e["elements"]["NORAD_CAT_ID"]): e["magnitude"] for e in catalog_json()}
    with patch(
        "custom_components.satellite_spotter.celestrak.brightness_table", return_value=brightness
    ):
        await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.LOADED
    assert hass.states.get("sensor.home_next_pass").attributes["cloud_cover"] == 16

    assert aioclient_mock.call_count == len(QUERIES) + 2
    for _method, url, _data, headers in aioclient_mock.mock_calls:
        assert headers["User-Agent"].startswith("HomeAssistant-SatelliteSpotter/"), url
        assert "github.com/kedube/ha-satellite-spotter" in headers["User-Agent"]


async def test_catalog_refreshed_twice_a_day(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    init_integration: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """Predictions every two hours from the cached catalog, a new download every twelve."""
    fetch = mock_downloads["fetch_catalog"]
    manager = async_get_catalog(hass)
    for hours in (2, 4, 6, 8, 10):
        await advance(hass, freezer, NOW + timedelta(hours=hours, seconds=1))
    assert fetch.await_count == 1
    assert mock_downloads["fetch_cloud_cover"].await_count == 6
    assert manager.version == 1

    await advance(hass, freezer, NOW + timedelta(hours=12, seconds=1))
    assert fetch.await_count == 2
    assert manager.version == 2
    assert init_integration.runtime_data.data.catalog_version == 2
    assert hass.states.get("sensor.home_catalog_updated").state == (
        (NOW + timedelta(hours=12, seconds=1)).isoformat()
    )


async def test_predictions_go_on_without_entities(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    init_integration: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """The panel and the cards need no entity: with every one disabled, predictions go on."""
    ent_reg = er.async_get(hass)
    for entity in er.async_entries_for_config_entry(ent_reg, init_integration.entry_id):
        ent_reg.async_update_entity(entity.entity_id, disabled_by=er.RegistryEntryDisabler.USER)
    await hass.async_block_till_done()
    assert hass.states.get("sensor.home_next_pass") is None
    coordinator = init_integration.runtime_data
    fetch = mock_downloads["fetch_catalog"]
    for hours in (2, 4, 6, 8, 10, 12):
        await advance(hass, freezer, NOW + timedelta(hours=hours, seconds=1))
    assert coordinator.data.computed_at == NOW + timedelta(hours=12, seconds=1)
    assert fetch.await_count == 2

    # Nothing is left running once the location is unloaded.
    assert await hass.config_entries.async_unload(init_integration.entry_id)
    await advance(hass, freezer, NOW + timedelta(hours=26, seconds=1))
    assert coordinator.data.computed_at == NOW + timedelta(hours=12, seconds=1)
    assert fetch.await_count == 2


async def test_refusal_waits_two_hours(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    init_integration: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
    hass_storage: dict[str, Any],
) -> None:
    """After CelesTrak refuses it is left alone, and the wait is kept for a restart."""
    fetch = mock_downloads["fetch_catalog"]
    fetch.side_effect = DownloadRefused("CelesTrak answered 403")
    refused_at = NOW + timedelta(hours=12, seconds=1)
    await advance(hass, freezer, refused_at)
    assert fetch.await_count == 2
    assert async_get_catalog(hass).last_error == "CelesTrak answered 403"

    await advance(hass, freezer, refused_at + timedelta(seconds=STORAGE_SAVE_DELAY + 1))
    stored = hass_storage[STORAGE_KEY]["data"]
    assert stored["refused_until"] == (refused_at + CATALOG_REFUSED_RETRY).isoformat()
    assert stored["last_error"] == "CelesTrak answered 403"
    assert stored["catalog"]

    # The predictions' own refreshes do not ask again meanwhile.
    await advance(hass, freezer, refused_at + timedelta(hours=1, minutes=59))
    assert fetch.await_count == 2

    fetch.side_effect = None
    await advance(hass, freezer, refused_at + timedelta(hours=2, minutes=1))
    assert fetch.await_count == 3
    assert async_get_catalog(hass).last_error is None

    await advance(hass, freezer, refused_at + timedelta(hours=2, minutes=1, seconds=11))
    assert "refused_until" not in hass_storage[STORAGE_KEY]["data"]


async def test_refusal_outlasts_a_restart(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
    hass_storage: dict[str, Any],
) -> None:
    """A catalog due for a refresh waits, and the sensor still says why."""
    freezer.move_to(NOW)
    store_catalog(hass_storage, NOW - timedelta(hours=13))
    hass_storage[STORAGE_KEY]["data"]["refused_until"] = (NOW + timedelta(hours=1)).isoformat()
    hass_storage[STORAGE_KEY]["data"]["last_error"] = "CelesTrak answered 403"
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.LOADED
    mock_downloads["fetch_catalog"].assert_not_awaited()
    catalog = hass.states.get("sensor.home_catalog_updated")
    assert catalog.attributes["last_download_error"] == "CelesTrak answered 403"


async def test_refusal_before_any_catalog_outlasts_a_restart(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
    hass_storage: dict[str, Any],
) -> None:
    """Only the refusal is stored; setup waits for it without asking."""
    freezer.move_to(NOW)
    hass_storage[STORAGE_KEY] = {
        "version": 1,
        "key": STORAGE_KEY,
        "data": {
            "refused_until": (NOW + timedelta(hours=1)).isoformat(),
            "last_error": "CelesTrak answered 403",
        },
    }
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.SETUP_RETRY
    assert mock_config_entry.reason == "No satellite catalog: CelesTrak answered 403"
    mock_downloads["fetch_catalog"].assert_not_awaited()


async def test_no_usable_satellites_waits_like_a_refusal(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """Downloading megabytes again in five minutes would not make them any more usable."""
    freezer.move_to(NOW)
    fetch = mock_downloads["fetch_catalog"]
    fetch.return_value = []
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.SETUP_RETRY
    with pytest.raises(DownloadRefused):
        await async_get_catalog(hass).async_get(retry_now=True)
    assert fetch.await_count == 1


async def test_recovers_when_network_comes_up(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """Home Assistant often starts before the network; setup must not stall for long."""
    # Load the platform components up front: setting them up for the first
    # time from inside a retry timer does not complete under the frozen clock.
    for component in ("binary_sensor", "calendar", "sensor"):
        assert await async_setup_component(hass, component, {})
    freezer.move_to(NOW)
    fetch = mock_downloads["fetch_catalog"]
    fetch.side_effect = CatalogError("Error fetching the catalog: Cannot connect")
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.SETUP_RETRY

    fetch.side_effect = None
    now = NOW
    for _ in range(10):
        now += timedelta(seconds=90)
        await advance(hass, freezer, now)
        if mock_config_entry.state is ConfigEntryState.LOADED:
            break
    assert mock_config_entry.state is ConfigEntryState.LOADED
    assert now - NOW <= timedelta(minutes=8)
    # The unreachable CelesTrak was not hammered while setup kept retrying.
    assert fetch.await_count == 2


async def test_failed_refresh_keeps_the_catalog(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    init_integration: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A failed refresh keeps predicting from the cached catalog, and tries again later."""
    caplog.set_level(logging.INFO, logger="custom_components.satellite_spotter")
    fetch = mock_downloads["fetch_catalog"]
    fetch.side_effect = CatalogError("Error fetching the catalog: 503")
    await advance(hass, freezer, NOW + timedelta(hours=12, seconds=1))
    assert fetch.await_count == 2
    assert init_integration.runtime_data.last_update_success
    catalog = hass.states.get("sensor.home_catalog_updated")
    assert catalog.state == NOW.isoformat()
    assert catalog.attributes["last_download_error"] == "Error fetching the catalog: 503"
    assert caplog.text.count("Could not refresh the satellite catalog") == 1

    # Not asked again at the next prediction run, but after half an hour.
    await async_get_catalog(hass).async_get()
    assert fetch.await_count == 2
    freezer.move_to(NOW + timedelta(hours=12, minutes=31))
    await async_get_catalog(hass).async_get()
    assert fetch.await_count == 3
    # Quietly, the second time.
    assert caplog.text.count("Could not refresh the satellite catalog") == 1

    fetch.side_effect = None
    freezer.move_to(NOW + timedelta(hours=13, minutes=2))
    await async_get_catalog(hass).async_get()
    assert "The satellite catalog downloaded again" in caplog.text
    assert async_get_catalog(hass).last_error is None


@pytest.mark.parametrize(
    ("stored", "downloads"),
    [
        # Downloaded "in the future": the clock was set back since.
        (NOW + timedelta(days=30), 1),
        # A small clock correction is not worth a download.
        (NOW + timedelta(hours=1), 0),
    ],
)
async def test_clock_set_back(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
    stored: Any,
    downloads: int,
) -> None:
    freezer.move_to(NOW)
    store_catalog(hass_storage, stored)
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.LOADED
    assert mock_downloads["fetch_catalog"].await_count == downloads


async def test_clock_set_back_ends_back_offs(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """A back-off set while the clock ran fast does not outlast the correction."""
    fetch = mock_downloads["fetch_catalog"]
    manager = async_get_catalog(hass)
    freezer.move_to(NOW + timedelta(days=30))
    fetch.side_effect = CatalogError("down")
    with pytest.raises(CatalogError):
        await manager.async_get()

    freezer.move_to(NOW)
    fetch.side_effect = None
    assert len(await manager.async_get()) == 22
    assert fetch.await_count == 2


async def test_unusable_satellites_are_skipped(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
    catalog: list[Satellite],
) -> None:
    """One malformed or decayed entry must not break every prediction."""
    good = catalog_json()[0]

    def unusable(
        norad_id: int, name: str, magnitude: float = 2.0, **elements: Any
    ) -> dict[str, Any]:
        fields = {**good["elements"], "NORAD_CAT_ID": norad_id, "OBJECT_NAME": name, **elements}
        return {"name": name, "magnitude": magnitude, "elements": fields}

    without_inclination = unusable(90002, "NO INCLINATION")
    del without_inclination["elements"]["INCLINATION"]
    broken = [
        # SGP4 refuses an eccentricity above 1.
        unusable(90001, "BAD ORBIT", ECCENTRICITY="1.5"),
        # Without an inclination there is no orbit at all.
        without_inclination,
        # Not a number: nothing fails, but there is no orbit or brightness to go by.
        unusable(90003, "NAN MOTION", MEAN_MOTION="NaN"),
        unusable(90004, "NAN SHAPE", ECCENTRICITY=math.nan),
        unusable(90005, "NAN MAGNITUDE", magnitude=math.nan),
    ]
    mock_downloads["fetch_catalog"].return_value = catalog + read_catalog(broken)
    freezer.move_to(NOW)
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.LOADED
    assert hass.states.get("sensor.home_next_pass").state == FIRST_PASS
    assert hass.states.get("sensor.home_catalog_updated").attributes["satellites"] == 22
    manager = async_get_catalog(hass)
    assert set(manager.by_id()) == {s.norad_id for s in catalog}
    # The globe's description of the catalog can be built from what is left.
    payload = catalog_payload(manager.satellites, manager.updated, manager.version)
    assert len(payload["satellites"]) == 22


async def test_stale_catalog_pauses_predictions(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """Orbit data too old to trust pauses predictions, with a repair issue that says why."""
    freezer.move_to(STALE)
    # Downloaded an hour ago, and CelesTrak's data is just as old.
    store_catalog(hass_storage, STALE - timedelta(hours=1))
    await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.SETUP_RETRY
    mock_downloads["fetch_catalog"].assert_not_awaited()
    assert "15 days old, and CelesTrak's own data is just as old" in mock_config_entry.reason

    issue = _stale_issue(hass)
    assert issue is not None
    assert not issue.is_fixable
    assert issue.severity is ir.IssueSeverity.WARNING
    # Worded for a CelesTrak as far behind: no download failed.
    assert issue.translation_key == CATALOG_STALE_UPSTREAM
    assert issue.translation_placeholders == {"age": "15"}
    # The issue goes with the last location.
    await hass.config_entries.async_remove(mock_config_entry.entry_id)
    await hass.async_block_till_done()
    assert _stale_issue(hass) is None


async def _paused_while_loaded(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    entry: MockConfigEntry,
    fetch: AsyncMock,
) -> None:
    """Set up at NOW, then let downloads fail until the orbit data is too old."""
    freezer.move_to(NOW)
    await add_location(hass, entry)
    assert entry.state is ConfigEntryState.LOADED
    fetch.side_effect = CatalogError("Error fetching the catalog: 503")
    await advance(hass, freezer, STALE)
    assert entry.state is ConfigEntryState.LOADED


async def test_paused_predictions_explain_themselves(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
    catalog: list[Satellite],
) -> None:
    entry = mock_config_entry
    fetch = mock_downloads["fetch_catalog"]
    await _paused_while_loaded(hass, freezer, entry, fetch)

    for entity_id in (
        "sensor.home_next_pass",
        "binary_sensor.home_satellite_visible",
        "calendar.home_satellite_passes",
    ):
        assert hass.states.get(entity_id).state == "unavailable", entity_id
    # The diagnostic sensor stays, to say why.
    catalog_state = hass.states.get("sensor.home_catalog_updated")
    assert catalog_state.state == NOW.isoformat()
    assert catalog_state.attributes["stale"] is True
    assert catalog_state.attributes["age_days"] == pytest.approx(15.6, abs=0.3)
    assert catalog_state.attributes["last_download_error"] == "Error fetching the catalog: 503"

    issue = _stale_issue(hass)
    assert issue is not None
    assert issue.translation_key == ISSUE_CATALOG_STALE
    assert issue.translation_placeholders == {
        "age": "15",
        "error": "Error fetching the catalog: 503",
    }
    # The error says it too, in the user's language where it is shown.
    error = entry.runtime_data.last_exception
    assert isinstance(error, UpdateFailed)
    assert (error.translation_domain, error.translation_key) == (DOMAIN, ISSUE_CATALOG_STALE)
    assert error.translation_placeholders == issue.translation_placeholders
    assert "15 days old and could not be refreshed" in str(error)

    # A reload keeps the issue, and the user's "Ignore" with it. Setup then
    # retries, so the diagnostic sensor is unavailable too.
    ir.async_get(hass).async_ignore(DOMAIN, ISSUE_CATALOG_STALE, True)
    assert not await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert _stale_issue(hass).dismissed_version is not None
    assert hass.states.get("sensor.home_catalog_updated").state == "unavailable"

    # Disabling the last location clears the issue; enabling it again with
    # CelesTrak still unreachable brings it back.
    await hass.config_entries.async_set_disabled_by(entry.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert _stale_issue(hass) is None
    await hass.config_entries.async_set_disabled_by(entry.entry_id, None)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert _stale_issue(hass) is not None

    # A fresh catalog ends the pause and the issue, within minutes.
    fetch.side_effect = None
    fetch.return_value = aged(satellites(), -15)
    now = STALE
    for _ in range(10):
        now += timedelta(seconds=90)
        await advance(hass, freezer, now)
        if entry.state is ConfigEntryState.LOADED:
            break
    assert entry.state is ConfigEntryState.LOADED
    assert now - STALE <= timedelta(minutes=8)
    assert hass.states.get("sensor.home_next_pass").state != "unavailable"
    assert hass.states.get("sensor.home_catalog_updated").attributes["stale"] is False
    assert _stale_issue(hass) is None


async def test_paused_location_resumes_within_minutes(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """Paused while loaded, a location tries again as soon as the catalog may, not hours later."""
    entry = mock_config_entry
    fetch = mock_downloads["fetch_catalog"]
    await _paused_while_loaded(hass, freezer, entry, fetch)
    assert hass.states.get("sensor.home_next_pass").state == "unavailable"
    downloads = fetch.await_count

    # CelesTrak is back, with fresh orbit data.
    fetch.side_effect = None
    fetch.return_value = aged(satellites(), -15)
    now = STALE
    for _ in range(10):
        now += timedelta(seconds=90)
        await advance(hass, freezer, now)
        if hass.states.get("sensor.home_next_pass").state != "unavailable":
            break
    assert now - STALE <= timedelta(minutes=8)
    assert entry.state is ConfigEntryState.LOADED
    assert _stale_issue(hass) is None
    # One download did it: CelesTrak was not asked again meanwhile.
    assert fetch.await_count == downloads + 1


async def test_paused_retry_does_not_wake_before_the_catalog_may_download(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """Home Assistant can wake a refresh up to a second early: the retry still downloads."""
    entry = mock_config_entry
    fetch = mock_downloads["fetch_catalog"]
    freezer.move_to(NOW)
    await add_location(hass, entry)
    # Home Assistant wakes a refresh at a whole second of its loop clock plus a
    # random 0.05 to 0.5 s; the failed download below is 0.9 s into a second.
    entry.runtime_data._microsecond = 0.2
    fetch.side_effect = CatalogError("Error fetching the catalog: 503")
    paused = STALE + timedelta(seconds=0.9)
    await advance(hass, freezer, paused)
    assert hass.states.get("sensor.home_next_pass").state == "unavailable"

    fetch.side_effect = None
    fetch.return_value = aged(satellites(), -15)
    now = paused
    while hass.states.get("sensor.home_next_pass").state == "unavailable":
        # The first retry downloads, rather than finding the catalog still backing off.
        assert now - paused <= timedelta(minutes=5, seconds=2)
        now += timedelta(seconds=0.5)
        await advance(hass, freezer, now)


async def test_options_change_keeps_the_ignored_issue(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """An options change reloads the location; the user's "Ignore" must survive it."""
    entry = mock_config_entry
    await _paused_while_loaded(hass, freezer, entry, mock_downloads["fetch_catalog"])
    ir.async_get(hass).async_ignore(DOMAIN, ISSUE_CATALOG_STALE, True)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    await hass.config_entries.options.async_configure(
        result["flow_id"],
        {**result["data_schema"]({CONF_STREET_VIEW: {}}), CONF_ALERT_LEAD_MINUTES: 20},
    )
    await hass.async_block_till_done(wait_background_tasks=True)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert _stale_issue(hass).dismissed_version is not None


@pytest.mark.parametrize("action", ["disable", "remove"])
async def test_issue_goes_with_the_last_location(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
    action: str,
) -> None:
    """The issue outlives a reload, but goes with the last enabled location."""
    entry = mock_config_entry
    await _paused_while_loaded(hass, freezer, entry, mock_downloads["fetch_catalog"])
    other = _other_location()
    await add_location(hass, other)
    assert other.state is ConfigEntryState.SETUP_RETRY
    ir.async_get(hass).async_ignore(DOMAIN, ISSUE_CATALOG_STALE, True)

    for location in (entry, other):
        if action == "disable":
            await hass.config_entries.async_set_disabled_by(
                location.entry_id, ConfigEntryDisabler.USER
            )
        else:
            await hass.config_entries.async_remove(location.entry_id)
        await hass.async_block_till_done()
        if location is entry:
            # Another location is still paused: the issue (and "Ignore") stays.
            assert _stale_issue(hass).dismissed_version is not None
    assert _stale_issue(hass) is None


async def test_new_catalog_updates_every_location(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    """A catalog downloaded for one location (or a new one) is used by all at once."""
    freezer.move_to(NOW)
    entries = [mock_config_entry, _other_location()]
    for entry in entries:
        await add_location(hass, entry)
    computed = [entry.runtime_data.data.computed_at for entry in entries]

    # Half a day later another location is added, which fetches a new catalog.
    freezer.move_to(NOW + timedelta(hours=13))
    manager = async_get_catalog(hass)
    await manager.async_get()
    await hass.async_block_till_done(wait_background_tasks=True)
    assert manager.version == 2
    for entry, before in zip(entries, computed, strict=True):
        assert entry.runtime_data.data.catalog_version == 2
        assert entry.runtime_data.data.computed_at > before
    assert mock_downloads["fetch_catalog"].await_count == 2


async def test_diagnostics_are_private(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    """Counts only: no coordinates, no pass times or look angles (they reveal the place)."""
    diag = await async_get_config_entry_diagnostics(hass, init_integration)
    assert diag["entry"] == {"latitude": "**REDACTED**", "longitude": "**REDACTED**",
                             "elevation": "**REDACTED**"}  # fmt: skip
    assert diag["catalog"]["satellites"] == 22
    assert diag["catalog"]["version"] == 1
    assert diag["catalog"]["last_error"] is None
    assert 0 < diag["catalog"]["median_epoch_age_days"] < 1
    assert diag["predictions"]["pass_count"] == 28
    assert diag["predictions"]["bright_pass_count"] == 10
    assert diag["predictions"]["sighting_count"] == 32
    assert diag["predictions"]["cloud_cover"] == {"enabled": True, "available": True}
    assert diag["paused"] is None
    text = repr(diag)
    for secret in ("52.09", "5.121", "19:08:36", "1791659316", "WNW"):
        assert secret not in text


# Every option the form masks, with a value it takes; each holds LEAK. A newly masked
# option fails the test below until it is added here, and to diagnostics.TO_REDACT.
LEAK = "Zx9Leak"
SECRETS = {
    CONF_GOOGLE_API_KEY: f"AIzaSy{LEAK}Google0123456789abcdefg",
    CONF_MAPILLARY_TOKEN: f"MLY|4242424242|{LEAK}Mapillary0123456789",
}


def _masked(schema: Any) -> set[str]:
    """The fields a form masks, its sections' included."""
    fields: set[str] = set()
    for key, value in schema.schema.items():
        if isinstance(value, section):
            fields |= _masked(value.schema)
        elif isinstance(value, TextSelector) and value.config.get("type") == "password":
            fields.add(str(key))
    return fields


async def test_diagnostics_download_leaves_out_the_keys(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    init_integration: MockConfigEntry,
    # After the clock is set to NOW, or its access token would date from after it.
    hass_client: ClientSessionGenerator,
) -> None:
    """Keys typed in the options are nowhere in the download, issues and all."""
    aioclient_mock.post(GOOGLE_SESSION_URL, json={"session": "s", "expiry": "1"})
    aioclient_mock.get(MAPILLARY_IMAGES_URL, json={"data": []})
    result = await hass.config_entries.options.async_init(init_integration.entry_id)
    assert _masked(result["data_schema"]) == set(SECRETS)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {CONF_STREET_VIEW: {CONF_STREET_SOURCE: "google", **SECRETS}}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert init_integration.state is ConfigEntryState.LOADED
    assert init_integration.options[CONF_STREET_VIEW] == {CONF_STREET_SOURCE: "google", **SECRETS}

    assert await async_setup_component(hass, "diagnostics", {})
    client = await hass_client()
    response = await client.get(f"/api/diagnostics/config_entry/{init_integration.entry_id}")
    assert response.status == HTTPStatus.OK
    text = await response.text()
    assert LEAK not in text
    # Still there to say a key is set.
    assert json.loads(text)["data"]["options"][CONF_STREET_VIEW] == {
        CONF_STREET_SOURCE: "google",
        CONF_GOOGLE_API_KEY: "**REDACTED**",
        CONF_MAPILLARY_TOKEN: "**REDACTED**",
    }


def _with_coordinates(url: str) -> ClientResponseError:
    """What aiohttp raises for a bad response; its text holds the request's URL."""
    info = RequestInfo(URL(url), "GET", CIMultiDictProxy(CIMultiDict()), URL(url))
    return ClientResponseError(info, (), status=502, message="Bad Gateway")


async def test_location_stays_out_of_logs(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A failed cloud cover request names its URL, coordinates included; none reach the log."""
    caplog.set_level(logging.DEBUG, logger="custom_components.satellite_spotter")
    freezer.move_to(NOW)
    url = f"{OPEN_METEO_URL}?latitude=52.0907&longitude=5.1214&hourly=cloud_cover"
    assert "52.0907" in str(_with_coordinates(url))
    aioclient_mock.get(OPEN_METEO_URL, exc=_with_coordinates(url))
    with patch(
        "custom_components.satellite_spotter.catalog.async_fetch_catalog",
        return_value=satellites(),
    ):
        await add_location(hass, mock_config_entry)
    assert mock_config_entry.state is ConfigEntryState.LOADED
    assert "No cloud cover forecast" in caplog.text
    assert hass.states.get("sensor.home_next_pass").attributes["cloud_cover"] is None

    diag = await async_get_config_entry_diagnostics(hass, mock_config_entry)
    logged = "\n".join(
        r.getMessage()
        for r in caplog.records
        if r.name.startswith("custom_components.satellite_spotter")
    )
    for secret in ("52.0907", "5.1214"):
        assert secret not in logged
        assert secret not in repr(diag)
        for state in hass.states.async_all():
            assert secret not in repr(state.attributes), state.entity_id
