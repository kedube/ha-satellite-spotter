"""Binary sensors: a satellite is visible now, and a bright pass is coming soon."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, override

from homeassistant.components.binary_sensor import (
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import SatelliteSpotterConfigEntry
from .coordinator import SatellitePass, SatelliteSpotterCoordinator
from .entity import SatelliteSpotterEntity, pass_attributes

PARALLEL_UPDATES = 0


@dataclass(frozen=True, kw_only=True)
class SatelliteBinarySensorDescription(BinarySensorEntityDescription):
    """Describes a binary sensor that is on during (or ahead of) a pass."""

    # The pass that turns the sensor on, or None while it is off.
    pass_fn: Callable[[SatelliteSpotterCoordinator, datetime], SatellitePass | None]


BINARY_SENSORS: tuple[SatelliteBinarySensorDescription, ...] = (
    # On while a satellite is visible overhead.
    SatelliteBinarySensorDescription(
        key="pass_in_progress",
        pass_fn=lambda c, now: c.current(now),
    ),
    # On from the advance notice before a bright pass until it ends.
    SatelliteBinarySensorDescription(
        key="bright_pass_soon",
        pass_fn=lambda c, now: c.bright_pass_soon(now),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the binary sensors."""
    coordinator = entry.runtime_data
    async_add_entities(SatelliteBinarySensor(coordinator, d) for d in BINARY_SENSORS)


class SatelliteBinarySensor(SatelliteSpotterEntity, BinarySensorEntity):
    """On during a pass (or ahead of a bright one), with that pass's details."""

    entity_description: SatelliteBinarySensorDescription
    _unrecorded_attributes = frozenset({"satellites", "info_url"})

    def __init__(
        self,
        coordinator: SatelliteSpotterCoordinator,
        description: SatelliteBinarySensorDescription,
    ) -> None:
        """Initialise the binary sensor."""
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    @override
    def is_on(self) -> bool:
        """Return whether the pass is under way (or coming soon)."""
        return self.entity_description.pass_fn(self.coordinator, dt_util.utcnow()) is not None

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return details of that pass, or nothing while off."""
        return pass_attributes(self.entity_description.pass_fn(self.coordinator, dt_util.utcnow()))
