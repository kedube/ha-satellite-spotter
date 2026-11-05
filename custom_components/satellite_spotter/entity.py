"""Shared entity code, and how a pass is described in attributes and payloads."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any, override

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from .const import (
    ATTRIBUTION,
    CONF_SHOW_PANEL,
    CONFIDENCE_HIGH_DAYS,
    CONFIDENCE_MEDIUM_DAYS,
    DEFAULT_SHOW_PANEL,
    DOMAIN,
    MAX_GROUP_NAMES,
    VERSION,
)
from .coordinator import ListedPass, SatelliteSpotterCoordinator
from .links import about_url

if TYPE_CHECKING:
    from .predict import Moment, Satellite

# The sixteen winds, clockwise from north.
_WINDS = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
]
# Satellites with a look of their own on the globe, by NORAD id.
_KINDS = {25544: "iss", 48274: "tiangong", 20580: "hubble"}


def satellite_kind(norad_id: int, name: str) -> str:
    """Return what a satellite is, for its icon.

    One of iss, tiangong, hubble, starlink, rocket, debris and satellite.

    The frontend's satelliteKind() follows the same rules.
    """
    if norad_id in _KINDS:
        return _KINDS[norad_id]
    upper = name.upper()
    if "STARLINK" in upper:
        return "starlink"
    if any(token in upper for token in ("R/B", "PKM", "AKM")):
        return "rocket"
    if "DEB" in upper:
        return "debris"
    return "satellite"


def compass(azimuth: float) -> str:
    """Name the nearest of the sixteen winds to an azimuth in degrees; halfway goes clockwise."""
    width = 360 / len(_WINDS)
    return _WINDS[int((azimuth + width / 2) % 360 // width)]


def magnitude(value: float) -> float:
    """Round a magnitude to one decimal, never -0.0."""
    return round(value, 1) or 0.0


def confidence(when: datetime, sat: Satellite) -> str:
    """How far the timing of a prediction can be trusted (rule of thumb).

    By how far the pass is from the epoch of the satellite's orbital
    elements.
    """
    days = abs((when - sat.epoch).total_seconds()) / 86400
    if days <= CONFIDENCE_HIGH_DAYS:
        return "high"
    if days <= CONFIDENCE_MEDIUM_DAYS:
        return "medium"
    return "low"


def _moment(name: str, moment: Moment) -> dict[str, Any]:
    """Describe a moment of a sighting: when it comes, which way to look, and how high."""
    return {
        f"{name}_time": moment.time.isoformat(),
        f"{name}_direction": compass(moment.azimuth),
        f"{name}_azimuth": moment.azimuth,
        f"{name}_elevation": moment.elevation,
    }


def describe_pass(p: ListedPass | None) -> dict[str, Any]:
    """Describe a pass for automations, which read these names; nothing without a pass.

    ``begins``, ``ends`` and ``length_seconds`` are the whole pass's. The three moments are the
    satellite's it is named after, which is the one worth looking for.
    """
    if p is None:
        return {}
    named = p.lead
    sat = named.satellite
    return {
        # Opens the pass in the sidebar page: /satellite-spotter?pass=<id>.
        "pass_id": p.id,
        "object_name": sat.name,
        "catalog_number": sat.norad_id,
        "about_url": about_url(sat.norad_id),
        "object_count": p.count,
        "objects": [s.satellite.name for s in p.sightings[:MAX_GROUP_NAMES]],
        "peak_magnitude": magnitude(p.peak_magnitude),
        "is_bright": p.bright,
        "sun_up": p.sun_up,
        "cloud_percent": p.cloud_cover,
        "begins": p.start.isoformat(),
        "ends": p.end.isoformat(),
        "length_seconds": p.duration,
        **_moment("appears", named.appears),
        **_moment("best_view", named.brightest),
        **_moment("disappears", named.vanishes),
    }


def _location_device(coordinator: SatelliteSpotterCoordinator) -> DeviceInfo:
    """Return the device a location's entities share; its link opens the location's page."""
    entry = coordinator.config_entry
    entry_id = entry.entry_id
    page = f"homeassistant://satellite-spotter?entry_id={entry_id}"
    return DeviceInfo(
        identifiers={(DOMAIN, entry_id)},
        name=entry.title,
        manufacturer="Satellite Spotter",
        model="Pass predictions",
        sw_version=VERSION,
        entry_type=DeviceEntryType.SERVICE,
        # Without the sidebar page there is nothing for the link to open.
        configuration_url=page if entry.options.get(CONF_SHOW_PANEL, DEFAULT_SHOW_PANEL) else None,
    )


class SatelliteSpotterEntity(CoordinatorEntity[SatelliteSpotterCoordinator]):
    """An entity of one location, named by its translation key."""

    _attr_has_entity_name = True

    _attr_attribution = ATTRIBUTION

    def __init__(self, coordinator: SatelliteSpotterCoordinator, key: str) -> None:
        """Initialise the entity."""
        super().__init__(coordinator)
        self._attr_translation_key = key
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_{key}"
        self._attr_device_info = _location_device(coordinator)


class PassEntity(SatelliteSpotterEntity):
    """An entity that follows one pass at a time, and carries its details."""

    _unrecorded_attributes = frozenset({"objects", "about_url"})

    def __init__(
        self,
        coordinator: SatelliteSpotterCoordinator,
        key: str,
        follow: Callable[[datetime], ListedPass | None],
    ) -> None:
        """Initialise the entity, with how to find the pass it follows at a given time."""
        super().__init__(coordinator, key)
        self._follow = follow

    def followed(self) -> ListedPass | None:
        """Return the pass it follows now, if there is one."""
        return self._follow(dt_util.utcnow())

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return the details of that pass, or nothing without one."""
        return describe_pass(self.followed())
