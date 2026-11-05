"""The search for passes: what can be seen from a place, and when, to the second."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import cached_property
import math
from typing import Any, NamedTuple, Self

import numpy as np
from sgp4.api import WGS72, Satrec

from . import track
from .const import DEFAULT_BRIGHTNESS_CUTOFF, PREDICTION_DAYS

# SGP4 counts its epochs in days from here.
_SGP4_EPOCH = datetime(1949, 12, 31, tzinfo=UTC)
_DEGREES = math.pi / 180.0
_MINUTES_PER_DAY = 1440.0
# Revolutions per day to radians per minute (and per minute squared, and cubed).
_MOTION = math.tau / _MINUTES_PER_DAY
# The most SGP4's records can hold; new launches can have nine digits.
_LARGEST_RECORD_NUMBER = 339999

_STARLINK_EXTRA_MAGNITUDES = 0.75
_MIN_STARLINKS = 5

# SGP4 keeps Python's lock for a whole batch, and Home Assistant's event loop waits that long.
# This many keeps the wait to about 12 ms on a fast computer, and takes no longer overall.
_BATCH_SIZE = 8
_GRID_S = 60.0
# Well past the cutoff, so that a sighting's edges fall inside the stretch searched exactly.
_PROMISING_PAST_CUTOFF = 2.0

# Sightings further apart than this are separate flyovers.
_SAME_FLYOVER = timedelta(seconds=60)


@dataclass
class Satellite:
    """One object in orbit: its orbital elements, and how bright it is."""

    norad_id: int
    name: str
    standard_magnitude: float | None
    curve: str | None
    elements: Mapping[str, str]
    epoch: datetime

    @classmethod
    def from_elements(
        cls,
        elements: Mapping[str, Any],
        standard_magnitude: float | None = None,
        *,
        curve: str | None = None,
        name: str | None = None,
    ) -> Self:
        """Build a satellite from CCSDS fields, as strings or numbers."""
        fields = {key: str(value) for key, value in elements.items()}
        return cls(
            norad_id=int(fields["NORAD_CAT_ID"]),
            name=fields["OBJECT_NAME"] if name is None else name,
            standard_magnitude=standard_magnitude,
            curve=curve,
            elements=fields,
            epoch=datetime.fromisoformat(fields["EPOCH"].removesuffix("Z")).replace(tzinfo=UTC),
        )

    def sgp4_record(self) -> Satrec:
        """Build a new SGP4 record of the elements."""
        fields = self.elements
        record = Satrec()
        record.sgp4init(
            WGS72,
            "i",
            self.norad_id if self.norad_id <= _LARGEST_RECORD_NUMBER else 0,
            (self.epoch - _SGP4_EPOCH).total_seconds() / 86400.0,
            float(fields["BSTAR"]),
            float(fields["MEAN_MOTION_DOT"]) * _MOTION / _MINUTES_PER_DAY,
            float(fields["MEAN_MOTION_DDOT"]) * _MOTION / _MINUTES_PER_DAY**2,
            float(fields["ECCENTRICITY"]),
            float(fields["ARG_OF_PERICENTER"]) * _DEGREES,
            float(fields["INCLINATION"]) * _DEGREES,
            float(fields["MEAN_ANOMALY"]) * _DEGREES,
            float(fields["MEAN_MOTION"]) * _MOTION,
            float(fields["RA_OF_ASC_NODE"]) * _DEGREES,
        )
        return record


class Moment(NamedTuple):
    """When something happens, and where to look."""

    time: datetime
    azimuth: float
    elevation: float


@dataclass
class Sighting:
    """One satellite visible once.

    ``vanishes`` has the first second it can no longer be seen, and the last place it was
    seen. ``sky_limit`` is what the sky shows as it appears, and ``sun_up`` is for then too.
    """

    satellite: Satellite
    appears: Moment
    brightest: Moment
    vanishes: Moment
    peak_magnitude: float
    sky_limit: float
    sun_up: bool

    @property
    def duration(self) -> int:
        """How long it can be seen, in whole seconds."""
        return round((self.vanishes.time - self.appears.time).total_seconds())


@dataclass
class Flyover:
    """What can be seen at about the same time, with the brightest first."""

    sightings: list[Sighting]

    def __post_init__(self) -> None:
        """Put the brightest first (the earliest listed of any that tie) and leave the rest."""
        listed = self.sightings
        lead = min(range(len(listed)), key=lambda index: listed[index].peak_magnitude)
        self.sightings = [listed[lead], *listed[:lead], *listed[lead + 1 :]]

    @property
    def lead(self) -> Sighting:
        """The brightest sighting."""
        return self.sightings[0]

    @cached_property
    def start(self) -> datetime:
        """The earliest appearance."""
        return min(sighting.appears.time for sighting in self.sightings)

    @cached_property
    def end(self) -> datetime:
        """The latest vanishing."""
        return max(sighting.vanishes.time for sighting in self.sightings)

    @property
    def duration(self) -> int:
        """How long it lasts, in whole seconds."""
        return round((self.end - self.start).total_seconds())

    @property
    def peak_magnitude(self) -> float:
        """How bright the lead gets."""
        return self.lead.peak_magnitude

    @cached_property
    def sky_limit(self) -> float:
        """The least the sky shows as any of them appears."""
        return min(sighting.sky_limit for sighting in self.sightings)

    @cached_property
    def sun_up(self) -> bool:
        """Whether the Sun is up as any of them appears."""
        return any(sighting.sun_up for sighting in self.sightings)

    @property
    def count(self) -> int:
        """How many there are."""
        return len(self.sightings)

    @property
    def title(self) -> str:
        """The lead's name, followed by how many others are there."""
        name = self.lead.satellite.name
        return f"{name} +{self.count - 1}" if self.count > 1 else name

    @property
    def bright(self) -> bool:
        """Whether it is easy to see: bright, and well clear of what a dark sky shows."""
        peak = self.peak_magnitude
        return not self.sun_up and peak < 0.5 and self.sky_limit - peak > 3


def _is_starlink(sat: Satellite) -> bool:
    return sat.name.upper().startswith("STARLINK")


def cutoff_for(sat: Satellite, faintest: float) -> float:
    """Return the faintest a satellite may be listed at: Starlinks go past the others."""
    return faintest + _STARLINK_EXTRA_MAGNITUDES if _is_starlink(sat) else faintest


def _runs(flags: np.ndarray[Any, Any]) -> list[tuple[int, int]]:
    """Return where flags are set, as [first, last) pairs."""
    padded = np.concatenate(([0], flags.astype(np.int8), [0]))
    edges = np.flatnonzero(np.diff(padded))
    return list(zip(edges[::2].tolist(), edges[1::2].tolist(), strict=True))


def _utc(seconds: float) -> datetime:
    return datetime.fromtimestamp(seconds, UTC)


def _exact_sightings(
    sat: Satellite,
    satrec: Satrec,
    observer: track.Observer,
    first: float,
    last: float,
    cutoff: float,
) -> list[Sighting]:
    """Find the sightings from second ``first`` to second ``last``, which ends any still on."""
    seconds = np.arange(first, last + 1.0)
    places = track.propagate([satrec], seconds)[0]
    light = track.photometry(sat, observer, places, track.sun_at(seconds))
    seen = track.visible(light, cutoff)
    seen[-1] = False
    azimuth, elevation, _ = track.look(observer, places)

    def moment(when: int, where: int) -> Moment:
        return Moment(
            _utc(float(seconds[when])),
            round(float(azimuth[where]), 1) % 360.0,
            round(float(elevation[where]), 1),
        )

    sightings = []
    for begin, stop in _runs(seen):
        brightest = begin + int(np.argmin(light.magnitude[begin:stop]))
        sightings.append(
            Sighting(
                satellite=sat,
                appears=moment(begin, begin),
                brightest=moment(brightest, brightest),
                vanishes=moment(stop, stop - 1),
                peak_magnitude=float(light.magnitude[brightest]),
                sky_limit=float(light.limiting[begin]),
                sun_up=bool(light.sun_angle[begin] < math.pi / 2.0),
            )
        )
    return sightings


def _promising_minutes(
    sat: Satellite,
    observer: track.Observer,
    places: np.ndarray[Any, Any],
    sun: np.ndarray[Any, Any],
    cutoff: float,
) -> np.ndarray[Any, Any]:
    """Say where a satellite is above the horizon and visible well past its cutoff."""
    promising = track.above_horizon(observer, places)
    if promising.any():
        light = track.photometry(sat, observer, places[promising], sun[promising])
        promising[promising] = track.visible(light, cutoff + _PROMISING_PAST_CUTOFF)
    return promising


def find_sightings(
    satellites: Sequence[Satellite],
    observer: track.Observer,
    *,
    start: datetime,
    days: float = PREDICTION_DAYS,
    faintest: float = DEFAULT_BRIGHTNESS_CUTOFF,
) -> list[Sighting]:
    """Return everything visible, ordered by appearance and then catalog order.

    A one-minute grid finds the promising stretches of each satellite, and each stretch is then
    worked out second by second, so that a sighting's times depend only on the elements and not
    on when the search began. A stretch still going at the end of the time is left for the next
    search.
    """
    first = float(start.replace(microsecond=0).timestamp())
    grid = first + _GRID_S * np.arange(int(days * _MINUTES_PER_DAY) + 1)
    sun = track.sun_at(grid)
    limit = track.sky_limit(observer, sun)

    candidates = []
    for order, sat in enumerate(satellites):
        cutoff = cutoff_for(sat, faintest)
        if (bound := track.brightest_possible(sat, observer)) < cutoff:
            candidates.append((bound, order, sat, cutoff))
    candidates.sort(key=lambda candidate: candidate[:2])

    found: list[tuple[datetime, int, Sighting]] = []
    for begin in range(0, len(candidates), _BATCH_SIZE):
        batch = candidates[begin : begin + _BATCH_SIZE]
        # Minutes too bright for the batch's best can be skipped, unless next to one that is not.
        dark = limit >= batch[0][0]
        dark[1:] |= limit[:-1] >= batch[0][0]
        dark[:-1] |= limit[1:] >= batch[0][0]
        minutes = np.flatnonzero(dark)
        if not minutes.size:
            continue
        satrecs = [candidate[2].sgp4_record() for candidate in batch]
        places = track.propagate(satrecs, grid[minutes])
        for (_, order, sat, cutoff), satrec, place in zip(batch, satrecs, places, strict=True):
            promising = np.zeros(grid.size, dtype=bool)
            promising[minutes] = _promising_minutes(sat, observer, place, sun[minutes], cutoff)
            for rising, ended in _runs(promising):
                if ended == grid.size:
                    continue
                low = max(first, float(grid[rising]) - _GRID_S)
                sightings = _exact_sightings(sat, satrec, observer, low, float(grid[ended]), cutoff)
                found += [(sighting.appears.time, order, sighting) for sighting in sightings]
    found.sort(key=lambda item: item[:2])
    return [sighting for _, _, sighting in found]


def _flyover(sightings: list[Sighting]) -> Flyover | None:
    """Make a flyover, without Starlinks too few to be a train; None if that leaves nothing."""
    starlinks = sum(_is_starlink(sighting.satellite) for sighting in sightings)
    if starlinks < _MIN_STARLINKS:
        sightings = [sighting for sighting in sightings if not _is_starlink(sighting.satellite)]
    return Flyover(sightings) if sightings else None


def group_sightings(sightings: Iterable[Sighting]) -> list[Flyover]:
    """Make flyovers from sightings: one starts over a minute after the last has all vanished."""
    groups: list[list[Sighting]] = []
    latest: datetime | None = None
    for sighting in sorted(sightings, key=lambda sighting: sighting.appears.time):
        if latest is None or sighting.appears.time - latest > _SAME_FLYOVER:
            groups.append([])
            latest = sighting.vanishes.time
        groups[-1].append(sighting)
        latest = max(latest, sighting.vanishes.time)
    return [flyover for group in groups if (flyover := _flyover(group)) is not None]


def read_catalog(entries: Iterable[Mapping[str, Any]]) -> list[Satellite]:
    """Read the stored form of a catalog."""
    return [
        Satellite.from_elements(
            entry["elements"],
            entry["standard_magnitude"],
            curve=entry["curve"],
            name=entry["name"],
        )
        for entry in entries
    ]


def write_catalog(satellites: Iterable[Satellite]) -> list[dict[str, Any]]:
    """Return the stored form of a catalog."""
    return [
        {
            "name": sat.name,
            "elements": dict(sat.elements),
            "standard_magnitude": (
                sat.standard_magnitude
                if sat.standard_magnitude is not None and math.isfinite(sat.standard_magnitude)
                else None
            ),
            "curve": sat.curve,
        }
        for sat in satellites
    ]
