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

if TYPE_CHECKING:
    from pysatellitespotter import Satellite

_COMPASS = (
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
)  # fmt: skip

# The website's "About" links.
_INFO_LINKS = {
    20580: "https://en.wikipedia.org/wiki/Hubble_Space_Telescope",
    25544: "https://en.wikipedia.org/wiki/International_Space_Station",
    41765: "https://en.wikipedia.org/wiki/Tiangong-2",
    41868: "https://en.wikipedia.org/wiki/Shenzhou_11",
    42830: "https://earthsky.org/space/mayak-bright-russian-satellite-july-august-2017",
    43552: "https://brownspace.org/equisat/",
    48274: "https://en.wikipedia.org/wiki/Tiangong_space_station",
    53807: "https://ast-science.com/spacemobile-network/bluewalker-3/",
    59588: "https://www.nasa.gov/mission/acs3/",
}
_INFO_PREFIXES = (
    ("Starlink", "https://en.wikipedia.org/wiki/Starlink"),
    ("SPACEMOBILE", "https://en.wikipedia.org/wiki/AST_SpaceMobile"),
    ("QIANFAN", "https://en.wikipedia.org/wiki/Qianfan"),
    ("HULIANWANG", "https://en.wikipedia.org/wiki/Guowang"),
    ("GUOWANG", "https://en.wikipedia.org/wiki/Guowang"),
    ("ARIANE", "https://en.wikipedia.org/wiki/Ariane_(rocket_family)"),
    ("COSMOS", "https://en.wikipedia.org/wiki/Kosmos_(satellite)"),
    ("CZ-3", "https://en.wikipedia.org/wiki/Long_March_3"),
    ("SL-", "https://en.wikipedia.org/wiki/Zenit_(rocket_family)"),
    ("FALCON 9", "https://en.wikipedia.org/wiki/Falcon_9"),
    ("ATLAS", "https://en.wikipedia.org/wiki/Atlas_(rocket_family)"),
    ("BLOCK DM-SL", "https://en.wikipedia.org/wiki/Blok_D"),
    ("BREEZE-M", "https://en.wikipedia.org/wiki/Briz_(rocket_stage)"),
    ("CZ-", "https://en.wikipedia.org/wiki/Long_March_(rocket_family)"),
    ("TITAN", "https://en.wikipedia.org/wiki/Titan_(rocket_family)"),
    ("H-2", "https://en.wikipedia.org/wiki/H-II"),
)
# Satellites with a look of their own on the globe, by NORAD id.
_KINDS = {25544: "iss", 48274: "tiangong", 20580: "hubble"}


def info_url(norad_id: int, name: str) -> str:
    """Where to read about a satellite (as the website links it)."""
    if norad_id in _INFO_LINKS:
        return _INFO_LINKS[norad_id]
    for prefix, url in _INFO_PREFIXES:
        if name.startswith(prefix):
            return url
    return f"https://heavens-above.com/satinfo.aspx?satid={norad_id}"


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
    """16-point compass direction of an azimuth in degrees."""
    return _COMPASS[round((azimuth % 360) / 22.5) % 16]


def magnitude(value: float) -> float:
    """Round a magnitude to one decimal, never -0.0."""
    return round(value, 1) + 0.0


def pass_title(p: SatellitePass) -> str:
    """Short name of a pass, for example "ISS" or "Starlink-123 +59"."""
    title = p.primary.satellite.name.removesuffix(" prediction")
    if (extra := p.group.satellite_count - 1) > 0:
        title += f" +{extra}"
    return title


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


def pass_attributes(p: SatellitePass | None) -> dict[str, Any]:
    """State attributes describing a pass (those of See A Satellite Tonight, plus its id)."""
    if p is None:
        return {}
    t = p.primary
    sat = t.satellite
    attrs: dict[str, Any] = {
        "satellite": sat.name,
        "norad_id": sat.norad_id,
        "start": t.start.isoformat(),
        "end": p.end.isoformat(),
        "duration": round((p.end - p.start).total_seconds()),
        "magnitude": magnitude(p.group.min_magnitude),
        "bright": p.bright,
        "before_sunset": p.group.before_sunset,
        "rise_direction": compass(t.rise.azimuth),
        "rise_azimuth": t.rise.azimuth,
        "rise_elevation": t.rise.elevation,
        "brightest_time": t.brightest_time.isoformat(),
        "brightest_direction": compass(t.brightest.azimuth),
        "brightest_azimuth": t.brightest.azimuth,
        "brightest_elevation": t.brightest.elevation,
        "set_direction": compass(t.set.azimuth),
        "set_azimuth": t.set.azimuth,
        "set_elevation": t.set.elevation,
        "cloud_cover": p.cloud_cover,
        "satellite_count": p.group.satellite_count,
        "info_url": info_url(sat.norad_id, sat.name),
        # Opens the pass in the sidebar page: /satellite-spotter?pass=<id>.
        "pass_id": p.id,
    }
    if len(p.group.transits) > 1:
        attrs["satellites"] = [x.satellite.name for x in p.group.transits[:MAX_GROUP_NAMES]]
    return attrs


class SatelliteSpotterEntity(CoordinatorEntity[SatelliteSpotterCoordinator]):
    """Common device and naming for the entities of a location."""

    _attr_has_entity_name = True
    _attr_attribution = ATTRIBUTION

    def __init__(self, coordinator: SatelliteSpotterCoordinator, key: str) -> None:
        """Initialise the entity."""
        super().__init__(coordinator)
        entry = coordinator.config_entry
        observer = coordinator.observer
        self._attr_translation_key = key
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="James Darpinian",
            model="See A Satellite Tonight",
            sw_version=VERSION,
            entry_type=DeviceEntryType.SERVICE,
            configuration_url=(
                f"{WEBSITE_URL}#loc={observer.latitude:.4f},{observer.longitude:.4f}"
            ),
        )
