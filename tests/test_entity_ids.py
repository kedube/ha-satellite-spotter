"""Entity ids, unique ids and the device."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.device_registry import DeviceEntryType
from homeassistant.util import slugify
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.entity import SatelliteSpotterEntity

from .common import DENVER, HONOLULU, INTEGRATION, add_location

# Every entity of a location, by platform and key: the key ends its unique id.
ENTITIES = {
    ("binary_sensor", "satellite_visible_now"),
    ("binary_sensor", "visible_pass_soon"),
    ("binary_sensor", "bright_pass_soon"),
    ("calendar", "visible_passes"),
    ("device_tracker", "satellite_position"),
    ("sensor", "next_visible_pass"),
    ("sensor", "next_visible_pass_peak_elevation"),
    ("sensor", "next_visible_pass_brightness"),
    ("sensor", "next_visible_pass_duration"),
    ("sensor", "next_visible_pass_cloud_cover"),
    ("sensor", "next_visible_pass_rating"),
    ("sensor", "next_visible_satellite_name"),
    ("sensor", "next_bright_pass"),
    ("sensor", "satellite_elevation"),
    ("sensor", "visible_passes_next_24_hours"),
    ("sensor", "orbital_elements_epoch"),
}
STRINGS = json.loads((INTEGRATION / "strings.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((INTEGRATION / "manifest.json").read_text(encoding="utf-8"))


def english_name(domain: str, key: str) -> str:
    name: str = STRINGS["entity"][domain][key]["name"]
    return name


def entries_of(hass: HomeAssistant, entry: MockConfigEntry) -> list[er.RegistryEntry]:
    return er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)


@pytest.mark.parametrize(("domain", "key"), sorted(ENTITIES))
async def test_each_unique_id_ends_in_the_key(
    hass: HomeAssistant, init_integration: MockConfigEntry, domain: str, key: str
) -> None:
    registered = {
        (e.domain, e.translation_key): e.unique_id for e in entries_of(hass, init_integration)
    }
    assert registered[(domain, key)] == f"{init_integration.entry_id}_{key}"


async def test_there_are_exactly_the_entities_of_the_table(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    registered = {(e.domain, e.translation_key) for e in entries_of(hass, init_integration)}
    assert registered == ENTITIES


@pytest.mark.parametrize(("domain", "key"), sorted(ENTITIES))
async def test_a_new_locations_entity_id_follows_the_english_name(
    hass: HomeAssistant, init_integration: MockConfigEntry, domain: str, key: str
) -> None:
    expected = f"{domain}.{slugify('Home ' + english_name(domain, key))}"
    registered = {
        (e.domain, e.translation_key): e.entity_id for e in entries_of(hass, init_integration)
    }
    assert registered[(domain, key)] == expected


async def test_the_readme_lists_those_entity_ids(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    readme = (INTEGRATION.parent.parent / "README.md").read_text(encoding="utf-8")
    for entity in entries_of(hass, init_integration):
        assert f"`{entity.entity_id}`" in readme


async def test_entity_ids_start_with_the_name_given_to_the_location(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, DENVER, title="The Cabin")
    assert {e.entity_id for e in entries_of(hass, entry)} == {
        f"{domain}.the_cabin_{key}" for domain, key in ENTITIES
    }


async def test_friendly_names_join_the_location_and_the_english_name(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    for entity in entries_of(hass, init_integration):
        if entity.disabled_by is not None:
            continue
        state = hass.states.get(entity.entity_id)
        assert state is not None
        assert entity.translation_key is not None
        name = english_name(entity.domain, entity.translation_key)
        assert state.attributes["friendly_name"] == f"Home {name}"


async def test_a_new_location_in_another_language_takes_its_ids_from_the_translated_names(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    # README, Entities: "In other languages, new entities take their ids from the translated names."
    dutch = json.loads((INTEGRATION / "translations" / "nl.json").read_text(encoding="utf-8"))
    hass.config.language = "nl"
    entry = await add_location(hass)
    ids = {e.entity_id for e in entries_of(hass, entry)}
    name = dutch["entity"]["sensor"]["next_visible_pass"]["name"]
    assert f"sensor.{slugify('Home ' + name)}" in ids


@pytest.mark.parametrize(
    ("old_key", "old_id", "domain"),
    [
        ("next_pass", "sensor.home_next_pass", "sensor"),
        ("passes_next_24h", "sensor.home_passes_next_24h", "sensor"),
        ("catalog_updated", "sensor.home_catalog_updated", "sensor"),
        ("pass_in_progress", "binary_sensor.home_pass_in_progress", "binary_sensor"),
        ("passes", "calendar.home_passes", "calendar"),
    ],
)
async def test_an_entity_no_longer_provided_is_taken_away(
    hass: HomeAssistant,
    mock_downloads: dict[str, AsyncMock],
    old_key: str,
    old_id: str,
    domain: str,
) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    registry = er.async_get(hass)
    registry.async_get_or_create(
        domain,
        DOMAIN,
        f"{entry.entry_id}_{old_key}",
        config_entry=entry,
        suggested_object_id=old_id.partition(".")[2],
    )
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert registry.async_get(old_id) is None
    assert {(e.domain, e.translation_key) for e in entries_of(hass, entry)} == ENTITIES


async def test_an_entity_kept_stays_as_people_renamed_it(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    registry = er.async_get(hass)
    registry.async_get_or_create(
        "sensor",
        DOMAIN,
        f"{entry.entry_id}_next_visible_pass",
        config_entry=entry,
        suggested_object_id="my_pass",
    )
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("sensor.my_pass") is not None


async def test_the_epoch_sensor_and_the_tracker_are_diagnostic_and_the_others_are_not(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    categories = {e.translation_key: e.entity_category for e in entries_of(hass, init_integration)}
    assert categories.pop("orbital_elements_epoch") is EntityCategory.DIAGNOSTIC
    # Home Assistant's own choice for every tracker.
    assert categories.pop("satellite_position") is EntityCategory.DIAGNOSTIC
    assert all(category is None for category in categories.values())


async def test_renaming_a_location_renames_its_device_and_entities_but_not_their_ids(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    before = {e.entity_id for e in entries_of(hass, init_integration)}
    coordinator = init_integration.runtime_data
    hass.config_entries.async_update_entry(init_integration, title="Cabin")
    await hass.async_block_till_done()
    assert init_integration.runtime_data is not coordinator
    devices = dr.async_entries_for_config_entry(dr.async_get(hass), init_integration.entry_id)
    assert devices[0].name == "Cabin"
    assert {e.entity_id for e in entries_of(hass, init_integration)} == before
    state = hass.states.get("sensor.home_next_visible_pass")
    assert state is not None
    assert state.attributes["friendly_name"] == "Cabin Next visible pass"


async def test_changing_something_else_about_a_location_does_not_reload_it(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    coordinator = init_integration.runtime_data
    hass.config_entries.async_update_entry(init_integration, unique_id="elsewhere")
    await hass.async_block_till_done()
    assert init_integration.runtime_data is coordinator


async def test_the_entities_share_one_service_device_for_the_location(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    devices = dr.async_entries_for_config_entry(dr.async_get(hass), init_integration.entry_id)
    assert len(devices) == 1
    device = devices[0]
    assert device.identifiers == {(DOMAIN, init_integration.entry_id)}
    assert device.name == "Home"
    assert device.manufacturer == "Satellite Spotter"
    assert device.model == "Pass predictions"
    assert device.sw_version == MANIFEST["version"]
    assert device.entry_type is DeviceEntryType.SERVICE
    assert device.configuration_url == (
        f"homeassistant://satellite-spotter?entry_id={init_integration.entry_id}"
    )
    assert all(e.device_id == device.id for e in entries_of(hass, init_integration))


async def test_the_device_page_link_goes_with_the_sidebar_option(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, options={"show_in_sidebar": False})
    devices = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)
    assert devices[0].configuration_url is None


async def test_the_device_page_link_is_there_with_the_option_on(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, options={"show_in_sidebar": True})
    devices = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)
    assert devices[0].configuration_url is not None
    assert entry.entry_id in devices[0].configuration_url


async def test_every_entity_credits_its_sources(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    # The Mini-MegaTORTORA team asks for attribution and citation (const.py, README).
    for entity in entries_of(hass, init_integration):
        if entity.disabled_by is not None:
            continue
        state = hass.states.get(entity.entity_id)
        assert state is not None
        attribution = state.attributes["attribution"]
        for source in ("CelesTrak", "Mini-MegaTORTORA", "Karpov", "Open-Meteo"):
            assert source in attribution


async def test_entities_have_the_entity_name_style(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    entity = SatelliteSpotterEntity(init_integration.runtime_data, "something_new")
    assert entity.has_entity_name is True
    assert entity.translation_key == "something_new"
    assert entity.unique_id == f"{init_integration.entry_id}_something_new"


async def test_every_entity_has_an_icon_and_a_name_for_its_key(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    icons = json.loads((INTEGRATION / "icons.json").read_text(encoding="utf-8"))["entity"]
    for entity in entries_of(hass, init_integration):
        assert entity.translation_key in icons[entity.domain]
        assert entity.translation_key in STRINGS["entity"][entity.domain]
