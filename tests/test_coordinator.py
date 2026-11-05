"""What the predictions answer: which pass, and when the next change comes."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

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
    lead = min(sightings, key=lambda s: s.peak_magnitude)
    start = min(s.appears.time for s in sightings)
    peak = track.SkyPoint(start.timestamp(), 45.0, 60.0)
    return ListedPass(
        list(sightings),
        id=f"{lead.satellite.norad_id}-{int(start.timestamp())}",
        cloud_cover=None,
        shapes=[],
        peak=peak,
    )


def _predictions(*passes: ListedPass) -> Predictions:
    return Predictions(
        passes=list(passes),
        computed_at=START,
        catalog_version=1,
        satellites={},
        cloud_cover=None,
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


def test_a_faint_pass_gives_no_advance_notice() -> None:
    predictions = _predictions(_pass(_sighting(1, START, 2.0)))
    assert predictions.next_change(START - UPCOMING_WINDOW, NOTICE) == START


def test_finding_a_pass_after_a_refresh() -> None:
    """A page's old id still finds the pass: moved a little, or named differently now."""
    p = _pass(_sighting(1, START, 2.0), _sighting(2, START + MINUTE, -1.0))
    predictions = _predictions(p)
    start = int(START.timestamp())
    near = PASS_ID_TOLERANCE.total_seconds() - 1
    assert predictions.find(p.id) is p
    assert predictions.find(f"2-{start + int(near)}") is p
    # It was named after the other satellite before the refresh.
    assert predictions.find(f"1-{start}") is p
    assert predictions.find(f"3-{start}") is None
    assert predictions.find(f"2-{start + int(near) + 3600}") is None
    assert predictions.find("not an id") is None
