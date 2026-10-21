// Tests for the time bar shared by the globe and the street view, with a tiny
// fake DOM: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { installDom } from "./helpers/view-dom.mjs";
import { fakeFormatter } from "./helpers/view-format.mjs";

installDom();
const { PassClock } = await import("../../custom_components/satellite_spotter/frontend/sat-clock.js");
const { Timebar, formatRate, timebarState } = await import("../../custom_components/satellite_spotter/frontend/sat-timebar.js");

const NOW_S = Date.parse("2026-10-17T21:00:00Z") / 1000;
const PASS = { id: "25544-1792400980", start: 1792400980, end: 1792401126 };
const WINDOW = { fromS: PASS.start - 120, toS: PASS.end + 60, visibleStartS: PASS.start, visibleEndS: PASS.end };

function setup({ callbacks = {}, nowS = NOW_S } = {}) {
  const real = { now: nowS * 1000 };
  const clock = new PassClock({ now: () => real.now });
  const container = document.createElement("div");
  const fmt = fakeFormatter();
  const calls = { live: 0, toggle: 0, close: 0, simulate: 0 };
  const bar = new Timebar(container, {
    clock,
    formatter: fmt,
    onLive: () => calls.live++,
    ...callbacks,
  });
  const $ = (sel) => container.querySelector(sel);
  return { real, clock, container, fmt, bar, calls, $ };
}

test("rates read as 7.3× or 44×", () => {
  assert.equal(formatRate(7.3), "7.3");
  assert.equal(formatRate(43.9), "44");
  assert.equal(formatRate(5), "5");
  assert.equal(formatRate(1.02), "1");
  assert.equal(formatRate(2.5, (v, d) => v.toFixed(d).replace(".", ",")), "2,5");
});

test("the state says where the replay is relative to the visible part", () => {
  const real = { now: NOW_S * 1000 };
  const clock = new PassClock({ now: () => real.now });
  // Live, before and during the pass.
  let s = timebarState(clock, { pass: PASS });
  assert.equal(s.live, true);
  assert.equal(s.status.key, "starts_in");
  assert.equal(s.status.ms, (PASS.start - NOW_S) * 1000);
  real.now = (PASS.start + 10) * 1000;
  s = timebarState(clock, { pass: PASS });
  assert.deepEqual(s.status, { key: "visible_left", ms: 136000, on: true });
  real.now = (PASS.end + 10) * 1000;
  assert.equal(timebarState(clock, { pass: PASS }).status, null);
  // Simulating: before, in and after the visible part.
  clock.simulate(WINDOW);
  s = timebarState(clock, { pass: PASS });
  assert.equal(s.live, false);
  assert.equal(s.status.key, "appears_in");
  assert.equal(s.status.ms, 120000);
  assert.deepEqual(s.visible.map((v) => +v.toFixed(4)), [+(120 / 326).toFixed(4), +(266 / 326).toFixed(4)]);
  clock.seek(PASS.start + 46);
  assert.deepEqual(timebarState(clock).status, { key: "visible_left", ms: 100000, on: true });
  clock.seek(PASS.end + 30);
  assert.equal(timebarState(clock).status.key, "after");
  // The fast-forward has no status: it is not at the pass yet.
  clock.simulate({ ...WINDOW, approachFromS: NOW_S });
  assert.equal(timebarState(clock).phase, "approach");
  assert.equal(timebarState(clock).status, null);
});

test("the bar follows the clock: tag, time, play button, speed and slider", () => {
  const { clock, bar, $ } = setup();
  bar.setContext({ pass: PASS, label: "ISS", view: "globe" });
  const root = $(".sat-tb");
  assert.equal(root.getAttribute("role"), "group");
  assert.equal(root.getAttribute("aria-label"), "Simulation controls");
  assert.ok(root.classList.contains("live"));
  assert.equal($(".tb-tag").textContent, "Live");
  assert.equal($(".tb-play").hidden, true, "nothing to replay without onSimulate");
  assert.equal($(".tb-live").hidden, true);
  assert.equal($(".tb-speed").hidden, true);
  assert.equal($(".tb-status").textContent, "starts in 1d 12:09:40");

  clock.simulate(WINDOW);
  assert.ok(!root.classList.contains("live"));
  assert.equal($(".tb-tag").textContent, "Simulation");
  assert.equal($(".tb-label").textContent, "ISS");
  assert.equal($(".tb-time").textContent, "09:07:40");
  assert.equal($(".tb-date").textContent, "Mon, Oct 19");
  assert.equal($(".tb-status").textContent, "appears in 02:00");
  assert.equal($(".tb-play").getAttribute("aria-label"), "Pause");
  assert.equal($(".tb-play").dataset.icon, "pause");
  assert.equal($(".tb-live").hidden, false);
  assert.equal($(".tb-seek").getAttribute("aria-valuetext"), "09:07:40, Mon, Oct 19");
  // The visible part of the pass, in gold on the slider.
  assert.equal($(".tb-track").style.getPropertyValue("--vs"), (120 / 326).toFixed(4));
  assert.equal($(".tb-track").style.getPropertyValue("--ve"), (266 / 326).toFixed(4));
  // Speeds: "Auto" shows what it means for this pass.
  const options = $(".tb-rate").children.map((o) => [o.value, o.textContent]);
  assert.deepEqual(options, [["fit", "Auto · 7.3×"], ["1", "1×"], ["5", "5×"], ["10", "10×"], ["30", "30×"], ["60", "60×"]]);
  assert.equal($(".tb-rate").value, "fit");

  clock.tick(0);
  clock.seek(PASS.start + 10);
  bar.update();
  assert.equal($(".tb-time").textContent, "09:09:50");
  assert.equal($(".tb-status").textContent, "visible, 02:16 left");
  assert.ok($(".tb-status").classList.contains("on"));
  assert.equal($(".tb-seek").value, String(Math.round((130 / 326) * 1000)));
  assert.equal($(".tb-track").style.getPropertyValue("--p"), (130 / 326).toFixed(4));

  clock.pause();
  assert.equal($(".tb-play").getAttribute("aria-label"), "Play");
  assert.equal($(".tb-play").dataset.icon, "play");
  clock.setRate(2.5); // not one of the menu's: it is added
  assert.deepEqual($(".tb-rate").children.map((o) => o.value), ["fit", "1", "5", "10", "30", "60", "2.5"]);
  assert.equal($(".tb-rate").value, "2.5");
});

test("the controls drive the clock", () => {
  const callbacks = {
    onToggleView: () => calls.toggle++,
    onClose: () => calls.close++,
    onSimulate: () => calls.simulate++,
  };
  const { clock, bar, $, calls } = setup({ callbacks });
  Object.assign(calls, { toggle: 0, close: 0, simulate: 0 });
  // Live, the play button asks the host to replay the pass.
  assert.equal($(".tb-play").hidden, false);
  assert.equal($(".tb-play").getAttribute("aria-label"), "Replay the pass");
  $(".tb-play").click();
  assert.equal(calls.simulate, 1);
  clock.simulate(WINDOW);
  $(".tb-play").click();
  assert.equal(clock.playing, false);
  $(".tb-play").click();
  assert.equal(clock.playing, true);
  // Space on the slider plays and pauses, as in a video player.
  const space = $(".tb-seek").fire("keydown", { key: " ", repeat: false });
  assert.equal(space.defaultPrevented, true);
  assert.equal(clock.playing, false);
  $(".tb-seek").fire("keydown", { key: " ", repeat: true });
  assert.equal(clock.playing, false, "a held key does not flicker");
  // The slider seeks; while it is dragged, frames do not move it back.
  $(".tb-seek").fire("pointerdown");
  $(".tb-seek").value = "500";
  $(".tb-seek").fire("input");
  assert.equal(clock.simS, WINDOW.fromS + 163);
  clock.seek(WINDOW.fromS + 10);
  bar.update();
  assert.equal($(".tb-seek").value, "500");
  $(".tb-seek").fire("pointerup");
  clock.seek(WINDOW.fromS + 20);
  assert.equal($(".tb-seek").value, String(Math.round((20 / 326) * 1000)));
  // The speed menu.
  $(".tb-rate").value = "30";
  $(".tb-rate").fire("change");
  assert.equal(clock.rateSetting, 30);
  $(".tb-rate").value = "fit";
  $(".tb-rate").fire("change");
  assert.equal(clock.rateSetting, "fit");
  // Looping, on by default, can be turned off: the replay then stops at its end.
  assert.equal($(".tb-loop").getAttribute("aria-pressed"), "true");
  assert.equal($(".tb-loop").getAttribute("aria-label"), "Replay the pass over and over");
  $(".tb-loop").click();
  assert.equal(clock.loop, false);
  assert.equal($(".tb-loop").getAttribute("aria-pressed"), "false");
  $(".tb-loop").click();
  assert.equal(clock.loop, true);
  // The buttons the host listens for.
  $(".tb-live").click();
  $(".tb-view").click();
  $(".tb-close").click();
  assert.deepEqual([calls.live, calls.toggle, calls.close], [1, 1, 1]);
  // The view switch names where it goes.
  assert.equal($(".tb-view").getAttribute("aria-label"), "Street view");
  bar.setContext({ view: "street" });
  assert.equal($(".tb-view").getAttribute("aria-label"), "Globe");
  assert.match($(".tb-view .tb-ico").innerHTML, /^<svg/);
});

test("without the optional callbacks their buttons are not there", () => {
  const { $ } = setup();
  assert.equal($(".tb-view").hidden, true);
  assert.equal($(".tb-close").hidden, true);
});

test("a replay that has stopped at the end offers to play it again", () => {
  const { clock, $ } = setup();
  clock.simulate({ ...WINDOW, loop: false, rate: 60 });
  for (let t = 0; t <= 6000; t += 16) clock.tick(t);
  assert.equal(clock.ended, true);
  assert.equal($(".tb-play").getAttribute("aria-label"), "Play again");
  assert.equal($(".tb-play").dataset.icon, "replay");
  $(".tb-play").click();
  assert.equal(clock.simS, WINDOW.fromS);
  assert.equal(clock.playing, true);
});

test("frames are cheap: the time is worded once a second, and nothing after destroy", () => {
  const { clock, bar, fmt, container, $ } = setup();
  clock.simulate({ ...WINDOW, rate: 1 });
  clock.tick(0);
  const before = fmt.calls.time;
  for (let t = 16; t < 1000; t += 16) {
    clock.tick(t);
    bar.update();
  }
  assert.ok(fmt.calls.time - before <= 1, `${fmt.calls.time - before} times worded in under a second`);
  bar.destroy();
  assert.equal(container.children.length, 0);
  clock.live();
  bar.update();
  assert.equal($(".tb-tag"), null);
});

test("a change of language rewords the bar", () => {
  const { bar, fmt, $ } = setup();
  assert.equal($(".tb-live .long").textContent, "Back to live");
  fmt.t = (key) => `[${key}]`;
  bar.refresh();
  assert.equal($(".tb-live .long").textContent, "[timebar.live]");
  assert.equal($(".tb-tag").textContent, "[timebar.live_tag]");
});
