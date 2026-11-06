// The globe's cloud of satellites on its own: what it asks for, and what it does for a new layer.
import assert from "node:assert/strict";
import { test } from "node:test";

import { SatelliteCloud } from "../../custom_components/satellite_spotter/frontend/sat-cloud.js";

const T0 = 1_800_000_000;
const positions = (ids = [1, 2, 3], version = 7) => ({
  start: T0,
  step: 60,
  count: 11,
  catalog_version: version,
  ids,
  pos: ids.map(() => Array.from({ length: 33 }, () => 10)),
  lit: ids.map(() => "1".repeat(11)),
});
const catalog = (version = 7) => ({ version, satellites: [1, 2, 3, 4].map((norad_id) => ({ norad_id, name: `S${norad_id}`, kind: "satellite" })) });

function layer() {
  const made = { clouds: [], flags: [], moved: [] };
  return {
    made,
    setCloud: (cloud) => made.clouds.push(cloud),
    setCloudFlags: (bits) => made.flags.push(Array.from(bits)),
    setCloudPositions: (xy, options) => made.moved.push({ xy, options }),
    pick: () => 1,
  };
}

function cloud({ wanted = () => true, key = () => "live", fetchPositions = async () => positions(), fetchCatalog = async () => catalog() } = {}) {
  const calls = { positions: 0, catalog: 0, loaded: 0 };
  const shown = [];
  const made = new SatelliteCloud({
    canAsk: wanted,
    request: () => ({ key: key(), want: { span: 600 } }),
    fetchPositions: (want) => (calls.positions++, fetchPositions(want)),
    fetchCatalog: (version) => (calls.catalog++, fetchCatalog(version)),
    nowS: () => T0,
    cloudOf: (cat, ids) => ({ cat, ids }),
    toLayer: (ll, out) => out ?? new Float32Array(ll.length),
    onLoaded: () => calls.loaded++,
    whenShown: (fn) => shown.push(fn),
  });
  return { made, calls, shown };
}

test("a new layer gets what is known at once, with nothing to ask for", async () => {
  const { made, calls } = cloud();
  const first = layer();
  made.attach(first);
  await made.load();
  assert.equal(calls.positions, 1);
  assert.equal(first.made.clouds.length, 1);
  assert.ok(made.ready);
  // The map is rebuilt, with fresh positions still at hand.
  made.detach();
  const second = layer();
  made.attach(second);
  assert.equal(second.made.clouds.length, 1, "handed over straight away");
  await made.load();
  assert.equal(calls.positions, 1, "and nothing asked for");
  assert.ok(made.moveTo(T0 + 60));
  assert.equal(second.made.moved.at(-1).options.visible, true);
});

test("a new layer hears of the flags again, though nothing has changed since the last", async () => {
  const { made } = cloud();
  const first = layer();
  made.attach(first);
  await made.load();
  const marks = (set) => set(2, 8);
  assert.equal(made.setFlags(marks), true);
  assert.equal(made.setFlags(marks), false, "nothing new");
  const second = layer();
  made.attach(second);
  assert.equal(made.setFlags(marks), true);
  assert.deepEqual(second.made.flags, [[0, 8, 0]]);
});

test("a list that differs anywhere gets the catalogue's order again", async () => {
  let ids = [1, 2, 3];
  const { made, calls } = cloud({ fetchPositions: async () => positions(ids) });
  made.attach(layer());
  await made.load();
  assert.equal(calls.catalog, 1);
  // The same length, the same first and last: only the middle has changed.
  ids = [1, 4, 3];
  await made.load(true);
  assert.equal(calls.catalog, 2);
  assert.equal(made._index.get(4), 1);
});

test("the same list again asks for no catalogue", async () => {
  const { made, calls } = cloud();
  made.attach(layer());
  await made.load();
  await made.load(true);
  assert.equal(calls.catalog, 1);
});

test("another location starts from nothing, even with a request on its way", async () => {
  const answers = [];
  const { made, calls } = cloud({ fetchPositions: () => new Promise((resolve) => answers.push(resolve)) });
  made.attach(layer());
  const loading = made.load();
  made.reset();
  assert.equal(made.ready, false);
  // Not left waiting for what the old location was asked.
  const again = made.load();
  assert.equal(calls.positions, 2);
  answers[0](positions([9]));
  await loading;
  assert.equal(made.positions, null, "the old location's answer is not listened to");
  answers[1](positions());
  await again;
  assert.ok(made.ready);
});

test("a failure backs off, a retry waits for the view, and a reconnect ends the wait", async () => {
  let fail = true;
  const { made, calls, shown } = cloud({
    fetchPositions: async () => {
      if (fail) throw new Error("down");
      return positions();
    },
  });
  made.attach(layer());
  await made.load();
  assert.equal(calls.positions, 1);
  await made.load();
  assert.equal(calls.positions, 1, "not on every frame");
  made.retrySoon();
  fail = false;
  await made.load();
  assert.equal(calls.positions, 2);
  assert.ok(made.ready);
  made.stopRetrying();
  assert.equal(shown.length, 0);
});

test("positions that come in for a moment no longer wanted are let go", async () => {
  let key = "live";
  let answer;
  const { made } = cloud({ key: () => key, fetchPositions: () => new Promise((resolve) => (answer = resolve)) });
  made.attach(layer());
  const loading = made.load();
  key = "sim:1";
  answer(positions());
  await loading;
  assert.equal(made.positions, null);
});

test("nothing is asked for while it is not wanted", async () => {
  const { made, calls } = cloud({ wanted: () => false });
  await made.load(true);
  assert.equal(calls.positions, 0);
});

test("while nothing moves fast enough to see, the satellites are not worked out every frame", async () => {
  const { made } = cloud();
  const space = layer();
  made.attach(space);
  await made.load();
  made.moveTo(T0 + 60);
  const first = made._movedTo;
  made.moveTo(T0 + 60.1, { slow: true });
  assert.equal(made._movedTo, first, "a tenth of a second on");
  made.moveTo(T0 + 60.6, { slow: true });
  assert.equal(made._movedTo, T0 + 60.6, "half a second on");
  made.moveTo(T0 + 60.7);
  assert.equal(made._movedTo, T0 + 60.7, "and every frame when it matters");
  assert.equal(space.made.moved.at(-1).options.visible, true);
});

test("it hides during the fast-forward, and says when positions have run out", async () => {
  const { made } = cloud();
  const space = layer();
  made.attach(space);
  await made.load();
  assert.equal(made.moveTo(T0 + 60, { hidden: true }), true);
  assert.equal(space.made.moved.at(-1).options.visible, false);
  assert.equal(made.moveTo(T0 + 3600), false);
  assert.equal(space.made.moved.at(-1).options.visible, false);
  made.moveTo(T0 + 60, { wanted: false });
  assert.equal(space.made.moved.at(-1).options.visible, false);
});

test("it tells which satellite is under a point, and how high", async () => {
  const { made } = cloud();
  made.attach(layer());
  await made.load();
  assert.equal(made.pick(1, 1, 800, 600, 10), 2);
  assert.equal(made.altitudeOf(2), null, "not until it has been placed");
  made.moveTo(T0);
  assert.equal(typeof made.altitudeOf(2), "number");
  assert.equal(made.altitudeOf(99), null);
  assert.equal(made.byId.get(4).name, "S4");
});

test("without a layer nothing breaks", async () => {
  const { made } = cloud();
  await made.load();
  assert.equal(made.moveTo(T0), true);
  assert.equal(made.setFlags(() => {}), false);
  assert.equal(made.pick(1, 1, 1, 1, 1), null);
  made.detach();
  made.reset();
});
