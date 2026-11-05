"""What the entities have in common, and the words they describe a pass in."""

from __future__ import annotations

from collections.abc import Callable
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
from .predict import Moment, Satellite

_KIND_BY_ID = {25544: "iss", 48274: "tiangong", 20580: "hubble"}
_ROCKET_WORDS = ("R/B", "PKM", "AKM")
_WINDS = (
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
)  # fmt: skip
_WIND_DEGREES = 360.0 / len(_WINDS)


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
    """Return the nearest of the 16 winds; exactly halfway goes clockwise."""
    return _WINDS[int((azimuth % 360.0 + _WIND_DEGREES / 2) // _WIND_DEGREES) % len(_WINDS)]


def magnitude(value: float) -> float:
    """Round a magnitude to one decimal, never to -0.0."""
    return round(value, 1) + 0.0


def confidence(when: datetime, sat: Satellite) -> str:
    """Say how far a time so far from the elements' epoch can be trusted: a rule of thumb."""
    days = abs(when - sat.epoch) / timedelta(days=1)
    if days <= CONFIDENCE_HIGH_DAYS:
        return "high"
    return "medium" if days <= CONFIDENCE_MEDIUM_DAYS else "low"


def _describe_moment(name: str, moment: Moment) -> dict[str, Any]:
    return {
        f"{name}_time": moment.time.isoformat(),
        f"{name}_direction": compass(moment.azimuth),
        f"{name}_azimuth": moment.azimuth,
        f"{name}_elevation": moment.elevation,
    }


def describe_pass(p: ListedPass | None) -> dict[str, Any]:
    """Return a pass's attributes, which automations and cards read; none without a pass."""
    if p is None:
        return {}
    lead = p.lead
    return {
        "pass_id": p.id,
        "object_name": lead.satellite.name,
        "catalog_number": lead.satellite.norad_id,
        "about_url": about_url(lead.satellite.norad_id),
        "object_count": p.count,
        "objects": [sighting.satellite.name for sighting in p.sightings[:MAX_GROUP_NAMES]],
        "peak_magnitude": magnitude(p.peak_magnitude),
        "is_bright": p.bright,
        "sun_up": p.sun_up,
        "cloud_percent": p.cloud_cover,
        "begins": p.start.isoformat(),
        "ends": p.end.isoformat(),
        "length_seconds": p.duration,
        **_describe_moment("appears", lead.appears),
        **_describe_moment("best_view", lead.brightest),
        **_describe_moment("disappears", lead.vanishes),
    }


class SatelliteSpotterEntity(CoordinatorEntity[SatelliteSpotterCoordinator]):
    """An entity of a location, on that location's device."""

    _attr_has_entity_name = True
    _attr_attribution = ATTRIBUTION

    def __init__(self, coordinator: SatelliteSpotterCoordinator, key: str) -> None:
        """Name the entity after its key: the keys are unique ids, and must not change."""
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


class PassEntity(SatelliteSpotterEntity):
    """An entity following one pass, and describing it."""

    _unrecorded_attributes = frozenset({"objects", "about_url"})

    def __init__(
        self,
        coordinator: SatelliteSpotterCoordinator,
        key: str,
        follow: Callable[[datetime], ListedPass | None],
    ) -> None:
        """Follow the pass that ``follow(now)`` finds."""
        super().__init__(coordinator, key)
        self._follow = follow

    def followed(self) -> ListedPass | None:
        """Return the pass followed just now."""
        return self._follow(dt_util.utcnow())

    @property
    @override
    def extra_state_attributes(self) -> dict[str, Any]:
        """Describe the pass followed."""
        return describe_pass(self.followed())
