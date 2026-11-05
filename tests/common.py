"""What the tests share: the places, the moment, the catalog and a way to move the clock."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
import csv
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from functools import lru_cache
import io
import json
from pathlib import Path
from typing import Any

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryDisabler, ConfigEntryState
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
)

from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.coordinator import ListedPass
from custom_components.satellite_spotter.predict import (
    Flyover,
    Moment,
    Satellite,
    Sighting,
    read_catalog,
)
from custom_components.satellite_spotter.track import SightingShape, SkyPoint
from custom_components.satellite_spotter.weather import CloudForecast

ROOT = Path(__file__).resolve().parent.parent
INTEGRATION = ROOT / "custom_components" / "satellite_spotter"
_CATALOG_FIXTURE = Path(__file__).parent / "fixtures" / "catalog.json"

# The fixture's orbital elements date from just before this.
NOW = datetime(2026, 11, 4, 15, 30, tzinfo=UTC)

HONOLULU = {CONF_LATITUDE: 21.3069, CONF_LONGITUDE: -157.8583, CONF_ELEVATION: 5.0}
DENVER = {CONF_LATITUDE: 39.74, CONF_LONGITUDE: -104.99, CONF_ELEVATION: 1609.0}

# The first pass predicted for HONOLULU from NOW with the default settings: the moment it begins,
# as Unix seconds. test_shared_helpers.py checks this against a fresh prediction.
FIRST_PASS_ID = "1793806752"

# The columns of CelesTrak's CSV answers, in its order.
_GP_COLUMNS = (
    "OBJECT_NAME",
    "OBJECT_ID",
    "EPOCH",
    "MEAN_MOTION",
    "ECCENTRICITY",
    "INCLINATION",
    "RA_OF_ASC_NODE",
    "ARG_OF_PERICENTER",
    "MEAN_ANOMALY",
    "EPHEMERIS_TYPE",
    "CLASSIFICATION_TYPE",
    "NORAD_CAT_ID",
    "ELEMENT_SET_NO",
    "REV_AT_EPOCH",
    "BSTAR",
    "MEAN_MOTION_DOT",
    "MEAN_MOTION_DDOT",
)

_HOUR_S = 3600
# The mocked cloud forecast covers these hours, either side of NOW: the five days predicted, and
# room for tests that let the clock run on past a refresh or two.
_FORECAST_FROM = NOW - timedelta(days=1)
_FORECAST_TO = NOW + timedelta(days=8)


def satellites() -> list[Satellite]:
    """Return a fresh list of the fixture's satellites."""
    return read_catalog(json.loads(_CATALOG_FIXTURE.read_text(encoding="utf-8")))


@lru_cache(maxsize=1)
def _iss_elements() -> Mapping[str, str]:
    return next(sat.elements for sat in satellites() if sat.norad_id == 25544)


def gp_csv(entries: Iterable[Mapping[str, Any]]) -> str:
    """Return the CSV CelesTrak answers with: a lacking field is 0, one beyond the set ignored."""
    out = io.StringIO()
    writer = csv.DictWriter(
        out, _GP_COLUMNS, restval="0", extrasaction="ignore", lineterminator="\n"
    )
    writer.writeheader()
    writer.writerows(entries)
    return out.getvalue()


def cloud_percent(hour: int) -> int:
    """Return the mocked forecast's value for the hour labelled with these Unix seconds.

    It is the number of hours since the Unix epoch, modulo 101: a value that differs from each
    hour to the next, and runs through 0 to 100.
    """
    return hour // _HOUR_S % 101


def cloud_forecast() -> CloudForecast:
    """Return the mocked forecast: ``cloud_percent`` for every hour around NOW."""
    first = int(_FORECAST_FROM.timestamp()) // _HOUR_S * _HOUR_S
    last = int(_FORECAST_TO.timestamp())
    return CloudForecast({hour: cloud_percent(hour) for hour in range(first, last, _HOUR_S)})


def forecast_of(passes: Iterable[ListedPass]) -> CloudForecast:
    """Return the forecast that gives these passes the cloud cover they already have."""
    return CloudForecast(
        {
            (int(p.start.timestamp()) // _HOUR_S + 1) * _HOUR_S: p.cloud_cover
            for p in passes
            if p.cloud_cover is not None
        }
    )


async def set_options(
    hass: HomeAssistant, entry: MockConfigEntry, options: Mapping[str, Any]
) -> None:
    """Change a location's options and reload it, as the options form does."""
    hass.config_entries.async_update_entry(entry, options=dict(options))
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()


async def advance(hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime) -> None:
    """Move the frozen clock to ``when``, and run everything that has fallen due, to the end."""
    freezer.move_to(when)
    # Twice, as what runs the first time can set a timer for this very moment.
    for _ in range(2):
        async_fire_time_changed(hass, when)
        await hass.async_block_till_done(wait_background_tasks=True)


async def add_location(
    hass: HomeAssistant,
    data: Mapping[str, float] = HONOLULU,
    *,
    title: str = "Home",
    options: Mapping[str, Any] | None = None,
    disabled_by: ConfigEntryDisabler | None = None,
    unique_id: str | None = None,
) -> MockConfigEntry:
    """Add a location to Home Assistant and set it up, unless it is disabled."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        title=title,
        data=dict(data),
        options=dict(options or {}),
        disabled_by=disabled_by,
        unique_id=unique_id,
    )
    entry.add_to_hass(hass)
    if disabled_by is None and entry.state is ConfigEntryState.NOT_LOADED:
        await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def with_epoch(sat: Satellite, epoch: datetime) -> Satellite:
    """Return the satellite with its elements dated at a moment, also in their stored form."""
    return replace(sat, epoch=epoch, elements={**sat.elements, "EPOCH": epoch.isoformat()})


def aged(catalog: Iterable[Satellite], by: timedelta) -> list[Satellite]:
    """Return the satellites with their elements' dates moved on (or back) by a time."""
    return [with_epoch(sat, sat.epoch + by) for sat in catalog]


def made_up_satellite(
    name: str = "ISS",
    norad_id: int = 25544,
    *,
    epoch: datetime = NOW - timedelta(days=1),
    standard_magnitude: float | None = -1.0,
) -> Satellite:
    """Return a satellite by name and number, on the ISS's orbit."""
    return Satellite(norad_id, name, standard_magnitude, None, _iss_elements(), epoch)


def sighting(
    start: datetime,
    seconds: float = 300,
    *,
    name: str = "ISS",
    norad_id: int = 25544,
    peak_magnitude: float = -2.0,
    sky_limit: float = 4.0,
    sun_up: bool = False,
    appears: tuple[float, float] = (270.0, 21.0),
    best_view: tuple[float, float] = (315.0, 40.0),
    disappears: tuple[float, float] = (45.0, 10.0),
    epoch: datetime = NOW - timedelta(days=1),
) -> Sighting:
    """Return a sighting, by default of something bright: azimuths and elevations in degrees."""
    end = start + timedelta(seconds=seconds)
    return Sighting(
        satellite=made_up_satellite(name, norad_id, epoch=epoch),
        appears=Moment(start, *appears),
        brightest=Moment(start + (end - start) / 2, *best_view),
        vanishes=Moment(end, *disappears),
        peak_magnitude=peak_magnitude,
        sky_limit=sky_limit,
        sun_up=sun_up,
    )


def listed(
    *sightings: Sighting,
    cloud_cover: int | None = None,
    reasons: tuple[str, str] = ("rise", "set"),
) -> ListedPass:
    """Return the pass made of these sightings: each is highest where it is brightest."""
    flyover = Flyover(list(sightings))
    shapes = [
        SightingShape(
            SkyPoint(
                sighting.brightest.time.timestamp(),
                sighting.brightest.azimuth,
                sighting.brightest.elevation,
            ),
            *reasons,
        )
        for sighting in flyover.sightings
    ]
    return ListedPass(
        flyover.sightings,
        id=str(int(flyover.start.timestamp())),
        cloud_cover=cloud_cover,
        shapes=shapes,
        peak=max((shape.peak for shape in shapes), key=lambda peak: peak.elevation),
    )


def bright_pass(
    start: datetime, seconds: float = 300, *, cloud_cover: int | None = None, **more: Any
) -> ListedPass:
    """Return a pass of one satellite that counts as bright: below 0.5, 3 clear of the sky."""
    return listed(sighting(start, seconds, **more), cloud_cover=cloud_cover)


def dim_pass(
    start: datetime, seconds: float = 300, *, cloud_cover: int | None = None, **more: Any
) -> ListedPass:
    """Return a pass of one satellite too faint to count as bright."""
    more.setdefault("peak_magnitude", 1.5)
    return listed(sighting(start, seconds, **more), cloud_cover=cloud_cover)
