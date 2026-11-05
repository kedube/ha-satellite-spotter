"""Moving a location in place: what shows it keeps working."""

from __future__ import annotations

import math
from typing import Any
from unittest.mock import AsyncMock, patch

from homeassistant.config_entries import SOURCE_RECONFIGURE, ConfigEntryState
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LOCATION, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult, FlowResultType, InvalidData
from homeassistant.helpers import entity_registry as er
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.celestrak import CatalogError
from custom_components.satellite_spotter.const import DOMAIN

from .common import DENVER, HONOLULU, add_location

MOVED = {CONF_LATITUDE: 20.0, CONF_LONGITUDE: -155.0, CONF_ELEVATION: 50.0}


def moved_to(latitude: float, longitude: float, elevation: float = 50.0) -> dict[str, Any]:
    return {
        CONF_LOCATION: {CONF_LATITUDE: latitude, CONF_LONGITUDE: longitude},
        CONF_ELEVATION: elevation,
    }


def key_of(result: FlowResult, name: str) -> Any:
    schema = result["data_schema"]
    assert schema is not None
    return next(key for key in schema.schema if key == name)


async def start(hass: HomeAssistant, entry: MockConfigEntry) -> FlowResult:
    return await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_RECONFIGURE, "entry_id": entry.entry_id}
    )


async def submit(hass: HomeAssistant, entry: MockConfigEntry, answer: dict[str, Any]) -> FlowResult:
    flow = await start(hass, entry)
    return await hass.config_entries.flow.async_configure(flow["flow_id"], answer)


async def test_the_form_offers_where_it_is_now(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    result = await start(hass, init_integration)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "reconfigure"
    assert result["errors"] == {}
    assert key_of(result, CONF_LOCATION).default() == {
        CONF_LATITUDE: HONOLULU[CONF_LATITUDE],
        CONF_LONGITUDE: HONOLULU[CONF_LONGITUDE],
    }
    assert key_of(result, CONF_ELEVATION).default() == HONOLULU[CONF_ELEVATION]


async def test_the_form_falls_back_to_home_for_what_is_missing(hass: HomeAssistant) -> None:
    hass.config.latitude = 12.5
    hass.config.longitude = -45.25
    hass.config.elevation = 321
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data={})
    entry.add_to_hass(hass)
    result = await start(hass, entry)
    assert key_of(result, CONF_LOCATION).default() == {CONF_LATITUDE: 12.5, CONF_LONGITUDE: -45.25}
    assert key_of(result, CONF_ELEVATION).default() == 321


async def test_the_elevation_box_has_the_same_limits_as_adding_a_location(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    for elevation in (-451, 8901):
        with pytest.raises(InvalidData):
            await submit(hass, init_integration, moved_to(20.0, -155.0, elevation))


async def test_moving_updates_the_place_and_keeps_the_entities_and_their_ids(
    hass: HomeAssistant, init_integration: MockConfigEntry, mock_downloads: dict[str, AsyncMock]
) -> None:
    registry = er.async_get(hass)
    entities_before = {
        e.entity_id: e.unique_id
        for e in er.async_entries_for_config_entry(registry, init_integration.entry_id)
    }
    result = await submit(hass, init_integration, moved_to(20.0, -155.0))
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reconfigure_successful"
    await hass.async_block_till_done()

    assert init_integration.data == MOVED
    assert init_integration.unique_id == "20.0000_-155.0000"
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1
    assert init_integration.state is ConfigEntryState.LOADED
    assert {
        e.entity_id: e.unique_id
        for e in er.async_entries_for_config_entry(registry, init_integration.entry_id)
    } == entities_before
    # The new place is what is predicted for, and the catalog stays as it is.
    assert init_integration.runtime_data.observer.latitude == 20.0
    assert init_integration.runtime_data.observer.elevation_m == 50.0
    mock_downloads["fetch_catalog"].assert_awaited_once()


async def test_a_moved_location_reloads_once(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, unique_id="21.3069_-157.8583")
    assert mock_downloads["fetch_forecast"].await_count == 1
    await submit(hass, entry, moved_to(20.0, -155.0))
    await hass.async_block_till_done()
    assert mock_downloads["fetch_forecast"].await_count == 2


async def test_a_location_still_retrying_is_reloaded_at_its_new_place(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    entry = await add_location(hass, unique_id="21.3069_-157.8583")
    assert entry.state is ConfigEntryState.SETUP_RETRY
    mock_downloads["fetch_catalog"].side_effect = None
    with patch.object(
        hass.config_entries,
        "async_schedule_reload",
        wraps=hass.config_entries.async_schedule_reload,
    ) as schedule:
        result = await submit(hass, entry, moved_to(20.0, -155.0))
        await hass.async_block_till_done()
    assert result["reason"] == "reconfigure_successful"
    schedule.assert_called_once_with(entry.entry_id)


async def test_saving_the_same_place_reloads_nothing(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    entry = await add_location(hass, unique_id="21.3069_-157.8583")
    assert entry.state is ConfigEntryState.SETUP_RETRY
    with patch.object(
        hass.config_entries,
        "async_schedule_reload",
        wraps=hass.config_entries.async_schedule_reload,
    ) as schedule:
        result = await submit(
            hass,
            entry,
            moved_to(HONOLULU[CONF_LATITUDE], HONOLULU[CONF_LONGITUDE], HONOLULU[CONF_ELEVATION]),
        )
        await hass.async_block_till_done()
    assert result["reason"] == "reconfigure_successful"
    schedule.assert_not_called()


async def test_saving_the_same_place_when_loaded_does_not_reload(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, unique_id="21.3069_-157.8583")
    before = entry.runtime_data
    result = await submit(
        hass,
        entry,
        moved_to(HONOLULU[CONF_LATITUDE], HONOLULU[CONF_LONGITUDE], HONOLULU[CONF_ELEVATION]),
    )
    await hass.async_block_till_done()
    assert result["reason"] == "reconfigure_successful"
    assert entry.runtime_data is before


async def test_a_small_move_within_ten_metres_is_saved(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, unique_id="21.3069_-157.8583")
    result = await submit(hass, entry, moved_to(21.30691, -157.8583, 5.0))
    await hass.async_block_till_done()
    assert result["reason"] == "reconfigure_successful"
    assert entry.data[CONF_LATITUDE] == 21.30691
    assert entry.unique_id == "21.3069_-157.8583"


async def test_only_the_elevation_changing_is_saved(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, unique_id="21.3069_-157.8583")
    result = await submit(
        hass, entry, moved_to(HONOLULU[CONF_LATITUDE], HONOLULU[CONF_LONGITUDE], 200.0)
    )
    await hass.async_block_till_done()
    assert result["reason"] == "reconfigure_successful"
    assert entry.data[CONF_ELEVATION] == 200.0
    assert entry.runtime_data.observer.elevation_m == 200.0


async def test_moving_onto_another_location_is_refused(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, unique_id="21.3069_-157.8583")
    await add_location(hass, DENVER, title="Cabin", unique_id="39.7400_-104.9900")
    result = await submit(
        hass, entry, moved_to(DENVER[CONF_LATITUDE], DENVER[CONF_LONGITUDE], 10.0)
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert entry.data == HONOLULU
    assert entry.unique_id == "21.3069_-157.8583"


async def test_a_place_written_zero_to_360_is_wrapped(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    await submit(hass, init_integration, moved_to(20.0, 205.0))
    await hass.async_block_till_done()
    assert init_integration.data[CONF_LONGITUDE] == -155.0
    assert init_integration.unique_id == "20.0000_-155.0000"


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [(90.00001, 0.0), (-91.0, 0.0), (math.nan, 0.0), (0.0, math.inf)],
)
async def test_a_place_that_makes_no_sense_is_explained_and_nothing_changes(
    hass: HomeAssistant, init_integration: MockConfigEntry, latitude: float, longitude: float
) -> None:
    result = await submit(hass, init_integration, moved_to(latitude, longitude))
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "reconfigure"
    assert result["errors"] == {CONF_LOCATION: "invalid_location"}
    assert key_of(result, CONF_ELEVATION).description["suggested_value"] == 50.0
    assert init_integration.data == HONOLULU
