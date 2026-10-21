/**
 * Astronomy for the planetarium sky of the street view: sidereal time and
 * precession, stars in the observer's sky, the Sun, the Moon and its phase,
 * the planets Mercury to Saturn with their magnitudes, refraction and
 * extinction, the colour of the sky through twilight, and star drawing
 * helpers. Pure functions with no DOM, unit tested against Skyfield (JPL
 * DE421) with node --test "tests/js/*.test.mjs".
 *
 * Angles are degrees; azimuth runs clockwise from north. An observer is
 * {latitude, longitude, elevation} (metres), as in sat-geo.js. A date is a
 * Date or unix milliseconds. Positions are geometric, like the pass
 * predictions: refraction() lifts them near the horizon when wanted.
 *
 * Star data (STARS in sat-stars.js) is a flat array [ra, dec, mag, bv, ...], J2000.
 */

const DEG = Math.PI / 180;
const J2000 = 2451545.0;
/** TT - UTC: 32.184 s + 37 leap seconds (since 2017). The ephemerides run on TT. */
const TT_UTC_S = 69.184;
const AU_KM = 149597870.7;
const LIGHT_DAYS_PER_AU = 0.0057755183;
const WGS84_A_KM = 6378.137;
const WGS84_E2 = 0.00669437999014;
const MOON_RADIUS_KM = 1737.4;
const SUN_RADIUS_AU = 0.0046524726;
const OBLIQUITY_J2000 = 23.4392911 * DEG;

const wrap360 = (x) => ((x % 360) + 360) % 360;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mix = (a, b, f) => a.map((x, i) => x + (b[i] - x) * f);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

// ---------------------------------------------------------------- time, frames

/** Julian date (UTC) of a Date or unix milliseconds. */
export function julianDate(date) {
  return +date / 86400000 + 2440587.5;
}

/** Julian centuries of Terrestrial Time since J2000, the time of the ephemerides. */
export function centuriesTT(date) {
  return (julianDate(date) + TT_UTC_S / 86400 - J2000) / 36525;
}

/** Greenwich mean sidereal time in degrees (IAU 1982, UT1 = UTC): sat-geo.js's gmst. */
export function greenwichSiderealTime(date) {
  const t = (julianDate(date) - J2000) / 36525;
  const seconds =
    -6.2e-6 * t ** 3 + 0.093104 * t ** 2 + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841;
  return wrap360(seconds / 240);
}

/** Local mean sidereal time in degrees: the right ascension on the meridian. */
export function localSiderealTime(date, longitude) {
  return wrap360(greenwichSiderealTime(date) + longitude);
}

/** Product of two row-major 3x3 matrices. */
function multiply(a, b) {
  const m = [];
  for (let i = 0; i < 9; i += 3) {
    for (let j = 0; j < 3; j++) m.push(a[i] * b[j] + a[i + 1] * b[3 + j] + a[i + 2] * b[6 + j]);
  }
  return m;
}

/** A row-major 3x3 matrix times a vector. */
export function applyMatrix(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Rotation from J2000 to the mean equator and equinox of date (IAU 1976
 * precession, Lieske 1977), row-major. Nutation (under 20") and aberration
 * (20") are left out: both are far below what a planetarium shows.
 */
export function precessionMatrix(date) {
  const t = centuriesTT(date);
  const as = DEG / 3600;
  const zeta = (2306.2181 + (0.30188 + 0.017998 * t) * t) * t * as;
  const z = (2306.2181 + (1.09468 + 0.018203 * t) * t) * t * as;
  const theta = (2004.3109 - (0.42665 + 0.041833 * t) * t) * t * as;
  const [cZeta, sZeta] = [Math.cos(zeta), Math.sin(zeta)];
  const [cZ, sZ] = [Math.cos(z), Math.sin(z)];
  const [cT, sT] = [Math.cos(theta), Math.sin(theta)];
  return [
    cZeta * cT * cZ - sZeta * sZ, -sZeta * cT * cZ - cZeta * sZ, -sT * cZ,
    cZeta * cT * sZ + sZeta * cZ, -sZeta * cT * sZ + cZeta * cZ, -sT * sZ,
    cZeta * sT, -sZeta * sT, cT,
  ];
}

/** Rotation from the equator and equinox of date to the observer's [east, north, up]. */
export function horizonMatrixOfDate(date, observer) {
  const lst = localSiderealTime(date, observer.longitude) * DEG;
  const lat = observer.latitude * DEG;
  const [cl, sl, cp, sp] = [Math.cos(lst), Math.sin(lst), Math.cos(lat), Math.sin(lat)];
  return [-sl, cl, 0, -sp * cl, -sp * sl, cp, cp * cl, cp * sl, sp];
}

/**
 * Rotation from J2000 equatorial coordinates (the star catalogue's) to the
 * observer's horizon frame [east, north, up]: precession to date, then the
 * Earth's turn. Precession is needed: it moves the stars 0.36 deg by 2026.
 * Row-major; WebGL's uniformMatrix3fv wants it transposed.
 */
export function horizonMatrix(date, observer) {
  return multiply(horizonMatrixOfDate(date, observer), precessionMatrix(date));
}

/** Unit vector of a right ascension and declination. */
export function raDecVector(ra, dec) {
  const a = ra * DEG;
  const d = dec * DEG;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

/** Right ascension (0..360) and declination of a vector. */
export function vectorRaDec(v) {
  return { ra: wrap360(Math.atan2(v[1], v[0]) / DEG), dec: Math.atan2(v[2], Math.hypot(v[0], v[1])) / DEG };
}

/** Azimuth and elevation of a horizon-frame vector [east, north, up]. */
export function azimuthElevation(v) {
  return {
    azimuth: wrap360(Math.atan2(v[0], v[1]) / DEG),
    elevation: Math.atan2(v[2], Math.hypot(v[0], v[1])) / DEG,
  };
}

/** Horizon-frame unit vector [east, north, up] of an azimuth and elevation. */
export function azElVector(azimuth, elevation) {
  const a = azimuth * DEG;
  const e = elevation * DEG;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

/** Where a J2000 RA/Dec is in the sky, given horizonMatrix(date, observer). */
export function toHorizon(matrix, ra, dec) {
  return azimuthElevation(applyMatrix(matrix, raDecVector(ra, dec)));
}

/** Where a J2000 RA/Dec (a star) is in the observer's sky at a date. */
export function raDecToAzEl(ra, dec, date, observer) {
  return toHorizon(horizonMatrix(date, observer), ra, dec);
}

/**
 * J2000 unit vectors of the stars of stars.json ([ra, dec, mag, bv, ...]), as
 * Float32Array [x, y, z, ...]. Made once; any moment's sky is then one matrix
 * away (horizonVectors, or horizonMatrix as a uniform on the GPU).
 */
export function starVectors(stars) {
  const out = new Float32Array((stars.length / 4) * 3);
  for (let i = 0, j = 0; i < stars.length; i += 4, j += 3) {
    out.set(raDecVector(stars[i], stars[i + 1]), j);
  }
  return out;
}

/** Vectors [x, y, z, ...] rotated by a matrix (horizonMatrix: to [east, north, up, ...]). */
export function horizonVectors(matrix, vectors, out = new Float32Array(vectors.length)) {
  const m = matrix;
  for (let i = 0; i < vectors.length; i += 3) {
    const [x, y, z] = [vectors[i], vectors[i + 1], vectors[i + 2]];
    out[i] = m[0] * x + m[1] * y + m[2] * z;
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z;
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z;
  }
  return out;
}

/** J2000 RA/Dec of a point on the ecliptic (latitude 0 by default): the path of the Sun and planets. */
export function eclipticToRaDec(longitude, latitude = 0) {
  return vectorRaDec(eclipticToEquatorial(longitude, latitude, OBLIQUITY_J2000));
}

/** J2000 RA/Dec of galactic coordinates, for the band of the Milky Way (b = 0). */
export function galacticToRaDec(l, b = 0) {
  const g = raDecVector(l, b);
  // Columns: the galactic x (centre), y and z (north pole) axes in J2000.
  return vectorRaDec([
    -0.0548755604 * g[0] + 0.4941094279 * g[1] - 0.867666149 * g[2],
    -0.8734370902 * g[0] - 0.44482963 * g[1] - 0.1980763734 * g[2],
    -0.4838350155 * g[0] + 0.7469822445 * g[1] + 0.4559837762 * g[2],
  ]);
}

function eclipticToEquatorial(longitude, latitude, obliquity) {
  const [x, y, z] = raDecVector(longitude, latitude);
  const [c, s] = [Math.cos(obliquity), Math.sin(obliquity)];
  return [x, c * y - s * z, s * y + c * z];
}

/** Mean obliquity of the ecliptic of date (IAU 1980), radians. */
function meanObliquity(t) {
  return (23.4392911 - (0.0130042 + (1.64e-7 - 5.04e-7 * t) * t) * t) * DEG;
}

// ---------------------------------------------------------------- Sun

/**
 * The Sun by the same low-precision formula as sat-geo.js's subsolarPoint
 * (Astronomical Almanac, 0.01 deg in 1950-2050), so the sky agrees with the
 * globe's day and night: RA/Dec of date, ecliptic longitude, distance in au.
 */
export function sunPosition(date) {
  const n = julianDate(date) - J2000;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = (280.46 + 0.9856474 * n + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;
  return {
    ra: wrap360(Math.atan2(Math.cos(obliquity) * Math.sin(lambda), Math.cos(lambda)) / DEG),
    dec: Math.asin(Math.sin(obliquity) * Math.sin(lambda)) / DEG,
    longitude: wrap360(lambda / DEG),
    distance: 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g),
  };
}

/** The Sun in the observer's sky: azimuth, elevation, angular radius. */
export function sunAzEl(date, observer) {
  const s = sunPosition(date);
  return {
    ...azimuthElevation(applyMatrix(horizonMatrixOfDate(date, observer), raDecVector(s.ra, s.dec))),
    radius: SUN_RADIUS_AU / s.distance / DEG,
  };
}

// ---------------------------------------------------------------- Moon

// Meeus, Astronomical Algorithms (2nd ed.), ch. 47 (the main terms of ELP-2000/82).
// Table 47.A: multiples of D, M, M', F; longitude (1e-6 deg) and distance (m) terms.
const MOON_LR = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0], [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];
// Table 47.B: multiples of D, M, M', F; latitude terms (1e-6 deg).
const MOON_B = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833], [0, 0, 1, -3, 777], [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351], [4, 0, 0, 1, 331], [2, -1, 1, 1, 315], [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283], [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185], [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177], [4, 0, -2, -1, 176], [4, -1, -1, -1, 166], [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132], [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107],
];

/**
 * The Moon from the Earth's centre (Meeus ch. 47, about 10" and 20 km):
 * ecliptic longitude and latitude, RA/Dec of the mean equator and equinox
 * of date, distance in km. Seen from the ground it is up to a degree lower
 * (parallax): use moonAzEl for the observer's sky.
 */
export function moonPosition(date) {
  const t = centuriesTT(date);
  const t2 = t * t;
  const lp = 218.3164477 + 481267.88123421 * t - 0.0015786 * t2 + (t2 * t) / 538841 - (t2 * t2) / 65194000;
  const d = 297.8501921 + 445267.1114034 * t - 0.0018819 * t2 + (t2 * t) / 545868 - (t2 * t2) / 113065000;
  const m = 357.5291092 + 35999.0502909 * t - 0.0001536 * t2 + (t2 * t) / 24490000;
  const mp = 134.9633964 + 477198.8675055 * t + 0.0087414 * t2 + (t2 * t) / 69699 - (t2 * t2) / 14712000;
  const f = 93.272095 + 483202.0175233 * t - 0.0036539 * t2 - (t2 * t) / 3526000 + (t2 * t2) / 863310000;
  const e = 1 - 0.002516 * t - 0.0000074 * t2; // the Earth's shrinking eccentricity, for terms in M
  const ecc = [1, e, e * e];
  let sl = 0;
  let sr = 0;
  let sb = 0;
  for (const [cd, cm, cmp, cf, l, r] of MOON_LR) {
    const arg = (cd * d + cm * m + cmp * mp + cf * f) * DEG;
    sl += l * ecc[Math.abs(cm)] * Math.sin(arg);
    sr += r * ecc[Math.abs(cm)] * Math.cos(arg);
  }
  for (const [cd, cm, cmp, cf, b] of MOON_B) {
    sb += b * ecc[Math.abs(cm)] * Math.sin((cd * d + cm * m + cmp * mp + cf * f) * DEG);
  }
  // Venus, Jupiter and the Earth's flattening.
  const [a1, a2, a3] = [119.75 + 131.849 * t, 53.09 + 479264.29 * t, 313.45 + 481266.484 * t].map((a) => a * DEG);
  sl += 3958 * Math.sin(a1) + 1962 * Math.sin((lp - f) * DEG) + 318 * Math.sin(a2);
  sb +=
    -2235 * Math.sin(lp * DEG) + 382 * Math.sin(a3) + 175 * Math.sin(a1 - f * DEG) +
    175 * Math.sin(a1 + f * DEG) + 127 * Math.sin((lp - mp) * DEG) - 115 * Math.sin((lp + mp) * DEG);
  const longitude = wrap360(lp + sl / 1e6);
  const latitude = sb / 1e6;
  return {
    longitude,
    latitude,
    ...vectorRaDec(eclipticToEquatorial(longitude, latitude, meanObliquity(t))),
    distance: 385000.56 + sr / 1000,
  };
}

/**
 * The Moon in the observer's sky, seen from their place on the ground (the
 * parallax moves it by up to a degree): azimuth, elevation, distance (km)
 * and angular radius.
 */
export function moonAzEl(date, observer) {
  const moon = moonPosition(date);
  const lat = observer.latitude * DEG;
  const n = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
  // The observer from the Earth's centre, in their own [east, north, up] axes.
  const here = [
    0,
    -n * WGS84_E2 * Math.sin(lat) * Math.cos(lat),
    n * (1 - WGS84_E2 * Math.sin(lat) ** 2) + (observer.elevation || 0) / 1000,
  ];
  const geocentric = raDecVector(moon.ra, moon.dec).map((x) => x * moon.distance);
  const v = sub(applyMatrix(horizonMatrixOfDate(date, observer), geocentric), here);
  const distance = norm(v);
  return { ...azimuthElevation(v), distance, radius: Math.asin(MOON_RADIUS_KM / distance) / DEG };
}

/**
 * Phase of the Moon (Meeus ch. 48): the phase angle (Sun-Moon-Earth), the
 * illuminated fraction, the elongation from the Sun, where it is in its
 * cycle (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter), whether it
 * is waxing, the position angle of the bright limb (from celestial north
 * through east) and the visual magnitude.
 */
export function moonPhase(date) {
  const moon = moonPosition(date);
  const sun = sunPosition(date);
  const elongation = Math.acos(clamp(dot(raDecVector(moon.ra, moon.dec), raDecVector(sun.ra, sun.dec)), -1, 1));
  const r = sun.distance * AU_KM;
  const i = Math.atan2(r * Math.sin(elongation), moon.distance - r * Math.cos(elongation));
  const da = (sun.ra - moon.ra) * DEG;
  const [d0, d] = [sun.dec * DEG, moon.dec * DEG];
  const limb = Math.atan2(
    Math.cos(d0) * Math.sin(da),
    Math.sin(d0) * Math.cos(d) - Math.cos(d0) * Math.sin(d) * Math.cos(da)
  );
  const cycle = wrap360(moon.longitude - sun.longitude) / 360;
  const phaseAngle = i / DEG;
  return {
    phaseAngle,
    fraction: (1 + Math.cos(i)) / 2,
    elongation: elongation / DEG,
    cycle,
    waxing: cycle < 0.5,
    positionAngle: wrap360(limb / DEG),
    magnitude: -12.73 + 0.026 * phaseAngle + 4e-9 * phaseAngle ** 4, // Allen
  };
}

/**
 * Outline of the lit part of a Moon of radius r centred on (0, 0), as SVG
 * path data (canvas takes it too, through Path2D): the bright limb, then the
 * terminator, half an ellipse r·|2k-1| wide. `litSide` is the direction of
 * the lit side on screen, degrees clockwise from up (skyDirection).
 */
export function moonLitPath(r, fraction, litSide) {
  const k = clamp(fraction, 0, 1);
  const tilt = litSide - 90; // the path is drawn lit side right, then turned
  const [s, c] = [Math.sin(tilt * DEG), Math.cos(tilt * DEG)];
  const f = (x) => +x.toFixed(2);
  const [tx, ty, bx, by] = [r * s, -r * c, -r * s, r * c].map(f);
  return (
    `M${tx} ${ty}A${f(r)} ${f(r)} 0 0 1 ${bx} ${by}` +
    `A${f(r * Math.abs(2 * k - 1))} ${f(r)} ${f(tilt)} 0 ${k > 0.5 ? 1 : 0} ${tx} ${ty}Z`
  );
}

const MOON_STATES = [
  [0.5, "new_moon"], [6.5, "waxing_crescent"], [7.5, "first_quarter"], [13.5, "waxing_gibbous"],
  [14.5, "full_moon"], [20.5, "waning_gibbous"], [21.5, "last_quarter"], [27.5, "waning_crescent"],
];

/**
 * Home Assistant's name for a phase (moonPhase().cycle), the states of its
 * moon sensor, so hass.localize can name it: the four main phases take a day
 * of a 28 day cycle each, as there.
 */
export function moonPhaseState(cycle) {
  const day = wrap360(cycle * 360) / 360 * 28;
  return (MOON_STATES.find(([end]) => day < end) || MOON_STATES[0])[1];
}

// ---------------------------------------------------------------- planets

// JPL "Keplerian Elements for Approximate Positions of the Major Planets"
// (E. M. Standish), table 1, 1800-2050 AD: a (au), e, I, L, long. of
// perihelion, long. of ascending node (deg, J2000 ecliptic), then their rates
// per century. The Earth is the Earth-Moon barycentre (under 5000 km off).
const ELEMENTS = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593,
    0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255,
    0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0,
    0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
  mars: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
    0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  jupiter: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
    -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
    -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
};
export const PLANETS = ["mercury", "venus", "mars", "jupiter", "saturn"];
/** B-V colour indices of the planets (Mallama 2017), to tint them like stars with bvToRgb. */
const PLANET_BV = { mercury: 0.93, venus: 0.82, mars: 1.36, jupiter: 0.83, saturn: 1.04 };
/** Saturn's north pole (J2000), for the tilt of its rings. */
const SATURN_POLE = [0.08547883, 0.07323576, 0.99364475];

/** Heliocentric J2000 equatorial position (au) of a planet at t (centuries TT). */
function heliocentric(name, t) {
  const el = ELEMENTS[name];
  const [a, e, inc, l, peri, node] = [0, 1, 2, 3, 4, 5].map((k) => el[k] + el[k + 6] * t);
  const m = wrap360(l - peri + 180) * DEG - Math.PI;
  let ea = m + e * Math.sin(m);
  for (let k = 0; k < 8; k++) ea -= (ea - e * Math.sin(ea) - m) / (1 - e * Math.cos(ea)); // Kepler
  const xp = a * (Math.cos(ea) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(ea);
  const [w, o, i] = [(peri - node) * DEG, node * DEG, inc * DEG];
  const [cw, sw, co, so, ci, si] = [Math.cos(w), Math.sin(w), Math.cos(o), Math.sin(o), Math.cos(i), Math.sin(i)];
  const x = (cw * co - sw * so * ci) * xp + (-sw * co - cw * so * ci) * yp;
  const y = (cw * so + sw * co * ci) * xp + (-sw * so + cw * co * ci) * yp;
  const z = sw * si * xp + cw * si * yp;
  const [c, s] = [Math.cos(OBLIQUITY_J2000), Math.sin(OBLIQUITY_J2000)];
  return [x, c * y - s * z, s * y + c * z];
}

/**
 * Visual magnitude (Mallama & Hilton 2018, as in Skyfield) from the distances
 * to the Sun and the Earth (au) and the phase angle i (deg). From the Earth
 * the phase angle of Mars stays under 50 deg and Jupiter's under 12, the
 * range of their formulae; ringTilt is Saturn's.
 */
function planetMagnitude(name, r, delta, i, ringTilt = 0) {
  const distance = 5 * Math.log10(r * delta);
  switch (name) {
    case "mercury":
      return -0.613 + distance + i * (6.328e-2 + i * (-1.6336e-3 + i * (3.3644e-5 + i * (-3.4265e-7 + i * (1.6893e-9 - 3.0334e-12 * i)))));
    case "venus":
      return i < 163.7
        ? -4.384 + distance + i * (-1.044e-3 + i * (3.687e-4 + i * (-2.814e-6 + 8.938e-9 * i)))
        : 236.05828 + distance + i * (-2.81914 + 8.39034e-3 * i);
    case "mars":
      return -1.601 + distance + i * (2.267e-2 - 1.302e-4 * i);
    case "jupiter":
      return -9.395 + distance + i * (-3.7e-4 + 6.16e-4 * i);
    default: {
      const s = Math.sin(ringTilt * DEG);
      return -8.914 + distance - 1.825 * s + 0.026 * i - 0.378 * s * Math.exp(-2.25 * i);
    }
  }
}

/**
 * The bright planets from the Earth's centre (parallax is under 0.01 deg),
 * corrected for light time: J2000 RA/Dec, distance (au), phase angle,
 * illuminated fraction, visual magnitude and B-V colour.
 */
export function planetPositions(date) {
  const t = centuriesTT(date);
  const earth = heliocentric("earth", t);
  return PLANETS.map((name) => {
    let helio = heliocentric(name, t);
    helio = heliocentric(name, t - (norm(sub(helio, earth)) * LIGHT_DAYS_PER_AU) / 36525);
    const geo = sub(helio, earth);
    const r = norm(helio);
    const distance = norm(geo);
    const phaseAngle = Math.acos(clamp(dot(helio, geo) / (r * distance), -1, 1)) / DEG;
    let ringTilt = 0;
    if (name === "saturn") {
      // Saturnicentric latitudes of the Sun and the Earth; their geometric mean if on one side.
      const sun = 90 - Math.acos(clamp(dot(SATURN_POLE, helio) / r, -1, 1)) / DEG;
      const here = 90 - Math.acos(clamp(dot(SATURN_POLE, geo) / distance, -1, 1)) / DEG;
      ringTilt = sun * here > 0 ? Math.sqrt(sun * here) : 0;
    }
    return {
      name,
      ...vectorRaDec(geo),
      distance,
      phaseAngle,
      fraction: (1 + Math.cos(phaseAngle * DEG)) / 2,
      magnitude: planetMagnitude(name, r, distance, phaseAngle, ringTilt),
      bv: PLANET_BV[name],
    };
  });
}

// ---------------------------------------------------------------- the observer's sky

/**
 * Atmospheric refraction, degrees to add to a geometric elevation
 * (Saemundsson 1986), for pressure in hPa and temperature in deg C. It holds
 * its -1 deg value below that, where the ground hides the sky anyway.
 */
export function refraction(elevation, pressure = 1010, temperature = 10) {
  const h = Math.max(elevation, -1);
  const arcmin = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * DEG);
  return Math.max(0, arcmin / 60) * (pressure / 1010) * (283 / (273 + temperature));
}

/**
 * Air mass towards an elevation: 1 at the zenith, about 5.6 at 10 deg and
 * 38 on the horizon (Kasten & Young 1989). Held at its horizon value below.
 */
export function airmass(elevation) {
  const h = Math.max(elevation, 0);
  return 1 / (Math.sin(h * DEG) + 0.50572 * (h + 6.07995) ** -1.6364);
}

/**
 * How much fainter the air makes a star or satellite at an elevation, in
 * magnitudes: k per air mass beyond the zenith's (0.25 suits a clear,
 * slightly hazy sky at sea level; 0.2 a mountain top).
 */
export function extinction(elevation, k = 0.25) {
  // Kasten & Young's air mass is 0.9997 at the zenith: never brighter than outside the air.
  return Math.max(0, k * (airmass(elevation) - 1));
}

/**
 * Direction from one point of the sky to another in a picture of the sky
 * with the zenith up and azimuth growing to the right (an eye-level view):
 * degrees clockwise from up. The Moon's lit side faces skyDirection(moon, sun).
 */
export function skyDirection(from, to) {
  const a = from.azimuth * DEG;
  const e = from.elevation * DEG;
  const v = azElVector(to.azimuth, to.elevation);
  const right = [Math.cos(a), -Math.sin(a), 0];
  const up = [-Math.sin(a) * Math.sin(e), -Math.cos(a) * Math.sin(e), Math.cos(e)];
  return wrap360(Math.atan2(dot(v, right), dot(v, up)) / DEG);
}

/**
 * The point `degrees` along the great circle from one point of the sky towards
 * another. Project both through any camera to orient something on screen,
 * like the Moon's lit side in the sky chart.
 */
export function towards(from, to, degrees) {
  const a = azElVector(from.azimuth, from.elevation);
  const b = azElVector(to.azimuth, to.elevation);
  const c = dot(a, b);
  const tangent = sub(b, a.map((x) => x * c));
  const length = norm(tangent) || 1;
  const d = degrees * DEG;
  return azimuthElevation(a.map((x, i) => x * Math.cos(d) + (tangent[i] / length) * Math.sin(d)));
}

/**
 * Everything in the observer's sky at a moment: the J2000 -> [east, north,
 * up] matrix for the stars, the Sun, the Moon with its phase and the angle of
 * its lit side (skyDirection), the planets, the twilight and the sky palette.
 */
export function skyAt(date, observer) {
  const matrix = horizonMatrix(date, observer);
  const sun = sunAzEl(date, observer);
  const moon = { ...moonAzEl(date, observer), ...moonPhase(date) };
  moon.litSide = skyDirection(moon, sun);
  const planets = planetPositions(date).map((p) => ({ ...p, ...toHorizon(matrix, p.ra, p.dec) }));
  return {
    matrix,
    sun,
    moon,
    planets,
    twilight: twilight(sun.elevation),
    palette: skyPalette(sun.elevation, moon),
  };
}

// ---------------------------------------------------------------- sky colours

/** The part of the day by the Sun's elevation: day, civil, nautical, astronomical (twilight) or night. */
export function twilight(sunElevation) {
  if (sunElevation >= -0.833) return "day"; // upper limb on the horizon
  if (sunElevation >= -6) return "civil";
  if (sunElevation >= -12) return "nautical";
  if (sunElevation >= -18) return "astronomical";
  return "night";
}

// By the Sun's elevation: the zenith, the horizon away from the Sun, the
// horizon under the Sun (sRGB), the height of that glow (deg), and the
// faintest star the eye picks up. No channel of the zenith darkens as the Sun
// climbs (so the rounded colours cannot either): a high Sun gives a deeper,
// brighter blue.
const SKY = [
  [-90, [2, 4, 10], [8, 12, 24], [8, 12, 24], 6, 6.0],
  [-18, [2, 4, 10], [8, 12, 24], [10, 14, 28], 8, 6.0],
  [-15, [4, 8, 20], [12, 19, 38], [24, 28, 54], 8, 5.2],
  [-12, [7, 14, 34], [20, 32, 62], [52, 50, 86], 9, 4.3],
  [-9, [11, 23, 56], [36, 54, 98], [112, 86, 112], 10, 3.2],
  [-6, [19, 39, 86], [66, 88, 140], [200, 122, 96], 11, 1.8],
  [-3, [30, 60, 120], [112, 132, 178], [242, 152, 92], 12, 0.2],
  [0, [44, 86, 160], [160, 178, 206], [255, 184, 112], 14, -1.5],
  [6, [52, 110, 196], [188, 208, 232], [255, 222, 172], 18, -3.0],
  [20, [52, 114, 212], [176, 206, 240], [228, 238, 250], 30, -4.0],
  [90, [52, 118, 226], [170, 202, 240], [220, 232, 250], 40, -4.0],
];
const MOONLIT = { zenith: [22, 36, 70], horizon: [44, 60, 98] };

/**
 * Colours of the sky for a Sun elevation: zenith, horizon away from the Sun
 * and horizon under it (sRGB 0-255), the height of that glow (deg), the
 * limiting magnitude for the stars and the twilight. With the Moon
 * ({elevation, fraction}) it lightens the night and drowns faint stars.
 */
export function skyPalette(sunElevation, moon = null) {
  const h = clamp(sunElevation, -90, 90);
  let k = 1;
  while (SKY[k][0] < h) k++;
  const [lo, hi] = [SKY[k - 1], SKY[k]];
  const f = (h - lo[0]) / (hi[0] - lo[0]);
  let zenith = mix(lo[1], hi[1], f);
  let horizon = mix(lo[2], hi[2], f);
  let limit = lo[5] + (hi[5] - lo[5]) * f;
  if (moon && moon.elevation > 0) {
    // Moonlight only shows once the twilight has faded.
    const light = moon.fraction ** 1.5 * Math.sin(Math.min(moon.elevation, 60) * DEG) / Math.sin(60 * DEG);
    const night = clamp((-sunElevation - 4) / 8, 0, 1);
    zenith = mix(zenith, MOONLIT.zenith, 0.6 * light * night);
    horizon = mix(horizon, MOONLIT.horizon, 0.6 * light * night);
    limit -= 2 * light * night;
  }
  const round = (c) => c.map(Math.round);
  return {
    zenith: round(zenith),
    horizon: round(horizon),
    glow: round(mix(lo[3], hi[3], f)),
    glowHeight: lo[4] + (hi[4] - lo[4]) * f,
    limit,
    twilight: twilight(sunElevation),
  };
}

/**
 * Colour of the sky (sRGB 0-255) at an azimuth and elevation, for a Sun at
 * {azimuth, elevation}: the horizon colour fading up to the zenith's, with
 * the glow of the Sun low down on its side, and a whiter aureole round it
 * by day. Below the horizon it is the horizon's colour.
 */
export function skyColor(azimuth, elevation, sun, palette = skyPalette(sun.elevation)) {
  const e = Math.max(0, elevation);
  let c = mix(palette.horizon, palette.zenith, (e / 90) ** 0.45);
  const side = ((1 + Math.cos((azimuth - sun.azimuth) * DEG)) / 2) ** 3;
  c = mix(c, palette.glow, side * Math.exp(-e / palette.glowHeight));
  if (sun.elevation > -2) {
    const away = Math.acos(clamp(dot(azElVector(azimuth, e), azElVector(sun.azimuth, sun.elevation)), -1, 1)) / DEG;
    const day = clamp((sun.elevation + 2) / 8, 0, 1);
    c = mix(c, [255, 250, 240], 0.7 * day * Math.exp(-away / 6));
  }
  return c.map((x) => Math.round(clamp(x, 0, 255)));
}

/**
 * Stops of a vertical sky gradient looking towards an azimuth, horizon to
 * zenith: [{elevation, color: [r, g, b]}]. Map elevation to the screen with
 * the camera (CSS, canvas, SVG); for a sky dome use skyColor per vertex.
 */
export function skyGradient(azimuth, sun, elevations = [0, 2, 5, 10, 18, 30, 50, 90]) {
  const palette = skyPalette(sun.elevation);
  return elevations.map((elevation) => ({ elevation, color: skyColor(azimuth, elevation, sun, palette) }));
}

/** CSS colour of [r, g, b], with an optional alpha. */
export function cssColor([r, g, b], alpha = 1) {
  return alpha < 1 ? `rgb(${r} ${g} ${b} / ${+alpha.toFixed(3)})` : `rgb(${r} ${g} ${b})`;
}

// ---------------------------------------------------------------- stars

/** Effective temperature (K) of a star from its B-V colour index (Ballesteros 2012). */
export function bvToTemperature(bv) {
  const b = clamp(bv, -0.4, 2.0);
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

/**
 * Colour (sRGB 0-255) of a star from its B-V: the blackbody colour of its
 * temperature (Tanner Helland's fit, white at 6600 K). `saturation` 0 gives
 * white; the eye sees star colours faintly, so 0.5-0.7 looks natural.
 */
export function bvToRgb(bv, saturation = 1) {
  const t = bvToTemperature(bv) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((c) => Math.round(255 - saturation * (255 - clamp(c, 0, 255))));
}

/**
 * Radius (px) of a star's dot: `scale` at the limiting magnitude, growing
 * with the fourth root of the flux (x5.6 for Sirius under a dark sky), at
 * most `max`.
 */
export function starRadius(mag, limit = 6, scale = 0.6, max = 5) {
  return Math.min(max, scale * 10 ** (0.1 * (limit - mag)));
}

/** Opacity of a star's dot: 0 half a magnitude past the limit, 1 from 1.5 magnitudes above it. */
export function starAlpha(mag, limit = 6) {
  return clamp((limit + 0.5 - mag) / 2, 0, 1);
}
