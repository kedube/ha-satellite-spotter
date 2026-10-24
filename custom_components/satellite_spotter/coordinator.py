"""Pass predictions for one location."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import partial
import logging
import re
from typing import TYPE_CHECKING, Any, override

from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_point_in_utc_time
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util
from pysatellitespotter import (
    CatalogError,
    CloudCover,
    Satellite,
    Transit,
    TransitGroup,
    cloud_cover_at,
    fetch_cloud_cover,
    group_transits,
    predict_transits,
)

from . import track
from .catalog import CatalogManager
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
    MAX_TRANSITS,
    PASS_ID_TOLERANCE,
    PREDICTION_DAYS,
    PREDICTION_LOOKBACK,
    PREDICTION_REFRESH,
    UPCOMING_WINDOW,
    USER_AGENT,
)

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
class SatellitePass:
    """A visible pass (one satellite, or several close together) with its weather."""

    # f"{primary NORAD id}-{start}", also the calendar event's uid.
    id: str
    group: TransitGroup
    cloud_cover: int | None
    # One per transit (up to MAX_TRANSITS), in the group's order.
    shapes: list[track.TransitShape]
    # The highest point any of the satellites reaches while visible.
    peak: track.SkyPoint

    @property
    def start(self) -> datetime:
        """When the first satellite becomes visible."""
        return self.group.start

    @property
    def end(self) -> datetime:
        """When the last satellite stops being visible."""
        return self.group.end

    @property
    def primary(self) -> Transit:
        """The satellite the pass is named after (the first to appear)."""
        return self.group.primary

    @property
    def bright(self) -> bool:
        """Whether the website labels the pass as bright."""
        return self.group.bright


@dataclass(slots=True)
class SatelliteData:
    """Predicted passes for one location, and what they were predicted from."""

    passes: list[SatellitePass]
    computed_at: datetime
    window_start: datetime
    catalog_version: int
    # The catalog the passes were predicted from, by NORAD id.
    satellites: dict[int, Satellite]
    # Whether a cloud cover forecast was used; None while switched off.
    cloud_cover: bool | None
    by_id: dict[str, SatellitePass] = field(init=False)

    def __post_init__(self) -> None:
        """Index the passes by id."""
        self.by_id = {p.id: p for p in self.passes}

    def current_or_next(
        self, now: datetime, predicate: Callable[[SatellitePass], bool] | None = None
    ) -> SatellitePass | None:
        """Return the pass in progress, or else the next one."""
        for p in self.passes:
            if p.end > now and (predicate is None or predicate(p)):
                return p
        return None

    def current(self, now: datetime) -> SatellitePass | None:
        """Return the pass in progress, if any."""
        p = self.current_or_next(now)
        return p if p is not None and p.start <= now else None

    def upcoming(self, now: datetime, window: timedelta = UPCOMING_WINDOW) -> list[SatellitePass]:
        """Return the passes in progress or starting within the window."""
        horizon = now + window
        return [p for p in self.passes if p.end > now and p.start < horizon]

    def find(self, pass_id: str) -> SatellitePass | None:
        """Return the pass with this id, or the same satellite's pass a moment from it.

        A refresh with newer orbital elements can move a pass by a few
        seconds, which changes its id; a page opened before still finds it.
        """
        if (p := self.by_id.get(pass_id)) is not None:
            return p
        norad_id, _, start = pass_id.rpartition("-")
        try:
            when = dt_util.utc_from_timestamp(int(start))
        except (OverflowError, ValueError, OSError):
            return None
        near = [
            p
            for p in self.passes
            if str(p.primary.satellite.norad_id) == norad_id
            and abs(p.start - when) <= PASS_ID_TOLERANCE
        ]
        return min(near, key=lambda p: abs(p.start - when), default=None)


def pass_id(group: TransitGroup) -> str:
    """Stable id of a pass: its primary satellite and start (whole seconds)."""
    return f"{group.primary.satellite.norad_id}-{int(group.start.timestamp())}"


def predict_passes(
    satellites: Sequence[Satellite],
    observer: track.Observer,
    *,
    start: datetime,
    max_magnitude: float,
    forecast: CloudCover | None,
) -> list[SatellitePass]:
    """Predict the visible passes from start (runs in the executor).

    ``start`` must be a whole minute: the library samples every minute from
    it, so the same start gives the same pass times (and ids) every run.
    """
    transits = predict_transits(
        satellites,
        observer.latitude,
        observer.longitude,
        observer.elevation_m,
        start=start,
        days=PREDICTION_DAYS,
        max_magnitude=max_magnitude,
    )
    passes = []
    for group in group_transits(transits, catalog_size=len(satellites)):
        shapes = [_shape(t, observer) for t in group.transits[:MAX_TRANSITS]]
        passes.append(
            SatellitePass(
                id=pass_id(group),
                group=group,
                cloud_cover=cloud_cover_at(forecast, group.start),
                shapes=shapes,
                peak=max((s.peak for s in shapes), key=lambda p: p.elevation),
            )
        )
    return passes


def _shape(transit: Transit, observer: track.Observer) -> track.TransitShape:
    brightest = track.SkyPoint(
        transit.brightest_time.timestamp(), transit.brightest.azimuth, transit.brightest.elevation
    )
    return track.transit_shape(
        transit.satellite,
        observer,
        transit.start.timestamp(),
        transit.end.timestamp(),
        brightest,
    )


def scrub(err: Exception) -> str:
    """Return an error's text without the query strings of the URLs it names."""
    return _QUERY.sub(r"\1", str(err)) or type(err).__name__


class SatelliteSpotterCoordinator(DataUpdateCoordinator[SatelliteData]):
    """Predicts the visible passes for one location.

    Every two hours, and whenever a new catalog arrives. Between runs, a
    timer wakes the entities at every moment one of them changes state.
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
        self._unsub_boundary: CALLBACK_TYPE | None = None
        self._unsub_catalog = catalog.async_add_listener(self._async_catalog_changed)

    @override
    async def _async_update_data(self) -> SatelliteData:
        self._predicting = True
        try:
            return await self._async_predict()
        finally:
            self._predicting = False

    async def _async_predict(self) -> SatelliteData:
        try:
            satellites = await self.catalog.async_get()
        except CatalogError as err:
            raise UpdateFailed(
                translation_domain=DOMAIN,
                translation_key="catalog_unavailable",
                translation_placeholders={"error": str(err)},
            ) from err
        version, by_id = self.catalog.version, self.catalog.by_id()

        now = dt_util.utcnow()
        age = self.catalog.median_epoch_age(now)
        if age is not None and age > CATALOG_MAX_AGE:
            # The downloads fail, or the website's own catalog is just as old.
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
        ir.async_delete_issue(self.hass, DOMAIN, ISSUE_CATALOG_STALE)

        forecast = await self._async_cloud_cover()
        start = now.replace(second=0, microsecond=0) - PREDICTION_LOOKBACK
        passes = await self.hass.async_add_executor_job(
            partial(
                predict_passes,
                satellites,
                self.observer,
                start=start,
                max_magnitude=self.settings.max_magnitude,
                forecast=forecast,
            )
        )
        data = SatelliteData(
            passes=passes,
            computed_at=now,
            window_start=start,
            catalog_version=version,
            satellites=by_id,
            cloud_cover=None if not self.settings.cloud_cover else forecast is not None,
        )
        self._schedule_boundary(data)
        return data

    async def _async_cloud_cover(self) -> CloudCover | None:
        if not self.settings.cloud_cover:
            return None
        try:
            return await fetch_cloud_cover(
                async_get_clientsession(self.hass),
                self.observer.latitude,
                self.observer.longitude,
                user_agent=USER_AGENT,
            )
        except CatalogError as err:
            # Passes are still predicted, just without the weather.
            _LOGGER.debug("No cloud cover forecast: %s", scrub(err))
            return None

    # -- timers ------------------------------------------------------------

    @callback
    def _schedule_boundary(self, data: SatelliteData) -> None:
        """Wake the entities at the next moment one of them changes state.

        A pass starting, ending, or coming within a day (passes_next_24h), or
        within the advance notice for a bright one (bright_pass_soon).
        """
        self._cancel_boundary()
        now = dt_util.utcnow()
        upcoming: list[datetime] = []
        for p in data.passes:
            times = [p.start - UPCOMING_WINDOW, p.start, p.end]
            if p.bright:
                times.append(p.start - self.settings.alert_lead)
            upcoming += [t for t in times if t > now]
        if upcoming:
            self._unsub_boundary = async_track_point_in_utc_time(
                self.hass, self._async_boundary, min(upcoming) + timedelta(seconds=1)
            )

    @callback
    def _async_boundary(self, _now: datetime) -> None:
        self._unsub_boundary = None
        self.async_update_listeners()
        if self.data is not None:
            self._schedule_boundary(self.data)

    @callback
    def _cancel_boundary(self) -> None:
        if self._unsub_boundary is not None:
            self._unsub_boundary()
            self._unsub_boundary = None

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

    @override
    async def async_shutdown(self) -> None:
        """Stop the timers along with the coordinator."""
        self._cancel_boundary()
        self._unsub_catalog()
        self._unsub_catalog = _noop
        await super().async_shutdown()

    # -- queries used by entities and the websocket API --------------------

    def next_pass(self, now: datetime) -> SatellitePass | None:
        """Return the pass in progress, or else the next one."""
        return None if self.data is None else self.data.current_or_next(now)

    def next_bright_pass(self, now: datetime) -> SatellitePass | None:
        """Return the bright pass in progress, or else the next one."""
        return None if self.data is None else self.data.current_or_next(now, _is_bright)

    def current(self, now: datetime) -> SatellitePass | None:
        """Return the pass in progress, if any."""
        return None if self.data is None else self.data.current(now)

    def bright_pass_soon(self, now: datetime) -> SatellitePass | None:
        """Return the next bright pass from its advance notice until it ends, else None."""
        p = self.next_bright_pass(now)
        return p if p is not None and p.start - self.settings.alert_lead <= now else None

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


def _is_bright(p: SatellitePass) -> bool:
    return p.bright


def _noop() -> None:
    """Nothing to undo."""
