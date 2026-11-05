"""Satellite Spotter: when satellites can be seen from a place."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv, entity_registry as er
from homeassistant.helpers.typing import ConfigType

from .catalog import async_remove_catalog, async_shared_catalog
from .const import DOMAIN
from .coordinator import PredictionSettings, SatelliteSpotterCoordinator
from .frontend import async_clear_stale_issue, async_setup_frontend, async_update_panel

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type SatelliteSpotterConfigEntry = ConfigEntry[SatelliteSpotterCoordinator]


def _platforms(settings: PredictionSettings) -> list[Platform]:
    platforms = [Platform.BINARY_SENSOR, Platform.SENSOR]
    if settings.show_in_calendar:
        platforms.append(Platform.CALENDAR)
    return platforms


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve the frontend."""
    await async_setup_frontend(hass)
    return True


@callback
def _async_remove_calendar(hass: HomeAssistant, entry: SatelliteSpotterConfigEntry) -> None:
    """Take away a calendar that is switched off, rather than leave it behind unavailable."""
    registry = er.async_get(hass)
    for entity in er.async_entries_for_config_entry(registry, entry.entry_id):
        if entity.domain == Platform.CALENDAR:
            registry.async_remove(entity.entity_id)


@callback
def _async_keep_refreshing() -> None:
    """Do nothing: as a listener, it keeps predictions refreshing with every entity disabled."""


async def _async_entry_updated(hass: HomeAssistant, entry: SatelliteSpotterConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_setup_entry(hass: HomeAssistant, entry: SatelliteSpotterConfigEntry) -> bool:
    """Set up a location."""
    # First, so that the page is there to say why while setup retries.
    await async_update_panel(hass, adding=entry)
    coordinator = SatelliteSpotterCoordinator(hass, entry, async_shared_catalog(hass))
    if not coordinator.settings.show_in_calendar:
        _async_remove_calendar(hass, entry)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    entry.async_on_unload(entry.add_update_listener(_async_entry_updated))
    entry.async_on_unload(coordinator.async_add_listener(_async_keep_refreshing))
    await hass.config_entries.async_forward_entry_setups(entry, _platforms(coordinator.settings))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SatelliteSpotterConfigEntry) -> bool:
    """Unload a location, by the options it was set up with: they may have changed since."""
    unloaded = await hass.config_entries.async_unload_platforms(
        entry, _platforms(entry.runtime_data.settings)
    )
    if unloaded:
        await async_update_panel(hass)
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: SatelliteSpotterConfigEntry) -> None:
    """Clean up after a location; the catalog goes with the last one, disabled ones counting."""
    await async_update_panel(hass, removing=entry)
    async_clear_stale_issue(hass)
    if all(other is entry for other in hass.config_entries.async_entries(DOMAIN)):
        await async_remove_catalog(hass)
