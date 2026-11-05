"""Where a satellite is, whether it is sunlit and how bright it looks.

predict.py searches with these to find the passes, and the globe and the street
view draw with them: positions every few seconds from horizon to horizon, the
magnitude even while it is too faint to count, and why a pass begins and ends.

The formulas are published, and cited where they are used. Some numbers have no
source to cite: what counts as visible (the horizon, the height sunlight must
clear, the margin over the sky's limit), two departures from Weaver's curve, and
in predict.py how close passes must be to count as one. They are the choices James
Darpinian made for See A Satellite Tonight (https://james.darpinian.com/satellites/),
kept because nothing yet says better.
tests/test_track.py checks the geometry against Skyfield, and tests/test_predict.py
the tables against their sources.

Times are Unix seconds, angles degrees, positions Earth-fixed metres. There
are no Home Assistant imports: everything here runs in executor jobs.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import math
from typing import TYPE_CHECKING, Any, NamedTuple

import numpy as np
from numpy.polynomial.polynomial import polyval
from sgp4.api import Satrec, SatrecArray

if TYPE_CHECKING:
    from .predict import Satellite

# WGS84, which its equatorial radius and flattening define.
_EQUATOR_M = 6378137.0
_FLATTENING = 1 / 298.257223563
_POLE_M = _EQUATOR_M * (1 - _FLATTENING)
_ECCENTRICITY_SQUARED = _FLATTENING * (2 - _FLATTENING)
_METRES_PER_AU = 149_597_870_700.0
_EARTH_MU_KM = 398600.4418
_EARTH_RADIUS_KM = 6378.137
_UNIX_EPOCH_JD = 2440587.5
_DAY_S = 86400.0
# The epoch J2000 (2000 January 1, 12:00) in Unix seconds, and a Julian century.
_J2000_S = 946_728_000.0
_CENTURY_S = 36525 * _DAY_S

# Below this a satellite counts as hidden, and a ray of sunlight that grazes the
# Earth lower than this (through the troposphere) counts as blocked.
MIN_ELEVATION = 10.0
_SUNLIGHT_CLEARS_M = 15000.0
_MIN_ELEVATION_RAD = math.radians(MIN_ELEVATION)
_SIN_MIN_ELEVATION = math.sin(_MIN_ELEVATION_RAD)
# A satellite must be this much brighter than the faintest star the sky shows.
_SKY_MARGIN = 0.3

# The faintest magnitude the sky shows, by the Sun's angle from the zenith in degrees:
# points read from Weaver 1947, PASP 59, 232, fig. 2. Two departures from the curve: full
# daylight at -4 where it shows about -3.2, and stopping at 4 where it goes on to 6
# by 106 degrees, as a satellite is harder to find than a star.
_WEAVER_SKY = np.array(
    [
        [0, -4],
        [50, -3.5],
        [82, -2.5],
        [90, -1],
        [93.2, 0],
        [95.2, 1],
        [96.4, 2],
        [97.5, 3],
        [100, 4],
    ]
)
_SKY_SUN_ANGLES = np.radians(_WEAVER_SKY[:, 0])
_SKY_MAGNITUDES = _WEAVER_SKY[:, 1]
# How much the air dims it, in magnitudes: Green 1992, ICQ 14, 55-59, table Ic ("summer").
# http://www.icq.eps.harvard.edu/ICQExtinct.html
# Each row is a zenith distance in degrees (the table's row for 1 degree stands for the
# zenith), then the dimming seen from each of these heights above sea level.
_EXTINCTION_HEIGHTS_M = np.array([0.0, 500.0, 1000.0, 2000.0, 3000.0])
_GREEN_TABLE_IC = np.array(
    [
        [90, 12.68, 10.56, 8.97, 6.80, 5.47],
        [89, 8.33, 6.93, 5.89, 4.47, 3.59],
        [88, 6.11, 5.09, 4.32, 3.28, 2.63],
        [87, 4.78, 3.98, 3.38, 2.56, 2.06],
        [86, 3.90, 3.25, 2.75, 2.09, 1.68],
        [85, 3.28, 2.73, 2.32, 1.76, 1.41],
        [84, 2.82, 2.35, 1.99, 1.51, 1.22],
        [83, 2.47, 2.06, 1.75, 1.32, 1.07],
        [82, 2.19, 1.83, 1.55, 1.18, 0.95],
        [81, 1.97, 1.64, 1.39, 1.06, 0.85],
        [80, 1.79, 1.49, 1.26, 0.96, 0.77],
        [79, 1.64, 1.36, 1.16, 0.88, 0.71],
        [78, 1.51, 1.25, 1.07, 0.81, 0.65],
        [77, 1.40, 1.16, 0.99, 0.75, 0.60],
        [76, 1.30, 1.08, 0.92, 0.70, 0.56],
        [75, 1.22, 1.01, 0.86, 0.65, 0.53],
        [74, 1.15, 0.95, 0.81, 0.61, 0.49],
        [73, 1.08, 0.90, 0.76, 0.58, 0.47],
        [72, 1.02, 0.85, 0.72, 0.55, 0.44],
        [71, 0.97, 0.81, 0.69, 0.52, 0.42],
        [70, 0.93, 0.77, 0.65, 0.50, 0.40],
        [68, 0.85, 0.70, 0.60, 0.45, 0.36],
        [66, 0.78, 0.65, 0.55, 0.42, 0.34],
        [64, 0.72, 0.60, 0.51, 0.39, 0.31],
        [62, 0.68, 0.56, 0.48, 0.36, 0.29],
        [60, 0.63, 0.53, 0.45, 0.34, 0.27],
        [55, 0.55, 0.46, 0.39, 0.30, 0.24],
        [50, 0.49, 0.41, 0.35, 0.26, 0.21],
        [45, 0.45, 0.37, 0.32, 0.24, 0.19],
        [40, 0.41, 0.34, 0.29, 0.22, 0.18],
        [30, 0.37, 0.30, 0.26, 0.20, 0.16],
        [20, 0.34, 0.28, 0.24, 0.18, 0.15],
        [10, 0.32, 0.27, 0.23, 0.17, 0.14],
        [0, 0.32, 0.26, 0.22, 0.17, 0.14],
    ]
)  # fmt: skip
_EXTINCTION_ELEVATIONS = np.radians(90 - _GREEN_TABLE_IC[:, 0])
_EXTINCTIONS = _GREEN_TABLE_IC[:, 1:]
# The Earth with the air that stops sunlight, as an ellipsoid's three radii.
_SHADOW_RADII = np.array([_EQUATOR_M, _EQUATOR_M, _POLE_M]) + _SUNLIGHT_CLEARS_M

# Horizon search around a visible window: this far either side, this coarse.
_SCAN_S = 1800.0
_SCAN_STEP_S = 5.0


def _distance_dimming(distance_m: np.ndarray) -> np.ndarray:
    """How much fainter something looks at this distance than at 1000 km."""
    return 5 * np.log10(distance_m / 1e6)


# How much brighter than half lit a satellite is fully lit, by the formula in _unobscured().
_FULLY_LIT_GAIN = 2.5 * math.log10(2)

# Starlinks, by the curve they follow: the magnitude at 1000 km as a cubic in the phase
# angle in degrees, constant term first. Direct-to-cell satellites: the phase function in
# Mallama et al. 2025, arXiv:2502.03651, table 1. Those still raising their orbits, before
# brightness mitigation starts at 357 km: the same curve, moved by the difference between
# its mean of 6.47 and their mean of 4.58 at 1000 km (Mallama et al. 2024, arXiv:2405.12007).
_STARLINK_CUBICS = {
    "starlink-dtc": (3.365, 0.06376, -1.716e-4, -1.139e-6),
    "starlink-raising": (3.365 - (6.47 - 4.58), 0.06376, -1.716e-4, -1.139e-6),
}
# The phase angles those were fitted to, in degrees; beyond them they hold the nearest.
_STARLINK_PHASES = (15.0, 155.0)
_MIN_PERIGEE_M = 100_000.0


class Observer:
    """A place on Earth, with the vectors the look angles need and the air above it."""

    __slots__ = (
        "east",
        "elevation_m",
        "extinctions",
        "latitude",
        "longitude",
        "normal",
        "north",
        "position",
    )

    def __init__(self, latitude: float, longitude: float, elevation_m: float = 0.0) -> None:
        """Place the observer above the WGS84 ellipsoid."""
        self.latitude = latitude
        self.longitude = longitude
        self.elevation_m = elevation_m
        phi, lam = math.radians(latitude), math.radians(longitude)
        self.normal = np.array(
            [math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)]
        )
        self.east = np.array([-math.sin(lam), math.cos(lam), 0.0])
        self.north = np.cross(self.normal, self.east)
        # Up from the ellipsoid does not pass through the Earth's centre, but this far from it.
        curvature = _EQUATOR_M / math.sqrt(1 - _ECCENTRICITY_SQUARED * math.sin(phi) ** 2)
        off_centre = curvature * _ECCENTRICITY_SQUARED * math.sin(phi)
        self.position = (curvature + elevation_m) * self.normal - np.array([0.0, 0.0, off_centre])
        # The air's dimming from this height, between the table's columns. Above its
        # 3 km this keeps to that column, and below sea level to that one.
        self.extinctions = np.array(
            [np.interp(elevation_m, _EXTINCTION_HEIGHTS_M, row) for row in _EXTINCTIONS]
        )


@dataclass(frozen=True, slots=True)
class SkyPoint:
    """Where a satellite is in the sky at one instant."""

    time: float
    azimuth: float
    elevation: float


@dataclass(frozen=True, slots=True)
class SightingShape:
    """What a pass list shows beyond a sighting.

    ``peak`` is the highest point of the visible window (a sighting's
    ``brightest`` is where it looks brightest, often lower). The reasons say
    why it appears (``rise`` above the horizon, ``shadow``: out of Earth's
    shadow, ``sky``: bright enough for the sky only then) and disappears
    (``set``, ``shadow``, ``sky``).
    """

    peak: SkyPoint
    start_reason: str
    end_reason: str


class Photometry(NamedTuple):
    """How a satellite looks from the observer at a series of positions."""

    elevation: np.ndarray  # radians
    distance: np.ndarray  # metres
    sun_angle: np.ndarray  # radians from the zenith
    lit: np.ndarray  # sunlight reaches it above the troposphere
    magnitude: np.ndarray  # apparent, with extinction; NaN where unknown
    limiting: np.ndarray  # faintest magnitude the sky shows


# --- Time, frames and the Sun -----------------------------------------------


def julian(ts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Unix seconds as Julian dates, split into whole days and fractions (UTC)."""
    days = np.asarray(ts, dtype=float) / _DAY_S
    whole = np.floor(days)
    return _UNIX_EPOCH_JD + whole, days - whole


def _centuries(ts: np.ndarray) -> np.ndarray:
    """Julian centuries since J2000 at Unix times."""
    centuries: np.ndarray = (np.asarray(ts, dtype=float) - _J2000_S) / _CENTURY_S
    return centuries


def _earth_turned(ts: np.ndarray) -> np.ndarray:
    """How far the Earth has turned at Unix times, in radians: Greenwich mean sidereal time.

    Aoki et al. 1982 (IAU 1982), which SGP4's TEME frame is defined by, as seconds of
    sidereal time for any time of day (Vallado et al. 2006, AIAA 2006-6753). UTC stands
    in for UT1, as it does for the elements.
    """
    seconds = polyval(
        _centuries(ts), (67310.54841, 876600.0 * 3600 + 8640184.812866, 0.093104, -6.2e-6)
    )
    turned: np.ndarray = np.mod(seconds, _DAY_S) * (math.tau / _DAY_S)
    return turned


def _earth_fixed(inertial: np.ndarray, turned: np.ndarray) -> np.ndarray:
    """Turn inertial positions (..., 3) with the Earth, each by its angle in radians.

    Only the equatorial plane turns, which as complex numbers is one multiplication.
    """
    equatorial = (inertial[..., 0] + 1j * inertial[..., 1]) * np.exp(-1j * turned)
    return np.stack((equatorial.real, equatorial.imag, inertial[..., 2]), axis=-1)


def sun_at(ts: np.ndarray) -> np.ndarray:
    """Return the Sun's Earth-fixed position (metres) at Unix times.

    Meeus 1998, Astronomical Algorithms, chapter 25, "Solar coordinates: low accuracy",
    good to 0.01 degree, with chapter 22's mean obliquity. It leaves out nutation, as
    mean sidereal time does. UTC stands in for dynamical time: the minute between them
    moves the Sun by under 0.001 degree.
    """
    t = _centuries(ts)
    # Coefficients as the book prints them, constant term first; angles in degrees.
    anomaly = np.radians(polyval(t, (357.52911, 35999.05029, -0.0001537)))
    eccentricity = polyval(t, (0.016708634, -0.000042037, -0.0000001267))
    centre = np.radians(
        polyval(t, (1.914602, -0.004817, -0.000014)) * np.sin(anomaly)
        + polyval(t, (0.019993, -0.000101)) * np.sin(2 * anomaly)
        + 0.000289 * np.sin(3 * anomaly)
    )
    aberration = np.radians(0.00569)
    longitude = np.radians(polyval(t, (280.46646, 36000.76983, 0.0003032))) + centre - aberration
    tilt = np.radians(
        polyval(
            t, (23 + 26 / 60 + 21.448 / 3600, -46.8150 / 3600, -0.00059 / 3600, 0.001813 / 3600)
        )
    )
    au = 1.000001018 * (1 - eccentricity**2) / (1 + eccentricity * np.cos(anomaly + centre))
    direction = np.stack(
        (np.cos(longitude), np.cos(tilt) * np.sin(longitude), np.sin(tilt) * np.sin(longitude)),
        axis=-1,
    )
    return _earth_fixed(direction * (au * _METRES_PER_AU)[..., None], _earth_turned(ts))


def propagate(satrecs: Sequence[Satrec], ts: np.ndarray) -> np.ndarray:
    """Earth-fixed positions in metres, shape (satellites, times, 3); NaN where SGP4 fails.

    SatrecArray copies the records, so the Satrec objects passed in are never
    changed and may be shared between threads.
    """
    jd, fr = julian(ts)
    failed, km, _ = SatrecArray(list(satrecs)).sgp4(jd, fr)
    metres = np.where(failed[..., None] != 0, np.nan, km * 1000.0)
    return _earth_fixed(metres, _earth_turned(ts))


def geodetic(pos: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Latitude and longitude in degrees and height in km of Earth-fixed positions."""
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1 - _ECCENTRICITY_SQUARED))
    for _ in range(4):
        s = np.sin(lat)
        curvature = _EQUATOR_M / np.sqrt(1 - _ECCENTRICITY_SQUARED * s * s)
        lat = np.arctan2(z + _ECCENTRICITY_SQUARED * curvature * s, p)
    s = np.sin(lat)
    height = p * np.cos(lat) + z * s - _EQUATOR_M * np.sqrt(1 - _ECCENTRICITY_SQUARED * s * s)
    return np.degrees(lat), np.degrees(np.arctan2(y, x)), height / 1000.0


def _altitude(observer: Observer, towards: np.ndarray, distance: np.ndarray) -> np.ndarray:
    """Radians above the observer's horizon of a line of sight of this length."""
    altitude: np.ndarray = np.arcsin(np.clip(towards @ observer.normal / distance, -1, 1))
    return altitude


def _sun_from_zenith(observer: Observer, sun: np.ndarray) -> np.ndarray:
    """Radians between straight up and the Sun at positions (..., 3)."""
    angle: np.ndarray = np.arccos(
        np.clip(sun @ observer.normal / np.linalg.norm(sun, axis=-1), -1, 1)
    )
    return angle


def look(observer: Observer, pos: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Azimuth and elevation in degrees and range in metres of positions (..., 3)."""
    towards = pos - observer.position
    distance = np.linalg.norm(towards, axis=-1)
    azimuth = np.degrees(np.arctan2(towards @ observer.east, towards @ observer.north)) % 360
    return azimuth, np.degrees(_altitude(observer, towards, distance)), distance


def sunlit(origin: np.ndarray, direction: np.ndarray) -> np.ndarray:
    """Whether sunlight reaches positions (..., 3), given the direction (..., 3) of the Sun.

    Stretch space until the Earth and the air that stops sunlight (_SHADOW_RADII) make a
    unit sphere. A point is then lit if it lies outside the sphere, and the straight line
    to the Sun either leads away from the sphere or passes it by.
    """
    point = origin / _SHADOW_RADII
    towards_sun = direction / _SHADOW_RADII
    towards_sun = towards_sun / np.linalg.norm(towards_sun, axis=-1, keepdims=True)
    from_centre_sq = np.sum(point * point, axis=-1)
    outward = np.sum(point * towards_sun, axis=-1)
    closest_sq = from_centre_sq - outward * outward
    lit: np.ndarray = (from_centre_sq >= 1) & ((outward >= 0) | (closest_sq >= 1))
    return lit


# --- Brightness --------------------------------------------------------------


def _starlink_at_1000_km(model: str, phase_degrees: np.ndarray) -> np.ndarray:
    """Return a Starlink's magnitude 1000 km away, by its published fit."""
    magnitude: np.ndarray = polyval(
        np.clip(phase_degrees, *_STARLINK_PHASES), _STARLINK_CUBICS[model]
    )
    return magnitude


def _unobscured(sat: Satellite, cos_phase: np.ndarray, distance: np.ndarray) -> np.ndarray:
    """How bright it looks at this distance and phase, before the air; NaN when unknown."""
    if sat.curve in _STARLINK_CUBICS:
        phase = np.degrees(np.arccos(np.clip(cos_phase, -1, 1)))
        fitted: np.ndarray = _starlink_at_1000_km(sat.curve, phase) + _distance_dimming(distance)
        return fitted
    if sat.standard_magnitude is None:
        return np.full_like(distance, np.nan)
    # Mini-MegaTORTORA's standard magnitude run backwards (Karpov et al. 2016): it is for
    # 1000 km and half lit, so range and the lit fraction, which is (1 + cos phase) / 2 of
    # the disc. See scripts/make_brightness_table.py.
    lit = 1 + np.clip(cos_phase, -1, 1)
    magnitude: np.ndarray = (
        sat.standard_magnitude + _distance_dimming(distance) - 2.5 * np.log10(lit)
    )
    return magnitude


def photometry(sat: Satellite, observer: Observer, pos: np.ndarray, sun: np.ndarray) -> Photometry:
    """Apparent magnitude and visibility inputs at positions (n, 3) with the Sun at sun (n, 3).

    The magnitude is kept even where the satellite is too low, too faint or in
    shadow; ``visible`` applies the cutoffs.
    """
    towards = pos - observer.position
    to_sun = sun - pos
    distance = np.linalg.norm(towards, axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        elevation = _altitude(observer, towards, distance)
        sun_angle = _sun_from_zenith(observer, sun)
        # The angle at the satellite, from the Sun round to the observer.
        cos_phase = -np.sum(towards * to_sun, axis=-1) / (
            distance * np.linalg.norm(to_sun, axis=-1)
        )
        air = np.interp(elevation, _EXTINCTION_ELEVATIONS, observer.extinctions)
        apparent = _unobscured(sat, cos_phase, distance) + air
    return Photometry(
        elevation,
        distance,
        sun_angle,
        sunlit(pos, to_sun),
        np.where(np.isfinite(apparent), apparent, np.nan),
        limiting_magnitude(sun_angle),
    )


def visible(ph: Photometry, faintest: float | None = None) -> np.ndarray:
    """Where the satellite counts as visible (and brighter than the faintest asked for)."""
    with np.errstate(invalid="ignore"):
        result: np.ndarray = (
            (ph.elevation >= _MIN_ELEVATION_RAD)
            & np.isfinite(ph.distance)
            & ph.lit
            & (ph.magnitude <= ph.limiting - _SKY_MARGIN)
        )
        if faintest is not None:
            result &= ph.magnitude < faintest
    return result


def limiting_magnitude(sun_angle: np.ndarray) -> np.ndarray:
    """Return the faintest magnitude the sky shows, by the Sun's angle from the zenith."""
    limit: np.ndarray = np.interp(sun_angle, _SKY_SUN_ANGLES, _SKY_MAGNITUDES)
    return limit


def sky_limit(observer: Observer, sun: np.ndarray) -> np.ndarray:
    """Return how bright a satellite must be to count as visible, with the Sun at sun (n, 3)."""
    return limiting_magnitude(_sun_from_zenith(observer, sun)) - _SKY_MARGIN


def above_horizon(observer: Observer, pos: np.ndarray) -> np.ndarray:
    """Return where positions (..., 3) are at least MIN_ELEVATION up."""
    d = pos - observer.position
    high: np.ndarray = d @ observer.normal >= _SIN_MIN_ELEVATION * np.linalg.norm(d, axis=-1)
    return high


def brightest_possible(sat: Satellite, observer: Observer) -> float:
    """Return a magnitude it can never beat from here: overhead, at perigee, fully lit."""
    if sat.curve in _STARLINK_CUBICS:
        low, high = _STARLINK_PHASES
        at_1000_km = float(_starlink_at_1000_km(sat.curve, np.arange(low, high + 1)).min())
    elif sat.standard_magnitude is None:
        return math.inf
    else:
        at_1000_km = sat.standard_magnitude - _FULLY_LIT_GAIN
    closest = max(apsides_km(sat)[0] * 1000.0, _MIN_PERIGEE_M)
    return at_1000_km + 5 * math.log10(closest / 1e6) + float(observer.extinctions.min())


# --- Passes ------------------------------------------------------------------


def sighting_shape(
    sat: Satellite,
    observer: Observer,
    start: float,
    end: float,
    fallback: SkyPoint,
) -> SightingShape:
    """Find the highest point of a visible window [start, end) and why it begins and ends.

    ``fallback`` (the sighting's brightest point) stands in where SGP4 fails.
    """
    start, end = round(start), round(end)
    # With the second just before the window, and the one that ends it.
    ts = np.arange(start - 1, max(end, start + 1) + 1, 1.0)
    pos = propagate([sat.sgp4_record()], ts)[0]
    with np.errstate(invalid="ignore"):
        azimuth, elevation, _ = look(observer, pos)
        lit = sunlit(pos, sun_at(ts) - pos)
        inside = (ts >= start) & (ts < max(end, start + 1)) & np.isfinite(elevation)
    if not inside.any():
        return SightingShape(fallback, "sky", "sky")
    i = int(np.flatnonzero(inside)[np.argmax(elevation[inside])])
    peak = SkyPoint(float(ts[i]), float(azimuth[i]), float(elevation[i]))
    return SightingShape(
        peak,
        _reason(elevation[0], lit[0], "rise"),
        _reason(elevation[-1], lit[-1], "set"),
    )


def _reason(elevation: float, lit: bool, horizon: str) -> str:
    """Why a visible window begins (or ends), from the second just outside it.

    Too low then: the horizon. Otherwise in Earth's shadow, or else the sky was
    too bright for it.
    """
    if elevation < MIN_ELEVATION:
        return horizon
    return "sky" if lit else "shadow"


@dataclass(slots=True)
class PassTrack:
    """One satellite's track across the sky, horizon to horizon.

    ``horizon_rise`` and ``horizon_set`` are the times of the first and last
    rows, the samples just below the horizon either side of the pass.
    """

    horizon_rise: float
    horizon_set: float
    rows: list[list[Any]]


def pass_track(
    sat: Satellite,
    observer: Observer,
    start: float,
    end: float,
    step: float,
    faintest: float,
) -> PassTrack | None:
    """Rows from just below the horizon before a visible window to just below it after.

    Row: ``[t, lat, lon, alt_km, lit, az, el, range_km, mag, vis]``. ``mag`` is
    the apparent magnitude whenever the satellite is lit and above the
    horizon (however faint), ``vis`` 1 where it counts as visible. The rows
    keep to multiples of ``step`` from the window's start.
    """
    satrec = sat.sgp4_record()
    low, high = _horizon_scan(satrec, observer, start, end)
    ts = start + step * np.arange(
        math.floor((low - start) / step), math.ceil((high - start) / step) + 1
    )
    pos = propagate([satrec], ts)[0]
    good = np.isfinite(pos).all(axis=1)
    if not good.any():
        return None
    ts, pos = ts[good], pos[good]
    with np.errstate(invalid="ignore"):
        azimuth, elevation, distance = look(observer, pos)
        ph = photometry(sat, observer, pos, sun_at(ts))
        shown = visible(ph, faintest)
    # The run above the horizon that holds the visible window, and one sample
    # either side (below the horizon) so the crossing can be interpolated.
    above = elevation > 0
    middle = int(np.argmin(np.abs(ts - (start + end) / 2)))
    if not above[middle]:
        return None
    first, last = middle, middle
    while first > 0 and above[first - 1]:
        first -= 1
    while last < len(ts) - 1 and above[last + 1]:
        last += 1
    span = slice(max(first - 1, 0), min(last + 1, len(ts) - 1) + 1)

    lat, lon, alt = geodetic(pos[span])
    lit = ph.lit[span]
    magnitude = np.where(lit & (elevation[span] > 0), np.round(ph.magnitude[span], 1) + 0.0, np.nan)
    rows = [
        [_seconds(t), la, lo, al, int(li), az, el, rng, None if math.isnan(m) else m, int(v)]
        for t, la, lo, al, li, az, el, rng, m, v in zip(
            ts[span].tolist(),
            np.round(lat, 4).tolist(),
            np.round(lon, 4).tolist(),
            np.round(alt, 1).tolist(),
            lit.tolist(),
            np.round(azimuth[span], 2).tolist(),
            np.round(elevation[span], 2).tolist(),
            np.round(distance[span] / 1000, 1).tolist(),
            magnitude.tolist(),
            shown[span].tolist(),
            strict=True,
        )
    ]
    return PassTrack(rows[0][0], rows[-1][0], rows)


def _horizon_scan(
    satrec: Satrec, observer: Observer, start: float, end: float
) -> tuple[float, float]:
    """Find times either side of a visible window when the satellite is below the horizon.

    Coarse samples up to _SCAN_S beyond the window; the scan's ends if the
    satellite stays up that long.
    """
    ts = np.arange(start - _SCAN_S, end + _SCAN_S + _SCAN_STEP_S, _SCAN_STEP_S)
    with np.errstate(invalid="ignore"):
        _, elevation, _ = look(observer, propagate([satrec], ts)[0])
    below = ~(elevation > 0)
    before = np.flatnonzero(below & (ts <= start))
    after = np.flatnonzero(below & (ts >= end))
    low = float(ts[before[-1]]) if len(before) else float(ts[0])
    high = float(ts[after[0]]) if len(after) else float(ts[-1])
    return low, high


def sun_rows(observer: Observer, start: float, end: float, step: float) -> list[list[float]]:
    """Return the Sun's ``[t, azimuth, elevation]`` every step from start to end."""
    ts = np.arange(start, end + 1e-6, step)
    azimuth, elevation, _ = look(observer, sun_at(ts))
    return [
        [_seconds(t), az, el]
        for t, az, el in zip(
            ts.tolist(),
            np.round(azimuth, 1).tolist(),
            np.round(elevation, 1).tolist(),
            strict=True,
        )
    ]


# --- Ground tracks and positions ---------------------------------------------


def ground_rows(satrec: Satrec, ts: np.ndarray) -> list[list[Any]]:
    """Rows ``[t, lat, lon, alt_km, lit]`` at the given times (where SGP4 succeeds)."""
    pos = propagate([satrec], ts)[0]
    good = np.isfinite(pos).all(axis=1)
    ts, pos = ts[good], pos[good]
    lat, lon, alt = geodetic(pos)
    lit = sunlit(pos, sun_at(ts) - pos)
    return [
        [_seconds(t), la, lo, al, int(li)]
        for t, la, lo, al, li in zip(
            ts.tolist(),
            np.round(lat, 4).tolist(),
            np.round(lon, 4).tolist(),
            np.round(alt, 1).tolist(),
            lit.tolist(),
            strict=True,
        )
    ]


class Positions(NamedTuple):
    """Many satellites at the same times."""

    ok: np.ndarray  # (satellites,) SGP4 succeeded at every time
    latitude: np.ndarray  # (satellites, times) degrees
    longitude: np.ndarray
    altitude_km: np.ndarray
    lit: np.ndarray


def positions(satrecs: Sequence[Satrec], ts: np.ndarray) -> Positions:
    """Where every satellite is at the given times, and whether it is sunlit."""
    pos = propagate(satrecs, ts)
    with np.errstate(invalid="ignore"):
        lat, lon, alt = geodetic(pos)
        lit = sunlit(pos, sun_at(ts) - pos)
    return Positions(np.isfinite(pos).all(axis=(1, 2)), lat, lon, alt, lit)


# --- Orbits --------------------------------------------------------------------


def period_s(sat: Satellite) -> float:
    """Orbital period in seconds, from the mean motion (revolutions a day)."""
    return _DAY_S / float(sat.elements["MEAN_MOTION"])


def apsides_km(sat: Satellite) -> tuple[float, float]:
    """Perigee and apogee heights above a spherical Earth."""
    n = float(sat.elements["MEAN_MOTION"]) * 2 * math.pi / _DAY_S
    a = (_EARTH_MU_KM / (n * n)) ** (1 / 3)
    e = float(sat.elements["ECCENTRICITY"])
    return a * (1 - e) - _EARTH_RADIUS_KM, a * (1 + e) - _EARTH_RADIUS_KM


def _seconds(t: float) -> float | int:
    """Unix time to the millisecond; whole seconds stay integers to keep payloads small."""
    t = round(t, 3)
    return int(t) if t.is_integer() else t
