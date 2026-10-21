/**
 * Terrain from the open AWS Terrarium elevation tiles, without WebGL: the
 * height of the ground under the observer (where the street view puts its
 * eye) and the skyline around them, which is the ground of the no-WebGL
 * fallback and says when hills hide part of a pass.
 *
 * The decoding and the geometry are pure and unit tested in node
 * (node --test "tests/js/*.test.mjs"); only loadTerrariumTile touches the
 * network and an image decoder.
 */

export const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const TERRAIN_ATTRIBUTION =
  'Terrain: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen Terrain Tiles</a> on AWS Open Data (USGS 3DEP, SRTM, GMTED2010, EU-DEM, ETOPO1 and others)';

const DEG = Math.PI / 180;
/** Mean Earth radius (m), as MapLibre's. */
const EARTH_RADIUS = 6371008.8;
/** Standard terrestrial refraction: light bends with 0.13 of the Earth's curvature. */
const REFRACTION_K = 0.13;
/** Tile edge in pixels. */
const SIZE = 256;

/** Height (m) of a Terrarium pixel: (R × 256 + G + B / 256) − 32768. */
export function terrariumHeight(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/** A tile's RGBA pixels as heights (m), row by row from the top left. */
export function decodeTerrarium(rgba) {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = terrariumHeight(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  return out;
}

/** Web Mercator tile coordinates (fractional) of a place at zoom z. */
export function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(lat * DEG) + 1 / Math.cos(lat * DEG)) / Math.PI) / 2) * n;
  return [x, y];
}

export function tileUrl(z, x, y) {
  return TERRARIUM.replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

/**
 * Clamp four neighbouring heights to their median ± limit before they are
 * interpolated: low-zoom Terrarium tiles carry single-pixel spikes (+780 m 7
 * km east of Boulder at z10) that would otherwise stand up as phantom peaks.
 */
export function despike(a, b, c, d, limit = 60) {
  const s = [a, b, c, d].sort((x, y) => x - y);
  const med = (s[1] + s[2]) / 2;
  const cl = (x) => Math.max(med - limit, Math.min(med + limit, x));
  return [cl(a), cl(b), cl(c), cl(d)];
}

/**
 * Bilinear height at a fractional pixel position, the values sitting at pixel
 * centres as in MapLibre's DEMData.sampleBilinear. `at(i, j)` reads a pixel;
 * NaN where there is no data.
 */
export function bilinear(at, px, py, { limit = null } = {}) {
  const x = px - 0.5;
  const y = py - 0.5;
  const i = Math.floor(x);
  const j = Math.floor(y);
  const u = x - i;
  const v = y - j;
  let [a, b, c, d] = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)];
  if (limit !== null && [a, b, c, d].every(Number.isFinite)) [a, b, c, d] = despike(a, b, c, d, limit);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * One Terrarium tile as heights, through the browser's image decoder. A
 * software canvas: the pixels are read back once, which would stall a GPU one.
 */
export async function loadTerrariumTile(z, x, y, { signal } = {}) {
  const res = await fetch(tileUrl(z, x, y), { signal, mode: "cors" });
  if (!res.ok) throw new Error(`terrain tile ${z}/${x}/${y}: HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const canvas = globalThis.OffscreenCanvas ? new OffscreenCanvas(bitmap.width, bitmap.height) : document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    return decodeTerrarium(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data);
  } finally {
    bitmap.close?.();
  }
}

/**
 * Height of the ground (m) at a place from the zoom-15 Terrarium tile under
 * it (about 3.5 m per pixel at 42° N): where the street view stands its
 * observer. Home Assistant's configured elevation is typed in by hand.
 */
export async function groundElevation(lat, lon, { zoom = 15, loadTile = loadTerrariumTile, signal } = {}) {
  const [fx, fy] = tileXY(lat, lon, zoom);
  const [tx, ty] = [Math.floor(fx), Math.floor(fy)];
  const heights = await loadTile(zoom, tx, ty, { signal });
  const at = (i, j) => heights[Math.min(SIZE - 1, Math.max(0, j)) * SIZE + Math.min(SIZE - 1, Math.max(0, i))];
  return bilinear(at, (fx - tx) * SIZE, (fy - ty) * SIZE);
}

/**
 * Heights around a place from a block of tiles at zoom z covering radiusKm:
 * {sample(lat, lon) -> m (NaN off the block), tiles, failed}. Missing tiles
 * leave holes rather than failing the lot.
 */
export async function demGrid(lat, lon, z, radiusKm, { loadTile = loadTerrariumTile, signal, despikeLimit = 60 } = {}) {
  const [cx, cy] = tileXY(lat, lon, z);
  const tileKm = (40075.016 * Math.cos(lat * DEG)) / 2 ** z;
  const r = Math.ceil(radiusKm / tileKm);
  const tiles = new Map();
  let failed = 0;
  const jobs = [];
  const n = 2 ** z;
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const x = (((Math.floor(cx) + dx) % n) + n) % n;
      const y = Math.floor(cy) + dy;
      if (y < 0 || y >= n) continue;
      jobs.push(
        loadTile(z, x, y, { signal })
          .then((t) => tiles.set(`${x}/${y}`, t))
          .catch((err) => {
            if (signal?.aborted) throw err;
            failed++;
          }),
      );
    }
  }
  await Promise.all(jobs);
  const at = (i, j) => {
    const x = ((Math.floor(i / SIZE) % n) + n) % n;
    const t = tiles.get(`${x}/${Math.floor(j / SIZE)}`);
    return t ? t[(((j % SIZE) + SIZE) % SIZE) * SIZE + (((i % SIZE) + SIZE) % SIZE)] : NaN;
  };
  const sample = (la, lo) => {
    const [fx, fy] = tileXY(la, lo, z);
    return bilinear(at, fx * SIZE, fy * SIZE, { limit: despikeLimit });
  };
  return { sample, tiles: tiles.size, failed, zoom: z };
}

/**
 * The skyline: for every azimuth (stepDeg apart) the highest elevation angle
 * of the ground out to maxKm, Earth's curvature and refraction included, and
 * how far away that ridge is. `near` samples within nearKm, `far` beyond.
 * @returns {{azimuth: number, elevation: number, distance: number}[]}
 */
export function skylineProfile(near, far, lat, lon, eyeAltitude, { maxKm = 40, nearKm = 6, stepDeg = 0.5, startM = 30, growth = 1.012 } = {}) {
  const out = [];
  const cosLat = Math.cos(lat * DEG);
  for (let az = 0; az < 360 - 1e-9; az += stepDeg) {
    const sa = Math.sin(az * DEG);
    const ca = Math.cos(az * DEG);
    let best = -90;
    let bestD = 0;
    for (let d = startM; d < maxKm * 1000; d *= growth) {
      const la = lat + (d * ca) / EARTH_RADIUS / DEG;
      const lo = lon + (d * sa) / (EARTH_RADIUS * cosLat) / DEG;
      const h = (d < nearKm * 1000 ? near : far)(la, lo);
      if (!Number.isFinite(h)) continue;
      const drop = ((1 - REFRACTION_K) * d * d) / (2 * EARTH_RADIUS);
      const angle = Math.atan2(h - drop - eyeAltitude, d) / DEG;
      if (angle > best) {
        best = angle;
        bestD = d;
      }
    }
    // Nothing loaded that way: a flat horizon, dipping with the eye's height.
    if (best === -90) best = -Math.acos(EARTH_RADIUS / (EARTH_RADIUS + Math.max(0, eyeAltitude))) / DEG;
    out.push({ azimuth: +az.toFixed(4), elevation: best, distance: bestD });
  }
  return out;
}

/**
 * The skyline around a place for an eye at eyeAltitude (m above sea level):
 * zoom-12 tiles within 6 km and zoom-10 tiles out to 40 km (34 tiles, about
 * 0.4 MB). Resolves to {profile, stepDeg, tiles, failed, loadMs, totalMs}.
 */
export async function skyline(lat, lon, eyeAltitude, { maxKm = 40, nearKm = 6, nearZoom = 12, farZoom = 10, stepDeg = 0.5, loadTile, signal } = {}) {
  const t0 = performance.now();
  const [near, far] = await Promise.all([
    demGrid(lat, lon, nearZoom, nearKm, { loadTile, signal }),
    demGrid(lat, lon, farZoom, maxKm, { loadTile, signal }),
  ]);
  if (!near.tiles && !far.tiles) throw new Error("no terrain tiles could be loaded");
  const loadMs = performance.now() - t0;
  const profile = skylineProfile(near.sample, far.sample, lat, lon, eyeAltitude, { maxKm, nearKm, stepDeg });
  return { profile, stepDeg, tiles: near.tiles + far.tiles, failed: near.failed + far.failed, loadMs, totalMs: performance.now() - t0 };
}

/** The skyline's elevation at an azimuth (linear between profile points). */
export function horizonAt(skyline, azimuth) {
  const { profile, stepDeg } = skyline;
  const a = ((((azimuth % 360) + 360) % 360) / stepDeg);
  const i = Math.floor(a);
  const f = a - i;
  const p = profile[i % profile.length].elevation;
  const q = profile[(i + 1) % profile.length].elevation;
  return p + (q - p) * f;
}

/**
 * Which samples of a path ({n, t, az, el} from sat-planetarium's
 * trackFromRows) are above the horizon but below the skyline: Map(t -> hidden).
 */
export function hiddenByTerrain(skyline, data) {
  const out = new Map();
  for (let i = 0; i < data.n; i++) {
    if (data.el[i] < 0) continue;
    out.set(data.t[i], data.el[i] < horizonAt(skyline, data.az[i]));
  }
  return out;
}
