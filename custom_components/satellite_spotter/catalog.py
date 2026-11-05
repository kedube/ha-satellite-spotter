"""The catalog every location shares: downloading it, keeping it, and leaving CelesTrak alone."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Callable, Hashable, Iterable, Sequence
from datetime import datetime, timedelta
import logging
import math
import statistics
from typing import Any

from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util
from homeassistant.util.hass_dict import HassKey
from sgp4.api import Satrec

from . import track
from .celestrak import CatalogError, DownloadRefused, async_fetch_catalog
from .const import (
    CATALOG_CLOCK_SLACK,
    CATALOG_MAX_AGE,
    CATALOG_REFRESH,
    CATALOG_REFUSED_RETRY,
    CATALOG_RETRY,
    CATALOG_UNREACHABLE_RETRY,
    DOMAIN,
    POSITIONS_CACHE_SIZE,
    STORAGE_KEY,
    STORAGE_SAVE_DELAY,
    STORAGE_VERSION,
)
from .predict import Satellite, read_catalog, write_catalog

_LOGGER = logging.getLogger(__name__)

SHARED_CATALOG: HassKey[CatalogManager] = HassKey(f"{DOMAIN}_catalog")

_NO_USABLE_SATELLITES = "The satellite catalog has no usable satellites"
_IGNORING = "Ignoring the stored satellite catalog: %s"
_LONGEST_RETRY = max(CATALOG_RETRY, CATALOG_UNREACHABLE_RETRY)


def _usable_record(sat: Satellite) -> Satrec | None:
    """Return a satellite's SGP4 record, if SGP4 and the orbit's formulas make sense of it."""
    try:
        record = sat.sgp4_record()
        error, position, _ = record.sgp4_tsince(0.0)
        numbers = [*position, *track.apsides_km(sat), track.period_s(sat)]
    except (ArithmeticError, KeyError, TypeError, ValueError):
        return None
    if sat.standard_magnitude is not None:
        numbers.append(sat.standard_magnitude)
    return None if error or not all(map(math.isfinite, numbers)) else record


def validate(satellites: Iterable[Satellite]) -> tuple[list[Satellite], list[Satrec], list[str]]:
    """Return the satellites worth keeping, their records and the ids of the rest, as strings."""
    kept: list[Satellite] = []
    records: list[Satrec] = []
    dropped: list[str] = []
    for sat in satellites:
        if (record := _usable_record(sat)) is None:
            dropped.append(str(sat.norad_id))
        else:
            kept.append(sat)
            records.append(record)
    return kept, records, dropped


def _read_stored(entries: Any) -> tuple[list[Satellite], list[Satrec], list[str]]:
    """Read and check a stored catalog (in the executor)."""
    return validate(read_catalog(entries))


def _from_before_1_08(entries: Any) -> bool:
    """Whether a stored catalog is from another source, on another brightness scale."""
    return (
        isinstance(entries, list)
        and bool(entries)
        and isinstance(entries[0], dict)
        and "OBJECT_NAME" in entries[0]
    )


def _stored_time(value: Any) -> datetime | None:
    parsed = dt_util.parse_datetime(value) if isinstance(value, str) else None
    return None if parsed is None else dt_util.as_utc(parsed)


class CatalogManager:
    """The one catalog, for every location: downloads when due, and keeps a copy in storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Start with nothing: storage is read on first use."""
        self.hass = hass
        self.satellites: list[Satellite] | None = None
        self.updated: datetime | None = None
        self.last_error: str | None = None
        self.version = 0
        self.cache: OrderedDict[Hashable, bytes] = OrderedDict()
        self._store: Store[Any] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._lock = asyncio.Lock()
        self._store_read = False
        self._refused_until: datetime | None = None
        self._retry_at: datetime | None = None
        self._failing = False
        self._satrecs: list[Satrec] = []
        self._by_id: dict[int, Satellite] = {}
        self._median_epoch: datetime | None = None
        self._listeners: list[CALLBACK_TYPE] = []

    async def async_satellites(self, *, retry_now: bool = False) -> list[Satellite]:
        """Return the catalog, reading storage on first use and downloading when due.

        ``retry_now`` cuts short the wait after a failed download, but never after a refusal.
        Raises CatalogError when there is no catalog, or DownloadRefused if that is because
        CelesTrak refused.
        """
        async with self._lock:
            await self._async_read_store()
            now = dt_util.utcnow()
            if self._due(now) and self._may_ask(now, retry_now):
                await self._async_download()
            if self.satellites is not None:
                return self.satellites
            error = self.last_error or "CelesTrak did not send a catalog"
            if self._refused_until is not None:
                raise DownloadRefused(error)
            raise CatalogError(error)

    def _due(self, now: datetime) -> bool:
        if self.satellites is None or self.updated is None:
            return True
        age = now - self.updated
        return age >= CATALOG_REFRESH or -age > CATALOG_CLOCK_SLACK

    def _may_ask(self, now: datetime, retry_now: bool) -> bool:
        """Whether a download may go ahead. A wait further ahead than its maximum is dropped."""
        if self._refused_until is not None:
            if timedelta(0) < self._refused_until - now <= CATALOG_REFUSED_RETRY:
                return False
            self._refused_until = None
        if self._retry_at is not None and not retry_now:
            if timedelta(0) < self._retry_at - now <= _LONGEST_RETRY:
                return False
            self._retry_at = None
        return True

    async def _async_download(self) -> None:
        try:
            downloaded = await async_fetch_catalog(self.hass)
            kept, records, dropped = await self.hass.async_add_executor_job(validate, downloaded)
            if not kept:
                raise DownloadRefused(_NO_USABLE_SATELLITES)
        except CatalogError as err:
            self._note_failure(err)
            return
        if dropped:
            _LOGGER.debug("Left out unusable satellites: %s", ", ".join(dropped))
        if self._failing:
            _LOGGER.info("The satellite catalog downloaded again")
        self._failing = False
        self.last_error = None
        self._refused_until = self._retry_at = None
        self._adopt(kept, records, dt_util.utcnow())
        self._store.async_delay_save(self._stored, STORAGE_SAVE_DELAY)

    def _note_failure(self, err: CatalogError) -> None:
        """Keep the old catalog, and work out when to try again."""
        self.last_error = str(err) or type(err).__name__
        log = _LOGGER.debug if self._failing else _LOGGER.warning
        log("Could not refresh the satellite catalog: %s", self.last_error)
        self._failing = True
        now = dt_util.utcnow()
        if isinstance(err, DownloadRefused):
            self._refused_until, self._retry_at = now + CATALOG_REFUSED_RETRY, None
            self._store.async_delay_save(self._stored, STORAGE_SAVE_DELAY)
        else:
            age = self.median_epoch_age(now)
            soon = age is None or age > CATALOG_MAX_AGE
            self._refused_until = None
            self._retry_at = now + (CATALOG_UNREACHABLE_RETRY if soon else CATALOG_RETRY)

    def _adopt(self, kept: list[Satellite], records: list[Satrec], updated: datetime) -> None:
        """Make this the catalog, and tell whoever is listening."""
        self.satellites = kept
        self.updated = updated
        self.version += 1
        self.cache.clear()
        self._satrecs = records
        self._by_id = {sat.norad_id: sat for sat in kept}
        self._median_epoch = dt_util.utc_from_timestamp(
            statistics.median(sat.epoch.timestamp() for sat in kept)
        )
        for listener in list(self._listeners):
            listener()

    async def _async_read_store(self) -> None:
        if self._store_read:
            return
        self._store_read = True
        try:
            stored = await self._store.async_load()
        except HomeAssistantError as err:
            _LOGGER.warning(_IGNORING, err)
            return
        if not stored:
            return
        if not isinstance(stored, dict):
            _LOGGER.warning(_IGNORING, "it is not a catalog")
            return
        self._restore_refusal(stored)
        if (entries := stored.get("catalog")) is not None:
            await self._async_restore_catalog(entries, stored.get("updated"))

    def _restore_refusal(self, stored: dict[str, Any]) -> None:
        until = _stored_time(stored.get("refused_until"))
        if until is None or not timedelta(0) < until - dt_util.utcnow() <= CATALOG_REFUSED_RETRY:
            return
        self._refused_until = until
        self.last_error = stored.get("last_error")

    async def _async_restore_catalog(self, entries: Any, stamp: Any) -> None:
        if _from_before_1_08(entries):
            _LOGGER.debug("Replacing the stored satellite catalog from before version 1.08")
            return
        if (updated := _stored_time(stamp)) is None:
            _LOGGER.warning(_IGNORING, "it has no date")
            return
        try:
            kept, records, dropped = await self.hass.async_add_executor_job(_read_stored, entries)
        except (AttributeError, KeyError, TypeError, ValueError) as err:
            _LOGGER.warning(_IGNORING, repr(err))
            return
        if not kept:
            _LOGGER.warning(_IGNORING, "it has no usable satellites")
            return
        if dropped:
            _LOGGER.debug("Left out unusable satellites: %s", ", ".join(dropped))
        self._adopt(kept, records, updated)

    def _stored(self) -> dict[str, Any]:
        """Return what goes to storage: a store can hold a refusal and no catalog."""
        data: dict[str, Any] = {}
        if self.satellites is not None and self.updated is not None:
            data["updated"] = self.updated.isoformat()
            data["catalog"] = write_catalog(self.satellites)
        if self._refused_until is not None:
            data["refused_until"] = self._refused_until.isoformat()
            data["last_error"] = self.last_error
        return data

    def _would_be_refused(self, now: datetime) -> bool:
        """Whether CelesTrak would refuse another download now."""
        if self._refused_until is not None and self._refused_until > now:
            return True
        if self.updated is None:
            return False
        return -CATALOG_CLOCK_SLACK <= now - self.updated < CATALOG_REFUSED_RETRY

    @callback
    def async_add_listener(self, listener: CALLBACK_TYPE) -> Callable[[], None]:
        """Call ``listener`` with every new catalog, until the function returned is called."""
        self._listeners.append(listener)

        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    def satrecs(self) -> Sequence[Satrec]:
        """Return the catalog's SGP4 records, in its order."""
        return self._satrecs

    def by_id(self) -> dict[int, Satellite]:
        """Return the catalog by NORAD id."""
        return self._by_id

    def median_epoch_age(self, now: datetime) -> timedelta | None:
        """Return how old the middle satellite's elements are; None without a catalog."""
        return None if self._median_epoch is None else now - self._median_epoch

    def epoch_range(self) -> tuple[datetime, datetime] | None:
        """Return the oldest and newest elements' dates; None without a catalog."""
        if not self.satellites:
            return None
        epochs = [sat.epoch for sat in self.satellites]
        return min(epochs), max(epochs)

    def cached(self, key: Hashable) -> bytes | None:
        """Return what was remembered under a key for this catalog, if it is still kept."""
        value = self.cache.get(key)
        if value is not None:
            self.cache.move_to_end(key)
        return value

    def remember(self, key: Hashable, value: bytes) -> None:
        """Keep a result for this catalog, with the most recently used others."""
        self.cache[key] = value
        self.cache.move_to_end(key)
        while len(self.cache) > POSITIONS_CACHE_SIZE:
            self.cache.popitem(last=False)

    async def async_remove(self) -> None:
        """Delete the stored copy, unless CelesTrak would refuse another download now.

        Then it is saved at once instead, so that a location added back needs no download.
        """
        async with self._lock:
            await self._async_read_store()
            if self._would_be_refused(dt_util.utcnow()):
                await self._store.async_save(self._stored())
            else:
                await self._store.async_remove()


@callback
def async_shared_catalog(hass: HomeAssistant) -> CatalogManager:
    """Return the one catalog manager, creating it if need be."""
    if (manager := hass.data.get(SHARED_CATALOG)) is None:
        manager = hass.data[SHARED_CATALOG] = CatalogManager(hass)
    return manager


async def async_remove_catalog(hass: HomeAssistant) -> None:
    """Remove the manager, and with it the stored catalog (even one nothing has read)."""
    manager = hass.data.pop(SHARED_CATALOG, None) or CatalogManager(hass)
    await manager.async_remove()
