"""How cloudy the sky will be over a place, hour by hour.

From Open-Meteo's forecast API: https://open-meteo.com/en/docs
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import aiohttp

from .const import PREDICTION_DAYS, USER_AGENT

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_HOUR_S = 3600
# As far ahead as passes are predicted, and the hour after the last of them.
_HOURS_AHEAD = PREDICTION_DAYS * 24 + 2
_PATIENCE = aiohttp.ClientTimeout(total=30)


class CloudCoverError(Exception):
    """There is no forecast to be had."""


@dataclass(frozen=True, slots=True)
class CloudForecast:
    """The percentage of the sky covered, by the Unix time of each whole hour."""

    percent_by_hour: Mapping[int, int]

    def after(self, moment: datetime) -> int | None:
        """Return the forecast for the whole hour after a moment, if there is one."""
        return self.percent_by_hour.get((int(moment.timestamp()) // _HOUR_S + 1) * _HOUR_S)


def _read_forecast(answer: Mapping[str, Any]) -> CloudForecast:
    hourly = answer["hourly"]
    percent_by_hour = {
        int(hour): int(percent)
        for hour, percent in zip(hourly["time"], hourly["cloud_cover"], strict=True)
        # An hour can be blank at the far end of the forecast.
        if percent is not None
    }
    return CloudForecast(percent_by_hour)


async def async_fetch_forecast(
    session: aiohttp.ClientSession, latitude: float, longitude: float
) -> CloudForecast:
    """Download a place's forecast, giving its position to four decimals (about 10 m)."""
    query: dict[str, str | int | float] = {
        "latitude": round(latitude, 4),
        "longitude": round(longitude, 4),
        "hourly": "cloud_cover",
        "forecast_hours": _HOURS_AHEAD,
        "timeformat": "unixtime",
    }
    try:
        async with session.get(
            FORECAST_URL,
            params=query,
            headers={"User-Agent": USER_AGENT},
            timeout=_PATIENCE,
        ) as response:
            response.raise_for_status()
            answer = await response.json()
    except (aiohttp.ClientError, TimeoutError, ValueError) as err:
        raise CloudCoverError(f"Could not get the cloud cover: {err}") from err
    try:
        return _read_forecast(answer)
    except (KeyError, TypeError, ValueError) as err:
        raise CloudCoverError(f"Could not read the cloud cover: {err}") from err
