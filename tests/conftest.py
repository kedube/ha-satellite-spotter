"""The fixtures every test module can use."""

from __future__ import annotations

from collections.abc import Iterator
import csv
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.predict import Satellite

from .common import HONOLULU, NOW, cloud_forecast, forecast_of, satellites

pytest_plugins = "pytest_homeassistant_custom_component"

_REFERENCE = Path(__file__).parent / "fixtures" / "skyfield_reference.json"


@pytest.fixture(autouse=True)
def _enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Let Home Assistant find the integration, in every test."""


@pytest.fixture(autouse=True)
def _storage_in_memory(hass_storage: dict[str, Any]) -> None:
    """Keep what Home Assistant stores in memory, for every test."""


@pytest.fixture
def usual_csv_limit() -> Iterator[None]:
    """Put the csv module's limit back to its default: scripts the tests load can raise it."""
    before = csv.field_size_limit(131072)
    yield
    csv.field_size_limit(before)


@pytest.fixture
def catalog() -> list[Satellite]:
    """Return a fresh copy of the fixture's satellites."""
    return satellites()


@pytest.fixture(scope="session")
def reference() -> Any:
    """Return the Skyfield reference positions; the file is read only if a test asks for it."""
    return json.loads(_REFERENCE.read_text(encoding="utf-8"))


@pytest.fixture
def mock_downloads(catalog: list[Satellite]) -> Iterator[dict[str, AsyncMock]]:
    """Answer the downloads without a network: see ``common.cloud_percent`` for the clouds."""
    with (
        patch(
            "custom_components.satellite_spotter.catalog.async_fetch_catalog",
            AsyncMock(return_value=catalog),
        ) as fetch_catalog,
        patch(
            "custom_components.satellite_spotter.coordinator.async_fetch_forecast",
            AsyncMock(return_value=cloud_forecast()),
        ) as fetch_forecast,
    ):
        yield {"fetch_catalog": fetch_catalog, "fetch_forecast": fetch_forecast}


@pytest.fixture
def predict_passes(mock_downloads: dict[str, AsyncMock]) -> Iterator[MagicMock]:
    """Replace the search for passes: set ``return_value`` to the passes a test wants.

    The forecast then agrees with their cloud cover, as each refresh applies it to them again.
    """
    with patch(
        "custom_components.satellite_spotter.coordinator.predict_passes",
        MagicMock(return_value=[]),
    ) as mock:
        mock_downloads["fetch_forecast"].side_effect = lambda *_: forecast_of(mock.return_value)
        yield mock


@pytest.fixture
async def init_integration(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
) -> MockConfigEntry:
    """Set up one location, Home in Honolulu, with the clock at NOW."""
    freezer.move_to(NOW)
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
