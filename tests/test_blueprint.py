"""The notification blueprint, run by Home Assistant against the integration's calendar."""

from __future__ import annotations

from datetime import datetime, timedelta
import itertools
import json
from typing import Any

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.blueprint.models import Blueprint, BlueprintInputs
from homeassistant.components.blueprint.schemas import BLUEPRINT_SCHEMA
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, entity_registry as er
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util, yaml as yaml_util
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_capture_events

from custom_components.satellite_spotter.calendar import event_times
from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.coordinator import SatellitePass

from .common import INTEGRATION, NOW, ROOT, advance

BLUEPRINT = ROOT / "blueprints/automation/satellite_spotter/notify_satellite_pass.yaml"
CALENDAR = "calendar.home_satellite_passes"
EVENT = "satellite_notification"


def _automation(calendar: str = CALENDAR, **inputs: Any) -> dict[str, Any]:
    blueprint = Blueprint(
        yaml_util.load_yaml_dict(BLUEPRINT), expected_domain="automation", schema=BLUEPRINT_SCHEMA
    )
    config = BlueprintInputs(
        blueprint,
        {
            "use_blueprint": {
                "path": "notify_satellite_pass.yaml",
                "input": {"calendar": calendar, "notify_device": "abc123", **inputs},
            }
        },
    )
    config.validate()
    return config.async_substitute()


def _recorded(config: dict[str, Any]) -> dict[str, Any]:
    """The blueprint's automation, with its phone notification recorded as an event."""
    sent = config["actions"][0]
    assert (sent["domain"], sent["type"], sent["device_id"]) == ("mobile_app", "notify", "abc123")
    return {
        **config,
        "id": "satellite_notify",
        "alias": "Satellite notify",
        "actions": [
            {
                "event": EVENT,
                "event_data": {
                    "title": sent["title"],
                    "message": sent["message"],
                    "data": sent["data"],
                },
            }
        ],
    }


def _variables(hass: HomeAssistant, summary: str, description: str, start: datetime) -> Any:
    config = _automation()
    trigger = {
        "calendar_event": {
            "summary": summary,
            "description": description,
            "uid": "53807-1791659316",
            "start": start.isoformat(),
            "end": (start + timedelta(minutes=2)).isoformat(),
        }
    }
    variables = cv.SCRIPT_VARIABLES_SCHEMA(config["variables"])
    return variables.async_render(hass, {"trigger": trigger})


async def _run(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    passes: list[SatellitePass],
    calendar: str = CALENDAR,
    **inputs: Any,
) -> list[Any]:
    """Run the automation through the calendar's events; return the notifications."""
    notifications = async_capture_events(hass, EVENT)
    assert await async_setup_component(
        hass, "automation", {"automation": [_recorded(_automation(calendar, **inputs))]}
    )
    await hass.async_block_till_done()
    lead = timedelta(minutes=10)
    for p in passes:
        start, _ = event_times(p)
        await advance(hass, freezer, start - lead - timedelta(seconds=1))
        await advance(hass, freezer, start - lead + timedelta(seconds=1))
    # Detach the trigger (its polling would outlive the test).
    await hass.services.async_call(
        "automation", "turn_off", {"entity_id": "automation.satellite_notify"}, blocking=True
    )
    return notifications


async def test_every_pass_is_announced(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    """Once per pass, ten minutes ahead, even passes a few minutes apart."""
    # Skip the first pass, under way in four minutes.
    passes = init_integration.runtime_data.data.passes[1:13]
    gaps = [b.start - a.end for a, b in itertools.pairwise(passes)]
    assert min(gaps) < timedelta(minutes=10)
    notifications = await _run(hass, freezer, passes, bright_only=False, max_cloud_cover=100)
    assert len(notifications) == len(passes)
    for event, p in zip(notifications, passes, strict=True):
        # The location the calendar belongs to, then the pass, in the street view.
        link = f"/satellite-spotter?entry_id={init_integration.entry_id}&pass={p.id}&view=street"
        assert event.data["data"] == {
            "url": link,
            "clickAction": link,
            "tag": f"satellite-pass-{p.id}",
        }
        assert event.data["title"].endswith(" in 10 min")
        assert event.data["title"].startswith("🛰️ ")
        assert event.data["message"].startswith(f"Look {_compass(p.primary.rise.azimuth)} at ")

    p = passes[0]
    t = p.primary
    local = dt_util.as_local
    assert notifications[0].data["title"] == "🛰️ TERRA in 10 min"
    assert notifications[0].data["message"] == (
        f"Look {_compass(t.rise.azimuth)} at {local(t.start):%H:%M}, {t.rise.elevation:.0f}° up. "
        f"Brightest {t.brightest.elevation:.0f}° up in the {_compass(t.brightest.azimuth)}, "
        f"magnitude {round(t.min_magnitude, 1) + 0.0}; gone in the {_compass(t.set.azimuth)} "
        f"by {local(t.end):%H:%M}. Cloud cover {p.cloud_cover}%."
    )


async def test_bright_passes_under_clear_skies(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    """By default only bright passes, and none under heavy cloud."""
    passes = init_integration.runtime_data.data.passes[1:]
    bright = [p for p in passes if p.bright][:3]
    assert [p.cloud_cover for p in bright] == [43, 66, 91]
    notifications = await _run(hass, freezer, [*passes[:2], *bright])
    # The 66% and 91% skies are cloudier than the default 60%.
    assert [e.data["data"]["url"] for e in notifications] == [
        f"/satellite-spotter?entry_id={init_integration.entry_id}&pass={bright[0].id}&view=street"
    ]
    assert notifications[0].data["title"] == "🛰️ BlueWalker 3 in 10 min"


async def test_other_languages(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_see_a_satellite: dict[str, Any],
) -> None:
    """The calendar speaks German: the notification quotes it, and still knows bright and clouds."""
    hass.config.language = "de"
    freezer.move_to(NOW)
    mock_config_entry.add_to_hass(hass)
    await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done()
    passes = mock_config_entry.runtime_data.data.passes[1:]
    bright = next(p for p in passes if p.bright)
    calendar = er.async_get(hass).async_get_entity_id(
        "calendar", DOMAIN, f"{mock_config_entry.entry_id}_passes"
    )
    assert calendar == "calendar.home_satellitenuberfluge"
    notifications = await _run(hass, freezer, [bright], calendar=calendar, max_cloud_cover=50)
    (event,) = notifications
    assert event.data["title"] == "🛰️ BlueWalker 3 in 10 min"
    assert event.data["data"]["url"] == (
        f"/satellite-spotter?entry_id={mock_config_entry.entry_id}&pass={bright.id}&view=street"
    )
    assert event.data["message"].startswith("Erscheint um ")
    assert "Am hellsten um " in event.data["message"]
    assert "(Helligkeit " in event.data["message"]


@pytest.mark.parametrize(
    "language", sorted(p.stem for p in (INTEGRATION / "translations").glob("*.json"))
)
async def test_bright_passes_in_every_language(hass: HomeAssistant, language: str) -> None:
    """The blueprint tells bright passes, satellite names and clouds in every language."""
    common = json.loads((INTEGRATION / f"translations/{language}.json").read_text())["common"]
    start = NOW + timedelta(minutes=10)
    for title in ("ISS", "IUS R/B(1)", "LEASAT 5 PKM (SSUS-A)", "Starlink 1 B +10"):
        for bright in (True, False):
            key = "calendar_summary_bright" if bright else "calendar_summary"
            summary = common[key].format(title=title)
            description = "\n".join(
                [
                    common["calendar_appears"].format(
                        time="20:31:02", direction="X", elevation="12"
                    ),
                    common["calendar_brightest"].format(
                        time="20:33:00", direction="Y", elevation="45", magnitude="-1,2"
                    ),
                    common["calendar_cloud_cover"].format(cloud_cover=37),
                ]
            )
            variables = _variables(hass, summary, description, start)
            assert variables["bright"] is bright, (language, summary)
            assert variables["satellite"] == title, (language, summary)
            assert variables["cloud_cover"] == 37
            assert variables["magnitude"] == -1.2
            # No such calendar in the registry: a link without the location.
            assert variables["entry_id"] == ""
            assert variables["link"] == "/satellite-spotter?pass=53807-1791659316&view=street"


async def test_without_a_forecast(hass: HomeAssistant, freezer: FrozenDateTimeFactory) -> None:
    """No cloud cover line: the pass is announced whatever the limit."""
    freezer.move_to(NOW)
    variables = _variables(
        hass,
        "🛰️ ISS (bright)",
        "Appears at 20:31:02 in the W, 21° up.\n"
        "Brightest at 20:32:30 in the NW, 40° up (magnitude -2.5).\n"
        "Disappears at 20:34:55 in the NE, 10° up.\n"
        "About ISS: https://en.wikipedia.org/wiki/International_Space_Station",
        NOW + timedelta(minutes=10),
    )
    assert variables["cloud_cover"] is None
    assert variables["minutes"] == 10
    assert variables["details"] == (
        "Look W at 20:31, 21° up. Brightest 40° up in the NW, magnitude -2.5; "
        "gone in the NE by 20:34."
    )


async def test_the_link_names_the_calendars_location(hass: HomeAssistant) -> None:
    """With several locations the panel opens the pass where the calendar is."""
    entry = MockConfigEntry(domain=DOMAIN, entry_id="01K8CABIN0000000000000000", title="Cabin")
    entry.add_to_hass(hass)
    er.async_get(hass).async_get_or_create(
        "calendar",
        DOMAIN,
        f"{entry.entry_id}_passes",
        config_entry=entry,
        suggested_object_id="home_satellite_passes",
    )
    variables = _variables(hass, "🛰️ ISS (bright)", "", NOW + timedelta(minutes=10))
    assert variables["entry_id"] == "01K8CABIN0000000000000000"
    assert variables["link"] == (
        "/satellite-spotter?entry_id=01K8CABIN0000000000000000&pass=53807-1791659316&view=street"
    )


def test_the_description_says_when_the_tap_opens_the_pass() -> None:
    """The link opens the sidebar page, which only the option it names adds."""
    description = yaml_util.load_yaml_dict(BLUEPRINT)["blueprint"]["description"]
    strings = json.loads((INTEGRATION / "strings.json").read_text())
    option = strings["options"]["step"]["init"]["data"]["show_in_sidebar"]
    assert f'"{option}"' in description


def _compass(azimuth: float) -> str:
    points = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
              "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")  # fmt: skip
    return points[round(azimuth / 22.5) % 16]
