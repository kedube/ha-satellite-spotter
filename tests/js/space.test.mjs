// Unit tests for the WebGL layers (sat-space.js): node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  circleRing,
  displayAltitudeKm,
  interpolatePositions,
  visibilityRadius,
} from "../../custom_components/satellite_spotter/frontend/sat-geo.js";
import {
  KIND_CODES,
  NightLayer,
  RIBBON_STYLES,
  SpaceLayer,
  buildRibbon,
  cloudFromCatalog,
  cloudPositions,
  loadCityLights,
  orbitSpans,
  toMercator,
} from "../../custom_components/satellite_spotter/frontend/sat-space.js";
import {
  COMPLETION_STATUS_KHR,
  GL,
  IDENTITY,
  anything,
  argsFor,
  draws,
  fakeGL,
  fakeMap,
  instancedDraws,
  uniformValues,
} from "./helpers/gl-fake.mjs";

const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);
const DEG = Math.PI / 180;
const ISS_M = 420000;

// SpaceLayer draws its sprites onto canvases.
globalThis.document ??= { createElement: () => ({ getContext: () => anything() }) };

test("points high above the ground stay in view past the limb, as far as the planet does not hide them", () => {
  const layer = new SpaceLayer();
  const D = 3.79; // camera distance in globe radii (the default view)
  layer._last = { main: IDENTITY, fallback: IDENTITY, plane: [0, 0, 1, -1 / D], transition: 1, globe: true };
  // Along the equator the angle from the camera axis (+z) is the longitude.
  assert.ok(layer.project(0, 85, ISS_M, 400, 400), "85 deg: in space beyond the limb, visible");
  assert.equal(layer.project(0, 100, ISS_M, 400, 400), null, "100 deg: behind the planet");
  // Brute force: the line of sight from the camera at (0, 0, D) must miss the unit sphere.
  const k = 1 + ISS_M / 6371008.8;
  const seen = (deg) => {
    const d = [Math.sin(deg * DEG) * k, 0, Math.cos(deg * DEG) * k - D];
    const t = Math.max(0, Math.min(1, (-D * d[2]) / (d[0] ** 2 + d[2] ** 2)));
    return Math.hypot(t * d[0], D + t * d[2]) >= 1;
  };
  for (let deg = 80; deg <= 100; deg += 0.25) {
    assert.equal(!!layer.project(0, deg, ISS_M, 400, 400), seen(deg), `${deg} deg at 420 km`);
  }
  // On the ground it is MapLibre's own clipping plane.
  for (let deg = 70; deg <= 80; deg += 0.1) {
    const inFront = Math.cos(deg * DEG) - 1 / D >= 0;
    assert.equal(!!layer.project(0, deg, 0, 400, 400), inFront, `${deg} deg on the ground`);
  }
});

test("on the globe the depth never puts a point in view in front of the near plane, however high; a hidden one is always past the far plane", () => {
  // projectAlt()'s own lines, from the vertex shader the GPU is given, run here: z / w for a point
  // `lifted` k globe radii from the centre, with MapLibre's clipping plane facing a camera D radii away.
  const { gl, created } = fakeGL();
  new SpaceLayer().prerender(gl, argsFor(true));
  const program = created.find(([name]) => name === "createProgram")[1];
  const source = program.shaders.find((s) => s.type === GL.VERTEX_SHADER).source;
  const line = (name) => source.match(new RegExp(`^\\s*(?:float )?${name.replace(".", "\\.")} = (.+);$`, "m"))[1];
  const depth = new Function(
    "k", "lifted", "u_projection_clipping_plane", "globePos",
    `const { max, min, sqrt } = Math;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const d = ${line("d")};
    const limit = ${line("limit")};
    return (${line("globePos.z")}) / globePos.w;`
  );
  const wrong = [];
  // Up to the highest apogee in the catalogue, from a camera close in to one far out (zoom 3.2 to 0).
  for (const km of [1, 420, 1000, 2000, 2500, 3000, 8000, 20200, 35786, 100000, 400000]) {
    const k = 1 + displayAltitudeKm(km) / 6371.0088;
    for (const D of [1.5, 2, 2.4, 3.79, 6, 9.5, 15.7, 20]) {
      for (let deg = 0; deg <= 180; deg += 0.5) {
        const p = [Math.sin(deg * DEG) * k, 0, Math.cos(deg * DEG) * k];
        const z = depth(k, p, { xyz: [0, 0, 1], w: -1 / D }, { w: 2.5 });
        // Brute force: how far the line of sight from the camera at (0, 0, D) passes from the planet.
        const v = [p[0], p[2] - D];
        const t = Math.max(0, Math.min(1, (-D * v[1]) / (v[0] ** 2 + v[1] ** 2)));
        const clearance = Math.hypot(t * v[0], D + t * v[1]) - 1;
        if (Math.abs(clearance) < 1e-9) continue; // grazing the limb
        const ok = clearance > 0 ? z >= -1 && z <= 1 : z > 1;
        if (!ok) wrong.push(`${km} km, ${deg} deg off the axis of a camera ${D} radii out: z/w ${z.toFixed(3)}`);
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 5), []);
});

test("on the flat map a point is placed on the copy of the world nearest the centre", () => {
  const layer = new SpaceLayer();
  // Clip x = 10 * (mercator x - 1.02): the view is centred on 187.2 E, past the antimeridian.
  const main = [10, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -10.2, 0, 0, 1];
  layer._last = { main, fallback: main, plane: [0, 0, 0, 0], transition: 0, globe: false, center: 1.02 };
  const east = layer.project(0, -179, 0, 200, 200); // mercator x 0.003, drawn at 1.003
  close(east.x, (10 * (1 + toMercator(0, -179)[0] - 1.02) * 0.5 + 0.5) * 200, 1e-6);
  const west = layer.project(0, 170, 0, 200, 200); // mercator x 0.972 is already the nearest
  close(west.x, (10 * (toMercator(0, 170)[0] - 1.02) * 0.5 + 0.5) * 200, 1e-6);
  // While the globe flattens into the map, the flat half uses that copy too (the camera looks along -z here).
  layer._last = { main: IDENTITY, fallback: main, plane: [0, 0, -1, 0], transition: 0.5, globe: true, center: 1.02 };
  const lon = -179;
  const [x] = toMercator(0, lon);
  const globeX = Math.sin(x * 2 * Math.PI + Math.PI);
  const flatX = 10 * (x + 1 - 1.02);
  close(layer.project(0, lon, 0, 200, 200).x, ((0.5 * globeX + 0.5 * flatX) * 0.5 + 0.5) * 200, 1e-6);
});

test("past the flat map's limit a point keeps its true latitude on the globe and sits on the map's edge when flat", () => {
  const layer = new SpaceLayer();
  const H = 2000;
  layer._last = { main: IDENTITY, fallback: IDENTITY, plane: [0, 0, 1, 0], transition: 1, globe: true };
  // Identity on the globe: screen y follows sin(latitude) on the unit sphere.
  close(layer.project(88, 0, 0, H, H).y, (0.5 - Math.sin(88 * DEG) * 0.5) * H, 1e-6, "88 N on the globe");
  assert.ok(layer.project(88, 0, 0, H, H).y < layer.project(85.05, 0, 0, H, H).y, "88 N is above the mercator limit");
  layer._last = { main: IDENTITY, fallback: IDENTITY, plane: [0, 0, 0, 0], transition: 0, globe: false, center: 0.5 };
  close(layer.project(88, 0, 0, H, H).y, layer.project(85.051129, 0, 0, H, H).y, 1e-6, "flat: on the edge");
  close(layer.project(-89, 30, 0, H, H).y, layer.project(-85.051129, 30, 0, H, H).y, 1e-6, "flat: south edge");
});

test("track rows over a pole keep their true latitude, so a polar orbit goes over the top of the globe", () => {
  const layer = new SpaceLayer();
  // A polar orbit: north along 10 E, over the pole and down 170 W.
  const rows = [80, 84, 88, 88, 84, 80].map((lat, i) => [i * 60, lat, i < 3 ? 10 : -170, 800, 1]);
  layer.setLine("orbit", rows, 0);
  const { data } = layer._ribbons.get("orbit");
  const latitude = (y) => (2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * y)) * 180) / Math.PI - 90;
  let top = -90;
  for (let i = 1; i < data.length; i += 12) top = Math.max(top, latitude(data[i]));
  close(top, 88, 1e-3, "highest point of the ribbon");
  assert.ok(data.every(Number.isFinite));
  // Satellites and ticks given through toMercator() go where their orbit does; the flat map's limit on request.
  assert.ok(toMercator(88, 10)[1] < 0, "past the flat map's top edge");
  close(latitude(toMercator(88, 10)[1]), 88, 1e-9);
  close(toMercator(88, 10, 85.051129)[1], 0, 1e-6);
  assert.ok(Number.isFinite(toMercator(90, 0)[1]) && Number.isFinite(toMercator(-90, 0)[1]));
});

test("ribbons are split at the antimeridian and the prime meridian into pieces of at most half a world", () => {
  const pts = [0.3, 0.45, 0.55, 0.7, 0.95, 0.05, 0.2].map((x, i) => [x, 0.4, 0, i * 10, 1]);
  const { data, segments } = buildRibbon(pts);
  assert.equal(segments.length, 3);
  const stride = 12;
  for (const [first, count, mid] of segments) {
    const xs = [];
    for (let v = first; v < first + count; v++) xs.push(data[v * stride]);
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 0.5 + 1e-6, `piece spans ${Math.max(...xs) - Math.min(...xs)}`);
    close(mid, (Math.max(...xs) + Math.min(...xs)) / 2, 1e-6);
  }
  // The cut at x = 0.5 is shared by both pieces, with the time interpolated.
  const endOfFirst = (segments[0][0] + segments[0][1] - 1) * stride;
  close(data[endOfFirst], 0.5, 1e-6);
  close(data[endOfFirst + 10], 15, 1e-4);
  close(data[segments[1][0] * stride], 0.5, 1e-6);
});

test("a ring numbers its points, so a dashed ring has dashes", () => {
  const layer = new SpaceLayer();
  const ring = circleRing(20, -60, 15, 24);
  layer.setRing("footprint", ring, 0);
  const { data, segments } = layer._ribbons.get("footprint");
  assert.equal(segments.length, 1);
  for (let i = 0; i < ring.length; i++) {
    close(data[i * 2 * 12 + 10], i, 1e-6);
    close(data[(i * 2 + 1) * 12 + 10], i, 1e-6);
  }
  // Across the prime meridian the cut gets an index between its neighbours.
  layer.setRing("footprint", circleRing(0, 0, 10, 8), 0);
  const r = layer._ribbons.get("footprint");
  assert.equal(r.segments.length, 3);
  const ts = Array.from({ length: r.data.length / 12 }, (_, v) => r.data[v * 12 + 10]);
  assert.ok(ts.every((t, i) => i === 0 || t >= ts[i - 1] - 1e-6), "indices only grow along the ring");
});

/**
 * Rasterise flat-map triangles [x, y, elevation, alpha] (mercator units, y clamped to the map)
 * and compare with the true circle around home.
 */
function rasterise(data, home, radiusDeg, W = 360) {
  const x0 = toMercator(home.latitude, home.longitude)[0];
  const [yLo, yHi] = home.latitude > 0 ? [0, 0.42] : [0.58, 1];
  const H = Math.round(W * (yHi - yLo));
  const hits = new Uint8Array(W * H);
  const clampY = (y) => Math.min(1, Math.max(0, y));
  for (let t = 0; t < data.length; t += 12) {
    const p = [data[t], clampY(data[t + 1])];
    const q = [data[t + 4], clampY(data[t + 5])];
    const r = [data[t + 8], clampY(data[t + 9])];
    const det = (q[1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1]);
    if (Math.abs(det) < 1e-15) continue;
    for (let j = 0; j < H; j++) {
      const y = yLo + (j + 0.5) / W;
      for (let i = 0; i < W; i++) {
        const x = x0 - 0.5 + (i + 0.5) / W;
        const a = ((q[1] - r[1]) * (x - r[0]) + (r[0] - q[0]) * (y - r[1])) / det;
        const b = ((r[1] - p[1]) * (x - r[0]) + (p[0] - r[0]) * (y - r[1])) / det;
        if (a >= 0 && b >= 0 && a + b <= 1) hits[j * W + i]++;
      }
    }
  }
  let inCap = 0, gaps = 0, outside = 0, overlaps = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const lat = (2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * (yLo + (j + 0.5) / W))) - Math.PI / 2) / DEG;
      const lon = (x0 - 0.5 + (i + 0.5) / W) * 360 - 180;
      const c = Math.sin(home.latitude * DEG) * Math.sin(lat * DEG) +
        Math.cos(home.latitude * DEG) * Math.cos(lat * DEG) * Math.cos((lon - home.longitude) * DEG);
      const inside = Math.acos(Math.min(1, c)) / DEG <= radiusDeg;
      const n = hits[j * W + i];
      if (inside) inCap++;
      if (inside && !n) gaps++;
      if (!inside && n) outside++;
      if (n > 1) overlaps++;
    }
  }
  return { inCap, gaps, outside, overlaps };
}

test("a cone around a pole gets a flat-map shape that fills its circle and nothing across the world", () => {
  const homes = [
    ["Longyearbyen", 78.22, 15.6, 10],
    ["Alert", 82.5, -62.35, 10],
    ["McMurdo", -77.85, 166.67, 10],
    ["Hammerfest, 0 deg mask", 70.66, 23.68, 0],
    ["80 N, 0 deg mask", 80, -40, 0],
  ];
  for (const [name, lat, lon, mask] of homes) {
    const home = { latitude: lat, longitude: lon };
    const radius = visibilityRadius(420, mask);
    const ring = circleRing(lat, lon, radius, 128);
    const layer = new SpaceLayer();
    layer.setCone(home, ring, ISS_M, radius);
    // The funnel for the globe is unchanged: one face per ring segment.
    assert.equal(layer._fills.get("cone").data.length, (ring.length - 1) * 12, name);
    const flat = layer._fills.get("coneFlat").data;
    assert.ok(flat.length > 0, `${name}: has a flat shape`);
    for (let t = 0; t < flat.length; t += 12) {
      const xs = [flat[t], flat[t + 4], flat[t + 8]];
      assert.ok(Math.max(...xs) - Math.min(...xs) < 0.5, `${name}: a face spans ${Math.max(...xs) - Math.min(...xs)} worlds`);
    }
    assert.ok(flat.every(Number.isFinite), name);
    const { inCap, gaps, outside, overlaps } = rasterise(flat, home, radius);
    assert.equal(overlaps, 0, `${name}: overlapping faces`);
    assert.ok(gaps / inCap < 0.003 && outside / inCap < 0.003, `${name}: gaps ${gaps}, outside ${outside} of ${inCap}`);
  }
});

test("on the globe a cone around a pole reaches over the top, past the flat map's edge", () => {
  const [lat, lon] = [78.22, 15.6]; // Longyearbyen
  const radius = visibilityRadius(420, 10);
  const ring = circleRing(lat, lon, radius, 128);
  const layer = new SpaceLayer();
  layer.setCone({ latitude: lat, longitude: lon }, ring, ISS_M, radius);
  layer.setRing("coneRing", ring, ISS_M);
  const latitude = (y) => (2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * y)) * 180) / Math.PI - 90;
  const highest = (data, stride) => {
    let top = -90;
    for (let i = 1; i < data.length; i += stride) top = Math.max(top, latitude(data[i]));
    return top;
  };
  // Across the pole from home, the ring is at 180 - lat - radius degrees.
  const far = 180 - lat - radius;
  assert.ok(far > 89, "the ring passes well beyond 85 degrees");
  assert.ok(Math.abs(highest(layer._fills.get("cone").data, 4) - far) < 0.01);
  assert.ok(Math.abs(highest(layer._ribbons.get("coneRing").data, 12) - far) < 0.01);
});

test("a cone away from the poles keeps the fan on the flat map too", () => {
  for (const [lat, lon] of [[39.74, -104.99], [-36.85, 174.76], [60, 10]]) {
    const layer = new SpaceLayer();
    const radius = visibilityRadius(420, 10);
    layer.setCone({ latitude: lat, longitude: lon }, circleRing(lat, lon, radius, 128), ISS_M, radius);
    assert.equal(layer._fills.get("coneFlat").data.length, 0);
    const fan = layer._fills.get("cone").data;
    for (let t = 0; t < fan.length; t += 12) {
      const xs = [fan[t], fan[t + 4], fan[t + 8]];
      assert.ok(Math.max(...xs) - Math.min(...xs) < 0.5, `${lat}, ${lon}`);
    }
  }
});

test("high orbits are drawn at their display altitude: lines, rings, cones, sprites and the CPU projection", () => {
  const GEO_M = 35786e3;
  const shown = displayAltitudeKm(35786) * 1000;
  assert.ok(shown > 6.5e6 && shown < 7e6, `${shown}`);
  const layer = new SpaceLayer();
  layer.setLine("orbit", [[0, 0, 0, 35786, 1], [60, 0, 1, 35786, 1]], 0);
  close(layer._ribbons.get("orbit").data[2], shown, 1, "line");
  layer.setRing("coneRing", circleRing(0, 0, 70, 8), GEO_M);
  close(layer._ribbons.get("coneRing").data[2], shown, 1, "ring");
  layer.setCone({ latitude: 0, longitude: 0 }, circleRing(0, 0, 70, 8), GEO_M, 70);
  close(layer._fills.get("cone").data[6], shown, 1, "cone rim");
  // Low orbits are drawn where they are.
  layer.setLine("orbit", [[0, 0, 0, 420, 1], [60, 0, 1, 420, 1]], 0);
  close(layer._ribbons.get("orbit").data[2], ISS_M, 1e-6, "low orbit");

  const { gl, calls } = fakeGL();
  layer.onAdd(fakeMap());
  layer.setFrame(spaceState({ objects: [{ kind: "satellite", primary: true, center: [0.5, 0.5, GEO_M], sunlit: true, size: 20 }] }));
  layer.render(gl, argsFor(true));
  close(uniformValues(calls, "u_center").at(-1)[2], shown, 1, "sprite");

  // The CPU projection uses the same altitude: identity matrices put a point at 30 E at x = sin(30) * k.
  layer._last = { main: IDENTITY, fallback: IDENTITY, plane: [0, 0, 1, 0], transition: 1, globe: true };
  const k = 1 + shown / 6371008.8;
  close(layer.project(0, 30, GEO_M, 1000, 1000).x, (0.5 * k * 0.5 + 0.5) * 1000, 1e-6, "project");
});

test("city lights: the bundled image first, then NASA's server, one image per width, retried after a failure", async () => {
  const requests = [];
  let fail = () => false;
  globalThis.Image = class {
    set src(url) {
      requests.push(url);
      this.naturalWidth = Number(/(\d+)\.jpg|WIDTH=(\d+)/.exec(url).slice(1).find(Boolean));
      setTimeout(() => (fail(url) ? this.onerror() : this.onload()));
    }
  };
  try {
    const small = await loadCityLights(2048);
    assert.ok(requests[0].endsWith("/frontend/img/black-marble-2016-2048.jpg"), requests[0]);
    assert.equal(small.naturalWidth, 2048);
    assert.equal(await loadCityLights(4096).then((img) => img.naturalWidth), 4096);
    assert.equal(loadCityLights(2048), loadCityLights(2048));
    assert.equal(requests.length, 2);

    // Without the bundled copy, NASA's map server.
    requests.length = 0;
    fail = (url) => url.includes("/img/");
    const fallback = await loadCityLights(1024);
    assert.equal(fallback.naturalWidth, 1024);
    assert.match(requests[1], /^https:\/\/gibs\.earthdata\.nasa\.gov\/.*WIDTH=1024&HEIGHT=512/);

    // Neither: null, and the next call tries again.
    requests.length = 0;
    fail = () => true;
    assert.equal(await loadCityLights(512), null);
    assert.equal(requests.length, 2);
    fail = () => false;
    assert.equal((await loadCityLights(512)).naturalWidth, 512);
    assert.equal(requests.length, 3);
  } finally {
    delete globalThis.Image;
  }
});

// -- rendering against a stand-in WebGL2 context --------------------------------

function spaceState(extra = {}) {
  return {
    now: 0,
    pixelRatio: 2,
    showTrack: true,
    showCone: true,
    showFootprint: true,
    iss: { center: [0.5, 0.5, ISS_M], ahead: [0.51, 0.5, ISS_M], ground: [0.5, 0.5, 0], sunlit: true, size: 20 },
    ticks: [],
    ...extra,
  };
}

const night = () => new NightLayer({ getState: () => ({ visible: true, sun: [1, 0, 0], strength: 1, lightsMix: 1 }) });

test("the layers are named for Satellite Spotter, so they never clash with ISS Tracker's", () => {
  assert.equal(night().id, "sat-night");
  assert.equal(new SpaceLayer().id, "sat-space");
  assert.equal(new SpaceLayer({ id: "other" }).id, "other");
});

test("shaders: every compile and link starts in prerender, before any status is asked for", () => {
  const { gl, calls } = fakeGL();
  const nightLayer = night();
  const space = new SpaceLayer();
  const map = fakeMap();
  nightLayer.onAdd(map);
  space.onAdd(map);
  const args = argsFor(true);
  nightLayer.prerender(gl, args);
  space.prerender(gl, args);
  assert.equal(calls.filter(([n]) => n === "linkProgram").length, 4);
  assert.equal(calls.filter(([n]) => n === "getProgramParameter").length, 0);
  space.setFrame(spaceState());
  nightLayer.render(gl, args);
  space.render(gl, args);
  assert.ok(draws(calls).length > 0);
  // A second frame builds nothing again.
  const links = calls.filter(([n]) => n === "linkProgram").length;
  nightLayer.prerender(gl, args);
  space.prerender(gl, args);
  assert.equal(calls.filter(([n]) => n === "linkProgram").length, links);
  // The cloud's program is built only once there is a cloud, and in prerender too.
  space.setCloud({ ids: [1], kinds: [0], mags: [0] });
  const status = calls.filter(([n]) => n === "getProgramParameter").length;
  space.prerender(gl, args);
  assert.equal(calls.filter(([n]) => n === "linkProgram").length, links + 1);
  assert.equal(calls.filter(([n]) => n === "getProgramParameter").length, status);
});

test("shaders: with parallel compiling a layer waits for the driver, without blocking, then draws", () => {
  const parallel = { COMPLETION_STATUS_KHR, done: false };
  const { gl, calls } = fakeGL({ parallel });
  const space = new SpaceLayer();
  const map = fakeMap();
  space.onAdd(map);
  space.setFrame(spaceState());
  space.setCloud({ ids: [1, 2], kinds: [0, 4], mags: [0, 3] });
  space.setCloudPositions(new Float32Array([0.5, 0.5, ISS_M, 1, 0.4, 0.4, ISS_M, 1]));
  const args = argsFor(true);
  space.prerender(gl, args);
  space.render(gl, args);
  assert.equal(draws(calls).length, 0);
  assert.equal(map.repaints, 1, "asks for another frame");
  assert.ok(!calls.some(([n, pname]) => n === "getProgramParameter" && pname === GL.LINK_STATUS), "no blocking query");
  parallel.done = true;
  space.render(gl, args);
  assert.ok(draws(calls).length > 0);
  assert.equal(instancedDraws(calls).length, 1);
});

test("shaders: a program that fails to build is reported once and its layer is skipped, not retried", () => {
  const { gl, calls } = fakeGL({ linkOk: false });
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const nightLayer = night();
    const map = fakeMap();
    nightLayer.onAdd(map);
    const args = argsFor(false);
    for (let i = 0; i < 3; i++) {
      nightLayer.prerender(gl, args);
      nightLayer.render(gl, args);
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^Satellite Spotter: a shader failed to build/);
    assert.match(errors[0], /link failed/);
    assert.equal(draws(calls).length, 0);
    assert.equal(map.repaints, 0);
  } finally {
    console.error = original;
  }
});

test("shaders: if the cloud's program fails, the cloud is left out and everything else is still drawn", () => {
  const { gl, calls } = fakeGL({ linkOk: (sources) => !sources.includes("a_flags") });
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const space = new SpaceLayer();
    const map = fakeMap();
    space.onAdd(map);
    space.setCloud({ ids: [1], kinds: [3], mags: [3] });
    space.setCloudPositions(new Float32Array([0.5, 0.5, ISS_M, 1]));
    space.setFrame(spaceState());
    const args = argsFor(true);
    for (let i = 0; i < 3; i++) {
      space.prerender(gl, args);
      space.render(gl, args);
    }
    assert.equal(errors.length, 1);
    assert.equal(instancedDraws(calls).length, 0);
    assert.ok(draws(calls).length >= 3 * 3, "the station and its lines, every frame");
    assert.equal(map.repaints, 0);
  } finally {
    console.error = original;
  }
});

test("widths and sizes follow the canvas's real pixel ratio, not the one asked for", () => {
  const { gl, calls } = fakeGL({ drawingBufferWidth: 4096 });
  const space = new SpaceLayer();
  space.onAdd(fakeMap({ cssWidth: 2560 })); // asked for 2x, clamped to 4096 px: 1.6
  space.setLine("orbit", [[0, 0, 0, 420, 1], [60, 1, 3, 420, 1]], 0);
  space.setFrame(spaceState({ pixelRatio: 2 }));
  space.render(gl, argsFor(false));
  const widths = uniformValues(calls, "u_width").map(([w]) => w);
  // The orbit's shadow, glow and core, then the line down from the station.
  const expected = [...RIBBON_STYLES.orbit.passes, ...RIBBON_STYLES.drop.passes].map((p) => p.width * 1.6);
  assert.equal(widths.length, expected.length);
  widths.forEach((w, i) => close(w, expected[i], 1e-9, `line ${i}`));
  close(uniformValues(calls, "u_size").at(-1)[0], 20 * 1.6, 1e-9, "station");
});

test("on the flat map every draw is repeated for each copy of the world in view", () => {
  const { gl, calls } = fakeGL();
  const nightLayer = night();
  nightLayer.onAdd(fakeMap({ west: -300, east: 250 })); // copies -1, 0 and 1
  nightLayer.render(gl, argsFor(false));
  const matrices = calls.filter(([n, loc]) => n === "uniformMatrix4fv" && loc.name === "u_projection_matrix").map(([, , , m]) => m);
  assert.deepEqual(matrices.slice(1).map((m) => m[12]), [-1, 0, 1]); // M x translate(w, 0, 0)
  assert.equal(draws(calls).length, 3);
});

test("while the globe flattens, each piece goes on the copy nearest the centre", () => {
  const { gl, calls } = fakeGL();
  const nightLayer = night();
  nightLayer.onAdd(fakeMap({ lng: 179 }));
  nightLayer.render(gl, argsFor(true, 0.5));
  // The night mesh starts half a world before the centre, on a cell boundary.
  const [offset] = uniformValues(calls, "u_offset").at(-1);
  const center = (179 + 180) / 360;
  assert.ok(offset <= center - 0.5 && offset > center - 0.5 - 1 / 96, `${offset}`);
  assert.equal(draws(calls).length, 1);

  // A line just east of the antimeridian is moved next to a centre just west of it.
  const space = new SpaceLayer();
  const s = fakeGL();
  space.onAdd(fakeMap({ lng: 179 }));
  space.setLine("orbit", [[0, 0, -179, 420, 1], [60, 1, -177, 420, 1]], 0);
  space.setFrame(spaceState({ showCone: false, showFootprint: false, iss: null }));
  space.render(s.gl, argsFor(true, 0.5));
  const firstDraw = s.calls.findIndex(([n]) => n === "drawArrays");
  const fallback = s.calls.slice(0, firstDraw).findLast(([n, loc]) => n === "uniformMatrix4fv" && loc.name === "u_projection_fallback_matrix");
  assert.equal(fallback[3][12], 1);
});

test("while the globe flattens, a cone around a pole is drawn on both sides of the meridian opposite home", () => {
  // 80 N 40 W with a 0 deg mask: the circle reaches 10 deg past the pole; the view is centred on 140 E.
  const home = { latitude: 80, longitude: -40 };
  const radius = visibilityRadius(420, 0);
  const space = new SpaceLayer();
  space.onAdd(fakeMap({ lng: 140 }));
  space.setCone(home, circleRing(80, -40, radius, 128), ISS_M, radius);
  space.setFrame(spaceState({ showTrack: false, showFootprint: false, iss: null }));
  const { gl, calls } = fakeGL();
  space.render(gl, argsFor(true, 0.5));
  // The flat half of every face drawn: moved by the fallback shift in force for its draw.
  const data = space._fills.get("coneFlat").data;
  const faces = [];
  let shift = 0;
  for (const [name, loc, ...a] of calls) {
    if (name === "uniformMatrix4fv" && loc.name === "u_projection_fallback_matrix") shift = a[1][12];
    if (name !== "drawArrays") continue;
    for (let v = a[0]; v < a[0] + a[1]; v += 3) {
      faces.push([0, 1, 2].map((k) => [data[(v + k) * 4] + shift, Math.min(1, Math.max(0, data[(v + k) * 4 + 1]))]));
    }
  }
  const inside = (x, y, [p, q, r]) => {
    const det = (q[1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1]);
    if (Math.abs(det) < 1e-15) return false; // flattened onto the edge of the map
    const a = ((q[1] - r[1]) * (x - r[0]) + (r[0] - q[0]) * (y - r[1])) / det;
    const b = ((r[1] - p[1]) * (x - r[0]) + (p[0] - r[0]) * (y - r[1])) / det;
    return a >= 0 && b >= 0 && a + b <= 1;
  };
  const center = (140 + 180) / 360;
  for (const lon of [139, 139.75, 140.25, 141]) {
    const [x, y] = toMercator(83, lon);
    const near = x + Math.round(center - x);
    assert.equal(faces.filter((f) => inside(near, y, f)).length, 1, `83 N ${lon} E`);
  }
});

test("on the flat map the satellite's nose follows its track across the antimeridian", () => {
  const { gl, calls } = fakeGL();
  const space = new SpaceLayer();
  space.onAdd(fakeMap({ lng: 179.6 }));
  space.setFrame(spaceState({
    objects: [{ kind: "iss", primary: true, center: [0.9989, 0.45, ISS_M], ahead: [0.0011, 0.449, ISS_M], ground: [0.9989, 0.45, 0], sunlit: true, size: 20 }],
  }));
  space.render(gl, argsFor(false));
  // The point ahead goes next to the satellite, not a world away to the west.
  const [x, y, z] = uniformValues(calls, "u_ahead").at(-1);
  close(x, 1.0011, 1e-9);
  assert.deepEqual([y, z], [0.449, ISS_M]);
});

test("the footprint is drawn only when it is switched on", () => {
  const space = new SpaceLayer();
  space.onAdd(fakeMap());
  space.setRing("footprint", circleRing(10, 60, 20), 0);
  const count = (showFootprint) => {
    const { gl, calls } = fakeGL();
    space.setFrame(spaceState({ showFootprint, showTrack: false, showCone: false, iss: null }));
    space.render(gl, argsFor(false));
    return draws(calls).length;
  };
  assert.equal(count(false), 0);
  assert.equal(count(true), 1);
});

test("browsers without roundRect still draw the station, with square corners", () => {
  const saved = globalThis.document;
  const ctx = () => new Proxy(function () {}, { get: (_, key) => (key === "roundRect" ? undefined : ctx()), apply: () => ctx() });
  globalThis.document = { createElement: () => ({ getContext: () => ctx() }) };
  try {
    const space = new SpaceLayer();
    space.onAdd(fakeMap());
    const { gl, calls } = fakeGL();
    space.setFrame(spaceState({ showTrack: false, showCone: false, showFootprint: false }));
    space.render(gl, argsFor(false));
    assert.ok(draws(calls).length > 0);
  } finally {
    globalThis.document = saved;
  }
});

// -- lines: the table of styles ----------------------------------------------------

const ROWS = [[0, 10, 20, 420, 1], [60, 11, 23, 421, 1], [120, 12, 26, 422, 0]];
/** The widths drawn this frame, in order, in CSS px. */
function widthsDrawn(space, state, args = argsFor(true)) {
  const { gl, calls } = fakeGL({ drawingBufferWidth: 800 });
  space.setFrame(state);
  space.render(gl, args);
  return uniformValues(calls, "u_width").map(([w]) => Math.round(w * 1000) / 1000);
}
const widthsOf = (...styles) => styles.flatMap((s) => RIBBON_STYLES[s].passes.map((p) => p.width));
const plain = spaceState({ iss: null, showTrack: true, showCone: true, showFootprint: true });

test("lines are drawn bottom to top by their style, whatever order they were set in", () => {
  const space = new SpaceLayer();
  space.onAdd(fakeMap());
  space.setLine("pass", ROWS, 0);
  space.setLine("member:45000", ROWS, 0, { style: "member" });
  space.setLine("approach", ROWS, 0);
  space.setLine("orbit", ROWS, 0);
  space.setLine("mystery", ROWS, 0, { style: "no such style" });
  assert.deepEqual(widthsDrawn(space, plain), widthsOf("orbit", "skyline", "approach", "member", "pass"));
  // Lines a frame flag hides.
  assert.deepEqual(widthsDrawn(space, { ...plain, showTrack: false }), widthsOf("skyline", "approach", "member", "pass"));
  // The member style is thin gold.
  const [glow, core] = RIBBON_STYLES.member.passes;
  assert.ok(glow.soft && core.width < RIBBON_STYLES.pass.passes[1].width);
  assert.ok(core.color[0] > 0.9 && core.color[2] < 0.5, "gold");
});

test("lines can be removed one by one or by prefix, and their buffers are freed on the next frame", () => {
  const space = new SpaceLayer();
  space.onAdd(fakeMap());
  for (const id of [1, 2, 3]) space.setLine(`member:${id}`, ROWS, 0, { style: "member" });
  space.setLine("pass", ROWS, 0);
  const first = fakeGL();
  space.setFrame(plain);
  space.render(first.gl, argsFor(true));
  const vaoOf = (name) => space._ribbons.get(name).vao;
  const gone = [vaoOf("member:2")];
  space.removeLine("member:2");
  space.removeLine("never set");
  assert.deepEqual(widthsDrawn(space, plain), widthsOf("member", "member", "pass"));
  gone.push(vaoOf("member:1"), vaoOf("member:3"));
  space.clearLines("member:");
  const { gl, calls } = fakeGL();
  space.render(gl, argsFor(true));
  assert.deepEqual(
    calls.filter(([n]) => n === "deleteVertexArray").map(([, vao]) => vao),
    gone.slice(1),
    "member:1 and member:3 freed now (member:2 was freed the frame before)"
  );
  assert.deepEqual([...space._ribbons.keys()], ["pass"]);
});

test("an earlier caller's fourth argument, the elevation, still works", () => {
  const space = new SpaceLayer();
  space.setLine("drop", ROWS, 0, 0);
  const { data } = space._ribbons.get("drop");
  for (let v = 0; v < data.length / 12; v++) assert.equal(data[v * 12 + 2], 0);
  assert.equal(space._ribbons.get("drop").style, "drop");
  space.setLine("orbit", ROWS, 0, null);
  close(space._ribbons.get("orbit").data[2], 420000, 1e-6);
});

test("the orbit fades over spans from the focus satellite's period", () => {
  const space = new SpaceLayer();
  space.onAdd(fakeMap());
  space.setLine("orbit", ROWS, 0);
  const spansDrawn = (spans) => {
    const { gl, calls } = fakeGL();
    space.setFrame({ ...plain, spans });
    space.render(gl, argsFor(true));
    return [uniformValues(calls, "u_past_span").at(-1)[0], uniformValues(calls, "u_future_span").at(-1)[0]];
  };
  assert.deepEqual(spansDrawn(undefined), [2400, 5700], "the ISS's");
  const tiangong = orbitSpans(5550);
  close(tiangong.past, 0.43 * 5550, 1e-9);
  close(tiangong.future, 1.02 * 5550, 1e-9);
  const high = orbitSpans(37000); // a rocket body on its way to geostationary orbit
  assert.deepEqual(spansDrawn(high), [high.past, high.future]);
  assert.deepEqual(spansDrawn({ past: 0, future: Number.NaN }), [2400, 5700], "nonsense falls back");
  assert.deepEqual(orbitSpans(undefined), { past: 2400, future: 5700 });
});

// -- satellites as sprites -------------------------------------------------------------

test("the primary gets its shadow, a glow in sunlight and a sprite of its kind; the others a glow and a sprite or a dot", () => {
  const space = new SpaceLayer();
  space.onAdd(fakeMap());
  const at = (x) => [x, 0.4, 550e3];
  const objects = [
    { id: 1, kind: "starlink", primary: true, center: at(0.5), ahead: at(0.51), ground: [0.5, 0.4, 0], sunlit: true, size: 22 },
    { id: 2, kind: "starlink", center: at(0.48), ahead: at(0.49), sunlit: true, size: 12 },
    { id: 3, kind: "starlink", center: at(0.46), sunlit: false, size: 5 },
  ];
  const { gl, calls } = fakeGL();
  space.setFrame({ ...plain, objects });
  space.render(gl, argsFor(true));
  // Textures are drawn once per kind: the Starlink sprite, the glow and the dot.
  assert.equal(calls.filter(([n]) => n === "texImage2D").length, 3);
  const sizes = uniformValues(calls, "u_size").map(([s]) => s / 2); // drawn at 2 device px per CSS px
  // Member 2: glow and sprite; member 3: glow and dot; the primary: shadow, glow, sprite (last, on top).
  assert.deepEqual(sizes, [12 * 1.7, 12, 5 * 1.7, 5, 6, 22 * 1.9, 22]);
  assert.deepEqual(uniformValues(calls, "u_orient").map(([o]) => o), [0, 1, 0, 0, 0, 0, 1]);
  // In Earth's shadow, dimmer.
  assert.ok(uniformValues(calls, "u_opacity")[3][0] < 1);
  // The next frame draws with the same textures.
  const again = fakeGL();
  space.render(again.gl, argsFor(true));
  assert.equal(again.calls.filter(([n]) => n === "texImage2D").length, 0);
});

test("rocket bodies and debris are drawn upright, not turned along their motion", () => {
  for (const kind of ["rocket", "debris"]) {
    const space = new SpaceLayer();
    space.onAdd(fakeMap());
    const { gl, calls } = fakeGL();
    space.setFrame({ ...plain, objects: [{ kind, primary: true, center: [0.5, 0.5, ISS_M], ahead: [0.6, 0.5, ISS_M], sunlit: true, size: 20 }] });
    space.render(gl, argsFor(true));
    assert.equal(uniformValues(calls, "u_orient").at(-1)[0], 0, kind);
  }
});

test("the line down to the ground is the primary's own, unless the view gives one", () => {
  const space = new SpaceLayer();
  space.onAdd(fakeMap());
  const primary = { kind: "iss", primary: true, center: [0.3, 0.4, 37000e3], ground: [0.3, 0.4, 0], sunlit: true, size: 20 };
  assert.deepEqual(widthsDrawn(space, { ...plain, objects: [primary] }), widthsOf("drop"));
  const { data, segments } = space._drop;
  assert.equal(segments.length, 1);
  close(data[2], 0, 1e-9, "foot");
  close(data[12 * 2 + 2], displayAltitudeKm(37000) * 1000, 1, "top, at the display altitude");
  // A frame without a primary has no line down; a view that sets "drop" itself gets that one only.
  assert.deepEqual(widthsDrawn(space, { ...plain, objects: [] }), []);
  space.setLine("drop", [[0, 1, 2, 0, 1], [0, 1, 2, 420, 1]], 0);
  assert.deepEqual(widthsDrawn(space, { ...plain, objects: [primary] }), widthsOf("drop"));
});

test("the earlier `iss` frame key still draws the station as the primary object", () => {
  const space = new SpaceLayer();
  space.onAdd(fakeMap());
  const { gl, calls } = fakeGL();
  space.setFrame(spaceState());
  space.render(gl, argsFor(true));
  assert.deepEqual(uniformValues(calls, "u_size").map(([s]) => s / 2), [6, 20 * 1.9, 20]);
  assert.deepEqual(uniformValues(calls, "u_orient").at(-1), [1]);
});

// -- the cloud of every satellite ---------------------------------------------------------

/** Mercator position at a display altitude, lit or not. */
const cloudPoint = (lat, lon, altM, lit = 1) => [...toMercator(lat, lon, 89.9999), altM, lit];

function cloudLayer(map = fakeMap()) {
  const space = new SpaceLayer();
  space.onAdd(map);
  space.setCloud({ ids: [25544, 44713, 22285], kinds: [KIND_CODES.iss, KIND_CODES.starlink, KIND_CODES.rocket], mags: [-2.3, 3.3, 3.4] });
  space.setCloudPositions(new Float32Array([...cloudPoint(10, 20, ISS_M), ...cloudPoint(-30, 60, 550e3, 0), ...cloudPoint(0, -40, 6.7e6)]));
  space.setFrame({ ...plain, iss: null, showTrack: false, showCone: false, showFootprint: false });
  return space;
}

/** For each instanced draw: [the projection matrix in force, first, count, instances]. */
function cloudDraws(calls) {
  let matrix = null;
  const out = [];
  for (const [name, loc, ...a] of calls) {
    if (name === "uniformMatrix4fv" && loc.name === "u_projection_matrix") matrix = a[1];
    if (name === "drawArraysInstanced") out.push([matrix, a[0], a[1], a[2]]);
  }
  return out;
}

test("the cloud is one instanced draw per copy of the world in view, four corners per satellite", () => {
  const space = cloudLayer(fakeMap({ west: -300, east: 250 })); // copies -1, 0 and 1
  const { gl, calls } = fakeGL();
  space.prerender(gl, argsFor(false));
  space.render(gl, argsFor(false));
  const drawn = cloudDraws(calls);
  assert.deepEqual(drawn.map(([m]) => m[12]), [-1, 0, 1]);
  for (const [, first, count, instances] of drawn) assert.deepEqual([first, count, instances], [0, 4, 3]);
  // The corners are shared; position, look, colour and flags advance once per satellite.
  const divisors = calls.filter(([n]) => n === "vertexAttribDivisor").map(([, loc, d]) => [loc, d]);
  assert.deepEqual(divisors, [[1, 1], [2, 1], [3, 1], [4, 1]]);
  const pointer = (loc) => calls.find(([n, l]) => n === "vertexAttribPointer" && l === loc);
  assert.deepEqual(pointer(1).slice(2, 4), [4, gl.FLOAT]);
  assert.deepEqual(pointer(3).slice(2, 5), [4, gl.UNSIGNED_BYTE, true], "colour, normalised bytes");
  assert.deepEqual(pointer(4).slice(2, 5), [1, gl.UNSIGNED_BYTE, false], "flags, as numbers");

  // On the globe a single draw: each satellite finds the copy nearest the centre itself.
  const globe = cloudLayer(fakeMap({ lng: 170 }));
  const g = fakeGL();
  globe.render(g.gl, argsFor(true, 0.5));
  assert.equal(cloudDraws(g.calls).length, 1);
  close(uniformValues(g.calls, "u_center_x").at(-1)[0], (170 + 180) / 360, 1e-9);
  const fallback = g.calls.findLast(([n, loc]) => n === "uniformMatrix4fv" && loc.name === "u_projection_fallback_matrix");
  assert.equal(fallback[3][12], 0, "not shifted as a whole");
});

test("the cloud keeps its looks from the catalogue: size and brightness by magnitude, colour and glyph by kind", () => {
  const space = cloudLayer();
  const { style, color } = space._cloud;
  const radius = (i) => style[i * 4];
  assert.ok(radius(0) > radius(1) && radius(1) > radius(2) * 0.9, "the ISS is the biggest");
  assert.deepEqual([style[1], style[5], style[9]], [KIND_CODES.iss, KIND_CODES.starlink, KIND_CODES.rocket], "glyph layers");
  assert.ok(style[2] >= style[6], "brighter is more opaque");
  assert.deepEqual([...color.slice(0, 3)], [252, 212, 77], "the ISS in gold");
  assert.notDeepEqual([...color.slice(4, 7)], [...color.slice(8, 11)], "Starlink and rocket bodies differ");
  // Unknown kind codes are drawn as satellites.
  space.setCloud({ ids: [1], kinds: [99], mags: [Number.NaN] });
  assert.equal(space._cloud.style[1], KIND_CODES.satellite);
  assert.ok(Number.isFinite(space._cloud.style[0]));
});

test("cloud positions are uploaded once per change into a buffer made once, and a missing one is hidden", () => {
  const space = cloudLayer();
  const frame = () => {
    const { gl, calls } = fakeGL();
    space.render(gl, argsFor(true));
    return calls;
  };
  const first = frame();
  const room = first.filter(([n, , size]) => n === "bufferData" && size === 3 * 16);
  assert.equal(room.length, 1, "room for three");
  assert.equal(room[0][3], GL.DYNAMIC_DRAW);
  assert.equal(first.filter(([n]) => n === "bufferSubData").length, 1);
  assert.equal(frame().filter(([n]) => n === "bufferSubData").length, 0, "nothing new: no upload");
  space.setCloudPositions(new Float32Array([...cloudPoint(10, 21, ISS_M), Number.NaN, Number.NaN, Number.NaN, 0, ...cloudPoint(0, -40, 6.7e6)]));
  const next = frame();
  const uploads = next.filter(([n]) => n === "bufferSubData");
  assert.equal(uploads.length, 1);
  const data = uploads[0][3];
  assert.deepEqual([...data.slice(4, 8)], [0, 0, -1, 0], "no position: marked for the shader to skip");
  assert.ok(data.every(Number.isFinite));
  // Fewer positions than satellites: only those are drawn.
  space.setCloudPositions(new Float32Array(cloudPoint(10, 22, ISS_M)));
  const fewer = frame();
  assert.equal(instancedDraws(fewer)[0][4], 1);
  // Hidden as a whole, and back.
  space.setCloudPositions(null, { visible: false });
  assert.equal(instancedDraws(frame()).length, 0);
  space.setCloudPositions(null, { visible: true });
  assert.equal(instancedDraws(frame()).length, 1);
});

test("cloud flags are uploaded when they change and say when the cloud moves by itself", () => {
  const space = cloudLayer();
  space.render(fakeGL().gl, argsFor(true));
  assert.equal(space.animating, false);
  space.setCloudFlags(new Uint8Array([1, 4 | 8, 2]));
  const { gl, calls } = fakeGL();
  space.render(gl, argsFor(true));
  const flagUploads = calls.filter(([n, , data]) => n === "bufferData" && data instanceof Uint8Array && data.length === 3);
  assert.equal(flagUploads.length, 1);
  assert.deepEqual([...flagUploads[0][2]], [1, 12, 2]);
  assert.equal(space.animating, true, "a ring breathes around a satellite visible now");
  space.setFrame({ ...plain, reducedMotion: true });
  assert.equal(space.animating, false, "not with reduced motion");
  assert.equal(uniformValues((() => {
    const f = fakeGL();
    space.render(f.gl, argsFor(true));
    return f.calls;
  })(), "u_pulse").at(-1)[0], 0);
  space.setFrame(plain);
  space.setCloudFlags([5]); // a plain array, shorter than the cloud; visible now but hidden
  assert.deepEqual([...space._cloud.flags], [5, 0, 0]);
  assert.equal(space.animating, false);
});

test("a new catalogue keeps the cloud's positions only when it has the same satellites", () => {
  const space = cloudLayer();
  space.setCloudFlags(new Uint8Array([0, 8, 0]));
  const pos = space._cloud.pos;
  space.setCloud({ ids: [25544, 44713, 22285], kinds: [0, 4, 5], mags: [-2.3, 3.3, 3.4] });
  assert.equal(space._cloud.pos, pos);
  assert.equal(space._cloud.count, 3);
  assert.deepEqual([...space._cloud.flags], [0, 8, 0]);
  space.setCloud({ ids: [25544, 99999, 22285], kinds: [0, 3, 5], mags: [-2.3, 3, 3.4] });
  assert.equal(space._cloud.count, 0, "no positions until the next setCloudPositions()");
  assert.deepEqual([...space._cloud.flags], [0, 0, 0]);
});

test("pick() finds the satellite under the pointer from the last frame's matrices", () => {
  const space = cloudLayer();
  const W = 1000;
  // Globe, identity: screen x, y follow the unit sphere (+z faces the camera at 0, 0).
  space._last = { main: IDENTITY, fallback: IDENTITY, plane: [0, 0, 1, 0], transition: 1, globe: true, center: 0.5 };
  const iss = space.projectMercator(...space._cloud.pos.slice(0, 3), W, W);
  const starlink = space.projectMercator(...space._cloud.pos.slice(4, 7), W, W);
  assert.ok(iss && starlink);
  assert.equal(space.pick(iss.x, iss.y, W, W), 0);
  assert.equal(space.pick(starlink.x + 6, starlink.y - 6, W, W), 1);
  assert.equal(space.pick(starlink.x + 30, starlink.y, W, W), -1, "too far");
  assert.equal(space.pick(starlink.x + 30, starlink.y, W, W, 40), 1, "a wider reach");
  // The nearest of two.
  const mid = { x: (iss.x * 3 + starlink.x) / 4, y: (iss.y * 3 + starlink.y) / 4 };
  assert.equal(space.pick(mid.x, mid.y, W, W, 1e4), 0);
  // A hidden satellite (flag 1, such as the focus satellite drawn as a sprite) is never picked.
  space.setCloudFlags(new Uint8Array([1, 0, 0]));
  assert.notEqual(space.pick(iss.x, iss.y, W, W, 4), 0);
  // A hovered one is drawn bigger, so it is picked further out.
  space.setCloudFlags(new Uint8Array([0, 2, 0]));
  assert.equal(space.pick(starlink.x + 14, starlink.y, W, W, 4), 1);
  // Nothing without a cloud on screen.
  space.setCloudPositions(null, { visible: false });
  assert.equal(space.pick(iss.x, iss.y, W, W), -1);
  assert.equal(new SpaceLayer().pick(0, 0, W, W), -1);
});

test("pick() skips satellites behind the globe and without a position", () => {
  const space = new SpaceLayer();
  space.setCloud({ ids: [1, 2], kinds: [3, 3], mags: [3, 3] });
  // The same screen point: one in front (0 E), one behind the planet (180 E, on the ground).
  space.setCloudPositions(new Float32Array([...cloudPoint(0, 0, 0), ...cloudPoint(0, 180, 0)]));
  space._last = { main: IDENTITY, fallback: IDENTITY, plane: [0, 0, 1, -0.25], transition: 1, globe: true, center: 0.5 };
  assert.equal(space.pick(500, 500, 1000, 1000), 0);
  space.setCloudFlags([1, 0]);
  assert.equal(space.pick(500, 500, 1000, 1000), -1, "the one behind the globe is not picked");
  space.setCloudPositions(new Float32Array([Number.NaN, 0, 0, 0, ...cloudPoint(0, 180, 0)]));
  space.setCloudFlags([0, 0]);
  assert.equal(space.pick(500, 500, 1000, 1000), -1);
});

test("on a flat map showing the world more than once, pick() finds a satellite on every copy the cloud is drawn on", () => {
  const space = new SpaceLayer();
  space.setCloud({ ids: [1], kinds: [3], mags: [3] });
  space.setCloudPositions(new Float32Array(cloudPoint(0, -144, 0))); // mercator x 0.1
  space.setFrame({ ...plain, iss: null, showTrack: false, showCone: false, showFootprint: false });
  const W = 1000;
  const y = (0.5 - 0.5 * 0.5) * W; // the equator: mercator y 0.5
  // Clip x = s (x - 0.5): a view centred on the world, 4 and then 10 worlds wide (the cloud stops at 3 copies out).
  for (const [s, drawn] of [[0.5, [-2, -1, 0, 1, 2]], [0.2, [-3, -2, -1, 0, 1, 2, 3]]]) {
    space.onAdd(fakeMap({ west: (0.5 - 1 / s) * 360 - 180, east: (0.5 + 1 / s) * 360 - 180 }));
    const main = [s, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.5 * s, 0, 0, 1];
    const args = argsFor(false);
    Object.assign(args.defaultProjectionData, { mainMatrix: main, fallbackMatrix: main });
    const { gl, calls } = fakeGL();
    space.render(gl, args);
    assert.deepEqual(cloudDraws(calls).map(([m]) => Math.round(m[12] / s + 0.5) + 0), drawn, `${2 / s} worlds`);
    for (let copy = -4; copy <= 4; copy++) {
      const x = (s * (0.1 + copy - 0.5) * 0.5 + 0.5) * W;
      if (x < 0 || x > W) continue;
      assert.equal(space.pick(x, y, W, W), drawn.includes(copy) ? 0 : -1, `copy ${copy} of ${2 / s} worlds`);
    }
    assert.equal(space.pick(W / 2, y, W, W), -1);
  }
});

test("cloudFromCatalog() and cloudPositions() turn the websocket payloads into setCloud()/setCloudPositions() input", () => {
  const catalog = {
    satellites: [
      { norad_id: 25544, name: "ISS", kind: "iss", magnitude: -2.3 },
      { norad_id: 44713, name: "Starlink 1007", kind: "starlink", magnitude: 3.3 },
    ],
  };
  const cloud = cloudFromCatalog(catalog, [44713, 25544, 1234]);
  assert.deepEqual([...cloud.ids], [44713, 25544, 1234]);
  assert.deepEqual([...cloud.kinds], [KIND_CODES.starlink, KIND_CODES.iss, KIND_CODES.satellite]);
  close(cloud.mags[0], 3.3, 1e-6);
  assert.equal(cloud.mags[2], 5, "unknown: faint");

  const payload = {
    start: 1000, step: 60, count: 2, ids: [25544, 1, 2],
    pos: [[10, 20, 420, 11, 22, 421], [null, null, null, null, null, null], [80, 0, 35786, 82, 10, 35786]],
    lit: ["11", "00", "01"],
  };
  const geo = interpolatePositions(payload, 1030);
  const out = cloudPositions(geo);
  const [x, y] = toMercator(geo[0], geo[1], 89.9999);
  close(out[0], x, 1e-6);
  close(out[1], y, 1e-6);
  close(out[2], 420500, 1);
  close(out[3], 1, 1e-6);
  assert.ok(Number.isNaN(out[6]), "no position");
  close(out[10], displayAltitudeKm(35786) * 1000, 1, "display altitude");
  close(out[11], 0.5, 1e-6, "half way out of the shadow");
  // An array to reuse.
  const again = cloudPositions(geo, out);
  assert.equal(again, out);
});

test("onRemove frees every buffer, vertex array, texture and program the layer made", () => {
  const space = new SpaceLayer();
  space.onAdd(fakeMap());
  const { gl, calls, created } = fakeGL();
  space.setLine("orbit", ROWS, 0);
  space.setLine("member:1", ROWS, 0, { style: "member" });
  const radius = visibilityRadius(420, 10);
  space.setCone({ latitude: 40, longitude: -70 }, circleRing(40, -70, radius, 64), ISS_M, radius);
  space.setRing("coneRing", circleRing(40, -70, radius, 64), ISS_M);
  space.setCloud({ ids: [1, 2], kinds: [0, 5], mags: [0, 3] });
  space.setCloudPositions(new Float32Array([0.5, 0.5, ISS_M, 1, 0.4, 0.4, ISS_M, 0]));
  space.setFrame({
    ...plain,
    ticks: [[0.5, 0.5, ISS_M]],
    objects: [
      { kind: "iss", primary: true, center: [0.5, 0.5, ISS_M], ground: [0.5, 0.5, 0], sunlit: true, size: 20 },
      { kind: "starlink", center: [0.4, 0.4, ISS_M], sunlit: true, size: 12 },
    ],
  });
  space.prerender(gl, argsFor(true));
  space.render(gl, argsFor(true));
  space.removeLine("member:1");
  space.onRemove(null, gl);
  const deleted = new Set(calls.filter(([n]) => /^delete(Buffer|VertexArray|Texture|Program)$/.test(n)).map(([, obj]) => obj));
  const kept = created.filter(([kind, obj]) => !kind.endsWith("Shader") && !deleted.has(obj));
  assert.deepEqual(kept, []);
  assert.ok(created.some(([kind]) => kind === "createTexture") && created.some(([kind]) => kind === "createVertexArray"));
  // Added again (MapLibre does so after a style change), it uploads everything anew.
  const again = fakeGL();
  space.prerender(again.gl, argsFor(true));
  space.render(again.gl, argsFor(true));
  assert.ok(again.calls.filter(([n]) => n === "texStorage3D").length === 1);
  assert.ok(instancedDraws(again.calls).length === 1);
  assert.ok(draws(again.calls).length > 5);
});

test("the cloud's glyphs are one texture array of 128 px layers, one per kind, made once", () => {
  const space = cloudLayer();
  const { gl, calls } = fakeGL();
  space.render(gl, argsFor(true));
  const storage = calls.filter(([n]) => n === "texStorage3D");
  assert.equal(storage.length, 1);
  assert.deepEqual(storage[0].slice(2, 7), [8, gl.RGBA8, 128, 128, Object.keys(KIND_CODES).length]);
  const layers = calls.filter(([n]) => n === "texSubImage3D").map((c) => c[5]);
  assert.deepEqual(layers, Object.values(KIND_CODES).sort());
  const premultiply = calls.filter(([n, pname]) => n === "pixelStorei" && pname === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL).map((c) => c[2]);
  assert.deepEqual(premultiply, [true, false], "premultiplied, then back to MapLibre's default");
  assert.ok(calls.some(([n, target]) => n === "generateMipmap" && target === gl.TEXTURE_2D_ARRAY));
  assert.ok(calls.some(([n, target, tex]) => n === "bindTexture" && target === gl.TEXTURE_2D_ARRAY && tex === null), "unbound after drawing");
  const again = fakeGL();
  space.render(again.gl, argsFor(true));
  assert.equal(again.calls.filter(([n]) => n === "texStorage3D").length, 0);
});

test("city lights are decoded off the main thread, uploaded once and the old texture freed", async () => {
  const closed = [];
  globalThis.createImageBitmap = async (img, options) => {
    assert.deepEqual(options, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" });
    return { from: img, close: () => closed.push(img) };
  };
  try {
    const { gl, calls } = fakeGL();
    const nightLayer = night();
    const map = fakeMap();
    nightLayer.onAdd(map);
    const args = argsFor(false);
    nightLayer.setLights("first");
    await new Promise((r) => setTimeout(r));
    assert.equal(map.repaints, 1);
    nightLayer.render(gl, args);
    nightLayer.render(gl, args);
    const uploads = () => calls.filter(([n]) => n === "texImage2D").map((c) => c[6].from);
    assert.deepEqual(uploads(), ["first"]);
    assert.deepEqual(closed, ["first"]);
    nightLayer.setLights("second");
    await new Promise((r) => setTimeout(r));
    nightLayer.render(gl, args);
    assert.deepEqual(uploads(), ["first", "second"]);
    assert.equal(calls.filter(([n]) => n === "deleteTexture").length, 1);
    assert.deepEqual(closed, ["first", "second"]);
  } finally {
    delete globalThis.createImageBitmap;
  }
});

/** createImageBitmap that resolves when finish() is called; closed bitmaps are recorded. */
function heldDecode() {
  const held = { closed: [] };
  globalThis.createImageBitmap = (img) =>
    new Promise((resolve) => (held.finish = () => resolve({ from: img, close: () => held.closed.push(img) })));
  return held;
}

test("city lights released while still decoding are closed when the decode lands, not kept", async () => {
  const held = heldDecode();
  try {
    const nightLayer = night();
    nightLayer.setLights("decoding");
    nightLayer.releaseLights();
    held.finish();
    await new Promise((r) => setTimeout(r));
    assert.deepEqual(held.closed, ["decoding"]);
    assert.equal(nightLayer._pendingLights, null);
  } finally {
    delete globalThis.createImageBitmap;
  }
});

test("city lights released while waiting for a frame are closed at once", async () => {
  const held = heldDecode();
  try {
    const nightLayer = night();
    nightLayer.setLights("waiting");
    held.finish();
    await new Promise((r) => setTimeout(r));
    assert.ok(nightLayer._pendingLights);
    nightLayer.releaseLights();
    assert.deepEqual(held.closed, ["waiting"]);
    assert.equal(nightLayer._pendingLights, null);
  } finally {
    delete globalThis.createImageBitmap;
  }
});
