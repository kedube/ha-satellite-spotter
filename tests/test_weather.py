"""The cloud forecast: what Open-Meteo is asked, and what is made of its answer."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
import pytest
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.satellite_spotter.const import PREDICTION_DAYS, USER_AGENT
from custom_components.satellite_spotter.weather import (
    FORECAST_URL,
    CloudCoverError,
    CloudForecast,
    async_fetch_forecast,
)

NOON = datetime(2026, 11, 5, 12, tzinfo=UTC)
HOUR = int(NOON.timestamp())


def test_the_forecast_is_for_the_whole_hour_after_a_moment() -> None:
    forecast = CloudForecast({HOUR: 10, HOUR + 3600: 20})
    assert forecast.after(NOON - timedelta(seconds=1)) == 10
    # On the hour counts as before the next one, not as that hour.
    assert forecast.after(NOON) == 20
    assert forecast.after(NOON + timedelta(minutes=59, seconds=59.5)) == 20
    assert forecast.after(NOON + timedelta(hours=1)) is None


async def test_what_open_meteo_is_asked(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.get(
        FORECAST_URL,
        json={"hourly": {"time": [HOUR, HOUR + 3600, HOUR + 7200], "cloud_cover": [5, None, 100]}},
    )
    forecast = await async_fetch_forecast(async_get_clientsession(hass), -41.286460, 174.776236)
    # An hour left blank is an hour without a forecast.
    assert forecast.percent_by_hour == {HOUR: 5, HOUR + 7200: 100}

    ((_, url, _, headers),) = aioclient_mock.mock_calls
    assert dict(url.query) == {
        # The position to about 10 m, as the README says.
        "latitude": "-41.2865",
        "longitude": "174.7762",
        "hourly": "cloud_cover",
        # Up to the hour after the last pass that can be predicted, and no further.
        "forecast_hours": str(PREDICTION_DAYS * 24 + 2),
        "timeformat": "unixtime",
    }
    assert headers["User-Agent"] == USER_AGENT


@pytest.mark.parametrize(
    "answer",
    [
        {"status": 500},
        {"exc": TimeoutError()},
        {"text": "not a forecast"},
        {"json": {"error": True, "reason": "Too many requests"}},
        {"json": {"hourly": {"time": [HOUR]}}},
        {"json": {"hourly": {"time": [HOUR], "cloud_cover": [5, 6]}}},
        {"json": {"hourly": {"time": [HOUR], "cloud_cover": ["some"]}}},
        {"json": ["not", "a", "mapping"]},
    ],
)
async def test_anything_else_is_no_forecast(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, answer: dict[str, Any]
) -> None:
    aioclient_mock.get(FORECAST_URL, **answer)
    with pytest.raises(CloudCoverError):
        await async_fetch_forecast(async_get_clientsession(hass), -41.29, 174.78)
