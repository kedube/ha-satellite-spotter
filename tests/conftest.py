"""Shared fixtures."""

from __future__ import annotations

from collections.abc import Generator
from datetime import datetime
import json
from typing import Any
from unittest.mock import AsyncMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
from pysatellitespotter import Satellite
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.const import DOMAIN

from .common import FIXTURES, NOW, UTRECHT, UTRECHT_ID, cloud_cover, satellites

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Allow Home Assistant to load the integration in every test."""


@pytest.fixture(scope="session")
def reference() -> dict[str, Any]:
    """Skyfield's look angles and sub-points for the ISS (scripts/validate_against_skyfield.py)."""
    return json.loads((FIXTURES / "skyfield_reference.json").read_text())


@pytest.fixture
def catalog() -> list[Satellite]:
    """The 22-satellite test catalog."""
    return satellites()


@pytest.fixture
def mock_pysatellitespotter(catalog: list[Satellite]) -> Generator[dict[str, AsyncMock]]:
    """Mock the library's network calls (the catalog and the cloud cover forecast)."""
    with (
        patch(
            "custom_components.satellite_spotter.catalog.fetch_site_catalog",
            return_value=catalog,
        ) as fetch_site_catalog,
        patch(
            "custom_components.satellite_spotter.coordinator.fetch_cloud_cover",
            return_value=cloud_cover(),
        ) as fetch_cloud_cover,
    ):
        yield {"fetch_site_catalog": fetch_site_catalog, "fetch_cloud_cover": fetch_cloud_cover}


@pytest.fixture
def mock_setup_entry() -> Generator[AsyncMock]:
    """Mock setting up a config entry."""
    with patch("custom_components.satellite_spotter.async_setup_entry", return_value=True) as mock:
        yield mock


@pytest.fixture
def mock_config_entry() -> MockConfigEntry:
    """A test location: the Dom Tower in Utrecht."""
    return MockConfigEntry(domain=DOMAIN, title="Home", unique_id=UTRECHT_ID, data=UTRECHT)


@pytest.fixture
def now() -> datetime:
    """When the tests start (the fixture catalog's first pass is minutes away)."""
    return NOW


@pytest.fixture
async def init_integration(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_pysatellitespotter: dict[str, AsyncMock],
) -> MockConfigEntry:
    """Set up the Utrecht location at NOW."""
    freezer.move_to(NOW)
    mock_config_entry.add_to_hass(hass)
    await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done()
    return mock_config_entry
