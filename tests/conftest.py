"""Shared fixtures."""

from __future__ import annotations

from collections.abc import Generator
from datetime import datetime
import json
from typing import Any
from unittest.mock import AsyncMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.predict import Satellite

from .common import FIXTURES, HONOLULU, HONOLULU_ID, NOW, add_location, cloud_cover, satellites

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
    """The test catalog."""
    return satellites()


@pytest.fixture
def mock_downloads(catalog: list[Satellite]) -> Generator[dict[str, AsyncMock]]:
    """Mock what goes over the network (the catalog and the cloud cover forecast)."""
    with (
        patch(
            "custom_components.satellite_spotter.catalog.async_fetch_catalog",
            return_value=catalog,
        ) as fetch_catalog,
        patch(
            "custom_components.satellite_spotter.coordinator.async_fetch_forecast",
            return_value=cloud_cover(),
        ) as fetch_forecast,
    ):
        yield {"fetch_catalog": fetch_catalog, "fetch_forecast": fetch_forecast}


@pytest.fixture
def mock_setup_entry() -> Generator[AsyncMock]:
    """Mock setting up a config entry."""
    with patch("custom_components.satellite_spotter.async_setup_entry", return_value=True) as mock:
        yield mock


@pytest.fixture
def mock_config_entry() -> MockConfigEntry:
    """The test location."""
    return MockConfigEntry(domain=DOMAIN, title="Home", unique_id=HONOLULU_ID, data=HONOLULU)


@pytest.fixture
def now() -> datetime:
    """When the tests start, minutes before the first pass."""
    return NOW


@pytest.fixture
async def init_integration(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_downloads: dict[str, AsyncMock],
) -> MockConfigEntry:
    """The test location, running from NOW."""
    freezer.move_to(NOW)
    await add_location(hass, mock_config_entry)
    return mock_config_entry
