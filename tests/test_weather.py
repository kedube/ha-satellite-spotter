"""The cloud forecast: what Open-Meteo is asked, and what is made of its answer."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
import pytest
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.satellite_spotter.const import PREDICTION_DAYS, USER_AGENT
from custom_components.satellite_spotter.weather import (
    FORECAST_URL,
    CloudCoverError,
    CloudForecast,
    async_entity_forecast,
    async_fetch_forecast,
)

from .common import NOW, add_location

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
        # The position to about a kilometre, as the README says.
        "latitude": "-41.29",
        "longitude": "174.78",
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


@pytest.mark.parametrize("value", [101, -1, 1e300, -1e300, "NaN"])
async def test_a_value_out_of_range_is_an_hour_without_a_forecast(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, value: Any
) -> None:
    aioclient_mock.get(
        FORECAST_URL,
        json={"hourly": {"time": [HOUR, HOUR + 3600], "cloud_cover": [value, 40]}},
    )
    forecast = await async_fetch_forecast(async_get_clientsession(hass), 0.0, 0.0)
    assert forecast.percent_by_hour == {HOUR + 3600: 40}


async def test_too_much_of_an_answer_is_no_forecast(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.get(FORECAST_URL, text=" " * (1024 * 1024 + 1))
    with pytest.raises(CloudCoverError, match="over"):
        await async_fetch_forecast(async_get_clientsession(hass), 0.0, 0.0)


# From a weather entity of the user's own.


def _weather_answers(hass: HomeAssistant, rows: Any) -> list[ServiceCall]:
    calls: list[ServiceCall] = []

    async def answer(call: ServiceCall) -> ServiceResponse:
        calls.append(call)
        return {"weather.home": {"forecast": rows}}

    hass.services.async_register(
        "weather", "get_forecasts", answer, supports_response=SupportsResponse.ONLY
    )
    return calls


async def test_a_weather_entity_is_asked_for_its_hourly_forecast(hass: HomeAssistant) -> None:
    calls = _weather_answers(
        hass,
        [
            {"datetime": "2026-11-05T12:00:00+00:00", "cloud_coverage": 25.4, "temperature": 3},
            # Not on the hour: it is that hour's forecast all the same.
            {"datetime": "2026-11-05T13:30:00+00:00", "cloud_coverage": 80},
            {"datetime": "2026-11-05T14:00:00+00:00"},
            {"datetime": "2026-11-05T15:00:00+00:00", "cloud_coverage": 300},
            {"datetime": "not a time", "cloud_coverage": 50},
            {"cloud_coverage": 50},
        ],
    )
    forecast = await async_entity_forecast(hass, "weather.home")
    assert forecast.percent_by_hour == {HOUR: 25, HOUR + 3600: 80}
    assert calls[0].data == {"entity_id": "weather.home", "type": "hourly"}


@pytest.mark.parametrize(
    "rows",
    [[], [{"datetime": "2026-11-05T12:00:00+00:00", "temperature": 3}], "not a list", None],
)
async def test_a_forecast_with_no_clouds_is_no_forecast(hass: HomeAssistant, rows: Any) -> None:
    _weather_answers(hass, rows)
    with pytest.raises(CloudCoverError):
        await async_entity_forecast(hass, "weather.home")


async def test_no_weather_at_all_is_no_forecast(hass: HomeAssistant) -> None:
    with pytest.raises(CloudCoverError):
        await async_entity_forecast(hass, "weather.home")


async def test_a_weather_entity_that_cannot_say_is_no_forecast(hass: HomeAssistant) -> None:
    async def refuse(_call: ServiceCall) -> ServiceResponse:
        raise HomeAssistantError("Weather entity does not support 'hourly' forecast")

    hass.services.async_register(
        "weather", "get_forecasts", refuse, supports_response=SupportsResponse.ONLY
    )
    with pytest.raises(CloudCoverError, match="does not support"):
        await async_entity_forecast(hass, "weather.home")


async def test_a_location_with_a_weather_entity_never_asks_open_meteo(
    hass: HomeAssistant, freezer: Any, mock_downloads: dict[str, AsyncMock]
) -> None:
    freezer.move_to(NOW)
    hour = (int(NOW.timestamp()) // 3600 + 1) * 3600
    rows = [
        {"datetime": datetime.fromtimestamp(hour + n * 3600, UTC).isoformat(), "cloud_coverage": 40}
        for n in range(240)
    ]
    _weather_answers(hass, rows)
    entry = await add_location(hass, options={"weather_entity": "weather.home"})
    mock_downloads["fetch_forecast"].assert_not_awaited()
    passes = entry.runtime_data.predictions.passes
    assert passes
    assert {p.cloud_cover for p in passes} == {40}


async def test_a_location_with_a_weather_entity_that_has_no_clouds_has_none(
    hass: HomeAssistant, freezer: Any, mock_downloads: dict[str, AsyncMock]
) -> None:
    freezer.move_to(NOW)
    entry = await add_location(hass, options={"weather_entity": "weather.gone"})
    mock_downloads["fetch_forecast"].assert_not_awaited()
    assert {p.cloud_cover for p in entry.runtime_data.predictions.passes} == {None}
    assert entry.runtime_data.predictions.cloud_forecast is False
