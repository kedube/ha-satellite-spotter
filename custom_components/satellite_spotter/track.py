"""Where a satellite is, whether it is sunlit and how bright it looks, along a track.

The pysatellitespotter library predicts when satellites are visible. Drawing a
pass on the globe and in the street view needs more: positions every few
seconds from horizon to horizon, the magnitude even while it is too faint to
count, and why a pass begins and ends. This module computes them with the
library's own formulas (pysatellitespotter/predict.py, a port of James
Darpinian's See A Satellite Tonight), but only through its public API, sgp4
and numpy: the library's helpers are private and may change without notice.
tests/test_track.py checks that this module agrees with them exactly.

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
    from pysatellitespotter import Satellite

# WGS84, as in the library.
_A = 6378137.0
_B = 6356752.3142451793
_E2 = 1.0 - (_B * _B) / (_A * _A)
_AU_M = 149597870700.0
_EARTH_MU_KM = 398600.4418
_EARTH_RADIUS_KM = 6378.137
_UNIX_EPOCH_JD = 2440587.5
_J2000_JD = 2451545.0
_DAY_S = 86400.0

# The library's horizon and the height sunlight must clear (the troposphere
# blocks a ray that grazes the Earth lower than this).
MIN_ELEVATION = 10.0
MIN_GRAZING_HEIGHT_M = 15000.0
_MIN_ELEVATION_RAD = math.radians(MIN_ELEVATION)
# A satellite must be this much brighter than the faintest star the sky shows.
_SKY_MARGIN = 0.3

# Limiting magnitude by the Sun's angle from the zenith (Weaver 1947, PASP 59,
# 232, fig. 2, daylight a bit brighter and truncated at 4, as the library has it).
_LIMITING_MAGNITUDES = np.array([-4, -3.5, -2.5, -1, 0, 1, 2, 3, 4], dtype=float)
_SUN_ANGLES = np.radians([0, 50, 82, 90, 93.2, 95.2, 96.4, 97.5, 100])
# Atmospheric extinction by elevation (Green 1992, ICQ 14, 55-59; summer, sea level).
_EXTINCTIONS = np.array(
    [12.68, 8.33, 6.11, 4.78, 3.9, 3.28, 2.82, 2.47, 2.19, 1.97, 1.79, 1.64,
     1.51, 1.4, 1.3, 1.22, 1.15, 1.08, 1.02, 0.97, 0.93, 0.85, 0.78, 0.72,
     0.68, 0.63, 0.55, 0.49, 0.45, 0.41, 0.37, 0.34, 0.32, 0.32]
)  # fmt: skip
_EXTINCTION_ELEVATIONS = np.radians(
    90 - np.array(
        [90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80, 79, 78, 77, 76, 75, 74,
         73, 72, 71, 70, 68, 66, 64, 62, 60, 55, 50, 45, 40, 30, 20, 10, 0],
        dtype=float,
    )
)  # fmt: skip
# The ellipsoid grown by the grazing height; a ray to the Sun that misses it is lit.
_GRAZING_RADII = np.array([_A, _A, _B]) + MIN_GRAZING_HEIGHT_M

# A pass begins with "rise" when it starts this low (the library's horizon is
# 10 degrees; positions differ from the library's by a fraction of a degree).
_EDGE_ELEVATION = MIN_ELEVATION + 0.3
# Seconds looked at beyond each end of a visible window to tell why it ends.
_EDGE_S = 6
# Horizon search around a visible window: this far either side, this coarse.
_SCAN_S = 1800.0
_SCAN_STEP_S = 5.0


def _distance_term(distance_m: np.ndarray) -> np.ndarray:
    return 5 * np.log10(distance_m * 1e-6)


def _starlink_cubic(
    c0: float, c1: float, c2: float, c3: float
) -> Callable[[np.ndarray, np.ndarray], np.ndarray]:
    def model(phase: np.ndarray, distance_m: np.ndarray) -> np.ndarray:
        a = np.clip(np.degrees(phase), 15, 155)
        magnitude: np.ndarray = (
            c0 + c1 * a + c2 * a * a + c3 * a * a * a + _distance_term(distance_m)
        )
        return magnitude

    return model


def _bluebird(phase: np.ndarray, distance_m: np.ndarray) -> np.ndarray:
    # AST SpaceMobile BlueBird (Cole et al. 2025), floored at magnitude 0.5.
    at_1000km = np.maximum(0.5, 2.1 + 0.022 * np.degrees(phase))
    magnitude: np.ndarray = at_1000km + _distance_term(distance_m)
    return magnitude


# Constellation-specific brightness, by the catalog's MODEL field (Mallama et
# al. 2025, arXiv:2502.03651 table 1; arXiv:2405.12007), as in the library.
_BRIGHTNESS_MODELS: dict[str, Callable[[np.ndarray, np.ndarray], np.ndarray]] = {
    "bluebird": _bluebird,
    "starlink-mini": _starlink_cubic(5.822, -0.00879, 8.483e-4, -5.784e-6),
    "starlink-dtc": _starlink_cubic(3.365, 0.06376, -1.716e-4, -1.139e-6),
    "starlink-raising": _starlink_cubic(3.365 - 1.89, 0.06376, -1.716e-4, -1.139e-6),
}


class Observer:
    """A place on Earth, with the vectors the look angles need."""

    __slots__ = ("east", "elevation_m", "latitude", "longitude", "normal", "north", "position")

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


@dataclass(frozen=True, slots=True)
class SkyPoint:
    """Where a satellite is in the sky at one instant."""

    time: float
    azimuth: float
    elevation: float


@dataclass(frozen=True, slots=True)
class TransitShape:
    """What a pass list shows beyond the library's transit.

    ``peak`` is the highest point of the visible window (the library's
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
    err, teme, _ = SatrecArray(list(satrecs)).sgp4(jd, fr)
    teme = teme * 1000.0
    teme[err != 0] = np.nan
    return _rotate_z(teme, gmst(jd + fr)[None, :])


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

    The website tests the lowest height along the ray; equivalently, the ray
    must miss the ellipsoid grown by that height, a quadratic in the space
    where that ellipsoid is the unit sphere.
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

    Unlike the library, the magnitude is kept where the satellite is too low,
    too faint or in shadow; ``visible`` applies the library's cutoffs.
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
        extinction = np.interp(elevation, _EXTINCTION_ELEVATIONS, _EXTINCTIONS)
        model = _BRIGHTNESS_MODELS.get(sat.model or "")
        if model is not None:
            magnitude = model(phase, distance) + extinction
        elif sat.magnitude is not None:
            # Intrinsic magnitude at 1000 km, range, extinction and the phase
            # of a diffusely reflecting sphere.
            f = (np.sin(phase) + (np.pi - phase) * np.cos(phase)) / np.pi
            magnitude = sat.magnitude + _distance_term(distance) + extinction - 2.5 * np.log10(f)
        else:
            magnitude = np.full(len(pos), np.nan)
    magnitude = np.where(np.isfinite(magnitude), magnitude, np.nan)
    limiting = np.interp(sun_angle, _SUN_ANGLES, _LIMITING_MAGNITUDES, left=-100.0)
    return Photometry(elevation, distance, sun_angle, sunlit(pos, sat_to_sun), magnitude, limiting)


def visible(ph: Photometry, max_magnitude: float | None = None) -> np.ndarray:
    """Where the library counts the satellite as visible (and below max_magnitude)."""
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


# --- Passes ------------------------------------------------------------------


def transit_shape(
    sat: Satellite,
    observer: Observer,
    start: float,
    end: float,
    fallback: SkyPoint,
) -> TransitShape:
    """Find the highest point of a visible window [start, end) and why it begins and ends.

    ``fallback`` (the library's brightest point) stands in where SGP4 fails.
    """
    start, end = round(start), round(end)
    ts = np.arange(start - _EDGE_S, end + _EDGE_S + 1, 1.0)
    pos = propagate([sat.satrec()], ts)[0]
    with np.errstate(invalid="ignore"):
        azimuth, elevation, _ = look(observer, pos)
        lit = sunlit(pos, sun_at(ts) - pos)
        inside = (ts >= start) & (ts < max(end, start + 1)) & np.isfinite(elevation)
    if not inside.any():
        return TransitShape(fallback, "sky", "sky")
    i = int(np.flatnonzero(inside)[np.argmax(elevation[inside])])
    peak = SkyPoint(float(ts[i]), float(azimuth[i]), float(elevation[i]))
    first, last = _EDGE_S, _EDGE_S + (end - start)
    return TransitShape(
        peak,
        _reason(elevation[first], lit[:first], "rise"),
        _reason(elevation[last], lit[last:], "set"),
    )


def _reason(edge_elevation: float, outside_lit: np.ndarray, horizon: str) -> str:
    """Why a visible window begins (or ends) at an edge.

    Low at the edge: the horizon. Otherwise in Earth's shadow just outside
    the window (positions differ from the library's by a second or two, so
    a few seconds are looked at), or else the sky was too bright for it.
    """
    if edge_elevation <= _EDGE_ELEVATION:
        return horizon
    if not outside_lit.all():
        return "shadow"
    return "sky"


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
    horizon (however faint), ``vis`` 1 where the library would count it as
    visible. The rows keep to multiples of ``step`` from the window's start.
    """
    satrec = sat.satrec()
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
    return _DAY_S / float(sat.omm["MEAN_MOTION"])


def apsides_km(sat: Satellite) -> tuple[float, float]:
    """Perigee and apogee heights above a spherical Earth, as the library measures them."""
    n = float(sat.omm["MEAN_MOTION"]) * 2 * math.pi / _DAY_S
    a = (_EARTH_MU_KM / (n * n)) ** (1 / 3)
    e = float(sat.omm["ECCENTRICITY"])
    return a * (1 - e) - _EARTH_RADIUS_KM, a * (1 + e) - _EARTH_RADIUS_KM


def _seconds(t: float) -> float | int:
    """Unix time to the millisecond; whole seconds stay integers to keep payloads small."""
    t = round(t, 3)
    return int(t) if t.is_integer() else t
