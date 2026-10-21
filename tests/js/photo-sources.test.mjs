// Tests for the street photos of the services that need a key
// (sat-photo-sources.js): Mapillary's search, candidates and camera
// rotations, Google Street View's session, search, panoramas and tiles,
// and the services' photos ranked together: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GOOGLE_REFERRER,
  GOOGLE_TILES,
  MAPILLARY_API,
  angleAxisRotation,
  fetchInit,
  fetchTiles,
  findGooglePhotos,
  findMapillaryPhotos,
  googleCandidate,
  googleProbePoints,
  googleSession,
  googleTiles,
  keyId,
  mapillaryBox,
  mapillaryCandidates,
  mapillaryOrientation,
  mapillarySearchUrl,
  rankPhotos,
} from "../../custom_components/satellite_spotter/frontend/sat-photo-sources.js";
import { distanceBearing, multiply3, photoOrientation, photoRotation, transpose3 } from "../../custom_components/satellite_spotter/frontend/sat-photo.js";

const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);
const turnTo = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;
const HOME = { latitude: 52.3702, longitude: 4.8952 };
const NOW_S = Date.UTC(2026, 9, 19) / 1000;
const NOW_MS = NOW_S * 1000;
/** A point some metres north and east of home. */
const near = (north, east) => ({ lat: HOME.latitude + north / 111320, lon: HOME.longitude + east / (111320 * Math.cos((HOME.latitude * Math.PI) / 180)) });

/** A rotation matrix's angle-axis vector (away from 180°). */
function axisAngle(R) {
  const angle = Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2)));
  if (angle < 1e-12) return [0, 0, 0];
  const k = angle / (2 * Math.sin(angle));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** Mapillary's computed_rotation for a camera with this heading, pitch and roll: world to camera (x right, y down, z forward). */
function mapillaryRotationFor(orientation) {
  const P = photoRotation(orientation);
  const cameraFromPhoto = [1, 0, 0, 0, 0, -1, 0, 1, 0];
  return axisAngle(multiply3(cameraFromPhoto, transpose3(P)));
}

/** localStorage as a Map. */
function memoryStorage() {
  const store = new Map();
  return { store, getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
}

/** A fetch that answers from a table of [test, response] and records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [match, answer] of routes) {
      if (match(url, init)) {
        const r = typeof answer === "function" ? await answer(url, init) : answer;
        return { ok: (r.status ?? 200) === 200, status: r.status ?? 200, json: async () => r.json, blob: async () => r.blob ?? { size: 1 } };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, calls };
}

// ---- Mapillary -----------------------------------------------------------------------

test("Mapillary is asked for 360° pictures in a square about home, from its position rounded to about 10 m", () => {
  const url = new URL(mapillarySearchUrl(52.370216, 4.895168, "MLY|123|abc"));
  assert.equal(`${url.origin}${url.pathname}`, `${MAPILLARY_API}/images`);
  assert.equal(url.searchParams.get("access_token"), "MLY|123|abc");
  assert.equal(url.searchParams.get("is_pano"), "true");
  for (const field of ["computed_rotation", "computed_compass_angle", "thumb_2048_url", "thumb_original_url", "creator", "captured_at"]) {
    assert.ok(url.searchParams.get("fields").split(",").includes(field), field);
  }
  const [w, s, e, n] = url.searchParams.get("bbox").split(",").map(Number);
  close((w + e) / 2, 4.8952, 1e-5, "centred on the rounded position");
  close((s + n) / 2, 52.3702, 1e-5);
  close(distanceBearing(s, w, s, e).distance, 500, 2, "250 m each way");
  close(distanceBearing(s, w, n, w).distance, 500, 2);
  assert.ok((e - w) * (n - s) < 0.01, "within Mapillary's limit on the box");
  assert.equal(mapillaryBox(52.370216, 4.895168), url.searchParams.get("bbox"));
});

test("Mapillary's reconstruction turns into the photo's heading, pitch and roll", () => {
  // Level and facing north, the camera's z (forward) is north and its y (down) is down: a quarter turn about east.
  for (const [k, v] of Object.entries(mapillaryOrientation([Math.PI / 2, 0, 0]))) close(v, 0, 1e-9, k);
  for (const orientation of [
    { heading: 37, pitch: 2, roll: -1.5 },
    { heading: 123, pitch: -4, roll: 3 },
    { heading: 250, pitch: 1, roll: 0.5 },
    { heading: 300, pitch: 6, roll: -3 },
  ]) {
    const got = mapillaryOrientation(mapillaryRotationFor(orientation));
    close(turnTo(got.heading, orientation.heading), 0, 1e-6, "heading");
    close(got.pitch, orientation.pitch, 1e-6, "pitch");
    close(got.roll, orientation.roll, 1e-6, "roll");
  }
  // And the rotations agree with photoRotation's.
  const R = angleAxisRotation([0.3, -0.2, 1.1]);
  const back = photoOrientation(photoRotation(photoOrientation(R)));
  for (const [k, v] of Object.entries(photoOrientation(R))) close(back[k], v, 1e-9, k);
  assert.deepEqual(angleAxisRotation([0, 0, 0]), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

/** A Mapillary image as its API gives it. */
function mapillaryImage(id, { north = 0, east = 0, pano = true, type = "spherical", width = 5760, height = 2880, rotation, compass = 90, captured = Date.UTC(2025, 5, 1, 10), user = "mapper", computed = null } = {}) {
  const p = near(north, east);
  const image = {
    id,
    geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    captured_at: captured,
    compass_angle: compass,
    is_pano: pano,
    camera_type: type,
    width,
    height,
    thumb_2048_url: `https://scontent.example/${id}/2048.jpg`,
    thumb_original_url: `https://scontent.example/${id}/original.jpg`,
    creator: { username: user, id: "7" },
  };
  if (rotation) image.computed_rotation = rotation;
  if (computed) {
    const q = near(...computed);
    image.computed_geometry = { type: "Point", coordinates: [q.lon, q.lat] };
  }
  return image;
}

test("Mapillary's candidates: 360° pictures near home, best first, credited to their photographer under CC BY-SA", () => {
  const tilted = mapillaryRotationFor({ heading: 10, pitch: 40, roll: 0 });
  const json = {
    data: [
      mapillaryImage("1001", { north: 30, rotation: mapillaryRotationFor({ heading: 200, pitch: 1, roll: -2 }) }),
      mapillaryImage("1002", { north: 12, east: 5, computed: [9, 4] }),
      mapillaryImage("1003", { north: 12.5, east: 5.5 }), // the same spot as 1002
      mapillaryImage("1004", { north: 20, rotation: tilted, compass: 75 }), // a broken reconstruction: the compass
      mapillaryImage("1005", { east: 60, pano: false, type: "perspective", width: 4000, height: 3000 }),
      mapillaryImage("1006", { east: 300 }), // too far
      mapillaryImage("1007", { north: 40, width: 4000, height: 3000 }), // not 2:1
      mapillaryImage("1008", { north: 50, type: "fisheye" }),
    ],
  };
  const list = mapillaryCandidates(json, { ...HOME, nowS: NOW_S });
  assert.deepEqual(list.map((p) => p.id), ["mapillary:1002", "mapillary:1004", "mapillary:1001"]);
  const [first, second, third] = list;
  assert.equal(first.source, "mapillary");
  close(first.distance, Math.hypot(9, 4), 0.2, "where the reconstruction put it");
  assert.deepEqual([first.heading, first.pitch, first.roll], [90, 0, 0], "no reconstruction: the compass, level");
  assert.deepEqual([second.heading, second.pitch, second.roll], [75, 0, 0], "a camera tilted 40°: not believed");
  close(third.heading, 200, 1e-6);
  close(third.roll, -2, 1e-6);
  assert.equal(first.author, "mapper");
  assert.equal(first.license, "CC BY-SA 4.0");
  assert.equal(first.licenseUrl, "https://creativecommons.org/licenses/by-sa/4.0/");
  assert.equal(first.page, "https://www.mapillary.com/app/?focus=photo&pKey=1002");
  assert.equal(first.sd, "https://scontent.example/1002/2048.jpg");
  assert.equal(first.hd, "https://scontent.example/1002/original.jpg");
  assert.equal(first.width, 5760);
  assert.equal(first.taken, Date.UTC(2025, 5, 1, 10) / 1000);
  assert.ok(list.every((p) => Number.isFinite(p.score)));
  assert.deepEqual(mapillaryCandidates({}, HOME), []);
  assert.deepEqual(mapillaryCandidates(null, HOME), []);
});

test("the Mapillary search goes without cookies or referrer, needs a token and says why it was refused", async () => {
  const { fetch, calls } = fakeFetch([[(url) => url.startsWith(`${MAPILLARY_API}/images`), { json: { data: [mapillaryImage("2001", { north: 10 })] } }]]);
  const list = await findMapillaryPhotos(HOME, { token: "MLY|1|2", fetch });
  assert.deepEqual(list.map((p) => p.id), ["mapillary:2001"]);
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.referrerPolicy, "no-referrer");
  await assert.rejects(findMapillaryPhotos(HOME, { token: "", fetch }), /no Mapillary access token/);
  const refused = fakeFetch([[() => true, { status: 401, json: { error: { message: "Invalid OAuth access token", type: "OAuthException" } } }]]);
  await assert.rejects(findMapillaryPhotos(HOME, { token: "MLY|bad", fetch: refused.fetch }), (err) => /Mapillary answered 401: Invalid OAuth access token/.test(err.message) && err.refused);
  // Mapillary says a token it does not take with code 190, even as a server error; a real one is not about the key.
  const oauth = fakeFetch([[() => true, { status: 500, json: { error: { message: "Invalid OAuth 2.0 Access Token", type: "MLYApiException", code: 190 } } }]]);
  await assert.rejects(findMapillaryPhotos(HOME, { token: "MLY|1|2", fetch: oauth.fetch }), (err) => err.refused === true);
  const down = fakeFetch([[() => true, { status: 500, json: { error: { message: "Service temporarily unavailable", code: 2, is_transient: true } } }]]);
  await assert.rejects(findMapillaryPhotos(HOME, { token: "MLY|1|2", fetch: down.fetch }), (err) => err.refused === false && err.status === 500);
  // One that never answers is given up on.
  const silent = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  await assert.rejects(findMapillaryPhotos(HOME, { token: "MLY|1|2", fetch: silent, timeoutMs: 10 }), /aborted/);
});

// ---- Google Street View --------------------------------------------------------------

test("Google's tiles need a session: one is made for a key, kept, and made again for another key or when it runs out", async () => {
  const storage = memoryStorage();
  let made = 0;
  const { fetch, calls } = fakeFetch([
    [(url) => url.startsWith(`${GOOGLE_TILES}/createSession`), () => ({ json: { session: `s${++made}`, expiry: String(NOW_S + 14 * 86400), tileWidth: 512, tileHeight: 512, imageFormat: "jpeg" } })],
  ]);
  const session = await googleSession("AIza-one", { fetch, storage, language: "fr", region: "FR", nowMs: NOW_MS });
  assert.equal(session.session, "s1");
  assert.equal(session.tileWidth, 512);
  const [call] = calls;
  assert.equal(call.url, `${GOOGLE_TILES}/createSession?key=AIza-one`);
  assert.equal(call.init.method, "POST");
  assert.deepEqual(JSON.parse(call.init.body), { mapType: "streetview", language: "fr", region: "FR" });
  assert.equal(call.init.referrerPolicy, GOOGLE_REFERRER, "a key restricted to the page's address needs its origin");
  assert.equal(call.init.credentials, "omit");
  // Kept: no new request for the same key.
  assert.equal((await googleSession("AIza-one", { fetch, storage, nowMs: NOW_MS })).session, "s1");
  assert.equal(calls.length, 1);
  assert.ok(!storage.store.get("satellite-spotter:google-session").includes("AIza-one"), "the key itself is not kept");
  // Another key, or the session about to run out: a new one.
  assert.equal((await googleSession("AIza-two", { fetch, storage, nowMs: NOW_MS })).session, "s2");
  assert.equal((await googleSession("AIza-two", { fetch, storage, nowMs: NOW_MS + 14 * 86400e3 })).session, "s3");
  assert.notEqual(keyId("AIza-one"), keyId("AIza-two"));
  const refused = fakeFetch([[() => true, { status: 400, json: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } } }]]);
  await assert.rejects(googleSession("AIza-bad", { fetch: refused.fetch, storage: memoryStorage() }), /Google answered 400: API key not valid/);
});

test("Google is asked for the panoramas nearest home and on the streets around, within about 200 m", () => {
  const points = googleProbePoints(52.370216, 4.895168);
  assert.deepEqual(points[0], { lat: 52.3702, lng: 4.8952 }, "home, rounded");
  assert.equal(points.length, 25);
  const rings = points.slice(1).map((p) => Math.round(distanceBearing(52.3702, 4.8952, p.lat, p.lng).distance));
  assert.deepEqual([...new Set(rings)], [45, 100, 160]);
});

/** Google's metadata for a panorama (the documentation's example, moved near home). */
function googleMeta(panoId, { north = 0, east = 0, ...extra } = {}) {
  const p = near(north, east);
  return {
    panoId,
    lat: p.lat,
    lng: p.lon,
    imageHeight: 6656,
    imageWidth: 13312,
    tileHeight: 512,
    tileWidth: 512,
    heading: 94.35,
    tilt: 88.39652,
    roll: 1.7181772,
    imageryType: "outdoor",
    date: "2023-01",
    copyright: "© 2023 Google",
    reportProblemLink: "https://cbks0.googleapis.com/cbk?output=report&panoid=x",
    links: [],
    ...extra,
  };
}
const SESSION = { session: "sess", tileWidth: 512, tileHeight: 512 };

test("a Google panorama's details make a candidate: its heading, the tilt and roll that level it, and Google's credit", () => {
  const photo = googleCandidate(googleMeta("pano-1", { north: 20 }), { ...HOME, session: SESSION, key: "AIza", nowS: NOW_S });
  assert.equal(photo.source, "google");
  assert.equal(photo.id, "google:pano-1");
  close(photo.distance, 20, 0.2);
  close(photo.heading, 94.35, 1e-9);
  close(photo.pitch, 90 - 88.39652, 1e-9, "the camera looks this far above the horizon at the picture's centre");
  close(photo.roll, 1.7181772, 1e-9);
  assert.equal(photo.taken, Date.UTC(2023, 0, 15) / 1000);
  assert.equal(photo.approximate, true, "only the month: not enough for the Sun");
  assert.equal(photo.copyright, "© 2023 Google");
  assert.equal(photo.reportLink, "https://cbks0.googleapis.com/cbk?output=report&panoid=x");
  assert.equal(photo.page, "https://www.google.com/maps/@?api=1&map_action=pano&pano=pano-1");
  assert.deepEqual(photo.google, { panoId: "pano-1", imageWidth: 13312, imageHeight: 6656, tileWidth: 512, tileHeight: 512, session: "sess", key: "AIza" });
  close(googleCandidate(googleMeta("p", { roll: 358.5 }), { ...HOME, session: SESSION, key: "k" }).roll, -1.5, 1e-9, "a roll of 358.5° is 1.5° the other way");
  // Google's own cars count as a little nearer than someone's photosphere at the same spot.
  const theirs = googleCandidate(googleMeta("p2", { north: 20, copyright: "© Jo Bloggs" }), { ...HOME, session: SESSION, key: "k", nowS: NOW_S });
  assert.ok(photo.score < theirs.score);
  // Not the street: indoors, not 2:1, too far, nothing at all.
  assert.equal(googleCandidate(googleMeta("in", { imageryType: "indoor" }), { ...HOME, session: SESSION, key: "k" }), null);
  assert.equal(googleCandidate(googleMeta("odd", { imageWidth: 8000, imageHeight: 3000 }), { ...HOME, session: SESSION, key: "k" }), null);
  assert.equal(googleCandidate(googleMeta("far", { north: 400 }), { ...HOME, session: SESSION, key: "k" }), null);
  assert.equal(googleCandidate(null, { ...HOME, session: SESSION, key: "k" }), null);
  assert.equal(googleCandidate(googleMeta("year", { date: "2019" }), { ...HOME, session: SESSION, key: "k" }).taken, Date.UTC(2019, 6, 1) / 1000);
});

test("the Google search: a session, the panoramas near the probe points, then the details of each, nearest first", async () => {
  const storage = memoryStorage();
  const metas = { a: googleMeta("a", { north: 30 }), b: googleMeta("b", { east: 8 }), c: googleMeta("c", { imageryType: "indoor" }) };
  const { fetch, calls } = fakeFetch([
    [(url) => url.includes("/createSession"), { json: { session: "sess/1", expiry: String(NOW_S + 86400 * 14), tileWidth: 512, tileHeight: 512 } }],
    [(url) => url.includes("/streetview/panoIds"), { json: { panoIds: ["a", "b", "a", "", "c"] } }],
    [(url) => url.includes("/streetview/metadata"), (url) => ({ json: metas[new URL(url).searchParams.get("panoId")] })],
  ]);
  const list = await findGooglePhotos(HOME, { key: "AIza-key", fetch, storage, nowMs: NOW_MS });
  assert.deepEqual(list.map((p) => p.id), ["google:b", "google:a"], "best first; the indoor one left out");
  const ask = calls.find((c) => c.url.includes("/panoIds"));
  const url = new URL(ask.url);
  assert.equal(url.searchParams.get("session"), "sess/1");
  assert.equal(url.searchParams.get("key"), "AIza-key");
  const body = JSON.parse(ask.init.body);
  assert.equal(body.radius, 50);
  assert.equal(body.locations.length, 25);
  assert.equal(calls.filter((c) => c.url.includes("/metadata")).length, 3, "each panorama once");
  assert.ok(calls.every((c) => c.init.referrerPolicy === GOOGLE_REFERRER && c.init.credentials === "omit"));
  // A session Google no longer takes is forgotten, so the next search makes a new one.
  const stale = fakeFetch([
    [(url) => url.includes("/panoIds"), { status: 403, json: { error: { message: "The session is invalid" } } }],
  ]);
  await assert.rejects(findGooglePhotos(HOME, { key: "AIza-key", fetch: stale.fetch, storage, nowMs: NOW_MS }), /Google answered 403: The session is invalid/);
  assert.equal(storage.store.has("satellite-spotter:google-session"), false);
  await assert.rejects(findGooglePhotos(HOME, { key: null, fetch }), /no Google API key/);
});

test("a Google panorama's tiles: the largest zoom that fits, five being the full picture, the edges' tiles cut off", () => {
  const photo = googleCandidate(googleMeta("p"), { ...HOME, session: { session: "s", tileWidth: 512, tileHeight: 512 }, key: "AIza" });
  const small = googleTiles(photo, 2048);
  assert.deepEqual([small.zoom, small.width, small.height, small.tiles.length], [2, 1664, 832, 8], "4 × 2 tiles");
  const phone = googleTiles(photo, 4096);
  assert.deepEqual([phone.zoom, phone.width, phone.height, phone.tiles.length], [3, 3328, 1664, 28], "7 × 4 tiles");
  const desktop = googleTiles(photo, 8192);
  assert.deepEqual([desktop.zoom, desktop.width, desktop.height, desktop.tiles.length], [4, 6656, 3328, 91]);
  assert.deepEqual(desktop.tiles.at(-1), { x: 12, y: 6, url: desktop.tiles.at(-1).url });
  const url = new URL(desktop.tiles[14].url);
  assert.equal(url.pathname, "/v1/streetview/tiles/4/1/1");
  assert.deepEqual(Object.fromEntries(url.searchParams), { session: "s", key: "AIza", panoId: "p" });
  // An older camera's 16384 px panoramas: powers of two.
  const old = { google: { ...photo.google, imageWidth: 16384, imageHeight: 8192 } };
  assert.deepEqual([googleTiles(old, 2048).width, googleTiles(old, 2048).tiles.length], [2048, 8]);
  assert.deepEqual([googleTiles(old, 8192).zoom, googleTiles(old, 8192).tiles.length], [4, 128]);
  assert.equal(googleTiles(old, 100).zoom, 1, "never below zoom 1");
});

test("tiles come a few at a time, a server error is tried once more, and a missing one stops the rest without telling the key", async () => {
  const photo = googleCandidate(googleMeta("p"), { ...HOME, session: SESSION, key: "AIza-secret" });
  const plan = googleTiles(photo, 2048);
  let flaky = 1;
  let inFlight = 0;
  let most = 0;
  const { fetch, calls } = fakeFetch([
    [
      () => true,
      async (url) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        if (url.endsWith("&panoId=p") && url.includes("/2/1/0?") && flaky-- > 0) return { status: 503 };
        return { blob: { url } };
      },
    ],
  ]);
  const blobs = await fetchTiles(plan, { fetch });
  assert.equal(blobs.length, 8);
  assert.ok(blobs.every((b, i) => b.url === plan.tiles[i].url), "in the plan's order");
  assert.equal(calls.length, 9, "the failed one once more");
  assert.ok(most <= 8);
  assert.ok(calls.every((c) => c.init.mode === "cors" && c.init.referrerPolicy === GOOGLE_REFERRER));
  const gone = fakeFetch([[() => true, { status: 404 }]]);
  await assert.rejects(fetchTiles(plan, { fetch: gone.fetch }), (err) => /tile 2\/\d\/\d: HTTP 404/.test(err.message) && !err.message.includes("AIza"));
});

test("the services' photos are ranked together, and each service is asked in its own way", () => {
  const a = [{ id: "g", source: "google", score: 12, distance: 27 }];
  const b = [{ id: "m1", source: "mapillary", score: 9, distance: 9 }, { id: "m2", source: "mapillary", score: 40, distance: 40 }];
  const c = [{ id: "p", source: "panoramax", score: 12, distance: 12 }];
  assert.deepEqual(rankPhotos([a, b, c]).map((p) => p.id), ["m1", "p", "g", "m2"], "by score, then distance");
  assert.deepEqual(fetchInit("panoramax", { signal: 1 }), { credentials: "omit", referrerPolicy: "no-referrer", signal: 1 });
  assert.equal(fetchInit("google").referrerPolicy, GOOGLE_REFERRER);
});
