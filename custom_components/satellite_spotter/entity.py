"""Shared entity code, and how a pass is described in attributes and payloads."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

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
from .coordinator import SatellitePass, SatelliteSpotterCoordinator
from .links import info_url

if TYPE_CHECKING:
    from .predict import Direction, Satellite

_COMPASS = [
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
    """Return the 16-point compass direction of an azimuth in degrees."""
    sector = 360 / len(_COMPASS)
    return _COMPASS[round((azimuth % 360) / sector) % len(_COMPASS)]


def magnitude(value: float) -> float:
    """Round a magnitude to one decimal, never -0.0."""
    return round(value, 1) or 0.0


def pass_title(p: SatellitePass) -> str:
    """Return the short name of a pass, for example "ISS" or "Starlink-123 +59"."""
    name = p.lead.satellite.name
    others = p.flyover.satellite_count - 1
    return f"{name} +{others}" if others > 0 else name


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


def _look_attributes(prefix: str, angle: Direction) -> dict[str, Any]:
    """Describe one point of a pass: which way to look, and how high."""
    return {
        f"{prefix}_direction": compass(angle.azimuth),
        f"{prefix}_azimuth": angle.azimuth,
        f"{prefix}_elevation": angle.elevation,
    }


def pass_attributes(p: SatellitePass | None) -> dict[str, Any]:
    """Return the state attributes describing a pass; none without one.

    Automations read these names, so changing one breaks them.
    """
    if p is None:
        return {}
    first = p.lead
    sat = first.satellite
    flyover = p.flyover
    attributes: dict[str, Any] = {
        "satellite": sat.name,
        "norad_id": sat.norad_id,
        "start": first.start.isoformat(),
        "end": p.end.isoformat(),
        "duration": round((p.end - p.start).total_seconds()),
        "magnitude": magnitude(flyover.peak_magnitude),
        "bright": p.bright,
        "before_sunset": flyover.before_sunset,
        **_look_attributes("rise", first.appears),
        "brightest_time": first.peak_time.isoformat(),
        **_look_attributes("brightest", first.peak),
        **_look_attributes("set", first.vanishes),
        "cloud_cover": p.cloud_cover,
        "satellite_count": flyover.satellite_count,
        "info_url": info_url(sat.norad_id, sat.name),
        # Opens the pass in the sidebar page: /satellite-spotter?pass=<id>.
        "pass_id": p.id,
    }
    if len(flyover.sightings) > 1:
        names = [sighting.satellite.name for sighting in flyover.sightings]
        attributes["satellites"] = names[:MAX_GROUP_NAMES]
    return attributes


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
