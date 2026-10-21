/**
 * Street photos from the services that need a key, beside Panoramax's
 * (sat-photo.js, open and keyless): Mapillary, with a free access token, and
 * Google Street View, with a Google Cloud API key (the Map Tiles API's
 * Street View tiles). The keys are the integration's options; the street
 * view asks Home Assistant for them (satellite_spotter/street) and searches
 * every service there is a key for.
 *
 * Every service's photos come as the same candidates as Panoramax's
 * (photoCandidates): {source, id, latitude, longitude, distance, bearing,
 * heading, pitch, roll, taken, author, license, licenseUrl, sd, hd, width,
 * page, score}. Google's have no sd or hd: `google` says what their tiles
 * need, and `taken` is only the month (`approximate`). rankPhotos() puts
 * the services' lists together, best first.
 *
 * Orientation, in sat-photo.js's terms (heading of the picture's centre,
 * pitch nose up, roll right side down):
 *  - Mapillary's reconstruction gives computed_rotation, OpenSfM's
 *    world-to-camera rotation as an angle-axis vector, with the camera's x
 *    right, y down and z forward and the world east, north, up; without it
 *    the compass angle, level;
 *  - Google gives the heading of the picture's centre, its tilt (90° is
 *    level: the camera looks 90° − tilt above the horizon there) and the
 *    roll that levels it.
 *
 * Pure functions but the searches, unit tested in node with a stand-in fetch.
 */

const VERSION = new URL(import.meta.url).search;
const { PHOTO_MAX_M, SEARCH_RADIUS_M, SEARCH_TIMEOUT_MS, distanceBearing, https, multiply3, photoOrientation, photoScore, spacedPhotos, transpose3 } =
  await import(`./sat-photo.js${VERSION}`);

export const MAPILLARY_API = "https://graph.mapillary.com";
export const MAPILLARY_VIEWER = "https://www.mapillary.com/app/?focus=photo&pKey=";
export const GOOGLE_TILES = "https://tile.googleapis.com/v1";
export const GOOGLE_VIEWER = "https://www.google.com/maps/@?api=1&map_action=pano&pano=";
/** The services, in the order the street view offers them. */
export const PHOTO_SOURCES = ["google", "mapillary", "panoramax"];
/** Their names, which are not translated. */
export const SOURCE_NAMES = { google: "Google Street View", mapillary: "Mapillary", panoramax: "Panoramax" };
/**
 * Google refuses a key restricted to websites unless the page's address
 * comes with the request: only the origin goes (Panoramax and Mapillary get
 * no referrer at all).
 */
export const GOOGLE_REFERRER = "strict-origin-when-cross-origin";
/** Mapillary's photos are all under this licence. */
const MAPILLARY_LICENSE = { license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" };
const MAPILLARY_FIELDS = [
  "id",
  "geometry",
  "computed_geometry",
  "captured_at",
  "compass_angle",
  "computed_compass_angle",
  "computed_rotation",
  "camera_type",
  "is_pano",
  "width",
  "height",
  "thumb_2048_url",
  "thumb_original_url",
  "creator",
].join(",");
/** A reconstruction that tilts the camera more than this (degrees) is wrong: the compass is used instead. */
const MAX_TILT = 25;
/** Google's own cars, being calibrated, count as this much nearer (m) than other photos. */
const GOOGLE_BONUS_M = 15;
/** The Google panoramas whose details are asked for, at most (the nearest). */
const GOOGLE_DETAILS = 12;
/** Where the session for Google's tiles is kept (it lasts about two weeks). */
const GOOGLE_SESSION_KEY = "satellite-spotter:google-session";
/** Tiles fetched at once. */
const TILE_FETCHES = 8;

const DEG = Math.PI / 180;
const wrap360 = (x) => ((x % 360) + 360) % 360;
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/** The fetch options for a service: no cookies; no referrer, but Google's origin. */
export function fetchInit(source, init = {}) {
  return { credentials: "omit", referrerPolicy: source === "google" ? GOOGLE_REFERRER : "no-referrer", ...init };
}

/** A fetch with its own time limit, which also stops when `signal` does. */
async function withTimeout(signal, timeoutMs, run) {
  const abort = globalThis.AbortController ? new AbortController() : null;
  const stop = () => abort?.abort();
  signal?.addEventListener?.("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    return await run(abort?.signal ?? signal ?? undefined);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", stop);
  }
}

/**
 * Why a service did not send photos: the message of its error body, or the
 * status. `refused` when it is about the key: Google's 400 and 403, and
 * Mapillary's OAuth error (code 190, whatever the status).
 */
async function refusal(name, response) {
  let error = null;
  try {
    error = (await response.json())?.error ?? null;
  } catch {
    // Not JSON.
  }
  const message = typeof error?.message === "string" ? error.message : "";
  const err = new Error(`${name} answered ${response.status}${message ? `: ${message}` : ""}`);
  err.status = response.status;
  err.refused = error?.code === 190 || [400, 401, 403].includes(response.status);
  return err;
}

// ---------------------------------------------------------------------------
// Mapillary

/** The square around home (the search radius each way) a Mapillary search covers, from the position rounded to about 10 m. */
export function mapillaryBox(latitude, longitude, radius = SEARCH_RADIUS_M) {
  const lat = round4(latitude);
  const lon = round4(longitude);
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos(lat * DEG));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(5)).join(",");
}

/** The search for Mapillary's 360° pictures around home. */
export function mapillarySearchUrl(latitude, longitude, token, { radius = SEARCH_RADIUS_M, limit = 500 } = {}) {
  const params = new URLSearchParams({ access_token: token, fields: MAPILLARY_FIELDS, bbox: mapillaryBox(latitude, longitude, radius), is_pano: "true", limit: String(limit) });
  return `${MAPILLARY_API}/images?${params}`;
}

/** The rotation (row-major 3×3) of an angle-axis vector (Rodrigues). */
export function angleAxisRotation([x, y, z]) {
  const angle = Math.hypot(x, y, z);
  if (!(angle > 1e-12)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [kx, ky, kz] = [x / angle, y / angle, z / angle];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * kx * kx + c, t * kx * ky - s * kz, t * kx * kz + s * ky,
    t * kx * ky + s * kz, t * ky * ky + c, t * ky * kz - s * kx,
    t * kx * kz - s * ky, t * ky * kz + s * kx, t * kz * kz + c,
  ];
}

/** The camera's directions (x right, y down, z forward) of the photo's (x right, y forward, z up). */
const CAMERA_FROM_PHOTO = [1, 0, 0, 0, 0, -1, 0, 1, 0];

/**
 * A Mapillary reconstruction's camera rotation (computed_rotation) as the
 * heading, pitch and roll photoRotation() takes: world = Rᵀ · camera, and
 * camera = CAMERA_FROM_PHOTO · photo.
 */
export function mapillaryOrientation(rotation) {
  const R = angleAxisRotation(rotation);
  return photoOrientation(multiply3(transpose3(R), CAMERA_FROM_PHOTO));
}

/**
 * The pictures of a Mapillary search that can stand in for the street:
 * equirectangular 360° pictures within maxDistance of home, best first,
 * spaced out (as Panoramax's: photoCandidates).
 */
export function mapillaryCandidates(json, { latitude, longitude, maxDistance = PHOTO_MAX_M, nowS = Date.now() / 1000, sunElevation = null, max } = {}) {
  const found = [];
  for (const image of json?.data ?? []) {
    if (!image || image.is_pano === false || typeof image.id !== "string") continue;
    if (image.camera_type && !["spherical", "equirectangular"].includes(image.camera_type)) continue;
    if (Number.isFinite(image.width) && Number.isFinite(image.height) && Math.abs(image.width / image.height - 2) > 0.01) continue;
    const [lon, lat] = (image.computed_geometry ?? image.geometry)?.coordinates ?? [];
    const sd = https(image.thumb_2048_url);
    const hd = https(image.thumb_original_url);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !(sd || hd)) continue;
    const { distance, bearing } = distanceBearing(latitude, longitude, lat, lon);
    if (distance > maxDistance) continue;
    let orientation = null;
    if (Array.isArray(image.computed_rotation) && image.computed_rotation.length === 3 && image.computed_rotation.every(Number.isFinite)) {
      orientation = mapillaryOrientation(image.computed_rotation);
      if (Math.abs(orientation.pitch) > MAX_TILT || Math.abs(orientation.roll) > MAX_TILT) orientation = null;
    }
    const compass = Number.isFinite(image.computed_compass_angle) ? image.computed_compass_angle : image.compass_angle;
    orientation ??= { heading: wrap360(Number.isFinite(compass) ? compass : 0), pitch: 0, roll: 0 };
    const photo = {
      source: "mapillary",
      id: `mapillary:${image.id}`,
      latitude: lat,
      longitude: lon,
      distance,
      bearing,
      ...orientation,
      taken: Number.isFinite(image.captured_at) ? image.captured_at / 1000 : null,
      author: typeof image.creator?.username === "string" ? image.creator.username : "",
      ...MAPILLARY_LICENSE,
      sd: sd ?? hd,
      hd: hd ?? sd,
      width: Number.isFinite(image.width) ? image.width : null,
      page: `${MAPILLARY_VIEWER}${encodeURIComponent(image.id)}`,
    };
    photo.score = photoScore(photo, { nowS, sunElevation });
    found.push(photo);
  }
  return spacedPhotos(found, max);
}

/** Ask Mapillary for the 360° pictures near a place, with an access token. Rejects when it refuses or does not answer. */
export async function findMapillaryPhotos({ latitude, longitude }, { token, signal = null, fetch: fetchImpl = (url, init) => globalThis.fetch(url, init), sunElevation = null, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  if (!token) throw new Error("no Mapillary access token");
  return withTimeout(signal, timeoutMs, async (stop) => {
    const response = await fetchImpl(mapillarySearchUrl(latitude, longitude, token), fetchInit("mapillary", { signal: stop }));
    if (!response.ok) throw await refusal("Mapillary", response);
    return mapillaryCandidates(await response.json(), { latitude, longitude, sunElevation });
  });
}

// ---------------------------------------------------------------------------
// Google Street View (the Map Tiles API)

/** A short fingerprint of a key, so that a session kept is never used with another key. */
export function keyId(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

/**
 * A session for Google's Street View tiles: the one kept in this browser if
 * it is for this key and has a day left, else a new one (and kept). The
 * same session keeps the tiles' addresses the same, so the browser's cache
 * serves a photo seen before.
 */
export async function googleSession(key, { fetch: fetchImpl = (url, init) => globalThis.fetch(url, init), signal = null, language = "en", region = "US", storage = globalThis.localStorage, nowMs = Date.now() } = {}) {
  const id = keyId(key);
  try {
    const kept = JSON.parse(storage?.getItem(GOOGLE_SESSION_KEY) ?? "null");
    if (kept?.id === id && typeof kept.session === "string" && kept.expiry * 1000 > nowMs + 86400e3) return kept;
  } catch {
    // Unreadable storage: a new session.
  }
  const response = await fetchImpl(
    `${GOOGLE_TILES}/createSession?key=${encodeURIComponent(key)}`,
    fetchInit("google", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mapType: "streetview", language, region }) }),
  );
  if (!response.ok) throw await refusal("Google", response);
  const json = await response.json();
  if (typeof json?.session !== "string") throw new Error("Google answered without a session");
  const session = {
    id,
    session: json.session,
    expiry: Number(json.expiry) || nowMs / 1000 + 86400,
    tileWidth: Number(json.tileWidth) || 512,
    tileHeight: Number(json.tileHeight) || 512,
  };
  try {
    storage?.setItem(GOOGLE_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private mode: a new session next time.
  }
  return session;
}

/**
 * Where to look for Google's panoramas: home (rounded to about 10 m) and
 * rings 45, 100 and 160 m out. Each finds the panorama nearest it within
 * 50 m, so together they reach about 200 m, on every street around.
 */
export function googleProbePoints(latitude, longitude) {
  const lat = round4(latitude);
  const lon = round4(longitude);
  const points = [{ lat, lng: lon }];
  for (const [ring, count] of [[45, 6], [100, 8], [160, 10]]) {
    for (let i = 0; i < count; i++) {
      const az = ((i + (ring === 100 ? 0.5 : 0)) / count) * 2 * Math.PI;
      const north = ring * Math.cos(az);
      const east = ring * Math.sin(az);
      points.push({ lat: +(lat + north / 111320).toFixed(6), lng: +(lon + east / (111320 * Math.cos(lat * DEG))).toFixed(6) });
    }
  }
  return points;
}

/** "2023-05" or "2023" as Unix seconds (the 15th of the month, or 1 July). */
function googleDate(date) {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(String(date ?? ""));
  if (!m) return null;
  const ms = m[2] ? Date.UTC(+m[1], +m[2] - 1, 15) : Date.UTC(+m[1], 6, 1);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** A Google panorama's details (streetview/metadata) as a candidate, or null if it cannot stand in for the street. */
export function googleCandidate(meta, { latitude, longitude, session, key, maxDistance = PHOTO_MAX_M, nowS = Date.now() / 1000 }) {
  if (!meta || typeof meta.panoId !== "string" || !meta.panoId) return null;
  if (meta.imageryType && meta.imageryType !== "outdoor") return null;
  const { imageWidth: W, imageHeight: H, lat, lng } = meta;
  if (!(W > 0 && H > 0) || Math.abs(W / H - 2) > 0.01 || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const { distance, bearing } = distanceBearing(latitude, longitude, lat, lng);
  if (distance > maxDistance) return null;
  const copyright = typeof meta.copyright === "string" ? meta.copyright : "";
  const roll = Number.isFinite(meta.roll) ? ((meta.roll + 540) % 360) - 180 : 0;
  const photo = {
    source: "google",
    id: `google:${meta.panoId}`,
    latitude: lat,
    longitude: lng,
    distance,
    bearing,
    heading: wrap360(Number.isFinite(meta.heading) ? meta.heading : 0),
    pitch: Number.isFinite(meta.tilt) ? Math.max(-MAX_TILT, Math.min(MAX_TILT, 90 - meta.tilt)) : 0,
    roll: Math.max(-MAX_TILT, Math.min(MAX_TILT, roll)),
    taken: googleDate(meta.date),
    // Only the month: not enough to tell where the Sun was.
    approximate: true,
    author: copyright,
    copyright,
    license: "",
    licenseUrl: null,
    reportLink: https(meta.reportProblemLink),
    sd: null,
    hd: null,
    width: W,
    page: `${GOOGLE_VIEWER}${encodeURIComponent(meta.panoId)}`,
    google: { panoId: meta.panoId, imageWidth: W, imageHeight: H, tileWidth: session.tileWidth, tileHeight: session.tileHeight, session: session.session, key },
  };
  photo.score = photoScore(photo, { nowS }) - (/google/i.test(copyright) ? GOOGLE_BONUS_M : 0);
  return photo;
}

/**
 * Ask Google for the Street View panoramas near a place, with an API key:
 * a session (kept), the panoramas nearest the probe points, then the
 * details of the nearest few. Rejects when Google refuses or does not answer.
 */
export async function findGooglePhotos({ latitude, longitude }, { key, signal = null, fetch: fetchImpl = (url, init) => globalThis.fetch(url, init), language = "en", region = "US", storage = globalThis.localStorage, timeoutMs = SEARCH_TIMEOUT_MS, nowMs = Date.now() } = {}) {
  if (!key) throw new Error("no Google API key");
  return withTimeout(signal, timeoutMs, async (stop) => {
    const session = await googleSession(key, { fetch: fetchImpl, signal: stop, language, region, storage, nowMs });
    const auth = `session=${encodeURIComponent(session.session)}&key=${encodeURIComponent(key)}`;
    const response = await fetchImpl(
      `${GOOGLE_TILES}/streetview/panoIds?${auth}`,
      fetchInit("google", { method: "POST", signal: stop, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locations: googleProbePoints(latitude, longitude), radius: 50 }) }),
    );
    if (!response.ok) {
      // A session Google no longer takes: the next search makes a new one.
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        try {
          storage?.removeItem(GOOGLE_SESSION_KEY);
        } catch {
          // Nothing kept.
        }
      }
      throw await refusal("Google", response);
    }
    const ids = [...new Set(((await response.json())?.panoIds ?? []).filter((id) => typeof id === "string" && id))].slice(0, GOOGLE_DETAILS);
    const details = await Promise.all(
      ids.map(async (panoId) => {
        try {
          const answer = await fetchImpl(`${GOOGLE_TILES}/streetview/metadata?${auth}&panoId=${encodeURIComponent(panoId)}`, fetchInit("google", { signal: stop }));
          return answer.ok ? await answer.json() : null;
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          return null;
        }
      }),
    );
    const nowS = nowMs / 1000;
    return spacedPhotos(details.map((meta) => googleCandidate(meta, { latitude, longitude, session, key, nowS })).filter(Boolean));
  });
}

/**
 * The tiles of a Google panorama at the largest zoom no wider than
 * maxWidth: zoom 5 is the full picture, each zoom below half as wide; the
 * tiles at the right and bottom edges stick out of it (and are cut off).
 * @returns {{zoom: number, width: number, height: number, tileWidth: number, tileHeight: number, tiles: {x: number, y: number, url: string}[]}}
 */
export function googleTiles(photo, maxWidth) {
  const g = photo.google;
  let zoom = 5;
  while (zoom > 1 && g.imageWidth / 2 ** (5 - zoom) > maxWidth) zoom--;
  const width = Math.round(g.imageWidth / 2 ** (5 - zoom));
  const height = Math.round(g.imageHeight / 2 ** (5 - zoom));
  const tileWidth = g.tileWidth || 512;
  const tileHeight = g.tileHeight || 512;
  const auth = `session=${encodeURIComponent(g.session)}&key=${encodeURIComponent(g.key)}&panoId=${encodeURIComponent(g.panoId)}`;
  const tiles = [];
  for (let y = 0; y < Math.ceil(height / tileHeight); y++) {
    for (let x = 0; x < Math.ceil(width / tileWidth); x++) tiles.push({ x, y, url: `${GOOGLE_TILES}/streetview/tiles/${zoom}/${x}/${y}?${auth}` });
  }
  return { zoom, width, height, tileWidth, tileHeight, tiles };
}

/**
 * Fetch a panorama's tiles (TILE_FETCHES at a time, a failed one once more):
 * their bytes, in the order of plan.tiles. One that does not come stops the
 * rest. Errors never carry the addresses (they hold the key).
 */
export async function fetchTiles(plan, { fetch: fetchImpl = (url, init) => globalThis.fetch(url, init), signal = null } = {}) {
  const abort = globalThis.AbortController ? new AbortController() : null;
  const stop = () => abort?.abort();
  signal?.addEventListener?.("abort", stop, { once: true });
  const blobs = new Array(plan.tiles.length);
  let next = 0;
  const one = async (tile) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(tile.url, fetchInit("google", { signal: abort?.signal ?? signal ?? undefined, mode: "cors" }));
      if (response.ok) return response.blob();
      if (attempt >= 1 || response.status < 500) throw new Error(`Google Street View tile ${plan.zoom}/${tile.x}/${tile.y}: HTTP ${response.status}`);
    }
  };
  const worker = async () => {
    while (next < plan.tiles.length) {
      const i = next++;
      blobs[i] = await one(plan.tiles[i]);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(TILE_FETCHES, plan.tiles.length) }, () => worker().catch((err) => (stop(), Promise.reject(err)))));
    return blobs;
  } finally {
    signal?.removeEventListener?.("abort", stop);
  }
}

// ---------------------------------------------------------------------------
// Together

/** The photos of several services in one list, best first (each list is already spaced out). */
export function rankPhotos(lists) {
  return lists.flat().sort((a, b) => a.score - b.score || a.distance - b.distance);
}
