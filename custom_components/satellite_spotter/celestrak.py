"""The satellite catalog: orbital elements from CelesTrak, brightness from our own table.

CelesTrak is a non-profit, and each Home Assistant downloads from it directly,
so this keeps to its usage policy (https://celestrak.org/usage-policy.php):
its data changes at most every two hours, it answers a repeated download with
a 403, and it can block an address that keeps asking. Automated software should
"immediately stop querying when it receives any non-HTTP 200 responses", so any
other answer, even a redirect, stops the whole download at once. The manager
(catalog.py) then leaves CelesTrak alone for at least two hours.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
import csv
from functools import lru_cache
import io
from pathlib import Path

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from pysatellitespotter import CatalogError, Satellite

from .const import USER_AGENT

GP_URL = "https://celestrak.org/NORAD/elements/gp.php"
# Together about 2.9 MB, smallest first. "active" holds the working satellites,
# most of them Starlinks, and R/B the spent rocket stages; "visual" adds some
# dead satellites and debris that are easy to see. USA 60 is in none of them,
# and it is bright enough to be worth a request of its own.
QUERIES: tuple[Mapping[str, str], ...] = (
    {"CATNR": "20682"},
    {"GROUP": "visual"},
    {"NAME": "R/B"},
    {"GROUP": "active"},
)
_TIMEOUT = aiohttp.ClientTimeout(total=120)

_TABLE = Path(__file__).parent / "brightness.csv"
# Only Starlinks this low are bright enough to draw the eye: new ones still
# climbing in a train, and old ones coming down. The rest are made to be dim.
STARLINK_MAX_PERIGEE_KM = 350.0
# What people call these, where CelesTrak says "ISS (ZARYA)", say.
_NAMES = {20580: "Hubble", 25544: "ISS", 48274: "Tiangong"}


class DownloadRefused(CatalogError):
    """CelesTrak answered, but not with orbital data: asking again soon would not help."""


@lru_cache(maxsize=1)
def brightness_table() -> dict[int, float]:
    """Return each satellite's intrinsic magnitude (reads a file: not in the event loop)."""
    with _TABLE.open(encoding="utf-8", newline="") as handle:
        lines = (line for line in handle if not line.startswith("#"))
        return {int(row["norad_id"]): float(row["magnitude"]) for row in csv.DictReader(lines)}


def _satellite(row: Mapping[str, str], table: Mapping[int, float]) -> Satellite | None:
    """Return the satellite a row of orbital data describes, if it is one we predict."""
    name = row["OBJECT_NAME"].upper()
    if name.startswith("STARLINK"):
        # Direct-to-cell satellites have a brightness model of their own.
        model = "starlink-dtc" if "[DTC]" in name else "starlink-raising"
        satellite = Satellite.from_omm(row, None, model)
        return satellite if satellite.perigee_km < STARLINK_MAX_PERIGEE_KM else None
    norad_id = int(row["NORAD_CAT_ID"])
    if (magnitude := table.get(norad_id)) is None:
        return None
    return Satellite.from_omm(row, magnitude, None, _NAMES.get(norad_id))


def build_catalog(responses: Iterable[str]) -> list[Satellite]:
    """Join CelesTrak's answers with the brightness table (in the executor).

    An object can be in several answers; the newest elements win.
    """
    table = brightness_table()
    rows: dict[str, dict[str, str]] = {}
    for text in responses:
        reader = csv.DictReader(io.StringIO(text))
        if "NORAD_CAT_ID" not in (reader.fieldnames or ()):
            raise DownloadRefused(f"CelesTrak did not send orbital data: {text[:80]!r}")
        for row in reader:
            # The last line of an answer cut short has no value in the last columns.
            if None in row.values():
                continue
            norad_id = row["NORAD_CAT_ID"]
            if norad_id not in rows or row["EPOCH"] > rows[norad_id]["EPOCH"]:
                rows[norad_id] = row
    satellites = []
    for row in rows.values():
        try:
            satellite = _satellite(row, table)
        # One bad row should not cost the other satellites.
        except (ArithmeticError, KeyError, TypeError, ValueError):
            continue
        if satellite is not None:
            satellites.append(satellite)
    return satellites


async def _async_download(session: aiohttp.ClientSession, query: Mapping[str, str]) -> str:
    try:
        async with session.get(
            GP_URL,
            params={**query, "FORMAT": "csv"},
            timeout=_TIMEOUT,
            headers={"User-Agent": USER_AGENT},
            allow_redirects=False,
        ) as response:
            if response.status != 200:
                raise DownloadRefused(f"CelesTrak answered {response.status} for {dict(query)}")
            return await response.text(encoding="utf-8", errors="replace")
    except (aiohttp.ClientError, TimeoutError) as err:
        raise CatalogError(f"Could not reach CelesTrak: {err}") from err


async def async_fetch_catalog(hass: HomeAssistant) -> list[Satellite]:
    """Download the orbital data, one request at a time, and build the catalog."""
    session = async_get_clientsession(hass)
    responses = [await _async_download(session, query) for query in QUERIES]
    return await hass.async_add_executor_job(build_catalog, responses)
