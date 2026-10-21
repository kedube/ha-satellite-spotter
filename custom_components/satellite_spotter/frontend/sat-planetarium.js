/**
 * The planetarium sky of the street view, drawn in 2D: one canvas behind the
 * map (the twilight sky, stars, constellations, the Moon and planets, and the
 * satellite's path and moving dot, all hidden by the buildings and hills the
 * map draws over them) and one in front (compass, elevation scale, time ticks,
 * markers, labels, the x-ray of hidden stretches and the off-screen arrow).
 * The no-WebGL fallback draws the same sky over a terrain skyline instead.
 *
 * Directions become pixels through makeProjector(), which reproduces
 * MapLibre's mercator camera from its public getters (bearing, pitch, roll,
 * vertical field of view, canvas size) to the pixel. The pure helpers are
 * unit tested in node: node --test "tests/js/*.test.mjs".
 */

const VERSION = new URL(import.meta.url).search;
const [astro, sky] = await Promise.all([
  import(`./sat-astro.js${VERSION}`),
  import(`./sat-stars.js${VERSION}`),
]);
const {
  azElVector, bvToRgb, extinction, galacticToRaDec, horizonMatrix, horizonVectors, moonAzEl, moonLitPath, moonPhase,
  planetPositions, raDecVector, skyDirection, skyPalette, starAlpha, starRadius, starVectors, sunAzEl, toHorizon, towards,
} = astro;
const { CONSTELLATIONS, STAR_NAMES, STARS } = sky;

export const DEG = Math.PI / 180;

/**
 * How light-polluted the observer's sky is: the faintest star at the zenith
 * on a moonless night (Bortle 3, 5 and 7-8) and the strength of the glow of
 * the town over the horizon.
 */
export const LIGHT_POLLUTION = {
  rural: { limit: 6.0, dome: 0.18 },
  suburban: { limit: 5.0, dome: 0.55 },
  city: { limit: 4.0, dome: 1 },
};

/**
 * The Milky Way as soft layers along the galactic equator: each a strip from
 * galactic latitude −w to +w over a range of galactic longitude (the wider,
 * fainter ones all round the sky, the narrow bright ones towards the centre
 * of the Galaxy in Sagittarius), as J2000 unit vectors every 3°.
 */
export const MILKY_WAY = [
  { w: 20, from: 0, to: 360, alpha: 0.016 },
  { w: 14, from: 0, to: 360, alpha: 0.018 },
  { w: 9, from: 0, to: 360, alpha: 0.02 },
  { w: 6, from: 0, to: 360, alpha: 0.014 },
  { w: 12, from: -90, to: 90, alpha: 0.016 },
  { w: 8, from: -70, to: 75, alpha: 0.02 },
  { w: 5, from: -50, to: 60, alpha: 0.024 },
  { w: 3, from: -30, to: 40, alpha: 0.02 },
].map((layer) => {
  const step = 3;
  const n = Math.round((layer.to - layer.from) / step) + 1;
  const upper = new Float32Array(n * 3);
  const lower = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const l = layer.from + k * step;
    const top = galacticToRaDec(l, layer.w);
    const bottom = galacticToRaDec(l, -layer.w);
    upper.set(raDecVector(top.ra, top.dec), k * 3);
    lower.set(raDecVector(bottom.ra, bottom.dec), k * 3);
  }
  return { ...layer, n, upper, lower };
});

/** Seconds between time ticks on the path. */
export const TICK_S = 30;
/** Labelled ticks at least this far apart (CSS px). */
export const LABEL_SPACING_PX = 70;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const wrap360 = (x) => ((x % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// Camera

/**
 * Where a direction lands on screen for MapLibre's mercator camera, and back.
 * Mirrors MercatorTransform._calcMatrices: P · S(1,−1,1) · T(0,0,−d) ·
 * Rz(−roll) · Rx(pitch) · Rz(−bearing), with the focal length height / 2 /
 * tan(fov / 2) (MapLibre's cameraToCenterDistance). Pitch 90 looks at the
 * horizon, 180 straight up. The world is x east, y SOUTH, z up (MapLibre's).
 * @returns {{project(az: number, el: number): number[] | null, projectVector(dx: number, dy: number, dz: number): number[] | null,
 *   toCamera(dx: number, dy: number, dz: number): number[], unproject(px: number, py: number): {azimuth: number, elevation: number},
 *   f: number, cx: number, cy: number, width: number, height: number, bearing: number, pitch: number, roll: number, fov: number, key: string}}
 */
export function makeProjector({ bearing, pitch, roll = 0, fov, width, height }) {
  const b = bearing * DEG;
  const p = pitch * DEG;
  const r = roll * DEG;
  const [cb, sb, cp, sp, cr, sr] = [Math.cos(b), Math.sin(b), Math.cos(p), Math.sin(p), Math.cos(r), Math.sin(r)];
  const f = height / 2 / Math.tan((fov * DEG) / 2);
  const cx = width / 2;
  const cy = height / 2;
  /** World vector -> camera space: x right, y down, z backwards (in front is z < 0). */
  const toCamera = (dx, dy, dz) => {
    const x1 = dx * cb + dy * sb;
    const y1 = -dx * sb + dy * cb;
    const y2 = y1 * cp - dz * sp;
    const z2 = y1 * sp + dz * cp;
    return [x1 * cr + y2 * sr, -x1 * sr + y2 * cr, z2];
  };
  const projectVector = (dx, dy, dz) => {
    const [x3, y3, z3] = toCamera(dx, dy, dz);
    if (z3 >= -1e-9) return null;
    return [cx + (f * x3) / -z3, cy + (f * y3) / -z3];
  };
  const project = (az, el) => {
    const ce = Math.cos(el * DEG);
    return projectVector(Math.sin(az * DEG) * ce, -Math.cos(az * DEG) * ce, Math.sin(el * DEG));
  };
  const unproject = (px, py) => {
    const x3 = (px - cx) / f;
    const y3 = (py - cy) / f;
    const x2 = x3 * cr - y3 * sr;
    const y2 = x3 * sr + y3 * cr;
    const y1 = y2 * cp - sp;
    const z1 = -y2 * sp - cp;
    const dx = x2 * cb - y1 * sb;
    const dy = x2 * sb + y1 * cb;
    return { azimuth: wrap360(Math.atan2(dx, -dy) / DEG), elevation: Math.atan2(z1, Math.hypot(dx, dy)) / DEG };
  };
  const key = [bearing, pitch, roll, fov, width, height].map((v) => +v.toFixed(4)).join("|");
  return { project, projectVector, toCamera, unproject, f, cx, cy, width, height, bearing, pitch, roll, fov, key };
}

/** A projector for a horizon-frame [east, north, up] vector (sat-astro's frame). */
const projectEnu = (P, e, n, u) => P.projectVector(e, -n, u);

/**
 * The view that shows a pass best: as much of its visible arc as possible
 * inside the part of the screen the HUD leaves free (`safe`: fractions of the
 * width and height kept clear at each edge), with the horizon in view if it
 * can be, at the narrowest field of view that does it (so the path is big),
 * turned towards the arc's highest point when the choice is free. A coarse
 * search over field of view, tilt and heading, then a finer one around the
 * best.
 * @param {{azimuth: number, elevation: number}[]} arc the visible part (or the whole path above the horizon)
 * @param {{aspect?: number, safe?: {top?: number, right?: number, bottom?: number, left?: number}, minFov?: number, maxFov?: number}} [options]
 * @returns {{bearing: number, pitch: number, fov: number}}
 */
export function frameView(arc, { aspect = 16 / 9, safe = {}, minFov = 50, maxFov = 90 } = {}) {
  let points = arc.filter((s) => Number.isFinite(s?.azimuth) && Number.isFinite(s?.elevation));
  if (!points.length) return { bearing: 180, pitch: 100, fov: 60 };
  if (points.length > 48) points = points.filter((_, i) => i % Math.ceil(points.length / 48) === 0 || i === points.length - 1);
  const peak = points.reduce((a, b) => (b.elevation > a.elevation ? b : a));
  const height = 1000;
  const width = height * aspect;
  const { top = 0.16, right = 0.04, bottom = 0.14, left = 0.04 } = safe;
  const box = { x0: width * left, x1: width * (1 - right), y0: height * top, y1: height * (1 - bottom) };
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const diag = Math.hypot(box.x1 - box.x0, box.y1 - box.y0);
  const score = (bearing, pitch, fov) => {
    const P = makeProjector({ bearing, pitch, fov, width, height });
    let inside = 0;
    let sx = 0;
    let sy = 0;
    for (const s of points) {
      const q = P.project(s.azimuth, s.elevation);
      if (!q) continue;
      if (q[0] >= box.x0 && q[0] <= box.x1 && q[1] >= box.y0 && q[1] <= box.y1) inside++;
      sx += clamp(q[0], -width, 2 * width);
      sy += clamp(q[1], -height, 2 * height);
    }
    const h = P.project(bearing, 0);
    const horizon = h && h[1] >= box.y0 && h[1] <= box.y1 ? 1 : 0;
    const off = Math.hypot(sx / points.length - cx, sy / points.length - cy) / diag;
    return inside / points.length + 0.15 * horizon - 0.002 * (fov - minFov) - 0.06 * off - 0.0004 * Math.abs(turnDeg(peak.azimuth, bearing));
  };
  let best = { s: -Infinity };
  const consider = (bearing, pitch, fov) => {
    pitch = clamp(pitch, 80, 170);
    fov = clamp(fov, minFov, maxFov);
    const s = score(bearing, pitch, fov);
    if (s > best.s) best = { s, bearing: wrap360(bearing), pitch, fov };
  };
  for (let fov = minFov; fov <= maxFov; fov += 10) {
    for (let pitch = 80; pitch <= 170; pitch += 5) {
      for (let k = -9; k <= 9; k++) consider(peak.azimuth + k * 10, pitch, fov);
    }
  }
  const coarse = { ...best };
  for (let df = -5; df <= 5; df += 5) {
    for (let dp = -4; dp <= 4; dp += 2) {
      for (let db = -8; db <= 8; db += 4) consider(coarse.bearing + db, coarse.pitch + dp, coarse.fov + df);
    }
  }
  return { bearing: +best.bearing.toFixed(2), pitch: +best.pitch.toFixed(2), fov: +best.fov.toFixed(2) };
}

/** Signed difference b − a of two azimuths, −180..180. */
const turnDeg = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

// ---------------------------------------------------------------------------
// The sky's light

/**
 * The limiting magnitude at the zenith: the darker of the twilight's (and the
 * Moon's, sat-astro's skyPalette) and the town's (LIGHT_POLLUTION).
 */
export function limitingMagnitude(sunElevation, { moon = null, lightPollution = "suburban" } = {}) {
  const lp = LIGHT_POLLUTION[lightPollution] ?? LIGHT_POLLUTION.suburban;
  return Math.min(skyPalette(sunElevation, moon).limit, lp.limit);
}

/** How bright a star of magnitude `mag` looks at an elevation: fainter low down (extinction). */
export function apparentMagnitude(mag, elevation) {
  return mag + extinction(elevation);
}

/**
 * Whether a star shows: above the horizon and, with the air's extinction and
 * the brighter sky low down (the town's glow), brighter than the limit.
 */
export function starVisible(mag, elevation, limit, dome = 0) {
  if (elevation <= 0) return false;
  return apparentMagnitude(mag, elevation) <= limit - horizonGlowPenalty(elevation, dome);
}

/** Magnitudes lost to the glow of a town low over the horizon (dome 0..1). */
export function horizonGlowPenalty(elevation, dome) {
  return 1.2 * dome * Math.exp(-Math.max(elevation, 0) / 15);
}

/**
 * Per-frame constants of the sky's colour for a Sun (and Moon) and a light
 * pollution setting; skyColorAt() then gives the colour of any direction.
 */
export function skyModel(sun, { moon = null, lightPollution = "suburban" } = {}) {
  const palette = skyPalette(sun.elevation, moon);
  const lp = LIGHT_POLLUTION[lightPollution] ?? LIGHT_POLLUTION.suburban;
  // The town's glow shows once the twilight has faded.
  const dome = lp.dome * smooth(-3, -12, sun.elevation);
  const [sx, sy, sz] = azElVector(sun.azimuth, sun.elevation);
  return {
    zenith: palette.zenith,
    horizon: palette.horizon,
    glow: palette.glow,
    glowHeight: palette.glowHeight,
    sunAzimuth: sun.azimuth,
    sunElevation: sun.elevation,
    sun: [sx, sy, sz],
    day: clamp((sun.elevation + 2) / 8, 0, 1),
    dome,
    limit: Math.min(palette.limit, lp.limit),
    twilight: palette.twilight,
    key: [sun.azimuth, sun.elevation].map((v) => v.toFixed(2)).join("|") + `|${lightPollution}|${palette.zenith}`,
  };
}

// Sodium and LED light scattered back down: a warm grey over the horizon.
const DOME = [70, 52, 38];
// The air below the horizon, where the map leaves a gap: a dark haze.
const HAZE = 0.42;

/**
 * Colour (sRGB 0-255, unrounded) of the sky at an azimuth and elevation: the
 * horizon's colour fading up to the zenith's, the glow of the Sun on its side
 * low down, the whiter aureole around it by day, the town's glow over the
 * horizon, and a dark haze below it. Matches sat-astro's skyColor above the
 * horizon without light pollution, but allocates nothing (the gradient asks
 * for thousands of points per frame).
 */
export function skyColorAt(m, azimuth, elevation, out = [0, 0, 0]) {
  const e = Math.max(0, elevation);
  const k = (e / 90) ** 0.45;
  const side = ((1 + Math.cos((azimuth - m.sunAzimuth) * DEG)) / 2) ** 3;
  const g = side * Math.exp(-e / m.glowHeight);
  let aureole = 0;
  if (m.sunElevation > -2) {
    const ce = Math.cos(e * DEG);
    const dot = Math.sin(azimuth * DEG) * ce * m.sun[0] + Math.cos(azimuth * DEG) * ce * m.sun[1] + Math.sin(e * DEG) * m.sun[2];
    const away = Math.acos(clamp(dot, -1, 1)) / DEG;
    aureole = 0.7 * m.day * Math.exp(-away / 6);
  }
  const dome = m.dome * Math.exp(-e / 14);
  const below = elevation < 0 ? smooth(0, -3, elevation) : 0;
  for (let i = 0; i < 3; i++) {
    let c = m.horizon[i] + (m.zenith[i] - m.horizon[i]) * k;
    c += (m.glow[i] - c) * g;
    if (aureole) c += ([255, 250, 240][i] - c) * aureole;
    c += DOME[i] * dome;
    if (below) c += (m.horizon[i] * HAZE - c) * below;
    out[i] = c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The satellites' paths

/**
 * A pass_track row list as typed arrays: times, horizon-frame unit vectors,
 * elevations, sunlit and visible flags and magnitudes (NaN when none).
 * Rows: [t, lat, lon, alt_km, lit, az, el, range_km, mag, vis].
 */
export function trackFromRows(rows) {
  const n = rows.length;
  const t = new Float64Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const az = new Float32Array(n);
  const el = new Float32Array(n);
  const lit = new Uint8Array(n);
  const vis = new Uint8Array(n);
  const mag = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    t[i] = r[0];
    az[i] = r[5];
    el[i] = r[6];
    const v = azElVector(r[5], r[6]);
    x[i] = v[0];
    y[i] = v[1];
    z[i] = v[2];
    lit[i] = r[4] ? 1 : 0;
    vis[i] = r[9] ? 1 : 0;
    mag[i] = r[8] == null ? NaN : r[8];
  }
  return { n, t, x, y, z, az, el, lit, vis, mag };
}

/**
 * Each satellite of a pass, from its pass_track payload: the primary first,
 * the rest in order. A train's members without rows follow the primary's
 * path, offset_s later.
 */
export function buildTracks(pass, detail) {
  const transits = detail?.transits ?? [];
  if (!transits.length) return [];
  const primaryId = pass?.transits?.[0]?.norad_id;
  let primaryIndex = transits.findIndex((tr) => tr.norad_id === primaryId && tr.rows);
  if (primaryIndex < 0) primaryIndex = Math.max(0, transits.findIndex((tr) => tr.rows));
  const primaryData = transits[primaryIndex].rows ? trackFromRows(transits[primaryIndex].rows) : null;
  if (!primaryData) return [];
  const used = new Set();
  const tracks = transits.map((tr, i) => {
    // The pass's own record of this satellite (reasons, brightest time), by id, else by position.
    let info = pass?.transits?.findIndex((p, k) => !used.has(k) && p.norad_id === tr.norad_id) ?? -1;
    if (info < 0 && pass?.transits?.[i] && !used.has(i)) info = i;
    if (info >= 0) used.add(info);
    const own = info >= 0 ? pass.transits[info] : null;
    const primary = i === primaryIndex;
    return {
      id: tr.norad_id,
      name: tr.name,
      kind: tr.kind,
      primary,
      offset: tr.rows || primary ? 0 : tr.offset_s || 0,
      shifted: !tr.rows && !primary,
      data: primary ? primaryData : tr.rows ? trackFromRows(tr.rows) : primaryData,
      visibleStart: tr.visible_start,
      visibleEnd: tr.visible_end,
      rise: tr.horizon_rise,
      set: tr.horizon_set,
      startReason: own?.start_reason ?? null,
      endReason: own?.end_reason ?? null,
      brightestTime: own?.brightest_time ?? null,
      magnitude: own?.magnitude ?? null,
    };
  });
  // Primary first.
  tracks.unshift(...tracks.splice(primaryIndex, 1));
  return tracks;
}

/** Index of the last sample at or before t (−1 before the first). */
function indexAt(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  if (!(t >= times[0])) return -1;
  if (t >= times[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Where a satellite is at time t (unix s), interpolated between samples:
 * {t, azimuth, elevation, x, y, z (horizon frame), lit, visible, magnitude}, or
 * null outside its path. `offset` shifts a train member along the primary's path.
 */
export function sampleAt(data, t, offset = 0) {
  if (!data?.n) return null;
  const s = t - offset;
  const i = indexAt(data.t, s);
  if (i < 0 || (i === data.n - 1 && s > data.t[i])) return null;
  const j = Math.min(i + 1, data.n - 1);
  const f = j === i ? 0 : (s - data.t[i]) / (data.t[j] - data.t[i]);
  let x = data.x[i] + (data.x[j] - data.x[i]) * f;
  let y = data.y[i] + (data.y[j] - data.y[i]) * f;
  let z = data.z[i] + (data.z[j] - data.z[i]) * f;
  const n = Math.hypot(x, y, z) || 1;
  [x, y, z] = [x / n, y / n, z / n];
  const near = f < 0.5 ? i : j;
  const [mi, mj] = [data.mag[i], data.mag[j]];
  const magnitude = Number.isFinite(mi) && Number.isFinite(mj) ? mi + (mj - mi) * f : Number.isFinite(data.mag[near]) ? data.mag[near] : null;
  return {
    t,
    azimuth: wrap360(Math.atan2(x, y) / DEG),
    elevation: Math.asin(clamp(z, -1, 1)) / DEG,
    x,
    y,
    z,
    lit: !!data.lit[near],
    visible: !!data.vis[near],
    magnitude,
  };
}

/**
 * Runs of consecutive samples drawn alike, above `minElevation`: "visible"
 * (the library would call it visible), "lit" (sunlit but too low or faint for
 * the sky) and "shadow" (in Earth's shadow). Each run [style, from, to] shares
 * its end sample with the next, so the drawn path has no gaps.
 */
export function pathRuns(data, minElevation = -1) {
  const runs = [];
  let current = null;
  for (let i = 0; i < data.n; i++) {
    if (data.el[i] < minElevation) {
      current = null;
      continue;
    }
    const style = data.lit[i] ? (data.vis[i] ? "visible" : "lit") : "shadow";
    if (current && current[0] === style) {
      current[2] = i;
    } else {
      if (current) current[2] = i;
      current = [style, i, i];
      runs.push(current);
    }
  }
  return runs.filter((r) => r[2] > r[1]);
}

/** Tick times every `step` seconds on the clock (…:00, …:30) from t0 to t1. */
export function tickTimes(t0, t1, step = TICK_S) {
  const out = [];
  if (!(t1 >= t0)) return out;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return out;
}

/**
 * Which ticks get a time label: in path order, each at least `minPx` from the
 * last labelled one, so the labels never crowd where the path runs towards
 * the viewer. Points are {x, y} or null (off screen); returns their indices.
 */
export function spacedLabels(points, minPx = LABEL_SPACING_PX) {
  const out = [];
  let last = null;
  points.forEach((p, i) => {
    if (!p) return;
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < minPx) return;
    out.push(i);
    last = p;
  });
  return out;
}

/** Whether two boxes {x0, y0, x1, y1} overlap (touching edges do not). */
const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Lay labels out without overlaps, most important first (lower priority
 * value first; ties keep their order). A label {x, y (anchor), w, h,
 * offsets: [[dx, dy] …] of its centre from the anchor, tried in order}
 * goes at the first offset whose box stays inside the screen (less `inset`)
 * and clear of every label placed so far and of the obstacles; else it is
 * left out. Returns the placed labels, each with `box` and centre `cx`, `cy`.
 */
export function placeLabels(labels, { width, height, inset = 4, obstacles = [], gap = 3 } = {}) {
  const placed = [];
  const taken = obstacles.map((o) => ({ ...o }));
  const order = labels.map((l, i) => [l, i]).sort((a, b) => (a[0].priority ?? 0) - (b[0].priority ?? 0) || a[1] - b[1]);
  for (const [label] of order) {
    for (const [dx, dy] of label.offsets ?? [[0, 0]]) {
      const cx = label.x + dx;
      const cy = label.y + dy;
      const box = { x0: cx - label.w / 2 - gap, y0: cy - label.h / 2 - gap, x1: cx + label.w / 2 + gap, y1: cy + label.h / 2 + gap };
      if (box.x0 + gap < inset || box.y0 + gap < inset || box.x1 - gap > width - inset || box.y1 - gap > height - inset) continue;
      if (taken.some((o) => overlaps(o, box))) continue;
      taken.push(box);
      placed.push({ ...label, cx, cy, box });
      break;
    }
  }
  return placed;
}

/**
 * Where to put an arrow at the edge of the view pointing at a direction that
 * is not in it (behind the viewer included): {x, y, angle (radians, 0 =
 * right, clockwise)}, or null when the direction is in view. The arrow sits
 * `margin` inside the safe area (the screen less `insets`).
 */
export function edgeArrow(P, azimuth, elevation, { insets = {}, margin = 30 } = {}) {
  const { top = 0, right = 0, bottom = 0, left = 0 } = insets;
  const ce = Math.cos(elevation * DEG);
  const [x3, y3, z3] = P.toCamera(Math.sin(azimuth * DEG) * ce, -Math.cos(azimuth * DEG) * ce, Math.sin(elevation * DEG));
  const box = { x0: left + margin, y0: top + margin, x1: P.width - right - margin, y1: P.height - bottom - margin };
  if (box.x1 <= box.x0 || box.y1 <= box.y0) return null;
  if (z3 < 0) {
    const sx = P.cx + (P.f * x3) / -z3;
    const sy = P.cy + (P.f * y3) / -z3;
    if (sx >= left && sx <= P.width - right && sy >= top && sy <= P.height - bottom) return null;
  }
  // Straight behind the viewer: point right, the way the compass turns.
  let dx = x3;
  let dy = y3;
  if (Math.hypot(dx, dy) < 1e-9) dx = 1;
  const ox = (box.x0 + box.x1) / 2;
  const oy = (box.y0 + box.y1) / 2;
  const sx = dx > 0 ? (box.x1 - ox) / dx : dx < 0 ? (box.x0 - ox) / dx : Infinity;
  const sy = dy > 0 ? (box.y1 - oy) / dy : dy < 0 ? (box.y0 - oy) / dy : Infinity;
  const s = Math.min(sx, sy);
  return { x: ox + dx * s, y: oy + dy * s, angle: Math.atan2(dy, dx) };
}

/**
 * Seconds from t until the satellite is on screen (inside the safe area and
 * above the horizon), searching its path in steps of `step`; 0 when it is
 * already, null when it will not be with this view.
 */
export function timeToEntry(P, data, t, { offset = 0, insets = {}, step = 2, horizon = 120 * 60 } = {}) {
  const { top = 0, right = 0, bottom = 0, left = 0 } = insets;
  for (let dt = 0; dt <= horizon; dt += step) {
    const s = sampleAt(data, t + dt, offset);
    if (!s) {
      if (t + dt - offset > data.t[data.n - 1]) return null;
      continue;
    }
    if (s.elevation <= 0) continue;
    const q = projectEnu(P, s.x, s.y, s.z);
    if (q && q[0] >= left && q[0] <= P.width - right && q[1] >= top && q[1] <= P.height - bottom) return dt;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Occlusion (what the buildings and hills hide)

/**
 * The band of rows (in GL's bottom-up order) a read-back must cover to see
 * every sample: {y0, rows}, or null when no sample is on the drawing buffer.
 * Samples are {x, y} in device pixels from the top left.
 */
export function bandFor(samples, width, height) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of samples) {
    if (s.x < 0 || s.x >= width || s.y < 0 || s.y >= height) continue;
    const gy = height - 1 - Math.round(s.y);
    lo = Math.min(lo, gy);
    hi = Math.max(hi, gy);
  }
  return lo > hi ? null : { y0: lo, rows: hi - lo + 1 };
}

/**
 * Which samples the map hides, from a read-back band of its canvas (RGBA,
 * `rows` rows from GL row y0 up, `width` wide): where the map drew a building
 * or the ground the alpha is opaque (> 200); the sky is transparent.
 * Returns Map(t -> hidden) for the samples inside the band.
 */
export function occlusionFromBand(buffer, width, height, y0, rows, samples) {
  const out = new Map();
  for (const s of samples) {
    const x = Math.round(s.x);
    const gy = height - 1 - Math.round(s.y);
    const row = gy - y0;
    if (x < 0 || x >= width || row < 0 || row >= rows) continue;
    out.set(s.t, buffer[(row * width + x) * 4 + 3] > 200);
  }
  return out;
}

/**
 * Stretches [from, to] (unix s) of a path within [t0, t1] that the
 * occlusion map says are hidden, merging samples up to `gap` seconds apart.
 */
export function hiddenStretches(data, hidden, t0, t1, gap = 4.5) {
  const out = [];
  if (!hidden?.size || !data?.n) return out;
  for (let i = 0; i < data.n; i++) {
    const t = data.t[i];
    if (t < t0 || t > t1 || hidden.get(t) !== true) continue;
    const last = out[out.length - 1];
    if (last && t - last[1] <= gap) last[1] = t;
    else out.push([t, t]);
  }
  return out;
}

/** Linear interpolation in a skyline profile ({profile: [{elevation}], stepDeg}) at an azimuth. */
export function skylineAt(skyline, azimuth) {
  const { profile, stepDeg } = skyline;
  const a = wrap360(azimuth) / stepDeg;
  const i = Math.floor(a);
  const f = a - i;
  const p = profile[i % profile.length].elevation;
  const q = profile[(i + 1) % profile.length].elevation;
  return p + (q - p) * f;
}

// ---------------------------------------------------------------------------
// Drawing

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const ELEVATIONS = [10, 20, 30, 45, 60, 75];
// Gold of the visible path, the dimmer gold of its sunlit but faint part, the
// violet of Earth's shadow (the telemetry's), and the label colours.
const GOLD = "252,211,77";
const GOLD_LIGHT = "253,230,138";
const SHADOW = "196,181,253";
const INK = "#f8fafc";
const HALO = "rgba(2,6,23,0.82)";
// Recompute the sky (Sun, Moon, planets, the stars' turn) at most this often in simulated time.
const SKY_STEP_S = 2;
// …and redraw the cached backdrop when the stars have turned this much (≈ 1 px at 50°).
const BACKDROP_STEP_S = 20;

/**
 * Draws the sky behind the map and the labels in front of it. One instance
 * per view; `draw()` per frame. Cheap when only the time moves: the sky,
 * stars and paths are cached per camera and redrawn every 20 simulated
 * seconds; the dots, the trail and the moving labels are drawn every frame.
 */
export class Planetarium {
  /**
   * @param {{sky: HTMLCanvasElement, overlay: HTMLCanvasElement, font?: string, createCanvas?: () => HTMLCanvasElement}} canvases
   */
  constructor({ sky: skyCanvas, overlay, font = "system-ui, sans-serif", createCanvas = () => document.createElement("canvas") }) {
    this.skyCanvas = skyCanvas;
    this.overlayCanvas = overlay;
    this.font = font;
    this._createCanvas = createCanvas;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.observer = { latitude: 0, longitude: 0, elevation: 0 };
    this.options = { constellations: true, lightPollution: "suburban", reducedMotion: false };
    this.formatter = null;
    this.tracks = [];
    this.pass = null;
    this.hidden = null;
    this.hiddenKind = "buildings";
    this.skyline = null;
    this._starVectors = starVectors(STARS);
    this._starEnu = new Float32Array(this._starVectors.length);
    // The eye sees star colours faintly: half the blackbody saturation.
    this._starColors = [];
    for (let i = 0; i < STARS.length; i += 4) this._starColors.push(bvToRgb(STARS[i + 3], 0.5).join(","));
    this._names = new Map(STAR_NAMES);
    this._widths = new Map();
    this._version = 0;
  }

  setObserver({ latitude, longitude, elevation = 0 }) {
    this.observer = { latitude, longitude, elevation };
    this._skyAt = null;
    this._invalidate();
  }

  setOptions(options) {
    this.options = { ...this.options, ...options };
    this._skyAt = null;
    this._invalidate();
  }

  /** The Formatter (sat-format.js) for times, magnitudes and words; redraws the labels. */
  setFormatter(formatter) {
    this.formatter = formatter;
    this._widths.clear();
    this._invalidate();
  }

  /** The pass (from `passes`) and its pass_track payload (or null while it loads). */
  setPass(pass, detail) {
    this.pass = pass;
    this.tracks = detail ? buildTracks(pass, detail) : [];
    this.primary = this.tracks[0] ?? null;
    this.hidden = null;
    this._invalidate();
  }

  /**
   * Which samples of the primary's path buildings or hills hide: Map(t -> bool),
   * or null; `kind` is what hides them, for the HUD: "buildings", "terrain" or
   * "buildings_or_terrain" (the 3D view cannot tell the two apart).
   */
  setOcclusion(hidden, kind = "buildings") {
    this.hidden = hidden;
    this.hiddenKind = kind;
    this._hiddenStamp = (this._hiddenStamp ?? 0) + 1;
    this._overlayKey = null;
  }

  /** The terrain skyline of the fallback ({profile, stepDeg}), drawn as the ground; null for none. */
  setSkyline(skyline) {
    this.skyline = skyline;
    this._invalidate();
  }

  resize(width, height, dpr = 1) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    for (const c of [this.skyCanvas, this.overlayCanvas]) {
      if (!c) continue;
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
    }
    this._invalidate();
  }

  _invalidate() {
    this._version++;
    this._backdropKey = null;
    this._overlayKey = null;
  }

  /** Let go of the off-screen canvases (megabytes each on a large screen) at once. */
  dispose() {
    for (const c of [this._backdrop, this._gradient, this._staticOverlay, this._milky]) {
      if (!c) continue;
      c.width = 0;
      c.height = 0;
    }
    this._backdrop = this._gradient = this._staticOverlay = this._milky = null;
    this._ground = null;
    this.tracks = [];
    this.primary = null;
    this._invalidate();
  }

  /** Changes with anything that changes the picture other than the camera and the time. */
  get stamp() {
    return `${this._version}|${this._hiddenStamp ?? 0}`;
  }

  /** On-screen samples of the primary's path, in device pixels, for the occlusion probe. */
  probeSamples(P) {
    const track = this.primary;
    if (!track) return [];
    const out = [];
    const d = track.data;
    for (let i = 0; i < d.n; i++) {
      if (d.el[i] < 0) continue;
      const q = projectEnu(P, d.x[i], d.y[i], d.z[i]);
      if (!q || q[0] < 0 || q[1] < 0 || q[0] >= P.width || q[1] >= P.height) continue;
      out.push({ t: d.t[i], x: q[0], y: q[1] });
    }
    return out;
  }

  /** The Sun, Moon, planets and the stars' rotation for a moment (cached per SKY_STEP_S). */
  skyAt(tS) {
    const s = this._skyAt;
    if (s && Math.abs(s.t - tS) < SKY_STEP_S) return s;
    const date = tS * 1000;
    const observer = this.observer;
    const sun = sunAzEl(date, observer);
    const moon = { ...moonAzEl(date, observer), ...moonPhase(date) };
    const matrix = horizonMatrix(date, observer);
    const planets = planetPositions(date).map((p) => ({ ...p, ...toHorizon(matrix, p.ra, p.dec) }));
    const model = skyModel(sun, { moon, lightPollution: this.options.lightPollution });
    horizonVectors(matrix, this._starVectors, this._starEnu);
    this._skyAt = { t: tS, sun, moon, matrix, planets, model, limit: model.limit };
    return this._skyAt;
  }

  /**
   * Draw a frame for camera P at time tS (unix s). `insets` (CSS px) keep the
   * pinned compass labels and the edge arrow clear of the HUD's edges, and
   * labels keep out of the `obstacles` ({x0, y0, x1, y1}: the HUD's panels).
   * @returns {object} what the HUD shows: sun, moon, limit, current (the primary now), entry, note
   */
  draw(P, tS, { insets = {}, obstacles = [] } = {}) {
    const sky = this.skyAt(tS);
    const state = this._state(P, tS, sky, insets);
    // The overlay's labels are laid out first: the sky's own labels (stars,
    // planets, constellations) keep out of their way.
    this._layoutOverlay(P, insets, obstacles);
    this._drawSky(P, tS, sky, state);
    this._drawOverlay(P, state, insets, obstacles);
    return state;
  }

  // -- state -----------------------------------------------------------------

  /**
   * The satellite to look for now: the primary while its own window has not
   * ended; then, for a group or a train, the brightest member still in its
   * window (a train goes on after its first satellite has gone).
   */
  focusAt(tS) {
    const primary = this.primary;
    if (!primary) return null;
    const ps = sampleAt(primary.data, tS);
    if (tS <= primary.visibleEnd || this.tracks.length === 1) return { track: primary, s: ps };
    let best = null;
    for (const track of this.tracks) {
      if (track === primary || tS < track.visibleStart || tS > track.visibleEnd) continue;
      const s = sampleAt(track.data, tS, track.offset);
      if (!s || s.elevation <= 0) continue;
      const m = Number.isFinite(s.magnitude) ? s.magnitude : 9;
      if (!best || (s.visible && !best.s.visible) || (s.visible === best.s.visible && m < best.m)) best = { track, s, m };
    }
    return best ? { track: best.track, s: best.s } : { track: primary, s: ps };
  }

  _state(P, tS, sky, insets) {
    const state = { t: tS, sun: sky.sun, moon: sky.moon, limit: sky.limit, twilight: sky.model.twilight, current: null, entry: null, note: null, phase: null, focus: null };
    const primary = this.primary;
    if (!primary) return state;
    const { track, s } = this.focusAt(tS);
    const d = track.data;
    const offset = track.offset;
    state.focus = track;
    state.phase = tS - offset < d.t[0] ? "before" : tS - offset > d.t[d.n - 1] ? "after" : "up";
    if (s) {
      const q = s.elevation > -1 ? projectEnu(P, s.x, s.y, s.z) : null;
      const onScreen = !!q && q[0] >= 0 && q[1] >= 0 && q[0] <= P.width && q[1] <= P.height;
      state.current = { ...s, x: q?.[0], y: q?.[1], onScreen, hidden: track === primary && this._hiddenAt(tS) };
    }
    // The arrow points at the satellite while it is up, else at where it appears.
    const target = s && s.elevation > 0 ? s : tS < track.visibleStart ? sampleAt(d, track.visibleStart, offset) : null;
    if (target && tS <= track.visibleEnd + 30) {
      const arrow = edgeArrow(P, target.azimuth, target.elevation, { insets });
      if (arrow) {
        const wait = timeToEntry(P, d, tS, { insets, offset });
        state.entry = { ...arrow, in: wait, visible: !!s?.visible, before: !(s && s.elevation > 0) };
      }
    }
    // "Hidden behind buildings until …" while hidden; "… from …" before (the primary's path is probed).
    const stretches = track === primary ? hiddenStretches(d, this.hidden, track.visibleStart, track.visibleEnd) : [];
    const now = stretches.find(([a, b]) => tS >= a - 1 && tS <= b + 1);
    const next = stretches.find(([a]) => a > tS);
    if (now) state.note = { kind: "until", time: Math.min(now[1] + 2, track.visibleEnd), stretch: now, source: this.hiddenKind };
    else if (next && tS >= track.visibleStart - 180) state.note = { kind: "from", time: next[0], stretch: next, source: this.hiddenKind };
    return state;
  }

  /** Whether the primary is hidden at t, from the nearest probed sample. */
  _hiddenAt(t) {
    if (!this.hidden?.size || !this.primary) return false;
    const d = this.primary.data;
    const i = indexAt(d.t, t);
    if (i < 0) return false;
    const j = Math.min(i + 1, d.n - 1);
    const near = t - d.t[i] <= d.t[j] - t ? i : j;
    return this.hidden.get(d.t[near]) === true;
  }

  // -- sky canvas (behind the map) --------------------------------------------

  _drawSky(P, tS, sky, state) {
    const canvas = this.skyCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const key = `${P.key}|${Math.floor(tS / BACKDROP_STEP_S)}|${this._version}|${sky.model.key}`;
    if (this._backdropKey !== key) {
      this._backdropKey = key;
      this._backdrop ??= this._createCanvas();
      const b = this._backdrop;
      if (b.width !== canvas.width) b.width = canvas.width;
      if (b.height !== canvas.height) b.height = canvas.height;
      this._paintBackdrop(b.getContext("2d"), P, tS, sky);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(this._backdrop, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const lowest = this._paintDots(ctx, P, tS, state);
    // The fallback's hills hide the dots behind them too, as the map does in
    // 3D: where a dot or its trail reaches the ground, the backdrop's ground
    // goes over it again.
    const ground = this._ground;
    if (ground && lowest >= ground.top) {
      ctx.save();
      traceGround(ctx, P, ground.pts);
      ctx.clip();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this._backdrop, 0, 0);
      ctx.restore();
    }
  }

  _paintBackdrop(ctx, P, tS, sky) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    this._paintGradient(ctx, P, sky.model, W, H);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const dark = smooth(2.5, 4.5, sky.limit);
    // Labels are gathered while painting and laid out together at the end, most important first.
    const labels = [];
    this._paintMilkyWay(ctx, P, sky);
    if (this.options.constellations && dark > 0.01) this._paintConstellations(ctx, P, dark, labels);
    this._paintStars(ctx, P, sky);
    this._paintPlanets(ctx, P, sky, labels);
    this._paintMoon(ctx, P, sky, labels);
    this._paintSun(ctx, P, sky);
    this._paintSkyLabels(ctx, P, labels);
    // The paths before the fallback's ground: its hills hide what is behind them, as the map does in 3D.
    for (const track of [...this.tracks].reverse()) this._paintPath(ctx, P, track, sky.model);
    this._ground = this.skyline ? this._paintSkyline(ctx, P, sky.model) : null;
  }

  /**
   * The Milky Way: only under a dark sky (the town's light and the Moon wash
   * it out first). Each layer is filled as whole polygons over the stretches
   * that are in front of the camera, so no seams show inside the band.
   */
  _paintMilkyWay(ctx, P, sky) {
    const strength = smooth(4.7, 5.9, sky.limit);
    if (strength < 0.02) return;
    // Drawn at an eighth of the resolution and scaled up: the layers' edges blur into a glow.
    const scale = 1 / 8;
    this._milky ??= this._createCanvas();
    const canvas = this._milky;
    const [w, h] = [Math.max(8, Math.ceil(P.width * scale)), Math.max(8, Math.ceil(P.height * scale))];
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const out = ctx;
    ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const m = sky.matrix;
    const toScreen = (v, k) => {
      const [x, y, z] = [v[k * 3], v[k * 3 + 1], v[k * 3 + 2]];
      const e = m[0] * x + m[1] * y + m[2] * z;
      const n = m[3] * x + m[4] * y + m[5] * z;
      const u = m[6] * x + m[7] * y + m[8] * z;
      const q = u > -0.08 ? projectEnu(P, e, n, u) : null;
      // Far outside the screen the projection runs away (towards the camera's side): break there.
      return q && Math.abs(q[0] - P.cx) < P.width * 3 && Math.abs(q[1] - P.cy) < P.height * 3 ? q : null;
    };
    ctx.save();
    for (const layer of MILKY_WAY) {
      ctx.fillStyle = `rgba(206,214,236,${(layer.alpha * strength).toFixed(4)})`;
      let up = [];
      let down = [];
      const flush = () => {
        if (up.length > 1) {
          ctx.beginPath();
          up.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
          for (let i = down.length - 1; i >= 0; i--) ctx.lineTo(down[i][0], down[i][1]);
          ctx.closePath();
          ctx.fill();
        }
        up = [];
        down = [];
      };
      for (let k = 0; k < layer.n; k++) {
        const a = toScreen(layer.upper, k);
        const b = toScreen(layer.lower, k);
        if (!a || !b) {
          flush();
          continue;
        }
        up.push(a);
        down.push(b);
      }
      flush();
    }
    ctx.restore();
    out.save();
    out.imageSmoothingEnabled = true;
    out.imageSmoothingQuality = "high";
    out.drawImage(canvas, 0, 0, w / scale, h / scale);
    out.restore();
  }

  /** The Moon's, the planets', the bright stars' and the constellations' names, clear of each other and of the overlay's labels. */
  _paintSkyLabels(ctx, P, labels) {
    const placed = placeLabels(labels, { width: P.width, height: P.height, inset: 2, obstacles: this._layout?.boxes ?? [], gap: 2 });
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const l of placed) {
      ctx.font = l.font;
      ctx.fillStyle = l.color;
      if (l.spacing) spaced(ctx, l.text, l.cx + l.spacing / 2, l.cy, l.spacing);
      else ctx.fillText(l.text, l.cx, l.cy + 0.5);
    }
    ctx.restore();
  }

  /** A sky label (see _paintSkyLabels) with offsets of its centre around an anchor. */
  _skyLabel(text, x, y, { size = 10.5, weight = 600, color, priority, offsets, spacing = 0 }) {
    const w = this._textWidth(text, weight, size) + spacing * Math.max(0, text.length - 1);
    const h = size + 3;
    return { text, x, y, w, h, color, priority, font: `${weight} ${size}px ${this.font}`, spacing, offsets: offsets(w, h) };
  }

  /** The sky's colour, computed at 1/8 resolution and scaled up smoothly. */
  _paintGradient(ctx, P, model, W, H) {
    const sw = Math.max(8, Math.ceil(P.width / 8));
    const sh = Math.max(8, Math.ceil(P.height / 8));
    const key = `${P.key}|${model.key}|${sw}x${sh}`;
    if (this._gradientKey !== key) {
      this._gradientKey = key;
      this._gradient ??= this._createCanvas();
      const g = this._gradient;
      if (g.width !== sw || g.height !== sh) {
        g.width = sw;
        g.height = sh;
      }
      const gctx = g.getContext("2d");
      const img = gctx.createImageData(sw, sh);
      const rgb = [0, 0, 0];
      // Dither by up to half a level: the smooth twilight would show bands otherwise.
      let seed = 7;
      for (let j = 0; j < sh; j++) {
        for (let i = 0; i < sw; i++) {
          const dir = P.unproject(((i + 0.5) / sw) * P.width, ((j + 0.5) / sh) * P.height);
          skyColorAt(model, dir.azimuth, dir.elevation, rgb);
          seed = (seed * 16807) % 2147483647;
          const n = seed / 2147483647 - 0.5;
          const k = (j * sw + i) * 4;
          img.data[k] = rgb[0] + n;
          img.data[k + 1] = rgb[1] + n;
          img.data[k + 2] = rgb[2] + n;
          img.data[k + 3] = 255;
        }
      }
      gctx.putImageData(img, 0, 0);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this._gradient, 0, 0, W, H);
  }

  _paintStars(ctx, P, sky) {
    const enu = this._starEnu;
    const limit = sky.limit;
    const dome = sky.model.dome;
    const pad = 6;
    for (let i = 0, k = 0; k < enu.length; i++, k += 3) {
      const u = enu[k + 2];
      if (u <= 0.002) continue;
      const mag = STARS[i * 4 + 2];
      // Brightest first: once a star is too faint even at the zenith, all the rest are.
      if (mag > limit + 0.6) break;
      const el = Math.asin(u) / DEG;
      const m = apparentMagnitude(mag, el) + horizonGlowPenalty(el, dome);
      if (m > limit + 0.5) continue;
      const q = projectEnu(P, enu[k], enu[k + 1], u);
      if (!q || q[0] < -pad || q[1] < -pad || q[0] > P.width + pad || q[1] > P.height + pad) continue;
      // The faintest still show as pinpricks (a screen is not a dark-adapted eye).
      const r = starRadius(m, limit, 0.72, 3.6);
      const a = 0.22 + 0.78 * starAlpha(m, limit);
      const c = this._starColors[i];
      if (m < 1.2) {
        const g = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], r * 4.5);
        g.addColorStop(0, `rgba(${c},${0.32 * a})`);
        g.addColorStop(1, `rgba(${c},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(q[0], q[1], r * 4.5, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(${c},${a})`;
      ctx.beginPath();
      ctx.arc(q[0], q[1], r, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  _paintConstellations(ctx, P, dark, labels) {
    const enu = this._starEnu;
    const at = (i) => (enu[i * 3 + 2] > -0.02 ? projectEnu(P, enu[i * 3], enu[i * 3 + 1], enu[i * 3 + 2]) : null);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    ctx.strokeStyle = `rgba(165,180,252,${0.17 * dark})`;
    ctx.beginPath();
    for (const c of CONSTELLATIONS) {
      for (const line of c.lines) {
        let pen = false;
        for (const i of line) {
          const q = at(i);
          if (!q) {
            pen = false;
            continue;
          }
          if (pen) ctx.lineTo(q[0], q[1]);
          else ctx.moveTo(q[0], q[1]);
          pen = true;
        }
      }
    }
    ctx.stroke();
    ctx.restore();
    // Names: the prominent constellations at every zoom, the rest once zoomed in.
    const maxRank = P.fov > 75 ? 1 : P.fov > 55 ? 2 : 3;
    const matrix = this._skyAt.matrix;
    for (const c of CONSTELLATIONS) {
      if (c.rank > maxRank) continue;
      const pos = toHorizon(matrix, c.label[0], c.label[1]);
      if (pos.elevation < 4) continue;
      const q = P.project(pos.azimuth, pos.elevation);
      if (!q || q[0] < 0 || q[1] < 0 || q[0] > P.width || q[1] > P.height) continue;
      labels.push(this._skyLabel(c.name.toUpperCase(), q[0], q[1], {
        size: 10, color: `rgba(165,180,252,${0.42 * dark})`, priority: 3 + c.rank / 10, spacing: 1.5,
        offsets: (w, h) => [[0, 0], [0, -h - 2], [0, h + 2]],
      }));
    }
    // The brightest stars by name.
    for (const [i, name] of this._names) {
      if (STARS[i * 4 + 2] > 1.6) continue;
      const u = enu[i * 3 + 2];
      if (u < 0.07) continue;
      const q = projectEnu(P, enu[i * 3], enu[i * 3 + 1], u);
      if (!q || q[0] < 0 || q[1] < 0 || q[0] > P.width || q[1] > P.height) continue;
      labels.push(this._skyLabel(name, q[0], q[1], {
        weight: 500, color: `rgba(203,213,225,${0.6 * dark})`, priority: 2 + STARS[i * 4 + 2] / 10,
        offsets: (w, h) => [[w / 2 + 7, 0], [-w / 2 - 7, 0], [0, -h / 2 - 6], [0, h / 2 + 6]],
      }));
    }
  }

  _paintPlanets(ctx, P, sky, labels) {
    const limit = sky.limit;
    for (const p of sky.planets) {
      if (p.elevation <= 0) continue;
      const m = apparentMagnitude(p.magnitude, p.elevation);
      if (m > limit + 0.3) continue;
      const q = P.project(p.azimuth, p.elevation);
      if (!q || q[0] < -10 || q[1] < -10 || q[0] > P.width + 10 || q[1] > P.height + 10) continue;
      const c = bvToRgb(p.bv, 0.75).join(",");
      const r = Math.max(1.8, starRadius(m, limit, 0.8, 4.2));
      const g = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], r * 5);
      g.addColorStop(0, `rgba(${c},0.45)`);
      g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(q[0], q[1], r * 5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = `rgb(${c})`;
      ctx.beginPath();
      ctx.arc(q[0], q[1], r, 0, 2 * Math.PI);
      ctx.fill();
      labels.push(this._skyLabel(this._t(`planetarium.${p.name}`), q[0], q[1], {
        color: "rgba(254,243,199,0.8)", priority: 1 + m / 20,
        offsets: (w, h) => [[w / 2 + r + 6, 0], [-w / 2 - r - 6, 0], [0, -h / 2 - r - 5], [0, h / 2 + r + 5]],
      }));
    }
  }

  _paintMoon(ctx, P, sky, labels) {
    const m = sky.moon;
    if (m.elevation < -1) return;
    const q = P.project(m.azimuth, m.elevation);
    if (!q) return;
    // 2.5 times its true size, so the phase reads at any zoom.
    const r = Math.max(5, 2.5 * P.f * Math.tan(m.radius * DEG));
    if (q[0] < -r * 10 || q[1] < -r * 10 || q[0] > P.width + r * 10 || q[1] > P.height + r * 10) return;
    // Direction of the lit side on screen: towards the Sun along the great circle.
    const ahead = towards(m, sky.sun, 1);
    const q2 = P.project(ahead.azimuth, ahead.elevation);
    const litSide = q2 ? Math.atan2(q2[0] - q[0], -(q2[1] - q[1])) / DEG : skyDirection(m, sky.sun);
    const night = 1 - sky.model.day;
    const halo = ctx.createRadialGradient(q[0], q[1], r * 0.8, q[0], q[1], r * 9);
    halo.addColorStop(0, `rgba(226,232,240,${(0.22 * m.fraction + 0.03) * (0.4 + 0.6 * night)})`);
    halo.addColorStop(1, "rgba(226,232,240,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(q[0], q[1], r * 9, 0, 2 * Math.PI);
    ctx.fill();
    ctx.save();
    ctx.translate(q[0], q[1]);
    // The unlit part, faintly lit by the Earth.
    ctx.fillStyle = `rgba(52,58,78,${0.55 + 0.35 * night})`;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 2 * Math.PI);
    ctx.fill();
    if (m.fraction > 0.005) {
      const lit = new Path2D(moonLitPath(r, m.fraction, litSide));
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
      g.addColorStop(0, "#fbfaf2");
      g.addColorStop(1, "#d9d6c8");
      ctx.fillStyle = g;
      ctx.fill(lit);
    }
    ctx.restore();
    labels.push(this._skyLabel(this._t("planetarium.moon"), q[0], q[1], {
      color: "rgba(226,232,240,0.75)", priority: 0,
      offsets: (w, h) => [[0, r + h / 2 + 5], [w / 2 + r + 6, 0], [0, -r - h / 2 - 5], [-w / 2 - r - 6, 0]],
    }));
  }

  _paintSun(ctx, P, sky) {
    const s = sky.sun;
    if (s.elevation < -1) return;
    const q = P.project(s.azimuth, s.elevation);
    if (!q) return;
    const r = Math.max(6, P.f * Math.tan(s.radius * DEG));
    const glare = ctx.createRadialGradient(q[0], q[1], r, q[0], q[1], r * 14);
    glare.addColorStop(0, "rgba(255,250,235,0.85)");
    glare.addColorStop(0.25, "rgba(255,240,210,0.3)");
    glare.addColorStop(1, "rgba(255,240,210,0)");
    ctx.fillStyle = glare;
    ctx.beginPath();
    ctx.arc(q[0], q[1], r * 14, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = "#fffdf5";
    ctx.beginPath();
    ctx.arc(q[0], q[1], r, 0, 2 * Math.PI);
    ctx.fill();
  }

  /**
   * The fallback's ground: the terrain skyline filled down to the bottom of
   * the screen. Returns its outline {pts, top} (CSS px), or null when none is in view.
   */
  _paintSkyline(ctx, P, model) {
    const half = (P.fov * P.width) / P.height / 2 + 30;
    const from = P.bearing - Math.min(180, half);
    const to = P.bearing + Math.min(180, half);
    const pts = [];
    for (let a = from; a <= to; a += 0.25) {
      const q = P.project(a, skylineAt(this.skyline, a));
      if (q) pts.push(q);
    }
    if (pts.length < 2) {
      // Looking up past the skyline: nothing of the ground in view.
      return null;
    }
    const top = Math.min(...pts.map((p) => p[1]));
    const g = ctx.createLinearGradient(0, top, 0, P.height);
    const lift = 0.35 + 0.65 * model.day;
    g.addColorStop(0, `rgb(${[16, 20, 32].map((c) => Math.round(c * lift + 30 * model.day)).join(",")})`);
    g.addColorStop(1, `rgb(${[5, 7, 12].map((c) => Math.round(c * lift + 20 * model.day)).join(",")})`);
    ctx.fillStyle = g;
    traceGround(ctx, P, pts);
    ctx.fill();
    // A rim of the sky's own light along the ridge.
    ctx.strokeStyle = `rgba(148,163,184,${0.18 + 0.2 * model.day})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    return { pts, top };
  }

  /** A satellite's path: gold where sunlit (brightest where visible), dashed violet in Earth's shadow. */
  _paintPath(ctx, P, track, model) {
    // A train's members run along nearly the same path, and the paths of a big
    // group would be a web of lines: only their dots are drawn. A pair or a
    // small group shows each path, faintly.
    if (!track.primary && (track.shifted || this.pass?.train || this.tracks.length > 4)) return;
    const d = track.data;
    const pts = new Array(d.n);
    for (let i = 0; i < d.n; i++) pts[i] = d.el[i] > -1.5 ? projectEnu(P, d.x[i], d.y[i], d.z[i]) : null;
    const runs = pathRuns(d, -1.5);
    const member = !track.primary;
    // A dark casing keeps the gold readable on a bright (twilight or day) sky.
    const casing = 0.35 * smooth(0.25, 0.7, (model.zenith[0] + model.zenith[1] + model.zenith[2]) / 765);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // The visible stretch brightens and fades with the satellite: pieces of
    // equal brightness (half a magnitude) get their own width and opacity.
    const pieces = [];
    for (const run of runs) {
      if (run[0] !== "visible") {
        pieces.push(run);
        continue;
      }
      const [, a, b] = run;
      const fallback = track.magnitude ?? magAround(d, a, b);
      const level = (i) => Math.round((Number.isFinite(d.mag[i]) ? d.mag[i] : fallback) * 2) / 2;
      let from = a;
      for (let i = a + 1; i <= b; i++) {
        if (i < b && level(i) === level(from)) continue;
        pieces.push(["visible", from, i, level(from)]);
        from = i;
      }
    }
    const scale = member ? 0.6 : 1;
    const stroke = (a, b, w, color, dash = []) => {
      ctx.setLineDash(dash);
      ctx.lineWidth = w * scale;
      ctx.strokeStyle = color;
      ctx.beginPath();
      let pen = false;
      for (let i = a; i <= b; i++) {
        const q = pts[i];
        if (!q) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(q[0], q[1]);
        else ctx.moveTo(q[0], q[1]);
        pen = true;
      }
      ctx.stroke();
    };
    // Casing and glow once per visible run (overlapping translucent pieces would bead at their joints)…
    for (const [style, a, b] of runs) {
      if (style !== "visible") continue;
      const width = magnitudeWidth(track.magnitude ?? magAround(d, a, b));
      if (casing > 0.01) stroke(a, b, width + 2.5, `rgba(15,23,42,${casing})`);
      if (member) continue;
      stroke(a, b, width * 4.5, `rgba(${GOLD},0.1)`);
      stroke(a, b, width * 2.2, `rgba(${GOLD},0.2)`);
    }
    // …then the line itself, piece by piece, butt-ended so the pieces meet without overlapping.
    for (const [style, a, b, mag] of pieces) {
      if (style === "shadow") {
        stroke(a, b, 1.3, `rgba(${SHADOW},${member ? 0.25 : 0.5})`, [3, 6]);
      } else if (style === "lit") {
        if (casing > 0.01) stroke(a, b, 3.6, `rgba(15,23,42,${casing})`);
        stroke(a, b, 1.6, `rgba(${GOLD},${member ? 0.28 : 0.55})`);
      } else {
        const strength = clamp(0.72 + 0.09 * (2.5 - mag), 0.72, 1);
        ctx.lineCap = "butt";
        stroke(a, b, magnitudeWidth(mag), `rgba(${GOLD_LIGHT},${member ? 0.5 : (0.96 * strength).toFixed(3)})`);
        ctx.lineCap = "round";
      }
    }
    ctx.restore();
    if (!member) this._paintChevrons(ctx, P, track, pts);
  }

  /** Small chevrons along the visible part, pointing the way the satellite goes. */
  _paintChevrons(ctx, P, track, pts) {
    const d = track.data;
    let travelled = 0;
    let last = null;
    ctx.save();
    ctx.strokeStyle = `rgba(${GOLD_LIGHT},0.9)`;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < d.n; i++) {
      const [p, q] = [pts[i - 1], pts[i]];
      if (!p || !q || !d.vis[i]) {
        last = null;
        continue;
      }
      const step = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (step > 200) continue; // a jump across the screen edge
      travelled += step;
      if (last === null) {
        last = 0;
        travelled = 50;
      }
      if (travelled < 120) continue;
      travelled = 0;
      const angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
      if (q[0] < 0 || q[1] < 0 || q[0] > P.width || q[1] > P.height) continue;
      ctx.save();
      ctx.translate(q[0], q[1]);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(-3.5, -4.5);
      ctx.lineTo(1.5, 0);
      ctx.lineTo(-3.5, 4.5);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * The satellites now: a dot sized and glowing by its brightness, with a
   * short trail. Returns how far down the screen they reach (CSS px).
   */
  _paintDots(ctx, P, tS, state) {
    let lowest = -Infinity;
    for (const track of this.tracks) {
      const s = sampleAt(track.data, tS, track.offset);
      if (!s || s.elevation < -0.5) continue;
      const q = projectEnu(P, s.x, s.y, s.z);
      if (!q || q[0] < -40 || q[1] < -40 || q[0] > P.width + 40 || q[1] > P.height + 40) continue;
      if (track.primary) lowest = Math.max(lowest, this._paintTrail(ctx, P, track, tS, s));
      lowest = Math.max(lowest, q[1] + paintDot(ctx, q[0], q[1], s, { primary: track.primary }));
    }
    return lowest;
  }

  /** The trail behind the primary's dot; returns how far down the screen it reaches (CSS px). */
  _paintTrail(ctx, P, track, tS, s) {
    let lowest = -Infinity;
    if (!s.lit) return lowest;
    const steps = 10;
    let prev = null;
    ctx.save();
    ctx.lineCap = "round";
    for (let k = steps; k >= 0; k--) {
      const p = sampleAt(track.data, tS - k * 0.8, track.offset);
      const q = p && p.elevation > -0.5 ? projectEnu(P, p.x, p.y, p.z) : null;
      if (q && prev) {
        const width = Math.max(1, dotRadius(s.magnitude) * 0.9 * (1 - k / steps));
        ctx.strokeStyle = `rgba(${GOLD_LIGHT},${0.55 * (1 - k / steps)})`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(q[0], q[1]);
        ctx.stroke();
        lowest = Math.max(lowest, prev[1] + width / 2, q[1] + width / 2);
      }
      prev = q;
    }
    ctx.restore();
    return lowest;
  }

  // -- overlay (in front of the map) ------------------------------------------

  /** Paint the parts of the overlay that only move with the camera (cached). */
  _layoutOverlay(P, insets, obstacles) {
    const canvas = this.overlayCanvas;
    if (!canvas) return;
    const edges = [insets.top, insets.right, insets.bottom, insets.left].map((v) => Math.round(v ?? 0)).join(",");
    const blocks = obstacles.map((b) => [b.x0, b.y0, b.x1, b.y1].map(Math.round).join(",")).join(";");
    const key = `${P.key}|${this.stamp}|${edges}|${blocks}`;
    if (this._overlayKey === key) return;
    this._overlayKey = key;
    // The backdrop's labels depend on this layout.
    this._backdropKey = null;
    this._staticOverlay ??= this._createCanvas();
    const o = this._staticOverlay;
    if (o.width !== canvas.width) o.width = canvas.width;
    if (o.height !== canvas.height) o.height = canvas.height;
    const octx = o.getContext("2d");
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, o.width, o.height);
    octx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._layout = this._paintStaticOverlay(octx, P, insets, obstacles);
  }

  _drawOverlay(P, state, insets, obstacles) {
    const canvas = this.overlayCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this._staticOverlay) ctx.drawImage(this._staticOverlay, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._paintLive(ctx, P, state, insets, obstacles);
  }

  _paintStaticOverlay(ctx, P, insets, obstacles) {
    const boxes = [];
    const compass = this._paintCompass(ctx, P, insets);
    boxes.push(...compass);
    const scale = this._paintElevationScale(ctx, P, insets);
    boxes.push(...scale);
    const track = this.primary;
    if (!track) return { boxes };
    const d = track.data;
    const pts = new Array(d.n);
    for (let i = 0; i < d.n; i++) pts[i] = d.el[i] > -1 ? projectEnu(P, d.x[i], d.y[i], d.z[i]) : null;
    this._paintXray(ctx, d, pts);
    // Ticks: dots where the satellite can be seen, hollow rings where it is hidden.
    const ticks = tickTimes(d.t[0], d.t[d.n - 1]).map((t) => {
      const s = sampleAt(d, t);
      if (!s || s.elevation < 0.5) return null;
      const q = projectEnu(P, s.x, s.y, s.z);
      if (!q || q[0] < 0 || q[1] < 0 || q[0] > P.width || q[1] > P.height) return null;
      return { t, x: q[0], y: q[1], s, hidden: this._hiddenAt(t) };
    });
    // What is drawn on the path is kept clear by every label, the stars' names included.
    const glyphs = [];
    for (const tick of ticks) {
      if (!tick) continue;
      paintTick(ctx, tick.x, tick.y, { hidden: tick.hidden, lit: tick.s.lit, visible: tick.s.visible });
      glyphs.push({ x0: tick.x - 4, y0: tick.y - 4, x1: tick.x + 4, y1: tick.y + 4 });
    }
    // Markers: where it appears, where it is brightest, where it goes.
    const labels = [];
    const markers = this._markers(track);
    for (const m of markers) {
      const s = sampleAt(d, m.t);
      if (!s || s.elevation < 0) continue;
      const q = projectEnu(P, s.x, s.y, s.z);
      if (!q || q[0] < 0 || q[1] < 0 || q[0] > P.width || q[1] > P.height) continue;
      paintMarker(ctx, q[0], q[1], m.kind, { hidden: this._hiddenAt(m.t) });
      glyphs.push({ x0: q[0] - 11, y0: q[1] - 11, x1: q[0] + 11, y1: q[1] + 11 });
      const w = this._textWidth(m.text, 600, 11.5) + (m.kind === "brightest" ? 22 : 18);
      labels.push({
        kind: m.kind, text: m.text, x: q[0], y: q[1], w, h: 22, priority: m.kind === "brightest" ? 0 : 1,
        offsets: around(w, 22, 14, tangentAt(pts, d, m.t)),
      });
    }
    // Time labels on the ticks, at least LABEL_SPACING_PX apart, where the satellite is in sight.
    const labelled = spacedLabels(ticks.map((tk) => (tk && !tk.hidden && tk.s.lit ? tk : null)));
    for (const i of labelled) {
      const tk = ticks[i];
      const text = this._time(tk.t);
      const w = this._textWidth(text, 600, 11);
      labels.push({ kind: "tick", text, x: tk.x, y: tk.y, w, h: 14, priority: 2, offsets: around(w, 14, 10, tangentAt(pts, d, tk.t)) });
    }
    const placed = placeLabels(labels, { width: P.width, height: P.height, inset: 4, obstacles: [...compass, ...scale, ...glyphs, ...insetBoxes(P, insets), ...obstacles] });
    for (const l of placed) {
      if (l.kind === "tick") paintText(ctx, l.text, l.cx, l.cy, { size: 11, color: "#fef3c7", font: this.font });
      else paintPill(ctx, l, this.font);
      boxes.push(l.box);
    }
    boxes.push(...glyphs);
    return { boxes, ticks };
  }

  /** The marker texts of the primary: start ("Appears 20:41:10"), brightest (magnitude), end ("Sets"…). */
  _markers(track) {
    const out = [];
    const start = track.visibleStart;
    const end = track.visibleEnd;
    if (Number.isFinite(start)) {
      const key = track.startReason === "shadow" ? "street.emerges" : "street.appears";
      out.push({ kind: "start", t: start, text: this._t(key, { time: this._time(start) }) });
    }
    if (Number.isFinite(track.brightestTime) && Number.isFinite(track.magnitude)) {
      out.push({ kind: "brightest", t: track.brightestTime, text: this._mag(track.magnitude) });
    }
    if (Number.isFinite(end)) {
      const key = track.endReason === "shadow" ? "street.fades_shadow" : track.endReason === "set" ? "street.sets" : "street.fades_sky";
      out.push({ kind: "end", t: end, text: this._t(key, { time: this._time(end) }) });
    }
    return out;
  }

  /** Dotted gold where buildings or hills hide the path: the x-ray. */
  _paintXray(ctx, d, pts) {
    if (!this.hidden?.size) return;
    ctx.save();
    ctx.setLineDash([1.5, 5]);
    ctx.lineCap = "round";
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${GOLD_LIGHT},0.6)`;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < d.n; i++) {
      const q = pts[i];
      const hidden = this.hidden.get(d.t[i]) === true;
      if (!q || d.el[i] < 0 || !hidden || !d.lit[i]) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(q[0], q[1]);
      else ctx.moveTo(q[0], q[1]);
      pen = true;
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Compass points on the horizon, held above the bottom of the view when the horizon is below it. */
  _paintCompass(ctx, P, insets) {
    const boxes = [];
    const bottom = P.height - (insets.bottom ?? 0) - 18;
    const top = (insets.top ?? 0) + 14;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Ticks every 10°, the eight points (every 45°) named.
    for (let az = 0; az < 360; az += 5) {
      const major = az % 45 === 0;
      if (!major && az % 10) continue;
      const q = P.project(az, 0);
      if (!q || q[0] < -20 || q[0] > P.width + 20) continue;
      const y = clamp(q[1], top, bottom);
      ctx.strokeStyle = major ? "rgba(226,232,240,0.8)" : "rgba(226,232,240,0.38)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(q[0], y + 4);
      ctx.lineTo(q[0], y + (major ? 12 : 8));
      ctx.stroke();
      if (!major) continue;
      const point = COMPASS[az / 45];
      const text = this.formatter ? this.formatter.direction(point) : point;
      const cardinal = az % 90 === 0;
      const size = cardinal ? 13 : 11;
      paintText(ctx, text, q[0], y - 6, { size, weight: cardinal ? 700 : 600, color: az === 0 ? "#7dd3fc" : cardinal ? INK : "#cbd5e1", font: this.font });
      const w = this._textWidth(text, 700, size);
      boxes.push({ x0: q[0] - w / 2 - 4, y0: y - 6 - size / 2 - 3, x1: q[0] + w / 2 + 4, y1: y + 12 });
    }
    ctx.restore();
    return boxes;
  }

  /** Elevations up the left edge: where each circle of equal elevation crosses it. */
  _paintElevationScale(ctx, P, insets) {
    const boxes = [];
    const left = (insets.left ?? 0) + 2;
    const top = (insets.top ?? 0) + 12;
    const bottom = P.height - (insets.bottom ?? 0) - 30;
    const marks = [];
    let previous = null;
    for (let y = top; y <= bottom; y += 2) {
      const el = P.unproject(left, y).elevation;
      if (previous !== null) {
        for (const mark of ELEVATIONS) {
          if ((previous.el - mark) * (el - mark) > 0 || previous.el === el) continue;
          marks.push({ el: mark, y: previous.y + ((mark - previous.el) / (el - previous.el)) * (y - previous.y) });
        }
      }
      previous = { el, y };
    }
    ctx.save();
    let last = -Infinity;
    for (const m of marks.sort((a, b) => a.y - b.y)) {
      // Looking steeply up they bunch together at the edge: keep them apart.
      if (m.y - last < 22) continue;
      last = m.y;
      ctx.fillStyle = "rgba(203,213,225,0.55)";
      ctx.fillRect(left, Math.round(m.y), 6, 1);
      const text = this.formatter ? this.formatter.degrees(m.el) : `${m.el}°`;
      paintText(ctx, text, left + 10, m.y, { size: 10.5, weight: 600, color: "rgba(203,213,225,0.75)", align: "left", font: this.font });
      boxes.push({ x0: left, y0: m.y - 8, x1: left + 14 + this._textWidth(text, 600, 10.5), y1: m.y + 8 });
    }
    ctx.restore();
    return boxes;
  }

  /** What moves every frame: the hidden dot's x-ray ring, the name by the dot and the edge arrow. */
  _paintLive(ctx, P, state, insets, hud) {
    const track = this.primary;
    if (!track) return;
    const cur = state.current;
    const obstacles = [...(this._layout?.boxes ?? []), ...insetBoxes(P, insets), ...hud];
    if (cur?.onScreen && cur.elevation > -0.5) {
      if (cur.hidden) {
        // Behind a building: a dashed ring where it is.
        ctx.save();
        ctx.setLineDash([2.5, 3.5]);
        ctx.strokeStyle = `rgba(${GOLD_LIGHT},0.85)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cur.x, cur.y, dotRadius(cur.magnitude) + 5, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.restore();
      }
      const name = state.focus && state.focus !== track ? state.focus.name : this.pass ? this._passName() : track.name;
      const w = this._textWidth(name, 700, 11.5) + 16;
      const [placed] = placeLabels(
        [{ kind: "name", text: name, x: cur.x, y: cur.y, w, h: 20, offsets: [[0, -22], [w / 2 + 14, 0], [-w / 2 - 14, 0], [0, 22]] }],
        { width: P.width, height: P.height, obstacles },
      );
      if (placed) {
        paintPill(ctx, { ...placed, kind: cur.visible ? "name" : "name-dim" }, this.font);
        obstacles.push(placed.box);
      }
    }
    // The other satellites of a small group by name (a train's are too many: its dots say enough).
    if (!this.pass?.train && this.tracks.length > 1 && this.tracks.length <= 8) {
      const names = [];
      for (const other of this.tracks) {
        if (other === state.focus) continue;
        const s = sampleAt(other.data, state.t, other.offset);
        if (!s || s.elevation < 1 || !s.lit) continue;
        const q = projectEnu(P, s.x, s.y, s.z);
        if (!q || q[0] < 0 || q[1] < 0 || q[0] > P.width || q[1] > P.height) continue;
        const w = this._textWidth(other.name, 700, 11.5) + 16;
        names.push({ kind: "name-dim", text: other.name, x: q[0], y: q[1], w, h: 20, offsets: [[0, -20], [w / 2 + 12, 0], [-w / 2 - 12, 0], [0, 20]] });
      }
      for (const l of placeLabels(names, { width: P.width, height: P.height, obstacles })) paintPill(ctx, l, this.font);
    }
    const entry = state.entry;
    if (entry) {
      // Out from under the HUD's panels: below one at the top, above one at the bottom.
      for (const b of hud) {
        if (entry.x < b.x0 - 18 || entry.x > b.x1 + 18 || entry.y < b.y0 - 18 || entry.y > b.y1 + 18) continue;
        entry.y = b.y0 < P.height / 2 ? b.y1 + 22 : b.y0 - 22;
      }
      const text = entry.in > 0 ? this._t("street.in", { countdown: this._countdown(entry.in) }) : this._passName();
      const width = this._textWidth(text, 700, 11.5);
      paintArrow(ctx, entry, { text, font: this.font, dim: !entry.visible && !entry.before, width, screen: P.width, pill: arrowPill(P, entry, width, obstacles) });
    }
  }

  // -- text --------------------------------------------------------------------

  _t(key, vars) {
    return this.formatter ? this.formatter.t(key, vars) : key;
  }

  _time(t) {
    return this.formatter ? this.formatter.time(t, { seconds: true }) : new Date(t * 1000).toISOString().slice(11, 19);
  }

  _mag(m) {
    return this.formatter ? this.formatter.magnitude(m) : (Math.round(m * 10) / 10).toFixed(1).replace("-", "−");
  }

  _countdown(seconds) {
    return this.formatter ? this.formatter.countdown(seconds * 1000) : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
  }

  _passName() {
    const p = this.pass;
    if (!p) return this.primary?.name ?? "";
    return this.formatter?.passTitle ? this.formatter.passTitle(p) : p.title ?? this.primary?.name ?? "";
  }

  _textWidth(text, weight, size) {
    const key = `${weight}|${size}|${text}`;
    let w = this._widths.get(key);
    if (w === undefined) {
      const ctx = this.overlayCanvas?.getContext("2d");
      if (ctx?.measureText) {
        ctx.save();
        ctx.font = `${weight} ${size}px ${this.font}`;
        w = ctx.measureText(text).width;
        ctx.restore();
      } else {
        w = text.length * size * 0.58;
      }
      if (this._widths.size > 500) this._widths.clear();
      this._widths.set(key, w);
    }
    return w;
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers

/** Stroke width of the visible path for a magnitude: about 4 px for −3, 2 px for 2.5. */
export function magnitudeWidth(mag) {
  return clamp(2.2 + 0.4 * (2.5 - (Number.isFinite(mag) ? mag : 2.5)), 1.8, 4.4);
}

/** Radius of the moving dot for a magnitude: 2 px at 3, about 6 px for the ISS at −3. */
export function dotRadius(mag) {
  return clamp(1.8 + 0.75 * (3 - (Number.isFinite(mag) ? mag : 3)), 1.8, 6.5);
}

function magAround(d, a, b) {
  let best = Infinity;
  for (let i = a; i <= b; i++) if (Number.isFinite(d.mag[i])) best = Math.min(best, d.mag[i]);
  return Number.isFinite(best) ? best : 2.5;
}

/**
 * The dot of a satellite: white-gold with a glow when visible, gold when only
 * sunlit, slate in shadow. Returns how far it reaches from its centre (px).
 */
function paintDot(ctx, x, y, s, { primary }) {
  const r = (s.lit ? dotRadius(s.magnitude) : 2) * (primary ? 1 : 0.75);
  if (!s.lit) {
    ctx.fillStyle = "rgba(148,163,184,0.55)";
    ctx.strokeStyle = "rgba(196,181,253,0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r + 1, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    return r + 1.5;
  }
  const strength = s.visible ? 1 : 0.45;
  const glow = r * (s.visible ? 5 : 3.5);
  const g = ctx.createRadialGradient(x, y, 0, x, y, glow);
  g.addColorStop(0, `rgba(255,251,235,${0.95 * strength})`);
  g.addColorStop(0.18, `rgba(${GOLD},${0.55 * strength})`);
  g.addColorStop(1, `rgba(${GOLD},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, glow, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = s.visible ? "#fffbeb" : `rgba(${GOLD_LIGHT},0.85)`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fill();
  return glow;
}

/** The fallback's ground as a path: along the skyline, closed below the bottom of the screen. */
function traceGround(ctx, P, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], P.height + 10);
  for (const p of pts) ctx.lineTo(p[0], p[1]);
  ctx.lineTo(pts[pts.length - 1][0], P.height + 10);
  ctx.closePath();
}

function paintTick(ctx, x, y, { hidden, lit, visible }) {
  ctx.save();
  if (hidden) {
    ctx.strokeStyle = `rgba(${GOLD_LIGHT},0.7)`;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, 2 * Math.PI);
    ctx.stroke();
  } else {
    ctx.fillStyle = lit ? (visible ? "#fde68a" : `rgba(${GOLD_LIGHT},0.7)`) : `rgba(${SHADOW},0.7)`;
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, lit ? 3 : 2.3, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fill();
  }
  ctx.restore();
}

function paintMarker(ctx, x, y, kind, { hidden }) {
  ctx.save();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = hidden ? `rgba(${GOLD_LIGHT},0.7)` : "#fde68a";
  ctx.fillStyle = "rgba(15,23,42,0.55)";
  if (hidden) ctx.setLineDash([2, 3]);
  if (kind === "brightest") {
    ctx.translate(x, y);
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? 3.4 : 8.5;
      const a = (k * Math.PI) / 5 - Math.PI / 2;
      ctx[k ? "lineTo" : "moveTo"](Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = hidden ? "rgba(252,211,77,0.35)" : "rgba(252,211,77,0.92)";
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    if (kind === "end") {
      // A bar across the ring: the path stops here.
      ctx.beginPath();
      ctx.moveTo(x - 3.2, y - 3.2);
      ctx.lineTo(x + 3.2, y + 3.2);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#fde68a";
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Text with a dark halo, legible on sky, buildings or imagery. */
function paintText(ctx, text, x, y, { size = 12, weight = 600, color = INK, align = "center", font = "system-ui, sans-serif" } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3.2;
  ctx.strokeStyle = HALO;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** A label pill: dark glass with gold text for the markers, gold for the name of a visible satellite. */
function paintPill(ctx, l, font) {
  const { cx, cy, w, h, text, kind } = l;
  ctx.save();
  const x = cx - w / 2;
  const y = cy - h / 2;
  const gold = kind === "name";
  ctx.beginPath();
  roundRect(ctx, x, y, w, h, h / 2);
  if (gold) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "#fde68a");
    g.addColorStop(1, "#f59e0b");
    ctx.fillStyle = g;
    ctx.shadowColor = "rgba(245,158,11,0.45)";
    ctx.shadowBlur = 10;
  } else {
    ctx.fillStyle = kind === "name-dim" ? "rgba(30,41,59,0.86)" : "rgba(15,23,42,0.8)";
  }
  ctx.fill();
  ctx.shadowBlur = 0;
  if (!gold) {
    ctx.strokeStyle = kind === "name-dim" ? "rgba(148,163,184,0.5)" : "rgba(252,211,77,0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.font = `${gold || kind === "name-dim" ? 700 : 600} 11.5px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let tx = cx;
  if (kind === "brightest") {
    // A small star before the magnitude.
    const sx = x + 10;
    ctx.fillStyle = "#fcd34d";
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? 2.2 : 5;
      const a = (k * Math.PI) / 5 - Math.PI / 2;
      ctx[k ? "lineTo" : "moveTo"](sx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.fill();
    tx += 6;
  }
  ctx.fillStyle = gold ? "#1c1404" : kind === "name-dim" ? "#e2e8f0" : "#fef3c7";
  ctx.fillText(text, tx, cy + 0.5);
  ctx.restore();
}

/** The off-screen arrow: a gold chevron in a dark disc at the edge, with the wait beside it. */
function paintArrow(ctx, entry, { text, font, dim, width, screen, pill = null }) {
  const { x, y, angle } = entry;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(15,23,42,0.82)";
  ctx.strokeStyle = dim ? "rgba(148,163,184,0.6)" : "rgba(252,211,77,0.75)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(0, 0, 15, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  ctx.rotate(angle);
  ctx.fillStyle = dim ? "#cbd5e1" : "#fcd34d";
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(-4, -6.5);
  ctx.lineTo(-1.5, 0);
  ctx.lineTo(-4, 6.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // The text goes on the inside of the arrow, unless arrowPill found a clearer place.
  const w = width + 16;
  const lx = pill?.cx ?? clamp(x - Math.cos(angle) * (w / 2 + 24), w / 2 + 4, screen - w / 2 - 4);
  const ly = pill?.cy ?? y - Math.sin(angle) * 26;
  paintPill(ctx, { cx: lx, cy: ly, w, h: 20, text, kind: dim ? "name-dim" : "marker" }, font);
}

/**
 * Where the edge arrow's label goes: inside the arrow, or beside that, clear of
 * the other labels and the HUD; null when none is clear (it then goes inside).
 */
export function arrowPill(P, { x, y, angle }, width, obstacles = []) {
  const w = width + 16;
  const inX = -Math.cos(angle) * (w / 2 + 24);
  const inY = -Math.sin(angle) * 26;
  // Across the arrow's direction, for the second choices.
  const px = -Math.sin(angle) * 26;
  const py = Math.cos(angle) * 26;
  const offsets = [[inX, inY], [inX + px, inY + py], [inX - px, inY - py], [inX * 1.8, inY * 1.8], [inX + 2 * px, inY + 2 * py], [inX - 2 * px, inY - 2 * py]];
  const [placed] = placeLabels([{ kind: "arrow", text: "", x, y, w, h: 20, offsets }], { width: P.width, height: P.height, inset: 4, obstacles });
  return placed ? { cx: placed.cx, cy: placed.cy } : null;
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Letter-spaced text, centred (canvas letterSpacing is not everywhere yet). */
function spaced(ctx, text, x, y, spacing) {
  if ("letterSpacing" in ctx) {
    ctx.letterSpacing = `${spacing}px`;
    ctx.fillText(text, x, y);
    ctx.letterSpacing = "0px";
    return;
  }
  ctx.fillText(text, x, y);
}

/** The path's direction on screen at time t (unit vector), for placing labels beside it. */
function tangentAt(pts, d, t) {
  const i = clamp(indexAt(d.t, t), 0, d.n - 1);
  for (let k = 1; k < 6; k++) {
    const a = pts[Math.max(0, i - k)];
    const b = pts[Math.min(d.n - 1, i + k)];
    if (a && b && (a[0] !== b[0] || a[1] !== b[1])) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    }
  }
  return [1, 0];
}

/**
 * Candidate offsets for a w × h label beside a point on a path running along
 * `tangent`: off to either side of the path first (above it first), then
 * along it.
 */
function around(w, h, gap, [tx, ty]) {
  // The normal that points up the screen goes first.
  let [nx, ny] = [-ty, tx];
  if (ny > 0) [nx, ny] = [-nx, -ny];
  const reach = (ux, uy) => Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2) + gap;
  const side = reach(nx, ny);
  const along = reach(tx, ty);
  return [
    [nx * side, ny * side],
    [-nx * side, -ny * side],
    [nx * side + tx * along * 0.8, ny * side + ty * along * 0.8],
    [nx * side - tx * along * 0.8, ny * side - ty * along * 0.8],
    [tx * along, ty * along],
    [-tx * along, -ty * along],
  ];
}

/** The HUD's edges as boxes labels must stay out of. */
function insetBoxes(P, { top = 0, right = 0, bottom = 0, left = 0 } = {}) {
  const out = [];
  if (top) out.push({ x0: 0, y0: 0, x1: P.width, y1: top });
  if (bottom) out.push({ x0: 0, y0: P.height - bottom, x1: P.width, y1: P.height });
  if (left) out.push({ x0: 0, y0: 0, x1: left, y1: P.height });
  if (right) out.push({ x0: P.width - right, y0: 0, x1: P.width, y1: P.height });
  return out;
}
