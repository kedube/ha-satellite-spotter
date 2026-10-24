"""Tests for the config, reconfigure and options flows."""

from __future__ import annotations

import logging
from typing import Any
from unittest.mock import AsyncMock

from aiohttp import ClientError, RequestInfo, TooManyRedirects
from homeassistant.config_entries import SOURCE_RECONFIGURE, SOURCE_USER
from homeassistant.const import (
    CONF_ELEVATION,
    CONF_LATITUDE,
    CONF_LOCATION,
    CONF_LONGITUDE,
    CONF_NAME,
)
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType, InvalidData
from multidict import CIMultiDict, CIMultiDictProxy
from pysatellitespotter import CatalogError
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker
import voluptuous as vol
from yarl import URL

from custom_components.satellite_spotter.const import (
    CONF_ALERT_LEAD_MINUTES,
    CONF_CLOUD_COVER,
    CONF_GOOGLE_API_KEY,
    CONF_MAPILLARY_TOKEN,
    CONF_MAX_MAGNITUDE,
    CONF_SHOW_CALENDAR,
    CONF_SHOW_PANEL,
    CONF_STREET_SOURCE,
    CONF_STREET_VIEW,
    CONF_UNITS,
    DOMAIN,
)
from custom_components.satellite_spotter.street import GOOGLE_SESSION_URL, MAPILLARY_IMAGES_URL

OPTIONS = {
    CONF_MAX_MAGNITUDE: 1.5,
    CONF_CLOUD_COVER: False,
    CONF_ALERT_LEAD_MINUTES: 30,
    CONF_SHOW_PANEL: False,
    CONF_SHOW_CALENDAR: True,
    CONF_UNITS: "metric",
    CONF_STREET_VIEW: {CONF_STREET_SOURCE: "panoramax"},
}
GOOGLE_KEY = "AIzaSyTestKey0123456789"
MAPILLARY_TOKEN = "MLY|1234567890|abcdef0123456789"

pytestmark = pytest.mark.usefixtures("mock_setup_entry")


def _user_input(lat: float = 42.36012345, lon: float = -71.0589) -> dict[str, Any]:
    return {
        CONF_NAME: "Backyard",
        CONF_LOCATION: {CONF_LATITUDE: lat, CONF_LONGITUDE: lon},
        CONF_ELEVATION: 12,
    }


async def _add(hass: HomeAssistant, user_input: dict[str, Any]) -> dict[str, Any]:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    return await hass.config_entries.flow.async_configure(result["flow_id"], user_input)


async def test_user_flow(
    hass: HomeAssistant,
    mock_pysatellitespotter: dict[str, AsyncMock],
    mock_setup_entry: AsyncMock,
) -> None:
    """A location is set up once the catalog is reachable; it fetches the catalog for all."""
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {}
    defaults = {str(key): key.default() for key in result["data_schema"].schema}
    assert defaults[CONF_NAME] == "Home"
    assert defaults[CONF_LOCATION] == {
        CONF_LATITUDE: hass.config.latitude,
        CONF_LONGITUDE: hass.config.longitude,
    }

    result = await hass.config_entries.flow.async_configure(result["flow_id"], _user_input())
    await hass.async_block_till_done()
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Backyard"
    assert result["data"] == {
        CONF_LATITUDE: 42.36012,
        CONF_LONGITUDE: -71.0589,
        CONF_ELEVATION: 12.0,
    }
    assert result["result"].unique_id == "42.3601_-71.0589"
    mock_pysatellitespotter["fetch_site_catalog"].assert_awaited_once()
    assert mock_setup_entry.call_count == 1


@pytest.mark.parametrize(
    ("side_effect", "error"),
    [(CatalogError("boom"), "cannot_connect"), (RuntimeError("boom"), "unknown")],
)
async def test_user_flow_errors(
    hass: HomeAssistant,
    mock_pysatellitespotter: dict[str, AsyncMock],
    side_effect: Exception,
    error: str,
) -> None:
    """Errors are shown, what was typed is kept, and the form can be sent again."""
    mock_pysatellitespotter["fetch_site_catalog"].side_effect = side_effect
    result = await _add(hass, _user_input())
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": error}
    suggested = {
        str(key): key.description["suggested_value"]
        for key in result["data_schema"].schema
        if key.description and "suggested_value" in key.description
    }
    assert suggested[CONF_NAME] == "Backyard"

    mock_pysatellitespotter["fetch_site_catalog"].side_effect = None
    result = await hass.config_entries.flow.async_configure(result["flow_id"], _user_input())
    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_catalog_shared_between_flows(
    hass: HomeAssistant, mock_pysatellitespotter: dict[str, AsyncMock]
) -> None:
    """Adding another location reuses the catalog instead of downloading it again."""
    for latitude in (52.0, 60.0):
        result = await _add(hass, _user_input(lat=latitude))
        assert result["type"] is FlowResultType.CREATE_ENTRY
    mock_pysatellitespotter["fetch_site_catalog"].assert_awaited_once()


async def test_duplicate_location_aborts(
    hass: HomeAssistant, mock_pysatellitespotter: dict[str, AsyncMock]
) -> None:
    """The same place (to about 10 m) can only be added once, without asking the website."""
    MockConfigEntry(domain=DOMAIN, unique_id="42.3601_-71.0589").add_to_hass(hass)
    result = await _add(hass, _user_input(42.36011, -71.05894))
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    mock_pysatellitespotter["fetch_site_catalog"].assert_not_awaited()


@pytest.mark.usefixtures("mock_pysatellitespotter")
@pytest.mark.parametrize("latitude", [423.601, -95.0, 90.0001, float("nan")])
async def test_out_of_range_latitude_is_refused(hass: HomeAssistant, latitude: float) -> None:
    result = await _add(hass, _user_input(lat=latitude))
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {CONF_LOCATION: "invalid_location"}
    # What was typed is kept, so only the location needs correcting.
    suggested = {
        str(key): key.description["suggested_value"]
        for key in result["data_schema"].schema
        if key.description and "suggested_value" in key.description
    }
    assert suggested[CONF_NAME] == "Backyard"
    assert suggested[CONF_ELEVATION] == 12

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], _user_input(lat=42.36)
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_LATITUDE] == 42.36


@pytest.mark.usefixtures("mock_pysatellitespotter")
@pytest.mark.parametrize(
    ("longitude", "expected"),
    [(288.94, -71.06), (-431.06, -71.06), (180.0, 180.0), (-180.0, -180.0), (179.99999, 179.99999)],
)
async def test_longitude_is_normalised(
    hass: HomeAssistant, longitude: float, expected: float
) -> None:
    result = await _add(hass, _user_input(lon=longitude))
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_LONGITUDE] == expected
    assert result["result"].unique_id == f"42.3601_{expected:.4f}"


@pytest.mark.usefixtures("mock_pysatellitespotter")
@pytest.mark.parametrize("longitude", [288.94, -431.06])
async def test_wrapped_longitude_is_a_duplicate(hass: HomeAssistant, longitude: float) -> None:
    MockConfigEntry(domain=DOMAIN, unique_id="42.3601_-71.0600").add_to_hass(hass)
    result = await _add(hass, _user_input(lon=longitude))
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


def _reconfigure_input(lat: float, lon: float, elevation: float = 40) -> dict[str, Any]:
    return {CONF_LOCATION: {CONF_LATITUDE: lat, CONF_LONGITUDE: lon}, CONF_ELEVATION: elevation}


async def test_reconfigure_moves_the_location(
    hass: HomeAssistant, mock_setup_entry: AsyncMock
) -> None:
    """Correcting the coordinates keeps the entry, so cards bound to it keep working."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Backyard",
        data={CONF_LATITUDE: 42.36, CONF_LONGITUDE: -71.06, CONF_ELEVATION: 12.0},
        unique_id="42.3600_-71.0600",
    )
    entry.add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_RECONFIGURE, "entry_id": entry.entry_id}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "reconfigure"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], _reconfigure_input(95, -71.06)
    )
    assert result["errors"] == {CONF_LOCATION: "invalid_location"}

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], _reconfigure_input(42.35, 288.95)
    )
    await hass.async_block_till_done()
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reconfigure_successful"
    assert entry.data == {CONF_LATITUDE: 42.35, CONF_LONGITUDE: -71.05, CONF_ELEVATION: 40.0}
    assert entry.unique_id == "42.3500_-71.0500"
    assert entry.title == "Backyard"
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1
    # Not loaded, so nothing else would pick the change up: it is set up now.
    assert mock_setup_entry.call_count == 1


async def test_reconfigure_keeps_the_place_or_refuses_a_duplicate(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={CONF_LATITUDE: 42.36, CONF_LONGITUDE: -71.06, CONF_ELEVATION: 12.0},
        unique_id="42.3600_-71.0600",
    )
    entry.add_to_hass(hass)
    MockConfigEntry(domain=DOMAIN, unique_id="51.5000_-0.1200").add_to_hass(hass)

    # Only the elevation changes: the location is still its own.
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_RECONFIGURE, "entry_id": entry.entry_id}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], _reconfigure_input(42.36, -71.06, 15)
    )
    await hass.async_block_till_done()
    assert result["reason"] == "reconfigure_successful"
    assert entry.data[CONF_ELEVATION] == 15.0

    # Moving onto another location is refused.
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_RECONFIGURE, "entry_id": entry.entry_id}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], _reconfigure_input(51.5, -0.12)
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert entry.unique_id == "42.3600_-71.0600"


def _defaults(schema: Any) -> dict[str, Any]:
    """The defaults a form offers, the street view section's included."""
    out: dict[str, Any] = {}
    for key, value in schema.schema.items():
        if str(key) == CONF_STREET_VIEW:
            out[str(key)] = {
                str(k): k.default() for k in value.schema.schema if k.default is not vol.UNDEFINED
            }
        else:
            out[str(key)] = key.default()
    return out


def _suggested(schema: Any) -> dict[str, Any]:
    """The street view section's suggested values (what the form shows as typed)."""
    (section_key,) = [k for k in schema.schema if str(k) == CONF_STREET_VIEW]
    return {
        str(k): (k.description or {}).get("suggested_value")
        for k in schema.schema[section_key].schema.schema
    }


async def _options(hass: HomeAssistant, entry: MockConfigEntry, **street: Any) -> dict[str, Any]:
    result = await hass.config_entries.options.async_init(entry.entry_id)
    return await hass.config_entries.options.async_configure(
        result["flow_id"], {**OPTIONS, CONF_STREET_VIEW: street}
    )


async def test_options_flow(hass: HomeAssistant) -> None:
    """The options are stored on the entry; the form offers the current ones."""
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_LATITUDE: 1, CONF_LONGITUDE: 2})
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    assert _defaults(result["data_schema"]) == {
        CONF_MAX_MAGNITUDE: 3.0,
        CONF_CLOUD_COVER: True,
        CONF_ALERT_LEAD_MINUTES: 15,
        CONF_SHOW_PANEL: True,
        CONF_SHOW_CALENDAR: True,
        CONF_UNITS: "auto",
        CONF_STREET_VIEW: {CONF_STREET_SOURCE: "auto"},
    }

    result = await hass.config_entries.options.async_configure(result["flow_id"], OPTIONS)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options == OPTIONS

    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert _defaults(result["data_schema"]) == OPTIONS


async def test_street_keys_are_tried_kept_and_removed(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """New keys are tried once (not with the location), kept trimmed, offered again, removable."""
    aioclient_mock.post(GOOGLE_SESSION_URL, json={"session": "s", "expiry": "1"})
    aioclient_mock.get(MAPILLARY_IMAGES_URL, json={"data": []})
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_LATITUDE: 52.09, CONF_LONGITUDE: 5.12})
    entry.add_to_hass(hass)
    result = await _options(
        hass,
        entry,
        **{
            CONF_STREET_SOURCE: "google",
            CONF_GOOGLE_API_KEY: f"  {GOOGLE_KEY} ",
            CONF_MAPILLARY_TOKEN: MAPILLARY_TOKEN,
        },
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options[CONF_STREET_VIEW] == {
        CONF_STREET_SOURCE: "google",
        CONF_GOOGLE_API_KEY: GOOGLE_KEY,
        CONF_MAPILLARY_TOKEN: MAPILLARY_TOKEN,
    }
    assert aioclient_mock.call_count == 2
    (google,) = [c for c in aioclient_mock.mock_calls if c[0] == "POST"]
    assert google[1].query["key"] == GOOGLE_KEY
    assert google[2]["mapType"] == "streetview"
    (mapillary,) = [c for c in aioclient_mock.mock_calls if c[0] == "GET"]
    assert mapillary[1].query["access_token"] == MAPILLARY_TOKEN
    for call in aioclient_mock.mock_calls:
        assert "52.09" not in str(call[1]) and "52.09" not in str(call[2])

    # Offered again; saving them unchanged does not ask again.
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert _suggested(result["data_schema"]) == {
        CONF_STREET_SOURCE: "google",
        CONF_MAPILLARY_TOKEN: MAPILLARY_TOKEN,
        CONF_GOOGLE_API_KEY: GOOGLE_KEY,
    }
    await _options(
        hass,
        entry,
        **{
            CONF_STREET_SOURCE: "auto",
            CONF_GOOGLE_API_KEY: GOOGLE_KEY,
            CONF_MAPILLARY_TOKEN: MAPILLARY_TOKEN,
        },
    )
    assert aioclient_mock.call_count == 2

    # Emptied (or left out), a key is gone.
    await _options(hass, entry, **{CONF_STREET_SOURCE: "auto", CONF_GOOGLE_API_KEY: " "})
    assert entry.options[CONF_STREET_VIEW] == {CONF_STREET_SOURCE: "auto"}


@pytest.mark.parametrize(
    ("source", "error"),
    [("google", "google_key_needed"), ("mapillary", "mapillary_token_needed")],
)
async def test_street_source_needs_its_key(hass: HomeAssistant, source: str, error: str) -> None:
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_LATITUDE: 1, CONF_LONGITUDE: 2})
    entry.add_to_hass(hass)
    result = await _options(hass, entry, **{CONF_STREET_SOURCE: source})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": error}
    # What was typed stays in the form.
    assert _suggested(result["data_schema"])[CONF_STREET_SOURCE] == source
    assert entry.options == {}


async def test_refused_keys_are_explained(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.post(
        GOOGLE_SESSION_URL,
        status=400,
        json={
            "error": {
                "code": 400,
                "message": "API key not valid. Please pass a valid API key.",
                "status": "INVALID_ARGUMENT",
                "details": [{"reason": "API_KEY_INVALID", "domain": "googleapis.com"}],
            }
        },
    )
    aioclient_mock.get(
        MAPILLARY_IMAGES_URL,
        status=401,
        json={"error": {"message": "Invalid OAuth access token", "type": "OAuthException"}},
    )
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_LATITUDE: 1, CONF_LONGITUDE: 2})
    entry.add_to_hass(hass)
    result = await _options(
        hass, entry, **{CONF_STREET_SOURCE: "auto", CONF_GOOGLE_API_KEY: GOOGLE_KEY}
    )
    assert result["errors"] == {"base": "google_refused"}
    assert result["description_placeholders"] == {
        "error": "API key not valid. Please pass a valid API key."
    }
    result = await _options(
        hass, entry, **{CONF_STREET_SOURCE: "auto", CONF_MAPILLARY_TOKEN: MAPILLARY_TOKEN}
    )
    assert result["errors"] == {"base": "mapillary_refused"}
    assert result["description_placeholders"] == {"error": "Invalid OAuth access token"}
    assert entry.options == {}


async def test_mapillary_says_a_bad_token_with_a_code(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Code 190 is a token Mapillary does not take, even sent as a server error."""
    aioclient_mock.get(
        MAPILLARY_IMAGES_URL,
        status=500,
        json={"error": {"message": "Invalid OAuth 2.0 Access Token", "code": 190}},
    )
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_LATITUDE: 1, CONF_LONGITUDE: 2})
    entry.add_to_hass(hass)
    result = await _options(
        hass, entry, **{CONF_STREET_SOURCE: "auto", CONF_MAPILLARY_TOKEN: MAPILLARY_TOKEN}
    )
    assert result["errors"] == {"base": "mapillary_refused"}
    # A token that is not one is caught before Mapillary is asked (it answers those as if down).
    result = await _options(
        hass, entry, **{CONF_STREET_SOURCE: "auto", CONF_MAPILLARY_TOKEN: "pk.eyJ1Ijoi"}
    )
    assert result["errors"] == {"base": "mapillary_token_format"}
    assert aioclient_mock.call_count == 1


REFERRER_BLOCKED = {
    "status": 403,
    "json": {
        "error": {
            "code": 403,
            "message": "Requests from referer <empty> are blocked.",
            "details": [{"reason": "API_KEY_HTTP_REFERRER_BLOCKED"}],
        }
    },
}


@pytest.mark.parametrize(
    ("google", "mapillary"),
    [
        # Restricted to the browser's address: only the browser can use it.
        (REFERRER_BLOCKED, {"json": {"data": []}}),
        ({"status": 503, "text": "Service Unavailable"}, {"status": 500, "text": "Oops"}),
        ({"status": 429, "json": {}}, {"status": 429, "json": {}}),
        ({"exc": ClientError("offline")}, {"exc": ClientError("offline")}),
        ({"exc": TimeoutError()}, {"exc": TimeoutError()}),
    ],
)
async def test_keys_that_cannot_be_told_are_kept(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    google: dict[str, Any],
    mapillary: dict[str, Any],
) -> None:
    aioclient_mock.post(GOOGLE_SESSION_URL, **google)
    aioclient_mock.get(MAPILLARY_IMAGES_URL, **mapillary)
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_LATITUDE: 1, CONF_LONGITUDE: 2})
    entry.add_to_hass(hass)
    result = await _options(
        hass,
        entry,
        **{
            CONF_STREET_SOURCE: "google",
            CONF_GOOGLE_API_KEY: GOOGLE_KEY,
            CONF_MAPILLARY_TOKEN: MAPILLARY_TOKEN,
        },
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options[CONF_STREET_VIEW][CONF_GOOGLE_API_KEY] == GOOGLE_KEY
    assert entry.options[CONF_STREET_VIEW][CONF_MAPILLARY_TOKEN] == MAPILLARY_TOKEN


def _redirected(url: URL) -> TooManyRedirects:
    """What aiohttp raises for a redirect loop (a captive portal's, say): its text holds the URL."""
    info = RequestInfo(url, "GET", CIMultiDictProxy(CIMultiDict()), url)
    return TooManyRedirects(info, ())


async def test_trying_keys_keeps_them_out_of_the_log(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, caplog: pytest.LogCaptureFixture
) -> None:
    """An error naming the request's URL is logged without its query, where the key is."""
    caplog.set_level(logging.DEBUG, logger="custom_components.satellite_spotter")
    google = URL(GOOGLE_SESSION_URL).with_query(key=GOOGLE_KEY)
    mapillary = URL(MAPILLARY_IMAGES_URL).with_query(access_token=MAPILLARY_TOKEN, fields="id")
    assert GOOGLE_KEY in str(_redirected(google))
    aioclient_mock.post(GOOGLE_SESSION_URL, exc=_redirected(google))
    aioclient_mock.get(MAPILLARY_IMAGES_URL, exc=_redirected(mapillary))
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_LATITUDE: 1, CONF_LONGITUDE: 2})
    entry.add_to_hass(hass)
    result = await _options(
        hass,
        entry,
        **{
            CONF_STREET_SOURCE: "auto",
            CONF_GOOGLE_API_KEY: GOOGLE_KEY,
            CONF_MAPILLARY_TOKEN: MAPILLARY_TOKEN,
        },
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    # Each URL is logged, its query gone.
    assert f"url='{GOOGLE_SESSION_URL}'" in caplog.text
    assert f"url='{MAPILLARY_IMAGES_URL}'" in caplog.text
    # The token's secret part, however it is encoded.
    for secret in (GOOGLE_KEY, MAPILLARY_TOKEN.rsplit("|", 1)[1]):
        assert secret not in caplog.text


@pytest.mark.parametrize(
    "bad",
    [
        {CONF_UNITS: "nautical"},
        {CONF_MAX_MAGNITUDE: 4.5},
        {CONF_MAX_MAGNITUDE: -2.5},
        {CONF_ALERT_LEAD_MINUTES: 0},
        {CONF_ALERT_LEAD_MINUTES: 241},
        {CONF_STREET_VIEW: {CONF_STREET_SOURCE: "bing"}},
    ],
)
async def test_options_out_of_range(hass: HomeAssistant, bad: dict[str, Any]) -> None:
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_LATITUDE: 1, CONF_LONGITUDE: 2})
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    with pytest.raises(InvalidData):
        await hass.config_entries.options.async_configure(result["flow_id"], {**OPTIONS, **bad})
