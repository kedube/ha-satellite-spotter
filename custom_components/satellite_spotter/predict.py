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
from sgp4 import omm
from sgp4.api import Satrec

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
_BRIGHT_MAGNITUDE = 1.0
_BRIGHT_OVER_SKY = 3.0

# The largest number SGP4's records can hold (Alpha-5). New launches can carry nine
# digit temporary numbers; the number plays no part in the orbit.
_LARGEST_RECORD_NUMBER = 339999


class Direction(NamedTuple):
    """Where to look: degrees clockwise from north, degrees above the horizon."""

    azimuth: float
    elevation: float


@dataclass(slots=True)
class Satellite:
    """An object in orbit: how it moves, and how bright it is."""

    norad_id: int
    name: str
    # Standard magnitude at 1000 km; None when a brightness model applies instead.
    magnitude: float | None
    # The brightness model it follows, if any (see track.py).
    model: str | None
    # Orbital elements under their CCSDS names, as strings, as CelesTrak publishes them.
    elements: Mapping[str, str]
    epoch: datetime

    @classmethod
    def from_elements(
        cls,
        elements: Mapping[str, object],
        magnitude: float | None,
        model: str | None = None,
        name: str | None = None,
    ) -> Satellite:
        """Build a satellite from orbital elements, strings or numbers."""
        text = {field: str(value) for field, value in elements.items()}
        epoch = datetime.fromisoformat(text["EPOCH"].removesuffix("Z")).replace(tzinfo=UTC)
        return cls(
            int(text["NORAD_CAT_ID"]), name or text["OBJECT_NAME"], magnitude, model, text, epoch
        )

    @property
    def is_starlink(self) -> bool:
        """Whether this is one of SpaceX's Starlinks."""
        return self.name.upper().startswith("STARLINK")

    @property
    def perigee_km(self) -> float:
        """How low the orbit comes, above a spherical Earth."""
        return track.apsides_km(self)[0]

    def sgp4_record(self) -> Satrec:
        """Return the record SGP4 propagates."""
        number = self.norad_id if self.norad_id <= _LARGEST_RECORD_NUMBER else 0
        record = Satrec()
        omm.initialize(
            record,
            {
                # sgp4 reads these labels, and the orbit does not depend on them.
                "CLASSIFICATION_TYPE": "U",
                "OBJECT_ID": "",
                "ELEMENT_SET_NO": "0",
                "REV_AT_EPOCH": "0",
                "EPHEMERIS_TYPE": "0",
                **self.elements,
                "NORAD_CAT_ID": str(number),
                # The only form sgp4 reads: no zone, six decimals.
                "EPOCH": self.epoch.strftime("%Y-%m-%dT%H:%M:%S.%f"),
            },
        )
        return record


@dataclass(slots=True)
class Sighting:
    """One satellite, visible once."""

    satellite: Satellite
    start: datetime
    # The first second it can no longer be seen.
    end: datetime
    appears: Direction
    peak: Direction
    vanishes: Direction
    peak_time: datetime
    peak_magnitude: float
    # How faint a star the sky shows as it appears.
    sky_limit: float
    before_sunset: bool


@dataclass(slots=True)
class Flyover:
    """What can be seen at about the same time, in order of appearance."""

    sightings: list[Sighting]

    @property
    def start(self) -> datetime:
        """When the first satellite appears."""
        return min(sighting.start for sighting in self.sightings)

    @property
    def end(self) -> datetime:
        """When nothing is left to see."""
        return max(sighting.end for sighting in self.sightings)

    @property
    def peak_magnitude(self) -> float:
        """The magnitude of the brightest moment of any of them."""
        return min(sighting.peak_magnitude for sighting in self.sightings)

    @property
    def sky_limit(self) -> float:
        """The strictest of their skies."""
        return min(sighting.sky_limit for sighting in self.sightings)

    @property
    def before_sunset(self) -> bool:
        """Whether any of them appears with the Sun still up."""
        return any(sighting.before_sunset for sighting in self.sightings)

    @property
    def lead(self) -> Sighting:
        """The first to appear, which the flyover is named after."""
        return self.sightings[0]

    @property
    def satellite_count(self) -> int:
        """How many satellites there are to see."""
        return len(self.sightings)

    @property
    def bright(self) -> bool:
        """Whether it is hard to miss."""
        peak = self.peak_magnitude
        return (
            peak < _BRIGHT_MAGNITUDE
            and self.sky_limit - peak > _BRIGHT_OVER_SKY
            and not self.before_sunset
        )


def _direction(observer: track.Observer, position: np.ndarray) -> Direction:
    azimuth, elevation, _ = track.look(observer, position)
    return Direction(round(float(azimuth), 1), round(float(elevation), 1))


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
    max_magnitude: float,
) -> list[Sighting]:
    """Work out, second by second, what can be seen of a satellite in [since, until)."""
    seconds = np.arange(since, until, 1.0)
    places = track.propagate([record], seconds)[0]
    with np.errstate(invalid="ignore"):
        light = track.photometry(sat, observer, places, track.sun_at(seconds))
        visible = track.visible(light, max_magnitude)

    def moment(index: int) -> datetime:
        return datetime.fromtimestamp(seconds[index], UTC)

    found = []
    for first, past in _stretches(visible):
        peak = first + int(np.argmin(light.magnitude[first:past]))
        found.append(
            Sighting(
                satellite=sat,
                start=moment(first),
                # When the stretch runs off the end, the next one starts there.
                end=moment(past) if past < len(seconds) else datetime.fromtimestamp(until, UTC),
                appears=_direction(observer, places[first]),
                peak=_direction(observer, places[peak]),
                vanishes=_direction(observer, places[past - 1]),
                peak_time=moment(peak),
                peak_magnitude=float(light.magnitude[peak]),
                sky_limit=float(light.limiting[first]),
                before_sunset=bool(light.sun_angle[first] < math.pi / 2),
            )
        )
    return found


def find_sightings(
    satellites: Sequence[Satellite],
    observer: track.Observer,
    *,
    start: datetime,
    days: float = PREDICTION_DAYS,
    max_magnitude: float = DEFAULT_MAX_MAGNITUDE,
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
    worth_trying = [sat for sat in satellites if best[id(sat)] < max_magnitude]
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
                seen = track.visible(light, max_magnitude + _SEARCH_MARGIN)
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
                    max_magnitude,
                )

    # Those that appear together keep the catalog's order.
    position = {id(sat): index for index, sat in enumerate(satellites)}
    found.sort(key=lambda sighting: (sighting.start, position[id(sighting.satellite)]))
    return found


def _worth_listing(sightings: list[Sighting]) -> list[Sighting]:
    """Drop the Starlinks of a flyover unless there are enough of them for a train."""
    others = [sighting for sighting in sightings if not sighting.satellite.is_starlink]
    starlinks = len(sightings) - len(others)
    return others if 0 < starlinks < _TRAIN_SIZE else sightings


def group_sightings(sightings: Iterable[Sighting]) -> list[Flyover]:
    """Join sightings that overlap or nearly do into flyovers."""
    joined: list[list[Sighting]] = []
    latest_end = datetime.min.replace(tzinfo=UTC)
    for sighting in sorted(sightings, key=attrgetter("start")):
        if not joined or sighting.start - latest_end > _FLYOVER_GAP:
            joined.append([])
            latest_end = sighting.end
        joined[-1].append(sighting)
        latest_end = max(latest_end, sighting.end)
    kept = (_worth_listing(members) for members in joined)
    return [Flyover(members) for members in kept if members]


def read_catalog(entries: Iterable[Mapping[str, Any]]) -> list[Satellite]:
    """Read a catalog written by write_catalog."""
    return [
        Satellite.from_elements(
            entry["elements"],
            None if entry.get("magnitude") is None else float(entry["magnitude"]),
            entry.get("model"),
            entry["name"],
        )
        for entry in entries
    ]


def write_catalog(satellites: Iterable[Satellite]) -> list[dict[str, Any]]:
    """Write a catalog for storage."""
    return [
        {
            "name": sat.name,
            "elements": dict(sat.elements),
            "magnitude": (
                sat.magnitude
                if sat.magnitude is not None and math.isfinite(sat.magnitude)
                else None
            ),
            "model": sat.model,
        }
        for sat in satellites
    ]
