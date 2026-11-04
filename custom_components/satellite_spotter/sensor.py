"""Sensors: the next pass, the next bright pass, the passes of the next day, the catalog."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, override

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
)
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import SatelliteSpotterConfigEntry
from .const import CATALOG_MAX_AGE, MAX_LISTED_PASSES
from .coordinator import SatellitePass, SatelliteSpotterCoordinator
from .entity import SatelliteSpotterEntity, compass, magnitude, pass_attributes, pass_title

PARALLEL_UPDATES = 0

# Keep the lists out of the recorder database: they are large and change with
# every pass.
_LIST_ATTRIBUTES = frozenset({"passes", "satellites", "info_url"})


@dataclass(frozen=True, kw_only=True)
class PassSensorDescription(SensorEntityDescription):
    """Describes a sensor that follows one pass."""

    # The pass to report, or None when there is none.
    pass_fn: Callable[[SatelliteSpotterCoordinator, datetime], SatellitePass | None]


PASS_SENSORS: tuple[PassSensorDescription, ...] = (
    PassSensorDescription(
        key="next_pass",
        device_class=SensorDeviceClass.TIMESTAMP,
        pass_fn=lambda c, now: c.next_pass(now),
    ),
    PassSensorDescription(
        key="next_bright_pass",
        device_class=SensorDeviceClass.TIMESTAMP,
        pass_fn=lambda c, now: c.next_bright_pass(now),
    ),
)
PASS_COUNT_SENSOR = SensorEntityDescription(key="passes_next_24h")
CATALOG_SENSOR = SensorEntityDescription(
    key="catalog_updated",
    device_class=SensorDeviceClass.TIMESTAMP,
    entity_category=EntityCategory.DIAGNOSTIC,
)
SENSORS: tuple[SensorEntityDescription, ...] = (*PASS_SENSORS, PASS_COUNT_SENSOR, CATALOG_SENSOR)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        [
            *(PassSensor(coordinator, description) for description in PASS_SENSORS),
            PassCountSensor(coordinator, PASS_COUNT_SENSOR),
            CatalogSensor(coordinator, CATALOG_SENSOR),
        ]
    )


class LocationSensor(SatelliteSpotterEntity, SensorEntity):
    """A sensor of one location, set up from its description."""

    def __init__(
        self, coordinator: SatelliteSpotterCoordinator, description: SensorEntityDescription
    ) -> None:
        """Initialise the sensor."""
        super().__init__(coordinator, description.key)
        self.entity_description = description


class PassSensor(LocationSensor):
    """When a pass starts, with the pass's details."""

    entity_description: PassSensorDescription
    _unrecorded_attributes = _LIST_ATTRIBUTES

    def _followed_pass(self) -> SatellitePass | None:
        return self.entity_description.pass_fn(self.coordinator, dt_util.utcnow())

    @property
    @override
    def native_value(self) -> datetime | None:
        """Return when the pass starts."""
        followed = self._followed_pass()
        return None if followed is None else followed.start

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return the details of the pass."""
        return pass_attributes(self._followed_pass())


class PassCountSensor(LocationSensor):
    """How many passes are under way or start within a day, and which."""

    _unrecorded_attributes = _LIST_ATTRIBUTES

    def _upcoming(self) -> list[SatellitePass]:
        data = self.coordinator.data
        return [] if data is None else data.upcoming(dt_util.utcnow())

    @property
    @override
    def native_value(self) -> int:
        """Return the number of passes."""
        return len(self._upcoming())

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return a short description of each pass, up to the limit."""
        return {"passes": [_listed_pass(p) for p in self._upcoming()[:MAX_LISTED_PASSES]]}


def _listed_pass(p: SatellitePass) -> dict[str, Any]:
    return {
        "start": p.start.isoformat(),
        "satellite": pass_title(p),
        "magnitude": magnitude(p.group.min_magnitude),
        "direction": compass(p.primary.rise.azimuth),
        "cloud_cover": p.cloud_cover,
    }


class CatalogSensor(LocationSensor):
    """When the catalog was downloaded; its satellite count is worth a history."""

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
            "satellites": len(catalog.satellites or []),
            # Half the satellites have older orbital elements than this.
            "age_days": None if age is None else round(age.total_seconds() / 86400, 1),
            "stale": age is not None and age > CATALOG_MAX_AGE,
            "last_download_error": catalog.last_error,
        }
