"""Predictions for one location, kept up to date."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from functools import partial
import logging
import re
from typing import Any, Self, override

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import CALLBACK_TYPE, HassJob, HomeAssistant, callback
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_point_in_utc_time
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from . import track
from .catalog import CatalogManager
from .celestrak import CatalogError
from .const import (
    CATALOG_MAX_AGE,
    CATALOG_STALE_UPSTREAM,
    CATALOG_UNREACHABLE_RETRY,
    CONF_ALERT_LEAD_MINUTES,
    CONF_BRIGHTNESS_CUTOFF,
    CONF_CLOUD_FORECAST,
    CONF_SHOW_CALENDAR,
    CONF_UNITS,
    DEFAULT_ALERT_LEAD_MINUTES,
    DEFAULT_BRIGHTNESS_CUTOFF,
    DEFAULT_CLOUD_FORECAST,
    DEFAULT_SHOW_CALENDAR,
    DEFAULT_UNITS,
    DOMAIN,
    FORECAST_MAX_AGE,
    ISSUE_CATALOG_STALE,
    LIVE_EVERY,
    LIVE_EVERY_DURING_PASS,
    MAX_SIGHTINGS,
    PASS_ID_TOLERANCE,
    PREDICTION_LOOKBACK,
    REFRESH_EVERY,
    SEARCH_EVERY,
    UPCOMING_WINDOW,
)
from .predict import Flyover, Satellite, find_sightings, group_sightings
from .weather import CloudCoverError, CloudForecast, async_fetch_forecast

_LOGGER = logging.getLogger(__name__)

# Listeners are woken a moment after a change, when it is sure to have happened.
_WAKE_AFTER = timedelta(seconds=1)
_URL_QUERY = re.compile(r"(\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s'\"?#]*)[?#][^\s'\"]*")


def scrub(err: BaseException) -> str:
    """Return an error's text without the query strings of any URLs; or else its type's name.

    Queries hold coordinates and keys, neither of which may reach a log.
    """
    return _URL_QUERY.sub(r"\1", str(err)) or type(err).__name__


@dataclass(frozen=True)
class PredictionSettings:
    """What a location's options ask for."""

    brightness_cutoff: float
    cloud_forecast: bool
    alert_lead: timedelta
    show_in_calendar: bool
    units: str

    @classmethod
    def from_options(cls, options: Mapping[str, Any]) -> Self:
        """Read the options, filling in the defaults."""
        return cls(
            brightness_cutoff=options.get(CONF_BRIGHTNESS_CUTOFF, DEFAULT_BRIGHTNESS_CUTOFF),
            cloud_forecast=options.get(CONF_CLOUD_FORECAST, DEFAULT_CLOUD_FORECAST),
            alert_lead=timedelta(
                minutes=options.get(CONF_ALERT_LEAD_MINUTES, DEFAULT_ALERT_LEAD_MINUTES)
            ),
            show_in_calendar=options.get(CONF_SHOW_CALENDAR, DEFAULT_SHOW_CALENDAR),
            units=options.get(CONF_UNITS, DEFAULT_UNITS),
        )


@dataclass
class ListedPass(Flyover):
    """A flyover as it is listed: with an id, its cloud cover and the shapes of its sightings."""

    id: str
    cloud_cover: int | None
    shapes: list[track.SightingShape]
    peak: track.SkyPoint

    def notice_at(self, alert_lead: timedelta) -> datetime:
        """Return when a pass's advance notice starts: that long before the lead appears."""
        return self.lead.appears.time - alert_lead


@dataclass(frozen=True)
class LiveSatellite:
    """The satellite of the pass under way, or the next, and where it is now."""

    satellite: Satellite
    position: track.SatellitePosition


@dataclass
class Predictions:
    """The passes of the latest search, and what they were found from."""

    passes: list[ListedPass]
    searched_at: datetime
    catalog_version: int
    satellites: Mapping[int, Satellite]
    cloud_forecast: bool | None
    by_id: dict[str, ListedPass] = field(init=False)

    def __post_init__(self) -> None:
        """Index the passes."""
        self.by_id = {p.id: p for p in self.passes}

    def next_visible_pass(self, now: datetime) -> ListedPass | None:
        """Return the pass under way, or else the next."""
        return next((p for p in self.passes if p.end > now), None)

    def next_bright_pass(self, now: datetime) -> ListedPass | None:
        """Return the bright pass under way, or else the next."""
        return next((p for p in self.passes if p.bright and p.end > now), None)

    def under_way(self, now: datetime) -> ListedPass | None:
        """Return the pass under way."""
        return next((p for p in self.passes if p.start <= now < p.end), None)

    def upcoming(self, now: datetime, window: timedelta = UPCOMING_WINDOW) -> list[ListedPass]:
        """Return the passes under way or starting within the window."""
        return [p for p in self.passes if p.end > now and p.start - now <= window]

    def next_change(self, now: datetime, alert_lead: timedelta) -> datetime | None:
        """Return the next moment after now when what the entities say could change."""
        moments = []
        for p in self.passes:
            moments += [p.start, p.end, p.start - UPCOMING_WINDOW, p.notice_at(alert_lead)]
        return min((moment for moment in moments if moment > now), default=None)

    def find(self, pass_id: str) -> ListedPass | None:
        """Return the pass with that id, or else the one starting nearest within the tolerance."""
        if (exact := self.by_id.get(pass_id)) is not None:
            return exact
        try:
            wanted = float(int(pass_id))
        except (OverflowError, ValueError):
            return None
        nearest = min(self.passes, key=lambda p: abs(p.start.timestamp() - wanted), default=None)
        if nearest is None:
            return None
        close = abs(nearest.start.timestamp() - wanted) <= PASS_ID_TOLERANCE.total_seconds()
        return nearest if close else None


def _listed(
    flyover: Flyover, observer: track.Observer, forecast: CloudForecast | None
) -> ListedPass:
    """List a flyover: the shapes of its sightings, up to MAX_SIGHTINGS, and its cloud cover."""
    shapes = [
        track.sighting_shape(
            sighting.satellite,
            observer,
            sighting.appears.time.timestamp(),
            sighting.vanishes.time.timestamp(),
            track.SkyPoint(
                sighting.brightest.time.timestamp(),
                sighting.brightest.azimuth,
                sighting.brightest.elevation,
            ),
        )
        for sighting in flyover.sightings[:MAX_SIGHTINGS]
    ]
    return ListedPass(
        flyover.sightings,
        id=str(int(flyover.start.timestamp())),
        cloud_cover=None if forecast is None else forecast.after(flyover.start),
        shapes=shapes,
        peak=max((shape.peak for shape in shapes), key=lambda peak: peak.elevation),
    )


def predict_passes(
    satellites: Sequence[Satellite],
    observer: track.Observer,
    *,
    start: datetime,
    faintest: float,
    forecast: CloudForecast | None,
) -> list[ListedPass]:
    """Search, group and list (in the executor)."""
    sightings = find_sightings(satellites, observer, start=start, faintest=faintest)
    return [_listed(flyover, observer, forecast) for flyover in group_sightings(sightings)]


def _with_clouds(
    data: Predictions, now: datetime, forecast: CloudForecast | None, enabled: bool
) -> Predictions:
    """Return the same search with the latest clouds, and without what is long over."""
    return Predictions(
        passes=[
            replace(p, cloud_cover=None if forecast is None else forecast.after(p.start))
            for p in data.passes
            if p.end > now - PREDICTION_LOOKBACK
        ],
        searched_at=data.searched_at,
        catalog_version=data.catalog_version,
        satellites=data.satellites,
        cloud_forecast=forecast is not None if enabled else None,
    )


def _nothing_to_stop() -> None:
    """Stand in for the timer's stopper while no timer is set."""


class SatelliteSpotterCoordinator(DataUpdateCoordinator[Predictions]):
    """Predicts a location's passes, and wakes the entities when what they say changes."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, catalog: CatalogManager) -> None:
        """Set up from the entry's data and options, listening for new catalogs."""
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=f"{DOMAIN} {entry.title}",
            update_interval=REFRESH_EVERY,
        )
        self.catalog = catalog
        self.observer = track.Observer(
            entry.data[CONF_LATITUDE],
            entry.data[CONF_LONGITUDE],
            entry.data.get(CONF_ELEVATION, 0.0),
        )
        self.settings = PredictionSettings.from_options(entry.options)
        self.title = entry.title
        self.live: LiveSatellite | None = None
        self._live_listeners: list[CALLBACK_TYPE] = []
        self._stop_live_timer: CALLBACK_TYPE = _nothing_to_stop
        self._live_job = HassJob(
            self._async_live_tick, f"{self.name} live", cancel_on_shutdown=True
        )
        self._forecast: CloudForecast | None = None
        self._forecast_at: datetime | None = None
        self._updating = False
        self._stopped = False
        self._stop_waiting: CALLBACK_TYPE = _nothing_to_stop
        self._stop_listening: CALLBACK_TYPE = catalog.async_add_listener(self._async_new_catalog)
        self._wake_job = HassJob(self._async_wake, f"{self.name} wake", cancel_on_shutdown=True)

    @property
    def predictions(self) -> Predictions | None:
        """The latest predictions; None before the first update."""
        return self.data

    @override
    async def _async_update_data(self) -> Predictions:
        self._updating = True
        try:
            return await self._async_predict()
        finally:
            self._updating = False

    async def _async_predict(self) -> Predictions:
        try:
            satellites = await self.catalog.async_satellites()
        except CatalogError as err:
            raise UpdateFailed(
                translation_domain=DOMAIN,
                translation_key="catalog_unavailable",
                translation_placeholders={"error": str(err)},
            ) from err
        version, by_id = self.catalog.version, self.catalog.by_id()

        now = dt_util.utcnow()
        self._async_check_age(now)

        forecast = await self._async_forecast(now)
        enabled = self.settings.cloud_forecast
        data = self.predictions
        if (
            data is not None
            and data.catalog_version == version
            and timedelta(0) <= now - data.searched_at < SEARCH_EVERY
        ):
            return _with_clouds(data, now, forecast, enabled)

        passes = await self.hass.async_add_executor_job(
            partial(
                predict_passes,
                satellites,
                self.observer,
                # A whole minute, so that passes keep their times and ids from run to run.
                start=(now - PREDICTION_LOOKBACK).replace(second=0, microsecond=0),
                faintest=self.settings.brightness_cutoff,
                forecast=forecast,
            )
        )
        return Predictions(
            passes=passes,
            searched_at=now,
            catalog_version=version,
            satellites=by_id,
            cloud_forecast=forecast is not None if enabled else None,
        )

    async def _async_forecast(self, now: datetime) -> CloudForecast | None:
        """Return the latest forecast, or the last one while it is fresh enough; None without."""
        if not self.settings.cloud_forecast:
            return None
        try:
            self._forecast = await async_fetch_forecast(
                async_get_clientsession(self.hass),
                self.observer.latitude,
                self.observer.longitude,
            )
            self._forecast_at = now
        except CloudCoverError as err:
            _LOGGER.debug("No cloud cover forecast: %s", scrub(err))
            if self._forecast_at is None or abs(now - self._forecast_at) > FORECAST_MAX_AGE:
                self._forecast = None
        return self._forecast

    @callback
    def _async_check_age(self, now: datetime) -> None:
        """Raise the repair issue and fail the update if the orbits are too old to trust."""
        if (age := self.stale_age(now)) is None:
            ir.async_delete_issue(self.hass, DOMAIN, ISSUE_CATALOG_STALE)
            return
        placeholders = {"age": str(age.days)}
        key = CATALOG_STALE_UPSTREAM
        if self.catalog.last_error:
            placeholders["error"] = self.catalog.last_error
            key = ISSUE_CATALOG_STALE
        ir.async_create_issue(
            self.hass,
            DOMAIN,
            ISSUE_CATALOG_STALE,
            is_fixable=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key=key,
            translation_placeholders=placeholders,
        )
        raise UpdateFailed(
            # Home Assistant can wake a refresh a second early: this one must find the catalog
            # ready to try again.
            retry_after=CATALOG_UNREACHABLE_RETRY.total_seconds() + 1,
            translation_domain=DOMAIN,
            translation_key=key,
            translation_placeholders=placeholders,
        )

    @callback
    def _async_new_catalog(self) -> None:
        """Refresh for a catalog that came from elsewhere."""
        data = self.predictions
        if self._updating or (data is not None and data.catalog_version == self.catalog.version):
            return
        self.config_entry.async_create_background_task(
            self.hass, self.async_request_refresh(), name=f"{self.name} new catalog"
        )

    @callback
    @override
    def _async_refresh_finished(self) -> None:
        self._async_set_timer()
        self._async_look_up()
        # Home Assistant tells listeners only of the first failure in a row, and the epoch sensor
        # goes on saying how old the orbits are and why they could not be refreshed.
        if not self.last_update_success:
            self.async_update_listeners()

    @callback
    def _async_set_timer(self) -> None:
        """Wait for the next moment that what the entities say can change."""
        self._stop_waiting()
        self._stop_waiting = _nothing_to_stop
        if self._stopped or (data := self.predictions) is None:
            return
        change = data.next_change(dt_util.utcnow(), self.settings.alert_lead)
        if change is not None:
            self._stop_waiting = async_track_point_in_utc_time(
                self.hass, self._wake_job, change + _WAKE_AFTER
            )

    @callback
    def _async_wake(self, _now: datetime) -> None:
        self._stop_waiting = _nothing_to_stop
        self._async_look_up()
        self.async_update_listeners()
        self._async_set_timer()

    @callback
    def async_add_live_listener(self, listener: CALLBACK_TYPE) -> CALLBACK_TYPE:
        """Call ``listener`` with each new position, until the function returned is called.

        Nothing is worked out while nothing listens.
        """
        self._live_listeners.append(listener)
        if len(self._live_listeners) == 1:
            self._async_look_up()

        @callback
        def remove() -> None:
            self._live_listeners.remove(listener)
            if not self._live_listeners:
                self._stop_live_timer()
                self._stop_live_timer = _nothing_to_stop
                self.live = None

        return remove

    @callback
    def _async_look_up(self) -> None:
        """Work out where the satellite is, and when to look again.

        For one satellite, this is little enough for the event loop.
        """
        self._stop_live_timer()
        self._stop_live_timer = _nothing_to_stop
        if self._stopped or not self._live_listeners:
            return
        now = dt_util.utcnow()
        p = self.next_visible_pass(now)
        sat = None if p is None else p.lead.satellite
        position = (
            None if sat is None else track.satellite_position(sat, self.observer, now.timestamp())
        )
        self.live = None if sat is None or position is None else LiveSatellite(sat, position)
        every = LIVE_EVERY_DURING_PASS if self.pass_under_way(now) is not None else LIVE_EVERY
        self._stop_live_timer = async_track_point_in_utc_time(
            self.hass, self._live_job, now + every
        )

    @callback
    def _async_live_tick(self, _now: datetime) -> None:
        self._stop_live_timer = _nothing_to_stop
        self._async_look_up()
        for listener in list(self._live_listeners):
            listener()

    @override
    async def async_shutdown(self) -> None:
        """Stop the timers and the catalog listener, and ignore new runs."""
        self._stopped = True
        self._stop_waiting()
        self._stop_waiting = _nothing_to_stop
        self._stop_live_timer()
        self._stop_live_timer = _nothing_to_stop
        self._stop_listening()
        await super().async_shutdown()

    def next_visible_pass(self, now: datetime) -> ListedPass | None:
        """Return the pass under way, or else the next."""
        data = self.predictions
        return None if data is None else data.next_visible_pass(now)

    def next_bright_pass(self, now: datetime) -> ListedPass | None:
        """Return the bright pass under way, or else the next."""
        data = self.predictions
        return None if data is None else data.next_bright_pass(now)

    def pass_under_way(self, now: datetime) -> ListedPass | None:
        """Return the pass under way."""
        data = self.predictions
        return None if data is None else data.under_way(now)

    def visible_pass_soon(self, now: datetime) -> ListedPass | None:
        """Return the next pass, from its advance notice until it ends."""
        p = self.next_visible_pass(now)
        return p if p is not None and p.notice_at(self.settings.alert_lead) <= now else None

    def bright_pass_soon(self, now: datetime) -> ListedPass | None:
        """Return the next bright pass, from its advance notice until it ends."""
        p = self.next_bright_pass(now)
        return p if p is not None and p.notice_at(self.settings.alert_lead) <= now else None

    def passes_from(self, now: datetime) -> list[ListedPass]:
        """Return the passes under way or to come."""
        data = self.predictions
        return [] if data is None else [p for p in data.passes if p.end > now]

    def upcoming_count(self, now: datetime) -> int:
        """Return how many passes are under way or start within a day."""
        data = self.predictions
        return 0 if data is None else len(data.upcoming(now))

    def stale_age(self, now: datetime) -> timedelta | None:
        """Return how old the orbits are, if that is too old to trust."""
        age = self.catalog.median_epoch_age(now)
        return age if age is not None and age > CATALOG_MAX_AGE else None

    def paused_reason(self, now: datetime) -> str | None:
        """Say why there are no predictions to go by; None when there are."""
        if not self.last_update_success:
            return str(self.last_exception or "") or "Predictions could not be updated"
        if (age := self.stale_age(now)) is not None:
            return f"Orbit data is {age.days} days old"
        return None
