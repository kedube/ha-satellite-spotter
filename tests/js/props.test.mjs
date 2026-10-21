// Tests for the 3D model's trees and street lights (sat-street-props.js):
// where they stand, their meshes and instances, the matrix that draws them
// at street level, and the custom layer on a fake WebGL:
// node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Bins,
  INSTANCE_FLOATS,
  MAX_TREES,
  PropsLayer,
  boxMesh,
  coniferMesh,
  crownMesh,
  cylinderMesh,
  distanceToLine,
  glows,
  hash3,
  instances,
  litStreet,
  localFrame,
  localMatrix,
  placeLamps,
  plantTrees,
  pointInPolygon,
  poolMesh,
  readMap,
  roadHalfWidth,
  treeArea,
} from "../../custom_components/satellite_spotter/frontend/sat-street-props.js";
import { mercatorFromLngLat } from "../../custom_components/satellite_spotter/frontend/sat-street-scene.js";
import { draws, fakeGL } from "./helpers/gl-fake.mjs";

const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);
const HOME = { latitude: 42.2965, longitude: -71.2925 };
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const area = (kind, ring, holes = []) => ({ kind, rings: [ring, ...holes], bbox: [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))] });

// ---- places ------------------------------------------------------------------------

test("local metres follow the map's own Mercator scale, there and back", () => {
  const frame = localFrame(HOME.latitude, HOME.longitude);
  for (const p of [[0, 0], [120, -80], [-350, 260]]) {
    const back = frame.toLocal(frame.toLngLat(p));
    close(back[0], p[0], 1e-6);
    close(back[1], p[1], 1e-6);
  }
  // As MapLibre has it: mercator units per metre times the metres east and north.
  const [lng, lat] = frame.toLngLat([100, 50]);
  const a = mercatorFromLngLat(HOME.longitude, HOME.latitude);
  const b = mercatorFromLngLat(lng, lat);
  const scale = 2 * Math.PI * 6371008.8 * Math.cos((HOME.latitude * Math.PI) / 180);
  close((b.x - a.x) * scale, 100, 1e-6);
  close((a.y - b.y) * scale, 50, 1e-6);
  // A point 0.001° north is 111 m away, as on the ground.
  close(frame.toLocal([HOME.longitude, HOME.latitude + 0.001])[1], 111.19, 0.01);
  assert.equal(frame.reaches([[HOME.longitude + 0.01, HOME.latitude]], 400), false, "800 m east");
  assert.equal(frame.reaches([[HOME.longitude + 0.01, HOME.latitude], [HOME.longitude - 0.01, HOME.latitude]], 400), true, "crossing");
});

test("the helpers: repeatable hashes, polygons with holes, distances to a line, bins", () => {
  assert.equal(hash3(3, 4, 5), hash3(3, 4, 5));
  const values = Array.from({ length: 2000 }, (_, i) => hash3(i, i * 7, 1));
  close(values.reduce((s, v) => s + v, 0) / values.length, 0.5, 0.03, "spread evenly");
  assert.ok(values.every((v) => v >= 0 && v < 1));
  const donut = [square(0, 0, 10, 10), square(4, 4, 6, 6)];
  assert.equal(pointInPolygon([2, 2], donut), true);
  assert.equal(pointInPolygon([5, 5], donut), false, "in the hole");
  assert.equal(pointInPolygon([12, 5], donut), false);
  close(distanceToLine([5, 3], [[0, 0], [10, 0]]), 3, 1e-9);
  close(distanceToLine([13, 4], [[0, 0], [10, 0]]), 5, 1e-9, "past the end");
  const bins = new Bins(10);
  bins.add("a", [0, 0, 25, 5]);
  bins.add("b", [100, 100, 101, 101]);
  assert.deepEqual([...bins.near(22, 3)], ["a"]);
  assert.deepEqual([...bins.near(60, 60)], []);
  assert.deepEqual([...bins.near(95, 95, 6)], ["b"]);
});

test("which areas grow trees and which streets have lights", () => {
  assert.equal(treeArea("landcover", { class: "wood", subclass: "wood" }), "wood");
  assert.equal(treeArea("landcover", { class: "wood", subclass: "forest" }), "forest");
  assert.equal(treeArea("landcover", { class: "grass", subclass: "park" }), "park");
  assert.equal(treeArea("landcover", { class: "grass", subclass: "golf_course" }), null, "open grass");
  assert.equal(treeArea("landuse", { class: "cemetery" }), "cemetery");
  assert.equal(treeArea("landuse", { class: "residential" }), null);
  assert.ok(litStreet({ class: "minor" }));
  assert.ok(litStreet({ class: "primary" }));
  assert.equal(litStreet({ class: "minor", brunnel: "tunnel" }), null);
  assert.equal(litStreet({ class: "service", service: "driveway" }), null);
  assert.equal(litStreet({ class: "path" }), null);
  assert.equal(litStreet({ class: "motorway" }), null, "motorways are left dark");
  assert.ok(roadHalfWidth("motorway") > roadHalfWidth("minor") && roadHalfWidth("minor") > roadHalfWidth("path"));
});

// ---- trees -------------------------------------------------------------------------------

test("trees fill the woods and dot the parks, never in a building, on a road or at the eye", () => {
  const wood = area("wood", square(20, 20, 120, 120));
  const park = area("park", square(-200, -200, -100, -100));
  const building = { rings: [square(60, 60, 80, 80)], bbox: [60, 60, 80, 80] };
  const buildings = new Bins(40);
  buildings.add(building, building.bbox);
  const road = { points: [[20, 40], [120, 40]], halfWidth: 4 };
  const roads = new Bins(40);
  roads.add(road, [20, 40, 120, 40]);
  const trees = plantTrees({ areas: [wood, park], buildings, roads });
  const inWood = trees.filter((t) => pointInPolygon([t.x, t.y], wood.rings));
  const inPark = trees.filter((t) => pointInPolygon([t.x, t.y], park.rings));
  assert.equal(inWood.length + inPark.length, trees.length, "only in the areas");
  // A wood near the eye: about one tree per 6 × 6 m, but for the building and the road.
  assert.ok(inWood.length > 150 && inWood.length < 280, `${inWood.length} trees in the wood`);
  assert.ok(inPark.length > 10 && inPark.length < 45, `${inPark.length} trees in the park`);
  assert.ok(inWood.every((t) => !pointInPolygon([t.x, t.y], building.rings) && distanceToLine([t.x, t.y], building.rings[0]) >= 1.5), "none in or against the building");
  assert.ok(inWood.every((t) => Math.abs(t.y - 40) >= 4 + 1.5), "none on the road");
  assert.ok(trees.some((t) => t.kind === "conifer") && trees.some((t) => t.kind === "leafy"));
  assert.ok(trees.every((t) => t.height > 6 && t.radius > 1 && t.radius < t.height / 2));
  // Nearest first, and the same trees every time.
  assert.ok(trees.every((t, i) => i === 0 || trees[i - 1].d <= t.d));
  assert.deepEqual(plantTrees({ areas: [wood, park], buildings, roads }), trees);
  // A wood around the eye leaves the eye clear.
  const around = plantTrees({ areas: [area("forest", square(-30, -30, 30, 30))] });
  assert.ok(around.length > 50 && around.every((t) => t.d >= 5));
  // Farther away, fewer to a hectare; and never more than asked for.
  const big = plantTrees({ areas: [area("wood", square(-400, -400, 400, 400))] });
  assert.equal(big.length, MAX_TREES);
  const far = plantTrees({ areas: [area("wood", square(260, -50, 360, 50))] });
  assert.ok(far.length < inWood.length * 0.5, "12 m apart out there");
  assert.equal(plantTrees({ areas: [area("wood", square(-20, -20, 20, 20))] }, { max: 10 }).length, 10);
});

// ---- street lights -------------------------------------------------------------------------

test("street lights line the streets where there are houses, on one side, their arms over the street", () => {
  const buildings = new Bins(40);
  for (let x = -200; x <= 200; x += 25) {
    const b = { rings: [square(x, 35, x + 12, 47)], bbox: [x, 35, x + 12, 47] };
    buildings.add(b, b.bbox);
  }
  const street = { points: [[-200, 20], [200, 20]], lit: litStreet({ class: "minor" }) };
  const lamps = placeLamps({ streets: [street], buildings });
  assert.ok(lamps.length >= 10 && lamps.length <= 13, `${lamps.length} lights along 400 m`);
  // On the right of the way it is drawn (east: the south side), off the street's edge, the arm reaching north over it.
  for (const l of lamps) {
    close(l.y, 20 - (4 + 1), 1e-9);
    close(l.ax, 0, 1e-9);
    close(l.ay, 1, 1e-9);
    assert.equal(l.height, 6.5);
  }
  const xs = lamps.map((l) => l.x).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) close(xs[i] - xs[i - 1], 34, 1e-6);
  // The same street twice (tiles of two zooms): no light twice.
  assert.equal(placeLamps({ streets: [street, street], buildings }).length, lamps.length);
  // A country lane, no houses near: no lights.
  const lane = { points: [[-200, -300], [200, -300]], lit: litStreet({ class: "minor" }) };
  assert.deepEqual(placeLamps({ streets: [lane], buildings }), []);
  // None inside a building.
  const across = { rings: [square(-200, 0, 200, 18)], bbox: [-200, 0, 200, 18] };
  const covered = new Bins(40);
  covered.add(across, across.bbox);
  assert.deepEqual(placeLamps({ streets: [street], buildings: covered }), []);
});

test("the map's features are read in local metres: trees' areas, buildings, roads and lit streets", () => {
  const frame = localFrame(HOME.latitude, HOME.longitude);
  const poly = (ring) => ({ type: "Polygon", coordinates: [ring.map(frame.toLngLat)] });
  const line = (points) => ({ type: "LineString", coordinates: points.map(frame.toLngLat) });
  const map = readMap(
    {
      building: [
        { properties: { render_height: 8 }, geometry: poly(square(30, 30, 40, 40)) },
        { properties: { hide_3d: true }, geometry: poly(square(50, 30, 60, 40)) },
        { properties: {}, geometry: poly(square(5000, 0, 5010, 10)) },
      ],
      landcover: [
        { properties: { class: "wood", subclass: "forest" }, geometry: { type: "MultiPolygon", coordinates: [poly(square(-100, -100, -50, -50)).coordinates] } },
        { properties: { class: "grass", subclass: "grass" }, geometry: poly(square(0, 0, 50, 50)) },
      ],
      landuse: [{ properties: { class: "cemetery" }, geometry: poly(square(100, 100, 150, 150)) }],
      transportation: [
        { properties: { class: "minor" }, geometry: line([[-100, 20], [100, 20]]) },
        { properties: { class: "minor", brunnel: "tunnel" }, geometry: line([[-100, 25], [100, 25]]) },
        { properties: { class: "path" }, geometry: line([[0, -100], [0, 100]]) },
      ],
    },
    frame,
  );
  assert.deepEqual(map.areas.map((a) => a.kind), ["forest", "cemetery"]);
  close(map.areas[0].bbox[0], -100, 1e-6);
  assert.equal([...map.buildings.near(0, 0, 600)].length, 1, "the hidden one and the far one left out");
  assert.equal(map.streets.length, 1, "lit: the street, not the tunnel or the path");
  assert.equal([...map.roads.near(0, 50)].length, 1, "the path still keeps trees off it");
  assert.equal([...map.roads.near(-80, 22)].length, 1, "not the tunnel");
});

// ---- meshes and instances --------------------------------------------------------------------

test("the meshes: a lumpy crown, a conifer's layers, a trunk, a box", () => {
  const unitNormals = (m) => {
    for (let i = 0; i < m.normals.length; i += 3) close(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]), 1, 1e-5);
  };
  const crown = crownMesh(2);
  assert.equal(crown.positions.length / 3, 162);
  assert.equal(crown.indices.length / 3, 320);
  unitNormals(crown);
  for (let i = 0; i < crown.positions.length; i += 3) {
    const r = Math.hypot(crown.positions[i], crown.positions[i + 1], crown.positions[i + 2]);
    assert.ok(r > 0.75 && r < 1.25, "about the unit sphere");
  }
  assert.equal(crownMesh(1).indices.length / 3, 80, "the far crowns: a quarter of the triangles");
  const conifer = coniferMesh();
  unitNormals(conifer);
  const zs = [...conifer.positions].filter((_, i) => i % 3 === 2);
  close(Math.min(...zs), 0, 1e-9);
  close(Math.max(...zs), 1, 1e-9);
  const trunk = cylinderMesh(8);
  assert.equal(trunk.indices.length / 3, 24);
  const box = boxMesh();
  assert.equal(box.positions.length / 3, 24);
  assert.equal(box.indices.length / 3, 12);
  unitNormals(box);
});

test("instances stand the trees and lights on the ground, the crowns on their trunks, the lamps lit", () => {
  const trees = [
    { x: 10, y: 20, d: 22, kind: "leafy", height: 10, radius: 3, tint: 0.5 },
    { x: -150, y: 0, d: 150, kind: "leafy", height: 12, radius: 4, tint: 0.1 },
    { x: 5, y: -30, d: 30, kind: "conifer", height: 15, radius: 2.5, tint: 0.9 },
  ];
  const lamps = [{ x: 0, y: 10, ax: 0, ay: 1, height: 6.5, kind: "led" }, { x: 30, y: 10, ax: 1, ay: 0, height: 8, kind: "sodium" }];
  const ground = (x, y) => 100 + x / 100 + y / 1000;
  const list = instances(trees, lamps, ground);
  const at = (array, i) => Array.from(array.slice(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS));
  assert.equal(list.trunk.length / INSTANCE_FLOATS, 3);
  assert.equal(list.leafy.length / INSTANCE_FLOATS, 1, "the near crown: the fine mesh");
  assert.equal(list.leafyFar.length / INSTANCE_FLOATS, 1);
  assert.equal(list.conifer.length / INSTANCE_FLOATS, 1);
  const [x, y, z, sx, , sz] = at(list.leafy, 0);
  assert.deepEqual([x, y], [10, 20]);
  // A crown of radius 3 (and a little less tall), its top at the tree's height.
  close(z + sz, ground(10, 20) + 10, 1e-4);
  close(sx, 3, 1e-6);
  close(at(list.trunk, 0)[2], ground(10, 20), 1e-4, "the trunk on the ground");
  close(at(list.conifer, 0)[2] + at(list.conifer, 0)[5], ground(5, -30) + 15, 1e-4);
  // Lamps: poles on the ground, heads at the top, over the street, glowing.
  assert.equal(list.pole.length / INSTANCE_FLOATS, 2);
  const head = at(list.head, 0);
  close(head[0], 0, 1e-9);
  close(head[1], 10 + 1.4, 1e-6);
  close(head[2], ground(0, 10) + 6.3, 1e-4);
  assert.equal(head[9], 1, "emissive");
  close(at(list.head, 1)[6], 1, 1e-9);
  close(at(list.head, 1)[7], 0.62, 1e-6, "sodium is orange");
  const glow = glows(lamps, ground);
  assert.equal(glow.length, 12);
  close(glow[2], ground(0, 10) + 6.2, 1e-4);
});

test("the pools of light: a disc on the terrain under each lamp, for a soft fall-off", () => {
  const lamps = [{ x: 0, y: 0, ax: 0, ay: 1, height: 6.5, kind: "led" }];
  const ground = (x, y) => 10 + 0.1 * x;
  const { vertices, indices } = poolMesh(lamps, ground, { grid: 5 });
  assert.equal(vertices.length, 25 * 8);
  assert.equal(indices.length, 16 * 6);
  const us = [];
  for (let i = 0; i < 25; i++) {
    const [x, y, z, u, v] = vertices.slice(8 * i, 8 * i + 5);
    close(z, ground(x, y), 1e-5, "on the sloping ground");
    close(x, u * 6.5 * 1.3, 1e-5);
    close(y, 1.4 + v * 6.5 * 1.3, 1e-5, "under the lamp, over the street");
    us.push(u);
  }
  assert.deepEqual([Math.min(...us), Math.max(...us)], [-1, 1]);
  assert.ok(Math.max(...indices) < 25);
});

// ---- the matrix ---------------------------------------------------------------------------

test("the layer's matrix puts local metres where MapLibre's world pixels are, in float64", () => {
  const worldSize = 512 * 2 ** 20.5;
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const M = localMatrix(identity, worldSize, HOME.latitude, HOME.longitude);
  const apply = ([e, n, z]) => [0, 1, 2].map((r) => M[r] * e + M[4 + r] * n + M[8 + r] * z + M[12 + r]);
  const m = mercatorFromLngLat(HOME.longitude, HOME.latitude);
  const ppm = worldSize / (2 * Math.PI * 6371008.8 * Math.cos((HOME.latitude * Math.PI) / 180));
  const [x, y, z] = apply([10, 20, 3]);
  // (Float32 keeps 24 bits of the world pixels here: the real view-projection takes the place out, below.)
  close(x, m.x * worldSize + 10 * ppm, 64, "east is +x");
  close(y, m.y * worldSize - 20 * ppm, 64, "north is -y");
  close(z, 3, 1e-6, "metres up as they are");
  // A real view-projection: the observer's place first taken out, so float32 keeps millimetres.
  const shifted = [...identity];
  shifted[12] = -m.x * worldSize;
  shifted[13] = -m.y * worldSize;
  const N = localMatrix(shifted, worldSize, HOME.latitude, HOME.longitude);
  close(N[12], 0, 1e-3);
  close(N[13], 0, 1e-3);
  close(N[0], ppm, 1e-3);
});

// ---- the layer -------------------------------------------------------------------------

function layerWith(look) {
  const scene = {
    latitude: HOME.latitude,
    longitude: HOME.longitude,
    view: { bearing: 30, pitch: 95, fov: 60 },
    look: { props: look },
    map: { transform: { worldSize: 512 * 2 ** 20 }, triggerRepaint() {} },
  };
  const layer = new PropsLayer(scene);
  const { gl, calls } = fakeGL();
  layer.onAdd(scene.map, gl);
  const trees = [{ x: 10, y: 20, d: 22, kind: "leafy", height: 10, radius: 3, tint: 0.5 }, { x: 5, y: -30, d: 30, kind: "conifer", height: 15, radius: 2.5, tint: 0.9 }];
  const lamps = [{ x: 0, y: 10, ax: 0, ay: 1, height: 6.5, kind: "led" }];
  layer.setData({ instances: instances(trees, lamps, () => 10), glows: glows(lamps, () => 10), pools: poolMesh(lamps, () => 10) });
  return { layer, gl, calls, scene };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const NIGHT = { light: [0, 0, 1], lightColour: [0.05, 0.05, 0.06], ambient: [0.12, 0.13, 0.16], lampsOn: true, glow: 1, pool: 0.3 };

test("the layer draws its trees and lights instanced, with the pools and glows added on top", () => {
  const { layer, calls, gl } = layerWith(NIGHT);
  assert.equal(layer.type, "custom");
  assert.equal(layer.renderingMode, "3d", "it shares the depth buffer with the buildings");
  layer.render(gl, { modelViewProjectionMatrix: IDENTITY });
  const drawn = draws(calls);
  // Trunks, the near crown, the conifer, the pole, arm and head: instanced; the pools; the glows.
  assert.equal(drawn.filter(([n]) => n === "drawElementsInstanced").length, 7);
  assert.equal(drawn.filter(([n]) => n === "drawElements").length, 1, "the pools");
  assert.equal(calls.filter(([n]) => n === "blendFuncSeparate").length, 2, "pools and glows: light added, the alpha left alone");
  assert.ok(calls.some(([n]) => n === "polygonOffset"), "the pools pulled off the terrain");
});

test("reading what hides the sky, the layer leaves out the street lights; by day there is no glow", () => {
  const night = layerWith(NIGHT);
  night.layer.probing = true;
  night.layer.render(night.gl, { modelViewProjectionMatrix: IDENTITY });
  assert.equal(draws(night.calls).filter(([n]) => n === "drawElementsInstanced").length, 3, "the trees only");
  assert.equal(draws(night.calls).filter(([n]) => n === "drawElements").length, 0);
  const day = layerWith({ ...NIGHT, lampsOn: false, glow: 0, pool: 0 });
  day.layer.render(day.gl, { modelViewProjectionMatrix: IDENTITY });
  assert.equal(draws(day.calls).filter(([n]) => n === "drawElementsInstanced").length, 6, "trees and lamps, no glow");
  assert.equal(draws(day.calls).filter(([n]) => n === "drawElements").length, 0, "no pools");
  // Switched off, nothing.
  const off = layerWith(NIGHT);
  off.layer.visible = false;
  off.layer.render(off.gl, { modelViewProjectionMatrix: IDENTITY });
  assert.equal(draws(off.calls).length, 0);
});
