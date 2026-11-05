"""The calendar of passes: events, ranges, words in several languages, and when state is written."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.calendar import CalendarEntity
from homeassistant.components.calendar.const import DATA_COMPONENT
from homeassistant.core import HomeAssistant, State
from homeassistant.util import dt as dt_util
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.satellite_spotter.calendar import (
    PassText,
    event_times,
    resolve_language,
)
from custom_components.satellite_spotter.celestrak import CatalogError

from .common import (
    INTEGRATION,
    NOW,
    add_location,
    advance,
    bright_pass,
    dim_pass,
    listed,
    satellites,
    sighting,
    with_epoch,
)

CALENDAR = "calendar.home_visible_passes"
SECOND = timedelta(seconds=1)
LANGUAGES = {path.stem for path in (INTEGRATION / "translations").glob("*.json")}


def state_of(hass: HomeAssistant) -> State:
    state = hass.states.get(CALENDAR)
    assert state is not None
    return state


def text_in(language: str) -> PassText:
    path = INTEGRATION / "translations" / f"{language}.json"
    return PassText(json.loads(path.read_text(encoding="utf-8"))["common"])


def the_entity(hass: HomeAssistant) -> CalendarEntity:
    entity = hass.data[DATA_COMPONENT].get_entity(CALENDAR)
    assert entity is not None
    return entity


async def events_between(
    hass: HomeAssistant, start: datetime, end: datetime
) -> list[dict[str, Any]]:
    """Ask for events the way an automation or a script would."""
    answer: Any = await hass.services.async_call(
        "calendar",
        "get_events",
        {"start_date_time": start.isoformat(), "end_date_time": end.isoformat()},
        target={"entity_id": CALENDAR},
        blocking=True,
        return_response=True,
    )
    events: list[dict[str, Any]] = answer[CALENDAR]["events"]
    return events


@pytest.fixture(autouse=True)
async def _clock_and_zone(hass: HomeAssistant, freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)
    await hass.config.async_set_time_zone("Pacific/Honolulu")


# Events.


async def test_the_state_is_off_with_the_next_pass_as_its_event(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    # NOW is 05:30 in Honolulu.
    p = bright_pass(datetime(2026, 11, 4, 16, 0, tzinfo=UTC))
    predict_passes.return_value = [p]
    await add_location(hass)
    state = state_of(hass)
    assert state.state == "off"
    assert state.attributes["message"] == "🌟 ISS"
    assert state.attributes["start_time"] == "2026-11-04 06:00:00"
    assert state.attributes["end_time"] == "2026-11-04 06:05:00"
    assert state.attributes["all_day"] is False


async def test_the_state_is_on_during_the_event_to_the_second(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    first = dim_pass(NOW + timedelta(minutes=10), 60, name="FIRST", norad_id=1)
    second = dim_pass(NOW + timedelta(minutes=20), 60, name="SECOND", norad_id=2)
    predict_passes.return_value = [first, second]
    await add_location(hass)

    await advance(hass, freezer, first.start - SECOND)
    assert state_of(hass).state == "off"
    await advance(hass, freezer, first.start)
    assert state_of(hass).state == "on"
    assert state_of(hass).attributes["message"] == "🔭 FIRST"
    await advance(hass, freezer, first.end - SECOND)
    assert state_of(hass).state == "on"
    await advance(hass, freezer, first.end)
    assert state_of(hass).state == "off"
    assert state_of(hass).attributes["message"] == "🔭 SECOND"


async def test_with_no_pass_left_there_is_no_event(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(minutes=10), 60)
    predict_passes.return_value = [p]
    await add_location(hass)
    await advance(hass, freezer, p.start)
    await advance(hass, freezer, p.end)
    state = state_of(hass)
    assert state.state == "off"
    assert "message" not in state.attributes


async def test_no_passes_no_event(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    await add_location(hass)
    assert state_of(hass).state == "off"
    assert the_entity(hass).event is None


async def test_every_pass_for_five_days_is_an_event(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    events = await events_between(hass, NOW, NOW + timedelta(days=6))
    passes = init_integration.runtime_data.predictions.passes
    assert len(events) == len(passes) == 17
    assert [event["summary"].split(" ", 1)[1] for event in events] == [p.title for p in passes]


async def test_events_have_the_id_of_the_pass_over_http(
    hass: HomeAssistant,
    hass_client: ClientSessionGenerator,
    init_integration: MockConfigEntry,
) -> None:
    client = await hass_client()
    answer = await client.get(
        f"/api/calendars/{CALENDAR}",
        params={
            "start": (NOW + timedelta(minutes=5)).isoformat(),
            "end": (NOW + timedelta(minutes=20)).isoformat(),
        },
    )
    assert answer.status == 200
    events = await answer.json()
    assert len(events) == 1
    assert events[0]["uid"] == "1793806752"
    assert events[0]["summary"] == "🌟 ISS"


# The range.


@pytest.mark.parametrize(
    ("from_start", "from_end", "found"),
    [
        pytest.param(timedelta(minutes=-10), timedelta(0), False, id="ends as the pass starts"),
        pytest.param(timedelta(minutes=-10), SECOND, True, id="ends a second into the pass"),
        pytest.param(
            timedelta(seconds=299), timedelta(minutes=10), True, id="starts in the last second"
        ),
        pytest.param(timedelta(seconds=300), timedelta(minutes=10), False, id="starts as it ends"),
        pytest.param(timedelta(seconds=100), timedelta(seconds=200), True, id="inside the pass"),
        pytest.param(timedelta(seconds=-100), timedelta(seconds=400), True, id="around the pass"),
    ],
)
async def test_events_overlapping_the_range_are_returned(
    hass: HomeAssistant,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
    from_start: timedelta,
    from_end: timedelta,
    found: bool,
) -> None:
    start = NOW + timedelta(hours=1)
    predict_passes.return_value = [bright_pass(start, 300)]
    await add_location(hass)
    events = await events_between(hass, start + from_start, start + from_end)
    assert bool(events) is found


async def test_only_the_passes_in_the_range_come_back_and_in_order(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    passes = [dim_pass(NOW + timedelta(hours=n), 60, name=f"P{n}", norad_id=n) for n in range(1, 5)]
    predict_passes.return_value = passes
    await add_location(hass)
    events = await events_between(hass, NOW + timedelta(hours=2), NOW + timedelta(hours=4))
    assert [event["summary"] for event in events] == ["🔭 P2", "🔭 P3"]


async def test_event_times_are_local(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    predict_passes.return_value = [bright_pass(datetime(2026, 11, 4, 16, 0, tzinfo=UTC), 300)]
    await add_location(hass)
    events = await events_between(hass, NOW, NOW + timedelta(hours=2))
    assert events[0]["start"] == "2026-11-04T06:00:00-10:00"
    assert events[0]["end"] == "2026-11-04T06:05:00-10:00"


def test_event_times_drop_the_fractions_of_a_second() -> None:
    start = datetime(2026, 11, 4, 16, 0, 0, 900000, tzinfo=UTC)
    p = bright_pass(start, 10)
    first, last = event_times(p)
    assert first == dt_util.as_local(datetime(2026, 11, 4, 16, 0, 0, tzinfo=UTC))
    assert last == dt_util.as_local(datetime(2026, 11, 4, 16, 0, 10, tzinfo=UTC))


@pytest.mark.parametrize("seconds", [0, 0.5])
def test_an_event_lasts_at_least_a_second(seconds: float) -> None:
    p = bright_pass(NOW, seconds)
    first, last = event_times(p)
    assert last - first == SECOND


def test_an_event_of_exactly_a_second_stays_a_second() -> None:
    first, last = event_times(bright_pass(NOW, 1))
    assert last - first == SECOND


# The words.


def test_a_bright_pass_has_a_star_and_others_a_telescope_in_every_language() -> None:
    # The blueprint recognises the star; CHANGELOG 1.11 says the titles are the same in every one.
    for language in LANGUAGES:
        text = text_in(language)
        assert text.summary(bright_pass(NOW)) == "🌟 ISS"
        assert text.summary(dim_pass(NOW)) == "🔭 ISS"


def test_a_group_is_titled_with_the_lead_and_how_many_others() -> None:
    p = listed(
        sighting(NOW), sighting(NOW, name="B", norad_id=2), sighting(NOW, name="C", norad_id=3)
    )
    assert text_in("en").summary(p) == "🌟 ISS +2"


def _worked_example() -> Any:
    """A pass at 06:00 UTC-10 with everything to say: compare the README's notification."""
    start = datetime(2026, 11, 4, 16, 0, 0, tzinfo=UTC)
    return listed(
        sighting(
            start,
            300,
            peak_magnitude=-2.46,
            appears=(270.0, 21.2),
            best_view=(315.0, 39.6),
            disappears=(90.0, 10.0),
        ),
        sighting(start, 120, name="OTHER", norad_id=2, peak_magnitude=1.0),
        cloud_cover=12,
    )


@pytest.mark.parametrize("language", sorted(LANGUAGES))
async def test_every_language_fills_in_the_whole_description(
    hass: HomeAssistant, language: str
) -> None:
    words = json.loads((INTEGRATION / "translations" / f"{language}.json").read_text("utf-8"))[
        "common"
    ]
    description = text_in(language).description(_worked_example())
    assert "{" not in description
    assert "}" not in description
    best, first, last, clouds, others, link = description.split("\n")
    assert all(when in line for when, line in zip(
        ("06:02:30", "06:00:00", "06:05:00"), (best, first, last), strict=True
    ))  # fmt: skip
    assert all(height in line for height, line in zip(
        ("40°", "21°", "10°"), (best, first, last), strict=True
    ))  # fmt: skip
    assert words["compass_nw"] in best
    assert f"-2{words['decimal_separator']}5" in best
    assert words["compass_w"] in first
    assert words["compass_e"] in last
    assert "12" in clouds
    assert "2" in others
    assert link.endswith("https://en.wikipedia.org/wiki/International_Space_Station")


async def test_the_description_in_english_worked_out_by_hand(hass: HomeAssistant) -> None:
    assert text_in("en").description(_worked_example()).split("\n") == [
        "Best view at 06:02:30: NW, 40° high, magnitude -2.5.",
        "First visible at 06:00:00 toward W, 21° high.",
        "Last visible at 06:05:00 toward E, 10° high.",
        "Cloud cover near the pass: 12%.",
        "This pass includes 2 satellites.",
        "Object: ISS — https://en.wikipedia.org/wiki/International_Space_Station",
    ]


async def test_the_description_in_german_worked_out_by_hand(hass: HomeAssistant) -> None:
    assert text_in("de").description(_worked_example()).split("\n") == [
        "Beste Sicht um 06:02:30: NW, 40° hoch, Helligkeit -2,5.",
        "Zuerst sichtbar um 06:00:00 in Richtung W, 21° hoch.",
        "Zuletzt sichtbar um 06:05:00 in Richtung O, 10° hoch.",
        "Bewölkung während des Überflugs: 12 %.",
        "Zu diesem Überflug gehören 2 Satelliten.",
        "Objekt: ISS — https://en.wikipedia.org/wiki/International_Space_Station",
    ]


async def test_the_description_in_french_uses_french_winds_and_a_comma(hass: HomeAssistant) -> None:
    description = text_in("fr").description(_worked_example())
    # compass_nw is "NO" in French, and the magnitude takes a comma.
    assert "NO" in description.split("\n")[0]
    assert "-2,5" in description.split("\n")[0]


async def test_a_single_satellite_says_nothing_about_a_group(hass: HomeAssistant) -> None:
    lines = text_in("en").description(bright_pass(NOW, cloud_cover=5)).split("\n")
    assert len(lines) == 5
    assert not any("includes" in line for line in lines)
    assert any("Cloud cover" in line for line in lines)


async def test_no_forecast_says_nothing_about_clouds(hass: HomeAssistant) -> None:
    lines = text_in("en").description(bright_pass(NOW)).split("\n")
    assert len(lines) == 4
    assert not any("Cloud cover" in line for line in lines)


async def test_a_clear_sky_is_still_mentioned(hass: HomeAssistant) -> None:
    assert "Cloud cover near the pass: 0%." in text_in("en").description(
        bright_pass(NOW, cloud_cover=0)
    )


async def test_the_link_comes_last_and_is_for_the_brightest(hass: HomeAssistant) -> None:
    # The blueprint and the README's automation drop the last line of the description.
    p = listed(
        sighting(NOW, name="FAINT", norad_id=7, peak_magnitude=1.0),
        sighting(NOW, name="LEAD", norad_id=8, peak_magnitude=0.0),
        cloud_cover=50,
    )
    last = text_in("en").description(p).split("\n")[-1]
    assert last == "Object: LEAD — https://www.n2yo.com/satellite/?s=8"


async def test_a_magnitude_of_exactly_zero_after_rounding_is_not_negative(
    hass: HomeAssistant,
) -> None:
    description = text_in("en").description(bright_pass(NOW, peak_magnitude=-0.04))
    assert "magnitude 0.0." in description


async def test_times_in_the_description_follow_home_assistants_time_zone(
    hass: HomeAssistant,
) -> None:
    await hass.config.async_set_time_zone("Europe/Amsterdam")
    start = datetime(2026, 11, 4, 16, 0, tzinfo=UTC)
    assert "First visible at 17:00:00" in text_in("en").description(bright_pass(start))


async def test_the_calendar_speaks_home_assistants_language(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    start = datetime(2026, 11, 4, 16, 0, tzinfo=UTC)
    predict_passes.return_value = [bright_pass(start, cloud_cover=30)]
    hass.config.language = "de"
    await add_location(hass)
    entity = hass.data[DATA_COMPONENT].entities
    calendar = next(iter(entity))
    event = calendar.event
    assert event is not None
    assert event.summary == "🌟 ISS"
    assert event.description is not None
    assert "Beste Sicht um 06:02:30" in event.description
    assert "-2,0" in event.description
    assert "30 %" in event.description
    assert event.uid == str(int(start.timestamp()))


async def test_the_calendar_defaults_to_english(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    predict_passes.return_value = [bright_pass(NOW + timedelta(hours=1))]
    await add_location(hass)
    event = the_entity(hass).event
    assert event is not None
    assert event.description is not None
    assert "Best view at" in event.description
    assert state_of(hass).attributes["description"] == event.description


@pytest.mark.parametrize(
    ("asked", "answer"),
    [
        ("de", "de"),
        ("pt-BR", "pt-BR"),
        ("pt_BR", "pt-BR"),
        ("pt", "pt-BR"),
        ("pt-PT", "pt-BR"),
        ("PT-pt", "pt-BR"),
        ("de-AT", "de"),
        ("sv", "sv"),
        ("en", "en"),
        ("en-GB", "en"),
        ("ja", "en"),
        ("", "en"),
    ],
)
def test_resolve_language_prefers_exact_then_base_then_english(asked: str, answer: str) -> None:
    assert resolve_language(asked, LANGUAGES) == answer


def test_resolve_language_takes_the_first_with_the_same_base() -> None:
    assert resolve_language("zh", ["zh-Hant", "zh-Hans", "en"]) == "zh-Hans"


def test_resolve_language_falls_back_to_english_even_when_it_is_not_offered() -> None:
    assert resolve_language("ja", ["de"]) == "en"


# When state is written: every write makes open calendars fetch.


async def test_a_wake_up_writes_no_state(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = bright_pass(NOW + timedelta(hours=1))
    predict_passes.return_value = [p]
    await add_location(hass)
    written = state_of(hass).last_reported

    # The notice is a change for the sensors, and none for the calendar.
    notice = p.start - timedelta(minutes=15)
    await advance(hass, freezer, notice + SECOND)
    bright_soon = hass.states.get("binary_sensor.home_bright_pass_soon")
    assert bright_soon is not None
    assert bright_soon.state == "on"
    assert state_of(hass).last_reported == written


async def test_a_new_prediction_run_writes_state(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    await add_location(hass)
    written = state_of(hass).last_reported
    refresh = NOW + timedelta(hours=2)
    await advance(hass, freezer, refresh)
    assert state_of(hass).last_reported != written
    assert state_of(hass).last_reported == refresh


async def test_a_failed_refresh_writes_state_once_and_recovering_writes_again(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    entry = await add_location(hass)
    assert state_of(hass).state == "off"

    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    failed = NOW + timedelta(days=20)
    await advance(hass, freezer, failed)
    assert state_of(hass).state == "unavailable"
    assert state_of(hass).last_reported == failed

    # Failing again changes nothing the calendar shows, and writes nothing.
    again = failed + timedelta(minutes=5, seconds=1)
    await advance(hass, freezer, again)
    assert not entry.runtime_data.last_update_success
    assert state_of(hass).last_reported == failed

    mock_downloads["fetch_catalog"].side_effect = None
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, failed) for s in satellites()]
    back = again + timedelta(minutes=5, seconds=1)
    await advance(hass, freezer, back)
    assert entry.runtime_data.last_update_success
    assert state_of(hass).state == "off"
    assert state_of(hass).last_reported == back


# Paused.


async def test_paused_predictions_empty_the_calendar(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    start = NOW + timedelta(days=20, hours=1)
    predict_passes.return_value = [bright_pass(start)]
    await add_location(hass)
    entity = the_entity(hass)
    assert await entity.async_get_events(hass, start - SECOND, start + SECOND)

    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    await advance(hass, freezer, NOW + timedelta(days=20))
    assert state_of(hass).state == "unavailable"
    assert await entity.async_get_events(hass, start - SECOND, start + SECOND) == []
    assert entity.event is None


async def test_the_event_is_the_first_not_over_by_its_own_times(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    # A pass ending in a fraction of a second is over at its whole second.
    start = NOW + timedelta(minutes=10)
    first = dim_pass(start, 60.5, name="FIRST", norad_id=1)
    second = dim_pass(NOW + timedelta(minutes=20), 60, name="SECOND", norad_id=2)
    predict_passes.return_value = [first, second]
    await add_location(hass)
    entity = the_entity(hass)
    freezer.move_to(start + timedelta(seconds=59))
    assert entity.event is not None
    assert entity.event.summary == "🔭 FIRST"
    freezer.move_to(start + timedelta(seconds=60))
    assert entity.event is not None
    assert entity.event.summary == "🔭 SECOND"
