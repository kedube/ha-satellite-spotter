"""Setting up, unloading, reloading and removing locations."""

from __future__ import annotations

from datetime import timedelta
import logging
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components import frontend
from homeassistant.config_entries import ConfigEntryDisabler, ConfigEntryState
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er, issue_registry as ir
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.catalog import SHARED_CATALOG
from custom_components.satellite_spotter.celestrak import CatalogError
from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.coordinator import SatelliteSpotterCoordinator

from .common import DENVER, HONOLULU, NOW, add_location, advance, aged, satellites, set_options

STORE_KEY = "satellite_spotter.catalog"
PANEL = "satellite-spotter"
EVERY_ENTITY = {
    "binary_sensor.home_satellite_visible_now",
    "binary_sensor.home_visible_pass_soon",
    "binary_sensor.home_bright_pass_soon",
    "calendar.home_visible_passes",
    "device_tracker.home_satellite_position",
    "sensor.home_next_visible_pass",
    "sensor.home_next_visible_pass_peak_elevation",
    "sensor.home_next_visible_pass_brightness",
    "sensor.home_next_visible_pass_duration",
    "sensor.home_next_visible_pass_cloud_cover",
    "sensor.home_next_visible_satellite_name",
    "sensor.home_next_bright_pass",
    "sensor.home_satellite_elevation",
    "sensor.home_visible_passes_next_24_hours",
    "sensor.home_orbital_elements_epoch",
}
EVERY_KEY = {
    entity_id.partition(".")[2].removeprefix("home_"): entity_id for entity_id in EVERY_ENTITY
}


def entity_ids(hass: HomeAssistant, entry: MockConfigEntry) -> set[str]:
    registry = er.async_get(hass)
    return {e.entity_id for e in er.async_entries_for_config_entry(registry, entry.entry_id)}


def panel_shown(hass: HomeAssistant) -> bool:
    return PANEL in hass.data.get(frontend.DATA_PANELS, {})


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


# Setting up.


async def test_one_location_is_set_up_with_all_its_entities(
    hass: HomeAssistant, init_integration: MockConfigEntry, mock_downloads: dict[str, AsyncMock]
) -> None:
    assert init_integration.state is ConfigEntryState.LOADED
    assert entity_ids(hass, init_integration) == EVERY_ENTITY
    assert all(hass.states.get(entity_id) is not None for entity_id in EVERY_ENTITY)
    assert isinstance(init_integration.runtime_data, SatelliteSpotterCoordinator)
    mock_downloads["fetch_catalog"].assert_awaited_once()
    mock_downloads["fetch_forecast"].assert_awaited_once()
    assert panel_shown(hass)


async def test_several_locations_share_one_download_and_have_their_own_of_the_rest(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    home = await add_location(hass, HONOLULU, title="Home")
    cabin = await add_location(hass, DENVER, title="Cabin")
    assert home.state is ConfigEntryState.LOADED
    assert cabin.state is ConfigEntryState.LOADED
    assert home.runtime_data.catalog is cabin.runtime_data.catalog
    mock_downloads["fetch_catalog"].assert_awaited_once()

    # Each asks about its own sky.
    asked = {call.args[1:] for call in mock_downloads["fetch_forecast"].await_args_list}
    assert asked == {
        (HONOLULU[CONF_LATITUDE], HONOLULU[CONF_LONGITUDE]),
        (DENVER[CONF_LATITUDE], DENVER[CONF_LONGITUDE]),
    }

    assert entity_ids(hass, home) == EVERY_ENTITY
    assert "sensor.cabin_next_visible_pass" in entity_ids(hass, cabin)
    assert len(entity_ids(hass, cabin)) == len(EVERY_ENTITY)

    home_next = hass.states.get("sensor.home_next_visible_pass")
    cabin_next = hass.states.get("sensor.cabin_next_visible_pass")
    assert home_next is not None
    assert cabin_next is not None
    assert home_next.state != cabin_next.state

    devices = dr.async_get(hass)
    assert len(dr.async_entries_for_config_entry(devices, home.entry_id)) == 1
    assert len(dr.async_entries_for_config_entry(devices, cabin.entry_id)) == 1


async def test_two_locations_set_up_at_once_share_one_download(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    # The way a restart sets them up: Home Assistant starts the integration for every entry.
    for place, title in ((HONOLULU, "Home"), (DENVER, "Cabin")):
        MockConfigEntry(domain=DOMAIN, title=title, data=dict(place)).add_to_hass(hass)
    assert await async_setup_component(hass, DOMAIN, {})
    await hass.async_block_till_done()
    entries = hass.config_entries.async_entries(DOMAIN)
    assert [entry.state for entry in entries] == [ConfigEntryState.LOADED] * 2
    mock_downloads["fetch_catalog"].assert_awaited_once()
    # The catalog arriving during their first refresh is no reason for a second.
    await hass.async_block_till_done(wait_background_tasks=True)
    assert mock_downloads["fetch_forecast"].await_count == 2


async def test_a_disabled_location_sets_nothing_up_and_downloads_nothing(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, disabled_by=ConfigEntryDisabler.USER)
    assert await async_setup_component(hass, DOMAIN, {})
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED
    assert entity_ids(hass, entry) == set()
    mock_downloads["fetch_catalog"].assert_not_awaited()
    assert not panel_shown(hass)


async def test_a_disabled_location_beside_an_enabled_one_is_left_out(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    home = await add_location(hass, HONOLULU)
    cabin = await add_location(hass, DENVER, title="Cabin", disabled_by=ConfigEntryDisabler.USER)
    assert home.state is ConfigEntryState.LOADED
    assert cabin.state is ConfigEntryState.NOT_LOADED
    assert entity_ids(hass, cabin) == set()
    mock_downloads["fetch_forecast"].assert_awaited_once()


async def test_enabling_a_location_sets_it_up(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, disabled_by=ConfigEntryDisabler.USER)
    assert await async_setup_component(hass, DOMAIN, {})
    await hass.config_entries.async_set_disabled_by(entry.entry_id, None)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert entity_ids(hass, entry) == EVERY_ENTITY
    assert panel_shown(hass)


async def test_a_location_with_no_elevation_is_at_sea_level(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    place = {CONF_LATITUDE: HONOLULU[CONF_LATITUDE], CONF_LONGITUDE: HONOLULU[CONF_LONGITUDE]}
    entry = await add_location(hass, place)
    assert entry.runtime_data.observer.elevation_m == 0.0


async def test_the_observer_is_where_the_location_says(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    observer = init_integration.runtime_data.observer
    assert observer.latitude == HONOLULU[CONF_LATITUDE]
    assert observer.longitude == HONOLULU[CONF_LONGITUDE]
    assert observer.elevation_m == HONOLULU[CONF_ELEVATION]


async def test_setup_retries_when_there_is_no_catalog_and_the_page_is_there_to_say_why(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert panel_shown(hass)
    assert entry.reason is not None
    assert "no route" in entry.reason
    assert not [state for state in hass.states.async_all() if state.domain != "zone"]


async def test_setup_recovers_by_itself(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    entry = await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = None
    await advance(hass, freezer, NOW + timedelta(minutes=6))
    assert entry.state is ConfigEntryState.LOADED
    assert entity_ids(hass, entry) == EVERY_ENTITY


async def test_a_failed_setup_leaves_no_listener_behind_on_the_catalog(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    predicted = mock_downloads["fetch_forecast"].await_count
    # Should the catalog come from elsewhere, the retrying setup's first coordinator is gone.
    mock_downloads["fetch_catalog"].side_effect = None
    await hass.data[SHARED_CATALOG].async_satellites(retry_now=True)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert mock_downloads["fetch_forecast"].await_count == predicted


async def test_yaml_is_refused_and_setup_still_goes_ahead(
    hass: HomeAssistant, caplog: pytest.LogCaptureFixture
) -> None:
    assert await async_setup_component(hass, DOMAIN, {DOMAIN: {"latitude": 1}})
    assert "does not support YAML" in caplog.text


# Unloading and reloading.


async def test_unloading_takes_the_entities_away_and_stops_the_work(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    init_integration: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    assert await hass.config_entries.async_unload(init_integration.entry_id)
    await hass.async_block_till_done()
    assert init_integration.state is ConfigEntryState.NOT_LOADED
    for entity_id in EVERY_ENTITY:
        state = hass.states.get(entity_id)
        assert state is not None
        assert state.state == "unavailable"

    asked = mock_downloads["fetch_forecast"].await_count
    await advance(hass, freezer, NOW + timedelta(hours=3))
    assert mock_downloads["fetch_forecast"].await_count == asked


async def test_unloading_updates_the_panel(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    with patch(
        "custom_components.satellite_spotter.async_update_panel", AsyncMock()
    ) as update_panel:
        assert await hass.config_entries.async_unload(init_integration.entry_id)
    update_panel.assert_awaited_once_with(hass)


# Its timers go on, as a failed unload leaves the location running.
@pytest.mark.parametrize("expected_lingering_timers", [True])
async def test_a_failed_unload_says_so_and_leaves_the_panel_alone(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    with (
        patch(
            "custom_components.satellite_spotter.async_update_panel", AsyncMock()
        ) as update_panel,
        patch.object(hass.config_entries, "async_unload_platforms", AsyncMock(return_value=False)),
    ):
        assert not await hass.config_entries.async_unload(init_integration.entry_id)
    update_panel.assert_not_awaited()
    assert init_integration.state is ConfigEntryState.FAILED_UNLOAD


async def test_reloading_keeps_entities_and_the_page_and_downloads_nothing(
    hass: HomeAssistant, init_integration: MockConfigEntry, mock_downloads: dict[str, AsyncMock]
) -> None:
    before = init_integration.runtime_data
    with patch.object(frontend, "async_remove_panel", MagicMock()) as remove_panel:
        await hass.config_entries.async_reload(init_integration.entry_id)
        await hass.async_block_till_done()
    assert init_integration.state is ConfigEntryState.LOADED
    assert init_integration.runtime_data is not before
    assert init_integration.runtime_data.catalog is before.catalog
    assert entity_ids(hass, init_integration) == EVERY_ENTITY
    mock_downloads["fetch_catalog"].assert_awaited_once()
    remove_panel.assert_not_called()
    assert panel_shown(hass)


async def test_changing_options_reloads_with_them(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    before = init_integration.runtime_data
    assert before.settings.brightness_cutoff == 2.25
    await set_options(hass, init_integration, {"brightness_cutoff": 1.0})
    assert init_integration.state is ConfigEntryState.LOADED
    assert init_integration.runtime_data is not before
    assert init_integration.runtime_data.settings.brightness_cutoff == 1.0


async def test_switching_the_calendar_off_takes_it_away_and_leaves_the_rest(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    await set_options(hass, init_integration, {"show_in_calendar": False})
    assert init_integration.state is ConfigEntryState.LOADED
    assert entity_ids(hass, init_integration) == EVERY_ENTITY - {"calendar.home_visible_passes"}
    assert hass.states.get("calendar.home_visible_passes") is None
    assert hass.states.get("sensor.home_next_visible_pass") is not None


async def test_switching_the_calendar_on_brings_it_back(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, options={"show_in_calendar": False})
    assert entity_ids(hass, entry) == EVERY_ENTITY - {"calendar.home_visible_passes"}
    await set_options(hass, entry, {"show_in_calendar": True})
    assert entry.state is ConfigEntryState.LOADED
    assert entity_ids(hass, entry) == EVERY_ENTITY
    state = hass.states.get("calendar.home_visible_passes")
    assert state is not None
    assert state.state != "unavailable"


async def test_unloading_goes_by_the_options_it_was_set_up_with(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    # Set up without a calendar, with the option on by the time it is unloaded.
    entry = await add_location(hass, options={"show_in_calendar": False})
    hass.config_entries.async_update_entry(
        entry, options={"show_in_calendar": True}
    )  # The listener's reload unloads a platform list of two, then sets up three.
    await hass.async_block_till_done()
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert entry.state is ConfigEntryState.NOT_LOADED


async def test_a_renamed_calendar_keeps_its_name_while_it_stays_on(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    registry = er.async_get(hass)
    registry.async_update_entity("calendar.home_visible_passes", new_entity_id="calendar.mine")
    await hass.config_entries.async_reload(init_integration.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("calendar.mine") is not None
    assert hass.states.get("calendar.home_visible_passes") is None


async def test_a_calendar_left_from_before_goes_when_it_is_off_at_setup(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN, title="Home", data=dict(HONOLULU), options={"show_in_calendar": False}
    )
    entry.add_to_hass(hass)
    registry = er.async_get(hass)
    registry.async_get_or_create("calendar", DOMAIN, f"{entry.entry_id}_passes", config_entry=entry)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert not [e for e in entity_ids(hass, entry) if e.startswith("calendar.")]


async def test_predictions_keep_refreshing_with_every_entity_disabled(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    registry = er.async_get(hass)
    for key, entity_id in EVERY_KEY.items():
        registry.async_get_or_create(
            entity_id.partition(".")[0],
            DOMAIN,
            f"{entry.entry_id}_{key}",
            config_entry=entry,
            disabled_by=er.RegistryEntryDisabler.USER,
        )
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert not [state for state in hass.states.async_all() if state.domain != "zone"]

    await advance(hass, freezer, NOW + timedelta(hours=1))
    assert mock_downloads["fetch_forecast"].await_count == 2


# Removing.


async def test_removing_one_of_two_leaves_the_other_and_the_shared_things_alone(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    hass_storage: dict[str, Any],
) -> None:
    home = await add_location(hass, HONOLULU, title="Home")
    cabin = await add_location(hass, DENVER, title="Cabin")
    manager = hass.data[SHARED_CATALOG]
    await advance(hass, freezer, NOW + timedelta(hours=3))
    assert STORE_KEY in hass_storage

    await hass.config_entries.async_remove(home.entry_id)
    await hass.async_block_till_done()

    assert entity_ids(hass, home) == set()
    assert hass.states.get("sensor.home_next_visible_pass") is None
    assert not dr.async_entries_for_config_entry(dr.async_get(hass), home.entry_id)
    assert cabin.state is ConfigEntryState.LOADED
    assert hass.states.get("sensor.cabin_next_visible_pass") is not None
    assert hass.data[SHARED_CATALOG] is manager
    assert STORE_KEY in hass_storage
    assert panel_shown(hass)


async def test_removing_the_last_takes_the_catalog_and_the_page(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    init_integration: MockConfigEntry,
    hass_storage: dict[str, Any],
) -> None:
    await advance(hass, freezer, NOW + timedelta(hours=3))
    assert STORE_KEY in hass_storage

    await hass.config_entries.async_remove(init_integration.entry_id)
    await hass.async_block_till_done()

    assert STORE_KEY not in hass_storage
    assert SHARED_CATALOG not in hass.data
    assert not panel_shown(hass)
    assert not [state for state in hass.states.async_all() if state.domain != "zone"]


async def test_removing_the_last_within_two_hours_of_a_download_keeps_the_file(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_storage: dict[str, Any]
) -> None:
    # README, Removing: so that adding a location back doesn't have to ask CelesTrak again.
    await hass.config_entries.async_remove(init_integration.entry_id)
    await hass.async_block_till_done()
    assert STORE_KEY in hass_storage
    assert hass_storage[STORE_KEY]["data"]["updated"] == NOW.isoformat()
    assert SHARED_CATALOG not in hass.data


async def test_the_stored_file_holds_nothing_about_the_location(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_storage: dict[str, Any]
) -> None:
    await hass.config_entries.async_remove(init_integration.entry_id)
    await hass.async_block_till_done()
    text = str(hass_storage[STORE_KEY])
    assert "21.3069" not in text
    assert "157.8583" not in text


async def test_a_disabled_location_counts_when_removing_the_last_enabled_one(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    hass_storage: dict[str, Any],
) -> None:
    home = await add_location(hass, HONOLULU)
    await add_location(hass, DENVER, title="Cabin", disabled_by=ConfigEntryDisabler.USER)
    manager = hass.data[SHARED_CATALOG]
    await advance(hass, freezer, NOW + timedelta(hours=3))

    await hass.config_entries.async_remove(home.entry_id)
    await hass.async_block_till_done()

    assert STORE_KEY in hass_storage
    assert hass.data[SHARED_CATALOG] is manager
    assert not panel_shown(hass)


async def test_removing_the_only_location_when_disabled_deletes_the_stored_catalog(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    hass_storage: dict[str, Any],
) -> None:
    entry = await add_location(hass, disabled_by=ConfigEntryDisabler.USER)
    assert await async_setup_component(hass, DOMAIN, {})
    hass_storage[STORE_KEY] = {
        "version": 1,
        "minor_version": 1,
        "key": STORE_KEY,
        "data": {"updated": (NOW - timedelta(hours=5)).isoformat(), "catalog": []},
    }
    await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert STORE_KEY not in hass_storage
    mock_downloads["fetch_catalog"].assert_not_awaited()


async def test_removing_the_last_clears_the_repair_and_one_of_two_does_not(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    home = await add_location(hass, HONOLULU)
    cabin = await add_location(hass, DENVER, title="Cabin")
    mock_downloads["fetch_catalog"].return_value = aged(satellites(), timedelta(0))
    await advance(hass, freezer, NOW + timedelta(days=20))
    issues = ir.async_get(hass)
    assert issues.async_get_issue(DOMAIN, "catalog_stale") is not None

    await hass.config_entries.async_remove(home.entry_id)
    await hass.async_block_till_done()
    assert issues.async_get_issue(DOMAIN, "catalog_stale") is not None

    await hass.config_entries.async_remove(cabin.entry_id)
    await hass.async_block_till_done()
    assert issues.async_get_issue(DOMAIN, "catalog_stale") is None


async def test_logging_stays_quiet_through_a_clean_life(
    hass: HomeAssistant,
    init_integration: MockConfigEntry,
    caplog: pytest.LogCaptureFixture,
) -> None:
    await hass.config_entries.async_reload(init_integration.entry_id)
    await hass.async_block_till_done()
    await hass.config_entries.async_remove(init_integration.entry_id)
    await hass.async_block_till_done()
    worries = [r for r in caplog.records if r.levelno >= logging.WARNING and DOMAIN in r.name]
    assert not worries
