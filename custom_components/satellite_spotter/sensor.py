"""The sensors of a location: the next passes, the satellite to watch, and the orbits' age."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, override

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
)
from homeassistant.const import DEGREE, PERCENTAGE, EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import MAX_UPCOMING_PASSES, RATINGS
from .coordinator import ListedPass, SatelliteSpotterCoordinator
from .entity import (
    LiveEntity,
    SatelliteSpotterEntity,
    compass,
    magnitude,
    pass_attributes,
    satellite_kind,
    upcoming_pass,
)
from .links import about_url

if TYPE_CHECKING:
    from . import SatelliteSpotterConfigEntry

PARALLEL_UPDATES = 0

_NEXT_VISIBLE = SatelliteSpotterCoordinator.next_visible_pass


@dataclass(frozen=True, kw_only=True)
class PassSensorDescription(SensorEntityDescription):
    """A sensor saying one thing about the pass it follows; unknown without one."""

    value: Callable[[ListedPass], Any]
    follow: Callable[[SatelliteSpotterCoordinator, datetime], ListedPass | None] = _NEXT_VISIBLE
    attributes: Callable[[ListedPass], dict[str, Any]] | None = None
    lists_upcoming: bool = False


def _satellite_details(p: ListedPass) -> dict[str, Any]:
    sat = p.lead.satellite
    return {
        "catalog_number": sat.norad_id,
        "kind": satellite_kind(sat.norad_id, sat.name),
        "about_url": about_url(sat.norad_id),
    }


PASS_SENSORS: tuple[PassSensorDescription, ...] = (
    PassSensorDescription(
        key="next_visible_pass",
        device_class=SensorDeviceClass.TIMESTAMP,
        value=lambda p: p.start,
        attributes=pass_attributes,
        lists_upcoming=True,
    ),
    PassSensorDescription(
        key="next_visible_pass_peak_elevation",
        native_unit_of_measurement=DEGREE,
        suggested_display_precision=0,
        value=lambda p: round(p.shapes[0].peak.elevation, 1),
    ),
    PassSensorDescription(
        key="next_visible_pass_brightness",
        suggested_display_precision=1,
        value=lambda p: magnitude(p.peak_magnitude),
    ),
    PassSensorDescription(
        key="next_visible_pass_duration",
        device_class=SensorDeviceClass.DURATION,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        suggested_unit_of_measurement=UnitOfTime.MINUTES,
        suggested_display_precision=1,
        value=lambda p: p.lead.duration,
    ),
    PassSensorDescription(
        key="next_visible_pass_cloud_cover",
        native_unit_of_measurement=PERCENTAGE,
        suggested_display_precision=0,
        value=lambda p: p.cloud_cover,
    ),
    PassSensorDescription(
        key="next_visible_pass_rating",
        device_class=SensorDeviceClass.ENUM,
        options=list(RATINGS),
        value=lambda p: p.rating,
    ),
    PassSensorDescription(
        key="next_visible_satellite_name",
        value=lambda p: p.lead.satellite.name,
        attributes=_satellite_details,
    ),
    PassSensorDescription(
        key="next_bright_pass",
        device_class=SensorDeviceClass.TIMESTAMP,
        follow=SatelliteSpotterCoordinator.next_bright_pass,
        value=lambda p: p.start,
        attributes=pass_attributes,
    ),
)

_UPCOMING_COUNT_KEY = "visible_passes_next_24_hours"
_ELEVATION_KEY = "satellite_elevation"
_EPOCH_KEY = "orbital_elements_epoch"

SENSOR_KEYS: tuple[str, ...] = (
    *(description.key for description in PASS_SENSORS),
    _UPCOMING_COUNT_KEY,
    _ELEVATION_KEY,
    _EPOCH_KEY,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add a location's sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        [
            *(PassSensor(coordinator, description) for description in PASS_SENSORS),
            VisiblePassCountSensor(coordinator, _UPCOMING_COUNT_KEY),
            SatelliteElevationSensor(coordinator, _ELEVATION_KEY),
            OrbitalElementsEpochSensor(coordinator, _EPOCH_KEY),
        ]
    )


class PassSensor(SatelliteSpotterEntity, SensorEntity):
    """One thing about the pass under way, or the next."""

    entity_description: PassSensorDescription
    _unrecorded_attributes = frozenset({"upcoming", "satellites", "about_url"})

    def __init__(
        self, coordinator: SatelliteSpotterCoordinator, description: PassSensorDescription
    ) -> None:
        """Say what the description says."""
        super().__init__(coordinator, description.key)
        self.entity_description = description

    def _followed(self) -> ListedPass | None:
        return self.entity_description.follow(self.coordinator, dt_util.utcnow())

    @property
    @override
    def native_value(self) -> Any:
        """Return what is said of the pass."""
        p = self._followed()
        return None if p is None else self.entity_description.value(p)

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Describe the pass, and what comes after it if that is listed here."""
        description = self.entity_description
        if description.attributes is None:
            return None
        now = dt_util.utcnow()
        p = description.follow(self.coordinator, now)
        attributes = {} if p is None else description.attributes(p)
        if description.lists_upcoming:
            coming = self.coordinator.passes_from(now)[:MAX_UPCOMING_PASSES]
            attributes["upcoming"] = [upcoming_pass(q) for q in coming]
        return attributes


class VisiblePassCountSensor(SatelliteSpotterEntity, SensorEntity):
    """How many passes are under way or start within a day."""

    @property
    @override
    def native_value(self) -> int:
        """Return how many; zero without data."""
        return self.coordinator.upcoming_count(dt_util.utcnow())


class SatelliteElevationSensor(LiveEntity, SensorEntity):
    """How high in the sky the satellite of the pass under way, or the next, is right now."""

    _attr_native_unit_of_measurement = DEGREE
    _attr_suggested_display_precision = 0
    _unrecorded_attributes = frozenset(
        {"satellite", "catalog_number", "azimuth", "direction", "range_km", "sunlit"}
    )

    @property
    @override
    def native_value(self) -> float | None:
        """Return the elevation in degrees: below zero while it is below the horizon."""
        live = self.coordinator.live
        return None if live is None else round(live.position.elevation, 1)

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Say which satellite this is, and where else to find it."""
        live = self.coordinator.live
        if live is None:
            return {}
        position = live.position
        return {
            "satellite": live.satellite.name,
            "catalog_number": live.satellite.norad_id,
            "azimuth": round(position.azimuth, 1),
            "direction": compass(position.azimuth),
            "range_km": round(position.range_km),
            "sunlit": position.sunlit,
        }


class OrbitalElementsEpochSensor(SatelliteSpotterEntity, SensorEntity):
    """How old the orbits are: there whenever a catalog is, to say why passes stop."""

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
        """Return the middle date of the catalog's orbital elements."""
        return self._catalog.median_epoch

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Describe the catalog."""
        now = dt_util.utcnow()
        age = self._catalog.median_epoch_age(now)
        updated = self._catalog.updated
        return {
            "downloaded": None if updated is None else dt_util.as_local(updated),
            "catalog_size": len(self._catalog.satellites or ()),
            "age_days": None if age is None else round(age / timedelta(days=1), 1),
            "stale": self.coordinator.stale_age(now) is not None,
            "last_download_error": self._catalog.last_error,
        }
