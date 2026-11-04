"""Shared entity code, and how a pass is described in attributes and payloads."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    ATTRIBUTION,
    CONFIDENCE_HIGH_DAYS,
    CONFIDENCE_MEDIUM_DAYS,
    DOMAIN,
    MAX_GROUP_NAMES,
    VERSION,
    WEBSITE_URL,
)
from .coordinator import SatellitePass, SatelliteSpotterCoordinator
from .links import info_url

if TYPE_CHECKING:
    from pysatellitespotter import LookAngle, Satellite

_COMPASS = (
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
)  # fmt: skip
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
    name = p.primary.satellite.name.removesuffix(" prediction")
    others = p.group.satellite_count - 1
    return f"{name} +{others}" if others > 0 else name


def confidence(when: datetime, sat: Satellite) -> str:
    """How far the timing of a prediction can be trusted (rule of thumb).

    By how far the pass is from the epoch of the satellite's orbital
    elements; a launch prediction's elements are guesses.
    """
    if sat.prediction:
        return "low"
    days = abs((when - sat.epoch).total_seconds()) / 86400
    if days <= CONFIDENCE_HIGH_DAYS:
        return "high"
    if days <= CONFIDENCE_MEDIUM_DAYS:
        return "medium"
    return "low"


def _look_attributes(prefix: str, angle: LookAngle) -> dict[str, Any]:
    """Describe one point of a pass: which way to look, and how high."""
    return {
        f"{prefix}_direction": compass(angle.azimuth),
        f"{prefix}_azimuth": angle.azimuth,
        f"{prefix}_elevation": angle.elevation,
    }


def pass_attributes(p: SatellitePass | None) -> dict[str, Any]:
    """Return the state attributes describing a pass; none without one.

    Automations read these names, which are those of the See A Satellite
    Tonight integration plus pass_id, so keep them as they are.
    """
    if p is None:
        return {}
    first = p.primary
    sat = first.satellite
    group = p.group
    attributes: dict[str, Any] = {
        "satellite": sat.name,
        "norad_id": sat.norad_id,
        "start": first.start.isoformat(),
        "end": p.end.isoformat(),
        "duration": round((p.end - p.start).total_seconds()),
        "magnitude": magnitude(group.min_magnitude),
        "bright": p.bright,
        "before_sunset": group.before_sunset,
        **_look_attributes("rise", first.rise),
        "brightest_time": first.brightest_time.isoformat(),
        **_look_attributes("brightest", first.brightest),
        **_look_attributes("set", first.set),
        "cloud_cover": p.cloud_cover,
        "satellite_count": group.satellite_count,
        "info_url": info_url(sat.norad_id, sat.name),
        # Opens the pass in the sidebar page: /satellite-spotter?pass=<id>.
        "pass_id": p.id,
    }
    if len(group.transits) > 1:
        names = [transit.satellite.name for transit in group.transits]
        attributes["satellites"] = names[:MAX_GROUP_NAMES]
    return attributes


def _location_device(coordinator: SatelliteSpotterCoordinator) -> DeviceInfo:
    """Return the device a location's entities share: the website, seen from there."""
    entry_id = coordinator.config_entry.entry_id
    observer = coordinator.observer
    return DeviceInfo(
        identifiers={(DOMAIN, entry_id)},
        name=coordinator.config_entry.title,
        manufacturer="James Darpinian",
        model="See A Satellite Tonight",
        sw_version=VERSION,
        entry_type=DeviceEntryType.SERVICE,
        configuration_url=f"{WEBSITE_URL}#loc={observer.latitude:.4f},{observer.longitude:.4f}",
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
