"""Starting up: what a location waits for, and what it leaves until setup is over."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine, Iterator
from datetime import timedelta
import time
from typing import Any
from unittest.mock import AsyncMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
import pytest

from custom_components.satellite_spotter.catalog import async_shared_catalog
from custom_components.satellite_spotter.celestrak import CatalogError
from custom_components.satellite_spotter.const import (
    DOMAIN,
    FIRST_DOWNLOAD_WAIT,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from custom_components.satellite_spotter.predict import Satellite, write_catalog

from .common import DENVER, HONOLULU, NOW, add_location, aged, cloud_forecast, satellites


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


async def without_waiting(hass: HomeAssistant, work: Coroutine[Any, Any, Any]) -> Any:
    """Return what the work comes to, or fail: with the clock frozen, no timeout would ever fire."""
    task = asyncio.ensure_future(work)
    for _ in range(1000):
        if task.done():
            return task.result()
        await hass.async_add_executor_job(time.sleep, 0.01)
    task.cancel()
    pytest.fail("It is waiting for the network")


def stored(hass_storage: dict[str, Any], catalog: list[Satellite], age: timedelta) -> None:
    hass_storage[STORAGE_KEY] = {
        "version": STORAGE_VERSION,
        "data": {"updated": (NOW - age).isoformat(), "catalog": write_catalog(catalog)},
    }


@pytest.fixture
def hanging(mock_downloads: dict[str, AsyncMock]) -> Iterator[asyncio.Event]:
    """Have every request wait until the event, as on a network that accepts and never answers."""
    release = asyncio.Event()

    async def catalog(_hass: HomeAssistant) -> list[Satellite]:
        await release.wait()
        return satellites()

    async def forecast(*_: Any) -> Any:
        await release.wait()
        return cloud_forecast()

    mock_downloads["fetch_catalog"].side_effect = catalog
    mock_downloads["fetch_forecast"].side_effect = forecast
    yield release
    release.set()


async def test_a_stored_catalog_is_enough_to_start_without_the_network(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    mock_downloads: dict[str, AsyncMock],
    hanging: asyncio.Event,
) -> None:
    # Old enough for a new one to be due.
    stored(hass_storage, satellites(), timedelta(hours=13))
    entry = await without_waiting(hass, add_location(hass))
    assert entry.state is ConfigEntryState.LOADED
    passes = entry.runtime_data.predictions.passes
    assert passes
    assert {p.cloud_cover for p in passes} == {None}
    state = hass.states.get("sensor.home_next_visible_pass")
    assert state is not None
    assert state.state != "unknown"

    # What was left out comes along by itself once the network answers.
    hanging.set()
    await hass.async_block_till_done(wait_background_tasks=True)
    mock_downloads["fetch_catalog"].assert_awaited_once()
    mock_downloads["fetch_forecast"].assert_awaited()
    assert {p.cloud_cover for p in entry.runtime_data.predictions.passes} != {None}


async def test_a_stored_catalog_that_is_not_due_downloads_nothing_after_setup(
    hass: HomeAssistant, hass_storage: dict[str, Any], mock_downloads: dict[str, AsyncMock]
) -> None:
    stored(hass_storage, satellites(), timedelta(hours=2))
    entry = await add_location(hass)
    await hass.async_block_till_done(wait_background_tasks=True)
    mock_downloads["fetch_catalog"].assert_not_awaited()
    mock_downloads["fetch_forecast"].assert_awaited_once()
    assert {p.cloud_cover for p in entry.runtime_data.predictions.passes} != {None}


async def test_every_location_starts_without_waiting_and_shares_one_download(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    mock_downloads: dict[str, AsyncMock],
    hanging: asyncio.Event,
) -> None:
    stored(hass_storage, satellites(), timedelta(hours=13))
    home = await without_waiting(hass, add_location(hass, HONOLULU))
    cabin = await without_waiting(hass, add_location(hass, DENVER, title="Cabin"))
    assert home.state is cabin.state is ConfigEntryState.LOADED
    hanging.set()
    await hass.async_block_till_done(wait_background_tasks=True)
    mock_downloads["fetch_catalog"].assert_awaited_once()
    versions = {e.runtime_data.predictions.catalog_version for e in (home, cabin)}
    assert versions == {async_shared_catalog(hass).version}


async def test_a_reload_interrupts_nothing_and_finds_its_catalog_at_once(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    mock_downloads: dict[str, AsyncMock],
    hanging: asyncio.Event,
) -> None:
    stored(hass_storage, satellites(), timedelta(hours=2))
    entry = await without_waiting(hass, add_location(hass))
    await without_waiting(hass, hass.config_entries.async_reload(entry.entry_id))
    assert entry.state is ConfigEntryState.LOADED
    assert async_shared_catalog(hass).last_error is None


async def test_with_nothing_stored_setup_waits_a_while_and_then_retries(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], hanging: asyncio.Event
) -> None:
    # The clock is frozen, so the wait is over as soon as it is asked for.
    async def a_while_later(tasks: set[Any], timeout: float) -> tuple[set[Any], set[Any]]:
        assert timeout == FIRST_DOWNLOAD_WAIT.total_seconds()
        return set(), tasks

    with patch("custom_components.satellite_spotter.coordinator.asyncio.wait", a_while_later):
        entry = await without_waiting(hass, add_location(hass))
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert "Still waiting for CelesTrak" in (entry.reason or "")

    # The download went on: a retry finds what it brought, without a second one.
    hanging.set()
    await hass.async_block_till_done(wait_background_tasks=True)
    mock_downloads["fetch_catalog"].assert_awaited_once()
    assert async_shared_catalog(hass).last_error is None
    assert await async_shared_catalog(hass).async_load() is not None


async def test_with_nothing_stored_and_a_quick_answer_setup_has_everything_at_once(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.LOADED
    assert {p.cloud_cover for p in entry.runtime_data.predictions.passes} != {None}
    mock_downloads["fetch_catalog"].assert_awaited_once()
    mock_downloads["fetch_forecast"].assert_awaited_once()


async def test_with_nothing_stored_and_no_network_setup_retries_and_says_why(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert "no route" in (entry.reason or "")


async def test_what_stops_a_download_unexpectedly_is_not_swallowed(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].side_effect = RuntimeError("a bug")
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_an_entry_with_an_elevation_of_nothing_goes_by_sea_level(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, {**HONOLULU, "elevation": None})
    assert entry.state is ConfigEntryState.LOADED
    assert entry.runtime_data.observer.elevation_m == 0.0


async def test_an_entry_that_makes_no_sense_fails_cleanly(
    hass: HomeAssistant,
    mock_downloads: dict[str, AsyncMock],
    caplog: pytest.LogCaptureFixture,
) -> None:
    entry = await add_location(hass, {**HONOLULU, "elevation": "high"})
    await hass.async_block_till_done(wait_background_tasks=True)
    assert entry.state is ConfigEntryState.SETUP_ERROR
    assert "AttributeError" not in caplog.text
    assert "was never retrieved" not in caplog.text


async def test_a_repair_goes_away_as_soon_as_a_location_starts_with_fresh_elements(
    hass: HomeAssistant, hass_storage: dict[str, Any], mock_downloads: dict[str, AsyncMock]
) -> None:
    stored(hass_storage, satellites(), timedelta(hours=2))
    ir.async_create_issue(
        hass,
        DOMAIN,
        "catalog_stale",
        is_fixable=False,
        severity=ir.IssueSeverity.WARNING,
        translation_key="catalog_stale",
    )
    await add_location(hass)
    assert ir.async_get(hass).async_get_issue(DOMAIN, "catalog_stale") is None


async def test_a_stale_stored_catalog_with_a_working_download_recovers_by_itself(
    hass: HomeAssistant, hass_storage: dict[str, Any], mock_downloads: dict[str, AsyncMock]
) -> None:
    stored(hass_storage, aged(satellites(), timedelta(days=-20)), timedelta(days=20))
    entry = await add_location(hass)
    assert entry.runtime_data.predictions.passes == []
    await hass.async_block_till_done(wait_background_tasks=True)
    assert entry.runtime_data.last_update_success
    assert entry.runtime_data.predictions.passes
    assert ir.async_get(hass).async_get_issue(DOMAIN, "catalog_stale") is None
