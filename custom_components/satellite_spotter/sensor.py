"""The sensors of a location: the next passes, how many are coming, and the catalog's age."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, override

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import MAX_LISTED_PASSES
from .coordinator import ListedPass, SatelliteSpotterCoordinator
from .entity import PassEntity, SatelliteSpotterEntity, compass, magnitude

if TYPE_CHECKING:
    from . import SatelliteSpotterConfigEntry

PARALLEL_UPDATES = 0

_LONG_LISTS = frozenset({"passes", "objects", "about_url"})


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add a location's sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        [
            PassTimeSensor(coordinator, "next_pass", coordinator.next_pass),
            PassTimeSensor(coordinator, "next_bright_pass", coordinator.next_bright_pass),
            UpcomingPassesSensor(coordinator, "passes_next_24h"),
            CatalogUpdatedSensor(coordinator, "catalog_updated"),
        ]
    )


class PassTimeSensor(PassEntity, SensorEntity):
    """When the pass followed begins."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _unrecorded_attributes = _LONG_LISTS

    @property
    @override
    def native_value(self) -> datetime | None:
        """Return when the pass begins."""
        p = self.followed()
        return None if p is None else p.start


class UpcomingPassesSensor(SatelliteSpotterEntity, SensorEntity):
    """How many passes are under way or coming soon, and what they are."""

    _unrecorded_attributes = _LONG_LISTS

    def _upcoming(self) -> list[ListedPass]:
        data = self.coordinator.predictions
        return [] if data is None else data.upcoming(dt_util.utcnow())

    @property
    @override
    def native_value(self) -> int:
        """Return how many passes there are; zero without data."""
        return len(self._upcoming())

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """List the passes."""
        return {
            "passes": [
                {
                    "pass_id": p.id,
                    "title": p.title,
                    "peak_magnitude": magnitude(p.peak_magnitude),
                    "is_bright": p.bright,
                    "cloud_percent": p.cloud_cover,
                    "begins": p.start.isoformat(),
                    "appears_direction": compass(p.lead.appears.azimuth),
                }
                for p in self._upcoming()[:MAX_LISTED_PASSES]
            ]
        }


class CatalogUpdatedSensor(SatelliteSpotterEntity, SensorEntity):
    """When the catalog was downloaded: there whenever a catalog is, to say why passes stop."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: SatelliteSpotterCoordinator, key: str) -> None:
        """Keep the catalog at hand."""
        super().__init__(coordinator, key)
        self._catalog = coordinator.catalog

    @property
    @override
    def available(self) -> bool:
        """Return whether a catalog exists, even while predictions are paused."""
        return self._catalog.satellites is not None

    @property
    @override
    def native_value(self) -> datetime | None:
        """Return when the catalog was downloaded."""
        return self._catalog.updated

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Describe the catalog."""
        now = dt_util.utcnow()
        age = self._catalog.median_epoch_age(now)
        return {
            "catalog_size": len(self._catalog.satellites or ()),
            "age_days": None if age is None else round(age / timedelta(days=1), 1),
            "stale": self.coordinator.stale_age(now) is not None,
            "last_download_error": self._catalog.last_error,
        }
