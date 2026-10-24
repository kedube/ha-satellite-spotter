"""Tests for the calendar of passes."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import itertools
import json
import string
from typing import Any
from unittest.mock import AsyncMock

from freezegun.api import FrozenDateTimeFactory
import homeassistant.components.calendar as calendar_component
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pysatellitespotter import CatalogError, LookAngle, Satellite, Transit, TransitGroup
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_mock_service

from custom_components.satellite_spotter import track
from custom_components.satellite_spotter.calendar import PassText, event_times, resolve_language
from custom_components.satellite_spotter.const import (
    CONF_SHOW_CALENDAR,
    DOMAIN,
    PREDICTION_REFRESH,
    UPCOMING_WINDOW,
)
from custom_components.satellite_spotter.coordinator import SatellitePass
from custom_components.satellite_spotter.entity import info_url, pass_title

from .common import INTEGRATION, NOW, UTRECHT, UTRECHT_ID, advance, aged, satellites

CALENDAR = "calendar.home_satellite_passes"
LANGUAGES = sorted(p.stem for p in (INTEGRATION / "translations").glob("*.json"))
# The calendar's live event subscription arrived in Home Assistant 2026.10.
HAS_SUBSCRIBE = hasattr(calendar_component, "handle_calendar_event_subscribe")
needs_subscribe = pytest.mark.skipif(
    not HAS_SUBSCRIBE, reason="calendar/event/subscribe needs a newer Home Assistant"
)

_COMPASS = (
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
)  # fmt: skip


# --- The See A Satellite Tonight integration's text, verbatim (MIT) --------------
# custom_components/see_a_satellite/{entity,calendar}.py at 4ebcd4c: the
# oracle for the English text, which automations parse with regexes.


def _ref_compass(azimuth: float) -> str:
    return _COMPASS[round(azimuth / 22.5) % 16]


def _ref_look(angle: LookAngle) -> str:
    return f"{_ref_compass(angle.azimuth)}, {angle.elevation:.0f}° up"


def _ref_summary(p: SatellitePass) -> str:
    title = p.group.primary.satellite.name.removesuffix(" prediction")
    if (extra := p.group.satellite_count - 1) > 0:
        title += f" +{extra}"
    summary = f"🛰️ {title}"
    if p.bright:
        summary += " (bright)"
    return summary


def _ref_description(p: SatellitePass) -> str:
    t = p.group.primary
    local = dt_util.as_local
    lines = [
        f"Appears at {local(t.start):%H:%M:%S} in the {_ref_look(t.rise)}.",
        f"Brightest at {local(t.brightest_time):%H:%M:%S} in the {_ref_look(t.brightest)}"
        f" (magnitude {t.min_magnitude:.1f}).",
        f"Disappears at {local(t.end):%H:%M:%S} in the {_ref_look(t.set)}.",
    ]
    if p.group.satellite_count > 1:
        lines.append(f"{p.group.satellite_count} satellites pass together.")
    if p.cloud_cover is not None:
        lines.append(f"Forecast cloud cover: {p.cloud_cover}%.")
    lines.append(f"About {t.satellite.name}: {info_url(t.satellite.norad_id, t.satellite.name)}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    """Set the clock before the fixtures that sign in, so their tokens are valid then."""
    freezer.move_to(NOW)


async def _setup(
    hass: HomeAssistant,
    options: dict[str, Any] | None = None,
) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN, title="Home", data=UTRECHT, options=options or {}, unique_id=UTRECHT_ID
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    return entry


async def _events(
    hass: HomeAssistant, start: datetime, end: datetime, entity_id: str = CALENDAR
) -> list[dict[str, Any]]:
    response = await hass.services.async_call(
        "calendar",
        "get_events",
        {"entity_id": entity_id, "start_date_time": start, "end_date_time": end},
        blocking=True,
        return_response=True,
    )
    return response[entity_id]["events"]


@pytest.mark.usefixtures("mock_pysatellitespotter")
async def test_calendar_lists_the_passes(hass: HomeAssistant) -> None:
    """Every pass of the next five days, in See A Satellite Tonight's words."""
    entry = await _setup(hass)
    data = entry.runtime_data.data
    events = await _events(hass, NOW, NOW + timedelta(days=5))
    assert len(events) == len(data.passes) == 64
    entity = hass.data["calendar"].get_entity(CALENDAR)
    uids = [e.uid for e in await entity.async_get_events(hass, NOW, NOW + timedelta(days=5))]
    assert uids == [p.id for p in data.passes]
    for event, p in zip(events, data.passes, strict=True):
        assert dt_util.parse_datetime(event["start"]) == p.start
        assert dt_util.parse_datetime(event["end"]) == p.end
        assert event["summary"] == _ref_summary(p)
        # Byte for byte, except that "-0.0" (BlueWalker 3, four times) reads 0.0.
        expected = _ref_description(p).replace("(magnitude -0.0)", "(magnitude 0.0)")
        assert event["description"] == expected
    assert events[0]["summary"] == "🛰️ BlueWalker 3 (bright)"
    assert "Forecast cloud cover: 20%" in events[0]["description"]
    assert sum("(magnitude 0.0)" in e["description"] for e in events) == 4
    assert sum(" +1" in e["summary"] for e in events) == 11

    sensor = hass.states.get("sensor.home_next_pass")
    assert dt_util.parse_datetime(events[0]["start"]) == dt_util.parse_datetime(sensor.state)

    # The calendar's state shows the next pass, and is off until it starts.
    state = hass.states.get(CALENDAR)
    assert state.state == "off"
    assert state.attributes["message"] == events[0]["summary"]
    assert state.attributes["description"] == events[0]["description"]
    assert state.attributes["start_time"] == dt_util.as_local(
        dt_util.parse_datetime(events[0]["start"])
    ).strftime("%Y-%m-%d %H:%M:%S")

    # Only the passes that overlap the requested range.
    first_end = dt_util.parse_datetime(events[0]["end"])
    assert await _events(hass, NOW, NOW + timedelta(minutes=1)) == []
    assert await _events(hass, first_end - timedelta(seconds=1), first_end) == events[:1]


@pytest.mark.usefixtures("mock_pysatellitespotter")
async def test_calendar_follows_the_passes(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    """On during each pass; once a pass is over the calendar shows the next one."""
    entry = await _setup(hass)
    first, following = entry.runtime_data.data.passes[:2]
    first_start, first_end = event_times(first)
    following_start, _ = event_times(following)
    second = timedelta(seconds=1)

    def state() -> tuple[str, str]:
        s = hass.states.get(CALENDAR)
        return s.state, s.attributes["start_time"]

    def local(when: datetime) -> str:
        return when.strftime("%Y-%m-%d %H:%M:%S")

    await advance(hass, freezer, first_start + second)
    assert state() == ("on", local(first_start))
    await advance(hass, freezer, first_end)
    assert state() == ("off", local(following_start))
    await advance(hass, freezer, following_start + second)
    assert state() == ("on", local(following_start))


@pytest.mark.usefixtures("mock_pysatellitespotter")
async def test_calendar_can_be_switched_off(hass: HomeAssistant) -> None:
    entry = await _setup(hass, options={CONF_SHOW_CALENDAR: False})
    assert hass.states.get(CALENDAR) is None
    entities = er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
    assert entities
    assert not [e for e in entities if e.domain == "calendar"]
    # The calendar integration is not even loaded for it.
    assert "calendar" not in hass.config.components
    assert hass.states.get("sensor.home_next_pass").state != "unavailable"


@pytest.mark.usefixtures("mock_pysatellitespotter")
async def test_calendar_follows_the_option(
    hass: HomeAssistant, caplog: pytest.LogCaptureFixture
) -> None:
    entry = await _setup(hass)
    ent_reg = er.async_get(hass)
    unique_id = f"{entry.entry_id}_passes"
    assert ent_reg.async_get_entity_id("calendar", DOMAIN, unique_id) == CALENDAR
    assert hass.states.get(CALENDAR).state == "off"

    # Switched off, it goes, rather than staying behind unavailable.
    hass.config_entries.async_update_entry(entry, options={CONF_SHOW_CALENDAR: False})
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert ent_reg.async_get_entity_id("calendar", DOMAIN, unique_id) is None
    assert hass.states.get(CALENDAR) is None

    hass.config_entries.async_update_entry(entry, options={CONF_SHOW_CALENDAR: True})
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get(CALENDAR).state == "off"
    # Each reload unloaded the platforms that were loaded, and only those.
    assert "Ignored unload request" not in caplog.text


@pytest.mark.usefixtures("mock_pysatellitespotter")
async def test_calendar_switched_on_later(
    hass: HomeAssistant, caplog: pytest.LogCaptureFixture
) -> None:
    """Switching it on reloads the location without unloading a calendar it never had."""
    # Loaded already, as it is for anyone with another calendar.
    assert await async_setup_component(hass, "calendar", {})
    entry = await _setup(hass, options={CONF_SHOW_CALENDAR: False})
    assert hass.states.get(CALENDAR) is None

    hass.config_entries.async_update_entry(entry, options={CONF_SHOW_CALENDAR: True})
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get(CALENDAR).state == "off"
    assert "Ignored unload request" not in caplog.text


@needs_subscribe
async def test_calendar_is_empty_while_predictions_are_paused(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    hass_ws_client,
    mock_pysatellitespotter: dict[str, AsyncMock],
) -> None:
    """Passes predicted from orbit data too old to trust are not shown."""
    # Predicted from elements 13.6 days old (the median), just in time.
    mock_pysatellitespotter["fetch_site_catalog"].return_value = aged(satellites(), 13)
    entry = await _setup(hass)
    # Signed in now, while the test user's token is still valid.
    client = await hass_ws_client(hass)
    mock_pysatellitespotter["fetch_site_catalog"].side_effect = CatalogError("503")
    later = NOW + timedelta(days=1)
    await advance(hass, freezer, later)
    assert not entry.runtime_data.last_update_success
    # Passes from the old elements are still to come...
    assert any(p.start > later for p in entry.runtime_data.data.passes)
    # ...but the calendar is unavailable, like the sensors, and lists none of
    # them: the calendar panel asks for them whether or not it is available.
    assert hass.states.get(CALENDAR).state == "unavailable"
    await client.send_json_auto_id(
        {
            "type": "calendar/event/subscribe",
            "entity_id": CALENDAR,
            "start": later.isoformat(),
            "end": (later + timedelta(days=5)).isoformat(),
        }
    )
    msg = await client.receive_json()
    assert msg["success"], msg
    msg = await client.receive_json()
    assert msg["event"]["events"] == []


@needs_subscribe
@pytest.mark.usefixtures("mock_pysatellitespotter")
async def test_wake_ups_do_not_resend_the_events(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, hass_ws_client
) -> None:
    """An open calendar gets the events again when the passes change, not at every wake-up.

    The entities wake whenever a pass comes within a day (and before a bright
    one); the calendar has nothing new to say then. Its own timers follow its
    events, and Home Assistant sends the events again at each of those.
    """
    entry = await _setup(hass)
    coordinator = entry.runtime_data
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {
            "type": "calendar/event/subscribe",
            "entity_id": CALENDAR,
            "start": NOW.isoformat(),
            "end": (NOW + timedelta(days=6)).isoformat(),
        }
    )
    msg = await client.receive_json()
    assert msg["success"], msg
    msg = await client.receive_json()
    assert len(msg["event"]["events"]) == len(coordinator.data.passes)

    async def sent() -> list[str]:
        """What arrived meanwhile (and answers the connection's heartbeat)."""
        await client.send_json_auto_id({"type": "ping"})
        types = []
        while (msg := await client.receive_json())["type"] != "pong":
            types.append(msg["type"])
        return types

    # Two wake-ups in a row with no pass starting or ending between them, and
    # no prediction run (every two hours from NOW).
    data = coordinator.data
    edges = [t for p in data.passes for t in (p.start, p.end)]
    wakes = sorted(
        p.start - UPCOMING_WINDOW for p in data.passes if p.start - UPCOMING_WINDOW > NOW
    )
    first, second = next(
        (a, b)
        for a, b in itertools.pairwise(wakes)
        if timedelta(seconds=10) < b - a < PREDICTION_REFRESH / 2
        and (a - NOW) % PREDICTION_REFRESH < (b - NOW) % PREDICTION_REFRESH
        and not any(a <= t <= b + timedelta(seconds=5) for t in edges)
    )
    await advance(hass, freezer, first + timedelta(seconds=2))
    # Let the calendar's one-second debounce run out, then start afresh.
    await advance(hass, freezer, first + timedelta(seconds=4))
    await sent()
    count = int(hass.states.get("sensor.home_passes_next_24_hours").state)

    await advance(hass, freezer, second + timedelta(seconds=2))
    assert int(hass.states.get("sensor.home_passes_next_24_hours").state) == count + 1
    assert await sent() == []

    # A new prediction run sends the events again.
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert await sent() == ["event"]
    await client.close()
    await hass.async_block_till_done()


@pytest.mark.usefixtures("mock_pysatellitespotter")
async def test_calendar_trigger_before_a_pass(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    """The README's automation: a calendar trigger ten minutes before each pass."""
    entry = await _setup(hass)
    p = entry.runtime_data.data.passes[3]
    pass_start, _ = event_times(p)
    await advance(hass, freezer, pass_start - timedelta(minutes=20))

    calls = async_mock_service(hass, "test", "automation")
    assert await async_setup_component(
        hass,
        "automation",
        {
            "automation": {
                "triggers": {
                    "trigger": "calendar",
                    "event": "start",
                    "offset": "-0:10:0",
                    "entity_id": CALENDAR,
                },
                "actions": {
                    "action": "test.automation",
                    "data": {
                        "summary": "{{ trigger.calendar_event.summary }}",
                        "start": "{{ trigger.calendar_event.start }}",
                        "uid": "{{ trigger.calendar_event.uid }}",
                    },
                },
            }
        },
    )
    await hass.async_block_till_done()

    await advance(hass, freezer, pass_start - timedelta(minutes=10, seconds=1))
    assert not calls
    await advance(hass, freezer, pass_start - timedelta(minutes=10) + timedelta(seconds=1))
    assert len(calls) == 1
    assert calls[0].data["summary"] == _ref_summary(p)
    assert calls[0].data["uid"] == p.id
    assert dt_util.parse_datetime(calls[0].data["start"]) == pass_start

    # Stops the trigger's polling, which would outlast the test.
    await hass.services.async_call("automation", "turn_off", {"entity_id": "all"}, blocking=True)


@pytest.mark.usefixtures("mock_pysatellitespotter")
@pytest.mark.parametrize(
    ("language", "summary", "appears", "brightest"),
    [
        ("de", "🛰️ BlueWalker 3 (hell)", "Erscheint um {} im WNW, 37° über dem Horizont.",
         "(Helligkeit 0,3)"),
        # Regional variants get their language's text, as on the globe.
        ("de-CH", "🛰️ BlueWalker 3 (hell)", "Erscheint um {} im WNW, 37° über dem Horizont.",
         "(Helligkeit 0,3)"),
        ("pt", "🛰️ BlueWalker 3 (brilhante)",
         "Aparece às {} na direção ONO, a 37° de altura.", "(magnitude 0,3)"),
        ("fr", "🛰️ BlueWalker 3 (brillant)",
         "Apparaît à {} dans le secteur O-NO, à 37° de hauteur.", "(magnitude 0,3)"),
        # Languages without a translation get English.
        ("ja", "🛰️ BlueWalker 3 (bright)", "Appears at {} in the WNW, 37° up.",
         "(magnitude 0.3)"),
    ],
)  # fmt: skip
async def test_events_follow_the_home_assistant_language(
    hass: HomeAssistant, language: str, summary: str, appears: str, brightest: str
) -> None:
    hass.config.language = language
    entry = await _setup(hass)
    entity_id = er.async_get(hass).async_get_entity_id(
        "calendar", DOMAIN, f"{entry.entry_id}_passes"
    )
    events = await _events(hass, NOW, NOW + timedelta(days=1), entity_id)
    p = entry.runtime_data.data.passes[0]
    assert events[0]["summary"] == summary
    lines = events[0]["description"].splitlines()
    assert lines[0] == appears.format(f"{dt_util.as_local(p.primary.start):%H:%M:%S}")
    assert lines[1].endswith(f"{brightest}.")


def test_resolve_language() -> None:
    available = {"en", "de", "es", "fr", "it", "nl", "pl", "pt-BR", "sv"}
    assert resolve_language("de", available) == "de"
    assert resolve_language("pt-BR", available) == "pt-BR"
    assert resolve_language("de-CH", available) == "de"
    assert resolve_language("es-419", available) == "es"
    assert resolve_language("pt", available) == "pt-BR"
    assert resolve_language("pt_BR", available) == "pt-BR"
    assert resolve_language("en-GB", available) == "en"
    assert resolve_language("ja", available) == "en"
    assert resolve_language("zh-Hans", available) == "en"


def _pass(
    start: datetime, magnitude: float, count: int = 1, cloud: int | None = 37
) -> SatellitePass:
    """A pass made up for the text: NW to SE over the NE, 67 degrees up."""
    sat = Satellite(
        norad_id=25544,
        name="ISS",
        magnitude=-1.8,
        model=None,
        omm={},
        epoch=start - timedelta(days=1),
    )
    end = start + timedelta(minutes=6)
    transits = [
        Transit(
            satellite=sat,
            start=start + timedelta(seconds=10 * i),
            end=end,
            min_magnitude=magnitude,
            before_sunset=False,
            limiting_magnitude=4.0,
            rise=LookAngle(315.0, 10.2),
            brightest=LookAngle(45.0, 67.4),
            brightest_time=start + timedelta(minutes=3),
            set=LookAngle(135.0, 24.6),
        )
        for i in range(count)
    ]
    group = TransitGroup(
        start=start,
        end=end,
        min_magnitude=magnitude,
        limiting_magnitude=4.0,
        before_sunset=False,
        transits=transits,
    )
    peak = track.SkyPoint(start.timestamp() + 180, 45.0, 67.4)
    shape = track.TransitShape(peak, "rise", "shadow")
    return SatellitePass(
        id=f"25544-{int(start.timestamp())}",
        group=group,
        cloud_cover=cloud,
        shapes=[shape] * count,
        peak=peak,
    )


def test_every_pass_lasts_at_least_a_second() -> None:
    noon = datetime(2026, 10, 12, 12, 0, tzinfo=UTC)
    p = _pass(noon, -1.0)
    p.group.end = noon
    start, end = event_times(p)
    assert (start, end - start) == (noon, timedelta(seconds=1))
    assert start.tzinfo is not None


def _common(language: str) -> dict[str, str]:
    path = INTEGRATION / "translations" / f"{language}.json"
    return json.loads(path.read_text(encoding="utf-8"))["common"]


def _placeholders(text: str) -> set[str]:
    return {name for _, name, _, _ in string.Formatter().parse(text) if name}


@pytest.mark.parametrize("language", LANGUAGES)
def test_every_language_describes_a_pass(language: str) -> None:
    """Every translation has all the calendar's words, with the placeholders filled in."""
    english, local = _common("en"), _common(language)
    assert local.keys() == english.keys()
    for key, text in local.items():
        assert _placeholders(text) == _placeholders(english[key]), key

    text = PassText(local)
    when = datetime(2026, 10, 12, 20, 0, tzinfo=UTC)
    for magnitude, count, cloud in ((-3.44, 2, 37), (-0.04, 1, None), (2.46, 1, 0)):
        p = _pass(when, magnitude, count, cloud)
        summary = text.summary(p)
        description = text.description(p)
        assert pass_title(p) in summary
        assert summary.startswith("🛰️ ")
        assert summary.endswith(")") is p.bright
        lines = description.splitlines()
        assert len(lines) == 4 + (count > 1) + (cloud is not None)
        assert "{" not in description
        assert "}" not in description
        sep = local["decimal_separator"]
        number = {-3.44: f"-3{sep}4", -0.04: f"0{sep}0", 2.46: f"2{sep}5"}[magnitude]
        assert number in lines[1]
        assert "-0" not in lines[1]
        assert local["compass_nw"] in lines[0]
        assert local["compass_ne"] in lines[1]
        assert local["compass_se"] in lines[2]
        for line in lines[:3]:
            assert "°" in line
            assert dt_util.as_local(when).strftime("%H:") in line
        if count > 1:
            assert "2" in lines[3]
        if cloud is not None:
            assert f"{cloud}" in lines[-2]
        assert lines[-1].endswith("https://en.wikipedia.org/wiki/International_Space_Station")
