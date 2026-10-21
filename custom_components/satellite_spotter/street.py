"""The street view's photo services: their settings, and a check of their keys.

The street view fetches its photos in the browser, so the keys go to the
browser (satellite_spotter/street). Home Assistant only tries a key once, in
the options flow, when it is new: a mistyped key is caught there rather than
showing up later as a missing photo. Neither check sends the location.
"""

from __future__ import annotations

from collections.abc import Mapping
import logging
import re
from typing import Any

from aiohttp import ClientError, ClientTimeout
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_GOOGLE_API_KEY,
    CONF_MAPILLARY_TOKEN,
    CONF_STREET_SOURCE,
    CONF_STREET_VIEW,
    DEFAULT_STREET_SOURCE,
    STREET_SOURCES,
    USER_AGENT,
)
from .coordinator import scrub

_LOGGER = logging.getLogger(__name__)

GOOGLE_SESSION_URL = "https://tile.googleapis.com/v1/createSession"
MAPILLARY_IMAGES_URL = "https://graph.mapillary.com/images"
CHECK_TIMEOUT = ClientTimeout(total=10)
# A key restricted to websites (or to the home's address) is refused when
# Home Assistant tries it, yet works in the browser: it can only be told there.
_GOOGLE_RESTRICTED = frozenset(
    {
        "API_KEY_HTTP_REFERRER_BLOCKED",
        "API_KEY_IP_ADDRESS_BLOCKED",
        "API_KEY_ANDROID_APP_BLOCKED",
        "API_KEY_IOS_APP_BLOCKED",
    }
)
# Anywhere with no photos at all (the sea at 0°, 0°): the token is tried
# without telling Mapillary where home is.
_NOWHERE = "0,0,0.001,0.001"
# Mapillary's client tokens: MLY|<application id>|<secret>. Mapillary answers
# a garbled one as if it were down, so the form says so itself.
MAPILLARY_TOKEN_FORMAT = re.compile(r"MLY\|\d+\|[0-9A-Za-z_-]+")
# Mapillary's (Facebook's) error code for a token it does not take, whatever the status.
_OAUTH_ERROR = 190


def street_options(options: Mapping[str, Any]) -> dict[str, Any]:
    """Return the options' street view section, checked: a known source, keys only when set."""
    street = dict(options.get(CONF_STREET_VIEW) or {})
    out: dict[str, Any] = {
        CONF_STREET_SOURCE: (
            street.get(CONF_STREET_SOURCE)
            if street.get(CONF_STREET_SOURCE) in STREET_SOURCES
            else DEFAULT_STREET_SOURCE
        )
    }
    for key in (CONF_MAPILLARY_TOKEN, CONF_GOOGLE_API_KEY):
        if value := str(street.get(key) or "").strip():
            out[key] = value
    return out


def street_payload(options: Mapping[str, Any]) -> dict[str, Any]:
    """Return what the street view needs to find photos: the source, and the keys or None."""
    street = street_options(options)
    return {
        "source": street[CONF_STREET_SOURCE],
        "mapillary_token": street.get(CONF_MAPILLARY_TOKEN),
        "google_api_key": street.get(CONF_GOOGLE_API_KEY),
    }


def _reason(data: Any, status: int) -> tuple[str, set[str], Any]:
    """Return the message of a Google or Mapillary error body, Google's reasons, and its code."""
    error = data.get("error") if isinstance(data, dict) else None
    if not isinstance(error, dict):
        return f"HTTP {status}", set(), None
    reasons = {
        detail["reason"]
        for detail in error.get("details") or ()
        if isinstance(detail, dict) and isinstance(detail.get("reason"), str)
    }
    message = error.get("message")
    text = message if isinstance(message, str) and message else f"HTTP {status}"
    return text, reasons, error.get("code")


async def async_check_google_key(hass: HomeAssistant, key: str) -> str | None:
    """Why Google refuses the key for Street View tiles; None when it works or cannot be told."""
    body = {
        "mapType": "streetview",
        "language": hass.config.language or "en",
        "region": (hass.config.country or "US").upper(),
    }
    try:
        async with async_get_clientsession(hass).post(
            GOOGLE_SESSION_URL,
            params={"key": key},
            json=body,
            headers={"User-Agent": USER_AGENT},
            timeout=CHECK_TIMEOUT,
        ) as response:
            if response.status == 200:
                return None
            status = response.status
            data = await response.json(content_type=None)
    except (ClientError, TimeoutError, ValueError) as err:
        # Offline, or Google is: the street view will say so if it lasts. Some
        # of aiohttp's errors name the URL, and the key is in its query.
        _LOGGER.debug("Could not try the Google API key: %s", scrub(err))
        return None
    message, reasons, _code = _reason(data, status)
    if reasons & _GOOGLE_RESTRICTED or status == 429 or status >= 500:
        return None
    return message


async def async_check_mapillary_token(hass: HomeAssistant, token: str) -> str | None:
    """Why Mapillary refuses the access token; None when it works or cannot be told."""
    params = {"access_token": token, "fields": "id", "limit": "1", "bbox": _NOWHERE}
    try:
        async with async_get_clientsession(hass).get(
            MAPILLARY_IMAGES_URL,
            params=params,
            headers={"User-Agent": USER_AGENT},
            timeout=CHECK_TIMEOUT,
        ) as response:
            if response.status == 200:
                return None
            status = response.status
            data = await response.json(content_type=None)
    except (ClientError, TimeoutError, ValueError) as err:
        _LOGGER.debug("Could not try the Mapillary access token: %s", scrub(err))
        return None
    message, _reasons, code = _reason(data, status)
    if code != _OAUTH_ERROR and (status == 429 or status >= 500):
        return None
    return message
