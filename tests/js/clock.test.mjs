// Tests for the clock the globe, the street view and the time bar share:
// node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HOLD_MS,
  MAX_STEP_MS,
  PASS_LEAD_S,
  PassClock,
  approachMs,
  fitRate,
  passIsLive,
} from "../../custom_components/satellite_spotter/frontend/sat-clock.js";

const NOW = Date.parse("2026-10-17T21:00:00Z");
// The bright ISS pass over Boston in the fixtures: 146 s visible.
const PASS = { start: 1792400980, end: 1792401126 };
const WINDOW = { fromS: PASS.start - 120, toS: PASS.end + 60, visibleStartS: PASS.start, visibleEndS: PASS.end };

const near = (actual, expected, label = "") =>
  assert.ok(Math.abs(actual - expected) < 1e-4, `${label} ${actual} != ${expected}`);

function clockAt(nowMs = NOW) {
  const real = { now: nowMs };
  const clock = new PassClock({ now: () => real.now });
  const changes = [];
  clock.on("change", (ev) => changes.push(ev.reason));
  return { clock, real, changes };
}

/** Tick every 16 ms for `ms` of real time, starting at `from`; returns the last real time. */
function run(clock, from, ms, step = 16) {
  let t = from;
  for (const end = from + ms; t < end; ) {
    t = Math.min(end, t + step);
    clock.tick(t);
  }
  return t;
}

test("live, the clock is Home Assistant's time", () => {
  const { clock, real } = clockAt();
  assert.equal(clock.mode, "live");
  assert.equal(clock.phase, "live");
  assert.equal(clock.simMs, NOW);
  real.now += 5000;
  assert.equal(clock.simMs, NOW + 5000);
  assert.equal(clock.tick(123), NOW + 5000);
  assert.equal(clock.playing, true);
  assert.equal(clock.rate, 1);
  assert.equal(clock.window, null);
  // Nothing to pause, seek or end live.
  clock.pause();
  clock.seek(PASS.start);
  clock.toggle();
  assert.equal(clock.mode, "live");
  assert.equal(clock.simMs, NOW + 5000);
});

test("'fit' replays the visible part in about 20 s, and the whole loop in at most 45 s", () => {
  assert.equal(fitRate(WINDOW), 146 / 20);
  // A short pass: the lead-in and tail would make the loop drag, so it goes faster.
  const short = { fromS: 0, toS: 240, visibleStartS: 120, visibleEndS: 180 };
  assert.equal(fitRate(short), 240 / 45);
  // A Starlink train of 878 s.
  assert.equal(fitRate({ fromS: 0, toS: 1058, visibleStartS: 120, visibleEndS: 998 }), 878 / 20);
  // Never slower than real time.
  assert.equal(fitRate({ fromS: 0, toS: 10, visibleStartS: 2, visibleEndS: 4 }), 1);
  assert.equal(fitRate(null), 1);
});

test("a replay plays at the chosen speed, holds a beat at the end, and starts over", () => {
  const { clock, changes } = clockAt();
  clock.simulate(WINDOW);
  assert.equal(clock.mode, "sim");
  assert.equal(clock.phase, "replay");
  assert.deepEqual({ ...clock.window }, WINDOW);
  assert.equal(clock.simS, WINDOW.fromS);
  assert.equal(clock.rate, 7.3);
  assert.equal(clock.rateSetting, "fit");
  // The first tick only sets the baseline.
  clock.tick(1000);
  assert.equal(clock.simS, WINDOW.fromS);
  run(clock, 1000, 1000);
  near(clock.simS, WINDOW.fromS + 7.3);
  clock.setRate(30);
  assert.equal(clock.rate, 30);
  // (326 s − 7.3 s) / 30 = 10.6 s to the end.
  let t = run(clock, 2000, 10600);
  assert.ok(clock.simS < WINDOW.toS);
  t = run(clock, t, 100);
  assert.equal(clock.simS, WINDOW.toS, "stops at the end of the window");
  assert.equal(clock.playing, true, "still playing: holding before the loop");
  t = run(clock, t, HOLD_MS - 100);
  assert.equal(clock.simS, WINDOW.toS);
  while (!changes.includes("loop") && t < 20000) clock.tick((t += 16));
  assert.equal(clock.simS, WINDOW.fromS, "started over");
  clock.tick(t + 16);
  near(clock.simS, WINDOW.fromS + 0.48, "and plays on");
  assert.deepEqual(changes, ["simulate", "rate", "loop"]);
});

test("without looping the replay stops at the end, and play starts it again", () => {
  const { clock, changes } = clockAt();
  clock.simulate({ ...WINDOW, loop: false, rate: 60 });
  run(clock, 0, 10000);
  assert.equal(clock.simS, WINDOW.toS);
  assert.equal(clock.playing, false);
  assert.equal(clock.ended, true);
  assert.equal(clock.progress, 1);
  clock.toggle();
  assert.equal(clock.playing, true);
  assert.equal(clock.simS, WINDOW.fromS);
  assert.deepEqual(changes, ["simulate", "end", "play"]);
});

test("pause, play and seek; seeking stays inside the window", () => {
  const { clock, changes } = clockAt();
  clock.simulate({ ...WINDOW, rate: 10 });
  clock.tick(0);
  clock.tick(400);
  clock.pause();
  assert.equal(clock.playing, false);
  const at = clock.simS;
  near(at, WINDOW.fromS + 4);
  run(clock, 1000, 5000);
  assert.equal(clock.simS, at, "time stands still while paused");
  clock.play();
  // The paused stretch is not made up for when it plays again.
  clock.tick(60000);
  assert.equal(clock.simS, at);
  clock.tick(60300);
  near(clock.simS, at + 3);
  clock.seek(PASS.start + 30);
  assert.equal(clock.simS, PASS.start + 30);
  clock.seek(0);
  assert.equal(clock.simS, WINDOW.fromS);
  clock.seek(PASS.end + 9999);
  assert.equal(clock.simS, WINDOW.toS);
  assert.equal(clock.progress, 1);
  clock.seek(Number.NaN);
  assert.equal(clock.simS, WINDOW.toS);
  assert.deepEqual(changes, ["simulate", "pause", "play", "seek", "seek", "seek"]);
});

test("a stalled page carries on where it was, not minutes later", () => {
  const { clock } = clockAt();
  clock.simulate({ ...WINDOW, rate: 5 });
  clock.tick(0);
  clock.tick(10 * 60 * 1000); // ten minutes in a hidden tab
  near(clock.simS, WINDOW.fromS + (MAX_STEP_MS / 1000) * 5);
});

test("several views ticking one clock move it at real speed", () => {
  const { clock } = clockAt();
  clock.simulate({ ...WINDOW, rate: 1 });
  clock.tick(0);
  for (let t = 16; t <= 1600; t += 16) {
    clock.tick(t); // the globe
    clock.tick(t + 3); // the street view, a little later in the same frame
  }
  near(clock.simS, WINDOW.fromS + 1.603);
});

test("the fast-forward eases from now to the pass, then the replay plays", () => {
  const { clock, changes } = clockAt();
  const nowS = NOW / 1000;
  clock.simulate({ ...WINDOW, approachFromS: nowS, periodS: 5578 });
  assert.equal(clock.phase, "approach");
  assert.equal(clock.playing, true);
  assert.equal(clock.simS, nowS);
  assert.equal(clock.progress, 0);
  const duration = approachMs(WINDOW.fromS - nowS, 5578);
  assert.equal(duration, 9000, "36 h of orbits squeezed into the longest fast-forward");
  let last = -Infinity;
  for (let t = 0; t <= duration; t += 50) {
    const s = clock.tick(t) / 1000;
    assert.ok(s >= last, `time went backwards at ${t} ms`);
    assert.ok(s <= WINDOW.fromS);
    last = s;
  }
  assert.equal(clock.phase, "replay");
  assert.equal(clock.simS, WINDOW.fromS, "lands exactly on the start");
  clock.tick(duration + 100);
  near(clock.simS, WINDOW.fromS + 0.73, "then plays on at the replay's speed");
  assert.deepEqual(changes, ["simulate", "phase"]);
  // A pass a little over an orbit away gets a shorter one, never under 3 s.
  assert.equal(approachMs(5578 * 3, 5578), 4500);
  assert.equal(approachMs(600, 5578), 3000);
});

test("pausing or seeking during the fast-forward cancels it", () => {
  const { clock } = clockAt();
  clock.simulate({ ...WINDOW, approachFromS: NOW / 1000 });
  clock.tick(0);
  clock.tick(1000);
  clock.pause();
  assert.equal(clock.phase, "replay");
  assert.equal(clock.simS, WINDOW.fromS, "waits at the start of the replay");
  assert.equal(clock.playing, false);
  clock.simulate({ ...WINDOW, approachFromS: NOW / 1000 });
  clock.tick(0);
  clock.seek(PASS.start);
  assert.equal(clock.phase, "replay");
  assert.equal(clock.simS, PASS.start);
  // Starting paused, or with nothing to fast-forward, skips it.
  clock.simulate({ ...WINDOW, approachFromS: NOW / 1000, playing: false });
  assert.equal(clock.phase, "replay");
  clock.simulate({ ...WINDOW, approachFromS: PASS.start - 0.5, startS: PASS.start });
  assert.equal(clock.phase, "replay");
  assert.equal(clock.simS, PASS.start);
});

test("bad input is refused, and back to live is clean", () => {
  const { clock, real, changes } = clockAt();
  assert.throws(() => clock.simulate({ fromS: 10, toS: 10 }), RangeError);
  assert.throws(() => clock.simulate({ fromS: Number.NaN, toS: 10 }), RangeError);
  clock.simulate({ ...WINDOW, rate: "warp" });
  assert.equal(clock.rateSetting, "fit");
  for (const bad of [0, -5, Number.NaN, Infinity, "x", null]) clock.setRate(bad);
  assert.equal(clock.rateSetting, "fit");
  // The visible part is kept inside the window, and the start too.
  clock.simulate({ fromS: 100, toS: 200, visibleStartS: 50, visibleEndS: 500, startS: 400 });
  assert.deepEqual({ ...clock.window }, { fromS: 100, toS: 200, visibleStartS: 100, visibleEndS: 200 });
  assert.equal(clock.simS, 200);
  clock.live();
  assert.equal(clock.mode, "live");
  assert.equal(clock.window, null);
  assert.equal(clock.simMs, real.now);
  clock.live();
  assert.equal(changes.filter((c) => c === "live").length, 1);
});

test("listeners can unsubscribe, and one that throws does not silence the others", () => {
  const { clock } = clockAt();
  const saved = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const seen = [];
    clock.on("change", () => {
      throw new Error("broken view");
    });
    const off = clock.on("change", (ev) => seen.push(ev.reason));
    assert.equal(typeof clock.on("tick", () => {}), "function");
    clock.simulate(WINDOW);
    off();
    clock.live();
    assert.deepEqual(seen, ["simulate"]);
    assert.equal(errors.length, 2);
  } finally {
    console.error = saved;
  }
});

test("a pass is watched live from two minutes before it starts until it ends, and replayed otherwise", () => {
  const pass = { start: 10000, end: 10400 };
  assert.equal(PASS_LEAD_S, 120);
  assert.equal(passIsLive(pass, pass.start - PASS_LEAD_S - 1), false);
  assert.equal(passIsLive(pass, pass.start - PASS_LEAD_S), true);
  assert.equal(passIsLive(pass, pass.start - 90), true, "90 s before: the countdown is on, live");
  assert.equal(passIsLive(pass, pass.end - 1), true);
  assert.equal(passIsLive(pass, pass.end), false);
});
