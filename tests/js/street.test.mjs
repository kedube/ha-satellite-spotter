// Tests for the street view: the eye camera and its maths against MapLibre's
// own formulas, the style, the night look and the window pattern
// (sat-street-scene.js), and the <satellite-street-view> element's lifecycle
// with a fake MapLibre, fake timers and no DOM library (sat-street.js):
// node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { PASS_LEAD_S, PassClock } from "../../custom_components/satellite_spotter/frontend/sat-clock.js";
import { declination } from "../../custom_components/satellite_spotter/frontend/sat-magnetic.js";
import {
  BUILDING_LAYERS,
  EARTH_CIRCUMFERENCE,
  ESRI_TILES,
  FACADES,
  FACADE_KINDS,
  OFM_TILEJSON,
  PITCH_MAX,
  PITCH_MIN,
  PX_PER_M,
  StreetScene,
  TERRAIN_ATTRIBUTION,
  buildStyle,
  eyeCamera,
  facadePattern,
  litShare,
  lngLatFromMercator,
  mercatorFromLngLat,
  meterInMercatorUnits,
  overrideFarPlane,
  sceneLook,
} from "../../custom_components/satellite_spotter/frontend/sat-street-scene.js";
import {
  DEFAULT_OPTIONS,
  SatelliteStreetView,
  detailMatches,
  deviceView,
  normalizeOptions,
  photoOrder,
  photoSource,
  photoSources,
  placeKey,
  streetSettings,
  summaryArc,
  visibleArc,
  wantsPhoto,
} from "../../custom_components/satellite_spotter/frontend/sat-street.js";
import { photoDirection, photoLook, photoRotation } from "../../custom_components/satellite_spotter/frontend/sat-photo.js";
import { localFrame } from "../../custom_components/satellite_spotter/frontend/sat-street-props.js";
import { fakeFormatter, fakeHud, fakeMapLibre, installClock, syntheticPass } from "./helpers/street-fakes.mjs";

const DEG = Math.PI / 180;
const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);
const BOSTON = { latitude: 42.3601, longitude: -71.0589, elevation: 10, title: "Boston" };

// ---- the eye camera ----------------------------------------------------------

test("mercator coordinates match MapLibre's MercatorCoordinate", () => {
  const m = mercatorFromLngLat(0, 0, 0);
  assert.deepEqual([m.x, m.y, m.z], [0.5, 0.5, 0]);
  const boston = mercatorFromLngLat(-71.0589, 42.3601, 100);
  close(boston.x, (180 - 71.0589) / 360, 1e-15);
  close(boston.z, 100 / (EARTH_CIRCUMFERENCE * Math.cos(42.3601 * DEG)), 1e-18);
  const [lng, lat] = lngLatFromMercator(boston.x, boston.y);
  close(lng, -71.0589, 1e-10);
  close(lat, 42.3601, 1e-10);
  close(meterInMercatorUnits(60), 2 / EARTH_CIRCUMFERENCE, 1e-20, "twice the units per metre at 60°");
  close(EARTH_CIRCUMFERENCE, 2 * Math.PI * 6371008.8, 1e-6);
});

/** Where MapLibre 6.11.2 puts its camera for jumpTo options (getCameraLngLat / getCameraAltitude). */
function maplibreCameraFrom({ center, elevation, zoom, pitch, bearing }, { fov, height }) {
  const worldSize = 512 * 2 ** zoom;
  const pixelPerMeter = worldSize / (EARTH_CIRCUMFERENCE * Math.cos(center[1] * DEG));
  const cameraToCenter = (0.5 / Math.tan((fov * DEG) / 2)) * height;
  const distance = cameraToCenter / pixelPerMeter;
  const c = mercatorFromLngLat(center[0], center[1], elevation);
  const units = distance / (EARTH_CIRCUMFERENCE * Math.cos(center[1] * DEG));
  const [x, y] = [Math.sin(pitch * DEG) * Math.sin(bearing * DEG), -Math.sin(pitch * DEG) * Math.cos(bearing * DEG)];
  const [lng, lat] = lngLatFromMercator(c.x - units * x, c.y - units * y);
  const altitude = Math.cos(pitch * DEG) * distance + elevation;
  return { lng, lat, altitude, pixelPerMeter };
}

test("the camera lands on the eye, at 25 px per metre, looking any way up to the zenith", () => {
  const eye = { longitude: BOSTON.longitude, latitude: BOSTON.latitude, eyeAltitude: 12.37 };
  for (const [bearing, pitch, fov, height] of [[35, 95, 50, 720], [125, 120, 50, 720], [240, 150, 70, 844], [10, 178, 90, 600], [300, 80, 40, 300], [0, 180, 60, 800]]) {
    const cam = eyeCamera({ ...eye, bearing, pitch, fov, height });
    const back = maplibreCameraFrom({ ...cam, center: cam.center }, { fov, height });
    close(back.lng, eye.longitude, 1e-9, "longitude");
    close(back.lat, eye.latitude, 1e-9, "latitude");
    close(back.altitude, eye.eyeAltitude, 1e-3, `altitude at pitch ${pitch}`);
    close(back.pixelPerMeter, PX_PER_M, 1e-3, "scale at the centre");
    close(cam.distance, height / 2 / Math.tan((fov * DEG) / 2) / PX_PER_M, 1e-9);
    // Looking up, the centre is above the eye.
    if (pitch > 90) assert.ok(cam.elevation > eye.eyeAltitude);
  }
  // The zoom depends only on the latitude (so the window pattern is computed once per place).
  const z1 = eyeCamera({ ...eye, bearing: 0, pitch: 95, fov: 50, height: 720 }).zoom;
  const z2 = eyeCamera({ ...eye, bearing: 200, pitch: 160, fov: 80, height: 300 }).zoom;
  close(z1, z2, 1e-9);
  close(z1, 20.46, 0.01, "Boston's zoom, as measured in the spike");
  close(eyeCamera({ longitude: 5.56, latitude: 52.03, eyeAltitude: 10, bearing: 0, pitch: 95, fov: 50, height: 720 }).zoom, 20.2, 0.01, "Veenendaal's");
});

test("the far plane is pushed to 150 km through the transform's private method, when it has one", () => {
  const near = [];
  const map = { _camera: { transform: { overrideNearFarZ: (n, f) => near.push([n, f]) }, _requestedCameraState: { overrideNearFarZ: (n, f) => near.push([n, f]) } } };
  assert.equal(overrideFarPlane(map, 25), true);
  assert.deepEqual(near, [[12.5, 3750000], [12.5, 3750000]]);
  assert.equal(overrideFarPlane({ _camera: { transform: {} } }, 25), false, "a MapLibre without it keeps its own far plane");
  assert.equal(overrideFarPlane({}, 25), false);
});

// ---- the look --------------------------------------------------------------

test("the scene's look: dark walls and lit windows at night, day colours by day, light from the Sun or Moon", () => {
  const night = sceneLook({ azimuth: 80, elevation: -25 }, { azimuth: 200, elevation: 40, fraction: 0.9 });
  const dusk = sceneLook({ azimuth: 260, elevation: -7 }, null);
  const day = sceneLook({ azimuth: 180, elevation: 30 }, null);
  assert.equal(night.windows, true);
  assert.equal(dusk.windows, true);
  assert.equal(day.windows, false);
  assert.equal(night.wall, "#131824");
  assert.equal(day.building, "#cfc6b8");
  assert.ok(night.lit > dusk.lit, "more windows lit as the night deepens");
  assert.ok(night.roadGlow > 0 && day.roadGlow === 0, "street lights");
  assert.equal(night.light.color, "#ffffff", "darken the material, not the light");
  assert.deepEqual(night.light.position.slice(1), [200, 50], "the Moon lights the night");
  assert.deepEqual(day.light.position.slice(1), [180, 60], "the Sun the day");
  assert.ok(night.raster["raster-brightness-max"] < 0.25 && day.raster["raster-brightness-max"] === 1);
  assert.equal(sceneLook({ azimuth: 80, elevation: -25 }, null).key, sceneLook({ azimuth: 80.2, elevation: -25.01 }, null).key, "no change for tiny moves");
  assert.notEqual(night.key, dusk.key);
  // The trees and street lights: lamps on and glowing at night, off by day; the Moon's light from the Moon.
  assert.equal(night.props.lampsOn, true);
  assert.ok(night.props.glow > 0.9 && night.props.pool > 0);
  assert.equal(day.props.lampsOn, false);
  assert.equal(day.props.glow, 0);
  close(Math.hypot(...night.props.light), 1, 0.01);
  close(Math.atan2(night.props.light[0], night.props.light[1]) / DEG, -160, 0.6, "towards the Moon in the SSW");
  assert.ok(day.props.ambient[0] > night.props.ambient[0] * 3);
  // Windows lit by the hour: most in the evening, fewest in the small hours.
  const at = (hour) => sceneLook({ azimuth: 80, elevation: -25 }, null, { solarHour: hour }).lit;
  assert.ok(at(20) > at(23) && at(23) > at(1) && at(1) > at(3.5));
  close(litShare(20), 0.4, 1e-9);
  close(litShare(3), 0.08, 1e-9);
  close(litShare(24 + 20), litShare(20), 1e-9, "any day");
  assert.notEqual(sceneLook({ azimuth: 80, elevation: -25 }, null, { solarHour: 20 }).facadeKey, sceneLook({ azimuth: 80, elevation: -25 }, null, { solarHour: 3 }).facadeKey);
});

test("the facades come out bay- and floor-sized both ways at any latitude, and show the hour", () => {
  const night = sceneLook({ azimuth: 80, elevation: -25 }, null, { solarHour: 21 });
  for (const [lat, k] of [[42.36, 1.13], [52.03, 1.36]]) {
    for (const kind of Object.keys(FACADE_KINDS)) {
      const f = FACADE_KINDS[kind];
      const p = facadePattern({ kind, tint: 0, look: night, latitude: lat, ppm: 25 });
      close(p.k, k, 0.01, `k at ${lat}`);
      // Along a wall: a bay's pixels per its metres at the map's scale, with the fractional zoom put back.
      const zoom = Math.log2((25 * EARTH_CIRCUMFERENCE * Math.cos(lat * DEG)) / 512);
      close(p.zoom, zoom, 1e-9);
      const bay = Math.round(f.bayM * f.pxPerM);
      close(p.pixelRatio, (bay / (f.bayM * 25)) * 2 ** (zoom - Math.floor(zoom)), 1e-9);
      // Up a wall the pattern runs k times faster: a floor's pixels are divided by k.
      assert.equal(p.floorPx, Math.round((f.floorM * (bay / f.bayM)) / p.k));
      assert.equal(p.width, f.cols * bay);
      assert.equal(p.height, f.rows * p.floorPx);
      assert.equal(p.data.length, p.width * p.height * 4);
    }
  }
  assert.equal(FACADES.length, 6);
  assert.deepEqual(FACADES.map((f) => f.name), ["facade-house-0", "facade-house-1", "facade-flats-0", "facade-flats-1", "facade-tower-0", "facade-tower-1"]);
  const a = facadePattern({ kind: "flats", look: night, latitude: 45 });
  assert.deepEqual(a.data, facadePattern({ kind: "flats", look: night, latitude: 45 }).data, "the same windows every time");
  assert.notDeepEqual(a.data, facadePattern({ kind: "flats", tint: 1, look: night, latitude: 45 }).data, "each finish its own");
  // More windows lit in the evening than at 3 in the morning (counted by their bright pixels); walls light by day, dark at night.
  const sum = (p) => p.data.reduce((s, v, i) => (i % 4 === 3 ? s : s + v), 0);
  const bright = (p) => p.data.reduce((n, v, i) => (i % 4 === 0 && v > 150 ? n + 1 : n), 0);
  const small = sceneLook({ azimuth: 80, elevation: -25 }, null, { solarHour: 3 });
  assert.ok(bright(facadePattern({ kind: "flats", look: night, latitude: 45 })) > 3 * bright(facadePattern({ kind: "flats", look: small, latitude: 45 })));
  const day = sceneLook({ azimuth: 180, elevation: 30 }, null, { solarHour: 12 });
  assert.ok(sum(facadePattern({ kind: "house", look: day, latitude: 45 })) > sum(facadePattern({ kind: "house", look: night, latitude: 45 })) * 3);
});

// ---- the style -----------------------------------------------------------------

test("the style: open ground, extruded buildings without the observer's own, terrain, and no sky", () => {
  const look = sceneLook({ azimuth: 260, elevation: -8 }, null);
  const style = buildStyle({ look, latitude: BOSTON.latitude, longitude: BOSTON.longitude });
  assert.deepEqual(Object.keys(style.sources).sort(), ["dem", "ofm"]);
  assert.equal(style.sources.ofm.url, OFM_TILEJSON);
  assert.deepEqual(style.sources.dem.tiles, ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"]);
  assert.equal(style.sources.dem.encoding, "terrarium");
  assert.equal(style.sources.dem.maxzoom, 15);
  assert.equal(style.sources.dem.attribution, TERRAIN_ATTRIBUTION);
  assert.deepEqual(style.terrain, { source: "dem", exaggeration: 1 });
  assert.equal(style.sky, undefined, "the default sky is transparent: the planetarium shows through");
  assert.equal(style.fog, undefined);
  const ids = style.layers.map((l) => l.id);
  assert.deepEqual(ids, ["ground", "landcover", "park", "water", "roads", "street-light", ...BUILDING_LAYERS]);
  assert.equal(style.layers[0].type, "background");
  // One layer per facade, each with its own pattern (by height, and by the building's id for the finish).
  const buildings = style.layers.filter((l) => l.type === "fill-extrusion");
  assert.deepEqual(buildings.map((l) => l.paint["fill-extrusion-pattern"]), FACADES.map((f) => f.name));
  for (const [i, layer] of buildings.entries()) {
    assert.equal(layer["source-layer"], "building");
    assert.deepEqual(layer.filter[1], ["!=", ["get", "hide_3d"], true]);
    assert.deepEqual(layer.filter[2], [">", ["distance", { type: "Point", coordinates: [BOSTON.longitude, BOSTON.latitude] }], 1], "not the house we stand in");
    assert.deepEqual(layer.filter.at(-1), ["==", ["%", ["to-number", ["id"], 0], 2], FACADES[i].tint]);
    assert.deepEqual(layer.paint["fill-extrusion-height"], ["coalesce", ["get", "render_height"], 6]);
  }
  const height = ["coalesce", ["get", "render_height"], 6];
  assert.deepEqual(buildings[0].filter.slice(3, -1), [["<=", height, 9]], "houses up to 9 m");
  assert.deepEqual(buildings[2].filter.slice(3, -1), [[">", height, 9], ["<=", height, 32]], "then flats");
  assert.deepEqual(buildings[4].filter.slice(3, -1), [[">", height, 32]], "then towers");
  assert.equal(style.light, look.light);
  // Aerial imagery replaces the vector ground; by day the facades are the same layers.
  const day = buildStyle({ look: sceneLook({ azimuth: 180, elevation: 30 }, null), latitude: 52, longitude: 5, imagery: "aerial" });
  assert.equal(day.sources.imagery.tiles[0], ESRI_TILES);
  assert.match(day.sources.imagery.attribution, /Powered by Esri/);
  assert.deepEqual(day.layers.map((l) => l.id), ["ground", "imagery", "street-light", ...BUILDING_LAYERS]);
  assert.equal(day.layers.find((l) => l.id === "street-light").layout.visibility, "none");
  assert.equal(day.layers.at(-1).paint["fill-extrusion-pattern"], "facade-tower-1");
  // Without OpenFreeMap: ground and terrain only; without terrain: no dem.
  const bare = buildStyle({ look, latitude: 52, longitude: 5, ofm: false, terrain: false });
  assert.deepEqual(bare.layers.map((l) => l.id), ["ground"]);
  assert.deepEqual(Object.keys(bare.sources), []);
  assert.equal(bare.terrain, undefined);
  // Street widths are metres at every zoom.
  const roads = style.layers.find((l) => l.id === "roads");
  assert.equal(roads.paint["line-width"][1][0], "exponential");
});

// ---- the scene -------------------------------------------------------------------

function scene(options = {}) {
  const ml = fakeMapLibre();
  const look = sceneLook({ azimuth: 260, elevation: -10 }, null);
  const s = new StreetScene({}, { ml, latitude: BOSTON.latitude, longitude: BOSTON.longitude, ground: 8.65, look, view: { bearing: 30, pitch: 100, fov: 60 }, ...options });
  return { s, map: ml.maps[0], ml };
}

test("the scene puts its camera at the eye and the far plane at 150 km on every view change", () => {
  const { s, map } = scene();
  assert.equal(map.options.centerClampedToGround, false);
  assert.equal(map.options.interactive, false);
  assert.equal(map.options.maxPitch, 180);
  assert.equal(map.options.canvasContextAttributes.failIfMajorPerformanceCaveat, true);
  assert.equal(map.jumps.length, 1, "seated before the style loads");
  assert.ok(FACADES.every((f) => map.images.has(f.name)), "the facades, before any tile asks for them");
  close(s.eyeAltitude, 8.65 + 1.7, 1e-9);
  s.setView({ bearing: 400, pitch: 200, fov: 50 });
  const jump = map.jumps.at(-1);
  assert.equal(jump.bearing, 40);
  assert.equal(jump.pitch, PITCH_MAX, "clamped");
  assert.equal(map.fov, 50);
  assert.equal(map.near.length, 4, "near/far overridden after each setView (two transforms)");
  close(map.near.at(-1)[1] / map.near.at(-1)[0], 150000 / 0.5, 1e-6);
  s.setView({ pitch: 10 });
  assert.equal(map.jumps.at(-1).pitch, PITCH_MIN);
  // Re-seated on the terrain as rendered.
  map.terrainHeight = 9.1;
  assert.equal(s.reseat(), true);
  close(s.eyeAltitude, 9.1 + 1.7, 1e-9);
  assert.equal(s.reseat(), false, "already there");
  s.setEyeHeight(15);
  close(s.eyeAltitude, 24.1, 1e-9);
  s.remove();
  assert.ok(map.removed);
});

test("the scene gives up a failing source and keeps the rest", () => {
  const degraded = [];
  const { s, map } = scene({ onDegrade: (e) => degraded.push(e.source) });
  // A few tile errors are normal; many with nothing loaded are not.
  for (let i = 0; i < 5; i++) map.fire("error", { sourceId: "dem", tile: {}, error: { message: "HTTP 503" } });
  assert.deepEqual(degraded, []);
  map.fire("error", { sourceId: "dem", tile: {}, error: { message: "HTTP 503" } });
  assert.deepEqual(degraded, ["terrain"]);
  assert.equal(map.terrain, null);
  close(s.eyeAltitude, 1.7, 1e-9, "on the flat ground");
  // OpenFreeMap's TileJSON failing is fatal at once: ground and terrain only.
  map.fire("error", { sourceId: "ofm", error: { message: "Failed to fetch" } });
  assert.deepEqual(degraded, ["terrain", "ofm"]);
  assert.deepEqual(map.style.layers.map((l) => l.id), ["ground"]);
  // Errors from elsewhere are only logged.
  const debug = console.debug;
  console.debug = () => {};
  map.fire("error", { error: { message: "something else" } });
  console.debug = debug;
  assert.equal(degraded.length, 2);
});

test("a new look repaints only what changed, and draws the facades again for the new light", () => {
  const { s, map } = scene();
  map.fire("style.load");
  const paints = map.paints.length;
  const before = map.images.get("facade-flats-0").image.data;
  s.setLook(s.look);
  assert.equal(map.paints.length, paints, "same look: nothing");
  assert.equal(map.images.get("facade-flats-0").image.data, before);
  s.setLook(sceneLook({ azimuth: 180, elevation: 25 }, null));
  assert.notEqual(map.images.get("facade-flats-0").image.data, before, "day walls");
  assert.ok(map.layout.some(([layer, name, value]) => layer === "street-light" && name === "visibility" && value === "none"));
  assert.equal(map.light.position[1], 180);
  // The same facades for a look that differs only a little (they cost a few milliseconds to draw).
  const day = map.images.get("facade-flats-0").image.data;
  s.setLook(sceneLook({ azimuth: 181, elevation: 25.2 }, null));
  assert.equal(map.images.get("facade-flats-0").image.data, day);
});

test("the scene puts trees and street lights where the map has woods and streets, once its tiles are in", async () => {
  const counts = [];
  const { s, map } = scene({ onProps: (c) => counts.push(c) });
  map.fire("style.load");
  const layer = map.getLayer("props");
  assert.ok(layer, "the custom layer, over the buildings");
  assert.equal(layer.renderingMode, "3d");
  const frame = localFrame(BOSTON.latitude, BOSTON.longitude);
  const poly = (x0, y0, x1, y1) => ({ type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(frame.toLngLat)] });
  map.features = {
    building: [{ properties: {}, geometry: poly(-60, 30, -40, 45) }, { properties: {}, geometry: poly(20, 30, 40, 45) }],
    landcover: [{ properties: { class: "wood", subclass: "wood" }, geometry: poly(60, -80, 140, 0) }],
    landuse: [],
    water: [],
    transportation: [{ properties: { class: "minor" }, geometry: { type: "LineString", coordinates: [[-150, 20], [150, 20]].map(frame.toLngLat) } }],
  };
  map.terrainHeight = 9;
  map.fire("sourcedata", { sourceId: "ofm", tile: {} });
  // (The scene waits for the tiles to settle; here it is told to place them now.)
  s._placeProps();
  assert.ok(s.treeCount > 40, `${s.treeCount} trees in the wood`);
  assert.ok(s.lampCount >= 4, `${s.lampCount} street lights`);
  assert.deepEqual(counts, [{ trees: s.treeCount, lamps: s.lampCount }]);
  assert.ok(layer._data.instances.trunk.length > 0 && layer._data.pools.indices.length > 0);
  close(layer._data.instances.trunk[2], 9, 1e-6, "on the terrain as rendered");
  // Only the map's features near home are asked for.
  assert.deepEqual(map.queried.at(-1).filter[1], ["<", ["distance", { type: "Point", coordinates: [BOSTON.longitude, BOSTON.latitude] }], 460]);
  s._placeProps();
  assert.equal(counts.length, 1, "placed once for the same tiles");
  // Reading what hides the sky, the street lights are left out (they are thin).
  const probe = s.probe([{ t: 1, x: 10, y: 10 }]);
  assert.equal(layer.probing, true);
  map.fire("render");
  await probe;
  assert.equal(layer.probing, false);
  // Switched off and on: placed again.
  s.setProps(false);
  assert.equal(layer.visible, false);
  s.setProps(true);
  assert.equal(layer.visible, true);
  s._placeProps();
  assert.equal(counts.length, 2);
  s.remove();
});

test("a look that comes before the style has loaded waits for it, rather than throwing from MapLibre", () => {
  const { s, map } = scene();
  const night = s.look;
  const day = sceneLook({ azimuth: 180, elevation: 25 }, null);
  // A fast replay moves the Sun within the first second, while the style loads.
  s.setLook(day);
  assert.equal(s.look, night, "not recorded as applied");
  assert.equal(map.light, undefined);
  assert.equal(map.paints.length, 0);
  map.fire("style.load");
  assert.equal(s.look, day);
  assert.equal(map.light.position[1], 180);
  // A full reload of the style (a source given up on) makes MapLibre throw again:
  // the look waits for that reload instead of being lost.
  const dusk = sceneLook({ azimuth: 270, elevation: 5 }, null);
  map.setLight = () => {
    throw new Error("Style is not done loading.");
  };
  s.setLook(dusk);
  assert.equal(s.look, day);
  delete map.setLight;
  map.fire("style.load");
  assert.equal(s.look, dusk);
  assert.equal(map.light.position[1], 270);
});

// ---- the element -------------------------------------------------------------

test("options are checked and old names understood", () => {
  assert.deepEqual(normalizeOptions({}), { ...DEFAULT_OPTIONS });
  assert.equal(normalizeOptions({ imagery: "esri" }).imagery, "aerial");
  assert.equal(normalizeOptions({ imagery: "bogus" }).imagery, "map");
  assert.equal(normalizeOptions({ eyeHeightM: 6 }).eyeHeightM, 6);
  assert.equal(normalizeOptions({ eyeHeightM: -1 }).eyeHeightM, 1.7);
  assert.equal(normalizeOptions({ lightPollution: "city", constellations: false }).constellations, false);
  assert.equal(normalizeOptions({ lightPollution: "moon" }).lightPollution, "suburban");
  assert.equal(DEFAULT_OPTIONS.props, true, "trees and street lights");
  assert.equal(normalizeOptions({ props: false }).props, false);
  assert.equal(normalizeOptions({ props: "no" }).props, true);
});

test("a path belongs to its pass, even under an id from before a refresh", () => {
  const { pass, detail } = syntheticPass();
  assert.ok(detailMatches(pass, detail));
  assert.ok(detailMatches(pass, { ...detail, pass_id: `25544-${pass.start + 60}` }));
  assert.ok(!detailMatches(pass, { ...detail, pass_id: `25544-${pass.start + 600}` }));
  assert.ok(!detailMatches(pass, { ...detail, pass_id: `99999-${pass.start}` }));
  assert.ok(!detailMatches(null, detail));
  assert.equal(summaryArc(pass).length, 4);
  const arc = visibleArc(detail, pass);
  assert.ok(arc.length > 20 && arc.every((p) => p.elevation >= 10));
});

test("a phone pointed at the sky: where its back camera looks", () => {
  const level = deviceView(0, 90, 0);
  close(level.bearing, 0, 1e-9);
  close(level.pitch, 90, 1e-9);
  close(deviceView(0, 120, 0).pitch, 120, 1e-9, "tilted back 30°: looking 30° up");
  close(deviceView(90, 90, 0).bearing, 270, 1e-9, "turned left a quarter: west");
  close(deviceView(270, 100, 0).bearing, 90, 1e-9);
  assert.equal(deviceView(0, 0, 0).pitch, PITCH_MIN, "lying flat: as low as the view goes");
});

const T0 = 1792399900;

/** A street view wired to fakes: no DOM, no network, no WebGL (and no street photo near home, unless given). */
function streetView({ webgl = true, ml = fakeMapLibre(), frameMs = 16, photos = [], photoScene = null, settings = null } = {}) {
  globalThis.Path2D ??= class {};
  const view = new SatelliteStreetView();
  view._buildDom = function () {
    this._els = fakeHud(1280, 800);
    this.shadowRoot = { querySelectorAll: () => [], activeElement: null, innerHTML: "" };
  };
  view._mountTimebar = async () => {};
  view._loadMapLibre = async () => ml;
  view._groundElevation = async () => 8.65;
  view._supportsWebGL2 = () => webgl;
  view._skyline = async () => ({ stepDeg: 1, profile: Array.from({ length: 360 }, (_, i) => ({ azimuth: i, elevation: 3, distance: 1000 })) });
  view._findPhotos = async (location, options) => (typeof photos === "function" ? photos(options) : photos);
  // Home Assistant's photo settings (satellite_spotter/street): none, unless given.
  view._fetchStreetSettings = async (msg) => {
    if (typeof settings === "function") return settings(msg);
    if (settings) return settings;
    throw new Error("unknown_command");
  };
  if (photoScene) view._createPhotoScene = photoScene;
  view.formatter = fakeFormatter();
  view.location = BOSTON;
  return { view, ml, frameMs };
}

test("open() starts once and asks for the path; dispose() frees the map and leaves no timer behind", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, ml } = streetView();
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    const asked = [];
    view.addEventListener("need-detail", (e) => asked.push(e.detail.passId));
    view.pass = pass;
    view.open();
    view.open();
    await clock.settle(3);
    assert.deepEqual(asked, [pass.id], "asked once for the path");
    assert.equal(ml.maps.length, 1, "one map");
    assert.equal(view._mode, "3d");
    assert.equal(view.clock.mode, "sim", "a pass to come is replayed");
    assert.equal(view.clock.window.visibleStartS, pass.start);
    view.detail = detail;
    assert.ok(view._planetarium.primary, "drawn once the path is in");
    const map = ml.maps[0];
    // The map settles: the veil goes, the GPU is timed, the eye re-seated.
    map.fire("idle");
    await clock.settle(30, 16);
    assert.ok(view._settled);
    assert.equal(view._mode, "3d", "a GPU that keeps up keeps the 3D street");
    assert.ok(map.jumps.length >= 2);
    view.dispose();
    assert.ok(map.removed, "the WebGL context goes with the map");
    assert.equal(clock.rafs.size, 0, "no animation frame left");
    assert.equal(clock.timeouts.size, 0, "no timeout left");
    assert.equal(clock.listeners.get("visibilitychange")?.size ?? 0, 0);
    // And again.
    view.open();
    await clock.settle(3);
    assert.equal(ml.maps.length, 2);
    view.dispose();
    assert.ok(ml.maps[1].removed);
    assert.equal(clock.timeouts.size, 0);
  } finally {
    clock.restore();
  }
});

test("without WebGL 2, or on a GPU too slow for it, the sky is drawn over the terrain skyline", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, ml } = streetView({ webgl: false });
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    view.setPass(pass, detail);
    view.open();
    await clock.settle(4);
    assert.equal(ml.maps.length, 0, "no map at all");
    assert.equal(view._mode, "2d");
    assert.equal(view._els.banner.hidden, false, "says why");
    assert.match(view._els.bannerText.textContent, /street\.fallback/);
    assert.ok(view._planetarium.skyline, "the skyline is the ground");
    assert.ok(view._planetarium.hidden, "and says where hills hide the path");
    view.dispose();
    assert.equal(clock.timeouts.size, 0);

    // A software GPU: the first frames take 120 ms.
    const slow = streetView();
    slow.view.clock = new PassClock({ now: () => Date.now() });
    slow.view.setPass(pass, detail);
    slow.view.open();
    await clock.settle(3);
    const map = slow.ml.maps[0];
    map.fire("idle");
    await clock.settle(30, 120);
    assert.equal(slow.view._mode, "2d");
    assert.ok(map.removed);
    assert.match(slow.view._els.bannerText.textContent, /reason_slow/);
    slow.view.dispose();
  } finally {
    clock.restore();
  }
});

test("the layers menu changes the scene, says so, and Escape closes the view", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, ml } = streetView();
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    view.setPass(pass, detail);
    view.open();
    await clock.settle(3);
    const changes = [];
    view.addEventListener("options-changed", (e) => changes.push(e.detail));
    view._setOptions({ ...view.options, imagery: "aerial" });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].imagery, "aerial");
    assert.ok(ml.maps[0].style.sources.imagery, "aerial imagery in the map");
    view._setOptions({ ...view.options, eyeHeightM: 15 });
    close(view._scene.eyeAltitude, 8.65 + 15, 1e-9);
    view._setOptions({ ...view.options, eyeHeightM: 15 });
    assert.equal(changes.length, 2, "no event without a change");
    // The host's options do not echo back as a change.
    view.options = { constellations: false };
    assert.equal(changes.length, 2);
    assert.equal(view.options.constellations, false);
    let closed = 0;
    view.addEventListener("close", () => closed++);
    let stopped = false;
    view._keyDown({ key: "Escape", preventDefault() {}, stopPropagation() {
      stopped = true;
    } });
    assert.equal(closed, 1);
    assert.ok(stopped, "a host dialog does not close too");
    view.dispose();
  } finally {
    clock.restore();
  }
});

test("follow keeps the satellite in view once it nears the edge, and leaves a framed pass alone", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = streetView();
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    view.setPass(pass, detail);
    view.open();
    await clock.settle(3);
    view.clock.simulate({ fromS: pass.start, toS: pass.end, startS: pass.peak.time, rate: 1, playing: true });
    // Point the camera well away: the next frames turn it towards the satellite.
    view._setView({ bearing: (pass.transits[0].brightest.azimuth + 120) % 360, pitch: 95 });
    const before = view._view.bearing;
    await clock.settle(20, 16);
    assert.ok(view._following);
    assert.notEqual(view._view.bearing, before);
    // A framed pass with the satellite in the middle: nothing moves.
    view._frame(false);
    const cur = view._state.current;
    view._setView({ bearing: cur.azimuth, pitch: 90 + cur.elevation });
    view._following = false;
    const still = { ...view._view };
    await clock.settle(5, 16);
    close(view._view.bearing, still.bearing, 2);
    // After the user turns the view, follow waits.
    view._userTurned();
    view._setView({ bearing: (cur.azimuth + 150) % 360 });
    await clock.settle(5, 16);
    assert.equal(view._following, false);
    view.dispose();
    assert.equal(clock.timeouts.size, 0);
  } finally {
    clock.restore();
  }
});

test("a new place while opening restarts only the scene", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, ml } = streetView();
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    view.setPass(pass, detail);
    view.open();
    view.location = { latitude: 52.03, longitude: 5.56, elevation: 10, title: "Veenendaal" };
    await clock.settle(4);
    assert.ok(view._planetarium.primary, "the pass is still shown");
    assert.equal(view._planetarium.observer.latitude, 52.03);
    assert.equal(ml.maps.length, 1, "one map, for the new place");
    assert.equal(ml.maps[0].options.center[1], 52.03);
    // And once it shows, another place swaps the map.
    view.location = BOSTON;
    await clock.settle(4);
    assert.equal(ml.maps.length, 2);
    assert.ok(ml.maps[0].removed);
    assert.equal(ml.maps[1].options.center[1], BOSTON.latitude);
    view.dispose();
    assert.equal(clock.timeouts.size, 0);
  } finally {
    clock.restore();
  }
});

test("a formatter that changes language in place rewords the view", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = streetView();
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    view.setPass(pass, detail);
    view.open();
    await clock.settle(3);
    assert.equal(view._els.closeBtn.getAttribute("aria-label"), "street.close");
    const fmt = view.formatter;
    const english = fmt.t;
    fmt.t = (key, vars) => `de:${english(key, vars)}`;
    view.formatter = fmt;
    assert.equal(view._els.closeBtn.getAttribute("aria-label"), "de:street.close");
    // Through hass, as Home Assistant switches language.
    fmt.t = (key, vars) => `fr:${english(key, vars)}`;
    view.hass = { language: "fr", locale: { language: "fr" } };
    await clock.settle(1);
    assert.equal(view._els.closeBtn.getAttribute("aria-label"), "fr:street.close");
    view.dispose();
  } finally {
    clock.restore();
  }
});

test("the time bar is the shared one, on the shared clock; its globe button closes the street view", async () => {
  const { installDom } = await import("./helpers/view-dom.mjs");
  const { fakeFormatter: timebarFormatter } = await import("./helpers/view-format.mjs");
  const { Timebar } = await import("../../custom_components/satellite_spotter/frontend/sat-timebar.js");
  const saved = globalThis.document;
  const doc = installDom({});
  globalThis.document = doc;
  try {
    const view = new SatelliteStreetView();
    view._els = { bar: doc.createElement("div") };
    view._measureHud = () => {};
    view._formatter = timebarFormatter();
    view._clock = new PassClock({ now: () => T0 * 1000 });
    const { pass } = syntheticPass({ start: T0 + 100 });
    view._pass = pass;
    let closed = 0;
    view._close = () => closed++;
    view._mountTimebar();
    assert.ok(view._timebar instanceof Timebar, "sat-timebar.js's, there is no other");
    view._mountTimebar();
    assert.equal(view._els.bar.querySelectorAll(".sat-tb").length, 1, "mounted once");
    view._els.bar.querySelector(".tb-view").click();
    assert.equal(closed, 1, "back to the globe: the street view closes");
    view._clock.simulate({ fromS: pass.start - 120, toS: pass.end + 60, visibleStartS: pass.start, visibleEndS: pass.end });
    view._els.bar.querySelector(".tb-live").click();
    assert.equal(view._clock.mode, "live", "Back to live is the shared clock's");
  } finally {
    globalThis.document = saved;
  }
});

// ---- lifetime, the clock, the path, what hides it, the phone ------------------------

test("taken off the page and put back, the view carries on; only the host's dispose() frees it", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, ml } = streetView();
    let connected = true;
    Object.defineProperty(view, "isConnected", { get: () => connected });
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    view.setPass(pass, detail);
    view.open();
    await clock.settle(3);
    assert.equal(view._mode, "3d");
    // The dashboard shows another view for 5 s, and keeps the card (and the street view in it).
    connected = false;
    view.disconnectedCallback();
    assert.equal(clock.rafs.size, 0, "nothing is drawn off the page");
    for (const fn of clock.listeners.get("visibilitychange") ?? []) fn();
    assert.equal(clock.rafs.size, 0, "not even when the tab comes back meanwhile");
    await clock.settle(1, 5000);
    assert.ok(view._opened && view._els && view._scene, "still open");
    assert.equal(ml.maps[0].removed, false);
    // A lost WebGL context is restored while away: the map is built again off the page.
    view._restartScene();
    await clock.settle(3);
    const rebuilt = view._scene;
    assert.ok(rebuilt && ml.maps.length === 2, "a new map");
    let fits = 0;
    const fit = rebuilt.resize.bind(rebuilt);
    rebuilt.resize = () => {
      fits++;
      fit();
    };
    connected = true;
    view.connectedCallback();
    assert.equal(fits, 1, "back on the page, the new map is fitted to the view");
    assert.equal(clock.rafs.size, 1, "drawing again");
    const at = view.clock.simMs;
    await clock.settle(5, 16);
    assert.ok(view.clock.simMs > at, "the replay moves on");
    // The host is done with it.
    view.dispose();
    assert.ok(ml.maps.every((map) => map.removed));
    assert.equal(clock.timeouts.size, 0);
  } finally {
    clock.restore();
  }
});

test("opened again after dispose(), the view follows the clock again", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = streetView();
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    const pc = new PassClock({ now: () => Date.now() });
    view.clock = pc;
    view.setPass(pass, detail);
    for (const round of [1, 2]) {
      view.open();
      await clock.settle(3);
      // Paused, the frame loop rests: a seek from the time bar has to bring a frame.
      pc.pause();
      await clock.settle(3);
      assert.equal(clock.rafs.size, 0, `round ${round}: paused, nothing moves`);
      pc.seek(pass.start + 60);
      assert.equal(clock.rafs.size, 1, `round ${round}: the seek is drawn`);
      view.dispose();
    }
  } finally {
    clock.restore();
  }
});

test("a pass about to begin is watched live, by the rule the hosts follow too (sat-clock.js)", async () => {
  const { pass, detail } = syntheticPass({ start: T0 });
  const cases = [
    [pass.start - PASS_LEAD_S + 1, "live"],
    [pass.start - 90, "live"],
    [pass.start + 30, "live"],
    [pass.start - PASS_LEAD_S - 30, "sim"],
    [pass.end + 5, "sim"],
  ];
  for (const [nowS, mode] of cases) {
    const clock = installClock(nowS * 1000);
    try {
      const { view } = streetView();
      view.clock = new PassClock({ now: () => Date.now() });
      view.setPass(pass, detail);
      view.open();
      await clock.settle(3);
      assert.equal(view.clock.mode, mode, `${pass.start - nowS} s before the pass`);
      view.dispose();
    } finally {
      clock.restore();
    }
  }
});

test("paused while following, the frame loop rests until the replay plays again", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = streetView();
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    view.setPass(pass, detail);
    view.open();
    await clock.settle(3);
    view.clock.simulate({ fromS: pass.start, toS: pass.end, startS: pass.peak.time, rate: 1, playing: true });
    view._setView({ bearing: (pass.transits[0].brightest.azimuth + 120) % 360, pitch: 95 });
    await clock.settle(20, 16);
    assert.ok(view._following);
    let frames = 0;
    const tick = view._tick.bind(view);
    view._tick = (now) => {
      frames++;
      return tick(now);
    };
    view.clock.pause();
    await clock.settle(2, 16);
    frames = 0;
    await clock.settle(60, 16);
    assert.equal(frames, 0, "paused: no frames");
    view.clock.play();
    await clock.settle(5, 16);
    assert.ok(frames >= 4, "playing: the loop runs again");
    assert.ok(view._following, "and follows on");
    view.dispose();
  } finally {
    clock.restore();
  }
});

test("in 3D the HUD names what can hide the satellite: buildings, hills, or either", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = streetView();
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    view.setPass(pass, detail);
    view.open();
    await clock.settle(3);
    const map = view._scene.map;
    // The map's read-back: the whole path is behind something.
    view._scene.probe = async (samples) => new Map(samples.map((s) => [s.t, true]));
    const note = async () => {
      await view._probe();
      // The HUD's words change at most four times a second.
      await clock.settle(1, 300);
      return view._els.note.textContent;
    };
    assert.match(await note(), /^street\.hidden_from_buildings_or_terrain\{/, "buildings on terrain: either");
    // Trees placed: they hide it too.
    view._scene.treeCount = 30;
    view._occlusionFor = null;
    assert.match(await note(), /^street\.hidden_from_model\{/, "buildings, trees or hills");
    view._setOptions({ ...view.options, props: false });
    assert.equal(view._scene.props, false, "the trees and lights put away");
    assert.match(await note(), /^street\.hidden_from_buildings_or_terrain\{/);
    view._setOptions({ ...view.options, buildings: false });
    assert.match(await note(), /^street\.hidden_from_terrain\{/, "no buildings: the hills");
    view._setOptions({ ...view.options, buildings: true });
    // The terrain tiles fail: the street is shown flat.
    for (let i = 0; i < 6; i++) map.fire("error", { sourceId: "dem", tile: {}, error: { message: "HTTP 503" } });
    assert.match(await note(), /^street\.hidden_from_buildings\{/, "a flat street: the buildings");
    view.dispose();
  } finally {
    clock.restore();
  }
});

test("a path that does not come is asked for again, the HUD says when it gave up, and the connection coming back asks again", async () => {
  const clock = installClock(T0 * 1000);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { view } = streetView();
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    let fail = true;
    const fetched = [];
    const connection = new EventTarget();
    view.hass = {
      language: "en",
      connection,
      callWS: async (msg) => {
        fetched.push(msg.pass_id);
        if (fail) throw new Error("Connection lost");
        return detail;
      },
    };
    view.clock = new PassClock({ now: () => Date.now() });
    const asked = [];
    view.addEventListener("need-detail", (e) => asked.push(e.detail.passId));
    view.pass = pass;
    view.open();
    await clock.settle(3);
    // (The HUD's words change at most four times a second.)
    await clock.settle(1, 300);
    const look = () => view._els.look.innerHTML;
    assert.match(look(), /street\.loading_path/);
    // The host, then Home Assistant; again after 5, 15 and 60 s.
    for (const wait of [2500, 5000, 2500, 15000, 2500, 60000, 2500]) await clock.settle(1, wait);
    await clock.settle(3);
    assert.equal(asked.length, 4);
    assert.equal(fetched.length, 4);
    assert.match(look(), /street\.path_failed/, "given up: it says so");
    await clock.settle(1, 120000);
    assert.equal(fetched.length, 4, "and asks no more");
    // Home Assistant is back.
    fail = false;
    connection.dispatchEvent(new Event("ready"));
    assert.equal(asked.length, 5);
    await clock.settle(1, 2500);
    await clock.settle(1, 300);
    assert.equal(fetched.length, 5);
    assert.ok(view._planetarium.primary, "the path is in");
    assert.doesNotMatch(look(), /street\.(loading_path|path_failed)/);
    view.dispose();
    assert.equal(clock.timeouts.size, 0);
  } finally {
    console.warn = warn;
    clock.restore();
  }
});

test("a phone's compass is magnetic: the view adds the declination at home to face true north", async () => {
  const clock = installClock(T0 * 1000);
  const handlers = new Map();
  globalThis.addEventListener = (type, fn) => handlers.set(type, fn);
  globalThis.removeEventListener = (type, fn) => handlers.get(type) === fn && handlers.delete(type);
  globalThis.DeviceOrientationEvent = class {};
  try {
    const { view } = streetView();
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    view.setPass(pass, detail);
    view.open();
    await clock.settle(3);
    const here = (place) => declination(place.latitude, place.longitude, place.elevation / 1000);
    // Android: absolute orientation, alpha from magnetic north. Upright, the camera to magnetic north:
    globalThis.ondeviceorientationabsolute = null;
    await view._toggleOrientation();
    handlers.get("deviceorientationabsolute")({ absolute: true, alpha: 0, beta: 90, gamma: 0 });
    close(view._view.bearing, 360 + here(BOSTON), 1e-6, "Boston's magnetic north");
    assert.ok(view._view.bearing > 345 && view._view.bearing < 347, "about 14° west of true north");
    await view._toggleOrientation();
    assert.equal(handlers.size, 0, "off");
    delete globalThis.ondeviceorientationabsolute;
    // iPhone: a compass heading, clockwise from magnetic north. To magnetic east:
    await view._toggleOrientation();
    handlers.get("deviceorientation")({ webkitCompassHeading: 90, alpha: 123, beta: 90, gamma: 0 });
    close(view._view.bearing, 90 + here(BOSTON), 1e-6);
    // Another home, its own declination (about 15° east in Seattle).
    const seattle = { latitude: 47.6062, longitude: -122.3321, elevation: 50, title: "Seattle" };
    view.location = seattle;
    for (let i = 0; i < 80; i++) handlers.get("deviceorientation")({ webkitCompassHeading: 0, beta: 90, gamma: 0 });
    close(view._view.bearing, here(seattle), 1e-3, "Seattle's magnetic north");
    assert.ok(here(seattle) > 14.5);
    view.dispose();
    assert.equal(handlers.size, 0);
  } finally {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    delete globalThis.DeviceOrientationEvent;
    delete globalThis.ondeviceorientationabsolute;
    clock.restore();
  }
});

// ---- the street photo ------------------------------------------------------------

/** PhotoScene stand-ins: a picture with a building in the WSW up to 30° and sky everywhere else above the horizon. */
function fakePhotoScenes({ fail = [] } = {}) {
  const made = [];
  const factory = (container, options) => {
    const W = 72;
    const H = 36;
    const R = photoRotation(options.photo);
    const sky = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const { azimuth, elevation } = photoDirection(R, (x + 0.5) / W, (y + 0.5) / H);
        sky[y * W + x] = elevation > 0 && !(azimuth > 240 && azimuth < 300 && elevation < 30) ? 1 : 0;
      }
    }
    const scene = {
      kind: "photo",
      photo: options.photo,
      rotation: R,
      found: null,
      removed: false,
      looks: [],
      views: [],
      async load() {
        if (fail.includes(options.photo.id)) throw new Error("HTTP 404");
        scene.found = { width: W, height: H, sky, fraction: 0.45 };
        return scene.found;
      },
      setView(v) {
        scene.views.push(v);
      },
      resize() {},
      lookFor: (sun, moon) => photoLook(sun, moon),
      setLook(look) {
        scene.looks.push(look);
      },
      remove() {
        scene.removed = true;
      },
    };
    made.push({ scene, options });
    return scene;
  };
  return { factory, made };
}

const photo = (id, distance, bearing) => ({
  id,
  distance,
  bearing,
  heading: 0,
  pitch: 0,
  roll: 0,
  taken: Date.UTC(2025, 6, 8) / 1000,
  author: "A. Mapper",
  license: "CC-BY-SA-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  page: `https://api.panoramax.xyz/#focus=pic&pic=${id}`,
  sd: `https://pics.example/${id}/sd.jpg`,
  hd: `https://pics.example/${id}/hd.jpg`,
});
const PHOTOS = [photo("near", 20, 120), photo("next", 45, 300), photo("far", 150, 10)];

/** localStorage for one test (Node has none without a file). */
function memoryStorage() {
  const store = new Map();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    configurable: true,
    writable: true,
  });
  return {
    store,
    restore: () => (saved ? Object.defineProperty(globalThis, "localStorage", saved) : delete globalThis.localStorage),
  };
}

test("a street photo near home is the street: no map, the photo says what it hides, and the menu where it was taken", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { factory, made } = fakePhotoScenes();
    let searched = 0;
    const { view, ml } = streetView({ photos: () => (searched++, PHOTOS), photoScene: factory });
    const { pass, detail } = syntheticPass({ start: T0 + 100 });
    view.clock = new PassClock({ now: () => Date.now() });
    view.setPass(pass, detail);
    view.open();
    await clock.settle(4);
    assert.equal(view._mode, "photo");
    assert.equal(ml.maps.length, 0, "no 3D map");
    assert.equal(made.length, 1);
    assert.equal(made[0].options.photo.id, "near", "the nearest");
    const scene = made[0].scene;
    assert.ok(scene.views.length >= 1, "turned to the view");
    assert.ok(scene.looks.length >= 1 && Number.isFinite(scene.looks.at(-1).exposure), "lit with the photo's own look");
    // The pass rises in the WSW behind the building, then climbs into the open sky.
    const hidden = view._planetarium.hidden;
    assert.equal(view._planetarium.hiddenKind, "photo");
    const d = view._planetarium.primary.data;
    const at = (pred) => [...hidden].filter(([t]) => pred(d.az[d.t.indexOf(t)], d.el[d.t.indexOf(t)])).map(([, h]) => h);
    assert.ok(at((az, el) => az > 245 && az < 295 && el > 1 && el < 28).every(Boolean), "hidden behind the building");
    assert.ok(at((az, el) => el > 35).every((h) => !h), "in the open sky");
    // The HUD says what hides it, in the photo's words.
    view._clock.seek?.((pass.start - 1) * 1000);
    view._renderHud(pass.start - 1);
    assert.match(view._els.note.textContent, /street\.hidden_(until|from)_photo/);
    // The menu: where the photo was taken, and the 3D model's controls put away.
    view._syncControls();
    assert.equal(view._els.photoPick.hidden, false);
    assert.match(view._els.photoWhere.textContent, /street\.photo_where/);
    assert.match(view._els.photoWhere.textContent, /"distance":"street\.metres\{\\"value\\":\\"20\\"\}"/);
    assert.match(view._els.photoWhen.textContent, /street\.photo_count\{"index":"1","count":"3"\}/);
    assert.equal(view._els.photoNote.hidden, true);
    // The info sheet credits the photographer and the licence, and says where the photo came from.
    view._els.sheet.querySelector = () => ({ addEventListener() {} });
    view._renderSheet();
    assert.match(view._els.sheet.innerHTML, /street\.credit_photo_text/);
    assert.match(view._els.sheet.innerHTML, /street\.privacy_photo/);
    assert.doesNotMatch(view._els.sheet.innerHTML, /street\.credit_map/);
    view.dispose();
    assert.ok(scene.removed, "the photo goes with the view");
    assert.equal(clock.timeouts.size, 0);
    assert.equal(searched, 1);
  } finally {
    clock.restore();
  }
});

test("the next photo is remembered for the place, and a photo that does not load gives way to the next", async () => {
  const clock = installClock(T0 * 1000);
  const storage = memoryStorage();
  try {
    const { factory, made } = fakePhotoScenes({ fail: ["near"] });
    let searched = 0;
    const { view } = streetView({ photos: () => (searched++, PHOTOS), photoScene: factory });
    view.clock = new PassClock({ now: () => Date.now() });
    view.open();
    await clock.settle(4);
    assert.deepEqual(made.map((m) => m.options.photo.id), ["near", "next"], "the nearest failed: the next");
    assert.ok(made[0].scene.removed);
    assert.equal(view._scene.photo.id, "next");
    view._stepPhoto(1);
    await clock.settle(4);
    assert.equal(view._scene.photo.id, "far");
    assert.deepEqual(JSON.parse(storage.store.get("satellite-spotter:street-photo")), { [placeKey(BOSTON)]: "far" });
    assert.equal(searched, 1, "the place's photos are asked for once");
    view.dispose();
    // Opened again, the choice stands.
    const again = streetView({ photos: PHOTOS, photoScene: fakePhotoScenes().factory });
    again.view.clock = new PassClock({ now: () => Date.now() });
    again.view.open();
    await clock.settle(4);
    assert.equal(again.view._scene.photo.id, "far");
    again.view.dispose();
    assert.deepEqual(photoOrder(PHOTOS, "next").map((p) => p.id), ["next", "near", "far"]);
    assert.deepEqual(photoOrder(PHOTOS, "gone").map((p) => p.id), ["near", "next", "far"]);
  } finally {
    storage.restore();
    clock.restore();
  }
});

test("with no photo near home, Panoramax out of reach, or no photo that loads, the street is the 3D model, and the menu says why", async () => {
  const clock = installClock(T0 * 1000);
  try {
    for (const [photos, fail, note] of [
      [[], [], "street.photo_none"],
      [() => Promise.reject(new Error("offline")), [], "street.photo_unavailable"],
      [PHOTOS, ["near", "next", "far"], "street.photo_failed"],
    ]) {
      const { view, ml } = streetView({ photos, photoScene: fakePhotoScenes({ fail }).factory });
      view.clock = new PassClock({ now: () => Date.now() });
      view.open();
      await clock.settle(4);
      assert.equal(view._mode, "3d", note);
      assert.equal(ml.maps.length, 1);
      assert.equal(view._photoNote, note);
      view._syncControls();
      assert.equal(view._els.photoNote.hidden, false);
      assert.match(view._els.photoNote.innerHTML, new RegExp(note.replace(".", "\\.")));
      assert.equal(view._els.photoPick.hidden, true);
      assert.equal(view._els.banner.hidden, true, "no banner: the model is a fine street too");
      view.dispose();
    }
  } finally {
    clock.restore();
  }
});

test("the layers menu swaps the photo for the 3D model and back, without asking for the photos again", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { factory, made } = fakePhotoScenes();
    let searched = 0;
    const { view, ml } = streetView({ photos: () => (searched++, PHOTOS), photoScene: factory });
    view.clock = new PassClock({ now: () => Date.now() });
    view.open();
    await clock.settle(4);
    assert.equal(view._mode, "photo");
    const changes = [];
    view.addEventListener("options-changed", (e) => changes.push(e.detail.street));
    view._setOptions({ ...view.options, street: "model" });
    await clock.settle(4);
    assert.ok(made[0].scene.removed);
    assert.equal(view._mode, "3d");
    assert.equal(ml.maps.length, 1);
    // The model's own controls work again.
    view._setOptions({ ...view.options, imagery: "aerial" });
    assert.ok(ml.maps[0].style.sources.imagery);
    view._setOptions({ ...view.options, street: "photo" });
    await clock.settle(4);
    assert.ok(ml.maps[0].removed);
    assert.equal(view._mode, "photo");
    assert.equal(made.length, 2);
    assert.equal(searched, 1);
    assert.deepEqual(changes, ["model", "model", "photo"]);
    view.dispose();
    assert.equal(normalizeOptions({ street: "model" }).street, "model");
    assert.equal(normalizeOptions({ street: "google" }).street, null, "as the integration's options say, by default");
  } finally {
    clock.restore();
  }
});

test("the integration's photo settings are checked, and decide the street unless the menu has", () => {
  const none = streetSettings(null);
  assert.deepEqual(none, { source: "auto", mapillary: null, google: null });
  assert.deepEqual(streetSettings({ source: "bing", mapillary_token: " ", google_api_key: " AIza " }), { source: "auto", mapillary: null, google: "AIza" });
  const keys = streetSettings({ source: "auto", mapillary_token: "MLY|1", google_api_key: "AIza" });
  assert.deepEqual(photoSources(none), ["panoramax"], "Panoramax needs no key");
  assert.deepEqual(photoSources(keys), ["google", "mapillary", "panoramax"]);
  // The street: the menu's choice, else the options'.
  const model = streetSettings({ source: "model" });
  assert.equal(wantsPhoto(normalizeOptions({}), keys), true);
  assert.equal(wantsPhoto(normalizeOptions({}), model), false);
  assert.equal(wantsPhoto(normalizeOptions({ street: "photo" }), model), true, "the menu wins");
  assert.equal(wantsPhoto(normalizeOptions({ street: "model" }), keys), false);
  // The service: the menu's, else the options'; one without its key is everybody's best.
  assert.equal(photoSource(normalizeOptions({}), keys), "auto");
  assert.equal(photoSource(normalizeOptions({}), streetSettings({ source: "mapillary", mapillary_token: "MLY|1" })), "mapillary");
  assert.equal(photoSource(normalizeOptions({}), streetSettings({ source: "google" })), "auto", "no key: the best of the rest");
  assert.equal(photoSource(normalizeOptions({ photoSource: "panoramax" }), keys), "panoramax");
  assert.equal(photoSource(normalizeOptions({ photoSource: "google" }), none), "auto");
  assert.equal(normalizeOptions({ photoSource: "bing" }).photoSource, null);
  assert.equal(DEFAULT_OPTIONS.photoSource, null);
});

/** A photo of a service, scored as given. */
function servicePhoto(source, id, distance, score = distance) {
  const p = { ...photo(id, distance, 90), source, score };
  if (source === "google") Object.assign(p, { copyright: "© 2024 Google", author: "© 2024 Google", license: "", licenseUrl: null, reportLink: "https://report.example/x", page: "https://www.google.com/maps/@?api=1&map_action=pano&pano=g" });
  return p;
}
const KEYS = { source: "auto", mapillary_token: "MLY|1|2", google_api_key: "AIza" };

test("with keys in the integration's options every service is searched, the best photo comes first, and the menu offers each", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { factory } = fakePhotoScenes();
    const searched = [];
    const lists = {
      google: [servicePhoto("google", "google:g", 25, 10)],
      mapillary: [servicePhoto("mapillary", "mapillary:m", 15), servicePhoto("mapillary", "mapillary:m2", 80)],
      panoramax: [servicePhoto("panoramax", "p", 40)],
    };
    const asked = [];
    const { view } = streetView({ photos: (o) => (searched.push(o.source), lists[o.source]), photoScene: factory, settings: (msg) => (asked.push(msg), KEYS) });
    view.hass = { language: "en", locale: { language: "en" }, config: { country: "NL" }, callWS: async () => ({}) };
    view.location = { ...BOSTON, entry_id: "e1" };
    view.clock = new PassClock({ now: () => Date.now() });
    view.open();
    await clock.settle(4);
    assert.deepEqual(asked, [{ type: "satellite_spotter/street", entry_id: "e1" }]);
    assert.deepEqual([...searched].sort(), ["google", "mapillary", "panoramax"]);
    assert.equal(view._scene.photo.id, "google:g", "the best: Google's");
    assert.deepEqual(view._photos.list.map((p) => p.id), ["google:g", "mapillary:m", "p", "mapillary:m2"]);
    view._syncControls();
    assert.equal(view._els.sources.hidden, false, "a choice of services");
    assert.match(view._els.photoWhen.textContent, / · Google · /);
    // Google's copyright and report link in the image's corner.
    assert.equal(view._els.photoCredit.hidden, false);
    assert.match(view._els.photoCredit.innerHTML, /^© 2024 Google · <a href="https:\/\/report\.example\/x"[^>]*>street\.photo_report<\/a>$/);
    view._els.sheet.querySelector = () => ({ addEventListener() {} });
    view._renderSheet();
    assert.match(view._els.sheet.innerHTML, /street\.credit_photo_google_text/);
    assert.match(view._els.sheet.innerHTML, /street\.privacy_photo_services.*Google Street View and Mapillary/);
    // Mapillary's photos only: the scene starts again, and nobody is asked again.
    view._setOptions({ ...view.options, photoSource: "mapillary" });
    await clock.settle(4);
    assert.equal(view._scene.photo.id, "mapillary:m");
    assert.deepEqual(view._photos.list.map((p) => p.id), ["mapillary:m", "mapillary:m2"]);
    assert.equal(searched.length, 3);
    assert.match(view._els.photoCredit.innerHTML, /© A\. Mapper/);
    view._renderSheet();
    assert.match(view._els.sheet.innerHTML, /street\.credit_photo_mapillary_text/);
    // The same choice made explicit changes nothing that shows.
    const scene = view._scene;
    view._setOptions({ ...view.options, street: "photo" });
    await clock.settle(2);
    assert.equal(view._scene, scene, "no restart");
    view.dispose();
  } finally {
    clock.restore();
  }
});

test("a service that sends no photos is named in the menu, the others still show, and it is asked again next time", async () => {
  const clock = installClock(T0 * 1000);
  const info = console.info;
  console.info = () => {};
  try {
    const searched = [];
    const photos = (o) => {
      searched.push(o.source);
      if (o.source === "google") return Promise.reject(Object.assign(new Error("Google answered 403: API key not valid"), { status: 403, refused: true }));
      if (o.source === "mapillary") return Promise.reject(new Error("Failed to fetch"));
      return [servicePhoto("panoramax", "p", 40)];
    };
    const { view } = streetView({ photos, photoScene: fakePhotoScenes().factory, settings: KEYS });
    view.hass = { language: "en", callWS: async () => ({}) };
    view.clock = new PassClock({ now: () => Date.now() });
    view.open();
    await clock.settle(4);
    assert.equal(view._scene.photo.id, "p");
    view._syncControls();
    const note = view._els.photoNote.innerHTML;
    assert.equal(view._els.photoNote.hidden, false);
    assert.match(note, /street\.photo_source_refused.*Google Street View/, "a refusal: the key");
    assert.match(note, /street\.photo_source_failed.*Mapillary/, "out of reach");
    view._restartScene();
    await clock.settle(4);
    assert.deepEqual(searched.filter((s) => s === "google").length, 2, "asked again");
    assert.deepEqual(searched.filter((s) => s === "panoramax").length, 1, "not the one that answered");
    view.dispose();
  } finally {
    console.info = info;
    clock.restore();
  }
});

test("the integration's options can make the street the 3D model, and the menu can still choose photos", async () => {
  const clock = installClock(T0 * 1000);
  try {
    let searched = 0;
    const { view, ml } = streetView({ photos: () => (searched++, PHOTOS), photoScene: fakePhotoScenes().factory, settings: { source: "model" } });
    view.hass = { language: "en", callWS: async () => ({}) };
    view.clock = new PassClock({ now: () => Date.now() });
    view.open();
    await clock.settle(4);
    assert.equal(view._mode, "3d");
    assert.equal(ml.maps.length, 1);
    assert.equal(searched, 0, "no photo asked for");
    view._syncControls();
    assert.equal(view._els.sources.hidden, true);
    view._setOptions({ ...view.options, street: "photo" });
    await clock.settle(4);
    assert.equal(view._mode, "photo");
    assert.equal(searched, 1);
    view.dispose();
  } finally {
    clock.restore();
  }
});

test("closed while a photo is still loading, the view frees it at once", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const made = [];
    const factory = (container, options) => {
      const scene = {
        kind: "photo",
        photo: options.photo,
        removed: false,
        load: () => new Promise(() => {}),
        setView() {},
        resize() {},
        lookFor: (sun, moon) => photoLook(sun, moon),
        setLook() {},
        remove() {
          scene.removed = true;
        },
      };
      made.push(scene);
      return scene;
    };
    const { view } = streetView({ photos: PHOTOS, photoScene: factory });
    view.clock = new PassClock({ now: () => Date.now() });
    view.open();
    await clock.settle(3);
    assert.equal(made.length, 1);
    assert.equal(view._mode, null, "still loading");
    view.dispose();
    assert.ok(made[0].removed, "its downloads and its WebGL context go");
    // And a restart (another place) frees it too.
    view.open();
    await clock.settle(3);
    view.location = { ...BOSTON, latitude: BOSTON.latitude + 0.01 };
    assert.ok(made[1].removed);
    view.dispose();
  } finally {
    clock.restore();
  }
});
