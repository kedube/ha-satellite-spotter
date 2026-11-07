"""Keeping faith with CelesTrak: nothing shortens the wait after a refusal.

CelesTrak can firewall an address that keeps asking. celestrak.py and const.py promise two hours of
silence after any refusal, whatever else happens: a restart, someone adding a location, removing the
last location and adding it back. Each route that could ask too soon has a test here. They count
the calls to the one function that talks to CelesTrak.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from datetime import datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import (
    SOURCE_RECONFIGURE,
    SOURCE_USER,
    ConfigEntryDisabler,
    ConfigEntryState,
)
from homeassistant.const import (
    CONF_ELEVATION,
    CONF_LATITUDE,
    CONF_LOCATION,
    CONF_LONGITUDE,
    CONF_NAME,
    EVENT_HOMEASSISTANT_FINAL_WRITE,
)
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
import pytest

from custom_components.satellite_spotter.catalog import (
    SHARED_CATALOG,
    CatalogManager,
    async_remove_catalog,
    async_shared_catalog,
)
from custom_components.satellite_spotter.celestrak import CatalogError, DownloadRefused
from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.predict import Satellite, write_catalog

from .common import DENVER, HONOLULU, NOW, add_location, advance, aged, cloud_forecast, satellites

STORE_KEY = "satellite_spotter.catalog"
REFUSAL = "CelesTrak allows one download every two hours, and answered HTTP 403 for GROUP=visual."
TWO_HOURS = timedelta(hours=2)
SECOND = timedelta(seconds=1)


def stored(hass_storage: dict[str, Any]) -> Any:
    return hass_storage[STORE_KEY]["data"]


def put_in_store(hass_storage: dict[str, Any], data: Any) -> None:
    hass_storage[STORE_KEY] = {"version": 2, "minor_version": 1, "key": STORE_KEY, "data": data}


async def restart(hass: HomeAssistant) -> CatalogManager:
    """Do what a restart does to the catalog: write what is pending, and start from storage."""
    hass.bus.async_fire(EVENT_HOMEASSISTANT_FINAL_WRITE)
    await hass.async_block_till_done()
    hass.data.pop(SHARED_CATALOG, None)
    return async_shared_catalog(hass)


async def refused_first_use(manager: CatalogManager) -> None:
    """Make the very first download a refusal."""
    with pytest.raises(DownloadRefused):
        await manager.async_satellites()


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


@pytest.fixture
def fetch() -> Iterator[AsyncMock]:
    """CelesTrak, refusing every download until a test says otherwise."""
    with patch(
        "custom_components.satellite_spotter.catalog.async_fetch_catalog",
        AsyncMock(side_effect=DownloadRefused(REFUSAL)),
    ) as mock:
        yield mock


@pytest.fixture
def forecast() -> Iterator[AsyncMock]:
    with patch(
        "custom_components.satellite_spotter.coordinator.async_fetch_forecast",
        AsyncMock(return_value=cloud_forecast()),
    ) as mock:
        yield mock


@pytest.fixture
def manager(hass: HomeAssistant) -> CatalogManager:
    return async_shared_catalog(hass)


# The wait itself.


async def test_a_refusal_is_reported_as_a_refusal(
    manager: CatalogManager, fetch: AsyncMock
) -> None:
    with pytest.raises(DownloadRefused, match="allows one download every two hours"):
        await manager.async_satellites()
    assert manager.last_error == REFUSAL
    assert manager.satellites is None


@pytest.mark.parametrize(
    "later",
    [
        pytest.param(timedelta(0), id="at once"),
        pytest.param(SECOND, id="a second later"),
        pytest.param(timedelta(minutes=5), id="after the unreachable retry"),
        pytest.param(timedelta(minutes=30), id="after the other retry"),
        pytest.param(TWO_HOURS - SECOND, id="a second short of two hours"),
    ],
)
@pytest.mark.parametrize("retry_now", [False, True], ids=["a refresh", "someone adding a location"])
async def test_nothing_is_asked_during_the_wait(
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    later: timedelta,
    retry_now: bool,
) -> None:
    await refused_first_use(manager)
    freezer.move_to(NOW + later)
    if retry_now:
        manager.forget_failed_download()
    with pytest.raises(DownloadRefused, match="two hours"):
        await manager.async_satellites()
    assert fetch.await_count == 1


async def test_asking_resumes_at_two_hours_exactly(
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    catalog: list[Satellite],
) -> None:
    await refused_first_use(manager)
    fetch.side_effect = None
    fetch.return_value = catalog
    freezer.move_to(NOW + TWO_HOURS)
    assert await manager.async_satellites() == catalog
    assert fetch.await_count == 2
    assert manager.last_error is None


async def test_a_second_refusal_starts_a_new_wait(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await refused_first_use(manager)
    freezer.move_to(NOW + TWO_HOURS)
    await refused_first_use(manager)
    assert fetch.await_count == 2
    freezer.move_to(NOW + 2 * TWO_HOURS - SECOND)
    await refused_first_use(manager)
    assert fetch.await_count == 2
    freezer.move_to(NOW + 2 * TWO_HOURS)
    await refused_first_use(manager)
    assert fetch.await_count == 3


async def test_a_catalog_with_nothing_usable_counts_as_a_refusal(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    # The whole catalog being nonsense is an answer that asking again soon would not improve.
    sat = satellites()[0]
    broken = type(sat)(sat.norad_id, sat.name, None, None, {"BSTAR": "x"}, sat.epoch)
    fetch.side_effect = None
    fetch.return_value = [broken]
    await refused_first_use(manager)
    freezer.move_to(NOW + TWO_HOURS - SECOND)
    await refused_first_use(manager)
    assert fetch.await_count == 1
    assert manager.last_error == "The satellite catalog has no usable satellites"


async def test_a_refusal_during_a_refresh_keeps_the_old_catalog_and_waits(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    catalog: list[Satellite],
) -> None:
    fetch.side_effect = None
    fetch.return_value = catalog
    await manager.async_satellites()
    refused_at = NOW + timedelta(hours=12)
    freezer.move_to(refused_at)
    fetch.side_effect = DownloadRefused(REFUSAL)

    # With a catalog to give, no exception: but the same silence.
    assert await manager.async_satellites() == catalog
    assert manager.last_error == REFUSAL
    assert fetch.await_count == 2
    freezer.move_to(refused_at + TWO_HOURS - SECOND)
    manager.forget_failed_download()
    assert await manager.async_satellites() == catalog
    assert fetch.await_count == 2
    freezer.move_to(refused_at + TWO_HOURS)
    await manager.async_satellites()
    assert fetch.await_count == 3


async def test_a_failure_after_the_wait_is_a_plain_failure_with_a_shorter_retry(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    # The wait has run out and CelesTrak cannot be reached: no longer a refusal to wait out.
    await refused_first_use(manager)
    fetch.side_effect = CatalogError("no route")
    freezer.move_to(NOW + TWO_HOURS)
    with pytest.raises(CatalogError, match="no route") as caught:
        await manager.async_satellites()
    assert not isinstance(caught.value, DownloadRefused)
    assert fetch.await_count == 2
    freezer.move_to(NOW + TWO_HOURS + timedelta(minutes=5))
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    assert fetch.await_count == 3


async def test_a_refusal_replaces_a_pending_retry_with_the_longer_wait(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    fetch.side_effect = CatalogError("no route")
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    fetch.side_effect = DownloadRefused(REFUSAL)
    manager.forget_failed_download()
    with pytest.raises(DownloadRefused):
        await manager.async_satellites()
    assert fetch.await_count == 2
    freezer.move_to(NOW + timedelta(minutes=5))
    with pytest.raises(DownloadRefused):
        await manager.async_satellites()
    assert fetch.await_count == 2


# What is stored about it.


async def test_a_refusal_with_no_catalog_is_stored_alone(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
) -> None:
    await refused_first_use(manager)
    await advance(hass, freezer, NOW + timedelta(seconds=14))
    assert STORE_KEY not in hass_storage
    await advance(hass, freezer, NOW + timedelta(seconds=15))
    assert stored(hass_storage) == {
        "refused_until": (NOW + TWO_HOURS).isoformat(),
        "last_error": REFUSAL,
    }


async def test_a_refusal_is_stored_with_the_catalog_it_left_in_place(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    catalog: list[Satellite],
) -> None:
    fetch.side_effect = None
    fetch.return_value = catalog
    await manager.async_satellites()
    refused_at = NOW + timedelta(hours=12)
    freezer.move_to(refused_at)
    fetch.side_effect = DownloadRefused(REFUSAL)
    await manager.async_satellites()
    await advance(hass, freezer, refused_at + timedelta(seconds=15))
    assert stored(hass_storage) == {
        "updated": NOW.isoformat(),
        "catalog": write_catalog(catalog),
        "refused_until": (refused_at + TWO_HOURS).isoformat(),
        "last_error": REFUSAL,
    }


async def test_a_success_clears_the_stored_refusal(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    catalog: list[Satellite],
) -> None:
    await refused_first_use(manager)
    await advance(hass, freezer, NOW + timedelta(seconds=15))
    fetch.side_effect = None
    fetch.return_value = catalog
    freezer.move_to(NOW + TWO_HOURS)
    await manager.async_satellites()
    await advance(hass, freezer, NOW + TWO_HOURS + timedelta(seconds=15))
    assert set(stored(hass_storage)) == {"updated", "catalog"}


async def test_a_plain_failure_after_a_refusal_stops_counting_as_refused(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
    manager: CatalogManager,
    hass_storage: dict[str, Any],
) -> None:
    await refused_first_use(manager)
    freezer.move_to(NOW + TWO_HOURS)
    fetch.side_effect = CatalogError("no route")
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    # Nothing left to honor, so removing the last location leaves nothing behind.
    await async_remove_catalog(hass)
    assert STORE_KEY not in hass_storage


# A restart.


async def test_a_restart_within_the_delayed_write_keeps_the_wait(
    hass: HomeAssistant, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await refused_first_use(manager)
    again = await restart(hass)
    assert again is not manager
    with pytest.raises(DownloadRefused, match="two hours"):
        await again.async_satellites()
    assert fetch.await_count == 1
    assert again.last_error == REFUSAL


async def test_a_restart_after_the_delayed_write_keeps_the_wait(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await refused_first_use(manager)
    await advance(hass, freezer, NOW + timedelta(hours=1))
    again = await restart(hass)
    with pytest.raises(DownloadRefused, match="two hours"):
        await again.async_satellites()
    assert fetch.await_count == 1


async def test_someone_adding_a_location_after_a_restart_does_not_shorten_the_wait(
    hass: HomeAssistant, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await refused_first_use(manager)
    again = await restart(hass)
    again.forget_failed_download()
    with pytest.raises(DownloadRefused):
        await again.async_satellites()
    assert fetch.await_count == 1


async def test_a_restart_keeps_the_end_of_the_wait_rather_than_starting_a_new_one(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    catalog: list[Satellite],
) -> None:
    await refused_first_use(manager)
    freezer.move_to(NOW + timedelta(hours=1))
    again = await restart(hass)
    freezer.move_to(NOW + TWO_HOURS - SECOND)
    await refused_first_use(again)
    assert fetch.await_count == 1
    fetch.side_effect = None
    fetch.return_value = catalog
    freezer.move_to(NOW + TWO_HOURS)
    assert await again.async_satellites() == catalog
    assert fetch.await_count == 2


async def test_a_restart_with_a_catalog_and_a_refusal_gives_the_catalog_and_keeps_the_wait(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    catalog: list[Satellite],
) -> None:
    fetch.side_effect = None
    fetch.return_value = catalog
    await manager.async_satellites()
    refused_at = NOW + timedelta(hours=12)
    freezer.move_to(refused_at)
    fetch.side_effect = DownloadRefused(REFUSAL)
    await manager.async_satellites()
    again = await restart(hass)
    assert await again.async_satellites() == catalog
    assert again.updated == NOW
    assert again.last_error == REFUSAL
    assert fetch.await_count == 2


@pytest.mark.parametrize(
    ("until", "asks"),
    [
        pytest.param(NOW + timedelta(hours=1), 0, id="an hour left"),
        pytest.param(NOW + SECOND, 0, id="a second left"),
        pytest.param(NOW + TWO_HOURS, 0, id="the whole wait left"),
        pytest.param(NOW, 1, id="over this instant"),
        pytest.param(NOW - SECOND, 1, id="over a second ago"),
        pytest.param(NOW + timedelta(days=3), 0, id="days ahead, from a clock since corrected"),
    ],
)
async def test_a_stored_refusal_counts_until_it_is_over(
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    until: datetime,
    asks: int,
) -> None:
    put_in_store(hass_storage, {"refused_until": until.isoformat(), "last_error": "stored words"})
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    assert fetch.await_count == asks


async def test_a_stored_refusal_brings_its_words_back(
    manager: CatalogManager, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    until = NOW + timedelta(hours=1)
    put_in_store(hass_storage, {"refused_until": until.isoformat(), "last_error": "stored words"})
    with pytest.raises(DownloadRefused, match="stored words"):
        await manager.async_satellites()
    assert manager.last_error == "stored words"


async def test_a_stored_refusal_without_words_still_raises_a_refusal(
    manager: CatalogManager, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    until = NOW + timedelta(hours=1)
    put_in_store(hass_storage, {"refused_until": until.isoformat()})
    with pytest.raises(DownloadRefused, match="did not send a catalog"):
        await manager.async_satellites()
    fetch.assert_not_awaited()


@pytest.mark.parametrize("over", [timedelta(0), SECOND], ids=["this instant", "a second ago"])
async def test_a_refusal_that_is_over_brings_no_old_words_with_it(
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    catalog: list[Satellite],
    over: timedelta,
) -> None:
    put_in_store(
        hass_storage,
        {
            "updated": NOW.isoformat(),
            "catalog": write_catalog(catalog),
            "refused_until": (NOW - over).isoformat(),
            "last_error": "stored words",
        },
    )
    await manager.async_satellites()
    assert manager.last_error is None


async def test_a_stored_refusal_outlives_a_corrupt_catalog_beside_it(
    manager: CatalogManager, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    put_in_store(
        hass_storage,
        {
            "refused_until": (NOW + timedelta(hours=1)).isoformat(),
            "last_error": "stored words",
            "updated": NOW.isoformat(),
            "catalog": "corrupt",
        },
    )
    with pytest.raises(DownloadRefused, match="stored words"):
        await manager.async_satellites()
    fetch.assert_not_awaited()


async def test_a_stored_refusal_outlives_a_catalog_from_before_1_08(
    manager: CatalogManager, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    put_in_store(
        hass_storage,
        {
            "refused_until": (NOW + timedelta(hours=1)).isoformat(),
            "updated": NOW.isoformat(),
            "catalog": [{"OBJECT_NAME": "ISS"}],
        },
    )
    with pytest.raises(DownloadRefused):
        await manager.async_satellites()
    fetch.assert_not_awaited()


@pytest.mark.parametrize("stamp", [None, 5, "soon", ""])
async def test_a_refusal_date_that_cannot_be_read_is_no_refusal(
    manager: CatalogManager, fetch: AsyncMock, hass_storage: dict[str, Any], stamp: Any
) -> None:
    put_in_store(hass_storage, {"refused_until": stamp, "last_error": "stored words"})
    with pytest.raises(DownloadRefused, match=REFUSAL):
        await manager.async_satellites()
    fetch.assert_awaited_once()


# The clock.


async def test_a_clock_jumping_past_the_wait_ends_it(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await refused_first_use(manager)
    freezer.move_to(NOW + timedelta(days=2))
    await refused_first_use(manager)
    assert fetch.await_count == 2


async def test_a_clock_set_far_back_cannot_strand_the_catalog(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    # Waiting for the clock to catch up would mean no catalog for days. Two hours, and it asks.
    await refused_first_use(manager)
    back = NOW - timedelta(days=3)
    freezer.move_to(back)
    await refused_first_use(manager)
    assert fetch.await_count == 1
    freezer.move_to(back + TWO_HOURS - SECOND)
    await refused_first_use(manager)
    assert fetch.await_count == 1
    freezer.move_to(back + TWO_HOURS)
    await refused_first_use(manager)
    assert fetch.await_count == 2


async def test_a_stored_refusal_too_far_ahead_lasts_two_hours_at_most(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
) -> None:
    put_in_store(
        hass_storage,
        {"refused_until": (NOW + timedelta(days=3)).isoformat(), "last_error": "stored words"},
    )
    manager = CatalogManager(hass)
    await refused_first_use(manager)
    assert fetch.await_count == 0
    freezer.move_to(NOW + TWO_HOURS)
    await refused_first_use(manager)
    assert fetch.await_count == 1


@pytest.mark.parametrize("back", [SECOND, timedelta(minutes=30)], ids=["a second", "half an hour"])
async def test_a_clock_stepping_back_a_little_does_not_ask_again_at_once(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock, back: timedelta
) -> None:
    await refused_first_use(manager)
    freezer.move_to(NOW - back)
    await refused_first_use(manager)
    assert fetch.await_count == 1


async def test_a_restart_with_the_clock_a_little_behind_does_not_ask_again_at_once(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await refused_first_use(manager)
    freezer.move_to(NOW - timedelta(minutes=30))
    again = await restart(hass)
    await refused_first_use(again)
    assert fetch.await_count == 1


@pytest.mark.parametrize("behind", [timedelta(minutes=30), timedelta(hours=5)], ids=str)
async def test_a_clock_that_comes_right_after_a_restart_keeps_the_end_of_the_wait(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    behind: timedelta,
) -> None:
    """A wait cut short by a wrong clock would end the moment the clock came right."""
    await refused_first_use(manager)
    restarted_at = NOW + timedelta(minutes=10)
    freezer.move_to(restarted_at - behind)
    again = await restart(hass)
    await refused_first_use(again)
    assert fetch.await_count == 1

    freezer.move_to(restarted_at + SECOND)
    await refused_first_use(again)
    assert fetch.await_count == 1

    freezer.move_to(NOW + TWO_HOURS - SECOND)
    await refused_first_use(again)
    assert fetch.await_count == 1

    freezer.move_to(NOW + TWO_HOURS)
    await refused_first_use(again)
    assert fetch.await_count == 2


async def test_the_real_end_of_the_wait_is_what_is_stored_with_the_clock_wrong(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
) -> None:
    await refused_first_use(manager)
    freezer.move_to(NOW - timedelta(hours=5))
    again = await restart(hass)
    await refused_first_use(again)
    assert again._stored()["refused_until"] == (NOW + TWO_HOURS).isoformat()


# A download that does not finish.


async def test_a_download_interrupted_waits_as_a_refusal_does(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
) -> None:
    """A reload can stop it after CelesTrak has answered part of it."""
    fetch.side_effect = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await manager.async_satellites()

    fetch.side_effect = None
    with pytest.raises(DownloadRefused, match="interrupted"):
        await manager.async_satellites()
    assert fetch.await_count == 1

    # Through a restart too.
    again = await restart(hass)
    with pytest.raises(DownloadRefused, match="interrupted"):
        await again.async_satellites()
    assert fetch.await_count == 1

    freezer.move_to(NOW + TWO_HOURS)
    fetch.return_value = satellites()
    await again.async_satellites()
    assert fetch.await_count == 2


# Removing the last location and adding it back.


async def test_removing_the_last_location_within_the_delayed_write_keeps_the_wait(
    hass: HomeAssistant, manager: CatalogManager, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    await refused_first_use(manager)
    assert STORE_KEY not in hass_storage
    await async_remove_catalog(hass)
    # Saved at once, not fifteen seconds later.
    assert stored(hass_storage)["refused_until"] == (NOW + TWO_HOURS).isoformat()
    assert SHARED_CATALOG not in hass.data

    async_shared_catalog(hass).forget_failed_download()
    with pytest.raises(DownloadRefused, match="two hours"):
        await async_shared_catalog(hass).async_satellites()
    assert fetch.await_count == 1


async def test_removing_a_second_before_the_wait_ends_keeps_it(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
) -> None:
    await refused_first_use(manager)
    freezer.move_to(NOW + TWO_HOURS - SECOND)
    await async_remove_catalog(hass)
    assert stored(hass_storage)["refused_until"] == (NOW + TWO_HOURS).isoformat()
    with pytest.raises(DownloadRefused):
        await async_shared_catalog(hass).async_satellites()
    assert fetch.await_count == 1


async def test_removing_when_the_wait_ends_leaves_nothing_behind(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
) -> None:
    await refused_first_use(manager)
    await advance(hass, freezer, NOW + timedelta(seconds=15))
    freezer.move_to(NOW + TWO_HOURS)
    await async_remove_catalog(hass)
    assert STORE_KEY not in hass_storage


async def test_removing_with_a_manager_that_has_not_read_storage_keeps_the_wait(
    hass: HomeAssistant, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    # After a restart, say, with only a disabled location left, which never loaded the catalog.
    until = (NOW + timedelta(hours=1)).isoformat()
    put_in_store(hass_storage, {"refused_until": until, "last_error": REFUSAL})
    await async_remove_catalog(hass)
    assert stored(hass_storage) == {"refused_until": until, "last_error": REFUSAL}
    with pytest.raises(DownloadRefused):
        await async_shared_catalog(hass).async_satellites()
    fetch.assert_not_awaited()


async def test_removing_keeps_the_catalog_beside_a_refusal(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    catalog: list[Satellite],
) -> None:
    # Downloaded long enough ago that only the refusal keeps the file.
    fetch.side_effect = None
    fetch.return_value = catalog
    await manager.async_satellites()
    refused_at = NOW + timedelta(hours=12)
    freezer.move_to(refused_at)
    fetch.side_effect = DownloadRefused(REFUSAL)
    await manager.async_satellites()
    await async_remove_catalog(hass)
    again = async_shared_catalog(hass)
    again.forget_failed_download()
    assert await again.async_satellites() == catalog
    assert fetch.await_count == 2
    assert again.updated == NOW


async def test_a_download_within_two_hours_needs_no_second_after_removing_and_adding_back(
    hass: HomeAssistant, manager: CatalogManager, fetch: AsyncMock, catalog: list[Satellite]
) -> None:
    # The README's promise: CelesTrak would refuse a second download this soon.
    fetch.side_effect = None
    fetch.return_value = catalog
    await manager.async_satellites()
    await async_remove_catalog(hass)
    async_shared_catalog(hass).forget_failed_download()
    assert await async_shared_catalog(hass).async_satellites() == catalog
    assert fetch.await_count == 1


# Through Home Assistant: the routes a person takes.


def _place(name: str, place: dict[str, float]) -> dict[str, Any]:
    return {
        CONF_NAME: name,
        CONF_LOCATION: {
            CONF_LATITUDE: place[CONF_LATITUDE],
            CONF_LONGITUDE: place[CONF_LONGITUDE],
        },
        CONF_ELEVATION: place[CONF_ELEVATION],
    }


async def _try_adding(hass: HomeAssistant, name: str, place: dict[str, float]) -> Any:
    """Open the form, submit it, and close it again if it still shows."""
    flow = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(flow["flow_id"], _place(name, place))
    if result["type"] is FlowResultType.FORM:
        hass.config_entries.flow.async_abort(flow["flow_id"])
    return result


async def test_pressing_submit_again_and_again_asks_once(
    hass: HomeAssistant, fetch: AsyncMock
) -> None:
    flow = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    for _ in range(3):
        result = await hass.config_entries.flow.async_configure(
            flow["flow_id"], _place("Home", HONOLULU)
        )
        assert result["type"] is FlowResultType.FORM
        assert result["errors"] == {"base": "download_limited"}
    assert fetch.await_count == 1


async def test_closing_the_form_and_opening_it_again_and_again_asks_once(
    hass: HomeAssistant, fetch: AsyncMock
) -> None:
    for _ in range(3):
        result = await _try_adding(hass, "Home", HONOLULU)
        assert result["errors"] == {"base": "download_limited"}
    assert fetch.await_count == 1


async def test_the_form_works_again_when_the_wait_is_over(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
    forecast: AsyncMock,
    catalog: list[Satellite],
) -> None:
    await _try_adding(hass, "Home", HONOLULU)
    fetch.side_effect = None
    fetch.return_value = catalog
    freezer.move_to(NOW + TWO_HOURS - SECOND)
    result = await _try_adding(hass, "Home", HONOLULU)
    assert result["errors"] == {"base": "download_limited"}
    assert fetch.await_count == 1
    freezer.move_to(NOW + TWO_HOURS)
    result = await _try_adding(hass, "Home", HONOLULU)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert fetch.await_count == 2
    await hass.async_block_till_done()


async def test_setup_retries_during_the_wait_ask_nothing(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, fetch: AsyncMock, forecast: AsyncMock
) -> None:
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert fetch.await_count == 1
    for minutes in range(1, 120):
        await advance(hass, freezer, NOW + timedelta(minutes=minutes))
        assert entry.state is ConfigEntryState.SETUP_RETRY
    assert fetch.await_count == 1


async def test_setup_succeeds_on_the_first_retry_after_the_wait(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
    forecast: AsyncMock,
    catalog: list[Satellite],
) -> None:
    entry = await add_location(hass)
    fetch.side_effect = None
    fetch.return_value = catalog
    for minutes in range(1, 121):
        await advance(hass, freezer, NOW + timedelta(minutes=minutes))
    await advance(hass, freezer, NOW + timedelta(minutes=125))
    assert entry.state is ConfigEntryState.LOADED
    assert fetch.await_count == 2


async def test_two_locations_retrying_ask_once_between_them(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, fetch: AsyncMock, forecast: AsyncMock
) -> None:
    first = await add_location(hass, HONOLULU, title="Home")
    second = await add_location(hass, DENVER, title="Cabin")
    assert first.state is ConfigEntryState.SETUP_RETRY
    assert second.state is ConfigEntryState.SETUP_RETRY
    for minutes in range(1, 120, 7):
        await advance(hass, freezer, NOW + timedelta(minutes=minutes))
    assert fetch.await_count == 1


async def test_reloading_a_retrying_location_asks_nothing(
    hass: HomeAssistant, fetch: AsyncMock, forecast: AsyncMock
) -> None:
    entry = await add_location(hass)
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert fetch.await_count == 1


async def test_a_loaded_location_refused_at_its_refresh_keeps_going_and_keeps_quiet(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
    forecast: AsyncMock,
    catalog: list[Satellite],
) -> None:
    fetch.side_effect = None
    fetch.return_value = catalog
    entry = await add_location(hass)
    assert fetch.await_count == 1

    fetch.side_effect = DownloadRefused(REFUSAL)
    # The refresh at twelve hours is refused; the ones that come before two more hours ask nothing.
    await advance(hass, freezer, NOW + timedelta(hours=12))
    assert fetch.await_count == 2
    refused_at = NOW + timedelta(hours=12)
    for minutes in range(1, 120, 13):
        await advance(hass, freezer, refused_at + timedelta(minutes=minutes))
    assert fetch.await_count == 2
    assert entry.state is ConfigEntryState.LOADED
    assert entry.runtime_data.last_update_success


async def test_reloading_or_changing_options_during_the_wait_asks_nothing(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
    forecast: AsyncMock,
    catalog: list[Satellite],
) -> None:
    fetch.side_effect = None
    fetch.return_value = catalog
    entry = await add_location(hass)
    refused_at = NOW + timedelta(hours=12)
    fetch.side_effect = DownloadRefused(REFUSAL)
    await advance(hass, freezer, refused_at)
    assert fetch.await_count == 2

    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert fetch.await_count == 2

    hass.config_entries.async_update_entry(entry, options={"brightness_cutoff": 1.0})
    await hass.async_block_till_done()
    assert fetch.await_count == 2
    assert entry.state is ConfigEntryState.LOADED


async def test_adding_another_location_during_the_wait_asks_nothing(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
    forecast: AsyncMock,
    catalog: list[Satellite],
) -> None:
    fetch.side_effect = None
    fetch.return_value = catalog
    await add_location(hass, HONOLULU)
    fetch.side_effect = DownloadRefused(REFUSAL)
    await advance(hass, freezer, NOW + timedelta(hours=12))
    assert fetch.await_count == 2

    result = await _try_adding(hass, "Cabin", DENVER)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert fetch.await_count == 2


async def test_moving_a_location_during_the_wait_asks_nothing(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
    forecast: AsyncMock,
    catalog: list[Satellite],
) -> None:
    fetch.side_effect = None
    fetch.return_value = catalog
    entry = await add_location(hass)
    fetch.side_effect = DownloadRefused(REFUSAL)
    await advance(hass, freezer, NOW + timedelta(hours=12))
    assert fetch.await_count == 2

    flow = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_RECONFIGURE, "entry_id": entry.entry_id}
    )
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"],
        {
            CONF_LOCATION: {CONF_LATITUDE: DENVER[CONF_LATITUDE], CONF_LONGITUDE: 10.0},
            CONF_ELEVATION: 1.0,
        },
    )
    assert result["reason"] == "reconfigure_successful"
    await hass.async_block_till_done()
    assert fetch.await_count == 2


async def test_disabling_and_enabling_a_location_during_the_wait_asks_nothing(
    hass: HomeAssistant, fetch: AsyncMock, forecast: AsyncMock
) -> None:
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    await hass.config_entries.async_set_disabled_by(entry.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    await hass.config_entries.async_set_disabled_by(entry.entry_id, None)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert fetch.await_count == 1


async def test_a_location_setting_up_after_a_restart_during_the_wait_asks_nothing(
    hass: HomeAssistant, fetch: AsyncMock, forecast: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    put_in_store(
        hass_storage,
        {"refused_until": (NOW + timedelta(hours=1)).isoformat(), "last_error": REFUSAL},
    )
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert entry.reason is not None
    assert "two hours" in entry.reason
    fetch.assert_not_awaited()


async def test_a_stale_catalog_retrying_every_few_minutes_still_waits(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
    forecast: AsyncMock,
    catalog: list[Satellite],
) -> None:
    # Stale predictions retry every five minutes. A refusal must still hold for two hours.
    fetch.side_effect = None
    fetch.return_value = catalog
    entry = await add_location(hass)
    fetch.side_effect = DownloadRefused(REFUSAL)
    refused_at = NOW + timedelta(days=20)
    await advance(hass, freezer, refused_at)
    assert entry.runtime_data.last_update_success is False
    assert fetch.await_count == 2
    for minutes in range(5, 120, 5):
        await advance(hass, freezer, refused_at + timedelta(minutes=minutes, seconds=1))
    assert fetch.await_count == 2


async def _remove(hass: HomeAssistant, entry_id: str) -> None:
    await hass.config_entries.async_remove(entry_id)
    await hass.async_block_till_done()


async def test_removing_the_last_location_and_adding_it_back_asks_nothing(
    hass: HomeAssistant, fetch: AsyncMock, forecast: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    entry = await add_location(hass)
    assert fetch.await_count == 1
    await _remove(hass, entry.entry_id)
    assert "refused_until" in stored(hass_storage)

    result = await _try_adding(hass, "Home", HONOLULU)
    assert result["errors"] == {"base": "download_limited"}
    assert fetch.await_count == 1

    # Nor can a location go straight back without the form.
    again = await add_location(hass)
    assert again.state is ConfigEntryState.SETUP_RETRY
    assert fetch.await_count == 1


async def test_removing_the_last_location_with_a_fresh_catalog_and_adding_it_back_asks_nothing(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
    forecast: AsyncMock,
    catalog: list[Satellite],
) -> None:
    fetch.side_effect = None
    fetch.return_value = catalog
    entry = await add_location(hass)
    freezer.move_to(NOW + TWO_HOURS - SECOND)
    await _remove(hass, entry.entry_id)
    result = await _try_adding(hass, "Home", HONOLULU)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert fetch.await_count == 1


async def test_removing_a_location_with_another_left_keeps_the_manager_and_the_wait(
    hass: HomeAssistant, fetch: AsyncMock, forecast: AsyncMock, catalog: list[Satellite]
) -> None:
    fetch.side_effect = None
    fetch.return_value = catalog
    first = await add_location(hass, HONOLULU)
    await add_location(hass, DENVER, title="Cabin")
    manager = hass.data[SHARED_CATALOG]
    await _remove(hass, first.entry_id)
    assert hass.data[SHARED_CATALOG] is manager
    assert fetch.await_count == 1


async def test_removing_all_but_a_disabled_location_keeps_the_stored_wait(
    hass: HomeAssistant, fetch: AsyncMock, forecast: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    # "the catalog goes with the last one, disabled ones counting".
    entry = await add_location(hass, HONOLULU)
    await add_location(hass, DENVER, title="Cabin", disabled_by=ConfigEntryDisabler.USER)
    await _remove(hass, entry.entry_id)
    with pytest.raises(DownloadRefused):
        await async_shared_catalog(hass).async_satellites()
    assert fetch.await_count == 1


async def test_a_stale_stored_catalog_does_not_get_around_a_stored_refusal(
    hass: HomeAssistant, fetch: AsyncMock, hass_storage: dict[str, Any], forecast: AsyncMock
) -> None:
    old = aged(satellites(), timedelta(days=-20))
    put_in_store(
        hass_storage,
        {
            "updated": (NOW - timedelta(days=20)).isoformat(),
            "catalog": write_catalog(old),
            "refused_until": (NOW + timedelta(hours=1)).isoformat(),
            "last_error": REFUSAL,
        },
    )
    entry = await add_location(hass)
    await hass.async_block_till_done(wait_background_tasks=True)
    # Set up, to say why there are no passes, and CelesTrak left alone.
    assert entry.state is ConfigEntryState.LOADED
    assert not entry.runtime_data.last_update_success
    fetch.assert_not_awaited()
