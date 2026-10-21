/**
 * Street photos for the street view: the 360° photo taken nearest home, from
 * Panoramax (open and keyless; the photos are under CC BY-SA and similar
 * licences) or, with their keys, Mapillary and Google Street View
 * (sat-photo-sources.js), turned to face true north, with its sky found so
 * that the planetarium shows through it, and darkened for the moment of the
 * pass. sat-photo-scene.js draws it.
 *
 * Pure functions, unit tested in node (node --test "tests/js/*.test.mjs"):
 *  - the search and the choice of photos near home, scored alike for every
 *    service (photoScore);
 *  - the photo's orientation: Panoramax gives the heading of the picture's
 *    centre (view:azimuth) and the camera's tilt (pers:pitch, pers:roll,
 *    when known), which level it as d_world = Rz(-heading) Rx(pitch)
 *    Ry(roll) d_photo, with the photo's x to the right, y forward, z up;
 *  - the sky: a flood from the smooth, bright top of the picture (the
 *    zenith) that stops at edges and texture, takes in soft-edged clouds
 *    and fills what the sky surrounds (wires, birds, the Sun), at about a
 *    third of a degree per pixel; the renderer refines the edges by colour;
 *  - what the photo hides of a path, and the look of the street at night.
 *
 * Equirectangular pictures: u = 0.5 + atan2(x, y) / 2π (the centre is the
 * heading, east of it to the right), v = 0.5 − asin(z) / π (the zenith at
 * the top).
 */

export const PANORAMAX_API = "https://api.panoramax.xyz/api";
/** Panoramax's own viewer, for a link to the picture. */
export const PANORAMAX_VIEWER = "https://api.panoramax.xyz/#focus=pic&pic=";
/** Farther from home than this (m), a photo does not show your street. */
export const PHOTO_MAX_M = 200;
/** The search reaches a little farther, for the rounding of the position. */
export const SEARCH_RADIUS_M = 250;
/** The pictures offered to choose from, at most (from each service). */
export const PICK_MAX = 12;
/** Pictures closer together than this (m) are the same spot: the picker skips them. */
const PICK_SPACING_M = 6;
/** The size the sky is looked for at (px; equirectangular 2:1). */
export const SKY_WIDTH = 1024;

const DEG = Math.PI / 180;
const EARTH_RADIUS = 6371008.8;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const wrap360 = (x) => ((x % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// Finding photos

/**
 * The search for 360° pictures around home. The position goes out rounded
 * to about 10 m; the server's 360° filter is Panoramax's meta-catalogue's
 * (photoSearch() asks again without it if it is refused).
 */
export function photoSearchUrl(latitude, longitude, { radius = SEARCH_RADIUS_M, limit = 100, only360 = true } = {}) {
  const params = new URLSearchParams({
    place_position: `${longitude.toFixed(4)},${latitude.toFixed(4)}`,
    place_distance: `0-${Math.round(radius)}`,
    limit: String(limit),
  });
  if (only360) params.set("filter", "field_of_view=360");
  return `${PANORAMAX_API}/search?${params}`;
}

/** Distance (m) and initial bearing (degrees) from one place to another. */
export function distanceBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const distance = 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { distance, bearing: wrap360(Math.atan2(y, x) / DEG) };
}

export const https = (href) => (typeof href === "string" && href.startsWith("https://") ? href : null);
const finiteOr = (x, fallback) => (Number.isFinite(x) ? x : fallback);

/**
 * How good a photo near home is, in metres (lower is better): its distance,
 * plus 12 m for every year it is older than three (streets change), its
 * position's uncertainty beyond 5 m, and 120 m with the Sun under 4° when it
 * was taken (400 m once it was down): a dark sky is not found.
 * `sunElevation(date, place)` (degrees) is optional, and so is everything
 * but the distance.
 */
export function photoScore({ distance, taken = null, latitude, longitude }, { nowS = Date.now() / 1000, accuracy = null, sunElevation = null } = {}) {
  let score = distance;
  if (Number.isFinite(taken)) score += 12 * Math.max(0, (nowS - taken) / (365.25 * 86400) - 3);
  if (Number.isFinite(accuracy)) score += Math.max(0, accuracy - 5);
  if (Number.isFinite(taken) && sunElevation) {
    const sun = sunElevation(taken * 1000, { latitude, longitude });
    if (Number.isFinite(sun) && sun < 4) score += sun < -2 ? 400 : 120;
  }
  return score;
}

/**
 * The best photos, spaced out: best first (then nearest), skipping any
 * within PICK_SPACING_M of one already picked from the same service, so the
 * picker steps between spots rather than through one car's every metre.
 */
export function spacedPhotos(photos, max = PICK_MAX) {
  const sorted = [...photos].sort((a, b) => a.score - b.score || a.distance - b.distance);
  const picked = [];
  for (const photo of sorted) {
    if (picked.length >= max) break;
    const near = (q) => q.source === photo.source && distanceBearing(q.latitude, q.longitude, photo.latitude, photo.longitude).distance < PICK_SPACING_M;
    if (picked.some(near)) continue;
    picked.push(photo);
  }
  return picked;
}

/**
 * The pictures of a Panoramax search (GeoJSON) that can stand in for the
 * street: equirectangular 360° pictures (2:1) within maxDistance of home,
 * best first (photoScore), spaced out (spacedPhotos).
 * @returns {object[]} {source: "panoramax", id, latitude, longitude, distance, bearing, heading, pitch, roll, taken, author, license, licenseUrl, sd, hd, width, page, score}
 */
export function photoCandidates(collection, { latitude, longitude, maxDistance = PHOTO_MAX_M, nowS = Date.now() / 1000, sunElevation = null, max = PICK_MAX } = {}) {
  const found = [];
  for (const f of collection?.features ?? []) {
    const p = f?.properties ?? {};
    const io = p["pers:interior_orientation"] ?? {};
    if (io.field_of_view !== 360) continue;
    const dims = io.sensor_array_dimensions;
    if (Array.isArray(dims) && dims.length === 2 && Math.abs(dims[0] / dims[1] - 2) > 0.01) continue;
    if (p["geovisio:status"] && p["geovisio:status"] !== "ready") continue;
    if (p["geovisio:visibility"] && p["geovisio:visibility"] !== "anyone") continue;
    const [lon, lat] = f.geometry?.coordinates ?? [];
    const sd = https(f.assets?.sd?.href);
    const hd = https(f.assets?.hd?.href);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !(sd || hd) || typeof f.id !== "string") continue;
    const { distance, bearing } = distanceBearing(latitude, longitude, lat, lon);
    if (distance > maxDistance) continue;
    const takenMs = Date.parse(p.datetime ?? "");
    const taken = Number.isFinite(takenMs) ? takenMs / 1000 : null;
    const licenseLink = (f.links ?? []).find((l) => l?.rel === "license");
    const photo = {
      source: "panoramax",
      id: f.id,
      latitude: lat,
      longitude: lon,
      distance,
      bearing,
      heading: wrap360(finiteOr(p["view:azimuth"], 0)),
      pitch: clamp(finiteOr(p["pers:pitch"], 0), -45, 45),
      roll: clamp(finiteOr(p["pers:roll"], 0), -45, 45),
      taken,
      author: typeof p["geovisio:producer"] === "string" ? p["geovisio:producer"] : "",
      license: typeof p.license === "string" ? p.license : "",
      licenseUrl: https(licenseLink?.href),
      sd: sd ?? hd,
      hd: hd ?? sd,
      // The large picture's width, when Panoramax says (the scene decodes it no larger than it draws).
      width: Array.isArray(dims) && Number.isFinite(dims[0]) ? dims[0] : null,
      page: `${PANORAMAX_VIEWER}${encodeURIComponent(f.id)}`,
    };
    photo.score = photoScore(photo, { nowS, accuracy: p["quality:horizontal_accuracy"], sunElevation });
    found.push(photo);
  }
  return spacedPhotos(found, max);
}

/** How long the search may take before the street view gives up on photos (ms). */
export const SEARCH_TIMEOUT_MS = 8000;

/**
 * Ask Panoramax for the pictures near a place: photoCandidates() of the
 * answer. No cookies and no referrer go with it. Rejects when Panoramax
 * cannot be reached, answers with an error, or takes too long.
 */
export async function findPhotos({ latitude, longitude }, { signal = null, fetch: fetchImpl = (url, init) => globalThis.fetch(url, init), sunElevation = null, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const abort = globalThis.AbortController ? new AbortController() : null;
  const stop = () => abort?.abort();
  signal?.addEventListener?.("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    const get = (url) => fetchImpl(url, { signal: abort?.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    let response = await get(photoSearchUrl(latitude, longitude));
    // A server without the meta-catalogue's 360° filter: every picture, sorted out here.
    if (response.status === 400) response = await get(photoSearchUrl(latitude, longitude, { only360: false }));
    if (!response.ok) throw new Error(`Panoramax answered ${response.status}`);
    return photoCandidates(await response.json(), { latitude, longitude, sunElevation });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", stop);
  }
}

// ---------------------------------------------------------------------------
// Orientation

/**
 * The rotation (row-major 3×3) from the photo's directions (x right, y
 * forward, z up) to the world's (east, north, up): heading clockwise from
 * north, pitch nose up, roll right side down, as Panoramax gives them.
 */
export function photoRotation({ heading = 0, pitch = 0, roll = 0 } = {}) {
  const [ch, sh] = [Math.cos(-heading * DEG), Math.sin(-heading * DEG)];
  const [cp, sp] = [Math.cos(pitch * DEG), Math.sin(pitch * DEG)];
  const [cr, sr] = [Math.cos(roll * DEG), Math.sin(roll * DEG)];
  const Rz = [ch, -sh, 0, sh, ch, 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const Ry = [cr, 0, sr, 0, 1, 0, -sr, 0, cr];
  return multiply3(multiply3(Rz, Rx), Ry);
}

/** The heading, pitch and roll (as photoRotation takes them) of a photo-to-world rotation. */
export function photoOrientation(R) {
  return {
    heading: wrap360(Math.atan2(R[1], R[4]) / DEG),
    pitch: Math.asin(clamp(R[7], -1, 1)) / DEG,
    roll: Math.atan2(-R[6], R[8]) / DEG,
  };
}

export function multiply3(a, b) {
  const out = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[3 * i + j] += a[3 * i + k] * b[3 * k + j];
  return out;
}

export function transpose3(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Where a direction of the sky (azimuth, elevation) is in the picture: [u, v] in 0..1. */
export function photoUV(R, azimuth, elevation) {
  const ce = Math.cos(elevation * DEG);
  const e = Math.sin(azimuth * DEG) * ce;
  const n = Math.cos(azimuth * DEG) * ce;
  const u = Math.sin(elevation * DEG);
  // The photo's own direction: Rᵀ · world.
  const x = R[0] * e + R[3] * n + R[6] * u;
  const y = R[1] * e + R[4] * n + R[7] * u;
  const z = R[2] * e + R[5] * n + R[8] * u;
  return [wrapUnit(0.5 + Math.atan2(x, y) / (2 * Math.PI)), 0.5 - Math.asin(clamp(z, -1, 1)) / Math.PI];
}

/** The direction of the sky (azimuth, elevation) at a point [u, v] of the picture. */
export function photoDirection(R, u, v) {
  const lon = (u - 0.5) * 2 * Math.PI;
  const lat = (0.5 - v) * Math.PI;
  const x = Math.cos(lat) * Math.sin(lon);
  const y = Math.cos(lat) * Math.cos(lon);
  const z = Math.sin(lat);
  const e = R[0] * x + R[1] * y + R[2] * z;
  const n = R[3] * x + R[4] * y + R[5] * z;
  const up = R[6] * x + R[7] * y + R[8] * z;
  return { azimuth: wrap360(Math.atan2(e, n) / DEG), elevation: Math.asin(clamp(up, -1, 1)) / DEG };
}

const wrapUnit = (u) => u - Math.floor(u);

/** The world elevation (degrees) of every pixel of a width × height picture. */
export function pixelElevations(R, width, height) {
  const out = new Float32Array(width * height);
  const sinLon = new Float32Array(width);
  const cosLon = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const lon = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
    sinLon[x] = Math.sin(lon);
    cosLon[x] = Math.cos(lon);
  }
  for (let y = 0; y < height; y++) {
    const lat = (0.5 - (y + 0.5) / height) * Math.PI;
    const cl = Math.cos(lat);
    const zl = Math.sin(lat) * R[8];
    for (let x = 0; x < width; x++) {
      const up = R[6] * cl * sinLon[x] + R[7] * cl * cosLon[x] + zl;
      out[y * width + x] = Math.asin(clamp(up, -1, 1)) / DEG;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The sky

/** 1-2-1 blur both ways (x wraps round the panorama, y stops at the poles). */
function blur121(src, W, H) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      tmp[row + x] = (src[row + (x === 0 ? W - 1 : x - 1)] + 2 * src[row + x] + src[row + (x === W - 1 ? 0 : x + 1)]) / 4;
    }
  }
  for (let y = 0; y < H; y++) {
    const up = (y === 0 ? 0 : y - 1) * W;
    const down = (y === H - 1 ? H - 1 : y + 1) * W;
    for (let x = 0; x < W; x++) out[y * W + x] = (tmp[up + x] + 2 * tmp[y * W + x] + tmp[down + x]) / 4;
  }
  return out;
}

/** Mean over a (2k + 1)² box, by running sums (x wraps, y clamps). */
export function boxMean(src, W, H, k) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = 2 * k + 1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let s = 0;
    for (let d = -k; d <= k; d++) s += src[row + ((d % W) + W) % W];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = s / n;
      s += src[row + ((x + k + 1) % W)] - src[row + (((x - k) % W) + W) % W];
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let d = -k; d <= k; d++) s += tmp[clamp(d, 0, H - 1) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = s / n;
      s += tmp[Math.min(H - 1, y + k + 1) * W + x] - tmp[Math.max(0, y - k) * W + x];
    }
  }
  return out;
}

/** The four neighbours of pixel p (x wraps; -1 off the top or bottom). */
function neighbours(p, W, H, out) {
  const y = (p / W) | 0;
  const x = p - y * W;
  out[0] = y * W + (x === 0 ? W - 1 : x - 1);
  out[1] = y * W + (x === W - 1 ? 0 : x + 1);
  out[2] = y > 0 ? p - W : -1;
  out[3] = y < H - 1 ? p + W : -1;
  return out;
}

/** 4-connected components of the pixels where pred(i): {label (−1 elsewhere), sizes}. */
function components(N, W, H, pred) {
  const label = new Int32Array(N).fill(-1);
  const sizes = [];
  const stack = new Int32Array(N);
  const ns = new Int32Array(4);
  for (let s = 0; s < N; s++) {
    if (label[s] !== -1 || !pred(s)) continue;
    const id = sizes.length;
    let top = 0;
    let size = 0;
    stack[top++] = s;
    label[s] = id;
    while (top) {
      const p = stack[--top];
      size++;
      for (const n of neighbours(p, W, H, ns)) {
        if (n < 0 || label[n] !== -1 || !pred(n)) continue;
        label[n] = id;
        stack[top++] = n;
      }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

const SKY_DEFAULTS = Object.freeze({
  // Seeds: as smooth as open sky, brighter than 60 % of the brightest part up high.
  seedGradient: 0.02,
  seedAbove: 35,
  zenithAbove: 72,
  // A big smooth patch lower down counts if it is about as bright as the sky overhead.
  bigSeed: 0.004,
  bigBright: 0.85,
  // The flood: no edge, no texture, no step in colour, not much darker than the sky at that height.
  gradient: 0.045,
  texture: 0.028,
  step: 0.06,
  bright: 0.75,
  // Nothing below this is sky (degrees: the horizon, with a little for a tilted camera).
  horizon: -2,
  // Back to the edge the flood stopped short of: px deep, a step's colour and the drift from the sky (0..1).
  grow: 12,
  growStep: 0.05,
  growDrift: 0.12,
  // Over twigs and wires: px across at most, and how close in colour the sky beyond must be (0..1).
  leap: 4,
  leapColour: 0.08,
  leapPasses: 4,
  // Clouds: brighter than the sky about them, pale, with softer edges.
  cloudBright: 0.92,
  cloudSaturation: 0.22,
  cloudGradient: 0.09,
  cloudTexture: 0.06,
  // Holes the sky surrounds: filled when bright (clouds, the Sun) or tiny (wires, birds).
  holeBright: 0.9,
  holeSmall: 0.0004,
});

/**
 * Find the sky in a picture (RGBA, equirectangular, about SKY_WIDTH wide):
 * Uint8Array(width × height), 1 where it is sky. `R` is photoRotation()'s.
 * Returns {width, height, sky, fraction, colour (the sky's mean RGB by
 * elevation, 0..1, from +90° in 2° bins)}; fraction 0 when no sky was found
 * (under a roof, in a tunnel, at night).
 */
export function findSky(image, R, options = {}) {
  const o = { ...SKY_DEFAULTS, ...options };
  const { width: W, height: H, data } = image;
  const N = W * H;
  const elev = pixelElevations(R, W, H);
  let r = new Float32Array(N);
  let g = new Float32Array(N);
  let b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    r[i] = data[4 * i] / 255;
    g[i] = data[4 * i + 1] / 255;
    b[i] = data[4 * i + 2] / 255;
  }
  r = blur121(r, W, H);
  g = blur121(g, W, H);
  b = blur121(b, W, H);
  // The colour gradient: the largest channel's Sobel magnitude, per pixel step.
  const grad = new Float32Array(N);
  const channels = [r, g, b];
  for (let y = 0; y < H; y++) {
    const up = (y === 0 ? 0 : y - 1) * W;
    const row = y * W;
    const down = (y === H - 1 ? H - 1 : y + 1) * W;
    for (let x = 0; x < W; x++) {
      const xl = x === 0 ? W - 1 : x - 1;
      const xr = x === W - 1 ? 0 : x + 1;
      let best = 0;
      for (const c of channels) {
        const gx = (c[up + xr] + 2 * c[row + xr] + c[down + xr] - c[up + xl] - 2 * c[row + xl] - c[down + xl]) / 8;
        const gy = (c[down + xl] + 2 * c[down + x] + c[down + xr] - c[up + xl] - 2 * c[up + x] - c[up + xr]) / 8;
        const m = gx * gx + gy * gy;
        if (m > best) best = m;
      }
      grad[row + x] = Math.sqrt(best);
    }
  }
  const tex = boxMean(grad, W, H, 3);
  const V = new Float32Array(N);
  for (let i = 0; i < N; i++) V[i] = Math.max(r[i], g[i], b[i]);
  const sky = new Uint8Array(N);
  const BIN = 2;
  const bins = Math.ceil(180 / BIN);
  const binOf = (i) => clamp(Math.floor((90 - elev[i]) / BIN), 0, bins - 1);

  // Seeds: smooth bright pixels high up, in groups that reach the zenith (or are big and as bright).
  const high = [];
  for (let i = 0; i < N; i++) if (elev[i] > o.seedAbove) high.push(V[i]);
  if (high.length < 0.01 * N) return emptySky(W, H);
  high.sort((x, y) => x - y);
  const vSeed = Math.max(0.3, 0.6 * high[Math.floor(high.length * 0.9)]);
  const groups = components(N, W, H, (i) => elev[i] > o.seedAbove && grad[i] < o.seedGradient && tex[i] < o.texture && V[i] > vSeed);
  const keep = new Uint8Array(groups.sizes.length);
  const sumV = new Float64Array(groups.sizes.length);
  for (let i = 0; i < N; i++) {
    const id = groups.label[i];
    if (id < 0) continue;
    sumV[id] += V[i];
    if (elev[i] > o.zenithAbove) keep[id] = 1;
  }
  let zv = 0;
  let zn = 0;
  groups.sizes.forEach((s, id) => {
    if (keep[id]) {
      zv += sumV[id];
      zn += s;
    }
  });
  const vZenith = zn > 0.002 * N ? zv / zn : 0;
  groups.sizes.forEach((s, id) => {
    if (!keep[id] && s > o.bigSeed * N && sumV[id] / s >= o.bigBright * vZenith) keep[id] = 1;
  });
  const queue = new Int32Array(N);
  let qt = 0;
  for (let i = 0; i < N; i++) {
    const id = groups.label[i];
    if (id >= 0 && keep[id]) {
      sky[i] = 1;
      queue[qt++] = i;
    }
  }
  if (qt < 0.002 * N) return emptySky(W, H);

  // The sky's brightness by elevation, from the seeds; lower down, the lowest known.
  const vals = Array.from({ length: bins }, () => []);
  for (let k = 0; k < qt; k++) vals[binOf(queue[k])].push(V[queue[k]]);
  const vref = new Float32Array(bins);
  let last = vSeed;
  for (let k = 0; k < bins; k++) {
    const v = vals[k];
    if (v.length > 20) {
      v.sort((x, y) => x - y);
      last = v[Math.floor(v.length / 2)];
    }
    vref[k] = last;
  }
  const ns = new Int32Array(4);
  const flood = (qh, accept) => {
    while (qh < qt) {
      const p = queue[qh++];
      for (const n of neighbours(p, W, H, ns)) {
        if (n < 0 || sky[n] || elev[n] < o.horizon || !accept(n, p)) continue;
        sky[n] = 1;
        queue[qt++] = n;
      }
    }
  };
  const lit = (n) => V[n] >= o.bright * vref[binOf(n)];
  const strict = (n, p) => {
    if (grad[n] > o.gradient || tex[n] > o.texture || !lit(n)) return false;
    const dr = r[n] - r[p];
    const dg = g[n] - g[p];
    const db = b[n] - b[p];
    return dr * dr + dg * dg + db * db <= o.step * o.step;
  };
  flood(0, strict);
  growToEdges(sky, data, elev, lit, W, H, o);
  // Sky seen through twigs and between wires: the flood stops at every one
  // of them, so it steps over thin ones onto sky of the same colour (even
  // among twigs, where the texture is everywhere), a few times over.
  for (let pass = 0; pass < o.leapPasses; pass++) {
    qt = 0;
    const leap2 = (o.leapColour * 255) ** 2;
    for (let i = 0; i < N; i++) {
      if (sky[i] || elev[i] < o.horizon || grad[i] > o.gradient || !lit(i)) continue;
      const y = (i / W) | 0;
      const x = i - y * W;
      let from = -1;
      for (let k = 2; k <= o.leap && from < 0; k++) {
        for (const j of [y * W + ((x + k) % W), y * W + ((x - k + W) % W), y >= k ? i - k * W : -1, y + k < H ? i + k * W : -1]) {
          if (j >= 0 && sky[j]) {
            from = j;
            break;
          }
        }
      }
      if (from < 0) continue;
      const dr = data[4 * i] - data[4 * from];
      const dg = data[4 * i + 1] - data[4 * from + 1];
      const db = data[4 * i + 2] - data[4 * from + 2];
      if (dr * dr + dg * dg + db * db <= leap2) queue[qt++] = i;
    }
    if (!qt) break;
    for (let k = 0; k < qt; k++) sky[queue[k]] = 1;
    flood(0, strict);
    growToEdges(sky, data, elev, lit, W, H, o);
  }
  // Clouds, from all the sky found so far.
  qt = 0;
  for (let i = 0; i < N; i++) if (sky[i]) queue[qt++] = i;
  flood(0, (n) => {
    if (V[n] < o.cloudBright * vref[binOf(n)] || grad[n] > o.cloudGradient || tex[n] > o.cloudTexture) return false;
    const mn = Math.min(r[n], g[n], b[n]);
    return (V[n] - mn) / Math.max(V[n], 1e-3) < o.cloudSaturation;
  });
  // Holes above the horizon that the sky surrounds.
  const holes = components(N, W, H, (i) => !sky[i] && elev[i] >= o.horizon);
  const touches = new Uint8Array(holes.sizes.length);
  const brightness = new Float64Array(holes.sizes.length);
  for (let i = 0; i < N; i++) {
    const id = holes.label[i];
    if (id < 0) continue;
    brightness[id] += V[i] / Math.max(vref[binOf(i)], 1e-3);
    // Next to the ground: it stands on it, so it is not a hole in the sky.
    if (elev[i] < o.horizon + 1.5) touches[id] = 1;
  }
  for (let i = 0; i < N; i++) {
    const id = holes.label[i];
    if (id < 0 || touches[id]) continue;
    const size = holes.sizes[id];
    if (size < o.holeSmall * N || brightness[id] / size >= o.holeBright) sky[i] = 1;
  }
  // The sky's colour by elevation, for the renderer's edges (and the sky's tests).
  const sums = Array.from({ length: bins }, () => [0, 0, 0, 0]);
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (!sky[i]) continue;
    count++;
    const s = sums[binOf(i)];
    s[0] += data[4 * i];
    s[1] += data[4 * i + 1];
    s[2] += data[4 * i + 2];
    s[3]++;
  }
  const colour = [];
  let known = [0.6, 0.7, 0.85];
  for (let k = 0; k < bins; k++) {
    const s = sums[k];
    if (s[3] > 10) known = [s[0] / s[3] / 255, s[1] / s[3] / 255, s[2] / s[3] / 255];
    colour.push(known);
  }
  return { width: W, height: H, sky, fraction: count / N, colour };
}

/**
 * The flood stops a few pixels short of an edge, as the gradient and the
 * texture it looks at spread out from the edge: grow the sky back up to it,
 * a pixel at a time and at most `grow` deep, while the picture's own
 * colours step no more than `growStep` from pixel to pixel and stay within
 * `growDrift` of the sky the growth started from, and not much darker than
 * the sky at that height (`lit`: else a pale wall next to a white sky draws
 * it on into the building).
 */
function growToEdges(sky, data, elev, lit, W, H, o) {
  const N = W * H;
  const depth = new Uint8Array(N);
  const origin = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  let qh = 0;
  let qt = 0;
  const ns = new Int32Array(4);
  for (let i = 0; i < N; i++) {
    if (!sky[i]) continue;
    for (const n of neighbours(i, W, H, ns)) {
      if (n >= 0 && !sky[n]) {
        origin[i] = i;
        queue[qt++] = i;
        break;
      }
    }
  }
  const step2 = (o.growStep * 255) ** 2;
  const drift2 = (o.growDrift * 255) ** 2;
  const d2 = (a, c) => {
    const dr = data[4 * a] - data[4 * c];
    const dg = data[4 * a + 1] - data[4 * c + 1];
    const db = data[4 * a + 2] - data[4 * c + 2];
    return dr * dr + dg * dg + db * db;
  };
  while (qh < qt) {
    const p = queue[qh++];
    if (depth[p] >= o.grow) continue;
    for (const n of neighbours(p, W, H, ns)) {
      if (n < 0 || sky[n] || elev[n] < o.horizon || !lit(n)) continue;
      if (d2(n, p) > step2 || d2(n, origin[p]) > drift2) continue;
      sky[n] = 1;
      depth[n] = depth[p] + 1;
      origin[n] = origin[p];
      queue[qt++] = n;
    }
  }
}

function emptySky(W, H) {
  return { width: W, height: H, sky: new Uint8Array(W * H), fraction: 0, colour: [] };
}

/**
 * The renderer's textures for a sky (findSky) over its picture:
 *  - mask (RGBA, the picture's size): R the sky, softened; G where the
 *    renderer decides by colour (a band along the sky's edge, `out` px into
 *    what is not sky and `inside` px into the sky: the flood stops a pixel
 *    or two short of a sharp edge);
 *  - skyColour and otherColour (RGBA, a quarter of the size each way): the
 *    colour of the sky and of what is not sky nearby, for the renderer to
 *    tell an edge pixel's share of each (as two-colour matting does).
 */
export function skyTextures(image, found, { out = 4, inside = 2, scale = 4 } = {}) {
  const { width: W, height: H, sky } = found;
  const N = W * H;
  const src = new Float32Array(N);
  for (let i = 0; i < N; i++) src[i] = sky[i];
  const soft = blur121(blur121(src, W, H), W, H);
  // Distance from the edge, in px (city-block, both ways): a band either side.
  const toSky = distanceTo(sky, 1, W, H, out + 1);
  const toGround = distanceTo(sky, 0, W, H, inside + 1);
  const mask = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const band = sky[i] ? toGround[i] <= inside : toSky[i] <= out;
    mask[4 * i] = Math.round(soft[i] * 255);
    mask[4 * i + 1] = band ? 255 : 0;
    mask[4 * i + 3] = 255;
  }
  const w = Math.max(1, Math.floor(W / scale));
  const h = Math.max(1, Math.floor(H / scale));
  const cells = (want) => {
    const sum = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
    const weight = new Float32Array(w * h);
    for (let y = 0; y < H; y++) {
      const cy = Math.min(h - 1, Math.floor(y / scale));
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (sky[i] !== want) continue;
        const c = cy * w + Math.min(w - 1, Math.floor(x / scale));
        sum[0][c] += image.data[4 * i];
        sum[1][c] += image.data[4 * i + 1];
        sum[2][c] += image.data[4 * i + 2];
        weight[c]++;
      }
    }
    const k = 2;
    const wt = boxMean(weight, w, h, k);
    return { mean: sum.map((s) => boxMean(s, w, h, k)), wt };
  };
  const pack = ({ mean, wt }, fallback) => {
    const outRGBA = new Uint8Array(w * h * 4);
    for (let c = 0; c < w * h; c++) {
      const y = Math.floor(c / w);
      const f = fallback(y);
      for (let ch = 0; ch < 3; ch++) outRGBA[4 * c + ch] = wt[c] > 0.02 ? Math.round(mean[ch][c] / wt[c]) : Math.round(f[ch] * 255);
      outRGBA[4 * c + 3] = 255;
    }
    return outRGBA;
  };
  // Where no sky is near, the sky's colour at that height; where nothing else is, black.
  const bins = found.colour?.length ?? 0;
  const skyAt = (cy) => {
    if (!bins) return [0.6, 0.7, 0.85];
    const el = 90 - (180 * (cy + 0.5)) / h;
    return found.colour[clamp(Math.floor((90 - el) / 2), 0, bins - 1)];
  };
  return {
    width: W,
    height: H,
    mask,
    lowWidth: w,
    lowHeight: h,
    skyColour: pack(cells(1), skyAt),
    otherColour: pack(cells(0), () => [0, 0, 0]),
  };
}

/** City-block distance (px, up to `limit`) from each pixel to the nearest one whose sky value is `value`. */
function distanceTo(sky, value, W, H, limit) {
  const N = W * H;
  const d = new Uint8Array(N).fill(limit);
  const queue = new Int32Array(N);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < N; i++) {
    if (sky[i] === value) {
      d[i] = 0;
      queue[qt++] = i;
    }
  }
  const ns = new Int32Array(4);
  while (qh < qt) {
    const p = queue[qh++];
    if (d[p] + 1 >= limit) continue;
    for (const n of neighbours(p, W, H, ns)) {
      if (n < 0 || d[n] <= d[p] + 1) continue;
      d[n] = d[p] + 1;
      queue[qt++] = n;
    }
  }
  return d;
}

/**
 * Where the Sun shows in a picture, if it does, near where it was when the
 * photo was taken (`predicted`: {azimuth, elevation}): the centre of the
 * round white patch its glare burns out in the sky (findSky's: a sunlit
 * white wall burns out too, but is not sky). Only the largest such patch
 * counts, and only when it is big enough to be glare, not so big that the
 * whole sky is burnt out (an overcast day), without a rival of its size,
 * and within `tolerance` degrees of the predicted elevation (which also says
 * the photo's time is right; glare sits a little low). Panoramax's headings
 * are often 10° to 30° off (a car's course is not where its camera faces);
 * the Sun says by how much. Returns {azimuth, elevation, pixels} or null.
 */
export function findSun(image, R, predicted, found, { tolerance = 4.5, minRadius = 2, maxRadius = 12, white = 245 } = {}) {
  if (!predicted || !found?.sky || !(predicted.elevation > 8 && predicted.elevation < 65)) return null;
  const { width: W, height: H, data } = image;
  const N = W * H;
  const elev = pixelElevations(R, W, H);
  const lit = (i) => found.sky[i] === 1 && elev[i] > 1 && data[4 * i] >= white && data[4 * i + 1] >= white && data[4 * i + 2] >= white;
  const { label, sizes } = components(N, W, H, lit);
  // Wider than this is a burnt-out cloud or a white sky, smaller a white speck: not the Sun's glare.
  const degPerPx = 360 / W;
  const maxPixels = Math.PI * (maxRadius / degPerPx) ** 2;
  const minPixels = Math.PI * (minRadius / degPerPx) ** 2;
  const order = sizes.map((n, id) => id).sort((a, b) => sizes[b] - sizes[a]);
  const [first, second] = order;
  if (first === undefined || sizes[first] > maxPixels || sizes[first] < minPixels) return null;
  if (second !== undefined && sizes[second] > 0.5 * sizes[first]) return null;
  const s = { sx: 0, sy: 0, x0: -1, n: 0, xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity };
  for (let i = 0; i < N; i++) {
    if (label[i] !== first) continue;
    const y = (i / W) | 0;
    let x = i - y * W;
    // Across the picture's seam, positions are taken near the patch's first pixel.
    if (s.x0 < 0) s.x0 = x;
    else if (x - s.x0 > W / 2) x -= W;
    else if (s.x0 - x > W / 2) x += W;
    s.sx += x;
    s.sy += y;
    s.n++;
    s.xmin = Math.min(s.xmin, x);
    s.xmax = Math.max(s.xmax, x);
    s.ymin = Math.min(s.ymin, y);
    s.ymax = Math.max(s.ymax, y);
  }
  const v = (s.sy / s.n + 0.5) / H;
  const seen = photoDirection(R, wrapUnit((s.sx / s.n + 0.5) / W), v);
  if (Math.abs(seen.elevation - predicted.elevation) > tolerance) return null;
  // Round, as glare is (in degrees across: the picture's rows shrink towards the zenith).
  const wide = (s.xmax - s.xmin + 1) * Math.cos(Math.min(85, Math.abs(90 - v * 180)) * DEG);
  const tall = s.ymax - s.ymin + 1;
  if (Math.max(wide, tall) > 2.5 * Math.min(wide, tall) + 2) return null;
  // Filled, not a ring or a streak.
  if (s.n < 0.45 * (s.xmax - s.xmin + 1) * tall) return null;
  return { ...seen, pixels: s.n };
}

/**
 * The heading of a photo turned to match the Sun in it (findSun), or as
 * Panoramax gives it when the Sun does not show.
 */
export function sunHeading(photo, image, found, predicted) {
  const R = photoRotation(photo);
  const sun = findSun(image, R, predicted, found);
  if (!sun) return { heading: photo.heading, turned: 0 };
  const turned = ((predicted.azimuth - sun.azimuth + 540) % 360) - 180;
  return { heading: wrap360(photo.heading + turned), turned };
}

/** Whether the photo shows sky in a direction (azimuth, elevation). */
export function photoShowsSky(found, R, azimuth, elevation) {
  if (!found?.sky) return true;
  const [u, v] = photoUV(R, azimuth, elevation);
  const x = Math.min(found.width - 1, Math.floor(u * found.width));
  const y = clamp(Math.floor(v * found.height), 0, found.height - 1);
  return found.sky[y * found.width + x] === 1;
}

/**
 * Which samples of a path (trackFromRows data: t, az, el, n) the photo
 * hides: Map(t -> hidden), for those above the horizon (as hiddenByTerrain).
 */
export function hiddenByPhoto(found, R, data) {
  const out = new Map();
  if (!found?.sky || !found.fraction) return out;
  for (let i = 0; i < data.n; i++) {
    if (data.el[i] < 0) continue;
    out.set(data.t[i], !photoShowsSky(found, R, data.az[i], data.el[i]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The look

/**
 * The photo darkened for a Sun ({elevation}) and Moon ({elevation,
 * fraction}): an exposure in linear light, how far colours fade (the eye
 * sees no colour by moonlight), and a cool tint. A moonless night keeps the
 * street just readable, as Darpinian's night filter does; the ground near
 * the camera (the car or bike it was on) fades into the dark below the
 * horizon.
 */
export function photoLook(sun, moon = null) {
  const day = smooth(-9, 3, sun.elevation);
  const twilight = smooth(-16, -2, sun.elevation);
  const moonLight = moon && moon.elevation > 0 ? (moon.fraction ?? 0) * smooth(0, 20, moon.elevation) : 0;
  const q = (v, step) => Math.round(v / step) * step;
  const night = 0.055 + 0.07 * moonLight + 0.16 * twilight;
  const look = {
    exposure: +q(night + (1 - night) * day ** 1.6, 0.002).toFixed(3),
    desaturate: +q(0.82 * (1 - day), 0.01).toFixed(2),
    tint: [0.78, 0.88, 1.16].map((c) => +q(c + (1 - c) * day, 0.01).toFixed(2)),
    // Where the night ground fades in below the horizon (degrees), and its colour (linear).
    groundFrom: -14,
    groundTo: -32,
    ground: [0.006, 0.008, 0.012].map((c) => +(c + (0.12 - c) * day).toFixed(4)),
  };
  look.key = JSON.stringify(look);
  return look;
}

/** The credit line's parts: who took it, under which licence, and links. */
export function photoCredit(photo) {
  return {
    author: photo?.author || "",
    license: photo?.license || "",
    licenseUrl: photo?.licenseUrl || null,
    page: photo?.page || null,
  };
}
