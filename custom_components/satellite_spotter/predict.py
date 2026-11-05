"""Which satellites can be seen from a place in the coming days, and when.

The physics is in track.py, so what is listed and what is drawn cannot disagree.
This module is the search. Every satellite is placed once a minute to find the
stretches when it might be visible, and each stretch is then worked out second
by second with SGP4 itself, so a pass's times depend only on its orbital elements
and not on when the search began. A pass shorter than a minute can fall between
two samples and be missed.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import math
from operator import attrgetter
from typing import Any, NamedTuple

import numpy as np
from sgp4.api import WGS72, Satrec

from . import track
from .const import DEFAULT_MAX_MAGNITUDE, PREDICTION_DAYS

# Minutes are sampled, so the brightest moment can fall between two of them: the
# search looks this much past the cutoff, and the exact pass applies the real one.
_SEARCH_MARGIN = 2.0
_SEARCH_STEP_S = 60
# How many satellites are propagated at once, in order of how bright they can get.
_BATCH = 48

# Sightings this close, or overlapping, make one flyover.
_FLYOVER_GAP = timedelta(seconds=60)
# Fewer Starlinks than this are not a train, only noise beside what else is passing.
_TRAIN_SIZE = 5
# A flyover is bright when it beats this magnitude, and the sky's limit by this
# much, after sunset.
_BRIGHT_MAGNITUDE = 0.5
_BRIGHT_OVER_SKY = 3.0
# Starlinks are listed this much past the cutoff: at the default most trains would go otherwise.
_STARLINK_MARGIN = 0.75

# The largest number SGP4's records can hold (Alpha-5). New launches can carry nine
# digit temporary numbers; the number plays no part in the orbit.
_LARGEST_RECORD_NUMBER = 339999
# SGP4 counts its epoch in days from here, and its rates in minutes.
_SGP4_DAY_ZERO = datetime(1949, 12, 31, tzinfo=UTC)
_MINUTES_A_DAY = 1440


@dataclass(slots=True)
class Satellite:
    """An object in orbit: how it moves, and how bright it is."""

    norad_id: int
    name: str
    # Its magnitude at 1000 km and half lit; None when a published curve applies instead.
    standard_magnitude: float | None
    # The published curve it follows, if any (see track.py).
    curve: str | None
    # Orbital elements under their CCSDS names, as strings, as CelesTrak publishes them.
    elements: Mapping[str, str]
    epoch: datetime

    @classmethod
    def from_elements(
        cls,
        elements: Mapping[str, object],
        standard_magnitude: float | None = None,
        *,
        curve: str | None = None,
        name: str | None = None,
    ) -> Satellite:
        """Build a satellite from orbital elements, strings or numbers."""
        text = {field: str(value) for field, value in elements.items()}
        return cls(
            int(text["NORAD_CAT_ID"]),
            name or text["OBJECT_NAME"],
            standard_magnitude,
            curve,
            text,
            datetime.fromisoformat(text["EPOCH"]).replace(tzinfo=UTC),
        )

    def sgp4_record(self) -> Satrec:
        """Return the record SGP4 propagates, from the elements in their published units."""

        def element(field: str) -> float:
            return float(self.elements[field])

        record = Satrec()
        record.sgp4init(
            WGS72,
            "i",
            self.norad_id if self.norad_id <= _LARGEST_RECORD_NUMBER else 0,
            (self.epoch - _SGP4_DAY_ZERO).total_seconds() / 86400,
            element("BSTAR"),
            # Revolutions a day, and its rates of change, as radians a minute.
            element("MEAN_MOTION_DOT") * math.tau / _MINUTES_A_DAY**2,
            element("MEAN_MOTION_DDOT") * math.tau / _MINUTES_A_DAY**3,
            element("ECCENTRICITY"),
            math.radians(element("ARG_OF_PERICENTER")),
            math.radians(element("INCLINATION")),
            math.radians(element("MEAN_ANOMALY")),
            element("MEAN_MOTION") * math.tau / _MINUTES_A_DAY,
            math.radians(element("RA_OF_ASC_NODE")),
        )
        return record


def _is_starlink(sat: Satellite) -> bool:
    return sat.name[:8].casefold() == "starlink"


def cutoff_for(sat: Satellite, faintest: float) -> float:
    """Return the faintest magnitude at which this satellite is listed."""
    return faintest + (_STARLINK_MARGIN if _is_starlink(sat) else 0.0)


class Moment(NamedTuple):
    """A moment of a sighting: when it is, and where to look then."""

    time: datetime
    # Degrees clockwise from north, and degrees above the horizon.
    azimuth: float
    elevation: float


@dataclass(slots=True)
class Sighting:
    """One satellite, visible once."""

    satellite: Satellite
    appears: Moment
    brightest: Moment
    # The first second it can no longer be seen, and the last place it was.
    vanishes: Moment
    peak_magnitude: float
    # How faint a star the sky shows as it appears.
    sky_limit: float
    # Whether the Sun is still up as it appears.
    sun_up: bool


@dataclass(slots=True)
class Flyover:
    """What can be seen at about the same time: the brightest, then the rest as they appear.

    The brightest names it, so that what is said of a flyover (its magnitude, whether it
    is bright) is true of the satellite named, and being first it survives a list cut short.
    """

    sightings: list[Sighting]

    def __post_init__(self) -> None:
        """Put the brightest first; the first to appear of any that tie."""
        brightest = min(self.sightings, key=attrgetter("peak_magnitude"))
        self.sightings = [brightest, *(s for s in self.sightings if s is not brightest)]

    @property
    def start(self) -> datetime:
        """When the first satellite appears."""
        return min(sighting.appears.time for sighting in self.sightings)

    @property
    def end(self) -> datetime:
        """When nothing is left to see."""
        return max(sighting.vanishes.time for sighting in self.sightings)

    @property
    def duration(self) -> int:
        """How long it lasts, in whole seconds."""
        return round((self.end - self.start).total_seconds())

    @property
    def lead(self) -> Sighting:
        """The brightest, which the flyover is named after."""
        return self.sightings[0]

    @property
    def peak_magnitude(self) -> float:
        """The magnitude of the brightest moment of any of them."""
        return self.lead.peak_magnitude

    @property
    def sky_limit(self) -> float:
        """The strictest of their skies."""
        return min(sighting.sky_limit for sighting in self.sightings)

    @property
    def sun_up(self) -> bool:
        """Whether any of them appears with the Sun still up."""
        return any(sighting.sun_up for sighting in self.sightings)

    @property
    def title(self) -> str:
        """What to call it: "ISS", or "ISS +3" with three others to see."""
        name = self.lead.satellite.name
        return name if self.count == 1 else f"{name} +{self.count - 1}"

    @property
    def count(self) -> int:
        """How many satellites there are to see."""
        return len(self.sightings)

    @property
    def bright(self) -> bool:
        """Whether it is hard to miss: bright in itself, and against a dark enough sky."""
        if self.sun_up or self.peak_magnitude >= _BRIGHT_MAGNITUDE:
            return False
        return self.sky_limit - self.peak_magnitude > _BRIGHT_OVER_SKY


def _stretches(flags: np.ndarray) -> list[tuple[int, int]]:
    """Return [first, past the last) of each stretch of True values."""
    padded = np.concatenate(([False], flags, [False]))
    changes = np.flatnonzero(padded[1:] != padded[:-1])
    return [(int(changes[i]), int(changes[i + 1])) for i in range(0, len(changes), 2)]


def _exact_sightings(
    sat: Satellite,
    record: Satrec,
    observer: track.Observer,
    since: float,
    until: float,
    faintest: float,
) -> list[Sighting]:
    """Work out, second by second, what can be seen of a satellite in [since, until)."""
    seconds = np.arange(since, until, 1.0)
    places = track.propagate([record], seconds)[0]
    with np.errstate(invalid="ignore"):
        light = track.photometry(sat, observer, places, track.sun_at(seconds))
        visible = track.visible(light, faintest)

    def moment(second: float, place: int) -> Moment:
        azimuth, elevation, _ = track.look(observer, places[place])
        return Moment(
            datetime.fromtimestamp(second, UTC),
            round(float(azimuth), 1),
            round(float(elevation), 1),
        )

    found = []
    for first, past in _stretches(visible):
        peak = first + int(np.argmin(light.magnitude[first:past]))
        # When the stretch runs off the end, the next one starts there.
        gone = seconds[past] if past < len(seconds) else until
        found.append(
            Sighting(
                satellite=sat,
                appears=moment(seconds[first], first),
                brightest=moment(seconds[peak], peak),
                vanishes=moment(gone, past - 1),
                peak_magnitude=float(light.magnitude[peak]),
                sky_limit=float(light.limiting[first]),
                sun_up=bool(light.sun_angle[first] < math.pi / 2),
            )
        )
    return found


def find_sightings(
    satellites: Sequence[Satellite],
    observer: track.Observer,
    *,
    start: datetime,
    days: float = PREDICTION_DAYS,
    faintest: float = DEFAULT_MAX_MAGNITUDE,
) -> list[Sighting]:
    """Find everything these satellites show a place, in order of appearance.

    A sighting cut off at the end of the time is left for the next search; one
    already under way at the start begins there.
    """
    origin = start.astimezone(UTC).replace(microsecond=0).timestamp()
    minutes = origin + _SEARCH_STEP_S * np.arange(int(days * 1440), dtype=float)
    sun = track.sun_at(minutes)
    sky_limit = track.sky_limit(observer, sun)

    # Brightest first, so that each batch can skip the minutes too light for its best.
    best = {id(sat): track.brightest_possible(sat, observer) for sat in satellites}
    cutoff = {id(sat): cutoff_for(sat, faintest) for sat in satellites}
    worth_trying = [sat for sat in satellites if best[id(sat)] < cutoff[id(sat)]]
    worth_trying.sort(key=lambda sat: best[id(sat)])

    found: list[Sighting] = []
    for offset in range(0, len(worth_trying), _BATCH):
        batch = worth_trying[offset : offset + _BATCH]
        # Keep each dark minute's neighbours too: the exact search starts from them.
        dark = np.concatenate(([False], sky_limit >= best[id(batch[0])], [False]))
        sampled = np.flatnonzero(dark[:-2] | dark[1:-1] | dark[2:])
        if sampled.size == 0:
            continue
        records = [sat.sgp4_record() for sat in batch]
        places = track.propagate(records, minutes[sampled])
        with np.errstate(invalid="ignore"):
            risen = track.above_horizon(observer, places)
        for row, sat in enumerate(batch):
            up = np.flatnonzero(risen[row])
            if up.size == 0:
                continue
            with np.errstate(invalid="ignore"):
                light = track.photometry(sat, observer, places[row, up], sun[sampled[up]])
                seen = track.visible(light, cutoff[id(sat)] + _SEARCH_MARGIN)
            promising = np.zeros(minutes.size, dtype=bool)
            promising[sampled[up[seen]]] = True
            for first, past in _stretches(promising):
                # Still going at the end of the time: the next search has it whole.
                if past == minutes.size:
                    continue
                found += _exact_sightings(
                    sat,
                    records[row],
                    observer,
                    float(minutes[max(first - 1, 0)]),
                    float(minutes[past]),
                    cutoff[id(sat)],
                )

    # Those that appear together keep the catalog's order.
    position = {id(sat): index for index, sat in enumerate(satellites)}
    found.sort(key=lambda sighting: (sighting.appears.time, position[id(sighting.satellite)]))
    return found


def _worth_listing(sightings: list[Sighting]) -> list[Sighting]:
    """Drop the Starlinks of a flyover unless there are enough of them for a train."""
    others = [sighting for sighting in sightings if not _is_starlink(sighting.satellite)]
    starlinks = len(sightings) - len(others)
    return others if 0 < starlinks < _TRAIN_SIZE else sightings


def group_sightings(sightings: Iterable[Sighting]) -> list[Flyover]:
    """Join sightings that overlap or nearly do into flyovers."""
    joined: list[list[Sighting]] = []
    latest_end = datetime.min.replace(tzinfo=UTC)
    for sighting in sorted(sightings, key=lambda sighting: sighting.appears.time):
        if not joined or sighting.appears.time - latest_end > _FLYOVER_GAP:
            joined.append([])
            latest_end = sighting.vanishes.time
        joined[-1].append(sighting)
        latest_end = max(latest_end, sighting.vanishes.time)
    kept = (_worth_listing(members) for members in joined)
    return [Flyover(members) for members in kept if members]


def read_catalog(entries: Iterable[Mapping[str, Any]]) -> list[Satellite]:
    """Read a catalog written by write_catalog."""
    return [
        Satellite.from_elements(
            entry["elements"],
            None if entry.get("magnitude") is None else float(entry["magnitude"]),
            curve=entry.get("model"),
            name=entry["name"],
        )
        for entry in entries
    ]


def write_catalog(satellites: Iterable[Satellite]) -> list[dict[str, Any]]:
    """Write a catalog for storage, whose field names stay so that a stored copy stays usable."""
    return [
        {
            "name": sat.name,
            "elements": dict(sat.elements),
            "magnitude": (
                sat.standard_magnitude
                if sat.standard_magnitude is not None and math.isfinite(sat.standard_magnitude)
                else None
            ),
            "model": sat.curve,
        }
        for sat in satellites
    ]
