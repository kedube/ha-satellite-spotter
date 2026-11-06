"""Predictions for one location, kept up to date."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from functools import partial
import logging
import math
import re
from typing import Any, Self, override

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    ATTR_LATITUDE,
    ATTR_LONGITUDE,
    CONF_ELEVATION,
    CONF_LATITUDE,
    CONF_LONGITUDE,
)
from homeassistant.core import CALLBACK_TYPE, Event, HassJob, HomeAssistant, State, callback
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import (
    EventStateChangedData,
    async_track_point_in_utc_time,
    async_track_state_change_event,
)
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util
from homeassistant.util.location import distance as location_distance

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
    CONF_FOLLOW_ENTITY,
    CONF_MIN_ELEVATION,
    CONF_SHOW_CALENDAR,
    CONF_UNITS,
    CONF_WEATHER_ENTITY,
    DEFAULT_ALERT_LEAD_MINUTES,
    DEFAULT_BRIGHTNESS_CUTOFF,
    DEFAULT_CLOUD_FORECAST,
    DEFAULT_MIN_ELEVATION,
    DEFAULT_SHOW_CALENDAR,
    DEFAULT_UNITS,
    DOMAIN,
    FIRST_DOWNLOAD_WAIT,
    FOLLOW_MIN_INTERVAL,
    FOLLOW_MIN_MOVE_KM,
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
from .rating import pass_score, rating_of
from .weather import (
    CloudCoverError,
    CloudForecast,
    async_entity_forecast,
    async_fetch_forecast,
)

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
    min_elevation: float
    weather_entity: str | None
    follow_entity: str | None

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
            min_elevation=options.get(CONF_MIN_ELEVATION, DEFAULT_MIN_ELEVATION),
            weather_entity=options.get(CONF_WEATHER_ENTITY) or None,
            follow_entity=options.get(CONF_FOLLOW_ENTITY) or None,
        )


@dataclass
class ListedPass(Flyover):
    """A flyover as it is listed: with an id, its cloud cover and the shapes of its sightings."""

    id: str
    cloud_cover: int | None
    shapes: list[track.SightingShape]
    peak: track.SkyPoint
    moon_dimming: float = 0.0

    def notice_at(self, alert_lead: timedelta) -> datetime:
        """Return when a pass's advance notice starts: that long before the lead appears."""
        return self.lead.appears.time - alert_lead

    @property
    def rating(self) -> str:
        """Say how worth going outside for it is: great, good, fair or poor."""
        return rating_of(
            pass_score(
                self.peak_magnitude,
                self.sky_limit,
                self.peak.elevation,
                self.duration,
                self.cloud_cover,
                self.moon_dimming,
            )
        )


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

    @classmethod
    def empty(cls, now: datetime, satellites: Mapping[int, Satellite]) -> Self:
        """Return no passes, from no search: the next refresh will search, whatever the catalog."""
        return cls(
            passes=[],
            searched_at=now,
            catalog_version=-1,
            satellites=satellites,
            cloud_forecast=None,
        )

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
    peak = max((shape.peak for shape in shapes), key=lambda peak: peak.elevation)
    return ListedPass(
        flyover.sightings,
        id=str(int(flyover.start.timestamp())),
        cloud_cover=None if forecast is None else forecast.after(flyover.start),
        shapes=shapes,
        peak=peak,
        moon_dimming=track.moon_dimming(observer, peak.time),
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


def _place_of(state: State | None) -> tuple[float, float] | None:
    """Return where a person or tracker says it is, if it says, in degrees."""
    if state is None:
        return None
    latitude, longitude = state.attributes.get(ATTR_LATITUDE), state.attributes.get(ATTR_LONGITUDE)
    if not isinstance(latitude, int | float) or not isinstance(longitude, int | float):
        return None
    if not (math.isfinite(latitude) and math.isfinite(longitude)):
        return None
    return (
        (float(latitude), float(longitude))
        if abs(latitude) <= 90 and abs(longitude) <= 180
        else None
    )


class SatelliteSpotterCoordinator(DataUpdateCoordinator[Predictions]):
    """Predicts a location's passes, and wakes the entities when what they say changes."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, catalog: CatalogManager) -> None:
        """Set up from the entry's data and options, listening for new catalogs."""
        # First of all, as Home Assistant shuts down whatever the parent's constructor has seen,
        # and an entry that makes no sense raises here.
        self.settings = PredictionSettings.from_options(entry.options)
        self.observer = self._observer_at(
            entry, entry.data[CONF_LATITUDE], entry.data[CONF_LONGITUDE]
        )
        self._stopped = False
        self._stop_live_timer: CALLBACK_TYPE = _nothing_to_stop
        self._stop_waiting: CALLBACK_TYPE = _nothing_to_stop
        self._stop_listening: CALLBACK_TYPE = _nothing_to_stop
        self._stop_following: CALLBACK_TYPE = _nothing_to_stop
        self._stop_follow_timer: CALLBACK_TYPE = _nothing_to_stop
        # The entry's id and not its title in what can reach a log: a location may be named after
        # an address.
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=f"{DOMAIN} {entry.entry_id}",
            update_interval=REFRESH_EVERY,
        )
        self.catalog = catalog
        self.title = entry.title
        self.live: LiveSatellite | None = None
        self._live_listeners: list[CALLBACK_TYPE] = []
        self._live_job = HassJob(
            self._async_live_tick, f"{self.name} live", cancel_on_shutdown=True
        )
        self._forecast: CloudForecast | None = None
        self._forecast_at: datetime | None = None
        self._updating = False
        # What the first refresh left out, for after setup.
        self._catch_up = False
        self._searched_from: track.Observer | None = None
        self._moved_at: datetime | None = None
        self._stop_listening = catalog.async_add_listener(self._async_new_catalog)
        self._wake_job = HassJob(self._async_wake, f"{self.name} wake", cancel_on_shutdown=True)
        self._follow_job = HassJob(
            self._async_check_followed, f"{self.name} follow", cancel_on_shutdown=True
        )
        if (followed := self.settings.follow_entity) is not None:
            self._stop_following = async_track_state_change_event(
                hass, [followed], self._async_followed_changed
            )
            # At once if it says, so that the first search is from there.
            if (place := _place_of(hass.states.get(followed))) is not None:
                self.observer = self._observer_at(entry, *place)

    def _observer_at(self, entry: ConfigEntry, latitude: float, longitude: float) -> track.Observer:
        return track.Observer(
            latitude,
            longitude,
            entry.data.get(CONF_ELEVATION) or 0.0,
            self.settings.min_elevation,
        )

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
        if self.predictions is None:
            return await self._async_first_predictions()
        try:
            satellites = await self.catalog.async_satellites()
        except CatalogError as err:
            raise self._unavailable(str(err)) from err
        now = dt_util.utcnow()
        self._async_check_age(now)

        forecast = await self._async_forecast(now)
        data = self.predictions
        if (
            data is not None
            and data.catalog_version == self.catalog.version
            and self._searched_from is self.observer
            and timedelta(0) <= now - data.searched_at < SEARCH_EVERY
        ):
            return _with_clouds(data, now, forecast, self.settings.cloud_forecast)
        return await self._async_search(satellites, now, forecast)

    async def _async_first_predictions(self) -> Predictions:
        """Start from the catalog there is, and leave the network until setup is over.

        A network that accepts and never answers would otherwise hold up Home Assistant's start,
        when a stored catalog has all that the entities need. Only with no catalog at all is it
        worth waiting for one, and then the network has shown that it works. If the catalog is too
        old to go by there are no passes, but setup still succeeds, so that the entity saying how
        old it is is there.
        """
        satellites = await self.catalog.async_load()
        if satellites is None:
            await self._async_wait_for_a_download()
            try:
                satellites = self.catalog.loaded()
            except CatalogError as err:
                raise self._unavailable(str(err)) from err
            forecast_now = True
        else:
            self._catch_up = True
            forecast_now = False
        now = dt_util.utcnow()
        if self.stale_age(now) is not None:
            self._catch_up = True
            return Predictions.empty(now, self.catalog.by_id())
        self._async_check_age(now)
        return await self._async_search(
            satellites, now, await self._async_forecast(now) if forecast_now else None
        )

    async def _async_wait_for_a_download(self) -> None:
        """Give the first download a little while: it goes on by itself if that is not enough.

        Not tied to the location, which would stop it if setup is to be retried: CelesTrak would
        have answered some of it for nothing.
        """
        download = self.hass.async_create_background_task(
            self.catalog.async_refresh(), name=f"{DOMAIN} first download"
        )
        done, _ = await asyncio.wait({download}, timeout=FIRST_DOWNLOAD_WAIT.total_seconds())
        if not done:
            raise self._unavailable("Still waiting for CelesTrak")
        download.result()

    @staticmethod
    def _unavailable(error: str) -> UpdateFailed:
        return UpdateFailed(
            translation_domain=DOMAIN,
            translation_key="catalog_unavailable",
            translation_placeholders={"error": error},
        )

    async def _async_search(
        self, satellites: list[Satellite], now: datetime, forecast: CloudForecast | None
    ) -> Predictions:
        version, by_id, observer = self.catalog.version, self.catalog.by_id(), self.observer
        passes = await self.hass.async_add_executor_job(
            partial(
                predict_passes,
                satellites,
                observer,
                # A whole minute, so that passes keep their times and ids from run to run.
                start=(now - PREDICTION_LOOKBACK).replace(second=0, microsecond=0),
                faintest=self.settings.brightness_cutoff,
                forecast=forecast,
            )
        )
        self._searched_from = observer
        enabled = self.settings.cloud_forecast
        return Predictions(
            passes=passes,
            searched_at=now,
            catalog_version=version,
            satellites=by_id,
            cloud_forecast=forecast is not None if enabled else None,
        )

    @callback
    def async_catch_up(self) -> None:
        """Do what the first refresh left out, now that setup is over: not something to wait for."""
        if self._catch_up:
            self._catch_up = False
            self.config_entry.async_create_background_task(
                self.hass, self.async_refresh(), name=f"{self.name} catch up"
            )

    async def _async_fetch_forecast(self) -> CloudForecast:
        if (entity_id := self.settings.weather_entity) is not None:
            return await async_entity_forecast(self.hass, entity_id)
        return await async_fetch_forecast(
            async_get_clientsession(self.hass),
            self.observer.latitude,
            self.observer.longitude,
        )

    async def _async_forecast(self, now: datetime) -> CloudForecast | None:
        """Return the latest forecast, or the last one while it is fresh enough; None without."""
        if not self.settings.cloud_forecast:
            return None
        try:
            self._forecast = await self._async_fetch_forecast()
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
        else:
            # The download worked and CelesTrak's own data is as old. Nothing here can be fixed, so
            # it is no repair: the page and the epoch sensor say what is going on.
            ir.async_delete_issue(self.hass, DOMAIN, ISSUE_CATALOG_STALE)
        raise UpdateFailed(
            # Home Assistant can wake a refresh a second early: this one must find the catalog
            # ready to try again.
            retry_after=CATALOG_UNREACHABLE_RETRY.total_seconds() + 1,
            translation_domain=DOMAIN,
            translation_key=key,
            translation_placeholders=placeholders,
        )

    @callback
    def _async_followed_changed(self, _event: Event[EventStateChangedData]) -> None:
        self._async_check_followed()

    @callback
    def _async_check_followed(self, _now: datetime | None = None) -> None:
        """Move with the person or tracker, once far enough away, and not too often.

        The search takes seconds of work on a small computer, and passes barely change over
        a few kilometres. The entry itself stays where it was set up.
        """
        self._stop_follow_timer()
        self._stop_follow_timer = _nothing_to_stop
        followed = self.settings.follow_entity
        place = None if followed is None else _place_of(self.hass.states.get(followed))
        if self._stopped or place is None:
            return
        metres = location_distance(self.observer.latitude, self.observer.longitude, *place)
        if metres is None or metres < FOLLOW_MIN_MOVE_KM * 1000.0:
            return
        now = dt_util.utcnow()
        if self._moved_at is not None and (later := self._moved_at + FOLLOW_MIN_INTERVAL) > now:
            self._stop_follow_timer = async_track_point_in_utc_time(
                self.hass, self._follow_job, later
            )
            return
        self._moved_at = now
        self.observer = self._observer_at(self.config_entry, *place)
        # The forecast was for somewhere else.
        self._forecast = self._forecast_at = None
        self.config_entry.async_create_background_task(
            self.hass, self.async_request_refresh(), name=f"{self.name} moved"
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
        self._stop_following()
        self._stop_following = _nothing_to_stop
        self._stop_follow_timer()
        self._stop_follow_timer = _nothing_to_stop
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
