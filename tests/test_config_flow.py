"""Adding a location: every field, limit, error and abort of the form."""

from __future__ import annotations

from collections.abc import Iterator
import logging
import math
from typing import Any
from unittest.mock import AsyncMock

from homeassistant.config_entries import SOURCE_USER
from homeassistant.const import (
    CONF_ELEVATION,
    CONF_LATITUDE,
    CONF_LOCATION,
    CONF_LONGITUDE,
    CONF_NAME,
)
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult, FlowResultType, InvalidData
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.celestrak import CatalogError, DownloadRefused
from custom_components.satellite_spotter.const import DOMAIN

from .common import HONOLULU


def place(latitude: float, longitude: float, elevation: float = 5.0, name: str = "Home") -> Any:
    return {
        CONF_NAME: name,
        CONF_LOCATION: {CONF_LATITUDE: latitude, CONF_LONGITUDE: longitude},
        CONF_ELEVATION: elevation,
    }


def key_of(result: FlowResult, name: str) -> Any:
    schema = result["data_schema"]
    assert schema is not None
    return next(key for key in schema.schema if key == name)


def default_of(result: FlowResult, name: str) -> Any:
    return key_of(result, name).default()


def suggested(result: FlowResult, name: str) -> Any:
    return key_of(result, name).description["suggested_value"]


async def start(hass: HomeAssistant) -> FlowResult:
    return await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})


async def submit(hass: HomeAssistant, user_input: dict[str, Any]) -> FlowResult:
    flow = await start(hass)
    return await hass.config_entries.flow.async_configure(flow["flow_id"], user_input)


@pytest.fixture
def fetch(mock_downloads: dict[str, AsyncMock]) -> Iterator[AsyncMock]:
    yield mock_downloads["fetch_catalog"]


# The form.


async def test_the_form_starts_at_home(hass: HomeAssistant) -> None:
    hass.config.latitude = 12.5
    hass.config.longitude = -45.25
    hass.config.elevation = 321
    result = await start(hass)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    assert result["errors"] == {}
    assert default_of(result, CONF_NAME) == "Home"
    assert default_of(result, CONF_LOCATION) == {CONF_LATITUDE: 12.5, CONF_LONGITUDE: -45.25}
    assert default_of(result, CONF_ELEVATION) == 321


async def test_the_form_asks_for_a_name_a_location_and_an_elevation(hass: HomeAssistant) -> None:
    result = await start(hass)
    schema = result["data_schema"]
    assert schema is not None
    assert {str(key) for key in schema.schema} == {CONF_NAME, CONF_LOCATION, CONF_ELEVATION}
    assert all(key.__class__.__name__ == "Required" for key in schema.schema)


async def test_the_location_picker_has_no_radius(hass: HomeAssistant) -> None:
    result = await start(hass)
    schema = result["data_schema"]
    assert schema is not None
    assert schema.schema[key_of(result, CONF_LOCATION)].config["radius"] is False


async def test_the_elevation_box_is_in_metres_from_the_dead_sea_to_everest(
    hass: HomeAssistant,
) -> None:
    result = await start(hass)
    schema = result["data_schema"]
    assert schema is not None
    config = schema.schema[key_of(result, CONF_ELEVATION)].config
    assert config["min"] == -450
    assert config["max"] == 8900
    assert config["step"] == 1
    assert config["unit_of_measurement"] == "m"
    assert config["mode"] == "box"


# A good answer.


async def test_a_location_is_created_with_its_name_place_and_elevation(
    hass: HomeAssistant, fetch: AsyncMock
) -> None:
    result = await submit(hass, place(21.3069, -157.8583, 5.0, name="Cabin"))
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Cabin"
    assert result["data"] == HONOLULU
    entry = result["result"]
    assert entry.unique_id == "21.3069_-157.8583"
    assert entry.title == "Cabin"
    assert (entry.version, entry.minor_version) == (1, 1)
    fetch.assert_awaited_once()
    await hass.async_block_till_done()


async def test_a_second_location_shares_the_catalog_already_there(
    hass: HomeAssistant, fetch: AsyncMock
) -> None:
    await submit(hass, place(21.3069, -157.8583))
    await hass.async_block_till_done()
    result = await submit(hass, place(39.74, -104.99, 1609.0, name="Cabin"))
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    fetch.assert_awaited_once()


@pytest.mark.parametrize("elevation", [-450, 8900, 0])
async def test_elevations_at_the_limits_are_taken(
    hass: HomeAssistant, fetch: AsyncMock, elevation: float
) -> None:
    result = await submit(hass, place(21.3, -157.8, elevation))
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_ELEVATION] == elevation
    await hass.async_block_till_done()


@pytest.mark.parametrize("elevation", [-451, 8901])
async def test_elevations_past_the_limits_are_refused_by_the_form(
    hass: HomeAssistant, fetch: AsyncMock, elevation: float
) -> None:
    with pytest.raises(InvalidData):
        await submit(hass, place(21.3, -157.8, elevation))
    fetch.assert_not_awaited()


@pytest.mark.parametrize(
    ("latitude", "longitude", "stored_latitude", "stored_longitude"),
    [
        pytest.param(90.0, 0.0, 90.0, 0.0, id="the north pole"),
        pytest.param(-90.0, 0.0, -90.0, 0.0, id="the south pole"),
        pytest.param(0.0, 180.0, 0.0, 180.0, id="180 east stays"),
        pytest.param(0.0, -180.0, 0.0, -180.0, id="180 west stays"),
        pytest.param(0.0, 180.00001, 0.0, -179.99999, id="just past 180 wraps"),
        pytest.param(0.0, -180.00001, 0.0, 179.99999, id="just past -180 wraps"),
        pytest.param(0.0, 202.1417, 0.0, -157.8583, id="written 0 to 360"),
        pytest.param(0.0, 360.0, 0.0, 0.0, id="a whole turn"),
        pytest.param(0.0, -190.0, 0.0, 170.0, id="past west"),
        pytest.param(90.000004, 0.0, 90.0, 0.0, id="rounds onto the pole"),
        pytest.param(21.3069123, -157.8583456, 21.30691, -157.85835, id="rounded to five digits"),
    ],
)
async def test_places_are_rounded_and_wrapped(
    hass: HomeAssistant,
    fetch: AsyncMock,
    latitude: float,
    longitude: float,
    stored_latitude: float,
    stored_longitude: float,
) -> None:
    result = await submit(hass, place(latitude, longitude))
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_LATITUDE] == stored_latitude
    assert result["data"][CONF_LONGITUDE] == stored_longitude
    await hass.async_block_till_done()


async def test_numbers_given_as_text_are_read_as_numbers(
    hass: HomeAssistant, fetch: AsyncMock
) -> None:
    flow = await start(hass)
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"],
        {
            CONF_NAME: "Home",
            CONF_LOCATION: {CONF_LATITUDE: "21.3", CONF_LONGITUDE: "-157.8", "radius": "5"},
            CONF_ELEVATION: 5,
        },
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_LATITUDE] == 21.3
    await hass.async_block_till_done()


# A bad answer.


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [
        pytest.param(90.00001, 0.0, id="just over the north pole"),
        pytest.param(-90.00001, 0.0, id="just over the south pole"),
        pytest.param(91.0, 0.0, id="latitude 91"),
        pytest.param(math.nan, 0.0, id="latitude not a number"),
        pytest.param(0.0, math.nan, id="longitude not a number"),
        pytest.param(math.inf, 0.0, id="latitude infinite"),
        pytest.param(0.0, math.inf, id="longitude infinite"),
        pytest.param(0.0, -math.inf, id="longitude minus infinity"),
    ],
)
async def test_a_place_that_makes_no_sense_is_explained_on_the_location_field(
    hass: HomeAssistant, fetch: AsyncMock, latitude: float, longitude: float
) -> None:
    result = await submit(hass, place(latitude, longitude))
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    assert result["errors"] == {CONF_LOCATION: "invalid_location"}
    fetch.assert_not_awaited()


@pytest.mark.parametrize(
    "location",
    [
        pytest.param({CONF_LATITUDE: 1.0}, id="no longitude"),
        pytest.param({CONF_LONGITUDE: 1.0}, id="no latitude"),
        pytest.param({CONF_LATITUDE: "north", CONF_LONGITUDE: 1.0}, id="no number"),
    ],
)
async def test_the_location_field_needs_two_numbers(
    hass: HomeAssistant, fetch: AsyncMock, location: dict[str, Any]
) -> None:
    flow = await start(hass)
    with pytest.raises(InvalidData):
        await hass.config_entries.flow.async_configure(
            flow["flow_id"], {CONF_NAME: "Home", CONF_LOCATION: location, CONF_ELEVATION: 5}
        )


async def test_what_was_typed_stays_in_the_form_after_an_error(
    hass: HomeAssistant, fetch: AsyncMock
) -> None:
    result = await submit(hass, place(91.0, 12.0, 77.0, name="Cabin"))
    assert suggested(result, CONF_NAME) == "Cabin"
    assert suggested(result, CONF_ELEVATION) == 77.0
    assert suggested(result, CONF_LOCATION) == {CONF_LATITUDE: 91.0, CONF_LONGITUDE: 12.0}


@pytest.mark.parametrize(
    ("failure", "error"),
    [
        (DownloadRefused("HTTP 403"), "download_limited"),
        (CatalogError("no route"), "cannot_connect"),
        (RuntimeError("surprise"), "unknown"),
    ],
)
async def test_a_catalog_that_cannot_be_had_is_explained_and_nothing_is_created(
    hass: HomeAssistant, fetch: AsyncMock, failure: Exception, error: str
) -> None:
    fetch.side_effect = failure
    result = await submit(hass, place(21.3069, -157.8583, name="Cabin"))
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": error}
    assert suggested(result, CONF_NAME) == "Cabin"
    assert not hass.config_entries.async_entries(DOMAIN)


async def test_only_an_unexpected_error_goes_to_the_log_with_its_traceback(
    hass: HomeAssistant, fetch: AsyncMock, caplog: pytest.LogCaptureFixture
) -> None:
    fetch.side_effect = RuntimeError("surprise")
    await submit(hass, place(21.3069, -157.8583))
    records = [r for r in caplog.records if "Unexpected error" in r.getMessage()]
    assert len(records) == 1
    assert records[0].levelno == logging.ERROR
    assert records[0].exc_info is not None


async def test_submitting_again_after_a_failed_download_tries_at_once(
    hass: HomeAssistant, fetch: AsyncMock
) -> None:
    # catalog.py: "retry_now cuts short the wait after a failed download".
    fetch.side_effect = CatalogError("no route")
    flow = await start(hass)
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"], place(21.3069, -157.8583)
    )
    assert result["errors"] == {"base": "cannot_connect"}

    fetch.side_effect = None
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"], place(21.3069, -157.8583)
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert fetch.await_count == 2
    await hass.async_block_till_done()


# The same place twice.


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [
        pytest.param(21.3069, -157.8583, id="the same"),
        pytest.param(21.30691, -157.85834, id="within ten metres"),
        pytest.param(21.30686, -157.85826, id="within ten metres, the other way"),
        pytest.param(21.3069, 202.1417, id="written 0 to 360"),
    ],
)
async def test_the_same_place_is_refused_without_asking_for_anything(
    hass: HomeAssistant, fetch: AsyncMock, latitude: float, longitude: float
) -> None:
    MockConfigEntry(domain=DOMAIN, data=dict(HONOLULU), unique_id="21.3069_-157.8583").add_to_hass(
        hass
    )
    result = await submit(hass, place(latitude, longitude))
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    fetch.assert_not_awaited()


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [
        pytest.param(21.30695, -157.8583, id="north at the fourth decimal"),
        pytest.param(21.3069, -157.85825, id="east at the fourth decimal"),
    ],
)
async def test_a_place_over_ten_metres_away_is_another_place(
    hass: HomeAssistant, fetch: AsyncMock, latitude: float, longitude: float
) -> None:
    MockConfigEntry(domain=DOMAIN, data=dict(HONOLULU), unique_id="21.3069_-157.8583").add_to_hass(
        hass
    )
    result = await submit(hass, place(latitude, longitude))
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()


@pytest.mark.parametrize(
    ("latitude", "longitude", "unique_id"),
    [
        (-0.00001, -0.00001, "0.0000_0.0000"),
        (0.00001, 0.00001, "0.0000_0.0000"),
        (0.0, 0.0, "0.0000_0.0000"),
        (21.3, -157.8, "21.3000_-157.8000"),
        (-33.86, 151.2, "-33.8600_151.2000"),
    ],
)
async def test_the_unique_id_is_four_decimals_and_never_negative_zero(
    hass: HomeAssistant, fetch: AsyncMock, latitude: float, longitude: float, unique_id: str
) -> None:
    result = await submit(hass, place(latitude, longitude))
    assert result["result"].unique_id == unique_id
    await hass.async_block_till_done()


async def test_either_side_of_zero_is_the_same_place(hass: HomeAssistant, fetch: AsyncMock) -> None:
    await submit(hass, place(0.00001, 0.00001))
    await hass.async_block_till_done()
    result = await submit(hass, place(-0.00001, -0.00001))
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
