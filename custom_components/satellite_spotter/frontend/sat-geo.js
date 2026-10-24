/**
 * Geometry helpers for the Satellite Spotter globe. Pure functions with no
 * DOM or WebGL, unit tested with `node --test "tests/js/*.test.mjs"`.
 * (Times, numbers and units are sat-format.js's.)
 *
 * Track rows, as sent by the integration: [unix seconds, latitude, longitude,
 * altitude km, sunlit 0/1, ...]. pass_track rows carry more columns after
 * these five; nothing here reads them.
 */

const DEG = Math.PI / 180;
const WGS84_A_KM = 6378.137;
const WGS84_E2 = 0.00669437999014;
const EARTH_MU = 398600.4418; // km^3/s^2
// The ISS's orbital period: what previewTimeline() paces itself by when not told.
const ISS_PERIOD_S = 92.9 * 60;
export const MERCATOR_MAX_LAT = 85.051129;

export function wrapLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Web Mercator coordinates in 0..1 (MapLibre's "mercator units"). Latitudes
 * are clamped to the flat map's limit unless `limit` says otherwise: the
 * globe's layers pass one just short of the pole, so that a polar orbit goes
 * over the top (sat-space.js toMercator()).
 */
export function mercator(lat, lon, limit = MERCATOR_MAX_LAT) {
  const clamped = Math.max(-limit, Math.min(limit, lat));
  return [
    ((((lon + 180) % 360) + 360) % 360) / 360,
    0.5 - Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2)) / (2 * Math.PI),
  ];
}

/**
 * Greenwich mean sidereal time in radians (IAU 1982, as pysatellitespotter's
 * `_gmst`) for a Julian date in UT1 (UTC is near enough).
 */
export function gmst(jd) {
  const t = (jd - 2451545.0) / 36525.0;
  const seconds =
    -6.2e-6 * t ** 3 + 0.093104 * t ** 2 + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841;
  return (((seconds * DEG) / 240.0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
}

/** Point on Earth with the Sun overhead (same low-precision formula as the Python engine). */
export function subsolarPoint(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const meanLongitude = 280.46 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = (meanLongitude + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(lambda));
  return { lat: dec / DEG, lon: wrapLongitude((ra - gmst(jd)) / DEG) };
}

/** Unit vector towards the Sun in an Earth-fixed frame: x at (0, 0), y at (0, 90E), z north. */
export function sunVector(date) {
  const s = subsolarPoint(date);
  const lat = s.lat * DEG;
  const lon = s.lon * DEG;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

/** Elevation of the Sun, in degrees, seen from a point on Earth. */
export function sunElevation(lat, lon, sun) {
  const s =
    Math.sin(lat * DEG) * Math.sin(sun.lat * DEG) +
    Math.cos(lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos((lon - sun.lon) * DEG);
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}

/** Position on a track at time t (unix seconds), interpolated; null outside the track. */
export function positionAt(track, t) {
  if (!track || track.length < 2 || t < track[0][0] || t > track[track.length - 1][0]) {
    return null;
  }
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  return {
    t,
    lat: a[1] + f * (b[1] - a[1]),
    lon: wrapLongitude(a[2] + f * wrapLongitude(b[2] - a[2])),
    alt: a[3] + f * (b[3] - a[3]),
    sunlit: (f < 0.5 ? a[4] : b[4]) === 1,
  };
}

/** Initial great-circle bearing from one point to another, in degrees. */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Ground distance in km (spherical Earth). */
export function groundDistanceKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const h =
    Math.sin((p2 - p1) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * 6371.0 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ring of [lon, lat] points at a fixed angular distance (degrees) around a centre. */
export function circleRing(lat, lon, radiusDeg, points = 96) {
  const p1 = lat * DEG;
  const d = radiusDeg * DEG;
  const ring = [];
  for (let i = 0; i <= points; i++) {
    const b = (2 * Math.PI * i) / points;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 =
      lon * DEG +
      Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    // Keep longitudes continuous around the centre so the ring never jumps.
    let lng = l2 / DEG;
    while (lng - lon > 180) lng -= 360;
    while (lng - lon < -180) lng += 360;
    // True latitudes, even past the flat map's limit: on the globe a ring
    // around a pole goes over the top.
    ring.push([lng, p2 / DEG]);
  }
  return ring;
}

/**
 * Angular radius (degrees) of the ground circle from which a satellite at
 * altitudeKm is at least minElevation degrees above the horizon.
 */
export function visibilityRadius(altitudeKm, minElevation) {
  const e = minElevation * DEG;
  return (Math.acos((WGS84_A_KM * Math.cos(e)) / (WGS84_A_KM + altitudeKm)) - e) / DEG;
}

function ecef(latDeg, lonDeg, hKm) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const n = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
  return [
    (n + hKm) * Math.cos(lat) * Math.cos(lon),
    (n + hKm) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - WGS84_E2) + hKm) * Math.sin(lat),
  ];
}

/** Azimuth, elevation (degrees) and range (km) of a satellite {lat, lon, alt km} from an observer. */
export function lookAngles(observer, satellite) {
  const o = ecef(observer.latitude, observer.longitude, (observer.elevation || 0) / 1000);
  const s = ecef(satellite.lat, satellite.lon, satellite.alt);
  const r = [s[0] - o[0], s[1] - o[1], s[2] - o[2]];
  const lat = observer.latitude * DEG;
  const lon = observer.longitude * DEG;
  const east = -Math.sin(lon) * r[0] + Math.cos(lon) * r[1];
  const north =
    -Math.sin(lat) * Math.cos(lon) * r[0] - Math.sin(lat) * Math.sin(lon) * r[1] + Math.cos(lat) * r[2];
  const up =
    Math.cos(lat) * Math.cos(lon) * r[0] + Math.cos(lat) * Math.sin(lon) * r[1] + Math.sin(lat) * r[2];
  const range = Math.hypot(r[0], r[1], r[2]);
  return {
    azimuth: (Math.atan2(east, north) / DEG + 360) % 360,
    elevation: Math.asin(up / range) / DEG,
    range,
  };
}

/** Where a track appears in the observer's sky: [{t, azimuth, elevation, range, sunlit}]. */
export function skyTrack(observer, rows) {
  return (rows || []).map((r) => ({
    t: r[0],
    ...lookAngles(observer, { lat: r[1], lon: r[2], alt: r[3] }),
    sunlit: r[4] === 1,
  }));
}

/** Index of the row where the satellite is highest in the observer's sky. */
export function closestApproach(observer, rows) {
  let best = -1;
  let bestEl = -Infinity;
  (rows || []).forEach((r, i) => {
    const el = lookAngles(observer, { lat: r[1], lon: r[2], alt: r[3] }).elevation;
    if (el > bestEl) {
      bestEl = el;
      best = i;
    }
  });
  return best;
}

/** Orbital period in seconds from the mean motion in revolutions per day (the elements' MEAN_MOTION). */
export function periodFromMeanMotion(revPerDay) {
  return revPerDay > 0 ? 86400 / revPerDay : NaN;
}

/** Semi-major axis in km of an orbit with this period (Kepler's third law). */
export function semiMajorAxisKm(periodS) {
  return periodS > 0 ? Math.cbrt(EARTH_MU * (periodS / (2 * Math.PI)) ** 2) : NaN;
}

/**
 * Orbital speed in km/s at an altitude, from the vis-viva equation. Give the
 * orbit's semi-major axis (semiMajorAxisKm(period_s)) for an elliptical
 * orbit, such as a rocket body's on its way to a high orbit: without it the
 * orbit is taken to be circular, which is right for the ISS but not there.
 */
export function orbitalSpeed(altitudeKm, axisKm = WGS84_A_KM + altitudeKm) {
  const r = WGS84_A_KM + altitudeKm;
  return Math.sqrt(EARTH_MU * Math.max(0, 2 / r - 1 / axisKm));
}

/**
 * The altitude to draw a satellite at, in km: the true one up to 2,000 km
 * (every low orbit, where nearly all naked-eye passes happen), then growing only
 * logarithmically, so that a geostationary orbit (35,786 km) is drawn at about
 * 6,700 km and the highest apogees in the catalogue stay in front of the
 * camera. Geometry and physics keep using the true altitude.
 */
export function displayAltitudeKm(km, knee = 2000, scale = 1500) {
  return km <= knee ? km : knee + scale * Math.log1p((km - knee) / scale);
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];
export function compass(azimuth) {
  return COMPASS[Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16];
}

/** Escape text for use in HTML. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Satellites with a look of their own, by NORAD id.
const KIND_BY_ID = { 25544: "iss", 48274: "tiangong", 20580: "hubble" };

/**
 * What a satellite is, for its sprite and icon: iss, tiangong, hubble,
 * starlink, rocket, debris or satellite. The same rules as the integration's
 * satellite_kind(), so a satellite looks the same everywhere: the stations by
 * NORAD id (the catalogue's names are the website's), then by name, ignoring
 * case (Starlink names come in mixed case).
 */
export function satelliteKind({ norad_id: id, name } = {}) {
  const known = KIND_BY_ID[Number(id)];
  if (known) return known;
  const upper = String(name ?? "").toUpperCase();
  if (upper.includes("STARLINK")) return "starlink";
  if (upper.includes("R/B") || upper.includes("PKM") || upper.includes("AKM")) return "rocket";
  if (upper.includes("DEB")) return "debris";
  return "satellite";
}

// Unit vectors, altitudes and sunlight of a positions payload, made once per payload.
const positionBases = new WeakMap();

function positionsBasis(payload) {
  let basis = positionBases.get(payload);
  if (basis) return basis;
  const n = payload.ids.length;
  const count = payload.count;
  const units = new Float64Array(n * count * 3);
  const alts = new Float64Array(n * count);
  const lit = new Uint8Array(n * count);
  for (let k = 0; k < n; k++) {
    const row = payload.pos[k] || [];
    const flags = payload.lit?.[k] || "";
    for (let i = 0; i < count; i++) {
      const j = k * count + i;
      const lat = row[i * 3];
      const lon = row[i * 3 + 1];
      const alt = row[i * 3 + 2];
      if (lat == null || lon == null || alt == null) {
        // No position (SGP4 could not propagate it): hidden.
        units[j * 3] = units[j * 3 + 1] = units[j * 3 + 2] = alts[j] = NaN;
        continue;
      }
      const c = Math.cos(lat * DEG);
      units[j * 3] = c * Math.cos(lon * DEG);
      units[j * 3 + 1] = c * Math.sin(lon * DEG);
      units[j * 3 + 2] = Math.sin(lat * DEG);
      alts[j] = alt;
      lit[j] = flags[i] === "1" ? 1 : 0;
    }
  }
  basis = { n, count, units, alts, lit };
  positionBases.set(payload, basis);
  return basis;
}

/**
 * Where every satellite of a `satellite_spotter/positions` payload is at tS
 * (unix seconds): a Float32Array of [lat, lon, altitude km, lit] per
 * satellite, in the order of `payload.ids`. Between two samples the position
 * moves along the great circle through them (an Earth-fixed unit-vector slerp,
 * which needs no special case at the antimeridian or over a pole) and the
 * altitude linearly; `lit` goes from 0 to 1 over the minute in which a
 * satellite leaves Earth's shadow. Times outside the samples are held at the
 * first or last one. A satellite without a position gets NaN. Pass `out` to
 * reuse an array every frame.
 */
export function interpolatePositions(payload, tS, out) {
  const n = payload?.ids?.length ?? 0;
  const res = out && out.length >= n * 4 ? out : new Float32Array(n * 4);
  const count = payload?.count ?? 0;
  if (!n || !(count > 0) || !(payload.step > 0)) {
    for (let o = 0; o < n * 4; o += 4) {
      res[o] = res[o + 1] = res[o + 2] = NaN;
      res[o + 3] = 0;
    }
    return res;
  }
  const { units, alts, lit } = positionsBasis(payload);
  const s = Math.max(0, Math.min(count - 1, (tS - payload.start) / payload.step || 0));
  const i = Math.min(Math.floor(s), Math.max(0, count - 2));
  const f = count > 1 ? s - i : 0;
  const next = count > 1 ? 1 : 0;
  for (let k = 0; k < n; k++) {
    const a = k * count + i;
    const b = a + next;
    const o = k * 4;
    const ax = units[a * 3];
    const bx = units[b * 3];
    if (Number.isNaN(ax) || Number.isNaN(bx)) {
      res[o] = res[o + 1] = res[o + 2] = NaN;
      res[o + 3] = 0;
      continue;
    }
    const ay = units[a * 3 + 1];
    const az = units[a * 3 + 2];
    const by = units[b * 3 + 1];
    const bz = units[b * 3 + 2];
    // The angle between the samples from atan2, which stays accurate for the
    // small angles a minute apart gives (acos of a dot product does not).
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const sinT = Math.hypot(cx, cy, cz);
    let wa = 1 - f;
    let wb = f;
    if (sinT > 1e-12) {
      const theta = Math.atan2(sinT, ax * bx + ay * by + az * bz);
      wa = Math.sin((1 - f) * theta) / sinT;
      wb = Math.sin(f * theta) / sinT;
    }
    const x = wa * ax + wb * bx;
    const y = wa * ay + wb * by;
    const z = wa * az + wb * bz;
    res[o] = Math.atan2(z, Math.hypot(x, y)) / DEG;
    res[o + 1] = Math.atan2(y, x) / DEG;
    res[o + 2] = alts[a] + f * (alts[b] - alts[a]);
    res[o + 3] = lit[a] + f * (lit[b] - lit[a]);
  }
  return res;
}

/**
 * Timeline of the fast-forward preview: sweep quickly to a few minutes before
 * the pass, play the pass itself slowly, then hold. With `skipApproach` (for
 * reduced motion) it starts at the lead-in instead of sweeping there.
 * `periodS` is the satellite's orbital period: the sweep takes about 1.5 s
 * per orbit (the ISS's when not given).
 *
 * Returns { at(realMs) -> {sim, phase, done}, durationMs }.
 */
export function previewTimeline(simStartS, passStartS, passEndS, options = {}) {
  const lead = options.leadS ?? 240;
  const slowRate = options.slowRate ?? 30; // simulated seconds per real second during the pass
  const holdMs = options.holdMs ?? 2500;
  const periodS = options.periodS > 0 ? options.periodS : ISS_PERIOD_S;
  const startS = options.skipApproach ? Math.max(simStartS, passStartS - lead) : simStartS;
  const approachS = Math.max(0, passStartS - lead - startS);
  // About 1.5 s per orbit, between 3 and 9 seconds in all.
  const fastMs = approachS > 0 ? Math.min(9000, Math.max(3000, (approachS / periodS) * 1500)) : 0;
  const slowStartS = startS + approachS;
  const slowMs = ((passEndS + 60 - slowStartS) / slowRate) * 1000;
  const durationMs = fastMs + slowMs + holdMs;
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  return {
    durationMs,
    at(realMs) {
      if (realMs < fastMs) {
        return { sim: startS + approachS * ease(realMs / fastMs), phase: "approach", done: false };
      }
      if (realMs < fastMs + slowMs) {
        return { sim: slowStartS + ((realMs - fastMs) / 1000) * slowRate, phase: "pass", done: false };
      }
      return { sim: passEndS + 60, phase: "hold", done: realMs >= durationMs };
    },
  };
}

/**
 * How long to wait before the next redraw, in ms; 0 means every display frame.
 *
 * `pxPerSecond` is how fast the satellite moves on screen (0 when it is off
 * screen). Aim for half a pixel per redraw, at least once a second. MapLibre
 * keeps redrawing for its 300 ms label fade after every camera move, so
 * anything between about 3 and 60 updates a second costs as much as redrawing
 * every frame: either wait at least 350 ms (steps of under 2 px up to 5 px/s),
 * or, once the motion is faster than that, redraw every frame.
 */
export function frameDelay(pxPerSecond, { chase = false, preview = false } = {}) {
  if (preview) return 0;
  // The near ground in the tilted chase view moves faster than the satellite.
  const speed = pxPerSecond * (chase ? 2.5 : 1);
  if (speed > 5) return 0;
  const ms = speed > 0 ? 500 / speed : Infinity;
  return Math.min(Math.max(ms, 350), 1000);
}
