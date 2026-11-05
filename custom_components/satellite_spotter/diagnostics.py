"""Diagnostics: counts only, as the times and look angles of passes would reveal the location."""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import CONF_GOOGLE_API_KEY, CONF_MAPILLARY_TOKEN

if TYPE_CHECKING:
    from . import SatelliteSpotterConfigEntry

TO_REDACT = {
    CONF_LATITUDE,
    CONF_LONGITUDE,
    CONF_ELEVATION,
    CONF_GOOGLE_API_KEY,
    CONF_MAPILLARY_TOKEN,
}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: SatelliteSpotterConfigEntry
) -> dict[str, Any]:
    """Describe a location, without saying where it is or what passes over it when."""
    coordinator = entry.runtime_data
    catalog = coordinator.catalog
    now = dt_util.utcnow()
    age = catalog.median_epoch_age(now)
    oldest, newest = catalog.epoch_range() or (None, None)
    diagnostics: dict[str, Any] = {
        "entry": async_redact_data(entry.data, TO_REDACT),
        "options": async_redact_data(entry.options, TO_REDACT),
        "now": now.isoformat(),
        "last_update_success": coordinator.last_update_success,
        "paused": coordinator.paused_reason(now),
        "catalog": {
            "updated": None if catalog.updated is None else catalog.updated.isoformat(),
            "version": catalog.version,
            "satellites": len(catalog.satellites or ()),
            "median_epoch_age_days": None if age is None else round(age / timedelta(days=1), 2),
            "oldest_epoch": None if oldest is None else oldest.isoformat(),
            "newest_epoch": None if newest is None else newest.isoformat(),
            "last_error": catalog.last_error,
        },
    }
    if (data := coordinator.predictions) is not None:
        diagnostics["predictions"] = {
            "computed_at": data.computed_at.isoformat(),
            "catalog_version": data.catalog_version,
            "pass_count": len(data.passes),
            "bright_pass_count": sum(p.bright for p in data.passes),
            "sighting_count": sum(p.count for p in data.passes),
            "cloud_cover": {
                "enabled": data.cloud_cover is not None,
                "available": bool(data.cloud_cover),
            },
        }
    return diagnostics
