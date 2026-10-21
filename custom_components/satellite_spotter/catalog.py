"""The satellite catalog: downloaded once, shared by every location, kept across restarts."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timedelta
import logging
import math
import statistics
from typing import Any

from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util
from homeassistant.util.hass_dict import HassKey
from see_a_satellite import (
    CatalogError,
    Satellite,
    dump_catalog,
    fetch_site_catalog,
    parse_site_catalog,
)
from sgp4.api import Satrec

from . import track
from .const import (
    CATALOG_CLOCK_SLACK,
    CATALOG_MAX_AGE,
    CATALOG_NAME,
    CATALOG_REFRESH,
    CATALOG_RETRY,
    CATALOG_UNREACHABLE_RETRY,
    DOMAIN,
    POSITIONS_CACHE_SIZE,
    STORAGE_KEY,
    STORAGE_SAVE_DELAY,
    STORAGE_VERSION,
    USER_AGENT,
)

_LOGGER = logging.getLogger(__name__)

DATA_CATALOG: HassKey[CatalogManager] = HassKey(DOMAIN)


def validate(satellites: list[Satellite]) -> tuple[list[Satellite], list[Satrec], list[str]]:
    """Keep the satellites the predictions can use: them, their propagators, and the rest's ids.

    The library builds the propagators of a whole batch of satellites at
    once, so one malformed or decayed entry would otherwise break every
    prediction. Runs in the executor, before the propagators are shared.
    """
    kept: list[Satellite] = []
    satrecs: list[Satrec] = []
    dropped: list[str] = []
    for sat in satellites:
        try:
            satrec = sat.satrec()
            error, position, _ = satrec.sgp4(satrec.jdsatepoch, satrec.jdsatepochF)
            # The library's brightness bound and the payloads use these. A
            # value that is not finite ("NaN" in the website's data) gets this
            # far without an error, but would spoil the library's sort by
            # brightness, which then skips satellites that are fine.
            numbers = [*position, *track.apsides_km(sat), track.period_s(sat)]
            if sat.magnitude is not None:
                numbers.append(sat.magnitude)
            if not all(map(math.isfinite, numbers)):
                error = -1
        except (ArithmeticError, KeyError, TypeError, ValueError):
            error = -1
        if error:
            dropped.append(str(sat.norad_id))
            continue
        kept.append(sat)
        satrecs.append(satrec)
    return kept, satrecs, dropped


class CatalogManager:
    """Downloads the website's catalog and keeps it, for every location.

    The website's author hosts the catalog, so it is downloaded once for all
    locations, at most twice a day, and kept in Home Assistant's storage, so
    a restart does not download it again and predictions keep working
    offline. Every new catalog gets a new ``version``.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise the manager."""
        self._hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._lock = asyncio.Lock()
        self._loaded = False
        self._retry_after: datetime | None = None
        self._failing = False
        self._listeners: list[Callable[[], None]] = []
        self._satrecs: list[Satrec] = []
        self._by_id: dict[int, Satellite] = {}
        self._epochs: list[float] = []
        self._median_epoch: float | None = None
        self.satellites: list[Satellite] | None = None
        self.updated: datetime | None = None
        self.last_error: str | None = None
        self.version = 0
        # Results shared by every location, for the current catalog version.
        self.cache: dict[Any, Any] = {}

    async def async_get(self, *, retry_now: bool = False) -> list[Satellite]:
        """Return the catalog, downloading a new one when due.

        After a failed download the website is left alone for a while, unless
        ``retry_now`` (someone asked, in the config flow). Raises CatalogError
        when there is no catalog, cached or downloaded.
        """
        async with self._lock:
            if not self._loaded:
                await self._async_load()
            now = dt_util.utcnow()
            # No back-off is longer than CATALOG_RETRY: one further ahead was
            # set while the clock ran fast and has since been set back.
            if self._retry_after is not None and self._retry_after - now > CATALOG_RETRY:
                self._retry_after = None
            if self._due(now) and (
                retry_now or self._retry_after is None or now >= self._retry_after
            ):
                await self._async_refresh(now)
            if self.satellites is None:
                raise CatalogError(self.last_error or "No satellite catalog available")
            return self.satellites

    def _due(self, now: datetime) -> bool:
        if self.satellites is None or self.updated is None:
            return True
        age = now - self.updated
        # A download in the future means the clock was set back since.
        return age >= CATALOG_REFRESH or age < -CATALOG_CLOCK_SLACK

    async def _async_load(self) -> None:
        self._loaded = True
        stored = await self._store.async_load()
        if not stored:
            return
        try:
            satellites = parse_site_catalog(stored["catalog"])
            updated = dt_util.parse_datetime(stored["updated"])
            if updated is None:
                raise ValueError(f"invalid time {stored['updated']!r}")
        except (AttributeError, KeyError, TypeError, ValueError) as err:
            # Download a fresh catalog rather than fail every update.
            _LOGGER.warning("Ignoring the stored satellite catalog: %s", err)
            return
        if not await self._async_accept(satellites, dt_util.as_utc(updated)):
            _LOGGER.warning("Ignoring the stored satellite catalog: no usable satellites")

    async def _async_refresh(self, now: datetime) -> None:
        try:
            satellites = await fetch_site_catalog(
                async_get_clientsession(self._hass), CATALOG_NAME, user_agent=USER_AGENT
            )
            if not await self._async_accept(satellites, now):
                raise CatalogError("The satellite catalog has no usable satellites")
        except CatalogError as err:
            self.last_error = str(err)
            # Soon while there is nothing to predict from (or only orbit data too
            # old to use), otherwise less eagerly.
            age = self.median_epoch_age(now)
            usable = age is not None and age <= CATALOG_MAX_AGE
            self._retry_after = now + (CATALOG_RETRY if usable else CATALOG_UNREACHABLE_RETRY)
            # Loudly once per outage, then quietly until a download succeeds.
            log = _LOGGER.debug if self._failing else _LOGGER.warning
            self._failing = True
            if self.satellites is None:
                log("Could not download the satellite catalog: %s", err)
            else:
                log(
                    "Could not refresh the satellite catalog, using the one from %s: %s",
                    self.updated,
                    err,
                )
            return
        if self._failing:
            _LOGGER.info("The satellite catalog downloaded again")
        self._failing = False
        self._retry_after = None
        self.last_error = None
        self._store.async_delay_save(self._data_to_save, STORAGE_SAVE_DELAY)

    async def _async_accept(self, satellites: list[Satellite], updated: datetime) -> bool:
        """Make a catalog current (validated in the executor); False when none is usable."""
        kept, satrecs, dropped = await self._hass.async_add_executor_job(validate, satellites)
        if not kept:
            return False
        if dropped:
            _LOGGER.debug("Skipping %d unusable satellites: %s", len(dropped), dropped)
        self.satellites = kept
        self.updated = updated
        self._satrecs = satrecs
        self._by_id = {s.norad_id: s for s in kept}
        self._epochs = sorted(s.epoch.timestamp() for s in kept)
        self._median_epoch = statistics.median(self._epochs)
        self.version += 1
        self.cache = {}
        for listener in list(self._listeners):
            listener()
        return True

    async def async_remove(self) -> None:
        """Delete the stored copy, and any save still to come."""
        await self._store.async_remove()

    @callback
    def _data_to_save(self) -> dict[str, Any]:
        assert self.updated is not None
        return {"updated": self.updated.isoformat(), "catalog": dump_catalog(self.satellites or ())}

    @callback
    def async_add_listener(self, listener: Callable[[], None]) -> CALLBACK_TYPE:
        """Call listener whenever a new catalog becomes current; returns the remover."""
        self._listeners.append(listener)

        @callback
        def remove() -> None:
            self._listeners.remove(listener)

        return remove

    def satrecs(self) -> list[Satrec]:
        """SGP4 propagators of the current catalog, in catalog order.

        Shared: propagate them only through SatrecArray (which copies them),
        never with Satrec.sgp4, so any thread may use them.
        """
        return self._satrecs

    def by_id(self) -> dict[int, Satellite]:
        """Return the current catalog by NORAD catalog number."""
        return self._by_id

    def median_epoch_age(self, now: datetime) -> timedelta | None:
        """Return how old the orbital elements typically are; None without a catalog."""
        if self._median_epoch is None:
            return None
        return timedelta(seconds=now.timestamp() - self._median_epoch)

    def epoch_range(self) -> tuple[datetime, datetime] | None:
        """Return the oldest and newest element epochs of the catalog."""
        if not self._epochs:
            return None
        return dt_util.utc_from_timestamp(self._epochs[0]), dt_util.utc_from_timestamp(
            self._epochs[-1]
        )

    def cached(self, key: Any) -> Any:
        """Return a result computed for the current catalog version, or None."""
        value = self.cache.get(key)
        if value is not None:
            # Most recently used last, for the eviction below.
            self.cache[key] = self.cache.pop(key)
        return value

    def remember(self, key: Any, value: Any) -> None:
        """Keep a result for the current catalog version (a few at most)."""
        self.cache[key] = value
        while len(self.cache) > POSITIONS_CACHE_SIZE:
            self.cache.pop(next(iter(self.cache)))


@callback
def async_get_catalog(hass: HomeAssistant) -> CatalogManager:
    """Return the catalog shared by every location (and the config flow)."""
    if (manager := hass.data.get(DATA_CATALOG)) is None:
        manager = hass.data[DATA_CATALOG] = CatalogManager(hass)
    return manager


async def async_remove_catalog(hass: HomeAssistant) -> None:
    """Forget the shared catalog and delete its stored copy: the last location is gone.

    Through the shared catalog's own store when there is one, which also
    cancels a save it still has to make (a fresh download is saved a few
    seconds later), so that the copy is not written back.
    """
    manager = hass.data.pop(DATA_CATALOG, None) or CatalogManager(hass)
    await manager.async_remove()
