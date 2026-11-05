"""What the entities have in common, and the words they describe a pass in."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, override

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
    PANEL_URL_PATH,
    VERSION,
)
from .coordinator import ListedPass, SatelliteSpotterCoordinator
from .links import about_url
from .predict import Satellite

_KIND_BY_ID = {25544: "iss", 48274: "tiangong", 20580: "hubble"}
_ROCKET_WORDS = ("R/B", "PKM", "AKM")
_COMPASS_POINTS = (
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
)  # fmt: skip
_DEGREES_PER_POINT = 360.0 / len(_COMPASS_POINTS)


def satellite_kind(norad_id: int, name: str) -> str:
    """Say what sort of thing a satellite is, as the page's satelliteKind does."""
    if (kind := _KIND_BY_ID.get(norad_id)) is not None:
        return kind
    upper = name.upper()
    if "STARLINK" in upper:
        return "starlink"
    if any(word in upper for word in _ROCKET_WORDS):
        return "rocket"
    return "debris" if "DEB" in upper else "satellite"


def compass(azimuth: float) -> str:
    """Return the nearest of the 16 compass points; exactly halfway goes clockwise."""
    index = int((azimuth % 360.0 + _DEGREES_PER_POINT / 2) // _DEGREES_PER_POINT)
    return _COMPASS_POINTS[index % len(_COMPASS_POINTS)]


def magnitude(value: float) -> float:
    """Round a magnitude to one decimal, never to -0.0."""
    return round(value, 1) + 0.0


def confidence(when: datetime, sat: Satellite) -> str:
    """Say how far a time so far from the elements' epoch can be trusted: a rule of thumb."""
    days = abs(when - sat.epoch) / timedelta(days=1)
    if days <= CONFIDENCE_HIGH_DAYS:
        return "high"
    return "medium" if days <= CONFIDENCE_MEDIUM_DAYS else "low"


def local_time(when: datetime) -> datetime:
    """Return a moment as attributes give it: local, to the second."""
    return dt_util.as_local(when.replace(microsecond=0))


def _point(name: str, when: datetime, azimuth: float, elevation: float) -> dict[str, Any]:
    return {
        name: local_time(when),
        f"{name}_direction": compass(azimuth),
        f"{name}_azimuth": azimuth,
        f"{name}_elevation": elevation,
    }


def pass_attributes(p: ListedPass) -> dict[str, Any]:
    """Describe a pass: its times and places are those of the brightest satellite it brings."""
    lead, shape = p.lead, p.shapes[0]
    sat = lead.satellite
    highest = shape.peak
    return {
        "pass_id": p.id,
        "satellite": sat.name,
        "catalog_number": sat.norad_id,
        "kind": satellite_kind(sat.norad_id, sat.name),
        "about_url": about_url(sat.norad_id),
        "satellite_count": p.count,
        "satellites": [sighting.satellite.name for sighting in p.sightings[:MAX_GROUP_NAMES]],
        **_point("start", lead.appears.time, lead.appears.azimuth, lead.appears.elevation),
        **_point(
            "peak",
            dt_util.utc_from_timestamp(highest.time),
            round(highest.azimuth, 1) % 360.0,
            round(highest.elevation, 1),
        ),
        **_point("end", lead.vanishes.time, lead.vanishes.azimuth, lead.vanishes.elevation),
        "duration_seconds": lead.duration,
        "magnitude": magnitude(p.peak_magnitude),
        "bright": p.bright,
        "sun_up": p.sun_up,
        "cloud_cover": p.cloud_cover,
        "appears_from_shadow": shape.start_reason == "shadow",
        "disappears_into_shadow": shape.end_reason == "shadow",
        "confidence": confidence(lead.appears.time, sat),
    }


def upcoming_pass(p: ListedPass) -> dict[str, Any]:
    """Describe a whole pass in the list of what is coming, which goes with every state written."""
    return {
        "pass_id": p.id,
        "satellite": p.title,
        "start": local_time(p.start),
        "end": local_time(p.end),
        "peak_elevation": round(p.peak.elevation, 1),
        "peak_direction": compass(p.peak.azimuth),
        "duration_seconds": p.duration,
        "magnitude": magnitude(p.peak_magnitude),
        "bright": p.bright,
        "cloud_cover": p.cloud_cover,
    }


class SatelliteSpotterEntity(CoordinatorEntity[SatelliteSpotterCoordinator]):
    """An entity of a location, on that location's device."""

    _attr_has_entity_name = True
    _attr_attribution = ATTRIBUTION

    def __init__(self, coordinator: SatelliteSpotterCoordinator, key: str) -> None:
        """Name the entity after its key."""
        super().__init__(coordinator)
        entry = coordinator.config_entry
        self._attr_translation_key = key
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Satellite Spotter",
            model="Pass predictions",
            sw_version=VERSION,
            entry_type=DeviceEntryType.SERVICE,
            configuration_url=(
                f"homeassistant://{PANEL_URL_PATH}?entry_id={entry.entry_id}"
                if entry.options.get(CONF_SHOW_PANEL, DEFAULT_SHOW_PANEL)
                else None
            ),
        )


class LiveEntity(SatelliteSpotterEntity):
    """An entity saying where the satellite of the pass under way, or the next, is right now.

    The ones that change without a pass beginning or ending.
    """

    @override
    async def async_added_to_hass(self) -> None:
        """Follow the satellite."""
        await super().async_added_to_hass()
        self.async_on_remove(self.coordinator.async_add_live_listener(self.async_write_ha_state))
