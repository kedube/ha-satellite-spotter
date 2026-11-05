"""The binary sensors of a location: a pass under way, and a bright one soon."""

from __future__ import annotations

from typing import TYPE_CHECKING, override

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .entity import PassEntity

if TYPE_CHECKING:
    from . import SatelliteSpotterConfigEntry

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add a location's binary sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        [
            PassBinarySensor(coordinator, "pass_in_progress", coordinator.pass_under_way),
            PassBinarySensor(coordinator, "bright_pass_soon", coordinator.bright_pass_soon),
        ]
    )


class PassBinarySensor(PassEntity, BinarySensorEntity):
    """On while there is such a pass, which it then describes."""

    @property
    @override
    def is_on(self) -> bool:
        """Return whether there is such a pass."""
        return self.followed() is not None
