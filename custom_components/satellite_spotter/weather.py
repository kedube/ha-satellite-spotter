"""How cloudy the coming week will be, from Open-Meteo (https://open-meteo.com/en/docs)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

import aiohttp

from .const import USER_AGENT

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
_TIMEOUT = aiohttp.ClientTimeout(total=30)

# Whole hours in order, with the percentage of the sky covered.
type CloudCover = Sequence[tuple[datetime, int]]


class CloudCoverError(Exception):
    """There is no forecast to be had."""


async def fetch_cloud_cover(
    session: aiohttp.ClientSession, latitude: float, longitude: float
) -> CloudCover:
    """Download the next seven days' cover, hour by hour, for a place."""
    query = {
        "latitude": f"{latitude:.4f}",
        "longitude": f"{longitude:.4f}",
        "hourly": "cloud_cover",
        "forecast_days": "7",
        "timeformat": "unixtime",
    }
    headers = {"User-Agent": USER_AGENT}
    try:
        async with session.get(
            OPEN_METEO_URL, params=query, headers=headers, timeout=_TIMEOUT
        ) as answer:
            answer.raise_for_status()
            hourly = (await answer.json())["hourly"]
        forecast = []
        # A cover can be missing at the far end of the forecast.
        for hour, cover in zip(hourly["time"], hourly["cloud_cover"], strict=False):
            if cover is not None:
                forecast.append((datetime.fromtimestamp(hour, UTC), int(cover)))
    except (aiohttp.ClientError, TimeoutError, ValueError, KeyError, TypeError) as err:
        raise CloudCoverError(f"Could not get the cloud cover: {err}") from err
    return forecast


def cloud_cover_at(forecast: CloudCover | None, when: datetime) -> int | None:
    """Return the forecast for the first whole hour after a moment, if there is one."""
    return next((cover for hour, cover in forecast or () if hour > when), None)
