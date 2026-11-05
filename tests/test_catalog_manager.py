"""The shared catalog's life: first download, storage, refreshes, retries and clock jumps.

What happens after a refusal is in test_catalog_refusals.py. The waits are written out here rather
than imported, as the README and const.py promise them: 12 hours between downloads, 30 minutes
(5 without a usable catalog) after a failure, a 2-hour clock slack and 14 days to go stale.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
import logging
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.const import EVENT_HOMEASSISTANT_FINAL_WRITE
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import Store
import pytest

from custom_components.satellite_spotter.catalog import (
    SHARED_CATALOG,
    CatalogManager,
    async_remove_catalog,
    async_shared_catalog,
    validate,
)
from custom_components.satellite_spotter.celestrak import CatalogError, DownloadRefused
from custom_components.satellite_spotter.predict import Satellite, read_catalog, write_catalog

from .common import NOW, advance, aged, satellites, with_epoch

STORE_KEY = "satellite_spotter.catalog"
IGNORING = "Ignoring the stored satellite catalog"
LOGGER_NAME = "custom_components.satellite_spotter.catalog"


def stored(hass_storage: dict[str, Any]) -> Any:
    """Return what the catalog's store holds."""
    return hass_storage[STORE_KEY]["data"]


def put_in_store(hass_storage: dict[str, Any], data: Any) -> None:
    """Leave this in the store, as an earlier run would have."""
    hass_storage[STORE_KEY] = {"version": 2, "minor_version": 1, "key": STORE_KEY, "data": data}


def _stored_entry(elements: Any) -> dict[str, Any]:
    return {"name": "A", "elements": elements, "standard_magnitude": 1.0, "curve": None}


def stored_catalog(updated: datetime, catalog: list[Satellite] | None = None) -> dict[str, Any]:
    """Return what the store holds for a catalog downloaded at a moment."""
    return {
        "updated": updated.isoformat(),
        "catalog": write_catalog(satellites() if catalog is None else catalog),
    }


def warnings_about_the_store(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if IGNORING in r.getMessage()]


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


@pytest.fixture
def fetch(catalog: list[Satellite]) -> Iterator[AsyncMock]:
    with patch(
        "custom_components.satellite_spotter.catalog.async_fetch_catalog",
        AsyncMock(return_value=catalog),
    ) as mock:
        yield mock


@pytest.fixture
def manager(hass: HomeAssistant) -> CatalogManager:
    return async_shared_catalog(hass)


# The first download.


async def test_first_use_downloads_the_catalog(
    hass: HomeAssistant, manager: CatalogManager, fetch: AsyncMock, catalog: list[Satellite]
) -> None:
    assert manager.satellites is None
    assert manager.updated is None
    assert manager.version == 0

    answer = await manager.async_satellites()

    fetch.assert_awaited_once_with(hass)
    assert answer == catalog
    assert manager.satellites == catalog
    assert manager.updated == NOW
    assert manager.version == int(manager.updated.timestamp())
    assert manager.last_error is None


async def test_the_records_and_the_index_follow_the_catalog(
    manager: CatalogManager, fetch: AsyncMock, catalog: list[Satellite]
) -> None:
    await manager.async_satellites()
    assert len(manager.satrecs()) == len(catalog)
    assert [record.satnum for record in manager.satrecs()][:3] == [20580, 25544, 48274]
    assert manager.by_id()[25544].name == "ISS"
    assert set(manager.by_id()) == {sat.norad_id for sat in catalog}


async def test_a_second_use_asks_nothing_and_keeps_the_version(
    manager: CatalogManager, fetch: AsyncMock
) -> None:
    first = await manager.async_satellites()
    second = await manager.async_satellites()
    assert fetch.await_count == 1
    assert second is first
    assert manager.version == int(manager.updated.timestamp())


async def test_simultaneous_first_uses_share_one_download(
    manager: CatalogManager, fetch: AsyncMock, catalog: list[Satellite]
) -> None:
    release = asyncio.Event()

    async def slowly(_hass: HomeAssistant) -> list[Satellite]:
        await release.wait()
        return catalog

    fetch.side_effect = slowly
    waiting = [asyncio.create_task(manager.async_satellites()) for _ in range(3)]
    await asyncio.sleep(0)
    release.set()
    answers = await asyncio.gather(*waiting)
    assert fetch.await_count == 1
    assert all(answer == catalog for answer in answers)


async def test_every_location_shares_one_manager(hass: HomeAssistant) -> None:
    first = async_shared_catalog(hass)
    assert async_shared_catalog(hass) is first
    assert hass.data[SHARED_CATALOG] is first


async def test_a_failure_with_no_catalog_raises_the_reason(
    manager: CatalogManager, fetch: AsyncMock
) -> None:
    fetch.side_effect = CatalogError("Could not reach CelesTrak: no route")
    with pytest.raises(CatalogError, match="no route") as caught:
        await manager.async_satellites()
    assert not isinstance(caught.value, DownloadRefused)
    assert manager.last_error == "Could not reach CelesTrak: no route"
    assert manager.satellites is None
    assert manager.version == 0


async def test_a_failure_without_words_is_named_by_its_type(
    manager: CatalogManager, fetch: AsyncMock
) -> None:
    fetch.side_effect = CatalogError()
    with pytest.raises(CatalogError, match="CatalogError"):
        await manager.async_satellites()
    assert manager.last_error == "CatalogError"


# What is worth keeping.


def _broken(**changes: str) -> Satellite:
    iss = satellites()[1]
    return replace(iss, elements={**iss.elements, **changes})


@pytest.mark.parametrize(
    "broken",
    [
        pytest.param(_broken(BSTAR="garbage"), id="a field that is no number"),
        pytest.param(_broken(MEAN_MOTION="0"), id="no mean motion"),
        pytest.param(_broken(ECCENTRICITY="1.5"), id="an impossible orbit"),
        pytest.param(replace(satellites()[1], elements={}), id="no elements at all"),
        pytest.param(
            replace(satellites()[1], standard_magnitude=float("nan")), id="NaN brightness"
        ),
        pytest.param(
            replace(satellites()[1], standard_magnitude=float("inf")), id="inf brightness"
        ),
    ],
)
def test_validate_sets_aside_what_makes_no_sense(broken: Satellite) -> None:
    good = satellites()[0]
    kept, records, dropped = validate([good, broken])
    assert kept == [good]
    assert len(records) == 1
    assert records[0].satnum == good.norad_id
    assert dropped == [str(broken.norad_id)]


def test_validate_keeps_a_satellite_with_no_magnitude_of_its_own() -> None:
    starlink = next(sat for sat in satellites() if sat.curve is not None)
    assert starlink.standard_magnitude is None
    kept, records, dropped = validate([starlink])
    assert kept == [starlink]
    assert len(records) == 1
    assert dropped == []


def test_validate_keeps_the_whole_fixture_in_order() -> None:
    catalog = satellites()
    kept, records, dropped = validate(catalog)
    assert kept == catalog
    assert records[0].satnum == catalog[0].norad_id
    assert len(records) == len(catalog)
    assert dropped == []


async def test_a_download_leaves_out_the_unusable_and_says_which_in_the_log(
    manager: CatalogManager,
    fetch: AsyncMock,
    catalog: list[Satellite],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger=LOGGER_NAME)
    fetch.return_value = [catalog[0], replace(_broken(BSTAR="x"), norad_id=99999)]
    assert await manager.async_satellites() == [catalog[0]]
    assert "Left out unusable satellites: 99999" in caplog.text


async def test_a_clean_download_mentions_nothing_left_out(
    manager: CatalogManager, fetch: AsyncMock, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger=LOGGER_NAME)
    await manager.async_satellites()
    assert "Left out" not in caplog.text


# What gets stored.


async def test_the_store_is_written_fifteen_seconds_after_a_download(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    catalog: list[Satellite],
    hass_storage: dict[str, Any],
) -> None:
    await manager.async_satellites()
    await advance(hass, freezer, NOW + timedelta(seconds=14))
    assert STORE_KEY not in hass_storage
    await advance(hass, freezer, NOW + timedelta(seconds=15))
    assert stored(hass_storage) == {"updated": NOW.isoformat(), "catalog": write_catalog(catalog)}
    assert hass_storage[STORE_KEY]["version"] == 2


async def test_a_clean_start_stores_the_same_field_names_people_have_on_disk(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
) -> None:
    await manager.async_satellites()
    await advance(hass, freezer, NOW + timedelta(seconds=15))
    entry = stored(hass_storage)["catalog"][1]
    assert set(entry) == {"name", "elements", "standard_magnitude", "curve"}
    assert entry["name"] == "ISS"
    assert entry["elements"]["NORAD_CAT_ID"] == "25544"


async def test_shutting_down_writes_a_download_not_yet_stored(
    hass: HomeAssistant, manager: CatalogManager, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    await manager.async_satellites()
    assert STORE_KEY not in hass_storage
    hass.bus.async_fire(EVENT_HOMEASSISTANT_FINAL_WRITE)
    await hass.async_block_till_done()
    assert stored(hass_storage)["updated"] == NOW.isoformat()


# Reading storage.


async def test_a_fresh_stored_catalog_needs_no_download(
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    catalog: list[Satellite],
) -> None:
    downloaded = NOW - timedelta(hours=3)
    put_in_store(hass_storage, stored_catalog(downloaded))
    assert await manager.async_satellites() == catalog
    fetch.assert_not_awaited()
    assert manager.updated == downloaded
    assert manager.version == int(manager.updated.timestamp())
    assert manager.last_error is None
    assert len(manager.satrecs()) == len(catalog)


async def test_storage_round_trips_every_field(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    catalog: list[Satellite],
) -> None:
    await manager.async_satellites()
    await advance(hass, freezer, NOW + timedelta(seconds=15))
    again = CatalogManager(hass)
    assert await again.async_satellites() == catalog
    assert again.updated == NOW
    assert fetch.await_count == 1


async def test_storage_is_read_only_once(
    hass: HomeAssistant, manager: CatalogManager, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    put_in_store(hass_storage, stored_catalog(NOW - timedelta(hours=3)))
    with patch.object(Store, "async_load", AsyncMock(wraps=manager._store.async_load)) as load:
        await manager.async_satellites()
        await manager.async_satellites()
    assert load.await_count == 1
    assert manager.version == int(manager.updated.timestamp())


@pytest.mark.parametrize(
    ("stamp", "expected"),
    [
        (NOW.isoformat(), NOW),
        ("2026-11-04T17:30:00+02:00", NOW),
        ("2026-11-04T15:30:00Z", NOW),
    ],
)
async def test_the_stored_date_is_read_in_any_offset(
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    stamp: str,
    expected: datetime,
) -> None:
    put_in_store(hass_storage, {**stored_catalog(NOW), "updated": stamp})
    await manager.async_satellites()
    assert manager.updated == expected
    assert manager.updated.tzinfo == UTC


async def test_a_stored_catalog_due_for_a_refresh_is_replaced(
    manager: CatalogManager, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    put_in_store(hass_storage, stored_catalog(NOW - timedelta(hours=12)))
    await manager.async_satellites()
    fetch.assert_awaited_once()
    assert manager.updated == NOW
    assert manager.version == int(manager.updated.timestamp())


async def test_a_stored_catalog_just_short_of_due_is_kept(
    manager: CatalogManager, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    put_in_store(hass_storage, stored_catalog(NOW - timedelta(hours=12) + timedelta(seconds=1)))
    await manager.async_satellites()
    fetch.assert_not_awaited()


async def test_an_old_stored_catalog_is_still_there_if_the_download_fails(
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    catalog: list[Satellite],
) -> None:
    old = NOW - timedelta(hours=30)
    put_in_store(hass_storage, stored_catalog(old))
    fetch.side_effect = CatalogError("no route")
    assert await manager.async_satellites() == catalog
    assert manager.updated == old
    assert manager.last_error == "no route"
    assert manager.version == int(manager.updated.timestamp())


@pytest.mark.parametrize(
    ("data", "why"),
    [
        pytest.param(["not", "a", "catalog"], "it is not a catalog", id="a list"),
        pytest.param("text", "it is not a catalog", id="text"),
        pytest.param({"catalog": []}, "it has no date", id="no date"),
        pytest.param(
            {"catalog": write_catalog(satellites()), "updated": None},
            "it has no date",
            id="date None",
        ),
        pytest.param(
            {"catalog": write_catalog(satellites()), "updated": 1793806752},
            "it has no date",
            id="date a number",
        ),
        pytest.param(
            {"catalog": write_catalog(satellites()), "updated": "the other day"},
            "it has no date",
            id="date no date",
        ),
        pytest.param({"catalog": [], "updated": NOW.isoformat()}, "no usable", id="empty catalog"),
        pytest.param({"catalog": 7, "updated": NOW.isoformat()}, "TypeError", id="a number"),
        pytest.param({"catalog": "junk", "updated": NOW.isoformat()}, "TypeError", id="a string"),
        pytest.param(
            {"catalog": {"OBJECT_NAME": 1}, "updated": NOW.isoformat()},
            "TypeError",
            id="a dictionary",
        ),
        pytest.param(
            {"catalog": ["OBJECT_NAME"], "updated": NOW.isoformat()},
            "TypeError",
            id="a list of the old field's name",
        ),
        pytest.param({"catalog": [{}], "updated": NOW.isoformat()}, "KeyError", id="no elements"),
        pytest.param(
            {"catalog": [_stored_entry(5)], "updated": NOW.isoformat()},
            "AttributeError",
            id="elements a number",
        ),
        pytest.param(
            {"catalog": [_stored_entry({"NORAD_CAT_ID": "x"})], "updated": NOW.isoformat()},
            "ValueError",
            id="catalog number no number",
        ),
        pytest.param(
            {
                "catalog": [_stored_entry({"NORAD_CAT_ID": "1", "OBJECT_NAME": "A", "EPOCH": "x"})],
                "updated": NOW.isoformat(),
            },
            "ValueError",
            id="bad epoch",
        ),
        pytest.param(
            {
                "catalog": [
                    _stored_entry(
                        {"NORAD_CAT_ID": "1", "OBJECT_NAME": "A", "EPOCH": "2026-11-04T00:00:00"}
                    )
                ],
                "updated": NOW.isoformat(),
            },
            "no usable",
            id="nothing usable",
        ),
    ],
)
async def test_corrupt_storage_is_ignored_with_a_warning_and_a_download(
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    catalog: list[Satellite],
    caplog: pytest.LogCaptureFixture,
    data: Any,
    why: str,
) -> None:
    put_in_store(hass_storage, data)
    assert await manager.async_satellites() == catalog
    fetch.assert_awaited_once()
    assert manager.version == int(manager.updated.timestamp())
    warned = warnings_about_the_store(caplog)
    assert len(warned) == 1
    assert why in warned[0]


async def test_a_store_that_cannot_be_read_is_ignored_with_a_warning(
    manager: CatalogManager, fetch: AsyncMock, caplog: pytest.LogCaptureFixture
) -> None:
    with patch.object(Store, "async_load", AsyncMock(side_effect=HomeAssistantError("corrupt"))):
        await manager.async_satellites()
    fetch.assert_awaited_once()
    assert "corrupt" in warnings_about_the_store(caplog)[0]


@pytest.mark.parametrize("data", [{}, None])
async def test_an_empty_store_is_nothing_to_warn_about(
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    caplog: pytest.LogCaptureFixture,
    data: Any,
) -> None:
    put_in_store(hass_storage, data)
    await manager.async_satellites()
    fetch.assert_awaited_once()
    assert not warnings_about_the_store(caplog)


async def test_a_store_with_no_catalog_key_is_nothing_to_warn_about(
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    caplog: pytest.LogCaptureFixture,
) -> None:
    # What is left behind by a refusal that has since run out, say.
    put_in_store(hass_storage, {"refused_until": (NOW - timedelta(hours=1)).isoformat()})
    await manager.async_satellites()
    fetch.assert_awaited_once()
    assert not warnings_about_the_store(caplog)


async def test_a_catalog_in_the_first_stored_form_is_read_rather_than_downloaded_again(
    hass: HomeAssistant, fetch: AsyncMock, hass_storage: dict[str, Any], catalog: list[Satellite]
) -> None:
    """The download may have been moments ago, and CelesTrak would refuse another."""
    older = [
        {
            "name": sat.name,
            "elements": dict(sat.elements),
            "magnitude": sat.standard_magnitude,
            "model": sat.curve,
        }
        for sat in catalog
    ]
    hass_storage[STORE_KEY] = {
        "version": 1,
        "minor_version": 1,
        "key": STORE_KEY,
        "data": {"updated": NOW.isoformat(), "catalog": older},
    }
    manager = CatalogManager(hass)
    assert await manager.async_satellites() == catalog
    fetch.assert_not_awaited()
    assert manager.updated == NOW


async def test_a_refusal_in_the_first_stored_form_is_kept(
    hass: HomeAssistant, fetch: AsyncMock, hass_storage: dict[str, Any]
) -> None:
    hass_storage[STORE_KEY] = {
        "version": 1,
        "minor_version": 1,
        "key": STORE_KEY,
        "data": {
            "refused_until": (NOW + timedelta(hours=1)).isoformat(),
            "last_error": "stored words",
            "catalog": ["not a satellite"],
        },
    }
    with pytest.raises(DownloadRefused, match="stored words"):
        await CatalogManager(hass).async_satellites()
    fetch.assert_not_awaited()


async def test_a_version_is_not_used_again_for_another_catalog(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    fetch: AsyncMock,
) -> None:
    """Pages keep a catalog while its version is current, whichever manager that comes from."""
    first = async_shared_catalog(hass)
    await first.async_satellites()
    version = first.version
    # Long enough for the stored copy to go with the last location.
    freezer.move_to(NOW + timedelta(hours=3))
    await async_remove_catalog(hass)
    second = async_shared_catalog(hass)
    await second.async_satellites()
    assert second is not first
    assert second.version != version


async def test_a_catalog_read_back_from_the_store_keeps_its_version(
    hass: HomeAssistant, fetch: AsyncMock, manager: CatalogManager
) -> None:
    await manager.async_satellites()
    await manager._store.async_save(manager._stored())
    again = CatalogManager(hass)
    await again.async_satellites()
    fetch.assert_awaited_once()
    assert again.version == manager.version


async def test_stored_satellites_that_became_unusable_are_left_out(
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    catalog: list[Satellite],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger=LOGGER_NAME)
    put_in_store(hass_storage, stored_catalog(NOW, [catalog[0], _broken(BSTAR="x")]))
    assert await manager.async_satellites() == [catalog[0]]
    fetch.assert_not_awaited()
    assert "Left out unusable satellites: 25544" in caplog.text


async def test_a_clean_store_mentions_nothing_left_out(
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger=LOGGER_NAME)
    put_in_store(hass_storage, stored_catalog(NOW))
    await manager.async_satellites()
    assert "Left out" not in caplog.text


# When a refresh is due.


async def test_no_refresh_a_second_before_twelve_hours(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await manager.async_satellites()
    freezer.move_to(NOW + timedelta(hours=12) - timedelta(seconds=1))
    await manager.async_satellites()
    assert fetch.await_count == 1


async def test_a_refresh_at_twelve_hours_and_twelve_hours_after_that(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await manager.async_satellites()
    freezer.move_to(NOW + timedelta(hours=12))
    await manager.async_satellites()
    assert fetch.await_count == 2
    assert manager.updated == NOW + timedelta(hours=12)
    assert manager.version == int(manager.updated.timestamp())
    freezer.move_to(NOW + timedelta(hours=24) - timedelta(seconds=1))
    await manager.async_satellites()
    assert fetch.await_count == 2
    freezer.move_to(NOW + timedelta(hours=24))
    await manager.async_satellites()
    assert fetch.await_count == 3


async def test_a_new_catalog_replaces_records_index_and_results_kept_for_the_old(
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    catalog: list[Satellite],
) -> None:
    await manager.async_satellites()
    manager.remember("positions", b"old")
    fetch.return_value = catalog[:2]
    freezer.move_to(NOW + timedelta(hours=12))
    assert await manager.async_satellites() == catalog[:2]
    assert len(manager.satrecs()) == 2
    assert set(manager.by_id()) == {catalog[0].norad_id, catalog[1].norad_id}
    assert manager.cached("positions") is None


async def test_a_new_catalog_tells_the_listeners_a_failure_does_not(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    listener = MagicMock()
    manager.async_add_listener(listener)
    await manager.async_satellites()
    assert listener.call_count == 1
    fetch.side_effect = CatalogError("no route")
    freezer.move_to(NOW + timedelta(hours=12))
    await manager.async_satellites()
    assert listener.call_count == 1


async def test_a_refresh_that_fails_keeps_the_catalog_and_says_why(
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    catalog: list[Satellite],
) -> None:
    await manager.async_satellites()
    fetch.side_effect = CatalogError("no route")
    freezer.move_to(NOW + timedelta(hours=12))
    assert await manager.async_satellites() == catalog
    assert manager.updated == NOW
    assert manager.version == int(manager.updated.timestamp())
    assert manager.last_error == "no route"


# Retries after a failure that was not a refusal.


async def test_with_a_catalog_a_failed_refresh_is_retried_after_thirty_minutes(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await manager.async_satellites()
    failed_at = NOW + timedelta(hours=12)
    fetch.side_effect = CatalogError("no route")
    freezer.move_to(failed_at)
    await manager.async_satellites()
    assert fetch.await_count == 2

    freezer.move_to(failed_at + timedelta(minutes=30) - timedelta(seconds=1))
    await manager.async_satellites()
    assert fetch.await_count == 2

    freezer.move_to(failed_at + timedelta(minutes=30))
    await manager.async_satellites()
    assert fetch.await_count == 3


async def test_with_no_catalog_a_failure_is_retried_after_five_minutes(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    fetch.side_effect = CatalogError("no route")
    with pytest.raises(CatalogError):
        await manager.async_satellites()

    freezer.move_to(NOW + timedelta(minutes=5) - timedelta(seconds=1))
    with pytest.raises(CatalogError, match="no route"):
        await manager.async_satellites()
    assert fetch.await_count == 1

    freezer.move_to(NOW + timedelta(minutes=5))
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    assert fetch.await_count == 2


@pytest.mark.parametrize(
    ("age", "retry"),
    [
        pytest.param(timedelta(days=14), timedelta(minutes=30), id="exactly 14 days"),
        pytest.param(
            timedelta(days=14, seconds=1), timedelta(minutes=5), id="a second over 14 days"
        ),
    ],
)
async def test_a_stale_catalog_is_retried_sooner(
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    age: timedelta,
    retry: timedelta,
) -> None:
    # A catalog whose elements all date from one moment: its median is that moment.
    catalog = [with_epoch(sat, NOW - age) for sat in satellites()]
    put_in_store(hass_storage, stored_catalog(NOW - timedelta(hours=12), catalog))
    fetch.side_effect = CatalogError("no route")
    await manager.async_satellites()
    assert fetch.await_count == 1

    freezer.move_to(NOW + retry - timedelta(seconds=1))
    await manager.async_satellites()
    assert fetch.await_count == 1

    freezer.move_to(NOW + retry)
    await manager.async_satellites()
    assert fetch.await_count == 2


async def test_retry_now_cuts_short_the_wait_after_a_failed_download(
    manager: CatalogManager, fetch: AsyncMock, catalog: list[Satellite]
) -> None:
    fetch.side_effect = CatalogError("no route")
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    fetch.side_effect = None
    assert await manager.async_satellites(retry_now=True) == catalog
    assert fetch.await_count == 2
    assert manager.last_error is None


async def test_retry_now_does_not_download_a_catalog_that_is_not_due(
    manager: CatalogManager, fetch: AsyncMock
) -> None:
    await manager.async_satellites()
    await manager.async_satellites(retry_now=True)
    assert fetch.await_count == 1


async def test_only_the_first_of_a_run_of_failures_is_a_warning(
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger=LOGGER_NAME)
    fetch.side_effect = CatalogError("no route")
    for minutes in (0, 5, 10):
        freezer.move_to(NOW + timedelta(minutes=minutes))
        with pytest.raises(CatalogError):
            await manager.async_satellites()
    records = [r for r in caplog.records if "Could not refresh" in r.getMessage()]
    assert [r.levelno for r in records] == [logging.WARNING, logging.DEBUG, logging.DEBUG]


async def test_recovering_is_logged_once_and_a_new_failure_warns_again(
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    fetch.side_effect = CatalogError("no route")
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    assert "downloaded again" not in caplog.text

    fetch.side_effect = None
    freezer.move_to(NOW + timedelta(minutes=5))
    await manager.async_satellites()
    assert caplog.text.count("The satellite catalog downloaded again") == 1
    assert manager.last_error is None

    caplog.clear()
    freezer.move_to(NOW + timedelta(hours=13))
    await manager.async_satellites()
    assert "downloaded again" not in caplog.text

    fetch.side_effect = CatalogError("no route")
    freezer.move_to(NOW + timedelta(hours=26))
    await manager.async_satellites()
    warned = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warned) == 1


async def test_a_failure_writes_nothing_to_the_store(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
) -> None:
    # Only a refusal needs remembering across a restart.
    fetch.side_effect = CatalogError("no route")
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    await advance(hass, freezer, NOW + timedelta(seconds=15))
    assert STORE_KEY not in hass_storage


# The clock jumping.


@pytest.mark.parametrize(
    "back",
    [
        pytest.param(timedelta(hours=1), id="an hour"),
        pytest.param(timedelta(hours=2), id="exactly the slack"),
        pytest.param(timedelta(hours=2, seconds=1), id="a second past the slack"),
        pytest.param(timedelta(days=30), id="a month"),
    ],
)
async def test_a_clock_set_back_does_not_bring_a_download_at_once(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock, back: timedelta
) -> None:
    """The stored catalog could be from moments ago, however far ahead it now looks."""
    await manager.async_satellites()
    freezer.move_to(NOW - back)
    await manager.async_satellites()
    assert fetch.await_count == 1


async def test_a_clock_set_back_for_good_brings_a_download_after_two_hours(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await manager.async_satellites()
    back = NOW - timedelta(days=30)
    freezer.move_to(back)
    await manager.async_satellites()
    freezer.move_to(back + timedelta(hours=2) - timedelta(seconds=1))
    await manager.async_satellites()
    assert fetch.await_count == 1
    freezer.move_to(back + timedelta(hours=2))
    await manager.async_satellites()
    assert fetch.await_count == 2
    # Nothing more is due: that download is dated by this clock.
    await manager.async_satellites()
    assert fetch.await_count == 2


async def test_a_clock_that_comes_right_is_no_reason_to_download(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await manager.async_satellites()
    freezer.move_to(NOW - timedelta(hours=3))
    await manager.async_satellites()
    freezer.move_to(NOW + timedelta(minutes=10))
    await manager.async_satellites()
    assert fetch.await_count == 1


async def test_a_clock_jumping_ahead_refreshes(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    await manager.async_satellites()
    freezer.move_to(NOW + timedelta(days=400))
    await manager.async_satellites()
    assert fetch.await_count == 2


@pytest.mark.parametrize(
    ("back", "asks"),
    [
        # After a failure with no catalog the wait is 5 minutes, and the longest such wait 30.
        pytest.param(timedelta(minutes=24), 1, id="still a plausible wait"),
        pytest.param(timedelta(minutes=25), 1, id="the longest plausible wait"),
        pytest.param(timedelta(minutes=25, seconds=1), 1, id="longer than the wait can be"),
    ],
)
async def test_a_clock_set_back_does_not_end_a_wait(
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    back: timedelta,
    asks: int,
) -> None:
    fetch.side_effect = CatalogError("no route")
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    freezer.move_to(NOW - back)
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    assert fetch.await_count == asks


async def test_a_clock_set_far_back_shortens_a_wait_to_the_longest_it_can_be(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    fetch.side_effect = CatalogError("no route")
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    back = NOW - timedelta(days=3)
    freezer.move_to(back)
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    assert fetch.await_count == 1
    freezer.move_to(back + timedelta(minutes=30))
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    assert fetch.await_count == 2


async def test_a_clock_jumping_past_a_retry_wait_ends_it(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    fetch.side_effect = CatalogError("no route")
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    freezer.move_to(NOW + timedelta(days=1))
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    assert fetch.await_count == 2


# Half-states that should not happen, and plain answers.


async def test_a_catalog_without_a_date_counts_as_due(
    manager: CatalogManager, catalog: list[Satellite]
) -> None:
    manager.satellites = catalog
    assert manager._due(NOW) is True


async def test_a_date_without_a_catalog_counts_as_due(manager: CatalogManager) -> None:
    manager.updated = NOW
    assert manager._due(NOW) is True


async def test_a_catalog_without_a_date_is_not_stored(
    manager: CatalogManager, catalog: list[Satellite]
) -> None:
    manager.satellites = catalog
    assert manager._stored() == {}


async def test_a_date_without_a_catalog_is_not_stored(manager: CatalogManager) -> None:
    manager.updated = NOW
    assert manager._stored() == {}


async def test_asking_is_a_plain_yes_or_no(
    manager: CatalogManager, freezer: FrozenDateTimeFactory, fetch: AsyncMock
) -> None:
    assert manager._may_ask(NOW, False) is True
    fetch.side_effect = CatalogError("no route")
    with pytest.raises(CatalogError):
        await manager.async_satellites()
    assert manager._may_ask(NOW, False) is False
    assert manager._may_ask(NOW, True) is True
    fetch.side_effect = DownloadRefused("HTTP 403")
    with pytest.raises(DownloadRefused):
        await manager.async_satellites(retry_now=True)
    assert manager._may_ask(NOW, False) is False
    assert manager._may_ask(NOW, True) is False


async def test_being_refused_is_a_plain_yes_or_no(
    manager: CatalogManager, freezer: FrozenDateTimeFactory, fetch: AsyncMock
) -> None:
    assert manager._would_be_refused(NOW) is False
    await manager.async_satellites()
    assert manager._would_be_refused(NOW) is True
    assert manager._would_be_refused(NOW + timedelta(hours=2)) is False


# What the manager tells others.


async def test_without_a_catalog_there_is_no_age_or_range(manager: CatalogManager) -> None:
    assert manager.median_epoch_age(NOW) is None
    assert manager.epoch_range() is None


async def test_the_age_is_the_median_of_an_odd_number_of_epochs(
    manager: CatalogManager, fetch: AsyncMock, catalog: list[Satellite]
) -> None:
    fetch.return_value = [
        replace(catalog[0], epoch=NOW - timedelta(days=40)),
        replace(catalog[1], epoch=NOW - timedelta(days=2)),
        replace(catalog[2], epoch=NOW - timedelta(days=1)),
    ]
    await manager.async_satellites()
    assert manager.median_epoch_age(NOW) == timedelta(days=2)
    assert manager.median_epoch_age(NOW + timedelta(days=1)) == timedelta(days=3)


async def test_the_age_is_the_middle_of_an_even_number_of_epochs(
    manager: CatalogManager, fetch: AsyncMock, catalog: list[Satellite]
) -> None:
    fetch.return_value = [
        replace(catalog[0], epoch=NOW - timedelta(days=40)),
        replace(catalog[1], epoch=NOW - timedelta(days=4)),
        replace(catalog[2], epoch=NOW - timedelta(days=2)),
        replace(catalog[3], epoch=NOW - timedelta(days=1)),
    ]
    await manager.async_satellites()
    assert manager.median_epoch_age(NOW) == timedelta(days=3)


async def test_the_range_is_the_oldest_and_newest_epochs(
    manager: CatalogManager, fetch: AsyncMock, catalog: list[Satellite]
) -> None:
    fetch.return_value = [
        replace(catalog[0], epoch=NOW - timedelta(days=2)),
        replace(catalog[1], epoch=NOW - timedelta(days=40)),
        replace(catalog[2], epoch=NOW - timedelta(days=1)),
    ]
    await manager.async_satellites()
    assert manager.epoch_range() == (NOW - timedelta(days=40), NOW - timedelta(days=1))


async def test_a_removed_listener_hears_nothing_and_removing_twice_is_harmless(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    listener = MagicMock()
    remove = manager.async_add_listener(listener)
    other = MagicMock()
    manager.async_add_listener(other)
    remove()
    remove()
    await manager.async_satellites()
    listener.assert_not_called()
    other.assert_called_once_with()


async def test_a_listener_removing_itself_does_not_cost_the_next_its_turn(
    manager: CatalogManager, fetch: AsyncMock
) -> None:
    second = MagicMock()

    def first() -> None:
        remove_first()

    remove_first = manager.async_add_listener(first)
    manager.async_add_listener(second)
    await manager.async_satellites()
    second.assert_called_once_with()


async def test_nothing_is_remembered_at_first(manager: CatalogManager) -> None:
    assert manager.cached("anything") is None


async def test_remembered_results_come_back(manager: CatalogManager) -> None:
    manager.remember("a", b"1")
    assert manager.cached("a") == b"1"
    manager.remember("a", b"2")
    assert manager.cached("a") == b"2"


async def test_eight_results_are_kept_and_the_ninth_pushes_out_the_oldest(
    manager: CatalogManager,
) -> None:
    for number in range(8):
        manager.remember(number, b"x")
    assert all(manager.cached(number) == b"x" for number in range(8))
    manager.remember(8, b"x")
    assert manager.cached(0) is None
    assert all(manager.cached(number) == b"x" for number in range(1, 9))


async def test_using_a_result_keeps_it_longer(manager: CatalogManager) -> None:
    for number in range(8):
        manager.remember(number, b"x")
    assert manager.cached(0) == b"x"
    manager.remember(8, b"x")
    assert manager.cached(0) == b"x"
    assert manager.cached(1) is None


async def test_remembering_again_keeps_a_result_longer(manager: CatalogManager) -> None:
    for number in range(8):
        manager.remember(number, b"x")
    manager.remember(0, b"y")
    manager.remember(8, b"x")
    assert manager.cached(0) == b"y"
    assert manager.cached(1) is None


# Removing the catalog when no refusal is involved.


async def test_removing_after_two_hours_deletes_the_stored_copy(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
) -> None:
    await manager.async_satellites()
    await advance(hass, freezer, NOW + timedelta(seconds=15))
    freezer.move_to(NOW + timedelta(hours=2))
    await async_remove_catalog(hass)
    assert STORE_KEY not in hass_storage
    assert SHARED_CATALOG not in hass.data


async def test_removing_a_second_short_of_two_hours_saves_it_at_once(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    catalog: list[Satellite],
) -> None:
    await manager.async_satellites()
    freezer.move_to(NOW + timedelta(hours=2) - timedelta(seconds=1))
    await async_remove_catalog(hass)
    assert stored(hass_storage) == {"updated": NOW.isoformat(), "catalog": write_catalog(catalog)}
    assert SHARED_CATALOG not in hass.data


@pytest.mark.parametrize(
    "back", [timedelta(hours=2), timedelta(hours=2, seconds=1), timedelta(days=30)]
)
async def test_removing_after_the_clock_was_set_back_keeps_a_download_that_may_be_recent(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    manager: CatalogManager,
    fetch: AsyncMock,
    hass_storage: dict[str, Any],
    back: timedelta,
) -> None:
    await manager.async_satellites()
    freezer.move_to(NOW - back)
    await async_remove_catalog(hass)
    assert STORE_KEY in hass_storage


async def test_removing_with_nothing_there_is_harmless(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    await async_remove_catalog(hass)
    assert STORE_KEY not in hass_storage
    assert SHARED_CATALOG not in hass.data


async def test_removing_deletes_a_stored_copy_nothing_has_read(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    put_in_store(hass_storage, stored_catalog(NOW - timedelta(hours=5)))
    await async_remove_catalog(hass)
    assert STORE_KEY not in hass_storage


async def test_read_catalog_and_write_catalog_mirror_each_other() -> None:
    # The form the fixture and people's disks are in.
    catalog = satellites()
    assert read_catalog(write_catalog(catalog)) == catalog


async def test_the_catalog_ages_as_time_passes(
    freezer: FrozenDateTimeFactory, manager: CatalogManager, fetch: AsyncMock
) -> None:
    fetch.return_value = aged(satellites(), timedelta(days=1))
    await manager.async_satellites()
    age = manager.median_epoch_age(NOW)
    assert age is not None
    assert manager.median_epoch_age(NOW + timedelta(days=2)) == age + timedelta(days=2)
