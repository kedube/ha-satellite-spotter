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


@dataclass(frozen=True, kw_only=True)
class SatelliteSensorDescription(SensorEntityDescription):
    """Describes a sensor computed from the predicted passes."""

    value_fn: Callable[[SatelliteSpotterCoordinator, datetime], Any]
    attrs_fn: Callable[[SatelliteSpotterCoordinator, datetime], dict[str, Any]] | None = None
    # Stays available while predictions are paused, to show why.
    available_when_stale: bool = False


def _start(p: SatellitePass | None) -> datetime | None:
    return None if p is None else p.start


def _upcoming(c: SatelliteSpotterCoordinator, now: datetime) -> list[SatellitePass]:
    return [] if c.data is None else c.data.upcoming(now)


def _upcoming_attrs(c: SatelliteSpotterCoordinator, now: datetime) -> dict[str, Any]:
    return {
        "passes": [
            {
                "start": p.start.isoformat(),
                "satellite": pass_title(p),
                "magnitude": magnitude(p.group.min_magnitude),
                "direction": compass(p.primary.rise.azimuth),
                "cloud_cover": p.cloud_cover,
            }
            for p in _upcoming(c, now)[:MAX_LISTED_PASSES]
        ]
    }


def _catalog_attrs(c: SatelliteSpotterCoordinator, now: datetime) -> dict[str, Any]:
    satellites = c.catalog.satellites or []
    age = c.catalog.median_epoch_age(now)
    return {
        "satellites": len(satellites),
        # Half the satellites have older orbital elements than this.
        "age_days": None if age is None else round(age.total_seconds() / 86400, 1),
        "stale": age is not None and age > CATALOG_MAX_AGE,
        "last_download_error": c.catalog.last_error,
    }


SENSORS: tuple[SatelliteSensorDescription, ...] = (
    SatelliteSensorDescription(
        key="next_pass",
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=lambda c, now: _start(c.next_pass(now)),
        attrs_fn=lambda c, now: pass_attributes(c.next_pass(now)),
    ),
    SatelliteSensorDescription(
        key="next_bright_pass",
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=lambda c, now: _start(c.next_bright_pass(now)),
        attrs_fn=lambda c, now: pass_attributes(c.next_bright_pass(now)),
    ),
    SatelliteSensorDescription(
        key="passes_next_24h",
        value_fn=lambda c, now: len(_upcoming(c, now)),
        attrs_fn=_upcoming_attrs,
    ),
    SatelliteSensorDescription(
        key="catalog_updated",
        device_class=SensorDeviceClass.TIMESTAMP,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda c, now: c.catalog.updated,
        attrs_fn=_catalog_attrs,
        available_when_stale=True,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        (CatalogSensor if d.available_when_stale else SatelliteSensor)(coordinator, d)
        for d in SENSORS
    )


class SatelliteSensor(SatelliteSpotterEntity, SensorEntity):
    """A sensor derived from the predicted passes."""

    entity_description: SatelliteSensorDescription
    # Keep the lists out of the recorder database: they are large and change
    # with every pass.
    _unrecorded_attributes = frozenset({"passes", "satellites", "info_url"})

    def __init__(
        self, coordinator: SatelliteSpotterCoordinator, description: SatelliteSensorDescription
    ) -> None:
        """Initialise the sensor."""
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    @override
    def available(self) -> bool:
        """Return True while there is something to show."""
        if self.entity_description.available_when_stale:
            return self.coordinator.catalog.satellites is not None
        return super().available

    @property
    @override
    def native_value(self) -> Any:
        """Return the state."""
        return self.entity_description.value_fn(self.coordinator, dt_util.utcnow())

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Return details of the pass (or passes, or catalog)."""
        if self.entity_description.attrs_fn is None:
            return None
        return self.entity_description.attrs_fn(self.coordinator, dt_util.utcnow())


class CatalogSensor(SatelliteSensor):
    """When the catalog was downloaded; its satellite count is worth a history."""

    _unrecorded_attributes = frozenset()
