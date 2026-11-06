"""Where on Earth the satellite to watch is overhead, for map cards."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, override

from homeassistant.components.device_tracker import SourceType, TrackerEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import POSITION_KEY
from .entity import LiveEntity

if TYPE_CHECKING:
    from . import SatelliteSpotterConfigEntry

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add a location's tracker."""
    async_add_entities([SatellitePositionTracker(entry.runtime_data, POSITION_KEY)])


class SatellitePositionTracker(LiveEntity, TrackerEntity):
    """The ground point beneath the satellite of the pass under way, or the next."""

    _attr_source_type = SourceType.GPS
    # It changes every minute, and every 10 seconds during a pass, and most have no use for it.
    _attr_entity_registry_enabled_default = False
    # The latitude and longitude stay recorded, for the trail on map cards.
    _unrecorded_attributes = frozenset({"satellite", "catalog_number", "altitude_km", "sunlit"})

    @property
    @override
    def force_update(self) -> bool:
        """Write only what changes, where trackers would otherwise write every update."""
        return False

    @property
    @override
    def latitude(self) -> float | None:
        """Return the latitude of the point beneath the satellite."""
        live = self.coordinator.live
        return None if live is None else round(live.position.latitude, 4)

    @property
    @override
    def longitude(self) -> float | None:
        """Return the longitude of the point beneath the satellite."""
        live = self.coordinator.live
        return None if live is None else round(live.position.longitude, 4)

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Say which satellite this is, and how high up."""
        live = self.coordinator.live
        if live is None:
            return {}
        return {
            "satellite": live.satellite.name,
            "catalog_number": live.satellite.norad_id,
            "altitude_km": round(live.position.altitude_km, 1),
            "sunlit": live.position.sunlit,
        }
