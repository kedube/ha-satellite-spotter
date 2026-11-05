"""From the web's answers to the entities, with nothing inside the integration replaced."""

from __future__ import annotations

from datetime import UTC, datetime

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.satellite_spotter.celestrak import (
    GP_URL,
    QUERIES,
    SUPPLEMENTAL_QUERY,
    SUPPLEMENTAL_URL,
)
from custom_components.satellite_spotter.weather import FORECAST_URL

from .common import FIRST_PASS_ID, NOW, add_location, gp_csv, satellites

_HOUR_S = 3600


async def test_a_location_runs_on_what_celestrak_and_open_meteo_answer(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, freezer: FrozenDateTimeFactory
) -> None:
    freezer.move_to(NOW)
    catalog = gp_csv(sat.elements for sat in satellites())
    for query in QUERIES:
        aioclient_mock.get(GP_URL, params={**query, "FORMAT": "csv"}, text=catalog)
    aioclient_mock.get(
        SUPPLEMENTAL_URL, params={**SUPPLEMENTAL_QUERY, "FORMAT": "csv"}, text=gp_csv([])
    )
    this_hour = int(NOW.timestamp()) // _HOUR_S * _HOUR_S
    aioclient_mock.get(
        FORECAST_URL,
        json={
            "hourly": {
                "time": [this_hour + i * _HOUR_S for i in range(168)],
                "cloud_cover": [i % 100 for i in range(168)],
            }
        },
    )

    entry = await add_location(hass)

    assert entry.state is ConfigEntryState.LOADED
    # The fixture was built from these answers and this table, so the prediction is the same.
    upcoming = hass.states.get("sensor.home_next_visible_pass")
    assert upcoming is not None
    assert upcoming.state == datetime.fromtimestamp(int(FIRST_PASS_ID), UTC).isoformat()
    # The first pass begins in this hour, and the forecast for the next is the second value.
    assert upcoming.attributes["cloud_cover"] == 1

    # Each query once, and the integration says who is asking every time.
    assert aioclient_mock.call_count == len(QUERIES) + 2
    for _method, url, _data, headers in aioclient_mock.mock_calls:
        assert headers["User-Agent"].startswith("HomeAssistant-SatelliteSpotter/"), url
        assert "github.com/kedube/ha-satellite-spotter" in headers["User-Agent"], url
