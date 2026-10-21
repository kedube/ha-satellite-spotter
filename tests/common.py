"""Shared test data and helpers (not collected as tests)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
from typing import Any

from freezegun.api import FrozenDateTimeFactory
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import async_fire_time_changed
from see_a_satellite import Satellite, dump_catalog, parse_site_catalog

from custom_components.satellite_spotter.const import STORAGE_KEY

ROOT = Path(__file__).parents[1]
FIXTURES = Path(__file__).parent / "fixtures"
INTEGRATION = ROOT / "custom_components/satellite_spotter"

# The website's catalog trimmed to 22 satellites that pass the test places
# (from the See A Satellite Tonight integration's tests). Its satellites pass
# Utrecht from 19:08:36 UTC on NOW, the first BlueWalker 3.
NOW = datetime(2026, 10, 10, 19, 5, tzinfo=UTC)
# The Dom Tower in Utrecht: 64 passes in five days, 6 of them bright.
UTRECHT = {CONF_LATITUDE: 52.0907, CONF_LONGITUDE: 5.1214, CONF_ELEVATION: 5.0}
UTRECHT_ID = "52.0907_5.1214"
# Denver: 25 passes, among them three bright ISS passes.
DENVER = {CONF_LATITUDE: 39.74, CONF_LONGITUDE: -104.99, CONF_ELEVATION: 1609.0}
DENVER_ID = "39.7400_-104.9900"
FIRST_PASS = "2026-10-10T19:08:36+00:00"
FIRST_PASS_ID = "53807-1791659316"


def catalog_json() -> list[dict[str, Any]]:
    """The 22-satellite catalog, as the website serves it."""
    return json.loads((FIXTURES / "brightest-sats.json").read_text())


def satellites() -> list[Satellite]:
    """The 22-satellite catalog, parsed."""
    return parse_site_catalog(catalog_json())


def cloud_cover() -> list[tuple[datetime, int]]:
    """Hourly cloud cover from midnight on NOW's day, equal to the hour of the week."""
    start = datetime(2026, 10, 10, tzinfo=UTC).timestamp()
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
            "catalog": dump_catalog(satellites() if catalog is None else catalog),
        },
    }


def aged(catalog: list[Satellite], days: float) -> list[Satellite]:
    """The catalog with every epoch moved back: the same orbits, older elements."""
    for sat in catalog:
        sat.epoch -= timedelta(days=days)
        sat.omm = {**sat.omm, "EPOCH": sat.epoch.strftime("%Y-%m-%dT%H:%M:%S.%f")}
    return catalog


async def advance(hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime) -> None:
    """Move the clock and run what falls due, including background refreshes."""
    freezer.move_to(when)
    async_fire_time_changed(hass, when)
    # Scheduled refreshes and setup retries run as background tasks; without
    # waiting for them the tests race the predictions.
    await hass.async_block_till_done(wait_background_tasks=True)
