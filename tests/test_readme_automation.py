"""The README's automation, taken from the README itself, runs as it says."""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime, timedelta
import re
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.template import Template
from homeassistant.setup import async_setup_component
from homeassistant.util.yaml import parse_yaml
import pytest
from pytest_homeassistant_custom_component.common import async_mock_service

from .common import NOW, ROOT, add_location, advance, bright_pass, dim_pass

SECOND = timedelta(seconds=1)
# Between the calendar trigger's quarter-hour polls, as most passes are.
START = NOW + timedelta(hours=1, minutes=7)
README = (ROOT / "README.md").read_text(encoding="utf-8")
EXAMPLE = re.search(r"```yaml\n(triggers:.*?)```", README, re.DOTALL)


def readme_automation() -> Any:
    assert EXAMPLE is not None
    return parse_yaml(EXAMPLE.group(1))


async def set_up_automation(hass: HomeAssistant) -> list[ServiceCall]:
    calls = async_mock_service(hass, "notify", "mobile_app_your_phone")
    assert await async_setup_component(
        hass,
        "automation",
        {"automation": {"id": "readme", "alias": "From the README", **readme_automation()}},
    )
    await hass.async_block_till_done()
    return calls


async def walk_to(hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime) -> None:
    """Let the clock run to a moment, in steps as short as the calendar trigger's polling."""
    moment = NOW + timedelta(minutes=15)
    while moment < when:
        await advance(hass, freezer, moment)
        moment += timedelta(minutes=15)
    await advance(hass, freezer, when)


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


@pytest.fixture(autouse=True)
async def _stop_automations(hass: HomeAssistant) -> AsyncIterator[None]:
    """Take away the calendar trigger's timers at the end of a test."""
    yield
    if hass.services.has_service("automation", "turn_off"):
        await hass.services.async_call(
            "automation", "turn_off", {"entity_id": "all"}, blocking=True
        )


def test_the_readme_has_the_example() -> None:
    config = readme_automation()
    assert config["triggers"][0]["entity_id"] == "calendar.home_visible_passes"
    assert config["triggers"][0]["trigger"] == "calendar"
    assert config["triggers"][0]["event"] == "start"


async def test_it_fires_fifteen_minutes_before_each_pass_with_what_it_promises(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = bright_pass(START, cloud_cover=12)
    predict_passes.return_value = [p]
    await add_location(hass)
    calls = await set_up_automation(hass)

    fires_at = p.start - timedelta(minutes=15)
    await walk_to(hass, freezer, fires_at - SECOND)
    assert calls == []

    await advance(hass, freezer, fires_at)
    assert len(calls) == 1
    data = calls[0].data
    assert data["title"] == "Pass in 15 minutes: 🌟 ISS"
    lines = data["message"]
    assert lines.startswith("Best view at ")
    assert "First visible at " in lines
    assert "Last visible at " in lines
    assert "Cloud cover near the pass: 12%." in lines
    # The last line, the link, is left out, and the others are on one line.
    assert "wikipedia" not in lines
    assert "\n" not in lines
    assert data["data"]["url"] == f"/satellite-spotter?pass={p.id}&view=street"
    assert data["data"]["clickAction"] == f"/satellite-spotter?pass={p.id}&view=street"


async def test_it_fires_for_every_pass_not_only_bright_ones(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(START)
    predict_passes.return_value = [p]
    await add_location(hass)
    calls = await set_up_automation(hass)
    await walk_to(hass, freezer, p.start - timedelta(minutes=15))
    assert len(calls) == 1
    assert calls[0].data["title"] == "Pass in 15 minutes: 🔭 ISS"


async def test_the_link_for_several_locations_names_the_location(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass)
    addition = re.search(r"`&entry_id=(\{\{.*?\}\})`", README)
    assert addition is not None
    assert Template(addition.group(1), hass).async_render() == entry.entry_id
