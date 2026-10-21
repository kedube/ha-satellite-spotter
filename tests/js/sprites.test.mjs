// Unit tests for the satellite sprites (sat-sprites.js): node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import * as space from "../../custom_components/satellite_spotter/frontend/sat-space.js";
import {
  KINDS,
  KIND_CODES,
  KIND_COLORS,
  SPRITES,
  drawGlow,
  drawSprite,
  drawStation,
  spriteIcon,
  spriteKind,
} from "../../custom_components/satellite_spotter/frontend/sat-sprites.js";
import { recordingCanvas, withDocument } from "./helpers/gl-fake.mjs";

/** Draw with a recording canvas: {canvas, log}. */
function record(draw, options) {
  const log = [];
  let canvas;
  withDocument(() => (canvas = recordingCanvas(log, options)), draw);
  return { canvas, log };
}

test("kind codes are the cloud's table, shared with sat-space.js", () => {
  assert.deepEqual({ ...KIND_CODES }, { iss: 0, tiangong: 1, hubble: 2, satellite: 3, starlink: 4, rocket: 5, debris: 6 });
  assert.ok(Object.isFrozen(KIND_CODES));
  assert.equal(space.KIND_CODES, KIND_CODES);
  assert.deepEqual([...KINDS], ["iss", "tiangong", "hubble", "satellite", "starlink", "rocket", "debris"]);
  assert.deepEqual([...SPRITES], [...KINDS, "train", "glow", "dot"]);
  assert.equal(spriteKind("rocket"), "rocket");
  assert.equal(spriteKind("payload"), "satellite", "anything else is a satellite");
  assert.equal(spriteKind(undefined), "satellite");
});

test("every kind has a colour of its own for the cloud", () => {
  const seen = new Set();
  for (const kind of KINDS) {
    const rgb = KIND_COLORS[kind];
    assert.equal(rgb.length, 3, kind);
    assert.ok(rgb.every((v) => v >= 0 && v <= 1), kind);
    seen.add(rgb.join());
  }
  assert.equal(seen.size, KINDS.length);
  assert.deepEqual(KIND_COLORS.iss, [0.99, 0.83, 0.3], "the ISS in the globe's gold");
});

test("every sprite draws at the size asked for, scaled from its 256 px design", () => {
  for (const kind of SPRITES) {
    for (const size of [256, 128, 40]) {
      const { canvas, log } = record(() => drawSprite(kind, size));
      assert.equal(canvas.width, size, kind);
      assert.equal(canvas.height, size, kind);
      const painted = log.filter(([m]) => ["fill", "fillRect", "stroke", "strokeRect"].includes(m)).length;
      assert.ok(painted > 0, `${kind} paints`);
      if (kind !== "glow" && kind !== "dot") assert.deepEqual(log.find(([m]) => m === "scale"), ["scale", size / 256, size / 256], kind);
    }
  }
});

test("each kind looks different, and the ISS is the station it always was", () => {
  const drawings = new Map(SPRITES.map((kind) => [kind, JSON.stringify(record(() => drawSprite(kind, 128)).log)]));
  assert.equal(new Set(drawings.values()).size, SPRITES.length);
  assert.equal(drawings.get("iss"), JSON.stringify(record(() => drawStation(128)).log));
  // Unknown kinds are drawn as a satellite.
  assert.equal(JSON.stringify(record(() => drawSprite("payload", 128)).log), drawings.get("satellite"));
});

test("the sprites have their own looks: gold ISS wings, Tiangong's dark blue arrays, a tumbling rocket body", () => {
  const stops = (log) => log.filter(([m]) => m === "set").map(([, , v]) => v).filter((v) => v?.stops).flatMap((g) => g.stops.map(([, c]) => c));
  const iss = record(() => drawSprite("iss", 256)).log;
  assert.ok(stops(iss).includes("#c98a2b"), "gold arrays");
  const tiangong = record(() => drawSprite("tiangong", 256)).log;
  assert.ok(stops(tiangong).includes("#2c4fb8"), "blue arrays");
  assert.ok(!stops(tiangong).includes("#c98a2b"), "not the ISS's gold");
  // The rocket body is drawn tilted, with arcs around it.
  const rocket = record(() => drawSprite("rocket", 256)).log;
  assert.deepEqual(rocket.find(([m]) => m === "rotate"), ["rotate", Math.PI / 6]);
  assert.ok(rocket.filter(([m]) => m === "arc").length >= 2, "tumbling arcs");
  // The others are drawn nose up (Hubble only turns its open door).
  for (const kind of ["iss", "tiangong", "satellite", "starlink", "debris", "train"]) {
    assert.ok(!record(() => drawSprite(kind, 256)).log.some(([m]) => m === "rotate"), kind);
  }
  // A Starlink train: six lights, each a glow and a core.
  assert.equal(record(() => drawSprite("train", 256)).log.filter(([m]) => m === "arc").length, 12);
});

test("glyphs keep clear of their edges, so the cloud's texture layers do not bleed as they shrink", () => {
  // Coordinates in the 256 px design space; the shapes drawn without a rotation.
  for (const kind of ["iss", "tiangong", "satellite", "starlink", "debris", "train"]) {
    const { log } = record(() => drawSprite(kind, 256));
    const xs = [];
    const ys = [];
    for (const [m, ...a] of log) {
      if (["fillRect", "strokeRect", "rect", "roundRect"].includes(m)) xs.push(a[0], a[0] + a[2]), ys.push(a[1], a[1] + a[3]);
      else if (m === "moveTo" || m === "lineTo") xs.push(a[0]), ys.push(a[1]);
      else if (m === "arc") xs.push(a[0] - a[2], a[0] + a[2]), ys.push(a[1] - a[2], a[1] + a[2]);
      else if (m === "ellipse") xs.push(a[0] - a[2], a[0] + a[2]), ys.push(a[1] - a[3], a[1] + a[3]);
    }
    assert.ok(xs.length > 4, kind);
    assert.ok(Math.min(...xs) >= 8 && Math.max(...xs) <= 248, `${kind}: x ${Math.min(...xs)}..${Math.max(...xs)}`);
    assert.ok(Math.min(...ys) >= 8 && Math.max(...ys) <= 248, `${kind}: y ${Math.min(...ys)}..${Math.max(...ys)}`);
  }
});

test("browsers without roundRect get square corners rather than an error", () => {
  for (const kind of SPRITES) {
    const { log } = record(() => drawSprite(kind, 128), { missing: ["roundRect"] });
    assert.ok(!log.some(([m]) => m === "roundRect"), kind);
  }
  assert.ok(record(() => drawSprite("hubble", 128), { missing: ["roundRect"] }).log.some(([m]) => m === "rect"));
});

test("a glow fades from the centre to the edge", () => {
  const { log } = record(() => drawGlow(64, "rgba(255,255,255,1)", "rgba(255,255,255,0)"));
  assert.deepEqual(log[0], ["createRadialGradient", 32, 32, 0, 32, 32, 32]);
  const gradient = log.find(([m, k]) => m === "set" && k === "fillStyle")[2];
  assert.deepEqual(gradient.stops, [[0, "rgba(255,255,255,1)"], [1, "rgba(255,255,255,0)"]]);
  assert.deepEqual(log.at(-1), ["fillRect", 0, 0, 64, 64]);
});

test("icons for the UI: PNG data URLs drawn for the screen's pixel ratio, made once per kind and size", () => {
  const saved = globalThis.devicePixelRatio;
  try {
    globalThis.devicePixelRatio = 2;
    const sizes = [];
    const made = () => {
      const canvas = recordingCanvas([]);
      return new Proxy(canvas, {
        set: (target, key, value) => {
          if (key === "width") sizes.push(value);
          target[key] = value;
          return true;
        },
      });
    };
    withDocument(made, () => {
      const url = spriteIcon("starlink", 20);
      assert.match(url, /^data:image\/png;base64,/);
      assert.equal(spriteIcon("starlink", 20), url, "cached");
      assert.deepEqual(sizes, [40], "20 CSS px at 2x");
      spriteIcon("starlink", 32);
      spriteIcon("iss", 20);
      spriteIcon("payload", 20); // a satellite
      spriteIcon("satellite", 20); // the same icon
      assert.deepEqual(sizes, [40, 64, 40, 40]);
      globalThis.devicePixelRatio = 7;
      spriteIcon("rocket", 10);
      assert.equal(sizes.at(-1), 30, "at most 3x");
    });
  } finally {
    globalThis.devicePixelRatio = saved;
  }
});
