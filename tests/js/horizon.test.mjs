// Tests for the terrain under and around the street view (sat-horizon.js):
// Terrarium decoding, sampling, despiking and the skyline:
// node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TERRARIUM,
  bilinear,
  decodeTerrarium,
  demGrid,
  despike,
  groundElevation,
  hiddenByTerrain,
  horizonAt,
  skylineProfile,
  terrariumHeight,
  tileUrl,
  tileXY,
} from "../../custom_components/satellite_spotter/frontend/sat-horizon.js";
import { trackFromRows } from "../../custom_components/satellite_spotter/frontend/sat-planetarium.js";

const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);

/** RGB of a Terrarium pixel for a height (the encoding's inverse). */
function encode(h) {
  const v = h + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v - r * 256);
  const b = Math.round((v - r * 256 - g) * 256);
  return [r, g, b];
}

/** A 256 × 256 tile of heights from a function of the pixel. */
function tile(fn) {
  const out = new Float32Array(256 * 256);
  for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) out[j * 256 + i] = fn(i, j);
  return out;
}

test("Terrarium pixels decode to metres", () => {
  assert.equal(terrariumHeight(128, 0, 0), 0);
  assert.equal(terrariumHeight(0, 0, 0), -32768);
  close(terrariumHeight(128, 10, 128), 10.5, 1e-12);
  for (const h of [-420.25, 0, 8.65, 1623.5, 4392]) {
    const [r, g, b] = encode(h);
    close(terrariumHeight(r, g, b), h, 1 / 256, `${h}`);
  }
  const rgba = new Uint8ClampedArray([...encode(10), 255, ...encode(-5.5), 255]);
  assert.deepEqual([...decodeTerrarium(rgba)], [10, -5.5]);
});

test("tile coordinates and URLs", () => {
  const [x, y] = tileXY(0, 0, 1);
  assert.deepEqual([x, y], [1, 1]);
  const [bx, by] = tileXY(42.3601, -71.0589, 15);
  assert.equal(Math.floor(bx), 9916);
  assert.equal(Math.floor(by), 12119);
  assert.equal(tileUrl(15, 9916, 12119), TERRARIUM.replace("{z}", 15).replace("{x}", 9916).replace("{y}", 12119));
  assert.match(TERRARIUM, /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\//);
});

test("heights sit at pixel centres and are interpolated between them", () => {
  const at = (i, j) => i * 10 + j;
  close(bilinear(at, 0.5, 0.5), 0, 1e-12, "a pixel's centre is its own value");
  close(bilinear(at, 1.5, 0.5), 10, 1e-12);
  close(bilinear(at, 1.0, 0.5), 5, 1e-12, "half way between centres");
  close(bilinear(at, 2.25, 3.75), 17.5 + 3.25, 1e-12);
});

test("single-pixel spikes are clamped before interpolating, real slopes are not", () => {
  // Boulder at z10: one pixel 780 m above its neighbours.
  assert.deepEqual(despike(1593, 1590, 2373, 1600), [1593, 1590, 1596.5 + 60, 1600]);
  assert.deepEqual(despike(100, 140, 120, 160), [100, 140, 120, 160], "a slope within 60 m of the median stays");
  const spiky = (i, j) => (i === 5 && j === 5 ? 2000 : 100);
  close(bilinear(spiky, 5.5, 5.5, { limit: 60 }), 160, 1e-9, "at most 60 m above the rest");
  close(bilinear(spiky, 5.5, 5.5), 2000, 1e-9, "unless asked to");
});

test("the ground under the observer comes from the z15 tile, bilinearly", async () => {
  const asked = [];
  const loadTile = async (z, x, y) => {
    asked.push([z, x, y]);
    // A plane rising 1 m per pixel eastwards and 0.5 m per pixel southwards from 10 m.
    return tile((i, j) => 10 + i + 0.5 * j);
  };
  const lat = 42.3601;
  const lon = -71.0589;
  const h = await groundElevation(lat, lon, { loadTile });
  const [fx, fy] = tileXY(lat, lon, 15);
  const px = (fx - Math.floor(fx)) * 256 - 0.5;
  const py = (fy - Math.floor(fy)) * 256 - 0.5;
  close(h, 10 + px + 0.5 * py, 1e-6);
  assert.deepEqual(asked, [[15, Math.floor(fx), Math.floor(fy)]]);
});

test("a block of tiles samples across tile edges and leaves holes where tiles failed", async () => {
  const lat = 52.03;
  const lon = 5.56;
  const z = 12;
  const [cx, cy] = tileXY(lat, lon, z);
  const failing = `${Math.floor(cx) + 1}/${Math.floor(cy)}`;
  const grid = await demGrid(lat, lon, z, 8, {
    loadTile: async (zz, x, y) => {
      if (`${x}/${y}` === failing) throw new Error("HTTP 503");
      return tile(() => 5 + (x - Math.floor(cx)));
    },
  });
  assert.equal(grid.failed, 1);
  assert.ok(grid.tiles >= 8);
  close(grid.sample(lat, lon), 5, 1e-6, "flat inside a tile");
  // Inside the failed tile: no data.
  const lonInFailed = ((Math.floor(cx) + 1.5) / 2 ** z) * 360 - 180;
  assert.ok(Number.isNaN(grid.sample(lat, lonInFailed)));
});

test("the skyline: a ridge's angle, the Earth's curvature, and a flat horizon's dip", () => {
  const lat = 40;
  const lon = -105;
  const R = 6371008.8;
  // A 300 m ridge running north-south 3 km to the west; flat ground at 0 m elsewhere.
  const ridge = (la, lo) => {
    const west = (lon - lo) * Math.cos((lat * Math.PI) / 180) * (Math.PI / 180) * R;
    return west > 2950 && west < 3200 ? 300 : 0;
  };
  const profile = skylineProfile(ridge, ridge, lat, lon, 1.7, { maxKm: 10, stepDeg: 1, growth: 1.002 });
  assert.equal(profile.length, 360);
  const west = profile[270];
  const expected = (Math.atan2(300 - 1.7 - ((1 - 0.13) * 2950 ** 2) / (2 * R), 2950) * 180) / Math.PI;
  close(west.elevation, expected, 0.05, "the ridge's top edge");
  close(west.distance, 2950, 20);
  // East: flat to 10 km, so the highest angle is the nearest ground, just below level.
  const east = profile[90];
  assert.ok(east.elevation < 0 && east.elevation > -0.1, `${east.elevation}`);
  close(horizonAt({ profile, stepDeg: 1 }, 270), west.elevation, 1e-9);
  close(horizonAt({ profile, stepDeg: 1 }, 270.5), (profile[270].elevation + profile[271].elevation) / 2, 1e-9);
  // No data in any direction: the geometric dip of the horizon for the eye's height.
  const none = skylineProfile(() => NaN, () => NaN, lat, lon, 100, { maxKm: 1, stepDeg: 90 });
  close(none[0].elevation, -Math.acos(R / (R + 100)) * (180 / Math.PI), 1e-9);
});

test("which parts of a path hills hide", () => {
  const skyline = { stepDeg: 90, profile: [0, 90, 180, 270].map((azimuth) => ({ azimuth, elevation: azimuth === 90 ? 12 : 2 })) };
  const d = trackFromRows([
    [0, 0, 0, 400, 1, 90, -1, 2000, null, 0],
    [2, 0, 0, 400, 1, 90, 5, 2000, 3, 0],
    [4, 0, 0, 400, 1, 90, 20, 2000, 2, 1],
    [6, 0, 0, 400, 1, 180, 5, 2000, 3, 0],
  ]);
  const hidden = hiddenByTerrain(skyline, d);
  assert.deepEqual([...hidden], [[2, true], [4, false], [6, false]]);
});
