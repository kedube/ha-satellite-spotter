"""The binary sensors of a location: whether a satellite is showing, or soon will be."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, override

from homeassistant.components.binary_sensor import (
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .coordinator import ListedPass, SatelliteSpotterCoordinator
from .entity import SatelliteSpotterEntity, pass_attributes

if TYPE_CHECKING:
    from . import SatelliteSpotterConfigEntry

PARALLEL_UPDATES = 0


@dataclass(frozen=True, kw_only=True)
class PassBinarySensorDescription(BinarySensorEntityDescription):
    """A binary sensor that is on while it has a pass to describe."""

    follow: Callable[[SatelliteSpotterCoordinator, datetime], ListedPass | None]


BINARY_SENSORS: tuple[PassBinarySensorDescription, ...] = (
    PassBinarySensorDescription(
        key="satellite_visible_now",
        follow=SatelliteSpotterCoordinator.pass_under_way,
    ),
    PassBinarySensorDescription(
        key="visible_pass_soon",
        follow=SatelliteSpotterCoordinator.visible_pass_soon,
    ),
    PassBinarySensorDescription(
        key="bright_pass_soon",
        follow=SatelliteSpotterCoordinator.bright_pass_soon,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add a location's binary sensors."""
    coordinator = entry.runtime_data
    async_add_entities(PassBinarySensor(coordinator, d) for d in BINARY_SENSORS)


class PassBinarySensor(SatelliteSpotterEntity, BinarySensorEntity):
    """On while there is such a pass, which it then describes."""

    entity_description: PassBinarySensorDescription
    _unrecorded_attributes = frozenset({"satellites", "about_url"})

    def __init__(
        self, coordinator: SatelliteSpotterCoordinator, description: PassBinarySensorDescription
    ) -> None:
        """Follow the pass the description says."""
        super().__init__(coordinator, description.key)
        self.entity_description = description

    def _followed(self) -> ListedPass | None:
        return self.entity_description.follow(self.coordinator, dt_util.utcnow())

    @property
    @override
    def is_on(self) -> bool:
        """Return whether there is such a pass."""
        return self._followed() is not None

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Describe the pass."""
        p = self._followed()
        return {} if p is None else pass_attributes(p)
