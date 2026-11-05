"""Pass predictions for one location."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import partial
import logging
from operator import attrgetter
import re
from typing import TYPE_CHECKING, Any, override

from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
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
    CONF_CLOUD_COVER,
    CONF_MAX_MAGNITUDE,
    CONF_SHOW_CALENDAR,
    CONF_UNITS,
    DEFAULT_ALERT_LEAD_MINUTES,
    DEFAULT_CLOUD_COVER,
    DEFAULT_MAX_MAGNITUDE,
    DEFAULT_SHOW_CALENDAR,
    DEFAULT_UNITS,
    DOMAIN,
    ISSUE_CATALOG_STALE,
    MAX_SIGHTINGS,
    PASS_ID_TOLERANCE,
    PREDICTION_DAYS,
    PREDICTION_LOOKBACK,
    PREDICTION_REFRESH,
    UPCOMING_WINDOW,
)
from .predict import Flyover, Satellite, Sighting, find_sightings, group_sightings
from .weather import CloudCoverError, CloudForecast, async_fetch_forecast

if TYPE_CHECKING:
    from . import SatelliteSpotterConfigEntry

_LOGGER = logging.getLogger(__name__)

# Errors from the cloud cover request name its URL, the location's
# coordinates included.
_QUERY = re.compile(r"(https?://[^\s?'\"]+)\?[^\s'\"]*")


@dataclass(frozen=True, slots=True)
class PredictionSettings:
    """User-tunable settings, from the options flow."""

    max_magnitude: float
    cloud_cover: bool
    alert_lead: timedelta
    show_in_calendar: bool
    units: str

    @classmethod
    def from_options(cls, options: dict[str, Any]) -> PredictionSettings:
        """Build settings, filling in defaults."""
        return cls(
            max_magnitude=float(options.get(CONF_MAX_MAGNITUDE, DEFAULT_MAX_MAGNITUDE)),
            cloud_cover=bool(options.get(CONF_CLOUD_COVER, DEFAULT_CLOUD_COVER)),
            alert_lead=timedelta(
                minutes=float(options.get(CONF_ALERT_LEAD_MINUTES, DEFAULT_ALERT_LEAD_MINUTES))
            ),
            show_in_calendar=bool(options.get(CONF_SHOW_CALENDAR, DEFAULT_SHOW_CALENDAR)),
            units=str(options.get(CONF_UNITS, DEFAULT_UNITS)),
        )


@dataclass(slots=True)
class ListedPass(Flyover):
    """A flyover as a location lists it, with its id, its weather and how it looks."""

    # f"{lead NORAD id}-{start}", also the calendar event's uid.
    id: str
    cloud_cover: int | None
    # One per sighting (up to MAX_SIGHTINGS), in the flyover's order.
    shapes: list[track.SightingShape]
    # The highest point any of the satellites reaches while visible.
    peak: track.SkyPoint

    def notice_at(self, alert_lead: timedelta) -> datetime:
        """Return when a bright pass's advance notice starts.

        Counted from the satellite that makes it bright: a big group can start long before.
        """
        return self.lead.appears.time - alert_lead


@dataclass(slots=True)
class Predictions:
    """The passes listed for one location, and what they were predicted from."""

    passes: list[ListedPass]
    computed_at: datetime
    catalog_version: int
    # The catalog the passes were predicted from, by NORAD id.
    satellites: dict[int, Satellite]
    # Whether a cloud cover forecast was used; None while switched off.
    cloud_cover: bool | None
    by_id: dict[str, ListedPass] = field(init=False)

    def __post_init__(self) -> None:
        """Index the passes by id."""
        self.by_id = {p.id: p for p in self.passes}

    def _not_over(self, now: datetime) -> Iterator[ListedPass]:
        """Yield the passes that are not over yet, earliest first."""
        return (p for p in self.passes if p.end > now)

    def next_pass(self, now: datetime) -> ListedPass | None:
        """Return the pass under way, or else the next to come."""
        return next(self._not_over(now), None)

    def next_bright_pass(self, now: datetime) -> ListedPass | None:
        """Return the bright pass under way, or else the next to come."""
        return next((p for p in self._not_over(now) if p.bright), None)

    def under_way(self, now: datetime) -> ListedPass | None:
        """Return the pass under way, if there is one."""
        return next((p for p in self._not_over(now) if p.start <= now), None)

    def upcoming(self, now: datetime, window: timedelta = UPCOMING_WINDOW) -> list[ListedPass]:
        """Return the passes under way or starting within the window."""
        horizon = now + window
        return [p for p in self._not_over(now) if p.start < horizon]

    def next_change(self, now: datetime, alert_lead: timedelta) -> datetime | None:
        """Return the next moment an entity's state changes, if there is one.

        A pass starting, ending, or coming within a day (passes_next_24h), or
        within the advance notice for a bright one (bright_pass_soon).
        """
        moments = [
            moment
            for p in self.passes
            for moment in (
                p.start - UPCOMING_WINDOW,
                p.start,
                p.end,
                *((p.notice_at(alert_lead),) if p.bright else ()),
            )
        ]
        return min((moment for moment in moments if moment > now), default=None)

    def find(self, pass_id: str) -> ListedPass | None:
        """Return the pass with this id, or a pass a moment from it with that satellite in it.

        A refresh with newer orbital elements can move a pass by a few seconds, or
        change which of its satellites is brightest, and either changes its id; a page
        opened before still finds it.
        """
        if (found := self.by_id.get(pass_id)) is not None:
            return found
        norad_id, _, start = pass_id.rpartition("-")
        try:
            when = dt_util.utc_from_timestamp(int(start))
        except (OverflowError, ValueError, OSError):
            return None
        near = [
            p
            for p in self.passes
            if abs(p.start - when) <= PASS_ID_TOLERANCE
            and any(str(s.satellite.norad_id) == norad_id for s in p.sightings)
        ]
        return min(near, key=lambda p: abs(p.start - when), default=None)


def predict_passes(
    satellites: Sequence[Satellite],
    observer: track.Observer,
    *,
    start: datetime,
    faintest: float,
    forecast: CloudForecast | None,
) -> list[ListedPass]:
    """List the passes a place can see from a moment on (runs in the executor)."""
    found = find_sightings(
        satellites, observer, start=start, days=PREDICTION_DAYS, faintest=faintest
    )
    return [_listed(flyover, observer, forecast) for flyover in group_sightings(found)]


def _listed(
    flyover: Flyover, observer: track.Observer, forecast: CloudForecast | None
) -> ListedPass:
    shapes = [_shape(sighting, observer) for sighting in flyover.sightings[:MAX_SIGHTINGS]]
    return ListedPass(
        flyover.sightings,
        id=f"{flyover.lead.satellite.norad_id}-{int(flyover.start.timestamp())}",
        cloud_cover=None if forecast is None else forecast.after(flyover.start),
        shapes=shapes,
        peak=max((shape.peak for shape in shapes), key=attrgetter("elevation")),
    )


def _shape(sighting: Sighting, observer: track.Observer) -> track.SightingShape:
    best = sighting.brightest
    return track.sighting_shape(
        sighting.satellite,
        observer,
        sighting.appears.time.timestamp(),
        sighting.vanishes.time.timestamp(),
        track.SkyPoint(best.time.timestamp(), best.azimuth, best.elevation),
    )


def scrub(err: Exception) -> str:
    """Return an error's text without the query strings of the URLs it names."""
    return _QUERY.sub(r"\1", str(err)) or type(err).__name__


def _nothing_to_stop() -> None:
    """Stand in for a timer or a subscription that is not running."""


class SatelliteSpotterCoordinator(DataUpdateCoordinator[Predictions]):
    """Keeps one location's predictions current, and its entities with them.

    It predicts every two hours, and whenever a new catalog arrives. In between, a
    timer wakes the entities at each moment one of them changes state.
    """

    config_entry: SatelliteSpotterConfigEntry

    def __init__(
        self, hass: HomeAssistant, entry: SatelliteSpotterConfigEntry, catalog: CatalogManager
    ) -> None:
        """Initialise the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=f"{DOMAIN} {entry.title}",
            update_interval=PREDICTION_REFRESH,
        )
        self.catalog = catalog
        self.observer = track.Observer(
            float(entry.data[CONF_LATITUDE]),
            float(entry.data[CONF_LONGITUDE]),
            float(entry.data.get(CONF_ELEVATION, 0.0)),
        )
        self.settings = PredictionSettings.from_options(dict(entry.options))
        self._predicting = False
        self._stop_waiting: CALLBACK_TYPE = _nothing_to_stop
        self._stop_following_catalog = catalog.async_add_listener(self._async_catalog_changed)

    # -- predicting --------------------------------------------------------

    @override
    async def _async_update_data(self) -> Predictions:
        self._predicting = True
        try:
            return await self._async_predict()
        finally:
            self._predicting = False

    async def _async_predict(self) -> Predictions:
        satellites = await self._async_catalog_or_fail()
        version, by_id = self.catalog.version, self.catalog.by_id()
        now = dt_util.utcnow()
        self._fail_if_orbits_are_stale(now)

        forecast = await self._async_forecast()
        start = now.replace(second=0, microsecond=0) - PREDICTION_LOOKBACK
        passes = await self.hass.async_add_executor_job(
            partial(
                predict_passes,
                satellites,
                self.observer,
                start=start,
                faintest=self.settings.max_magnitude,
                forecast=forecast,
            )
        )
        predictions = Predictions(
            passes=passes,
            computed_at=now,
            catalog_version=version,
            satellites=by_id,
            cloud_cover=None if not self.settings.cloud_cover else forecast is not None,
        )
        self._wait_for_next_change(predictions)
        return predictions

    async def _async_catalog_or_fail(self) -> list[Satellite]:
        try:
            return await self.catalog.async_satellites()
        except CatalogError as err:
            raise UpdateFailed(
                translation_domain=DOMAIN,
                translation_key="catalog_unavailable",
                translation_placeholders={"error": str(err)},
            ) from err

    def _fail_if_orbits_are_stale(self, now: datetime) -> None:
        """Raise a repair issue and fail the update, or clear the issue if all is well."""
        age = self.catalog.median_epoch_age(now)
        if age is None or age <= CATALOG_MAX_AGE:
            ir.async_delete_issue(self.hass, DOMAIN, ISSUE_CATALOG_STALE)
            return
        # The downloads fail, or CelesTrak's own data is just as old.
        placeholders = {"age": str(age.days)}
        if error := self.catalog.last_error:
            key = ISSUE_CATALOG_STALE
            placeholders["error"] = error
        else:
            key = CATALOG_STALE_UPSTREAM
        # One issue for every location: they all share the catalog.
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
            translation_domain=DOMAIN,
            translation_key=key,
            translation_placeholders=placeholders,
            # When the catalog may download again (it waits only this long
            # while its orbit data is too old to use), not two hours on. A
            # second more, as Home Assistant rounds its loop clock down and
            # can wake a refresh up to a second early, before the back-off
            # ends, which would skip the download and wait five minutes more.
            retry_after=CATALOG_UNREACHABLE_RETRY.total_seconds() + 1,
        )

    async def _async_forecast(self) -> CloudForecast | None:
        """Return the cloud forecast if it is wanted and can be had: passes do without it."""
        if not self.settings.cloud_cover:
            return None
        session = async_get_clientsession(self.hass)
        try:
            return await async_fetch_forecast(
                session, self.observer.latitude, self.observer.longitude
            )
        except CloudCoverError as err:
            _LOGGER.debug("No cloud cover forecast: %s", scrub(err))
            return None

    @callback
    def _async_catalog_changed(self) -> None:
        """Predict again from a catalog another location (or the config flow) downloaded.

        So every location, and the globe's cloud of satellites, use the same one.
        """
        if (
            self._predicting
            or self.data is None
            or self.data.catalog_version == self.catalog.version
        ):
            return
        self.config_entry.async_create_background_task(
            self.hass, self.async_request_refresh(), f"{DOMAIN} predictions from a new catalog"
        )

    # -- keeping the entities up to the moment -----------------------------

    @callback
    def _wait_for_next_change(self, predictions: Predictions) -> None:
        self._stop_waiting()
        self._stop_waiting = _nothing_to_stop
        change = predictions.next_change(dt_util.utcnow(), self.settings.alert_lead)
        if change is not None:
            self._stop_waiting = async_track_point_in_utc_time(
                self.hass, self._async_change_due, change + timedelta(seconds=1)
            )

    @callback
    def _async_change_due(self, _now: datetime) -> None:
        self._stop_waiting = _nothing_to_stop
        self.async_update_listeners()
        if self.data is not None:
            self._wait_for_next_change(self.data)

    @override
    async def async_shutdown(self) -> None:
        """Stop the timer, and following the catalog, along with the coordinator."""
        self._stop_waiting()
        self._stop_waiting = _nothing_to_stop
        self._stop_following_catalog()
        self._stop_following_catalog = _nothing_to_stop
        await super().async_shutdown()

    # -- what entities and the websocket API ask ---------------------------

    def next_pass(self, now: datetime) -> ListedPass | None:
        """Return the pass under way, or else the next to come."""
        return None if self.data is None else self.data.next_pass(now)

    def next_bright_pass(self, now: datetime) -> ListedPass | None:
        """Return the bright pass under way, or else the next to come."""
        return None if self.data is None else self.data.next_bright_pass(now)

    def pass_under_way(self, now: datetime) -> ListedPass | None:
        """Return the pass under way, if there is one."""
        return None if self.data is None else self.data.under_way(now)

    def bright_pass_soon(self, now: datetime) -> ListedPass | None:
        """Return the next bright pass from its advance notice until it ends, else None."""
        coming = self.next_bright_pass(now)
        return coming if coming and coming.notice_at(self.settings.alert_lead) <= now else None

    def paused_reason(self, now: datetime) -> str | None:
        """Why predictions are paused, or None while they can be trusted.

        This mirrors the entities, which go unavailable at the same time. Only
        a loaded location has a coordinator to ask, so there are predictions.
        """
        if not self.last_update_success:
            return str(self.last_exception or "Predictions could not be updated")
        if (age := self.stale_age(now)) is not None:
            return f"Orbit data is {age.days} days old"
        return None

    def stale_age(self, now: datetime) -> timedelta | None:
        """Return the catalog's median element age when beyond the limit, else None."""
        age = self.catalog.median_epoch_age(now)
        return age if age is not None and age > CATALOG_MAX_AGE else None
