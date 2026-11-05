"""The catalog every location shares: downloading it, keeping it, and leaving CelesTrak alone."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Callable, Hashable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
import logging
import math
import statistics
from typing import Any, override

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
    CATALOG_DOWNLOAD_EVERY,
    CATALOG_MAX_AGE,
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
_INTERRUPTED = (
    "The catalog download was interrupted. CelesTrak allows one download every two hours, so the "
    "integration waits two hours, then tries again by itself."
)
_LONGEST_RETRY = max(CATALOG_RETRY, CATALOG_UNREACHABLE_RETRY)


# What the first version of the store called two of each satellite's fields.
_STORED_FIELD_NAMES = {"magnitude": "standard_magnitude", "model": "curve"}


@dataclass
class _Wait:
    """Not to ask until a moment, whatever the clock does meanwhile.

    A clock set back makes a wait look longer than it can be. That must not end the wait, as
    CelesTrak can block an address that asks too soon, nor strand the catalog for as long as the
    clock is out. So the wait then lasts its longest from when that is noticed, unless the clock
    comes right first, when the moment it was to end holds again.
    """

    until: datetime
    longest: timedelta
    _cap: datetime | None = None

    def is_over(self, now: datetime) -> bool:
        """Say whether the wait is over."""
        left = self.until - now
        if left <= timedelta(0):
            return True
        if left <= self.longest:
            return False
        if self._cap is None:
            self._cap = now + self.longest
        return now >= self._cap


class _CatalogStore(Store[Any]):
    """The stored catalog, whose fields had other names in the first version.

    Read rather than downloaded again: the download may have been moments ago.
    """

    @override
    async def _async_migrate_func(
        self, old_major_version: int, old_minor_version: int, old_data: Any
    ) -> Any:
        if isinstance(old_data, dict) and isinstance(entries := old_data.get("catalog"), list):
            old_data["catalog"] = [
                {_STORED_FIELD_NAMES.get(key, key): value for key, value in entry.items()}
                if isinstance(entry, dict)
                else entry
                for entry in entries
            ]
        return old_data


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
        self._cache: OrderedDict[Hashable, bytes] = OrderedDict()
        self._store = _CatalogStore(hass, STORAGE_VERSION, STORAGE_KEY)
        self._lock = asyncio.Lock()
        self._store_read = False
        self._refusal: _Wait | None = None
        self._retry: _Wait | None = None
        self._clock_wait: _Wait | None = None
        self._failing = False
        self._satrecs: list[Satrec] = []
        self._by_id: dict[int, Satellite] = {}
        self.median_epoch: datetime | None = None
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
            if self._refusal is not None:
                raise DownloadRefused(error)
            raise CatalogError(error)

    def _due(self, now: datetime) -> bool:
        if self.satellites is None or self.updated is None:
            return True
        age = now - self.updated
        if age >= CATALOG_DOWNLOAD_EVERY:
            return True
        if -age <= CATALOG_CLOCK_SLACK:
            self._clock_wait = None
            return False
        if self._clock_wait is None:
            self._clock_wait = _Wait(self.updated + CATALOG_REFUSED_RETRY, CATALOG_REFUSED_RETRY)
        return self._clock_wait.is_over(now)

    def _may_ask(self, now: datetime, retry_now: bool) -> bool:
        """Whether a download may go ahead."""
        if self._refusal is not None and self._refusal.is_over(now):
            self._refusal = None
        if self._retry is not None and self._retry.is_over(now):
            self._retry = None
        return self._refusal is None and (self._retry is None or retry_now)

    async def _async_download(self) -> None:
        try:
            downloaded = await async_fetch_catalog(self.hass)
            kept, records, dropped = await self.hass.async_add_executor_job(validate, downloaded)
            if not kept:
                raise DownloadRefused(_NO_USABLE_SATELLITES)
        except CatalogError as err:
            self._note_failure(err)
            return
        except asyncio.CancelledError:
            # Stopped by a reload or a shutdown, perhaps after CelesTrak had answered some of it.
            self.last_error = _INTERRUPTED
            self._note_refusal(dt_util.utcnow())
            raise
        if dropped:
            _LOGGER.debug("Left out unusable satellites: %s", ", ".join(dropped))
        if self._failing:
            _LOGGER.info("The satellite catalog downloaded again")
        self._failing = False
        self.last_error = None
        self._refusal = self._retry = None
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
            self._note_refusal(now)
        else:
            age = self.median_epoch_age(now)
            soon = age is None or age > CATALOG_MAX_AGE
            self._refusal = None
            self._retry = _Wait(
                now + (CATALOG_UNREACHABLE_RETRY if soon else CATALOG_RETRY), _LONGEST_RETRY
            )

    def _note_refusal(self, now: datetime) -> None:
        """Leave CelesTrak alone for the whole wait, even through a restart."""
        self._refusal = _Wait(now + CATALOG_REFUSED_RETRY, CATALOG_REFUSED_RETRY)
        self._retry = None
        self._store.async_delay_save(self._stored, STORAGE_SAVE_DELAY)

    def _adopt(self, kept: list[Satellite], records: list[Satrec], updated: datetime) -> None:
        """Make this the catalog, and tell whoever is listening."""
        self.satellites = kept
        self.updated = updated
        # Never the same for two catalogs, even across removing the last location and adding it
        # back, as pages keep a catalog for as long as its version is current.
        self.version = int(updated.timestamp())
        self._clock_wait = None
        self._cache.clear()
        self._satrecs = records
        self._by_id = {sat.norad_id: sat for sat in kept}
        self.median_epoch = dt_util.utc_from_timestamp(
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
        if until is not None and until > dt_util.utcnow():
            self._refusal = _Wait(until, CATALOG_REFUSED_RETRY)
            self.last_error = stored.get("last_error")

    async def _async_restore_catalog(self, entries: Any, stamp: Any) -> None:
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
        if self._refusal is not None:
            data["refused_until"] = self._refusal.until.isoformat()
            data["last_error"] = self.last_error
        return data

    def _would_be_refused(self, now: datetime) -> bool:
        """Whether CelesTrak would refuse another download now, as far as anyone can tell."""
        if self._refusal is not None and not self._refusal.is_over(now):
            return True
        return self.updated is not None and now - self.updated < CATALOG_REFUSED_RETRY

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
        return None if self.median_epoch is None else now - self.median_epoch

    def epoch_range(self) -> tuple[datetime, datetime] | None:
        """Return the oldest and newest elements' dates; None without a catalog."""
        if not self.satellites:
            return None
        epochs = [sat.epoch for sat in self.satellites]
        return min(epochs), max(epochs)

    def cached(self, key: Hashable) -> bytes | None:
        """Return what was remembered under a key for this catalog, if it is still kept."""
        value = self._cache.get(key)
        if value is not None:
            self._cache.move_to_end(key)
        return value

    def remember(self, key: Hashable, value: bytes) -> None:
        """Keep a result for this catalog, with the most recently used others."""
        self._cache[key] = value
        self._cache.move_to_end(key)
        while len(self._cache) > POSITIONS_CACHE_SIZE:
            self._cache.popitem(last=False)

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
