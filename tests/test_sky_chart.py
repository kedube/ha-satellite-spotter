"""The picture of a pass for notifications: what is drawn, and who can have it."""

from __future__ import annotations

from datetime import timedelta
from http import HTTPStatus
import struct
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
import zlib

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.http.auth import async_sign_path
from homeassistant.core import HomeAssistant
import numpy as np
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.satellite_spotter import sky_chart, track
from custom_components.satellite_spotter.const import DOMAIN, SERVICE_GET_PASSES
from custom_components.satellite_spotter.coordinator import predict_passes as search_for_passes
from custom_components.satellite_spotter.sky_chart import (
    ChartPath,
    chart_of_pass,
    render_chart,
    sky_chart_path,
    sky_xy,
)

from .common import FIRST_PASS_ID, HONOLULU, NOW, add_location, bright_pass


def pixels(png: bytes) -> np.ndarray[Any, Any]:
    """Decode the kind of PNG the chart is: eight-bit RGB with no filters."""
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    at = 8
    width = height = 0
    data = b""
    while at < len(png):
        length, kind = struct.unpack(">I4s", png[at : at + 8])
        body = png[at + 8 : at + 8 + length]
        crc = struct.unpack(">I", png[at + 8 + length : at + 12 + length])[0]
        assert crc == zlib.crc32(kind + body)
        if kind == b"IHDR":
            width, height, depth, colour, *_ = struct.unpack(">IIBBBBB", body)
            assert (depth, colour) == (8, 2)
        elif kind == b"IDAT":
            data += body
        at += 12 + length
    raw = np.frombuffer(zlib.decompress(data), dtype=np.uint8)
    rows = raw.reshape(height, 1 + width * 3)
    assert not rows[:, 0].any()
    return rows[:, 1:].reshape(height, width, 3)


ACROSS = ChartPath(
    above=[(270.0, 0.0), (270.0, 45.0), (90.0, 45.0), (90.0, 0.0)],
    visible=[(270.0, 45.0), (0.0, 90.0), (90.0, 45.0)],
)


def test_north_is_up_and_east_to_the_right_like_the_pages_chart() -> None:
    size = 480
    assert sky_xy(0.0, 0.0)[1] < size / 2
    assert sky_xy(90.0, 0.0)[0] > size / 2
    assert sky_xy(180.0, 0.0)[1] > size / 2
    assert sky_xy(270.0, 0.0)[0] < size / 2
    assert sky_xy(123.0, 90.0) == pytest.approx((size / 2, size / 2))


def test_the_visible_part_of_the_path_is_gold_and_elsewhere_is_not() -> None:
    image = pixels(render_chart(ACROSS))
    # Halfway down towards the east, on the path.
    red, green, blue = image[240, 288]
    assert red > 200 and green > 150 and blue < 150
    # Up in the north-west, away from it and the guides: dark blue sky.
    red, green, blue = image[150, 170]
    assert red < 60 and blue > red


def test_a_path_with_nothing_visible_still_makes_a_chart() -> None:
    image = pixels(render_chart(ChartPath(above=[(10.0, 5.0), (20.0, 15.0)], visible=[])))
    assert image.shape == (480, 480, 3)


def test_an_empty_path_still_makes_a_chart() -> None:
    assert pixels(render_chart(ChartPath(above=[], visible=[]))).shape == (480, 480, 3)


@pytest.mark.parametrize(
    ("language", "letters"),
    [
        ("en", ("N", "E", "S", "W")),
        ("de", ("N", "O", "S", "W")),
        ("nl", ("N", "O", "Z", "W")),
        ("fr", ("N", "E", "S", "O")),
        ("sv", ("N", "Ö", "S", "V")),
        # Polish names them in words: the letters everyone knows instead.
        ("pl", ("N", "E", "S", "W")),
        ("xx", ("N", "E", "S", "W")),
    ],
)
def test_the_compass_is_in_the_language(language: str, letters: tuple[str, ...]) -> None:
    assert sky_chart._cardinals(language) == letters


def test_the_chart_of_a_real_pass(catalog: list[Any]) -> None:
    observer = track.Observer(*HONOLULU.values())
    start = NOW.replace(second=0, microsecond=0)
    p = search_for_passes(catalog, observer, start=start, faintest=2.25, forecast=None)[0]
    assert pixels(chart_of_pass(p, observer, 2.25, "en")).shape == (480, 480, 3)


# Over HTTP.


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


async def test_it_is_served_to_someone_signed_in(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_client: ClientSessionGenerator
) -> None:
    client = await hass_client()
    answer = await client.get(sky_chart_path(init_integration.entry_id, FIRST_PASS_ID))
    assert answer.status == HTTPStatus.OK
    assert answer.content_type == "image/png"
    assert pixels(await answer.read()).shape == (480, 480, 3)


async def test_it_is_kept_rather_than_drawn_again(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_client: ClientSessionGenerator
) -> None:
    client = await hass_client()
    path = sky_chart_path(init_integration.entry_id, FIRST_PASS_ID)
    with patch.object(sky_chart, "chart_of_pass", wraps=chart_of_pass) as drawn:
        for _ in range(3):
            assert (await client.get(path)).status == HTTPStatus.OK
    assert drawn.call_count == 1


async def test_it_is_not_served_to_anyone_else(
    hass: HomeAssistant,
    init_integration: MockConfigEntry,
    hass_client_no_auth: ClientSessionGenerator,
) -> None:
    client = await hass_client_no_auth()
    answer = await client.get(sky_chart_path(init_integration.entry_id, FIRST_PASS_ID))
    assert answer.status == HTTPStatus.UNAUTHORIZED


async def test_a_signed_link_needs_no_sign_in_until_it_runs_out(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    init_integration: MockConfigEntry,
    hass_client_no_auth: ClientSessionGenerator,
) -> None:
    answer = await hass.services.async_call(
        DOMAIN,
        SERVICE_GET_PASSES,
        {"config_entry_id": init_integration.entry_id, "pass_id": FIRST_PASS_ID},
        blocking=True,
        return_response=True,
    )
    link = answer["passes"][0]["sky_chart"]
    client = await hass_client_no_auth()
    assert (await client.get(link)).status == HTTPStatus.OK
    # Signed for this picture only.
    other = async_sign_path(hass, "/api/config", timedelta(days=1), use_content_user=True)
    assert link.split("authSig=")[1] != other.split("authSig=")[1]
    tampered = link.replace(FIRST_PASS_ID, str(int(FIRST_PASS_ID) + 1))
    assert (await client.get(tampered)).status == HTTPStatus.UNAUTHORIZED
    freezer.move_to(NOW + timedelta(days=1, seconds=1))
    assert (await client.get(link)).status == HTTPStatus.UNAUTHORIZED


@pytest.mark.parametrize(
    ("entry_id", "pass_id"),
    [("nothing", FIRST_PASS_ID), ("{entry}", "1"), ("{entry}", "not a pass")],
)
async def test_what_is_not_there_is_a_404(
    hass: HomeAssistant,
    init_integration: MockConfigEntry,
    hass_client: ClientSessionGenerator,
    entry_id: str,
    pass_id: str,
) -> None:
    client = await hass_client()
    path = sky_chart_path(entry_id.format(entry=init_integration.entry_id), pass_id)
    assert (await client.get(path)).status == HTTPStatus.NOT_FOUND


async def test_another_integrations_entry_is_a_404(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_client: ClientSessionGenerator
) -> None:
    other = MockConfigEntry(domain="sun")
    other.add_to_hass(hass)
    client = await hass_client()
    answer = await client.get(sky_chart_path(other.entry_id, FIRST_PASS_ID))
    assert answer.status == HTTPStatus.NOT_FOUND


async def test_a_location_with_no_predictions_is_a_404(
    hass: HomeAssistant,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
    hass_client: ClientSessionGenerator,
) -> None:
    predict_passes.return_value = [bright_pass(NOW + timedelta(hours=1))]
    entry = await add_location(hass)
    client = await hass_client()
    await hass.config_entries.async_unload(entry.entry_id)
    answer = await client.get(sky_chart_path(entry.entry_id, FIRST_PASS_ID))
    assert answer.status == HTTPStatus.NOT_FOUND
