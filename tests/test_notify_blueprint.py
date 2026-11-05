"""The notification blueprint, loaded as Home Assistant loads it, and run against the calendar.

The one thing replaced is its action, a device action that needs a phone registered with the
Companion app: the same fields go to a service the test can read instead.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta
import json
import re
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.blueprint.models import Blueprint, BlueprintInputs
from homeassistant.components.blueprint.schemas import BLUEPRINT_SCHEMA
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.template import Template
from homeassistant.setup import async_setup_component
from homeassistant.util.yaml import load_yaml_dict
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_mock_service

from custom_components.satellite_spotter.coordinator import ListedPass
from custom_components.satellite_spotter.predict import Moment

from .common import (
    INTEGRATION,
    NOW,
    ROOT,
    add_location,
    advance,
    bright_pass,
    dim_pass,
    listed,
    sighting,
)

BLUEPRINT = ROOT / "blueprints" / "automation" / "satellite_spotter" / "notify_satellite_pass.yaml"
CALENDAR = "calendar.home_visible_passes"
LANGUAGES = sorted(path.stem for path in (INTEGRATION / "translations").glob("*.json"))
SECOND = timedelta(seconds=1)
README = (ROOT / "README.md").read_text(encoding="utf-8")
# Between the calendar trigger's quarter-hour polls, as most passes are.
START = NOW + timedelta(hours=1, minutes=7)


def blueprint() -> Blueprint:
    return Blueprint(
        load_yaml_dict(str(BLUEPRINT)), expected_domain="automation", schema=BLUEPRINT_SCHEMA
    )


def substituted(**inputs: Any) -> dict[str, Any]:
    """Return the automation the blueprint makes of its inputs, as Home Assistant would."""
    with_inputs = BlueprintInputs(
        blueprint(),
        {
            "use_blueprint": {
                "path": "satellite_spotter/notify_satellite_pass.yaml",
                "input": {"calendar": CALENDAR, "notify_device": "a_phone", **inputs},
            }
        },
    )
    with_inputs.validate()
    return with_inputs.async_substitute()


async def set_up_automation(hass: HomeAssistant, **inputs: Any) -> list[ServiceCall]:
    """Set the blueprint's automation up, sending its notification to a service the test reads."""
    config = substituted(**inputs)
    action = config["actions"][0]
    assert action["device_id"] == "a_phone"
    config["actions"] = [
        {
            "action": "notify.phone",
            "data": {
                "title": action["title"],
                "message": action["message"],
                "data": action["data"],
            },
        }
    ]
    calls = async_mock_service(hass, "notify", "phone")
    assert await async_setup_component(
        hass, "automation", {"automation": {"id": "notify", "alias": "Notify", **config}}
    )
    await hass.async_block_till_done()
    return calls


async def walk_to(hass: HomeAssistant, freezer: FrozenDateTimeFactory, *moments: datetime) -> None:
    """Let the clock run through the moments, in steps as short as the trigger's polling."""
    last = max(moments)
    polls = (NOW + timedelta(minutes=15 * n) for n in range(1, 2000))
    stops = {*moments, *(poll for poll in polls if poll < last)}
    for stop in sorted(stops):
        await advance(hass, freezer, stop)


def calendar_of(hass: HomeAssistant, entry: MockConfigEntry) -> str:
    """Return the location's calendar: its id depends on the language it was set up in."""
    return next(
        e.entity_id
        for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
        if e.domain == "calendar"
    )


async def notifications_for(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    predict_passes: MagicMock,
    passes: Sequence[ListedPass],
    **inputs: Any,
) -> list[ServiceCall]:
    """Run a location with these passes past the last one, ten minutes ahead of each."""
    predict_passes.return_value = list(passes)
    entry = await add_location(hass)
    calls = await set_up_automation(hass, calendar=calendar_of(hass, entry), **inputs)
    await walk_to(hass, freezer, *(p.start - timedelta(minutes=10) for p in passes))
    return calls


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


# As a blueprint.


def test_its_description_quotes_the_option_the_link_needs() -> None:
    """The notification's link opens the sidebar page, and only this option adds that page."""
    strings = json.loads((INTEGRATION / "strings.json").read_text(encoding="utf-8"))
    label = strings["options"]["step"]["init"]["data"]["show_in_sidebar"]
    assert f'"{label}"' in load_yaml_dict(BLUEPRINT)["blueprint"]["description"]


def test_it_loads_as_an_automation_blueprint() -> None:
    loaded = blueprint()
    assert loaded.domain == "automation"
    assert loaded.name == "Satellite pass notification"
    assert set(loaded.inputs) == {
        "calendar",
        "notice",
        "bright_only",
        "max_cloud_cover",
        "notify_device",
    }


def test_its_defaults_are_what_the_readme_says() -> None:
    # README: "By default it covers bright passes only, ten minutes ahead, and skips skies more
    # than 60% cloudy."
    inputs = blueprint().inputs
    assert inputs["notice"]["default"] == "-0:10:00"
    assert inputs["bright_only"]["default"] is True
    assert inputs["max_cloud_cover"]["default"] == 60


def test_the_two_inputs_with_no_default_are_required() -> None:
    inputs = blueprint().inputs
    assert "default" not in inputs["calendar"]
    assert "default" not in inputs["notify_device"]


def test_the_calendar_input_offers_only_this_integrations_calendars() -> None:
    [selector] = blueprint().inputs["calendar"]["selector"]["entity"]["filter"]
    assert selector["integration"] == "satellite_spotter"
    assert selector["domain"] in ("calendar", ["calendar"])


def test_the_phone_input_offers_only_companion_app_devices() -> None:
    selector = blueprint().inputs["notify_device"]["selector"]["device"]["filter"]
    assert selector == [{"integration": "mobile_app"}]


def test_the_notice_options_are_valid_offsets_of_what_they_say() -> None:
    options = blueprint().inputs["notice"]["selector"]["select"]["options"]
    minutes = {"5 minutes": 5, "10 minutes": 10, "15 minutes": 15, "20 minutes": 20}
    minutes |= {"30 minutes": 30, "45 minutes": 45, "1 hour": 60, "2 hours": 120}
    assert {option["label"] for option in options} == set(minutes)
    for option in options:
        hours, mins, seconds = option["value"].removeprefix("-").split(":")
        assert option["value"].startswith("-")
        assert int(seconds) == 0
        assert int(hours) * 60 + int(mins) == minutes[option["label"]]


def test_the_automation_it_makes_is_triggered_by_the_calendar_and_notifies_a_device() -> None:
    config = substituted(notice="-0:30:00")
    assert config["triggers"] == [
        {"trigger": "calendar", "event": "start", "offset": "-0:30:00", "entity_id": CALENDAR}
    ]
    assert config["mode"] == "queued"
    assert config["max"] == 10
    action = config["actions"][0]
    assert action["domain"] == "mobile_app"
    assert action["type"] == "notify"
    assert action["device_id"] == "a_phone"


def test_each_notification_is_tagged_with_its_pass_so_that_it_can_be_replaced() -> None:
    assert substituted()["actions"][0]["data"]["tag"] == "satellite-pass-{{ pass_id }}"


# Its templates, one by one.


def _variable(name: str) -> Any:
    return substituted()["variables"][name]


def _render(hass: HomeAssistant, name: str, **variables: Any) -> Any:
    return Template(_variable(name), hass).async_render(variables)


@pytest.mark.parametrize(
    ("summary", "satellite"),
    [
        ("🌟 ISS", "ISS"),
        ("🔭 CZ-2C R/B", "CZ-2C R/B"),
        ("🌟 ISS +7", "ISS +7"),
        ("🔭 STARLINK-1020 +5", "STARLINK-1020 +5"),
        ("", ""),
    ],
)
async def test_the_satellite_is_the_title_without_its_mark(
    hass: HomeAssistant, summary: str, satellite: str
) -> None:
    assert str(_render(hass, "satellite", summary=summary) or "") == satellite


@pytest.mark.parametrize(("summary", "bright"), [("🌟 ISS", True), ("🔭 ISS", False), ("", False)])
async def test_bright_is_the_star(hass: HomeAssistant, summary: str, bright: bool) -> None:
    assert _render(hass, "bright", summary=summary) is bright


@pytest.mark.parametrize(
    ("description", "cloud"),
    [
        ("Cloud cover near the pass: 12%.\nObject: x", 12),
        ("Bewölkung während des Überflugs: 100 %.\nObjekt: x", 100),
        (
            ("Couverture nuageuse\N{NO-BREAK SPACE}: 0\N{NO-BREAK SPACE}%.\nObjet: x", 0),
            0,
        ),
        ("Best view at 20:32:30: NW, 40° high, magnitude -2.5.\nObject: x", None),
        ("", None),
    ],
)
async def test_the_cloud_cover_is_read_from_the_description(
    hass: HomeAssistant, description: str, cloud: int | None
) -> None:
    assert _render(hass, "cloud_cover", description=description) == cloud


async def test_the_details_are_every_line_but_the_last(hass: HomeAssistant) -> None:
    rendered = _render(hass, "details", description="one\ntwo\nthree\nlink")
    assert rendered == "one two three"


async def test_the_link_opens_the_pass_in_the_street_view(hass: HomeAssistant) -> None:
    rendered = _render(hass, "link", entry_id="abc", pass_id="123")
    assert rendered == "/satellite-spotter?entry_id=abc&pass=123&view=street"


async def test_with_no_location_the_link_still_opens_the_pass(hass: HomeAssistant) -> None:
    rendered = _render(hass, "link", entry_id="", pass_id="123")
    assert rendered == "/satellite-spotter?pass=123&view=street"


async def test_a_calendar_of_no_location_gives_an_empty_entry_id(hass: HomeAssistant) -> None:
    assert _render(hass, "entry_id", calendar="calendar.not_there") == ""


async def test_its_conditions_read_as_the_blueprint_says(hass: HomeAssistant) -> None:
    conditions = substituted()["conditions"]
    bright_template, cloud_template = (c["value_template"] for c in conditions)
    for bright, bright_only, expected in (
        (True, True, True),
        (True, False, True),
        (False, True, False),
        (False, False, True),
    ):
        rendered = Template(bright_template, hass).async_render(
            {"bright": bright, "bright_only": bright_only}
        )
        assert rendered is expected
    for cloud_cover, limit, expected in (
        (None, 0, True),
        (0, 0, True),
        (1, 0, False),
        (60, 60, True),
        (61, 60, False),
        (100, 100, True),
    ):
        rendered = Template(cloud_template, hass).async_render(
            {"cloud_cover": cloud_cover, "max_cloud_cover": limit}
        )
        assert rendered is expected


# Running.


async def test_a_bright_pass_is_notified_ten_minutes_ahead_by_default(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = bright_pass(START, cloud_cover=12)
    predict_passes.return_value = [p]
    entry = await add_location(hass)
    calls = await set_up_automation(hass)

    fires_at = START - timedelta(minutes=10)
    await walk_to(hass, freezer, fires_at - SECOND)
    assert calls == []

    await advance(hass, freezer, fires_at)
    assert len(calls) == 1
    data = calls[0].data
    assert data["title"] == "ISS in 10 min"
    message = data["message"]
    assert message.startswith("Best view at ")
    assert "First visible at " in message
    assert "Last visible at " in message
    assert message.endswith("Cloud cover near the pass: 12%.")
    assert "wikipedia" not in message
    assert "\n" not in message
    link = f"/satellite-spotter?entry_id={entry.entry_id}&pass={p.id}&view=street"
    assert data["data"]["url"] == link
    assert data["data"]["clickAction"] == link
    assert data["data"]["tag"] == f"satellite-pass-{p.id}"


async def test_the_notification_reads_as_the_readme_shows_it(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    sample = re.search(r"> \*\*(.*)\*\*\\\n> (.*)\n> (.*)\n", README)
    assert sample is not None
    await hass.config.async_set_time_zone("Pacific/Honolulu")
    # The README's pass, at the times it shows (20:31:02 in Honolulu is 06:31:02 UTC).
    appears = datetime(2026, 11, 5, 6, 31, 2, tzinfo=UTC)
    seen = sighting(
        appears,
        233,
        peak_magnitude=-2.5,
        appears=(270.0, 21.0),
        best_view=(315.0, 40.0),
        disappears=(45.0, 10.0),
    )
    seen.brightest = Moment(datetime(2026, 11, 5, 6, 32, 30, tzinfo=UTC), 315.0, 40.0)
    p = listed(seen, cloud_cover=12)
    predict_passes.return_value = [p]
    entry = await add_location(hass)
    calls = await set_up_automation(hass, calendar=calendar_of(hass, entry))
    await walk_to(hass, freezer, appears - timedelta(minutes=10))
    assert [call.data["title"] for call in calls] == [sample.group(1)]
    assert calls[0].data["message"] == f"{sample.group(2)} {sample.group(3)}"


@pytest.mark.parametrize(("notice", "minutes"), [("-0:05:00", 5), ("-0:45:00", 45)])
async def test_the_notice_can_be_chosen(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
    notice: str,
    minutes: int,
) -> None:
    predict_passes.return_value = [bright_pass(START)]
    await add_location(hass)
    calls = await set_up_automation(hass, notice=notice)
    fires_at = START - timedelta(minutes=minutes)
    await walk_to(hass, freezer, fires_at - SECOND)
    assert calls == []
    await advance(hass, freezer, fires_at)
    assert len(calls) == 1
    assert calls[0].data["title"] == f"ISS in {minutes} min"


async def test_a_group_is_titled_with_how_many_others(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = listed(sighting(START), sighting(START, name="B", norad_id=2), cloud_cover=10)
    calls = await notifications_for(hass, freezer, predict_passes, [p])
    assert calls[0].data["title"] == "ISS +1 in 10 min"
    assert "This pass includes 2 satellites." in calls[0].data["message"]


async def test_dim_passes_are_skipped_by_default_and_told_when_asked(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    dim = dim_pass(START, cloud_cover=10, name="DIM", norad_id=1)
    bright = bright_pass(START + timedelta(hours=1), cloud_cover=10)
    calls = await notifications_for(hass, freezer, predict_passes, [dim, bright])
    assert [call.data["title"] for call in calls] == ["ISS in 10 min"]


async def test_with_bright_only_off_every_pass_is_notified(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    dim = dim_pass(START, cloud_cover=10, name="DIM", norad_id=1)
    bright = bright_pass(START + timedelta(hours=1), cloud_cover=10)
    calls = await notifications_for(hass, freezer, predict_passes, [dim, bright], bright_only=False)
    assert [call.data["title"] for call in calls] == ["DIM in 10 min", "ISS in 10 min"]


@pytest.mark.parametrize(
    ("cloud", "limit", "told"),
    [
        pytest.param(60, None, True, id="exactly the default limit"),
        pytest.param(61, None, False, id="just over the default limit"),
        pytest.param(0, 0, True, id="clear with a limit of nothing"),
        pytest.param(1, 0, False, id="a little cloud with a limit of nothing"),
        pytest.param(100, 100, True, id="overcast with no limit"),
        pytest.param(5, 5, True, id="one digit, on the limit"),
        pytest.param(100, 95, False, id="three digits, over the limit"),
    ],
)
async def test_passes_too_cloudy_are_skipped(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
    cloud: int,
    limit: int | None,
    told: bool,
) -> None:
    inputs = {} if limit is None else {"max_cloud_cover": limit}
    calls = await notifications_for(
        hass, freezer, predict_passes, [bright_pass(START, cloud_cover=cloud)], **inputs
    )
    assert bool(calls) is told


async def test_a_pass_with_no_forecast_is_always_announced(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    calls = await notifications_for(
        hass, freezer, predict_passes, [bright_pass(START)], max_cloud_cover=0
    )
    assert len(calls) == 1
    assert "Cloud cover" not in calls[0].data["message"]


async def test_passes_close_together_each_get_a_notification(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    first = bright_pass(START, 60, cloud_cover=10)
    second = bright_pass(START + timedelta(minutes=2), 60, cloud_cover=10, name="B", norad_id=2)
    calls = await notifications_for(hass, freezer, predict_passes, [first, second])
    assert [call.data["title"] for call in calls] == ["ISS in 10 min", "B in 10 min"]


def _translated(language: str) -> dict[str, str]:
    path = INTEGRATION / "translations" / f"{language}.json"
    common: dict[str, str] = json.loads(path.read_text(encoding="utf-8"))["common"]
    return common


@pytest.mark.parametrize("language", LANGUAGES)
async def test_in_every_language_the_cloud_limit_holds_and_the_text_is_translated(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
    language: str,
) -> None:
    hass.config.language = language
    on_limit = bright_pass(START, 60, cloud_cover=60, name="OK", norad_id=1)
    over = bright_pass(START + timedelta(hours=1), 60, cloud_cover=61, name="CLOUDY", norad_id=2)
    calls = await notifications_for(hass, freezer, predict_passes, [on_limit, over])

    assert [call.data["title"] for call in calls] == ["OK in 10 min"]
    strings = _translated(language)
    message = calls[0].data["message"]
    assert strings["calendar_cloud_cover"].format(cloud_cover=60) in message
    # The bright mark and the end of the message hold whatever the language.
    assert strings["calendar_about"].split("{")[0].strip() not in message


async def test_in_german_the_directions_and_decimals_are_german(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    hass.config.language = "de"
    p = bright_pass(START, cloud_cover=12, peak_magnitude=-2.46, appears=(90.0, 21.0))
    calls = await notifications_for(hass, freezer, predict_passes, [p])
    message = calls[0].data["message"]
    assert "Helligkeit -2,5." in message
    assert "in Richtung O, 21° hoch." in message
    assert message.endswith("Bewölkung während des Überflugs: 12 %.")
    assert "Objekt" not in message


async def test_it_works_with_real_predictions(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    init_integration: MockConfigEntry,
) -> None:
    # The second bright pass over Honolulu is the first with room for the notice.
    calls = await set_up_automation(hass, max_cloud_cover=100)
    passes = init_integration.runtime_data.predictions.passes
    bright = next(p for p in passes if p.bright and p.start - NOW > timedelta(minutes=30))
    await walk_to(hass, freezer, bright.start - timedelta(minutes=10))
    assert [call.data["title"] for call in calls] == [f"{bright.title} in 10 min"]
    assert f"pass={bright.id}&" in calls[0].data["data"]["url"]
    assert init_integration.entry_id in calls[0].data["data"]["url"]
