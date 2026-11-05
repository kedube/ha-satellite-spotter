"""Binary sensors: a satellite is visible now, and a bright pass is coming soon."""

from __future__ import annotations

from typing import override

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SatelliteSpotterConfigEntry
from .entity import PassEntity

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the binary sensors. Their keys are their unique ids: see sensor.py."""
    location = entry.runtime_data
    async_add_entities(
        [
            # On while a satellite is visible overhead.
            PassBinarySensor(location, "pass_in_progress", location.pass_under_way),
            # On from the advance notice before a bright pass until it ends.
            PassBinarySensor(location, "bright_pass_soon", location.bright_pass_soon),
        ]
    )


class PassBinarySensor(PassEntity, BinarySensorEntity):
    """On during a pass (or ahead of a bright one), with that pass's details."""

    @property
    @override
    def is_on(self) -> bool:
        """Return whether there is such a pass now."""
        return self.followed() is not None
