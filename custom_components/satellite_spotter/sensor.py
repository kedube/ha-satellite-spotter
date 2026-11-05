"""Sensors: the next pass, the next bright pass, the passes of the next day, the catalog."""

from __future__ import annotations

from datetime import datetime
from typing import Any, override

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import SatelliteSpotterConfigEntry
from .const import CATALOG_MAX_AGE, MAX_LISTED_PASSES
from .coordinator import ListedPass
from .entity import PassEntity, SatelliteSpotterEntity, compass, magnitude

PARALLEL_UPDATES = 0

# Keep the lists out of the recorder database: they are large and change with
# every pass.
_LIST_ATTRIBUTES = frozenset({"passes", "objects", "about_url"})


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the sensors. Their keys are their unique ids: changing one recreates the entity."""
    location = entry.runtime_data
    async_add_entities(
        [
            PassSensor(location, "next_pass", location.next_pass),
            PassSensor(location, "next_bright_pass", location.next_bright_pass),
            PassCountSensor(location, "passes_next_24h"),
            CatalogSensor(location, "catalog_updated"),
        ]
    )


class PassSensor(PassEntity, SensorEntity):
    """When a pass starts, with the pass's details."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _unrecorded_attributes = _LIST_ATTRIBUTES

    @property
    @override
    def native_value(self) -> datetime | None:
        """Return when the pass starts."""
        followed = self.followed()
        return None if followed is None else followed.start


class PassCountSensor(SatelliteSpotterEntity, SensorEntity):
    """How many passes are under way or start within a day, and which."""

    _unrecorded_attributes = _LIST_ATTRIBUTES

    def _upcoming(self) -> list[ListedPass]:
        predictions = self.coordinator.data
        return [] if predictions is None else predictions.upcoming(dt_util.utcnow())

    @property
    @override
    def native_value(self) -> int:
        """Return the number of passes."""
        return len(self._upcoming())

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return a short description of each pass, up to the limit."""
        return {"passes": [_summary(p) for p in self._upcoming()[:MAX_LISTED_PASSES]]}


def _summary(p: ListedPass) -> dict[str, Any]:
    return {
        "pass_id": p.id,
        "title": p.title,
        "peak_magnitude": magnitude(p.peak_magnitude),
        "is_bright": p.bright,
        "cloud_percent": p.cloud_cover,
        "begins": p.start.isoformat(),
        "appears_direction": compass(p.lead.appears.azimuth),
    }


class CatalogSensor(SatelliteSpotterEntity, SensorEntity):
    """When the catalog was downloaded; its satellite count is worth a history."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    @property
    @override
    def available(self) -> bool:
        """Stay available while predictions are paused, to show why."""
        return self.coordinator.catalog.satellites is not None

    @property
    @override
    def native_value(self) -> datetime | None:
        """Return when the catalog was downloaded."""
        return self.coordinator.catalog.updated

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return the catalog's size and age, and the last download error."""
        catalog = self.coordinator.catalog
        age = catalog.median_epoch_age(dt_util.utcnow())
        return {
            "catalog_size": len(catalog.satellites or []),
            # Half the satellites have older orbital elements than this.
            "age_days": None if age is None else round(age.total_seconds() / 86400, 1),
            "stale": age is not None and age > CATALOG_MAX_AGE,
            "last_download_error": catalog.last_error,
        }
