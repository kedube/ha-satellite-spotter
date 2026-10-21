"""Diagnostics for Satellite Spotter."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from . import SatelliteSpotterConfigEntry
from .const import CONF_GOOGLE_API_KEY, CONF_MAPILLARY_TOKEN

# The location, and every key the options take (each field the form masks).
TO_REDACT = {
    CONF_ELEVATION,
    CONF_LATITUDE,
    CONF_LONGITUDE,
    CONF_GOOGLE_API_KEY,
    CONF_MAPILLARY_TOKEN,
}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: SatelliteSpotterConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a config entry.

    Counts only: the times and look angles of the passes would reveal the
    location to within a few hundred metres.
    """
    coordinator = entry.runtime_data
    catalog = coordinator.catalog
    now = dt_util.utcnow()
    age = catalog.median_epoch_age(now)
    epochs = catalog.epoch_range()
    data = coordinator.data
    result: dict[str, Any] = {
        "entry": async_redact_data(dict(entry.data), TO_REDACT),
        "options": async_redact_data(dict(entry.options), TO_REDACT),
        "now": now.isoformat(),
        "last_update_success": coordinator.last_update_success,
        "paused": coordinator.paused_reason(now),
        "catalog": {
            "updated": None if catalog.updated is None else catalog.updated.isoformat(),
            "version": catalog.version,
            "satellites": len(catalog.satellites or ()),
            "median_epoch_age_days": None if age is None else round(age.total_seconds() / 86400, 2),
            "oldest_epoch": None if epochs is None else epochs[0].isoformat(),
            "newest_epoch": None if epochs is None else epochs[1].isoformat(),
            "last_error": catalog.last_error,
        },
    }
    if data is not None:
        result["predictions"] = {
            "computed_at": data.computed_at.isoformat(),
            "catalog_version": data.catalog_version,
            "pass_count": len(data.passes),
            "bright_pass_count": sum(p.bright for p in data.passes),
            "transit_count": sum(len(p.group.transits) for p in data.passes),
            "cloud_cover": {
                "enabled": coordinator.settings.cloud_cover,
                "available": data.cloud_cover,
            },
        }
    return result
