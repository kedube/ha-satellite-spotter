"""Satellite Spotter: when satellites are visible from home, on a 3D globe and at street level.

Predictions come from the see-a-satellite library, a port of James Darpinian's
See A Satellite Tonight (https://james.darpinian.com/satellites/).
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv, entity_registry as er
from homeassistant.helpers.typing import ConfigType

from .catalog import async_get_catalog, async_remove_catalog
from .const import DOMAIN
from .coordinator import SatelliteSpotterCoordinator
from .frontend import async_clear_stale_issue, async_setup_frontend, async_update_panel

PLATFORMS = [Platform.BINARY_SENSOR, Platform.SENSOR]

type SatelliteSpotterConfigEntry = ConfigEntry[SatelliteSpotterCoordinator]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve the dashboard cards and the sidebar panel."""
    await async_setup_frontend(hass)
    return True


def _platforms(coordinator: SatelliteSpotterCoordinator) -> list[Platform]:
    """Return the platforms of a location: the calendar only while it is switched on.

    The settings are the ones the location was set up with, so a reload after
    an options change unloads the platforms that were loaded.
    """
    if coordinator.settings.show_in_calendar:
        return [*PLATFORMS, Platform.CALENDAR]
    return PLATFORMS


async def async_setup_entry(hass: HomeAssistant, entry: SatelliteSpotterConfigEntry) -> bool:
    """Set up a location from a config entry."""
    # The panel follows the enabled locations, so it is there (and says what
    # it is waiting for) even while setup retries.
    await async_update_panel(hass, adding=entry)

    coordinator = SatelliteSpotterCoordinator(hass, entry, async_get_catalog(hass))
    if not coordinator.settings.show_in_calendar:
        _async_remove_calendar(hass, entry)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    # The coordinator refreshes only while something listens, and the panel
    # and the cards read it without an entity: keep the predictions (and the
    # shared catalog) up to date even with every entity disabled.
    entry.async_on_unload(coordinator.async_add_listener(lambda: None))

    await hass.config_entries.async_forward_entry_setups(entry, _platforms(coordinator))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SatelliteSpotterConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(
        entry, _platforms(entry.runtime_data)
    )
    if unloaded:
        # A reload keeps the panel (the entry is still enabled); disabling the
        # entry, which happens before the unload, removes it. A reload also
        # keeps the repair issue, and the user's "Ignore" with it.
        await async_update_panel(hass)
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: SatelliteSpotterConfigEntry) -> None:
    """Remove the panel and the repair issue with the last enabled location.

    The stored catalog goes once no location is left, disabled ones counted
    (Home Assistant has already dropped this one from its entries).
    """
    await async_update_panel(hass, removing=entry)
    async_clear_stale_issue(hass)
    if not hass.config_entries.async_entries(DOMAIN):
        await async_remove_catalog(hass)


async def _async_update_listener(hass: HomeAssistant, entry: SatelliteSpotterConfigEntry) -> None:
    """Reload when the options or the location change."""
    await hass.config_entries.async_reload(entry.entry_id)


@callback
def _async_remove_calendar(hass: HomeAssistant, entry: SatelliteSpotterConfigEntry) -> None:
    """Drop the calendar once it is switched off, rather than leave it behind unavailable."""
    ent_reg = er.async_get(hass)
    for entity in er.async_entries_for_config_entry(ent_reg, entry.entry_id):
        if entity.domain == Platform.CALENDAR:
            ent_reg.async_remove(entity.entity_id)
