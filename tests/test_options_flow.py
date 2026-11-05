"""The options: every field, limit and error, and the checks on the street view's keys."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

from aiohttp import ClientError
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult, FlowResultType, InvalidData
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.street import (
    GOOGLE_SESSION_URL,
    MAPILLARY_IMAGES_URL,
    street_options,
    street_payload,
)

from .common import HONOLULU, add_location

TOKEN = "MLY|123456|abc-DEF_789"
GOOGLE_KEY = "AIzaSyExample"
DEFAULTS = {
    "brightness_cutoff": 2.25,
    "cloud_forecast": True,
    "alert_lead_minutes": 15,
    "show_in_sidebar": True,
    "show_in_calendar": True,
    "units": "auto",
    "street_view": {"street_source": "auto"},
}


def answer(street: dict[str, Any] | None = None, **fields: Any) -> dict[str, Any]:
    """Return the form filled in with the defaults, but for these."""
    return {**DEFAULTS, **fields, "street_view": {"street_source": "auto", **(street or {})}}


def field(result: FlowResult, name: str) -> Any:
    schema = result["data_schema"]
    assert schema is not None
    return next(key for key in schema.schema if key == name)


def selector_config(result: FlowResult, name: str) -> Any:
    schema = result["data_schema"]
    assert schema is not None
    return schema.schema[field(result, name)].config


def street_section(result: FlowResult) -> Any:
    schema = result["data_schema"]
    assert schema is not None
    return schema.schema[field(result, "street_view")]


def street_field(result: FlowResult, name: str) -> Any:
    section = street_section(result)
    return next(key for key in section.schema.schema if key == name)


async def open_options(hass: HomeAssistant, entry: MockConfigEntry) -> FlowResult:
    return await hass.config_entries.options.async_init(entry.entry_id)


async def submit(
    hass: HomeAssistant, entry: MockConfigEntry, user_input: dict[str, Any]
) -> FlowResult:
    flow = await open_options(hass, entry)
    return await hass.config_entries.options.async_configure(flow["flow_id"], user_input=user_input)


@pytest.fixture
def entry(hass: HomeAssistant) -> MockConfigEntry:
    """A location that is not set up: all these tests need is its options."""
    location = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    location.add_to_hass(hass)
    return location


# The form.


async def test_the_form_offers_the_documented_defaults(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    # README, Options.
    result = await open_options(hass, entry)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "init"
    assert result["errors"] == {}
    assert field(result, "brightness_cutoff").default() == 2.25
    assert field(result, "cloud_forecast").default() is True
    assert field(result, "alert_lead_minutes").default() == 15
    assert field(result, "show_in_sidebar").default() is True
    assert field(result, "show_in_calendar").default() is True
    assert field(result, "units").default() == "auto"
    assert street_field(result, "street_source").default() == "auto"


async def test_the_form_offers_what_is_saved(hass: HomeAssistant) -> None:
    saved = {
        "brightness_cutoff": 1.0,
        "cloud_forecast": False,
        "alert_lead_minutes": 30,
        "show_in_sidebar": False,
        "show_in_calendar": False,
        "units": "imperial",
        "street_view": {
            "street_source": "mapillary",
            "mapillary_token": TOKEN,
            "google_api_key": GOOGLE_KEY,
        },
    }
    location = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU), options=saved)
    location.add_to_hass(hass)
    result = await open_options(hass, location)
    assert field(result, "brightness_cutoff").default() == 1.0
    assert field(result, "cloud_forecast").default() is False
    assert field(result, "alert_lead_minutes").default() == 30
    assert field(result, "show_in_sidebar").default() is False
    assert field(result, "show_in_calendar").default() is False
    assert field(result, "units").default() == "imperial"
    assert street_field(result, "street_source").default() == "mapillary"
    assert street_field(result, "street_source").description["suggested_value"] == "mapillary"
    assert street_field(result, "mapillary_token").description["suggested_value"] == TOKEN
    assert street_field(result, "google_api_key").description["suggested_value"] == GOOGLE_KEY


async def test_the_form_offers_a_saved_street_view_cleaned_up(hass: HomeAssistant) -> None:
    location = MockConfigEntry(
        domain=DOMAIN,
        data=dict(HONOLULU),
        options={"street_view": {"street_source": "somewhere new", "google_api_key": "  "}},
    )
    location.add_to_hass(hass)
    result = await open_options(hass, location)
    assert street_field(result, "street_source").default() == "auto"
    assert street_field(result, "street_source").description["suggested_value"] == "auto"
    # The blank key is not offered back.
    assert street_field(result, "google_api_key").description is None


async def test_the_sliders_and_lists_have_the_documented_limits(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    result = await open_options(hass, entry)
    cutoff = selector_config(result, "brightness_cutoff")
    assert (cutoff["min"], cutoff["max"], cutoff["step"]) == (-1, 4, 0.25)
    assert cutoff["mode"] == "slider"
    lead = selector_config(result, "alert_lead_minutes")
    assert (lead["min"], lead["max"], lead["step"]) == (1, 240, 1)
    assert lead["unit_of_measurement"] == "min"
    assert lead["mode"] == "box"
    units = selector_config(result, "units")
    assert units["options"] == ["auto", "metric", "imperial"]
    assert units["translation_key"] == "units"
    source = street_section(result).schema.schema[street_field(result, "street_source")].config
    assert source["options"] == ["auto", "google", "mapillary", "panoramax", "model"]
    assert source["translation_key"] == "street_source"


async def test_the_street_view_section_starts_collapsed_with_hidden_keys(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    result = await open_options(hass, entry)
    section = street_section(result)
    assert section.options["collapsed"] is True
    schema = section.schema.schema
    for name in ("mapillary_token", "google_api_key"):
        key = street_field(result, name)
        assert key.__class__.__name__ == "Optional"
        assert schema[key].config["type"] == "password"


# A good answer.


async def test_saving_stores_every_field(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    chosen = {
        "brightness_cutoff": 1.75,
        "cloud_forecast": False,
        "alert_lead_minutes": 30,
        "show_in_sidebar": False,
        "show_in_calendar": False,
        "units": "metric",
        "street_view": {"street_source": "panoramax"},
    }
    result = await submit(hass, entry, chosen)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == chosen
    assert entry.options == chosen


async def test_saving_reloads_a_loaded_location_with_the_new_options(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    location = await add_location(hass)
    await submit(hass, location, answer(brightness_cutoff=1.0, alert_lead_minutes=45))
    await hass.async_block_till_done()
    settings = location.runtime_data.settings
    assert settings.brightness_cutoff == 1.0
    assert settings.alert_lead.total_seconds() == 45 * 60


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("brightness_cutoff", -1),
        ("brightness_cutoff", 4),
        ("brightness_cutoff", 0),
        ("alert_lead_minutes", 1),
        ("alert_lead_minutes", 240),
        ("units", "metric"),
        ("units", "imperial"),
    ],
)
async def test_values_at_the_limits_are_taken(
    hass: HomeAssistant, entry: MockConfigEntry, name: str, value: Any
) -> None:
    result = await submit(hass, entry, answer(**{name: value}))
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][name] == value


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("brightness_cutoff", -1.01),
        ("brightness_cutoff", 4.01),
        ("alert_lead_minutes", 0),
        ("alert_lead_minutes", 241),
        ("units", "furlongs"),
    ],
)
async def test_values_past_the_limits_are_refused_by_the_form(
    hass: HomeAssistant, entry: MockConfigEntry, name: str, value: Any
) -> None:
    with pytest.raises(InvalidData):
        await submit(hass, entry, answer(**{name: value}))


async def test_an_unknown_photo_source_is_refused_by_the_form(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    with pytest.raises(InvalidData):
        await submit(hass, entry, answer(street={"street_source": "bing"}))


@pytest.mark.parametrize("source", ["auto", "panoramax", "model"])
async def test_sources_that_need_no_key_ask_for_none(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    source: str,
) -> None:
    result = await submit(hass, entry, answer(street={"street_source": source}))
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["street_view"] == {"street_source": source}
    assert aioclient_mock.call_count == 0


async def test_blank_keys_are_not_kept_and_keys_lose_their_spaces(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.post(GOOGLE_SESSION_URL, json={})
    result = await submit(
        hass, entry, answer(street={"mapillary_token": "   ", "google_api_key": f"  {GOOGLE_KEY} "})
    )
    assert result["data"]["street_view"] == {
        "street_source": "auto",
        "google_api_key": GOOGLE_KEY,
    }


# The services' needs.


async def test_google_as_the_source_needs_a_key(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    result = await submit(hass, entry, answer(street={"street_source": "google"}))
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "google_key_needed"}
    assert result["description_placeholders"] == {}
    assert aioclient_mock.call_count == 0
    assert not entry.options


async def test_mapillary_as_the_source_needs_a_token(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    result = await submit(hass, entry, answer(street={"street_source": "mapillary"}))
    assert result["errors"] == {"base": "mapillary_token_needed"}
    assert aioclient_mock.call_count == 0


async def test_google_as_the_source_is_not_satisfied_by_a_mapillary_token(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    result = await submit(
        hass, entry, answer(street={"street_source": "google", "mapillary_token": TOKEN})
    )
    assert result["errors"] == {"base": "google_key_needed"}


@pytest.mark.parametrize(
    "token",
    [
        "abc",
        "MLY|123",
        "MLY|123|",
        "mly|123|abc",
        "MLY|abc|def",
        "MLY|123|ab c",
        "MLY|123|abc|more",
        "XMLY|123|abc",
    ],
)
async def test_a_mapillary_token_of_the_wrong_form_is_explained_without_asking(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker, token: str
) -> None:
    result = await submit(hass, entry, answer(street={"mapillary_token": token}))
    assert result["errors"] == {"base": "mapillary_token_format"}
    assert aioclient_mock.call_count == 0


async def test_what_was_typed_stays_in_the_form_after_an_error(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    typed = answer(brightness_cutoff=1.5, street={"mapillary_token": "typo"})
    result = await submit(hass, entry, typed)
    assert field(result, "brightness_cutoff").description["suggested_value"] == 1.5
    assert street_field(result, "mapillary_token").description["suggested_value"] == "typo"


# Trying the keys.


async def test_a_google_key_that_works_is_saved(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.post(GOOGLE_SESSION_URL, json={"session": "s"})
    result = await submit(
        hass, entry, answer(street={"street_source": "google", "google_api_key": GOOGLE_KEY})
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["street_view"]["google_api_key"] == GOOGLE_KEY
    assert aioclient_mock.call_count == 1


async def test_a_google_key_is_tried_without_saying_where_home_is(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    # street.py: "Neither check sends the location."
    hass.config.language = "de"
    hass.config.country = "nl"
    aioclient_mock.post(GOOGLE_SESSION_URL, json={})
    await submit(hass, entry, answer(street={"google_api_key": GOOGLE_KEY}))
    _method, url, body, _headers = aioclient_mock.mock_calls[0]
    assert url.query["key"] == GOOGLE_KEY
    assert body == {"mapType": "streetview", "language": "de", "region": "NL"}


async def test_a_google_key_is_tried_with_sensible_defaults(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    hass.config.language = ""
    hass.config.country = None
    aioclient_mock.post(GOOGLE_SESSION_URL, json={})
    await submit(hass, entry, answer(street={"google_api_key": GOOGLE_KEY}))
    assert aioclient_mock.mock_calls[0][2] == {
        "mapType": "streetview",
        "language": "en",
        "region": "US",
    }


async def test_a_google_key_refused_is_explained_in_googles_words(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.post(
        GOOGLE_SESSION_URL, status=400, json={"error": {"message": "API key not valid."}}
    )
    result = await submit(hass, entry, answer(street={"google_api_key": GOOGLE_KEY}))
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "google_refused"}
    assert result["description_placeholders"] == {"error": "API key not valid."}
    assert not entry.options


@pytest.mark.parametrize(
    ("body", "words"),
    [
        pytest.param({}, "HTTP 403", id="nothing said"),
        pytest.param({"error": "no"}, "HTTP 403", id="error not a dictionary"),
        pytest.param({"error": {"message": ""}}, "HTTP 403", id="empty message"),
        pytest.param({"error": {"message": 5}}, "HTTP 403", id="message not text"),
        pytest.param(["odd"], "HTTP 403", id="not a dictionary"),
        pytest.param(
            {"error": {"message": "no", "details": [5, {"reason": 6}, {"reason": "OTHER"}]}},
            "no",
            id="reasons that excuse nothing",
        ),
    ],
)
async def test_a_refusal_in_odd_words_is_still_a_refusal(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    body: Any,
    words: str,
) -> None:
    aioclient_mock.post(GOOGLE_SESSION_URL, status=403, json=body)
    result = await submit(hass, entry, answer(street={"google_api_key": GOOGLE_KEY}))
    assert result["errors"] == {"base": "google_refused"}
    assert result["description_placeholders"] == {"error": words}


@pytest.mark.parametrize(
    "reason",
    [
        "API_KEY_HTTP_REFERRER_BLOCKED",
        "API_KEY_IP_ADDRESS_BLOCKED",
        "API_KEY_ANDROID_APP_BLOCKED",
        "API_KEY_IOS_APP_BLOCKED",
    ],
)
async def test_a_google_key_restricted_to_elsewhere_cannot_be_told_here_and_is_saved(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker, reason: str
) -> None:
    # street.py: a key restricted to websites is refused when tried here, yet works in the browser.
    aioclient_mock.post(
        GOOGLE_SESSION_URL,
        status=403,
        json={"error": {"message": "blocked", "details": [{"reason": reason}]}},
    )
    result = await submit(hass, entry, answer(street={"google_api_key": GOOGLE_KEY}))
    assert result["type"] is FlowResultType.CREATE_ENTRY


@pytest.mark.parametrize("status", [429, 500, 503])
async def test_google_being_busy_or_down_says_nothing_about_the_key(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker, status: int
) -> None:
    aioclient_mock.post(GOOGLE_SESSION_URL, status=status, json={"error": {"message": "later"}})
    result = await submit(hass, entry, answer(street={"google_api_key": GOOGLE_KEY}))
    assert result["type"] is FlowResultType.CREATE_ENTRY


@pytest.mark.parametrize("status", [401, 499])
async def test_other_google_answers_are_refusals(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker, status: int
) -> None:
    aioclient_mock.post(GOOGLE_SESSION_URL, status=status, json={})
    result = await submit(hass, entry, answer(street={"google_api_key": GOOGLE_KEY}))
    assert result["errors"] == {"base": "google_refused"}


@pytest.mark.parametrize("failure", [ClientError("offline"), TimeoutError()])
async def test_being_unable_to_reach_google_says_nothing_about_the_key(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    failure: Exception,
) -> None:
    aioclient_mock.post(GOOGLE_SESSION_URL, exc=failure)
    result = await submit(hass, entry, answer(street={"google_api_key": GOOGLE_KEY}))
    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_an_answer_from_google_that_is_no_json_says_nothing_about_the_key(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.post(GOOGLE_SESSION_URL, status=403, text="<html>")
    result = await submit(hass, entry, answer(street={"google_api_key": GOOGLE_KEY}))
    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_a_google_key_never_reaches_the_log(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("DEBUG", logger="custom_components.satellite_spotter.street")
    aioclient_mock.post(
        GOOGLE_SESSION_URL,
        exc=ClientError(f"Cannot connect to {GOOGLE_SESSION_URL}?key={GOOGLE_KEY}"),
    )
    await submit(hass, entry, answer(street={"google_api_key": GOOGLE_KEY}))
    assert GOOGLE_SESSION_URL in caplog.text
    assert GOOGLE_KEY not in caplog.text


async def test_a_mapillary_token_is_tried_on_the_empty_sea(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    # street.py: the token is tried without telling Mapillary where home is.
    aioclient_mock.get(MAPILLARY_IMAGES_URL, json={"data": []})
    result = await submit(
        hass, entry, answer(street={"street_source": "mapillary", "mapillary_token": TOKEN})
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["street_view"]["mapillary_token"] == TOKEN
    url = aioclient_mock.mock_calls[0][1]
    assert url.query["access_token"] == TOKEN
    assert url.query["bbox"] == "0,0,0.001,0.001"


async def test_a_mapillary_token_refused_is_explained_in_mapillarys_words(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.get(
        MAPILLARY_IMAGES_URL, status=401, json={"error": {"message": "Invalid token", "code": 190}}
    )
    result = await submit(hass, entry, answer(street={"mapillary_token": TOKEN}))
    assert result["errors"] == {"base": "mapillary_refused"}
    assert result["description_placeholders"] == {"error": "Invalid token"}


@pytest.mark.parametrize("status", [500, 429])
async def test_mapillarys_token_error_counts_whatever_the_status(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker, status: int
) -> None:
    aioclient_mock.get(
        MAPILLARY_IMAGES_URL, status=status, json={"error": {"message": "Bad", "code": 190}}
    )
    result = await submit(hass, entry, answer(street={"mapillary_token": TOKEN}))
    assert result["errors"] == {"base": "mapillary_refused"}


@pytest.mark.parametrize(
    ("status", "body"),
    [
        (429, {"error": {"message": "later", "code": 4}}),
        (500, {"error": {"message": "down"}}),
        (503, {}),
    ],
)
async def test_mapillary_being_busy_or_down_says_nothing_about_the_token(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    status: int,
    body: Any,
) -> None:
    aioclient_mock.get(MAPILLARY_IMAGES_URL, status=status, json=body)
    result = await submit(hass, entry, answer(street={"mapillary_token": TOKEN}))
    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_being_unable_to_reach_mapillary_says_nothing_about_the_token(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.get(MAPILLARY_IMAGES_URL, exc=ClientError("offline"))
    result = await submit(hass, entry, answer(street={"mapillary_token": TOKEN}))
    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_a_mapillary_token_never_reaches_the_log(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    aioclient_mock: AiohttpClientMocker,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("DEBUG", logger="custom_components.satellite_spotter.street")
    aioclient_mock.get(
        MAPILLARY_IMAGES_URL,
        exc=ClientError(f"Cannot connect to {MAPILLARY_IMAGES_URL}?access_token={TOKEN}"),
    )
    await submit(hass, entry, answer(street={"mapillary_token": TOKEN}))
    assert MAPILLARY_IMAGES_URL in caplog.text
    assert TOKEN not in caplog.text


async def test_keys_already_saved_are_not_tried_again(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    location = MockConfigEntry(
        domain=DOMAIN,
        data=dict(HONOLULU),
        options={"street_view": {"google_api_key": GOOGLE_KEY, "mapillary_token": TOKEN}},
    )
    location.add_to_hass(hass)
    result = await submit(
        hass, location, answer(street={"google_api_key": GOOGLE_KEY, "mapillary_token": TOKEN})
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert aioclient_mock.call_count == 0


async def test_a_changed_key_is_tried(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    location = MockConfigEntry(
        domain=DOMAIN,
        data=dict(HONOLULU),
        options={"street_view": {"google_api_key": GOOGLE_KEY, "mapillary_token": TOKEN}},
    )
    location.add_to_hass(hass)
    aioclient_mock.post(GOOGLE_SESSION_URL, json={})
    aioclient_mock.get(MAPILLARY_IMAGES_URL, json={})
    await submit(
        hass,
        location,
        answer(street={"google_api_key": "AIzaOther", "mapillary_token": "MLY|1|changed"}),
    )
    assert aioclient_mock.call_count == 2


async def test_only_the_changed_one_of_two_keys_is_tried(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    location = MockConfigEntry(
        domain=DOMAIN,
        data=dict(HONOLULU),
        options={"street_view": {"google_api_key": GOOGLE_KEY, "mapillary_token": TOKEN}},
    )
    location.add_to_hass(hass)
    aioclient_mock.get(MAPILLARY_IMAGES_URL, json={})
    await submit(
        hass,
        location,
        answer(street={"google_api_key": GOOGLE_KEY, "mapillary_token": "MLY|1|changed"}),
    )
    assert aioclient_mock.call_count == 1
    assert aioclient_mock.mock_calls[0][1].host == "graph.mapillary.com"


async def test_clearing_a_saved_key_removes_it(hass: HomeAssistant) -> None:
    location = MockConfigEntry(
        domain=DOMAIN, data=dict(HONOLULU), options={"street_view": {"google_api_key": GOOGLE_KEY}}
    )
    location.add_to_hass(hass)
    result = await submit(hass, location, answer())
    assert result["data"]["street_view"] == {"street_source": "auto"}


async def test_clearing_the_key_a_saved_source_needs_is_explained(hass: HomeAssistant) -> None:
    location = MockConfigEntry(
        domain=DOMAIN,
        data=dict(HONOLULU),
        options={"street_view": {"street_source": "google", "google_api_key": GOOGLE_KEY}},
    )
    location.add_to_hass(hass)
    result = await submit(hass, location, answer(street={"street_source": "google"}))
    assert result["errors"] == {"base": "google_key_needed"}


async def test_the_first_key_refused_is_the_one_explained(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.post(GOOGLE_SESSION_URL, status=403, json={"error": {"message": "google no"}})
    aioclient_mock.get(MAPILLARY_IMAGES_URL, status=401, json={"error": {"message": "mly no"}})
    result = await submit(
        hass, entry, answer(street={"google_api_key": GOOGLE_KEY, "mapillary_token": TOKEN})
    )
    assert result["errors"] == {"base": "google_refused"}
    assert result["description_placeholders"] == {"error": "google no"}
    assert aioclient_mock.call_count == 1


async def test_a_good_google_key_does_not_excuse_a_bad_mapillary_token(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.post(GOOGLE_SESSION_URL, json={})
    aioclient_mock.get(MAPILLARY_IMAGES_URL, status=401, json={"error": {"message": "mly no"}})
    result = await submit(
        hass, entry, answer(street={"google_api_key": GOOGLE_KEY, "mapillary_token": TOKEN})
    )
    assert result["errors"] == {"base": "mapillary_refused"}
    assert result["description_placeholders"] == {"error": "mly no"}


# The saved street view section, as the rest of the integration reads it.


@pytest.mark.parametrize(
    ("options", "expected"),
    [
        pytest.param({}, {"street_source": "auto"}, id="nothing saved"),
        pytest.param({"street_view": None}, {"street_source": "auto"}, id="section None"),
        pytest.param(
            {"street_view": {"street_source": "gone"}}, {"street_source": "auto"}, id="unknown"
        ),
        pytest.param(
            {"street_view": {"street_source": "model"}}, {"street_source": "model"}, id="known"
        ),
        pytest.param(
            {"street_view": {"mapillary_token": " x ", "google_api_key": None}},
            {"street_source": "auto", "mapillary_token": "x"},
            id="keys only when set",
        ),
    ],
)
def test_street_options_are_checked(options: dict[str, Any], expected: dict[str, Any]) -> None:
    assert street_options(options) == expected


def test_the_street_payload_says_none_for_a_missing_key() -> None:
    assert street_payload({"street_view": {"street_source": "google", "google_api_key": "k"}}) == {
        "source": "google",
        "mapillary_token": None,
        "google_api_key": "k",
    }
