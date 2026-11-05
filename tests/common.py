"""Shared test data and helpers (not collected as tests)."""

from __future__ import annotations

import csv
from datetime import UTC, datetime, timedelta
import io
import json
from pathlib import Path
from typing import Any

from freezegun.api import FrozenDateTimeFactory
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from custom_components.satellite_spotter.const import STORAGE_KEY
from custom_components.satellite_spotter.predict import Satellite, read_catalog, write_catalog

ROOT = Path(__file__).parents[1]
FIXTURES = Path(__file__).parent / "fixtures"
INTEGRATION = ROOT / "custom_components/satellite_spotter"

# A small catalog: CelesTrak's elements of 22 objects, as read on 2026-11-04, with
# magnitudes that are test values and do not follow brightness.csv, so a rebuilt table
# does not move these tests.
CATALOG_FILE = FIXTURES / "catalog.json"
NOW = datetime(2026, 11, 4, 15, 30, tzinfo=UTC)
# 28 passes in five days, 10 of them bright, and a bright one first.
HONOLULU = {CONF_LATITUDE: 21.3069, CONF_LONGITUDE: -157.8583, CONF_ELEVATION: 5.0}
HONOLULU_ID = "21.3069_-157.8583"
# 29 passes, 8 of them bright, and the first not until the next day.
DENVER = {CONF_LATITUDE: 39.74, CONF_LONGITUDE: -104.99, CONF_ELEVATION: 1609.0}
DENVER_ID = "39.7400_-104.9900"
FIRST_PASS = "2026-11-04T15:33:28+00:00"
FIRST_PASS_ID = "53807-1793806408"


def catalog_json() -> list[dict[str, Any]]:
    """The test catalog, as it is stored."""
    return json.loads(CATALOG_FILE.read_text())


def satellites() -> list[Satellite]:
    """The test catalog, read."""
    return read_catalog(catalog_json())


# CelesTrak's columns, in its order.
GP_COLUMNS = (
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


def gp_csv(entries: list[dict[str, Any]]) -> str:
    """Orbital data as CelesTrak answers it when asked for CSV."""
    out = io.StringIO()
    writer = csv.DictWriter(out, GP_COLUMNS, extrasaction="ignore", restval="0")
    writer.writeheader()
    writer.writerows(entries)
    return out.getvalue()


async def add_location(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """Add a location to Home Assistant, and wait until it has settled."""
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


def cloud_cover() -> list[tuple[datetime, int]]:
    """Hourly cloud cover from midnight on NOW's day, equal to the hour of the week."""
    start = datetime(2026, 11, 4, tzinfo=UTC).timestamp()
    return [(datetime.fromtimestamp(start + 3600 * i, UTC), i % 100) for i in range(168)]


def store_catalog(
    hass_storage: dict[str, Any], updated: datetime, catalog: list[Satellite] | None = None
) -> None:
    """Leave a catalog in Home Assistant's storage, as a previous run would have."""
    hass_storage[STORAGE_KEY] = {
        "version": 1,
        "key": STORAGE_KEY,
        "data": {
            "updated": updated.isoformat(),
            "catalog": write_catalog(satellites() if catalog is None else catalog),
        },
    }


def aged(catalog: list[Satellite], days: float) -> list[Satellite]:
    """The catalog with every epoch moved back: the same orbits, older elements."""
    for sat in catalog:
        sat.epoch -= timedelta(days=days)
        sat.elements = {**sat.elements, "EPOCH": sat.epoch.strftime("%Y-%m-%dT%H:%M:%S.%f")}
    return catalog


async def advance(hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime) -> None:
    """Move the clock and run what falls due, including background refreshes."""
    freezer.move_to(when)
    async_fire_time_changed(hass, when)
    # Scheduled refreshes and setup retries run as background tasks; without
    # waiting for them the tests race the predictions.
    await hass.async_block_till_done(wait_background_tasks=True)
