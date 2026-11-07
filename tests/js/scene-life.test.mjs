// The street view's scene lifecycle on its own: no DOM, no WebGL, only a timer to run by hand.
import assert from "node:assert/strict";
import { test } from "node:test";

import { SceneLife } from "../../custom_components/satellite_spotter/frontend/sat-scene-life.js";
import { strict } from "./helpers/strict-timers.mjs";

function life() {
  const timers = new Set();
  let stillLost = 0;
  const made = new SceneLife({
    later: (fn) => {
      const timer = { fn };
      timers.add(timer);
      return timer;
    },
    cancel: (timer) => timers.delete(timer),
    restoreMs: 5000,
    onStillLost: () => stillLost++,
  });
  return {
    made,
    timers,
    get stillLost() {
      return stillLost;
    },
    runTimers: () => {
      for (const timer of [...timers]) {
        timers.delete(timer);
        timer.fn();
      }
    },
  };
}

const scene = (on = () => {}) => {
  const s = {
    removed: 0,
    remove() {
      s.removed++;
      on(s);
    },
  };
  return s;
};

test("a new start overtakes the last, and stops its downloads", () => {
  const { made } = life();
  const first = made.start();
  assert.ok(first.isCurrent());
  assert.equal(first.signal.aborted, false);
  const second = made.start();
  assert.equal(first.isCurrent(), false);
  assert.ok(first.signal.aborted);
  assert.ok(second.isCurrent());
  assert.equal(second.signal.aborted, false);
  assert.equal(made.current, second);
});

test("clearing frees what shows and what loads, and leaves no start current", () => {
  const { made } = life();
  const start = made.start();
  const showing = scene();
  const loading = scene();
  made.show(showing, "photo");
  made.settled = true;
  made.loading(loading);
  made.clear();
  assert.equal(showing.removed, 1);
  assert.equal(loading.removed, 1);
  assert.equal(made.scene, null);
  assert.equal(made.pending, null);
  assert.equal(made.mode, null);
  assert.equal(made.settled, false);
  assert.equal(start.isCurrent(), false);
  assert.ok(start.signal.aborted);
});

test("a scene that has loaded stops being the one loading", () => {
  const { made } = life();
  made.start();
  const s = scene();
  made.loading(s);
  assert.equal(made.pending, s);
  assert.equal(made.scene, null);
  made.show(s, "photo");
  assert.equal(made.pending, null);
  assert.equal(made.scene, s);
  assert.equal(made.mode, "photo");
});

test("taking a scene away is not a lost context, even if it says so as it goes", () => {
  const t = life();
  const { made } = t;
  made.start();
  // As a real scene does: giving up its context is heard like any other loss.
  const s = scene((self) => made.lost(self));
  made.show(s, "photo");
  made.clear();
  assert.equal(t.timers.size, 0, "no restart on the way");
  t.runTimers();
  assert.equal(t.stillLost, 0);
});

test("a scene no longer ours has no say, in either direction", () => {
  const t = life();
  const { made } = t;
  made.start();
  const old = scene();
  made.show(old, "photo");
  made.start();
  assert.equal(made.lost(old), false);
  assert.equal(made.restored(old), false);
  assert.equal(t.timers.size, 0);
  assert.equal(made.lost(null), false);
});

test("a real loss has a while to come back, and then it is time for another start", () => {
  const t = life();
  const { made } = t;
  made.start();
  const s = scene();
  made.show(s, "3d");
  assert.equal(made.lost(s), true);
  assert.equal(t.timers.size, 1);
  assert.equal(made.lost(s), true, "heard twice");
  assert.equal(t.timers.size, 1, "still the one wait");
  assert.equal(made.restored(s), true);
  assert.equal(t.timers.size, 0, "it came back");
  made.lost(s);
  t.runTimers();
  assert.equal(t.stillLost, 1, "it did not");
});

test("the wait after a loss ends with the start it belonged to", () => {
  const t = life();
  const { made } = t;
  made.start();
  const s = scene();
  made.show(s, "3d");
  made.lost(s);
  made.start();
  assert.equal(t.timers.size, 0);
  t.runTimers();
  assert.equal(t.stillLost, 0);
});

test("a scene that loses its context while loading counts too", () => {
  const t = life();
  const { made } = t;
  made.start();
  const s = scene();
  made.loading(s);
  assert.equal(made.lost(s), true);
  made.discard(s);
  assert.equal(t.timers.size, 1, "a pending scene's going leaves the wait for the next to see");
  t.runTimers();
  assert.equal(t.stillLost, 1);
});

test("discarding frees a scene once it is ours, and any other as well", () => {
  const t = life();
  const { made } = t;
  made.start();
  const s = scene();
  made.show(s, "3d");
  made.lost(s);
  made.discard(s);
  assert.equal(s.removed, 1);
  assert.equal(made.scene, null);
  assert.equal(t.timers.size, 0, "nothing left to wait for");
  const other = scene();
  made.discard(other);
  assert.equal(other.removed, 1);
});

test("the sky needs no scene", () => {
  const { made } = life();
  made.start();
  made.showSky();
  assert.equal(made.mode, "2d");
  assert.equal(made.scene, null);
});

test("it works where there is no AbortController", () => {
  const saved = globalThis.AbortController;
  delete globalThis.AbortController;
  try {
    const { made } = life();
    const start = made.start();
    assert.equal(start.signal, undefined);
    made.clear();
    assert.equal(start.isCurrent(), false);
  } finally {
    globalThis.AbortController = saved;
  }
});

test("left to its own timer, it cancels as a browser allows: clearTimeout is not called as a method", () => {
  const real = globalThis.clearTimeout;
  const canceled = [];
  globalThis.clearTimeout = strict((id) => canceled.push(id));
  try {
    const made = new SceneLife({ later: () => "the wait", restoreMs: 5000, onStillLost() {} });
    made.start();
    const s = scene();
    made.show(s, "3d");
    made.lost(s);
    assert.equal(made.restored(s), true);
    assert.deepEqual(canceled, ["the wait"]);
  } finally {
    globalThis.clearTimeout = real;
  }
});
