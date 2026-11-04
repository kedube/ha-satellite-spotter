"""Where a satellite is, whether it is sunlit and how bright it looks.

predict.py searches with these to find the passes, and the globe and the street
view draw with them: positions every few seconds from horizon to horizon, the
magnitude even while it is too faint to count, and why a pass begins and ends.

The formulas are published, and cited where they are used. Some numbers have no
source to cite: what counts as visible (the horizon, the height sunlight must
clear, the margin over the sky's limit), two departures from Weaver's curve, and
in predict.py what counts as bright and how close passes must be to count as one.
They are the choices James Darpinian made for See A Satellite Tonight
(https://james.darpinian.com/satellites/), kept because nothing yet says better.
tests/test_track.py checks the geometry against Skyfield, and tests/test_predict.py
the tables against their sources.

Times are Unix seconds, angles degrees, positions Earth-fixed metres. There
are no Home Assistant imports: everything here runs in executor jobs.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
import math
from typing import TYPE_CHECKING, Any, NamedTuple

import numpy as np
from sgp4.api import Satrec, SatrecArray

if TYPE_CHECKING:
    from .predict import Satellite

# WGS84.
_A = 6378137.0
_B = 6356752.3142451793
_E2 = 1.0 - (_B * _B) / (_A * _A)
_AU_M = 149597870700.0
_EARTH_MU_KM = 398600.4418
_EARTH_RADIUS_KM = 6378.137
_UNIX_EPOCH_JD = 2440587.5
_J2000_JD = 2451545.0
_DAY_S = 86400.0

# Below this a satellite counts as hidden, and a ray of sunlight that grazes the
# Earth lower than this (through the troposphere) counts as blocked.
MIN_ELEVATION = 10.0
MIN_GRAZING_HEIGHT_M = 15000.0
_MIN_ELEVATION_RAD = math.radians(MIN_ELEVATION)
_SIN_MIN_ELEVATION = math.sin(_MIN_ELEVATION_RAD)
# A satellite must be this much brighter than the faintest star the sky shows.
_SKY_MARGIN = 0.3

# The faintest magnitude the sky shows, by the Sun's angle from the zenith: points
# read from Weaver 1947, PASP 59, 232, fig. 2. Two departures from the curve: full
# daylight at -4 where it shows about -3.2, and stopping at 4 where it goes on to 6
# by 106 degrees, as a satellite is harder to find than a star.
_LIMITING_MAGNITUDES = np.array([-4, -3.5, -2.5, -1, 0, 1, 2, 3, 4], dtype=float)
_SUN_ANGLES = np.radians([0, 50, 82, 90, 93.2, 95.2, 96.4, 97.5, 100])
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
# The ellipsoid grown by the grazing height; a ray to the Sun that misses it is lit.
_GRAZING_RADII = np.array([_A, _A, _B]) + MIN_GRAZING_HEIGHT_M

# Horizon search around a visible window: this far either side, this coarse.
_SCAN_S = 1800.0
_SCAN_STEP_S = 5.0


def _distance_dimming(distance_m: np.ndarray) -> np.ndarray:
    """How much fainter something looks at this distance than at 1000 km."""
    return 5 * np.log10(distance_m / 1e6)


def _starlink_curve(
    constant: float, linear: float, quadratic: float, cubic: float
) -> Callable[[np.ndarray, np.ndarray], np.ndarray]:
    """Return a published fit: the magnitude at 1000 km, cubic in the phase angle in degrees."""

    def model(phase: np.ndarray, distance_m: np.ndarray) -> np.ndarray:
        degrees = np.clip(np.degrees(phase), 15, 155)
        at_1000_km = np.polyval([cubic, quadratic, linear, constant], degrees)
        magnitude: np.ndarray = at_1000_km + _distance_dimming(distance_m)
        return magnitude

    return model


# Starlinks, by the catalog's MODEL field. Direct-to-cell satellites: the phase
# function in Mallama et al. 2025, arXiv:2502.03651, table 1. Those still raising
# their orbits, before brightness mitigation starts at 357 km: the same curve, moved
# by the difference between its mean of 6.47 and their mean of 4.58 at 1000 km
# (Mallama et al. 2024, arXiv:2405.12007).
_BRIGHTNESS_MODELS: dict[str, Callable[[np.ndarray, np.ndarray], np.ndarray]] = {
    "starlink-dtc": _starlink_curve(3.365, 0.06376, -1.716e-4, -1.139e-6),
    "starlink-raising": _starlink_curve(3.365 - (6.47 - 4.58), 0.06376, -1.716e-4, -1.139e-6),
}
_PHASE_GRID = np.radians(np.arange(0.0, 181.0))
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
        """Place the observer on the WGS84 ellipsoid."""
        self.latitude = latitude
        self.longitude = longitude
        self.elevation_m = elevation_m
        lat, lon = math.radians(latitude), math.radians(longitude)
        sl, cl, so, co = math.sin(lat), math.cos(lat), math.sin(lon), math.cos(lon)
        n = _A / math.sqrt(1 - _E2 * sl * sl)
        self.position = np.array(
            [
                (n + elevation_m) * cl * co,
                (n + elevation_m) * cl * so,
                (n * (1 - _E2) + elevation_m) * sl,
            ]
        )
        self.normal = np.array([cl * co, cl * so, sl])
        self.east = np.array([-so, co, 0.0])
        self.north = np.array([-sl * co, -sl * so, cl])
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


def gmst(jd: np.ndarray) -> np.ndarray:
    """Greenwich mean sidereal time in radians (IAU-82, as SGP4's TEME frame uses)."""
    t = (jd - _J2000_JD) / 36525.0
    seconds = (
        -6.2e-6 * t**3 + 0.093104 * t**2 + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841
    )
    return np.radians((seconds % _DAY_S) / 240.0)


def _rotate_z(vec: np.ndarray, angle: np.ndarray) -> np.ndarray:
    """Rotate inertial vectors (..., 3) into the Earth-fixed frame."""
    c, s = np.cos(angle), np.sin(angle)
    out = np.empty_like(vec)
    out[..., 0] = vec[..., 0] * c + vec[..., 1] * s
    out[..., 1] = -vec[..., 0] * s + vec[..., 1] * c
    out[..., 2] = vec[..., 2]
    return out


def sun_ecef(jd: np.ndarray) -> np.ndarray:
    """Return the Sun's Earth-fixed position in metres (Astronomical Almanac, ~0.01 degree)."""
    n = jd - _J2000_JD
    mean_lon = np.radians(280.460 + 0.9856474 * n)
    g = np.radians(357.528 + 0.9856003 * n)
    lam = mean_lon + np.radians(1.915 * np.sin(g) + 0.020 * np.sin(2 * g))
    eps = np.radians(23.439 - 0.0000004 * n)
    dist = (1.00014 - 0.01671 * np.cos(g) - 0.00014 * np.cos(2 * g)) * _AU_M
    eci = np.stack(
        [dist * np.cos(lam), dist * np.cos(eps) * np.sin(lam), dist * np.sin(eps) * np.sin(lam)],
        axis=-1,
    )
    return _rotate_z(eci, gmst(jd))


def sun_at(ts: np.ndarray) -> np.ndarray:
    """Return the Sun's Earth-fixed position (metres) at Unix times."""
    jd, fr = julian(ts)
    return sun_ecef(jd + fr)


def propagate(satrecs: Sequence[Satrec], ts: np.ndarray) -> np.ndarray:
    """Earth-fixed positions in metres, shape (satellites, times, 3); NaN where SGP4 fails.

    SatrecArray copies the records, so the Satrec objects passed in are never
    changed and may be shared between threads.
    """
    jd, fr = julian(ts)
    failed, km, _ = SatrecArray(list(satrecs)).sgp4(jd, fr)
    metres = np.where(failed[..., None] != 0, np.nan, km * 1000.0)
    return _rotate_z(metres, gmst(jd + fr)[None, :])


def geodetic(pos: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Latitude and longitude in degrees and height in km of Earth-fixed positions."""
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1 - _E2))
    for _ in range(4):
        s = np.sin(lat)
        lat = np.arctan2(z + _E2 * (_A / np.sqrt(1 - _E2 * s * s)) * s, p)
    s = np.sin(lat)
    height = p * np.cos(lat) + z * s - _A * np.sqrt(1 - _E2 * s * s)
    return np.degrees(lat), np.degrees(np.arctan2(y, x)), height / 1000.0


def look(observer: Observer, pos: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Azimuth and elevation in degrees and range in metres of positions (..., 3)."""
    d = pos - observer.position
    distance = np.linalg.norm(d, axis=-1)
    elevation = np.pi / 2 - np.arccos(np.clip(d @ observer.normal / distance, -1, 1))
    azimuth = np.degrees(np.arctan2(d @ observer.east, d @ observer.north)) % 360
    return azimuth, np.degrees(elevation), distance


def sunlit(origin: np.ndarray, direction: np.ndarray) -> np.ndarray:
    """Whether rays from positions towards the Sun clear the grazing ellipsoid.

    The ray must miss the ellipsoid grown by the grazing height, a quadratic
    in the space where that ellipsoid is the unit sphere.
    """
    so, sd = origin / _GRAZING_RADII, direction / _GRAZING_RADII
    a = np.einsum("ij,ij->i", sd, sd)
    b = np.einsum("ij,ij->i", so, sd)
    c = np.einsum("ij,ij->i", so, so) - 1.0
    # In shadow if inside, or heading inwards and meeting it.
    lit: np.ndarray = (c >= 0) & ((b >= 0) | (b * b - a * c <= 0))
    return lit


# --- Brightness --------------------------------------------------------------


def photometry(sat: Satellite, observer: Observer, pos: np.ndarray, sun: np.ndarray) -> Photometry:
    """Apparent magnitude and visibility inputs at positions (n, 3) with the Sun at sun (n, 3).

    The magnitude is kept even where the satellite is too low, too faint or in
    shadow; ``visible`` applies the cutoffs.
    """
    user_to_sat = pos - observer.position
    distance = np.linalg.norm(user_to_sat, axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        elevation = np.pi / 2 - np.arccos(np.clip(user_to_sat @ observer.normal / distance, -1, 1))
        sun_angle = np.arccos(np.clip(sun @ observer.normal / np.linalg.norm(sun, axis=-1), -1, 1))
        sat_to_sun = sun - pos
        cos_phase = np.einsum("ij,ij->i", -user_to_sat, sat_to_sun) / (
            distance * np.linalg.norm(sat_to_sun, axis=-1)
        )
        phase = np.arccos(np.clip(cos_phase, -1, 1))
        extinction = np.interp(elevation, _EXTINCTION_ELEVATIONS, observer.extinctions)
        model = _BRIGHTNESS_MODELS.get(sat.model or "")
        if model is not None:
            magnitude = model(phase, distance) + extinction
        elif sat.magnitude is not None:
            # Standard magnitude at 1000 km, range, extinction and the phase of
            # a diffusely reflecting sphere.
            f = (np.sin(phase) + (np.pi - phase) * np.cos(phase)) / np.pi
            magnitude = sat.magnitude + _distance_dimming(distance) + extinction - 2.5 * np.log10(f)
        else:
            magnitude = np.full(len(pos), np.nan)
    magnitude = np.where(np.isfinite(magnitude), magnitude, np.nan)
    limiting = np.interp(sun_angle, _SUN_ANGLES, _LIMITING_MAGNITUDES, left=-100.0)
    return Photometry(elevation, distance, sun_angle, sunlit(pos, sat_to_sun), magnitude, limiting)


def visible(ph: Photometry, max_magnitude: float | None = None) -> np.ndarray:
    """Where the satellite counts as visible (and below max_magnitude)."""
    with np.errstate(invalid="ignore"):
        result: np.ndarray = (
            (ph.elevation >= _MIN_ELEVATION_RAD)
            & np.isfinite(ph.distance)
            & ph.lit
            & (ph.magnitude <= ph.limiting - _SKY_MARGIN)
        )
        if max_magnitude is not None:
            result &= ph.magnitude < max_magnitude
    return result


def limiting_magnitude(sun_angle: np.ndarray) -> np.ndarray:
    """Return the faintest magnitude the sky shows, by the Sun's angle from the zenith."""
    limit: np.ndarray = np.interp(sun_angle, _SUN_ANGLES, _LIMITING_MAGNITUDES, left=-100.0)
    return limit


def sky_limit(observer: Observer, sun: np.ndarray) -> np.ndarray:
    """Return how bright a satellite must be to count as visible, with the Sun at sun (n, 3)."""
    sun_angle = np.arccos(np.clip(sun @ observer.normal / np.linalg.norm(sun, axis=-1), -1, 1))
    return limiting_magnitude(sun_angle) - _SKY_MARGIN


def above_horizon(observer: Observer, pos: np.ndarray) -> np.ndarray:
    """Return where positions (..., 3) are at least MIN_ELEVATION up."""
    d = pos - observer.position
    high: np.ndarray = d @ observer.normal >= _SIN_MIN_ELEVATION * np.linalg.norm(d, axis=-1)
    return high


def brightest_possible(sat: Satellite, observer: Observer) -> float:
    """Return a magnitude it can never beat from here: overhead, at perigee, fully lit."""
    distance = max(apsides_km(sat)[0] * 1000.0, _MIN_PERIGEE_M)
    model = _BRIGHTNESS_MODELS.get(sat.model or "")
    if model is not None:
        best = float(model(_PHASE_GRID, np.full_like(_PHASE_GRID, distance)).min())
    elif sat.magnitude is None:
        return math.inf
    else:
        best = sat.magnitude + 5 * math.log10(distance * 1e-6)
    return best + float(observer.extinctions.min())


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
    max_magnitude: float,
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
        shown = visible(ph, max_magnitude)
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
    count, times = pos.shape[:2]
    with np.errstate(invalid="ignore"):
        lat, lon, alt = geodetic(pos)
        flat = pos.reshape(-1, 3)
        to_sun = (sun_at(ts)[None, :, :] - pos).reshape(-1, 3)
        lit = sunlit(flat, to_sun).reshape(count, times)
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
