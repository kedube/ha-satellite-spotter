"""Geometry and light: where satellites are, how they look from a place, whether they show.

Nothing here touches Home Assistant, as it all runs in executor jobs. Times are Unix seconds,
angles degrees unless stated, positions Earth-fixed metres. Everything works on NumPy arrays,
and an SGP4 failure shows up as a NaN position rather than an exception.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import math
from typing import TYPE_CHECKING, Any, NamedTuple

import numpy as np
from numpy.typing import ArrayLike, NDArray
from sgp4.api import Satrec, SatrecArray

from .const import DEFAULT_MIN_ELEVATION

if TYPE_CHECKING:
    from .predict import Satellite

type Floats = NDArray[Any]
type Flags = NDArray[np.bool_]
type Number = int | float

# WGS84.
_EQUATOR_M = 6378137.0
_FLATTENING = 1 / 298.257223563
_POLE_M = _EQUATOR_M * (1 - _FLATTENING)
_ECCENTRICITY_SQUARED = _FLATTENING * (2 - _FLATTENING)

_METRES_PER_AU = 149597870700.0
# For orbit sizes: a spherical Earth, in km.
_MU_KM3_PER_S2 = 398600.4418
_EARTH_RADIUS_KM = 6378.137

# Sunlight grazing the air below this height is too dim to light a satellite.
_SUNLIGHT_CLEARS_M = 15000.0
_SHADOW_RADII = np.array(
    [
        _EQUATOR_M + _SUNLIGHT_CLEARS_M,
        _EQUATOR_M + _SUNLIGHT_CLEARS_M,
        _POLE_M + _SUNLIGHT_CLEARS_M,
    ]
)

_UNIX_JD = 2440587.5
_DAY_S = 86400.0
_J2000_UNIX = 946728000.0
_CENTURY_S = 36525 * _DAY_S
_RADIANS_PER_SECOND_OF_TIME = math.tau / _DAY_S

# Green 1992, International Comet Quarterly 14, 55, table Ic, "summer": a zenith distance in
# degrees, then the dimming in magnitudes from each of the heights below.
_EXTINCTION_HEIGHTS_M = (0.0, 500.0, 1000.0, 2000.0, 3000.0)
_EXTINCTION_TABLE = np.array(
    [
        (90, 12.68, 10.56, 8.97, 6.80, 5.47),
        (89, 8.33, 6.93, 5.89, 4.47, 3.59),
        (88, 6.11, 5.09, 4.32, 3.28, 2.63),
        (87, 4.78, 3.98, 3.38, 2.56, 2.06),
        (86, 3.90, 3.25, 2.75, 2.09, 1.68),
        (85, 3.28, 2.73, 2.32, 1.76, 1.41),
        (84, 2.82, 2.35, 1.99, 1.51, 1.22),
        (83, 2.47, 2.06, 1.75, 1.32, 1.07),
        (82, 2.19, 1.83, 1.55, 1.18, 0.95),
        (81, 1.97, 1.64, 1.39, 1.06, 0.85),
        (80, 1.79, 1.49, 1.26, 0.96, 0.77),
        (79, 1.64, 1.36, 1.16, 0.88, 0.71),
        (78, 1.51, 1.25, 1.07, 0.81, 0.65),
        (77, 1.40, 1.16, 0.99, 0.75, 0.60),
        (76, 1.30, 1.08, 0.92, 0.70, 0.56),
        (75, 1.22, 1.01, 0.86, 0.65, 0.53),
        (74, 1.15, 0.95, 0.81, 0.61, 0.49),
        (73, 1.08, 0.90, 0.76, 0.58, 0.47),
        (72, 1.02, 0.85, 0.72, 0.55, 0.44),
        (71, 0.97, 0.81, 0.69, 0.52, 0.42),
        (70, 0.93, 0.77, 0.65, 0.50, 0.40),
        (68, 0.85, 0.70, 0.60, 0.45, 0.36),
        (66, 0.78, 0.65, 0.55, 0.42, 0.34),
        (64, 0.72, 0.60, 0.51, 0.39, 0.31),
        (62, 0.68, 0.56, 0.48, 0.36, 0.29),
        (60, 0.63, 0.53, 0.45, 0.34, 0.27),
        (55, 0.55, 0.46, 0.39, 0.30, 0.24),
        (50, 0.49, 0.41, 0.35, 0.26, 0.21),
        (45, 0.45, 0.37, 0.32, 0.24, 0.19),
        (40, 0.41, 0.34, 0.29, 0.22, 0.18),
        (30, 0.37, 0.30, 0.26, 0.20, 0.16),
        (20, 0.34, 0.28, 0.24, 0.18, 0.15),
        (10, 0.32, 0.27, 0.23, 0.17, 0.14),
        (0, 0.32, 0.26, 0.22, 0.17, 0.14),
    ]
)
_EXTINCTION_ELEVATIONS = np.radians(90.0 - _EXTINCTION_TABLE[:, 0])

# Weaver 1947, PASP 59, 232: the faintest magnitude the sky shows, by the Sun's zenith distance in
# degrees. With the Sun high, table V for slightly hazy air at sea level, which it calls the usual
# case there. From 85 degrees on, figure 2, read from the scan to the 0.1 it can be read to. It
# stops at 4.0, table III's limit under the brightest moonlit sky it lists, because few homes have
# a truly dark sky and the figure's 6.0 would be too hopeful for them.
_SKY_TABLE = np.array(
    [
        (0, -4.2),
        (30, -4.0),
        (60, -3.6),
        (75, -3.2),
        (85, -1.7),
        (88, -1.3),
        (90, -0.9),
        (92, -0.4),
        (93, -0.1),
        (94, 0.3),
        (95, 0.9),
        (96, 1.7),
        (97, 2.8),
        (98, 3.4),
        (99, 3.8),
        (100, 4.0),
    ]
)
_SKY_ANGLES = np.radians(_SKY_TABLE[:, 0])
_SKY_LIMITS = _SKY_TABLE[:, 1]
# A satellite must beat the sky's limit by this much to be found. James Darpinian's choice, and
# about half the 0.6 between observers that Weaver quotes from Langmuir and Westendorp.
_SKY_MARGIN = 0.3

# Standard magnitudes are for this distance.
_REFERENCE_M = 1_000_000.0
_NEAREST_KM = 100.0
_FULLY_LIT = 2.5 * math.log10(2.0)

# Mallama et al. 2025, arXiv:2502.03651 gives the curve; Mallama et al. 2024,
# arXiv:2405.12007 the means at 1000 km, 6.47 in mitigation and 4.58 while raising orbit.
_CURVE_OFFSETS = {"starlink-dtc": 0.0, "starlink-raising": 6.47 - 4.58}
_CURVE_FIT_DEGREES = (15.0, 155.0)

# How the horizon is looked for around a visible window.
_SCAN_STEP_S = 5.0
_SCAN_REACH_S = 1800.0

# What a full Moon overhead takes off what the sky shows, in magnitudes: a rule of thumb, for
# rating passes rather than for deciding what can be seen.
_MOONLIGHT_MAGNITUDES = 1.0


def julian(ts: ArrayLike) -> tuple[Floats, Floats]:
    """Split Unix seconds into whole-day Julian dates and day fractions, as SGP4 wants them."""
    seconds = np.asarray(ts, dtype=float)
    days = np.floor(seconds / _DAY_S)
    return days + _UNIX_JD, (seconds - days * _DAY_S) / _DAY_S


def _centuries(ts: ArrayLike) -> Floats:
    """Julian centuries since J2000, with UTC standing in for UT1 and TT."""
    return (np.asarray(ts, dtype=float) - _J2000_UNIX) / _CENTURY_S


def _earth_turned(ts: ArrayLike) -> Floats:
    """Return Greenwich mean sidereal time in radians: the angle SGP4's TEME frame turns by."""
    t = _centuries(ts)
    per_century = 876600.0 * 3600.0 + 8640184.812866
    seconds = 67310.54841 + per_century * t + 0.093104 * t**2 - 6.2e-6 * t**3
    return np.mod(seconds * _RADIANS_PER_SECOND_OF_TIME, math.tau)


def _earth_fixed(inertial: Floats, turned: Floats) -> Floats:
    """Rotate vectors (..., 3) from inertial to Earth-fixed by the angles given."""
    cos, sin = np.cos(turned), np.sin(turned)
    x, y, z = inertial[..., 0], inertial[..., 1], inertial[..., 2]
    return np.stack((cos * x + sin * y, cos * y - sin * x, z), axis=-1)


def sun_at(ts: ArrayLike) -> Floats:
    """Return the Sun's Earth-fixed position in metres (Meeus 1998, chapter 25, low accuracy)."""
    t = _centuries(ts)
    mean_longitude = 280.46646 + 36000.76983 * t + 0.0003032 * t**2
    anomaly = np.radians(357.52911 + 35999.05029 * t - 0.0001537 * t**2)
    eccentricity = 0.016708634 - 0.000042037 * t - 0.0000001267 * t**2
    centre = (
        (1.914602 - 0.004817 * t - 0.000014 * t**2) * np.sin(anomaly)
        + (0.019993 - 0.000101 * t) * np.sin(2 * anomaly)
        + 0.000289 * np.sin(3 * anomaly)
    )
    true_anomaly = anomaly + np.radians(centre)
    distance = (
        _METRES_PER_AU
        * 1.000001018
        * (1 - eccentricity**2)
        / (1 + eccentricity * np.cos(true_anomaly))
    )
    # Less the aberration, with no nutation.
    longitude = np.radians(mean_longitude + centre - 0.00569)
    # Chapter 22: 23 degrees 26 minutes 21.448 seconds, then seconds per century.
    tilt = np.radians(
        23.0 + 26.0 / 60.0 + (21.448 - 46.8150 * t - 0.00059 * t**2 + 0.001813 * t**3) / 3600.0
    )
    inertial = np.stack(
        (
            distance * np.cos(longitude),
            distance * np.cos(tilt) * np.sin(longitude),
            distance * np.sin(tilt) * np.sin(longitude),
        ),
        axis=-1,
    )
    return _earth_fixed(inertial, _earth_turned(ts))


def moon_at(ts: ArrayLike) -> Floats:
    """Return the Moon's Earth-fixed position in metres, to a few tenths of a degree.

    The Astronomical Almanac's low-precision formulae, in the mean equator and equinox of date.
    """
    t = _centuries(ts)

    def sin(phase: float, rate: float) -> Floats:
        wave: Floats = np.sin(np.radians(phase + rate * t))
        return wave

    def cos(phase: float, rate: float) -> Floats:
        wave: Floats = np.cos(np.radians(phase + rate * t))
        return wave

    longitude = np.radians(
        218.32
        + 481267.881 * t
        + 6.29 * sin(135.0, 477198.87)
        - 1.27 * sin(259.3, -413335.36)
        + 0.66 * sin(235.7, 890534.22)
        + 0.21 * sin(269.9, 954397.74)
        - 0.19 * sin(357.5, 35999.05)
        - 0.11 * sin(186.5, 966404.03)
    )
    latitude = np.radians(
        5.13 * sin(93.3, 483202.02)
        + 0.28 * sin(228.2, 960400.89)
        - 0.28 * sin(318.3, 6003.15)
        - 0.17 * sin(217.6, -407332.21)
    )
    parallax = np.radians(
        0.9508
        + 0.0518 * cos(135.0, 477198.87)
        + 0.0095 * cos(259.3, -413335.36)
        + 0.0078 * cos(235.7, 890534.22)
        + 0.0028 * cos(269.9, 954397.74)
    )
    distance = _EQUATOR_M / np.sin(parallax)
    tilt = np.radians(23.439 - 0.0130 * t)
    across = np.cos(latitude) * np.sin(longitude)
    inertial = np.stack(
        (
            distance * np.cos(latitude) * np.cos(longitude),
            distance * (np.cos(tilt) * across - np.sin(tilt) * np.sin(latitude)),
            distance * (np.sin(tilt) * across + np.cos(tilt) * np.sin(latitude)),
        ),
        axis=-1,
    )
    return _earth_fixed(inertial, _earth_turned(ts))


class Observer:
    """Somewhere above the WGS84 ellipsoid to watch from, and how high a satellite must get."""

    def __init__(
        self,
        latitude: float,
        longitude: float,
        elevation_m: float = 0.0,
        min_elevation: float = DEFAULT_MIN_ELEVATION,
    ) -> None:
        """Work out where the place is, which way is which, and how much air is above it."""
        self.latitude = latitude
        self.longitude = longitude
        self.elevation_m = elevation_m
        self.min_elevation = min_elevation
        self.min_elevation_radians = math.radians(min_elevation)
        lat, lon = math.radians(latitude), math.radians(longitude)
        sin_lat, cos_lat = math.sin(lat), math.cos(lat)
        sin_lon, cos_lon = math.sin(lon), math.cos(lon)
        radius = _EQUATOR_M / math.sqrt(1 - _ECCENTRICITY_SQUARED * sin_lat**2)
        self.position: Floats = np.array(
            [
                (radius + elevation_m) * cos_lat * cos_lon,
                (radius + elevation_m) * cos_lat * sin_lon,
                (radius * (1 - _ECCENTRICITY_SQUARED) + elevation_m) * sin_lat,
            ]
        )
        self.normal: Floats = np.array([cos_lat * cos_lon, cos_lat * sin_lon, sin_lat])
        self.east: Floats = np.array([-sin_lon, cos_lon, 0.0])
        self.north: Floats = np.array([-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat])
        self.extinctions: Floats = np.array(
            [np.interp(elevation_m, _EXTINCTION_HEIGHTS_M, row) for row in _EXTINCTION_TABLE[:, 1:]]
        )


def _dot(a: Floats, b: Floats) -> Floats:
    total: Floats = np.sum(a * b, axis=-1)
    return total


def look(observer: Observer, pos: Floats) -> tuple[Floats, Floats, Floats]:
    """Return azimuth (0 to 360, clockwise from north), elevation and range in metres."""
    offset = pos - observer.position
    east, north, up = offset @ observer.east, offset @ observer.north, offset @ observer.normal
    azimuth = np.mod(np.degrees(np.arctan2(east, north)), 360.0)
    elevation = np.degrees(np.arctan2(up, np.hypot(east, north)))
    return azimuth, elevation, np.linalg.norm(offset, axis=-1)


def geodetic(pos: Floats) -> tuple[Floats, Floats, Floats]:
    """Return latitude and longitude in degrees and height in km on WGS84 (Bowring's method)."""
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    across = np.hypot(x, y)
    second_eccentricity_squared = _ECCENTRICITY_SQUARED / (1 - _ECCENTRICITY_SQUARED)
    reduced = np.arctan2(z * _EQUATOR_M, across * _POLE_M)
    # Twice is far closer than a millimetre, from the ground to beyond geostationary orbit.
    for _ in range(2):
        lat = np.arctan2(
            z + second_eccentricity_squared * _POLE_M * np.sin(reduced) ** 3,
            across - _ECCENTRICITY_SQUARED * _EQUATOR_M * np.cos(reduced) ** 3,
        )
        reduced = np.arctan2((1 - _FLATTENING) * np.sin(lat), np.cos(lat))
    height = (
        across * np.cos(lat)
        + z * np.sin(lat)
        - _EQUATOR_M * np.sqrt(1 - _ECCENTRICITY_SQUARED * np.sin(lat) ** 2)
    )
    return np.degrees(lat), np.degrees(np.arctan2(y, x)), height / 1000.0


def above_horizon(observer: Observer, pos: Floats, margin: float = 0.0) -> Flags:
    """Say where positions are as high as the observer asks, or within a margin of it (degrees)."""
    offset = pos - observer.position
    lowest = math.sin(math.radians(observer.min_elevation - margin))
    high_enough: Flags = offset @ observer.normal >= lowest * np.linalg.norm(offset, axis=-1)
    return high_enough


def sunlit(origin: Floats, direction: Floats) -> Flags:
    """Say whether sunlight reaches positions (..., 3), given the direction (..., 3) to the Sun.

    Stretched so that the Earth, with the air sunlight cannot cross, is a sphere of radius 1, its
    shadow is a cylinder of the same radius reaching away from the Sun. What is inside the sphere
    or that cylinder is dark. NaN gives False.
    """
    place, sunward = origin / _SHADOW_RADII, direction / _SHADOW_RADII
    from_centre_squared = _dot(place, place)
    towards_sun = _dot(place, sunward)
    from_axis_squared = from_centre_squared - towards_sun * towards_sun / _dot(sunward, sunward)
    in_cylinder = (towards_sun < 0.0) & (from_axis_squared <= 1.0)
    lit: Flags = (from_centre_squared > 1.0) & ~in_cylinder
    return lit


def limiting_magnitude(sun_angle: Floats | float) -> Floats:
    """Return the faintest magnitude the sky shows, given the Sun's zenith distance in radians."""
    limit: Floats = np.interp(sun_angle, _SKY_ANGLES, _SKY_LIMITS)
    return limit


def _sun_angle(observer: Observer, sun: Floats) -> Floats:
    offset = sun - observer.position
    cosine = offset @ observer.normal / np.linalg.norm(offset, axis=-1)
    angle: Floats = np.arccos(np.clip(cosine, -1.0, 1.0))
    return angle


def sky_limit(observer: Observer, sun: Floats) -> Floats:
    """Return what a satellite must beat to be seen, with the Sun at positions (n, 3)."""
    return limiting_magnitude(_sun_angle(observer, sun)) - _SKY_MARGIN


def _starlink_at_1000_km(curve: str, phase_degrees: Floats) -> Floats:
    """Return a Starlink's magnitude at 1000 km, which holds its value outside the fitted range."""
    p = np.clip(phase_degrees, *_CURVE_FIT_DEGREES)
    return 3.365 + 0.06376 * p - 1.716e-4 * p**2 - 1.139e-6 * p**3 - _CURVE_OFFSETS[curve]


def _apparent(
    sat: Satellite, observer: Observer, elevation: Floats, distance: Floats, cos_phase: Floats
) -> Floats:
    """Return the magnitude seen from the observer; NaN where it is not finite."""
    if sat.curve in _CURVE_OFFSETS:
        at_reference = _starlink_at_1000_km(sat.curve, np.degrees(np.arccos(cos_phase)))
    elif sat.standard_magnitude is not None:
        with np.errstate(divide="ignore", invalid="ignore"):
            at_reference = sat.standard_magnitude - 2.5 * np.log10(1.0 + cos_phase)
    else:
        return np.full_like(distance, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        magnitude = (
            at_reference
            + 5.0 * np.log10(distance / _REFERENCE_M)
            + np.interp(elevation, _EXTINCTION_ELEVATIONS, observer.extinctions)
        )
    return np.where(np.isfinite(magnitude), magnitude, np.nan)


class Photometry(NamedTuple):
    """How a satellite looks, for positions (n, 3)."""

    elevation: Floats  # Radians.
    distance: Floats  # Metres.
    sun_angle: Floats  # Radians from the zenith.
    lit: Flags
    magnitude: Floats  # Kept even when too low, faint or in shadow.
    limiting: Floats  # The faintest the sky shows.
    high_enough: Flags  # As high as the observer asks.


def photometry(sat: Satellite, observer: Observer, pos: Floats, sun: Floats) -> Photometry:
    """Work out how a satellite looks at positions (n, 3), with the Sun at positions (n, 3)."""
    to_satellite = pos - observer.position
    to_sun = sun - pos
    distance = np.linalg.norm(to_satellite, axis=-1)
    elevation = np.arcsin(np.clip(to_satellite @ observer.normal / distance, -1.0, 1.0))
    # The angle at the satellite between the Sun and the observer.
    cos_phase = np.clip(
        -_dot(to_satellite, to_sun) / (distance * np.linalg.norm(to_sun, axis=-1)), -1.0, 1.0
    )
    sun_angle = _sun_angle(observer, sun)
    return Photometry(
        elevation=elevation,
        distance=distance,
        sun_angle=sun_angle,
        lit=sunlit(pos, to_sun),
        magnitude=_apparent(sat, observer, elevation, distance, cos_phase),
        limiting=limiting_magnitude(sun_angle),
        high_enough=elevation >= observer.min_elevation_radians,
    )


def visible(light: Photometry, faintest: float | None = None) -> Flags:
    """Say where a satellite can be seen and, if given, is brighter than ``faintest``."""
    seen: Flags = (
        light.high_enough
        & np.isfinite(light.distance)
        & light.lit
        & (light.magnitude <= light.limiting - _SKY_MARGIN)
    )
    return seen if faintest is None else seen & (light.magnitude < faintest)


def bright_enough_nearby(
    light: Photometry, faintest: float, past_cutoff: float, past_sky: float
) -> Flags:
    """Say where a satellite could be bright enough to count, a little before or after.

    It can gain a magnitude or more in half a minute: ``past_cutoff`` and ``past_sky`` are how far
    short of the cutoff and of what the sky shows it may fall.
    """
    could: Flags = (
        np.isfinite(light.distance)
        & (light.magnitude < faintest + past_cutoff)
        & (light.magnitude <= light.limiting - _SKY_MARGIN + past_sky)
    )
    return could


def moon_dimming(observer: Observer, when: float) -> float:
    """Return what the Moon's light takes off the sky at a moment, in magnitudes.

    Nothing while it is down. A rule of thumb: how much of it is lit, times how high it is.
    """
    moon, sun = moon_at(when), sun_at(when)
    _, elevation, _ = look(observer, moon)
    if not elevation > 0.0:
        return 0.0
    cos_elongation = _dot(moon, sun) / (np.linalg.norm(moon) * np.linalg.norm(sun))
    lit = (1.0 - float(cos_elongation)) / 2.0
    return _MOONLIGHT_MAGNITUDES * lit * math.sin(math.radians(float(elevation)))


def brightest_possible(sat: Satellite, observer: Observer) -> float:
    """Return a magnitude it can never beat from here; infinity with no brightness at all.

    That is overhead at perigee (never closer than 100 km), fully lit, through the least air.
    """
    if sat.curve in _CURVE_OFFSETS:
        low, high = _CURVE_FIT_DEGREES
        at_reference = float(
            np.min(_starlink_at_1000_km(sat.curve, np.arange(low, high + 1.0, 1.0)))
        )
    elif sat.standard_magnitude is not None:
        at_reference = sat.standard_magnitude - _FULLY_LIT
    else:
        return math.inf
    distance_km = max(apsides_km(sat)[0], _NEAREST_KM)
    return (
        at_reference
        + 5.0 * math.log10(distance_km * 1000.0 / _REFERENCE_M)
        + float(np.min(observer.extinctions))
    )


def propagate(satrecs: Sequence[Satrec], ts: ArrayLike) -> Floats:
    """Return positions (satellites, times, 3), Earth-fixed metres, NaN where SGP4 fails.

    SatrecArray works on its own copies, so the records can be shared between threads.
    """
    times = np.atleast_1d(np.asarray(ts, dtype=float))
    if not satrecs:
        return np.empty((0, times.size, 3))
    jd, fr = julian(times)
    errors, inertial, _ = SatrecArray(list(satrecs)).sgp4(jd, fr)
    metres = np.where(errors[..., np.newaxis] == 0, inertial * 1000.0, np.nan)
    return _earth_fixed(metres, _earth_turned(times))


def period_s(sat: Satellite) -> float:
    """Return how long one orbit takes, from the mean motion."""
    return _DAY_S / float(sat.elements["MEAN_MOTION"])


def apsides_km(sat: Satellite) -> tuple[float, float]:
    """Return perigee and apogee heights above the spherical Earth."""
    motion = float(sat.elements["MEAN_MOTION"]) * math.tau / _DAY_S
    eccentricity = float(sat.elements["ECCENTRICITY"])
    axis = (_MU_KM3_PER_S2 / motion**2) ** (1.0 / 3.0)
    return (
        axis * (1.0 - eccentricity) - _EARTH_RADIUS_KM,
        axis * (1.0 + eccentricity) - _EARTH_RADIUS_KM,
    )


class SatellitePosition(NamedTuple):
    """Where a satellite is at a moment: in the sky, over the Earth, and in the Sun or not."""

    azimuth: float
    elevation: float
    range_km: float
    latitude: float
    longitude: float
    altitude_km: float
    sunlit: bool


def satellite_position(sat: Satellite, observer: Observer, when: float) -> SatellitePosition | None:
    """Return where a satellite is at a moment (Unix seconds); None if SGP4 cannot place it."""
    place = propagate([sat.sgp4_record()], [when])[0, 0]
    if not np.isfinite(place).all():
        return None
    azimuth, elevation, distance = look(observer, place)
    latitude, longitude, altitude = geodetic(place)
    return SatellitePosition(
        float(azimuth),
        float(elevation),
        float(distance) / 1000.0,
        float(latitude),
        float(longitude),
        float(altitude),
        bool(sunlit(place, sun_at(when) - place)),
    )


@dataclass(frozen=True)
class SkyPoint:
    """Where a satellite is at a moment (Unix seconds)."""

    time: float
    azimuth: float
    elevation: float


@dataclass(frozen=True)
class SightingShape:
    """The highest point of a visible window, and why it begins and ends."""

    peak: SkyPoint
    start_reason: str
    end_reason: str


def _edge_reason(elevation: float, lit: bool, horizon: str, lowest: float) -> str:
    if elevation < lowest:
        return horizon
    return "shadow" if math.isfinite(elevation) and not lit else "sky"


def sighting_shape(
    sat: Satellite, observer: Observer, start: float, end: float, fallback: SkyPoint
) -> SightingShape:
    """Look at the visible window [start, end) second by second.

    The reasons come from the second just before it and the second that ends it. Where SGP4
    fails throughout, ``fallback`` is the peak.
    """
    first = round(start)
    last = max(round(end), first + 1)
    seconds = np.arange(first - 1.0, last + 1.0)
    places = propagate([sat.sgp4_record()], seconds)[0]
    azimuth, elevation, _ = look(observer, places)
    if np.isnan(elevation[1:-1]).all():
        return SightingShape(fallback, "sky", "sky")
    highest = 1 + int(np.nanargmax(elevation[1:-1]))
    lit = sunlit(places, sun_at(seconds) - places)
    return SightingShape(
        SkyPoint(float(seconds[highest]), float(azimuth[highest]), float(elevation[highest])),
        _edge_reason(float(elevation[0]), bool(lit[0]), "rise", observer.min_elevation),
        _edge_reason(float(elevation[-1]), bool(lit[-1]), "set", observer.min_elevation),
    )


def _when(t: float) -> Number:
    """Return a time to the millisecond, whole seconds as integers."""
    seconds = round(float(t), 3)
    return int(seconds) if seconds.is_integer() else seconds


def _rounded(values: Floats, digits: int) -> list[float]:
    """Round to a number of decimals, never to -0.0."""
    rounded: list[float] = (np.round(values, digits) + 0.0).tolist()
    return rounded


def _rounded_azimuth(values: Floats, digits: int) -> list[float]:
    """Round azimuths, with what rounds up to 360 going back to 0."""
    return _rounded(np.mod(np.round(values, digits), 360.0), digits)


class PassTrack(NamedTuple):
    """A satellite's way across the sky, from just below the horizon to just below it again."""

    horizon_rise: Number
    horizon_set: Number
    rows: list[list[Any]]  # Each [t, lat, lon, alt_km, lit, az, el, range_km, mag, vis].


def _horizon_edge(observer: Observer, satrec: Satrec, times: Floats) -> float:
    """Return the first of these times with the satellite not up, or else the last of them."""
    _, elevation, _ = look(observer, propagate([satrec], times)[0])
    down = np.flatnonzero(~(elevation > 0.0))
    return float(times[down[0] if down.size else -1])


def _track_rows(
    sat: Satellite, observer: Observer, times: Floats, places: Floats, faintest: float | None
) -> list[list[Any]]:
    sun = sun_at(times)
    light = photometry(sat, observer, places, sun)
    seen = visible(light, faintest)
    azimuth, elevation, distance = look(observer, places)
    latitude, longitude, altitude = geodetic(places)
    shown = light.lit & (elevation > 0.0) & np.isfinite(light.magnitude)
    magnitudes: list[float | None] = [
        value if show else None
        for value, show in zip(_rounded(light.magnitude, 1), shown.tolist(), strict=True)
    ]
    return [
        [_when(t), *row]
        for t, *row in zip(
            times.tolist(),
            _rounded(latitude, 4),
            _rounded(longitude, 4),
            _rounded(altitude, 1),
            light.lit.astype(int).tolist(),
            _rounded_azimuth(azimuth, 2),
            _rounded(elevation, 2),
            _rounded(distance / 1000.0, 1),
            magnitudes,
            seen.astype(int).tolist(),
            strict=True,
        )
    ]


def pass_track(
    sat: Satellite,
    observer: Observer,
    start: float,
    end: float,
    step: float,
    faintest: float | None,
) -> PassTrack | None:
    """Trace a pass from just below the horizon before a visible window to just below it after.

    Rows keep to multiples of ``step`` from ``start``. None if SGP4 fails throughout or the
    window's middle is not above the horizon.
    """
    satrec = sat.sgp4_record()
    middle = (start + end) / 2.0
    _, elevation_at_middle, _ = look(observer, propagate([satrec], [middle])[0])
    if not elevation_at_middle[0] > 0.0:
        return None

    reach = np.arange(0.0, _SCAN_REACH_S + _SCAN_STEP_S, _SCAN_STEP_S)
    rise = _horizon_edge(observer, satrec, start - reach)
    fall = _horizon_edge(observer, satrec, end + reach)
    multiples = np.arange(math.floor((rise - start) / step), math.ceil((fall - start) / step) + 1)
    times = start + step * multiples
    places = propagate([satrec], times)[0]
    _, elevation, _ = look(observer, places)

    # The run above the horizon holding the middle, and one sample either side of it.
    above = elevation > 0.0
    ups = np.flatnonzero(above)
    if not ups.size:
        return None
    centre = ups[np.argmin(np.abs(times[ups] - middle))]
    breaks = np.flatnonzero(~above)
    before, after = breaks[breaks < centre], breaks[breaks > centre]
    first = int(before[-1]) if before.size else 0
    last = int(after[0]) if after.size else times.size - 1
    keep = first + np.flatnonzero(np.isfinite(places[first : last + 1]).all(axis=-1))

    rows = _track_rows(sat, observer, times[keep], places[keep], faintest)
    return PassTrack(rows[0][0], rows[-1][0], rows)


def sun_rows(observer: Observer, start: float, end: float, step: float) -> list[list[Any]]:
    """Return the Sun as rows [t, azimuth, elevation] from ``start`` for as long as fits."""
    times = float(start) + np.arange(0.0, float(end) - float(start) + 1e-6, step)
    azimuth, elevation, _ = look(observer, sun_at(times))
    return [
        [_when(t), az, el]
        for t, az, el in zip(
            times.tolist(),
            _rounded_azimuth(azimuth, 1),
            _rounded(elevation, 1),
            strict=True,
        )
    ]


def ground_rows(satrec: Satrec, ts: ArrayLike) -> list[list[Any]]:
    """Return rows [t, lat, lon, alt_km, lit] where SGP4 succeeds."""
    times = np.atleast_1d(np.asarray(ts, dtype=float))
    places = propagate([satrec], times)[0]
    good = np.isfinite(places).all(axis=-1)
    times, places = times[good], places[good]
    latitude, longitude, altitude = geodetic(places)
    lit = sunlit(places, sun_at(times) - places)
    return [
        [_when(t), lat, lon, alt, shone]
        for t, lat, lon, alt, shone in zip(
            times.tolist(),
            _rounded(latitude, 4),
            _rounded(longitude, 4),
            _rounded(altitude, 1),
            lit.astype(int).tolist(),
            strict=True,
        )
    ]


class Positions(NamedTuple):
    """Where many satellites are at many times: each (satellites, times), except ``ok``."""

    ok: Flags  # Per satellite: SGP4 succeeded at every time.
    latitude: Floats
    longitude: Floats
    altitude_km: Floats
    lit: Flags


def positions(satrecs: Sequence[Satrec], ts: ArrayLike) -> Positions:
    """Place every satellite at every time."""
    times = np.atleast_1d(np.asarray(ts, dtype=float))
    places = propagate(satrecs, times)
    latitude, longitude, altitude = geodetic(places)
    return Positions(
        ok=np.asarray(np.isfinite(places).all(axis=(1, 2))),
        latitude=latitude,
        longitude=longitude,
        altitude_km=altitude,
        lit=sunlit(places, sun_at(times) - places),
    )
