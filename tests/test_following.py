"""A location that follows someone: when it moves, what moves with it, and what stays."""

from __future__ import annotations

from datetime import timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from freezegun.api import FrozenDateTimeFactory
from homeassistant.const import CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.diagnostics import async_get_config_entry_diagnostics
from custom_components.satellite_spotter.frontend import location_json

from .common import DENVER, HONOLULU, NOW, add_location, advance

PERSON = "person.someone"
FOLLOWING = {"follow_entity": PERSON}
# Far enough from Honolulu to count, and from each other.
KAUAI = (22.0, -159.5)
MAUI = (20.8, -156.3)
# About 11 km from Honolulu.
NEARBY = (21.4069, -157.8583)


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


def is_at(hass: HomeAssistant, place: tuple[float, float] | None, state: str = "not_home") -> None:
    attributes: dict[str, Any] = {}
    if place is not None:
        attributes = {"latitude": place[0], "longitude": place[1]}
    hass.states.async_set(PERSON, state, attributes)


def where(entry: MockConfigEntry) -> tuple[float, float]:
    observer = entry.runtime_data.observer
    return observer.latitude, observer.longitude


HOME = (HONOLULU[CONF_LATITUDE], HONOLULU[CONF_LONGITUDE])


async def test_it_starts_from_where_they_are_if_they_say(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    is_at(hass, KAUAI)
    entry = await add_location(hass, options=FOLLOWING)
    assert where(entry) == KAUAI
    assert mock_downloads["fetch_forecast"].await_args.args[1:] == KAUAI


async def test_it_starts_from_the_place_set_up_if_they_do_not(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, options=FOLLOWING)
    assert where(entry) == HOME
    is_at(hass, None, "unknown")
    await hass.async_block_till_done(wait_background_tasks=True)
    assert where(entry) == HOME


async def test_it_searches_again_once_they_have_gone_far_enough(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    entry = await add_location(hass, options=FOLLOWING)
    searches = predict_passes.call_count

    is_at(hass, NEARBY)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert where(entry) == HOME
    assert predict_passes.call_count == searches

    is_at(hass, KAUAI)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert where(entry) == KAUAI
    assert predict_passes.call_count == searches + 1
    assert predict_passes.call_args.args[1] is entry.runtime_data.observer
    assert mock_downloads["fetch_forecast"].await_args.args[1:] == KAUAI


async def test_the_entry_stays_as_it_was_set_up_and_the_page_gets_where_they_are(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, options=FOLLOWING)
    is_at(hass, KAUAI)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert (entry.data[CONF_LATITUDE], entry.data[CONF_LONGITUDE]) == HOME
    place = location_json(entry.runtime_data)
    assert (place["latitude"], place["longitude"]) == KAUAI


async def test_it_moves_at_most_every_half_hour(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    entry = await add_location(hass, options=FOLLOWING)
    is_at(hass, KAUAI)
    await hass.async_block_till_done(wait_background_tasks=True)
    searches = predict_passes.call_count

    # On the move: nothing yet, and only the last place counts when the time comes.
    await advance(hass, freezer, NOW + timedelta(minutes=5))
    is_at(hass, MAUI)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert where(entry) == KAUAI
    assert predict_passes.call_count == searches
    is_at(hass, (21.0, -156.0))
    await hass.async_block_till_done(wait_background_tasks=True)

    await advance(hass, freezer, NOW + timedelta(minutes=30))
    assert where(entry) == (21.0, -156.0)
    assert predict_passes.call_count == searches + 1


async def test_it_settles_where_it_turned_back_from(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, options=FOLLOWING)
    is_at(hass, KAUAI)
    await hass.async_block_till_done(wait_background_tasks=True)
    await advance(hass, freezer, NOW + timedelta(minutes=5))
    is_at(hass, MAUI)
    await hass.async_block_till_done(wait_background_tasks=True)
    # Back where it is before the half hour is up: nothing to do when it is.
    is_at(hass, KAUAI)
    await advance(hass, freezer, NOW + timedelta(minutes=31))
    assert where(entry) == KAUAI


@pytest.mark.parametrize(
    "attributes",
    [
        {},
        {"latitude": 95.0, "longitude": 0.0},
        {"latitude": 0.0, "longitude": 190.0},
        {"latitude": "here", "longitude": "there"},
        {"latitude": float("nan"), "longitude": 0.0},
        {"latitude": 10.0},
    ],
)
async def test_what_makes_no_sense_is_ignored(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], attributes: dict[str, Any]
) -> None:
    entry = await add_location(hass, options=FOLLOWING)
    hass.states.async_set(PERSON, "not_home", attributes)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert where(entry) == HOME


async def test_unloading_stops_it(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    entry = await add_location(hass, options=FOLLOWING)
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    searches = predict_passes.call_count
    is_at(hass, KAUAI)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert predict_passes.call_count == searches


async def test_without_the_option_nothing_follows(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass)
    is_at(hass, KAUAI)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert where(entry) == HOME


async def test_diagnostics_keep_who_is_followed_to_themselves(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, options=FOLLOWING)
    report = await async_get_config_entry_diagnostics(hass, entry)
    assert PERSON not in str(report)


async def test_it_follows_a_real_tracker_through_a_real_person(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    assert await async_setup_component(
        hass,
        "person",
        {"person": [{"id": "1", "name": "Someone", "device_trackers": ["device_tracker.phone"]}]},
    )
    hass.states.async_set(
        "device_tracker.phone",
        "not_home",
        {
            "latitude": DENVER[CONF_LATITUDE],
            "longitude": DENVER[CONF_LONGITUDE],
            "source_type": "gps",
        },
    )
    await hass.async_block_till_done()
    entry = await add_location(hass, options=FOLLOWING)
    assert where(entry) == (DENVER[CONF_LATITUDE], DENVER[CONF_LONGITUDE])
    assert entry.domain == DOMAIN
