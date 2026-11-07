"""The cloud forecast: from Open-Meteo, or from a weather entity of the user's own."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util
from homeassistant.util.json import json_loads
import voluptuous as vol

from .const import MAX_REPLY_BYTES, PREDICTION_DAYS, USER_AGENT
from .download import async_read_capped

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_TIMEOUT = aiohttp.ClientTimeout(total=30)
_ENTITY_TIMEOUT_S = 30
_HOUR_S = 3600
# About a kilometer: all a cloud forecast needs, and all Open-Meteo need learn.
_COORDINATE_DIGITS = 2


class CloudCoverError(Exception):
    """No forecast: the network failed or the answer made no sense."""


@dataclass(frozen=True)
class CloudForecast:
    """The cloud cover, by the Unix time each hour's forecast is labeled with."""

    percent_by_hour: Mapping[int, int]

    def after(self, moment: datetime) -> int | None:
        """Return the percentage for the whole hour after a moment, if there is one.

        On the hour counts as before the next.
        """
        return self.percent_by_hour.get((int(moment.timestamp()) // _HOUR_S + 1) * _HOUR_S)


def _percents(pairs: Iterable[tuple[int, Any]]) -> dict[int, int]:
    """Keep the hours with a percentage: blank or out of range is an hour without a forecast."""
    return {
        when: round(value)
        for when, percent in pairs
        if percent is not None and 0.0 <= (value := float(percent)) <= 100.0
    }


def _forecast_from(answer: Any) -> CloudForecast:
    """Read Open-Meteo's answer."""
    hourly = answer["hourly"]
    times, percents = hourly["time"], hourly["cloud_cover"]
    if len(times) != len(percents):
        raise ValueError("The forecast's times and values do not match")
    return CloudForecast(
        _percents((int(when), percent) for when, percent in zip(times, percents, strict=True))
    )


async def async_fetch_forecast(
    session: aiohttp.ClientSession, latitude: float, longitude: float
) -> CloudForecast:
    """Ask Open-Meteo for the cloud cover. Any failure raises CloudCoverError."""
    query = {
        "latitude": str(round(latitude, _COORDINATE_DIGITS)),
        "longitude": str(round(longitude, _COORDINATE_DIGITS)),
        "hourly": "cloud_cover",
        "forecast_hours": str(PREDICTION_DAYS * 24 + 2),
        "timeformat": "unixtime",
    }
    try:
        async with session.get(
            FORECAST_URL,
            params=query,
            headers={"User-Agent": USER_AGENT},
            timeout=_TIMEOUT,
        ) as response:
            response.raise_for_status()
            answer = json_loads(await async_read_capped(response, MAX_REPLY_BYTES))
        return _forecast_from(answer)
    except (
        aiohttp.ClientError,
        KeyError,
        OverflowError,
        TimeoutError,
        TypeError,
        ValueError,
    ) as err:
        raise CloudCoverError(str(err) or type(err).__name__) from err


def _forecast_of_entity(rows: Iterable[Mapping[str, Any]]) -> CloudForecast:
    """Read a weather entity's hourly forecast, whose hours are not always labeled on the hour."""
    percents = _percents(
        (int(when.timestamp()) // _HOUR_S * _HOUR_S, row.get("cloud_coverage"))
        for row in rows
        if (when := dt_util.parse_datetime(str(row.get("datetime")))) is not None
    )
    if not percents:
        raise ValueError("Its forecast has no cloud coverage")
    return CloudForecast(percents)


async def async_entity_forecast(hass: HomeAssistant, entity_id: str) -> CloudForecast:
    """Ask a weather entity for the cloud cover. Any failure raises CloudCoverError."""
    try:
        async with asyncio.timeout(_ENTITY_TIMEOUT_S):
            answer = await hass.services.async_call(
                "weather",
                "get_forecasts",
                {"entity_id": entity_id, "type": "hourly"},
                blocking=True,
                return_response=True,
            )
        forecasts: Any = (answer or {})[entity_id]
        return _forecast_of_entity(forecasts["forecast"])
    except (
        AttributeError,
        HomeAssistantError,
        KeyError,
        OverflowError,
        TimeoutError,
        TypeError,
        ValueError,
        vol.Invalid,
    ) as err:
        raise CloudCoverError(str(err) or type(err).__name__) from err
