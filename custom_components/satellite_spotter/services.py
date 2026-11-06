"""The action listing a location's passes, for scripts, automations and voice assistants."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from homeassistant.components.http.auth import async_sign_path
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import ATTR_CONFIG_ENTRY_ID
from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
    callback,
)
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.util import dt as dt_util
import voluptuous as vol

from .const import (
    DOMAIN,
    GET_PASSES_DEFAULT_LIMIT,
    GET_PASSES_MAX_LIMIT,
    RATINGS,
    SERVICE_GET_PASSES,
    SKY_CHART_LINK_LIFETIME,
)
from .coordinator import ListedPass, SatelliteSpotterCoordinator
from .entity import confidence, satellite_kind, upcoming_pass
from .rating import at_least
from .sky_chart import sky_chart_path

KINDS = ("iss", "tiangong", "hubble", "starlink", "rocket", "debris", "satellite")

ATTR_PASS_ID = "pass_id"
ATTR_START = "start"
ATTR_END = "end"
ATTR_MIN_RATING = "min_rating"
ATTR_MAX_CLOUD_COVER = "max_cloud_cover"
ATTR_BRIGHT_ONLY = "bright_only"
ATTR_KINDS = "kinds"
ATTR_SATELLITE = "satellite"
ATTR_LIMIT = "limit"

GET_PASSES_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CONFIG_ENTRY_ID): cv.string,
        vol.Optional(ATTR_PASS_ID): cv.string,
        vol.Optional(ATTR_START): cv.datetime,
        vol.Optional(ATTR_END): cv.datetime,
        vol.Optional(ATTR_MIN_RATING): vol.In(RATINGS),
        vol.Optional(ATTR_MAX_CLOUD_COVER): vol.All(vol.Coerce(int), vol.Range(min=0, max=100)),
        vol.Optional(ATTR_BRIGHT_ONLY): cv.boolean,
        vol.Optional(ATTR_KINDS): vol.All(cv.ensure_list, [vol.In(KINDS)]),
        vol.Optional(ATTR_SATELLITE): cv.string,
        vol.Optional(ATTR_LIMIT, default=GET_PASSES_DEFAULT_LIMIT): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=GET_PASSES_MAX_LIMIT)
        ),
    }
)


def _coordinator(hass: HomeAssistant, entry_id: str) -> SatelliteSpotterCoordinator:
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None or entry.domain != DOMAIN:
        raise ServiceValidationError(translation_domain=DOMAIN, translation_key="unknown_location")
    if entry.state is not ConfigEntryState.LOADED:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="location_not_loaded"
        )
    coordinator: SatelliteSpotterCoordinator = entry.runtime_data
    return coordinator


def _kinds(p: ListedPass) -> set[str]:
    return {satellite_kind(s.satellite.norad_id, s.satellite.name) for s in p.sightings}


def _wanted(
    p: ListedPass, call: Mapping[str, Any], after: datetime | None, before: datetime | None
) -> bool:
    """Say whether a pass is among those asked for: one with no forecast counts as clear."""
    if (after is not None and p.end <= after) or (before is not None and p.start >= before):
        return False
    if (least := call.get(ATTR_MIN_RATING)) is not None and not at_least(p.rating, least):
        return False
    most_cloud = call.get(ATTR_MAX_CLOUD_COVER)
    if most_cloud is not None and p.cloud_cover is not None and p.cloud_cover > most_cloud:
        return False
    if call.get(ATTR_BRIGHT_ONLY) and not p.bright:
        return False
    if (kinds := call.get(ATTR_KINDS)) and not _kinds(p) & set(kinds):
        return False
    if (name := call.get(ATTR_SATELLITE)) is not None:
        return any(name.casefold() in s.satellite.name.casefold() for s in p.sightings)
    return True


def _as_text(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def _described(hass: HomeAssistant, entry_id: str, p: ListedPass) -> dict[str, Any]:
    """Describe a pass as the upcoming attribute does, with more of what automations want."""
    lead = p.lead.satellite
    path = sky_chart_path(entry_id, p.id)
    return {
        **{key: _as_text(value) for key, value in upcoming_pass(p).items()},
        "kind": satellite_kind(lead.norad_id, lead.name),
        "catalog_number": lead.norad_id,
        "satellite_count": p.count,
        "satellites": [s.satellite.name for s in p.sightings],
        "confidence": confidence(p.lead.appears.time, lead),
        # A link that needs no token, as a notification's image is fetched outside any session.
        "sky_chart": async_sign_path(hass, path, SKY_CHART_LINK_LIFETIME, use_content_user=True),
    }


@callback
def async_get_passes(call: ServiceCall) -> ServiceResponse:
    """List the passes of a location that fit what is asked for, soonest first."""
    data = call.data
    entry_id = data[ATTR_CONFIG_ENTRY_ID]
    coordinator = _coordinator(call.hass, entry_id)
    now = dt_util.utcnow()
    predictions = coordinator.predictions
    paused = coordinator.paused_reason(now)
    passes = [] if predictions is None or paused is not None else predictions.passes
    if (pass_id := data.get(ATTR_PASS_ID)) is not None:
        found = None if not passes or predictions is None else predictions.find(pass_id)
        passes = [] if found is None else [found]
    # Passes that are over stay out, unless they are asked for by when or by which.
    after = None if pass_id is not None else now
    if ATTR_START in data:
        after = dt_util.as_utc(data[ATTR_START])
    before = dt_util.as_utc(data[ATTR_END]) if ATTR_END in data else None
    listed = [p for p in passes if _wanted(p, data, after, before)][: data[ATTR_LIMIT]]
    return {
        "location": coordinator.title,
        "paused": paused,
        "passes": [_described(call.hass, entry_id, p) for p in listed],
    }


@callback
def async_setup_services(hass: HomeAssistant) -> None:
    """Offer the action, whether or not any location is loaded."""
    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_PASSES,
        async_get_passes,
        schema=GET_PASSES_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
