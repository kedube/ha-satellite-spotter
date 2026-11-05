"""What the predictions answer: which pass, and when the next change comes."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter import track
from custom_components.satellite_spotter.const import PASS_ID_TOLERANCE, UPCOMING_WINDOW
from custom_components.satellite_spotter.coordinator import ListedPass, Predictions
from custom_components.satellite_spotter.predict import Moment, Satellite, Sighting

START = datetime(2026, 11, 6, 20, tzinfo=UTC)
NOTICE = timedelta(minutes=15)
MINUTE = timedelta(minutes=1)


def _sighting(norad_id: int, start: datetime, magnitude: float) -> Sighting:
    return Sighting(
        satellite=Satellite(norad_id, str(norad_id), magnitude, None, {}, start),
        appears=Moment(start, 315.0, 10.0),
        brightest=Moment(start + 2 * MINUTE, 45.0, 60.0),
        vanishes=Moment(start + 5 * MINUTE, 135.0, 10.0),
        peak_magnitude=magnitude,
        sky_limit=4.0,
        sun_up=False,
    )


def _pass(*sightings: Sighting) -> ListedPass:
    start = min(s.appears.time for s in sightings)
    peak = track.SkyPoint(start.timestamp(), 45.0, 60.0)
    return ListedPass(
        list(sightings),
        id=str(int(start.timestamp())),
        cloud_cover=None,
        shapes=[],
        peak=peak,
    )


def _predictions(*passes: ListedPass) -> Predictions:
    return Predictions(
        passes=list(passes),
        searched_at=START,
        catalog_version=1,
        satellites={},
        cloud_forecast=None,
    )


def test_a_listed_pass_is_a_flyover() -> None:
    p = _pass(_sighting(1, START, 2.0), _sighting(2, START + MINUTE, -1.0))
    assert p.title == "2 +1"
    assert p.bright
    assert p.start == START
    assert p.end == START + 6 * MINUTE
    assert p.duration == 360


def test_next_change_walks_through_a_bright_pass() -> None:
    predictions = _predictions(_pass(_sighting(25544, START, -2.0)))
    moments = [
        START - UPCOMING_WINDOW,
        START - NOTICE,
        START,
        START + 5 * MINUTE,
    ]
    now = START - UPCOMING_WINDOW - MINUTE
    for moment in moments:
        assert predictions.next_change(now, NOTICE) == moment
        now = moment
    assert predictions.next_change(now, NOTICE) is None


def test_a_faint_pass_gives_advance_notice_too() -> None:
    predictions = _predictions(_pass(_sighting(1, START, 2.0)))
    assert predictions.next_change(START - UPCOMING_WINDOW, NOTICE) == START - NOTICE


def test_advance_notice_counts_from_the_bright_satellite() -> None:
    """A big group can start long before the satellite that makes it bright appears."""
    p = _pass(_sighting(1, START, 2.0), _sighting(2, START + 30 * MINUTE, -2.0))
    assert p.notice_at(NOTICE) == START + 15 * MINUTE
    predictions = _predictions(p)
    assert predictions.next_change(START - MINUTE, NOTICE) == START
    assert predictions.next_change(START, NOTICE) == START + 15 * MINUTE
    assert predictions.next_change(START + 15 * MINUTE, NOTICE) == START + 35 * MINUTE


async def test_bright_pass_soon_waits_for_the_bright_satellite(
    init_integration: MockConfigEntry,
) -> None:
    coordinator = init_integration.runtime_data
    p = _pass(_sighting(1, START, 2.0), _sighting(2, START + 30 * MINUTE, -2.0))
    coordinator.data = _predictions(p)
    notice = START + 30 * MINUTE - coordinator.settings.alert_lead
    assert notice > START
    second = timedelta(seconds=1)
    assert coordinator.bright_pass_soon(START) is None, "only the faint one is up"
    assert coordinator.bright_pass_soon(notice - second) is None
    assert coordinator.bright_pass_soon(notice) is p
    assert coordinator.bright_pass_soon(p.end - second) is p
    assert coordinator.bright_pass_soon(p.end) is None


def test_finding_a_pass_after_a_refresh() -> None:
    """A page's old id still finds the pass when new elements have moved it a little."""
    p = _pass(_sighting(1, START, 2.0), _sighting(2, START + MINUTE, -1.0))
    predictions = _predictions(p)
    start = int(START.timestamp())
    near = int(PASS_ID_TOLERANCE.total_seconds())
    assert predictions.find(p.id) is p
    assert predictions.find(str(start + near)) is p
    assert predictions.find(str(start - near)) is p
    assert predictions.find(str(start + near + 1)) is None
    assert predictions.find("not an id") is None
