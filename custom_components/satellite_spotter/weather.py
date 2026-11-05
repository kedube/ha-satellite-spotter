"""The cloud forecast, from Open-Meteo."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import aiohttp

from .const import PREDICTION_DAYS, USER_AGENT

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_TIMEOUT = aiohttp.ClientTimeout(total=30)
_HOUR_S = 3600


class CloudCoverError(Exception):
    """No forecast: the network failed or the answer made no sense."""


@dataclass(frozen=True)
class CloudForecast:
    """The cloud cover, by the Unix time each hour's forecast is labelled with."""

    percent_by_hour: Mapping[int, int]

    def after(self, moment: datetime) -> int | None:
        """Return the percentage for the whole hour after a moment, if there is one.

        On the hour counts as before the next.
        """
        return self.percent_by_hour.get((int(moment.timestamp()) // _HOUR_S + 1) * _HOUR_S)


def _forecast_from(answer: Any) -> CloudForecast:
    """Read Open-Meteo's answer; a blank hour is an hour without a forecast."""
    hourly = answer["hourly"]
    times, percents = hourly["time"], hourly["cloud_cover"]
    if len(times) != len(percents):
        raise ValueError("The forecast's times and values do not match")
    return CloudForecast(
        {
            int(when): round(float(percent))
            for when, percent in zip(times, percents, strict=True)
            if percent is not None
        }
    )


async def async_fetch_forecast(
    session: aiohttp.ClientSession, latitude: float, longitude: float
) -> CloudForecast:
    """Ask Open-Meteo for the cloud cover. Any failure raises CloudCoverError."""
    query = {
        "latitude": str(round(latitude, 4)),
        "longitude": str(round(longitude, 4)),
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
            answer = await response.json(content_type=None)
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
