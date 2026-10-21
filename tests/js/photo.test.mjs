// Tests for the street photos (sat-photo.js): the search and the choice of
// pictures near home, their orientation, finding the sky in a picture, what
// the photo hides of a path, and the night look; and the photo scene's camera
// (sat-photo-scene.js) against the planetarium's projector:
// node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { makeProjector } from "../../custom_components/satellite_spotter/frontend/sat-planetarium.js";
import { MIN_SKY, PhotoScene, rayToWorld } from "../../custom_components/satellite_spotter/frontend/sat-photo-scene.js";
import {
  PANORAMAX_API,
  PHOTO_MAX_M,
  distanceBearing,
  findPhotos,
  findSky,
  findSun,
  hiddenByPhoto,
  photoCandidates,
  photoDirection,
  photoLook,
  photoRotation,
  photoSearchUrl,
  photoShowsSky,
  photoUV,
  pixelElevations,
  skyTextures,
  sunHeading,
} from "../../custom_components/satellite_spotter/frontend/sat-photo.js";
import { fakeGL } from "./helpers/gl-fake.mjs";

const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);
const HOME = { latitude: 52.3702, longitude: 4.8952 };
const NOW_S = Date.UTC(2026, 9, 19) / 1000;

// ---- finding photos -------------------------------------------------------------

test("the search asks the meta-catalogue for 360° pictures around home, rounded to about 10 m", () => {
  const url = new URL(photoSearchUrl(52.370216, 4.895168));
  assert.equal(`${url.origin}${url.pathname}`, `${PANORAMAX_API}/search`);
  assert.equal(url.searchParams.get("place_position"), "4.8952,52.3702");
  assert.equal(url.searchParams.get("place_distance"), "0-250");
  assert.equal(url.searchParams.get("filter"), "field_of_view=360");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(new URL(photoSearchUrl(1, 2, { only360: false })).searchParams.get("filter"), null);
  assert.ok(PHOTO_MAX_M < 250, "the search reaches past the farthest photo used");
});

test("distances and bearings between places", () => {
  const north = distanceBearing(52, 5, 52.001, 5);
  close(north.distance, 111.2, 0.2, "a thousandth of a degree of latitude");
  close(north.bearing, 0, 1e-6);
  const east = distanceBearing(52, 5, 52, 5.001);
  close(east.distance, 111.2 * Math.cos(52 * Math.PI / 180), 0.2);
  close(east.bearing, 90, 0.01);
  close(distanceBearing(52, 5, 51.999, 4.999).bearing, 180 + 31.6, 0.2);
});

/** A Panoramax search feature (GeoJSON), as the API gives them. */
function feature(id, { dLat = 0, dLon = 0, fov = 360, dims = [5760, 2880], taken = "2025-07-08T12:00:00+00:00", heading = 90, pitch, roll, extra = {}, sd = true } = {}) {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [HOME.longitude + dLon, HOME.latitude + dLat] },
    properties: {
      datetime: taken,
      license: "CC-BY-SA-4.0",
      "geovisio:producer": "A. Mapper",
      "geovisio:status": "ready",
      "view:azimuth": heading,
      ...(pitch === undefined ? {} : { "pers:pitch": pitch }),
      ...(roll === undefined ? {} : { "pers:roll": roll }),
      "pers:interior_orientation": { field_of_view: fov, sensor_array_dimensions: dims },
      ...extra,
    },
    assets: {
      ...(sd ? { sd: { href: `https://pics.example/${id}/sd.jpg` } } : {}),
      hd: { href: `https://pics.example/${id}/hd.jpg` },
    },
    links: [{ rel: "license", href: "https://creativecommons.org/licenses/by-sa/4.0/" }],
  };
}

test("photos near home: 360° pictures only, nearest first, spaced out, with what the view needs", () => {
  const m = 1 / 111200; // a metre of latitude, in degrees
  const collection = {
    features: [
      feature("far", { dLat: 230 * m }),
      feature("flat", { dLat: 5 * m, fov: 90 }),
      feature("cropped", { dLat: 6 * m, dims: [5760, 2000] }),
      feature("hidden", { dLat: 7 * m, extra: { "geovisio:visibility": "owner" } }),
      feature("broken", { dLat: 8 * m, extra: { "geovisio:status": "broken" } }),
      feature("insecure", { dLat: 9 * m }),
      feature("near", { dLat: 30 * m, pitch: 3.5, roll: -1.2 }),
      feature("nearest", { dLat: -12 * m, heading: 400 }),
      feature("twin", { dLat: -14 * m }),
      feature("old", { dLat: 15 * m, taken: "2015-07-08T12:00:00+00:00" }),
      feature("only-hd", { dLat: -60 * m, sd: false }),
    ],
  };
  collection.features[5].assets.sd.href = "http://pics.example/insecure/sd.jpg";
  collection.features[5].assets.hd.href = "http://pics.example/insecure/hd.jpg";
  const list = photoCandidates(collection, { ...HOME, nowS: NOW_S });
  assert.deepEqual(
    list.map((p) => p.id),
    ["nearest", "near", "only-hd", "old"],
    "the twin is the same spot as the nearest; the old one, 15 m off, goes after ones up to 60 m",
  );
  const [nearest, near, onlyHd] = list;
  close(nearest.distance, 12, 0.05);
  close(nearest.bearing, 180, 0.01);
  assert.equal(nearest.heading, 40, "headings wrap");
  assert.deepEqual([nearest.pitch, nearest.roll], [0, 0], "no tilt known: level");
  assert.deepEqual([near.pitch, near.roll], [3.5, -1.2]);
  assert.equal(nearest.sd, "https://pics.example/nearest/sd.jpg");
  assert.equal(onlyHd.sd, onlyHd.hd, "the large picture stands in for a missing small one");
  assert.equal(nearest.width, 5760, "the large picture's width, from the sensor's");
  assert.equal(nearest.author, "A. Mapper");
  assert.equal(nearest.license, "CC-BY-SA-4.0");
  assert.equal(nearest.licenseUrl, "https://creativecommons.org/licenses/by-sa/4.0/");
  assert.equal(nearest.page, "https://api.panoramax.xyz/#focus=pic&pic=nearest");
  assert.equal(nearest.taken, Date.parse("2025-07-08T12:00:00Z") / 1000);
  assert.deepEqual(photoCandidates({ features: [] }, HOME), []);
  assert.deepEqual(photoCandidates(null, HOME), []);
});

test("a photo taken with the Sun low or down goes after one taken by day", () => {
  const m = 1 / 111200;
  const collection = { features: [feature("dusk", { dLat: 5 * m, taken: "2025-01-01T16:30:00Z" }), feature("noon", { dLat: 40 * m, taken: "2025-01-01T11:30:00Z" })] };
  const sunElevation = (ms) => (new Date(ms).getUTCHours() === 16 ? -4 : 14);
  assert.deepEqual(photoCandidates(collection, { ...HOME, nowS: NOW_S, sunElevation }).map((p) => p.id), ["noon", "dusk"]);
  assert.deepEqual(photoCandidates(collection, { ...HOME, nowS: NOW_S }).map((p) => p.id), ["dusk", "noon"], "without the Sun, by distance");
});

test("findPhotos asks Panoramax without cookies or referrer, falls back without the 360° filter, and gives up on errors and delays", async () => {
  const asked = [];
  const answer = (status, body = { features: [feature("a", { dLat: 0.0001 })] }) => ({ ok: status === 200, status, json: async () => body });
  const ok = await findPhotos(HOME, {
    fetch: async (url, init) => {
      asked.push({ url, init });
      return answer(200);
    },
  });
  assert.deepEqual(ok.map((p) => p.id), ["a"]);
  assert.equal(asked[0].init.credentials, "omit");
  assert.equal(asked[0].init.referrerPolicy, "no-referrer");
  assert.match(asked[0].url, /filter=field_of_view%3D360/);
  asked.length = 0;
  const retried = await findPhotos(HOME, {
    fetch: async (url) => {
      asked.push({ url });
      return answer(url.includes("filter=") ? 400 : 200);
    },
  });
  assert.equal(asked.length, 2, "asked again without the filter");
  assert.doesNotMatch(asked[1].url, /filter=/);
  assert.equal(retried.length, 1);
  await assert.rejects(findPhotos(HOME, { fetch: async () => answer(503) }), /503/);
  // Too slow: aborted after the timeout.
  const slow = findPhotos(HOME, {
    timeoutMs: 20,
    fetch: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  });
  await assert.rejects(slow, /aborted/);
});

// ---- orientation ------------------------------------------------------------------

test("the picture's centre is its heading, east of it to the right, the zenith at the top", () => {
  const R = photoRotation({ heading: 30 });
  const [u, v] = photoUV(R, 30, 0);
  close(u, 0.5, 1e-12);
  close(v, 0.5, 1e-12);
  close(photoUV(R, 120, 0)[0], 0.75, 1e-12, "90° to the right");
  close(photoUV(R, 300, 0)[0], 0.25, 1e-12, "90° to the left");
  close(photoUV(R, 0, 90)[1], 0, 1e-9, "zenith");
  close(photoUV(R, 0, -90)[1], 1, 1e-9, "nadir");
  close(photoUV(R, 30, 45)[1], 0.25, 1e-12);
  // Every direction comes back.
  for (const [az, el] of [[0, 0], [123, 45], [359, -30], [200, 80], [77, -80]]) {
    for (const o of [{ heading: 30 }, { heading: 265, pitch: 5.9, roll: 0.1 }, { heading: 98, pitch: -7.2, roll: -10.4 }]) {
      const Ro = photoRotation(o);
      const [uu, vv] = photoUV(Ro, az, el);
      const back = photoDirection(Ro, uu, vv);
      close(((back.azimuth - az + 540) % 360) - 180, 0, 1e-6, `azimuth ${az}`);
      close(back.elevation, el, 1e-6, `elevation ${el}`);
    }
  }
});

test("a camera pitched up shows the horizon ahead below the middle, and behind it above (Panoramax's convention)", () => {
  // Checked against Panoramax's own viewer on real pictures: their pitch and roll level them so.
  const R = photoRotation({ heading: 0, pitch: 6 });
  close(photoUV(R, 0, 0)[1], 0.5 + 6 / 180, 1e-9, "ahead");
  close(photoUV(R, 180, 0)[1], 0.5 - 6 / 180, 1e-9, "behind");
  close(photoUV(R, 90, 0)[1], 0.5, 1e-9, "to the side, the horizon stays");
  const rolled = photoRotation({ heading: 0, roll: 10 });
  close(photoUV(rolled, 90, 0)[1], 0.5 - 10 / 180, 1e-9, "rolled right side down: the horizon on the right rises in the picture");
  const elev = pixelElevations(photoRotation({ heading: 0 }), 8, 4);
  [67.5, 22.5, -22.5, -67.5].forEach((want, row) => close(elev[row * 8], want, 1e-4, `row ${row}`));
});

test("the photo scene's rays are the planetarium's (sat-planetarium.js makeProjector)", () => {
  for (const view of [{ bearing: 0, pitch: 90 }, { bearing: 37, pitch: 120, roll: 4 }, { bearing: 250, pitch: 85 }, { bearing: 180, pitch: 178 }]) {
    const P = makeProjector({ ...view, fov: 60, width: 1200, height: 800 });
    const M = rayToWorld(view);
    for (const [px, py] of [[600, 400], [0, 0], [1199, 799], [300, 650]]) {
      const x = (px - P.cx) / P.f;
      const y = (py - P.cy) / P.f;
      const e = M[0] * x + M[1] * y + M[2];
      const n = M[3] * x + M[4] * y + M[5];
      const u = M[6] * x + M[7] * y + M[8];
      const az = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
      const el = (Math.atan2(u, Math.hypot(e, n)) * 180) / Math.PI;
      const want = P.unproject(px, py);
      close(((az - want.azimuth + 540) % 360) - 180, 0, 1e-9, `azimuth at ${px},${py}`);
      close(el, want.elevation, 1e-9, `elevation at ${px},${py}`);
    }
  }
});

// ---- the sky ------------------------------------------------------------------------

/**
 * A synthetic street panorama (level, heading 0): a sky that grows paler
 * towards the horizon, grey ground, a low brick building with dark windows,
 * a tall one with a window that shows the sky, and a white cloud in the sky.
 */
function streetPicture(width = 512, { night = false } = {}) {
  const height = width / 2;
  const data = new Uint8ClampedArray(width * height * 4);
  const R = photoRotation({ heading: 0 });
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 6;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { azimuth: az, elevation: el } = photoDirection(R, (x + 0.5) / width, (y + 0.5) / height);
      let c;
      if (el < 0) c = [92 + noise(), 90 + noise(), 94 + noise()];
      else {
        const t = el / 90;
        c = [170 - 110 * t, 200 - 90 * t, 236 - 36 * t];
      }
      const window = (cell) => (Math.floor(x / cell) % 2 === 0 && Math.floor(y / cell) % 2 === 0);
      if (az > 60 && az < 120 && el < 32) c = window(3) ? [32, 36, 46] : [122 + noise(), 84 + noise(), 68 + noise()];
      if (az > 200 && az < 240 && el < 55) {
        c = window(3) ? [30, 34, 44] : [110 + noise(), 104 + noise(), 98 + noise()];
        // A window that shows the sky, high up.
        if (az > 214 && az < 226 && el > 40 && el < 48) c = [120, 170, 225];
      }
      const dc = Math.hypot((((az - 300 + 540) % 360) - 180) * Math.cos((el * Math.PI) / 180), el - 50);
      if (dc < 6) c = [246, 246, 249];
      if (night) c = c.map((v) => v * 0.08);
      const i = 4 * (y * width + x);
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { image: { width, height, data }, R };
}

test("the sky is found: the open sky and a cloud in it, not the buildings, a window showing the sky, or the ground", () => {
  const { image, R } = streetPicture();
  const found = findSky(image, R);
  assert.ok(found.fraction > 0.35 && found.fraction < 0.5, `sky ${found.fraction}`);
  const sky = (az, el) => photoShowsSky(found, R, az, el);
  for (const [az, el] of [[0, 60], [150, 20], [330, 5], [0, 89], [300, 50], [90, 40], [220, 60]]) assert.ok(sky(az, el), `sky at ${az}, ${el}`);
  for (const [az, el] of [[90, 20], [90, 30], [220, 44], [220, 30], [10, -5], [180, -45]]) assert.ok(!sky(az, el), `not sky at ${az}, ${el}`);
  // Its colour by height, for the renderer: paler near the horizon.
  assert.ok(found.colour[44][0] > found.colour[5][0]);
});

test("a picture taken at night, or with no open sky, has no sky to show the planetarium through", () => {
  const { image, R } = streetPicture(256, { night: true });
  assert.equal(findSky(image, R).fraction, 0);
  // Under a roof: every pixel textured.
  const width = 256;
  const data = new Uint8ClampedArray(width * (width / 2) * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7919) % 255));
  assert.equal(findSky({ width, height: width / 2, data }, R).fraction, 0);
  assert.ok(MIN_SKY > 0, "and the scene refuses such a picture");
});

test("the renderer's textures: a softened sky, a band along its edge, and the colours either side", () => {
  const { image, R } = streetPicture();
  const found = findSky(image, R);
  const t = skyTextures(image, found);
  assert.equal(t.mask.length, image.width * image.height * 4);
  assert.equal(t.lowWidth, image.width / 4);
  const at = (az, el) => {
    const [u, v] = photoUV(R, az, el);
    return Math.min(image.height - 1, Math.floor(v * image.height)) * image.width + Math.min(image.width - 1, Math.floor(u * image.width));
  };
  const band = (az, el) => t.mask[4 * at(az, el) + 1];
  const soft = (az, el) => t.mask[4 * at(az, el)];
  assert.equal(soft(0, 60), 255, "open sky");
  assert.equal(soft(90, 15), 0, "the building");
  assert.equal(band(90, 32.3), 255, "the roofline is decided by colour");
  assert.equal(band(0, 60), 0);
  assert.equal(band(90, 15), 0);
  const low = (rgba, az, el) => {
    const [u, v] = photoUV(R, az, el);
    const i = Math.min(t.lowHeight - 1, Math.floor(v * t.lowHeight)) * t.lowWidth + Math.min(t.lowWidth - 1, Math.floor(u * t.lowWidth));
    return [rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]];
  };
  const skyNearRoof = low(t.skyColour, 90, 34);
  const wallNearRoof = low(t.otherColour, 90, 30);
  assert.ok(skyNearRoof[2] > 200 && skyNearRoof[2] > skyNearRoof[0], `sky by the roof is blue ${skyNearRoof}`);
  assert.ok(wallNearRoof[0] > wallNearRoof[2], `the wall by the roof is brick ${wallNearRoof}`);
});

test("what the photo hides of a path: behind the building, then in the open sky", () => {
  const { image, R } = streetPicture();
  const found = findSky(image, R);
  const data = { n: 5, t: [0, 10, 20, 30, 40], az: [90, 90, 90, 90, 90], el: [-3, 10, 25, 40, 70] };
  const hidden = hiddenByPhoto(found, R, data);
  assert.deepEqual([...hidden], [[10, true], [20, true], [30, false], [40, false]], "below the horizon is not asked about");
  assert.equal(hiddenByPhoto({ ...found, fraction: 0 }, R, data).size, 0, "no sky found: nothing said");
});

/**
 * A clear sky photographed with the camera facing 20° (its true heading),
 * with the Sun's glare at azimuth 200°, 30° up, and a sunlit white wall with
 * dark windows in the WNW, burnt out as white as the Sun.
 */
function sunnyPicture(width = 512, { overcast = false, sun = true } = {}) {
  const height = width / 2;
  const data = new Uint8ClampedArray(width * height * 4);
  const R = photoRotation({ heading: 20 });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { azimuth: az, elevation: el } = photoDirection(R, (x + 0.5) / width, (y + 0.5) / height);
      let c = el < 0 ? [90, 90, 92] : overcast ? [252, 252, 252] : [140 - el, 180 - el / 2, 235];
      const dAz = (((az - 200 + 540) % 360) - 180) * Math.cos((el * Math.PI) / 180);
      const d = Math.hypot(dAz, el - 30);
      if (sun && !overcast && el > 0) {
        if (d < 3.5) c = [255, 255, 255];
        else if (d < 9) c = c.map((v) => v + (250 - v) * (1 - (d - 3.5) / 5.5));
      }
      if (az > 290 && az < 320 && el > -10 && el < 30) c = Math.floor(x / 3) % 2 && Math.floor(y / 3) % 2 ? [40, 40, 50] : [252, 252, 252];
      const i = 4 * (y * width + x);
      data.set([c[0], c[1], c[2], 255], i);
    }
  }
  return { width, height, data };
}

test("the Sun in a photo turns it to face the right way; a white wall, a white sky or a low Sun do not", () => {
  const predicted = { azimuth: 200, elevation: 30 };
  const off = { heading: 0, pitch: 0, roll: 0 };
  const image = sunnyPicture();
  const found = findSky(image, photoRotation(off));
  const sun = findSun(image, photoRotation(off), predicted, found);
  assert.ok(sun, "the glare is found");
  close(sun.azimuth, 180, 1, "where the wrong heading puts it");
  close(sun.elevation, 30, 1);
  const turned = sunHeading(off, image, found, predicted);
  close(turned.turned, 20, 1, "turned by the heading's error");
  close(turned.heading, 20, 1);
  // A predicted elevation that does not match: the time or the patch is wrong.
  assert.equal(findSun(image, photoRotation(off), { azimuth: 200, elevation: 40 }, found), null);
  // The Sun low, near the buildings: not trusted.
  assert.equal(findSun(image, photoRotation(off), { azimuth: 200, elevation: 6 }, found), null);
  // No Sun in the picture: the white wall at 30° is not sky, so not taken for it.
  const noSun = sunnyPicture(512, { sun: false });
  const noSunSky = findSky(noSun, photoRotation(off));
  assert.equal(findSun(noSun, photoRotation(off), { azimuth: 305, elevation: 20 }, noSunSky), null);
  assert.deepEqual(sunHeading(off, noSun, noSunSky, predicted), { heading: 0, turned: 0 });
  // A white, overcast sky: nothing to tell the Sun by.
  const white = sunnyPicture(512, { overcast: true });
  assert.equal(findSun(white, photoRotation(off), predicted, findSky(white, photoRotation(off))), null);
});

// ---- the look ---------------------------------------------------------------------------

test("the photo is darkened, cooled and faded for the night, less so in twilight or by the Moon", () => {
  const day = photoLook({ elevation: 20 });
  const civil = photoLook({ elevation: -4 });
  const night = photoLook({ elevation: -30 });
  const moonlit = photoLook({ elevation: -30 }, { elevation: 40, fraction: 1 });
  assert.equal(day.exposure, 1);
  assert.equal(day.desaturate, 0);
  assert.deepEqual(day.tint, [1, 1, 1]);
  assert.ok(night.exposure < moonlit.exposure && moonlit.exposure < civil.exposure && civil.exposure < day.exposure);
  assert.ok(night.exposure > 0.03, "the street stays readable");
  assert.ok(night.desaturate > 0.7);
  assert.ok(night.tint[2] > 1 && night.tint[0] < 1, "cool");
  assert.ok(night.groundTo < night.groundFrom, "the ground fades in going down");
  assert.notEqual(night.key, day.key);
  assert.equal(photoLook({ elevation: -30.001 }).key, night.key, "quantised: tiny moves of the Sun change nothing");
});

// ---- the scene ------------------------------------------------------------------------

/** A PhotoScene on a fake canvas and WebGL, with fake pictures. */
function photoScene({ picture = streetPicture(512), status = 200, large = true, photo: extra = {}, sunAt = null } = {}) {
  const { gl, calls } = fakeGL();
  const listeners = new Map();
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    className: "",
    isConnected: true,
    setAttribute() {},
    addEventListener: (type, fn) => listeners.set(type, fn),
    getContext: (type) => (type === "webgl2" ? gl : null),
    remove() {
      this.isConnected = false;
    },
  };
  const container = { clientWidth: 800, clientHeight: 500, children: [], append: (c) => container.children.push(c) };
  const saved = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
  globalThis.document = { createElement: () => canvas };
  const decoded = [];
  globalThis.createImageBitmap = async (blob, options) => {
    decoded.push({ blob, options });
    return { width: blob.width, height: blob.height, close() {} };
  };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.w = w;
      this.h = h;
    }
    getContext() {
      return { drawImage() {}, getImageData: () => picture.image };
    }
  };
  const fetched = [];
  const fetch = async (url, init) => {
    fetched.push({ url, init });
    const big = url.includes("hd");
    return { ok: status === 200, status, blob: async () => ({ width: big ? 5760 : 2048, height: big ? 2880 : 1024 }) };
  };
  const photo = { id: "p", heading: 0, pitch: 0, roll: 0, sd: "https://pics.example/p/sd.jpg", hd: large ? "https://pics.example/p/hd.jpg" : "https://pics.example/p/sd.jpg", ...extra };
  const scene = new PhotoScene(container, { photo, view: { bearing: 0, pitch: 100, fov: 60 }, fetch, sunAt });
  const restore = () => Object.assign(globalThis, saved);
  return { scene, gl, calls, fetched, decoded, canvas, container, listeners, restore };
}

test("the scene loads the small picture, finds its sky, draws, then swaps in the large one", async () => {
  const s = photoScene();
  try {
    assert.equal(s.container.children.length, 1, "its canvas is in the container");
    assert.equal(s.canvas.width, 800 * Math.min(globalThis.devicePixelRatio || 1, 2));
    const found = await s.scene.load();
    assert.ok(found.fraction > 0.3);
    assert.equal(s.fetched[0].url, "https://pics.example/p/sd.jpg");
    assert.equal(s.fetched[0].init.referrerPolicy, "no-referrer");
    assert.ok(s.calls.some(([name]) => name === "drawArrays"), "drawn");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(s.fetched[1].url, "https://pics.example/p/hd.jpg");
    assert.ok(s.scene.large, "the large picture is up");
    const before = s.calls.filter(([n]) => n === "drawArrays").length;
    s.scene.setView({ bearing: 90 });
    assert.equal(s.calls.filter(([n]) => n === "drawArrays").length, before + 1, "a turn redraws at once");
    s.scene.setLook(s.scene.lookFor({ elevation: -5 }, null));
    s.scene.remove();
    assert.equal(s.canvas.isConnected, false);
    s.scene.render();
    assert.equal(s.calls.filter(([n]) => n === "drawArrays").length, before + 2, "nothing drawn once removed");
  } finally {
    s.restore();
  }
});

test("a Google panorama is put together from its tiles: the small one for the sky, then the large one", async () => {
  const s = photoScene();
  const drawn = [];
  const sizes = [];
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      sizes.push([w, h]);
      this.width = w;
      this.height = h;
    }
    getContext() {
      return { drawImage: (image, x, y, w, h) => drawn.push([this.width, x, y, w, h]), getImageData: () => streetPicture(512).image };
    }
  };
  const fetched = [];
  s.scene._fetch = async (url, init) => {
    fetched.push({ url, init });
    return { ok: true, status: 200, blob: async () => ({ width: 512, height: 512 }) };
  };
  s.scene._sunAt = () => {
    throw new Error("only the month is known: the Sun is not asked about");
  };
  s.scene.photo = {
    source: "google",
    id: "google:p",
    heading: 0,
    pitch: 0,
    roll: 0,
    taken: 1673740800,
    approximate: true,
    latitude: 52.37,
    longitude: 4.89,
    google: { panoId: "p", imageWidth: 16384, imageHeight: 8192, tileWidth: 512, tileHeight: 512, session: "s", key: "AIza" },
  };
  try {
    const found = await s.scene.load();
    assert.ok(found.fraction > 0.3);
    const sky = fetched.slice(0, 8);
    assert.ok(sky.every((f) => f.url.includes("/streetview/tiles/2/") && f.init.referrerPolicy === "strict-origin-when-cross-origin"), "zoom 2: 4 × 2 tiles for the sky");
    assert.ok(fetched.slice(8).every((f) => f.url.includes("/streetview/tiles/3/")), "and the large one on its way");
    assert.deepEqual(sizes[0], [2048, 1024]);
    assert.deepEqual(
      drawn.filter(([w]) => w === 2048).map(([, x, y]) => [x, y]),
      [[0, 0], [512, 0], [1024, 0], [1536, 0], [0, 512], [512, 512], [1024, 512], [1536, 512]],
      "each tile at its place, at its own size",
    );
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    // The fake GPU's limit is unknown: 4096, zoom 3.
    assert.equal(fetched.length, 8 + 32, "then zoom 3: 8 × 4 tiles");
    assert.ok(fetched.slice(8).every((f) => f.url.includes("/streetview/tiles/3/")));
    assert.ok(s.scene.large);
    assert.equal(s.scene.turned, 0);
  } finally {
    s.restore();
  }
});

test("a picture that is not 2:1, shows too little sky, or does not come is refused", async () => {
  const night = photoScene({ picture: streetPicture(256, { night: true }) });
  try {
    await assert.rejects(night.scene.load(), /too little sky/);
  } finally {
    night.restore();
  }
  const missing = photoScene({ status: 404 });
  try {
    await assert.rejects(missing.scene.load(), /404/);
  } finally {
    missing.restore();
  }
  const odd = photoScene();
  try {
    globalThis.createImageBitmap = async () => ({ width: 2048, height: 1114, close() {} });
    await assert.rejects(odd.scene.load(), /not an equirectangular picture/);
  } finally {
    odd.restore();
  }
});

test("the scene turns a photo to match the Sun in it, when it knows when and where it was taken", async () => {
  const asked = [];
  const sunAt = (ms, place) => (asked.push({ ms, place }), { azimuth: 200, elevation: 30 });
  const s = photoScene({ picture: { image: sunnyPicture() }, photo: { taken: 1751976000, latitude: 52.37, longitude: 4.89 }, sunAt });
  try {
    await s.scene.load();
    close(s.scene.turned, 20, 1);
    assert.deepEqual(asked, [{ ms: 1751976000000, place: { latitude: 52.37, longitude: 4.89 } }]);
    // The turned rotation puts the Sun where it was.
    const [u] = photoUV(s.scene.rotation, 200, 30);
    close((u - (0.5 + (200 - 20) / 360) + 1.5) % 1 - 0.5, 0, 0.004, "180° from the picture's centre, at its seam");
  } finally {
    s.restore();
  }
  // Without the time of the photo, it stays as it came.
  const unknown = photoScene({ picture: { image: sunnyPicture() }, sunAt });
  try {
    await unknown.scene.load();
    assert.equal(unknown.scene.turned, 0);
  } finally {
    unknown.restore();
  }
});
