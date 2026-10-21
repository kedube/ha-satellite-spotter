// Tests for the passes card (sat-passes-card.js): the countdown, the live
// pass, its timers and refreshes, the states, and opening a pass, on a fake
// DOM and fake time, with the street view stubbed out:
// node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { installClock } from "./helpers/dom-clock.mjs";
import { installDom, installLocation, keydown } from "./helpers/dom-fake.mjs";
import { BOSTON_NOW, bostonHass, makePass } from "./helpers/dom-passes.mjs";
import { stubModules } from "./helpers/dom-stubs.mjs";

stubModules(["sat-street.js"]);
const { document, flush } = installDom();
const nav = installLocation("http://ha.local/lovelace/0");
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

const card = await import("../../custom_components/satellite_spotter/frontend/sat-passes-card.js");
const { compassPoint, hasPanel, lookAt, panelLink } = card;

const MIN = 60;
const PASSES = [
  makePass({ id: "53807-1792276500", title: "BlueWalker 3", start: BOSTON_NOW + 95 * MIN, duration: 206, magnitude: 1.7, elevation: 25, from: "SSW", to: "E", cloud: 7 }),
  makePass({ id: "62078-1792277100", title: "CZ-2C R/B", kind: "rocket", start: BOSTON_NOW + 105 * MIN, duration: 115, magnitude: 2.3, elevation: 58.9, from: "NW", to: "SE", cloud: 7 }),
  makePass({ id: "25544-1792400980", title: "ISS", kind: "iss", start: BOSTON_NOW + 36 * 3600, duration: 146, magnitude: -2.1, bright: true, elevation: 56.1, from: "NW", to: "ENE", cloud: 13 }),
  makePass({ id: "53807-1792366428", title: "BlueWalker 3", start: BOSTON_NOW + 25 * 3600, duration: 118, magnitude: -0.1, bright: true, elevation: 85.4, from: "W", to: "ENE", cloud: 97 }),
  makePass({ id: "101007-1792318250", title: "Starlink Group 15-25 D +21", kind: "starlink", train: true, count: 22, start: BOSTON_NOW + 13 * 3600, duration: 878, magnitude: 2, elevation: 74.6 }),
  makePass({ id: "43641-1792278312", title: "SAOCOM 1-A", start: BOSTON_NOW + 125 * MIN, duration: 234, magnitude: 1.4, elevation: 82.6, from: "NNE", to: "S", cloud: 9 }),
].sort((a, b) => a.start - b.start);
const FIRST = PASSES[0];

/** Rows of a pass track every 10 s: up from the south-west, through north, to 50° and down. */
function rowsFor(pass) {
  const from = pass.start - 60;
  const span = pass.end + 60 - from;
  const rows = [];
  for (let t = from; t <= pass.end + 60; t += 10) {
    const f = (t - from) / span;
    rows.push([t, 0, 0, 420, 1, (200 + 200 * f) % 360, 50 * Math.sin(Math.PI * f), 900, 1.5, 1]);
  }
  return rows;
}
const expectedLook = (pass, t) => {
  const from = pass.start - 60;
  const f = (t - from) / (pass.end + 60 - from);
  return { azimuth: (200 + 200 * f) % 360, elevation: 50 * Math.sin(Math.PI * f) };
};

/** A Home Assistant that answers the integration's commands, and remembers what it was asked. */
function makeHass({ passes = PASSES, payload = {}, panel = true, fail = null, serverAheadS = 0, dark = true } = {}) {
  const asked = [];
  const listeners = {};
  const hass = bostonHass({
    callWS: async (msg) => {
      asked.push(msg);
      if (typeof fail === "function" ? fail(msg) : fail) throw typeof fail === "function" ? fail(msg) : fail;
      if (msg.type === "satellite_spotter/passes") {
        return {
          generated_at: Date.now() / 1000, server_time: Date.now() / 1000 + serverAheadS, computed_at: BOSTON_NOW,
          paused: null, paused_days: null, paused_error: null,
          location: { entry_id: msg.entry_id ?? "home", title: "Home", latitude: 42.36, longitude: -71.06, elevation: 10 },
          settings: { max_magnitude: 3, cloud_cover: true, alert_lead_minutes: 15, units: "auto", days: 5, min_elevation: 10 },
          catalog: { updated: BOSTON_NOW - 3600, version: 3, satellites: 893, median_epoch_age_days: 1.4 },
          passes, ...payload,
        };
      }
      if (msg.type === "satellite_spotter/pass_track") {
        const pass = passes.find((p) => p.id === msg.pass_id);
        return {
          pass_id: pass.id, step: msg.step ?? 2, sun: [],
          transits: [{ norad_id: 1, name: pass.title, kind: pass.kind, offset_s: 0, horizon_rise: pass.start - 60, horizon_set: pass.end + 60,
            visible_start: pass.start, visible_end: pass.end, rows: rowsFor(pass) }],
        };
      }
      throw { code: "unknown_command", message: msg.type };
    },
  });
  hass.panels = panel ? { "satellite-spotter": { component_name: "custom", url_path: "satellite-spotter", config: { _panel_custom: { name: "satellite-spotter-panel" } } } } : {};
  hass.themes = { darkMode: dark };
  hass.connection = {
    addEventListener: (type, fn) => (listeners[type] ??= new Set()).add(fn),
    removeEventListener: (type, fn) => listeners[type]?.delete(fn),
    fire: (type) => listeners[type]?.forEach((fn) => fn()),
    listeners,
  };
  return { hass, asked, passesAsked: () => asked.filter((m) => m.type === "satellite_spotter/passes").length };
}

/** A passes card on the page, at a fake time. */
async function mount({ config = { count: 3 }, at = BOSTON_NOW, ...options } = {}) {
  const clock = installClock(at * 1000);
  const { hass, asked, passesAsked } = makeHass(options);
  const view = document.createElement("satellite-passes-view");
  view.config = config;
  view.hass = hass;
  document.body.appendChild(view);
  await clock.advance(0);
  const root = view.shadowRoot;
  const text = (sel) => root.querySelector(sel)?.textContent ?? null;
  const plain = (s) => s?.replace(/[  ]/g, " ");
  return {
    view, root, clock, hass, asked, passesAsked, plain,
    text: (sel) => plain(text(sel)),
    rows: () => root.querySelector(".list").shadowRoot.querySelectorAll("li.row").map((li) => li.dataset.id),
    async unmount() {
      view.remove();
      clock.restore();
    },
  };
}

test("a countdown to the next pass, then the passes after it", async () => {
  const c = await mount();
  assert.equal(c.text(".state .label"), "Next pass");
  assert.equal(c.text(".clock"), "01:35:00");
  // The cloud for its forecast hour: the first after 6:35 PM.
  assert.equal(c.text(".when"), "Tonight · 6:35 PM7% cloud at 7 PM");
  assert.equal(c.text(".name .title"), "BlueWalker 3");
  assert.equal(c.text(".facts .mag"), "easy to see 1.7");
  assert.equal(c.text(".facts.path"), "SSW→E" + "up to 25°" + "3 min");
  // Saturday evening has a waxing Moon, 43 % lit, low in the south.
  assert.equal(c.root.querySelector(".facts.moon").hidden, false);
  assert.equal(c.text(".facts.moon"), "Moon 43% lit, 21° up in the S");
  assert.match(c.root.querySelector(".facts.moon").innerHTML, /^<svg class="moon-glyph"/);
  assert.equal(c.root.querySelector(".state .chip").hidden, true, "not a bright pass");
  assert.deepEqual(c.rows(), [PASSES[1].id, PASSES[2].id, PASSES[3].id], "the next three, without the one on top");
  assert.equal(c.root.querySelector(".foot").hidden, false);
  assert.equal(c.text(".all"), "All passes");
  assert.equal(c.root.querySelector(".btn.sim").hidden, false);
  assert.equal(c.plain(c.root.querySelector(".main").getAttribute("aria-label")), "BlueWalker 3 at 6:35 PM: open in Satellite Spotter");
  // The sky chart, from the pass track (one row every 10 s).
  assert.deepEqual(c.asked.find((m) => m.type === "satellite_spotter/pass_track"), { type: "satellite_spotter/pass_track", pass_id: FIRST.id, step: 10 });
  assert.equal(c.root.querySelector(".chart").hidden, false);
  assert.match(c.root.querySelector(".chart").innerHTML, /<svg[^>]*role="img"/);
  assert.equal(c.root.querySelector(".chart .live-dot").getAttribute("display"), "none", "not up yet");
  // Too small for times: only the highest point and the brightness are labelled.
  assert.doesNotMatch(c.root.querySelector(".chart").innerHTML, /class="lbl">/);
  assert.match(c.root.querySelector(".chart").innerHTML, /class="lbl peak">/);
  // The list's evening passes get the small Moon too.
  const list = c.root.querySelector(".list").shadowRoot;
  assert.ok(list.querySelector(`li[data-id="${PASSES[1].id}"] .moon`));
  await c.unmount();
});

test("the sky chart's star says the hero's magnitude: the group's brightest satellite", async () => {
  // COSMO-SKYMED with the ISS riding along: the ISS is the brighter, and the pass's magnitude is its.
  const group = makePass({
    id: "67304-1792277000", title: "COSMO-SKYMED-FM3 +1", start: BOSTON_NOW + 600, duration: 300, magnitude: -2.7, bright: true,
    elevation: 70, members: [{ norad_id: 25544, name: "ISS", kind: "iss", magnitude: -2.7, brightest: { azimuth: 90, elevation: 40, direction: "E" } }],
  });
  group.transits[0].magnitude = 1.7;
  const c = await mount({ passes: [group, ...PASSES] });
  assert.equal(c.text(".facts .mag"), "dazzling −2.7");
  const chart = c.root.querySelector(".chart").innerHTML;
  assert.match(chart, /class="star"/);
  assert.ok(chart.includes(">−2.7</text>") || chart.includes("· −2.7</text>"), "the star's label is the hero's magnitude");
  assert.ok(!chart.includes("1.7</text>"), "not the first satellite's");
  await c.unmount();
});

test("the countdown ticks every second, and only while the page is visible", async () => {
  const c = await mount();
  // On the second (just after it, so the countdown has moved on).
  await c.clock.advance(1010);
  assert.equal(c.text(".clock"), "01:34:59");
  await c.clock.advance(60000);
  assert.equal(c.text(".clock"), "01:33:59");
  document.hidden = true;
  document.dispatchEvent(new CustomEvent("visibilitychange"));
  assert.equal(c.clock.pending(), 0, "no ticking, no polling in a hidden page");
  await c.clock.advance(3 * 60000);
  assert.equal(c.text(".clock"), "01:33:59");
  document.hidden = false;
  document.dispatchEvent(new CustomEvent("visibilitychange"));
  await c.clock.advance(0);
  assert.equal(c.text(".clock"), "01:30:59");
  await c.unmount();
});

test("passes are fetched every five minutes, again on return to a page hidden longer, and on reconnecting", async () => {
  const c = await mount();
  assert.equal(c.passesAsked(), 1);
  await c.clock.advance(4 * 60000);
  assert.equal(c.passesAsked(), 1);
  await c.clock.advance(60000);
  assert.equal(c.passesAsked(), 2);
  document.hidden = true;
  document.dispatchEvent(new CustomEvent("visibilitychange"));
  await c.clock.advance(10 * 60000);
  assert.equal(c.passesAsked(), 2);
  document.hidden = false;
  document.dispatchEvent(new CustomEvent("visibilitychange"));
  await c.clock.advance(0);
  assert.equal(c.passesAsked(), 3, "due while hidden: at once");
  c.hass.connection.fire("ready");
  await c.clock.advance(0);
  assert.equal(c.passesAsked(), 4);
  await c.unmount();
});

test("while a pass is up: where to look now, and how it ends; then the next pass", async () => {
  const c = await mount({ at: FIRST.start + 30 });
  assert.equal(c.text(".state .label"), "Visible now");
  assert.equal(c.root.querySelector(".hero").classList.contains("live"), true);
  const look = expectedLook(FIRST, FIRST.start + 30);
  assert.equal(c.text(".clock"), `Look ${compassPoint(look.azimuth)}, ${Math.round(look.elevation)}° up`);
  assert.equal(c.text(".when"), "Ends in 02:56 · sets in the E7% cloud at 7 PM");
  assert.notEqual(c.root.querySelector(".chart .live-dot").getAttribute("display"), "none");
  // A minute later (and the tick just after the second), it has moved.
  await c.clock.advance(60010);
  const later = expectedLook(FIRST, FIRST.start + 90.005);
  assert.equal(c.text(".clock"), `Look ${compassPoint(later.azimuth)}, ${Math.round(later.elevation)}° up`);
  assert.match(c.text(".when"), /^Ends in 01:56/);
  // Said once, when it began; not on the first draw, nor every second.
  assert.equal(c.text("[aria-live]"), "");
  // Over: the next pass, and a fresh look at the predictions just after.
  const asked = c.passesAsked();
  await c.clock.advance((FIRST.end - (FIRST.start + 90)) * 1000 + 2490);
  assert.equal(c.text(".state .label"), "Next pass");
  assert.equal(c.text(".name .title"), "CZ-2C R/B");
  assert.equal(c.text("[aria-live]"), "Next pass: CZ-2C R/B, Sat, Oct 17, 6:45 PM");
  assert.equal(c.passesAsked(), asked + 1);
  await c.unmount();
});

test("bright only: the next bright pass on top, and only bright ones below", async () => {
  const c = await mount({ config: { count: 5, bright_only: true } });
  assert.equal(c.text(".state .label"), "Next bright pass");
  assert.equal(c.text(".name .title"), "BlueWalker 3");
  assert.equal(c.root.querySelector(".state .chip").hidden, false);
  assert.equal(c.text(".state .chip"), "Bright");
  assert.equal(c.text(".when"), "Tomorrow evening · 6:00 PM97% cloud at 7 PM");
  assert.deepEqual(c.rows(), ["25544-1792400980"]);
  // Starlink hidden as asked.
  c.view.config = { count: 5, hide_starlink: true };
  assert.equal(c.rows().includes("101007-1792318250"), false);
  await c.unmount();
});

test("paused predictions, no passes, and errors say so", async () => {
  let c = await mount({ payload: { paused: "stale", paused_days: 16, paused_error: "HTTP 503", passes: [] } });
  assert.equal(c.text(".state .label"), "Predictions paused");
  assert.equal(c.text(".clock"), "Orbit data out of date");
  assert.equal(c.text(".when"), "Orbit data is 16 days old (HTTP 503)");
  assert.equal(c.text(".text"), "Passes come back once fresh orbit data downloads.");
  assert.equal(c.root.querySelector(".actions").hidden, true);
  assert.equal(c.root.querySelector(".list").hidden, true);
  assert.equal(c.root.querySelector(".main").disabled, true);
  await c.unmount();

  c = await mount({ passes: [] });
  assert.equal(c.text(".clock"), "None soon");
  assert.equal(c.text(".when"), "No satellites bright enough to see in the next 5 days.");
  assert.match(c.text(".text"), /after dusk and before dawn/);
  await c.unmount();

  for (const [code, message, expected] of [
    ["not_found", "No location", "Set up the Satellite Spotter integration to see passes here."],
    ["unknown_location", "Gone", "The location this card shows no longer exists. Edit the card and choose a location."],
    ["location_disabled", "Disabled", "This location is disabled. Enable it under Settings > Devices & services, or choose another location."],
    ["not_ready", "Starting up", "Waiting for the satellite catalogue… (Starting up)"],
    ["home_assistant_error", "Boom", "Could not load the passes (Boom). Trying again shortly."],
  ]) {
    c = await mount({ fail: { code, message } });
    assert.equal(c.text(".text"), expected, code);
    assert.equal(c.root.querySelector(".clock .spinner") !== null, code === "not_ready", `${code}: a spinner only while waiting`);
    await c.unmount();
  }
});

test("after an error the card tries again, waiting longer each time, and keeps the passes it has", async () => {
  let failing = false;
  const c = await mount({ fail: (msg) => failing && msg.type === "satellite_spotter/passes" && { code: "not_ready", message: "Starting up" } });
  assert.equal(c.text(".name .title"), "BlueWalker 3");
  failing = true;
  await c.clock.advance(5 * 60000);
  assert.equal(c.passesAsked(), 2);
  assert.equal(c.text(".name .title"), "BlueWalker 3", "the passes stay");
  await c.clock.advance(9000);
  assert.equal(c.passesAsked(), 2);
  await c.clock.advance(1000);
  assert.equal(c.passesAsked(), 3, "10 s later");
  await c.clock.advance(19000);
  assert.equal(c.passesAsked(), 3);
  await c.clock.advance(1000);
  assert.equal(c.passesAsked(), 4, "then 20 s");
  failing = false;
  await c.clock.advance(40000);
  assert.equal(c.passesAsked(), 5);
  await c.clock.advance(5 * 60000);
  assert.equal(c.passesAsked(), 6, "back to every five minutes");
  await c.unmount();
});

test("a tap opens the pass in the sidebar panel", async () => {
  const c = await mount({ config: { count: 3, entry_id: "home" } });
  let changed = 0;
  const onChange = () => changed++;
  globalThis.addEventListener("location-changed", onChange);
  c.root.querySelector(".main").click();
  assert.equal(nav.pushed.at(-1), `http://ha.local/satellite-spotter?entry_id=home&pass=${FIRST.id}`);
  c.root.querySelector(".btn.sim").click();
  assert.equal(nav.pushed.at(-1), `http://ha.local/satellite-spotter?entry_id=home&pass=${FIRST.id}&view=simulate`);
  c.root.querySelector(".btn.street").click();
  assert.equal(nav.pushed.at(-1), `http://ha.local/satellite-spotter?entry_id=home&pass=${FIRST.id}&view=street`);
  const list = c.root.querySelector(".list").shadowRoot;
  list.querySelector(`li[data-id="${PASSES[1].id}"] button.pick`).click();
  assert.equal(nav.pushed.at(-1), `http://ha.local/satellite-spotter?entry_id=home&pass=${PASSES[1].id}`);
  c.root.querySelector(".all").click();
  assert.equal(nav.pushed.at(-1), "http://ha.local/satellite-spotter?entry_id=home");
  assert.equal(changed, 5);
  globalThis.removeEventListener("location-changed", onChange);
  // In the card editor, the card looks the same but taps stay put.
  const before = nav.pushed.length;
  c.view.editorPreview = true;
  assert.equal(c.root.querySelector(".btn.sim").hidden, false);
  c.root.querySelector(".btn.sim").click();
  c.root.querySelector(".main").click();
  c.root.querySelector(".all").click();
  assert.equal(nav.pushed.length, before);
  await c.unmount();
});

test("in the list the arrow keys only move through the passes, and Enter opens one", async () => {
  const c = await mount({ config: { count: 3, entry_id: "home" } });
  const list = c.root.querySelector(".list").shadowRoot;
  const row = list.querySelector(`li[data-id="${PASSES[1].id}"] button.pick`);
  const before = nav.pushed.length;
  keydown(row, "ArrowDown");
  keydown(row, "End");
  assert.equal(nav.pushed.length, before, "browsing stays on the dashboard");
  keydown(row, "Enter");
  assert.equal(nav.pushed.at(-1), `http://ha.local/satellite-spotter?entry_id=home&pass=${PASSES[1].id}`);
  await c.unmount();
});

test("without the panel, the street view opens over the card, and closes", async () => {
  store.set("satellite-spotter:street", JSON.stringify({ imagery: "aerial", eyeHeightM: 6, constellations: false, follow: true }));
  const c = await mount({ panel: false });
  assert.equal(c.root.querySelector(".btn.sim").hidden, true, "no globe to simulate on");
  assert.equal(c.root.querySelector(".foot").hidden, true);
  const button = c.root.querySelector(".btn.street");
  button.click();
  assert.equal(c.view.hasAttribute("overlay"), true);
  const overlay = c.root.querySelector(".overlay");
  assert.equal(overlay.getAttribute("role"), "dialog");
  assert.equal(overlay.getAttribute("aria-modal"), "true");
  await c.clock.advance(0);
  const street = overlay.querySelector("satellite-street-view");
  assert.ok(street, "the street view is in");
  assert.equal(street.pass.id, FIRST.id);
  assert.equal(street.detail.pass_id, FIRST.id);
  assert.equal(street.location.title, "Home");
  assert.equal(street.formatter.time(FIRST.start).replace(/ /g, " "), "6:35 PM");
  assert.deepEqual(street.options, { imagery: "aerial", eyeHeightM: 6, constellations: false, follow: true });
  assert.equal(street.clock.mode, "sim", "a pass to come is simulated");
  assert.deepEqual(street.calls.map((call) => call[0]), ["open"]);
  // The street view keeps its own settings (it stores them itself): the card leaves them alone.
  street.fire("options-changed", { imagery: "map", eyeHeightM: 1.7, constellations: true, follow: false });
  assert.equal(JSON.parse(store.get("satellite-spotter:street")).imagery, "aerial");
  assert.equal(overlay.classList.contains("ready"), true, "its own close button from now on");
  // Focus that wanders off the dialog comes back to it.
  c.root.querySelector(".main").focus();
  document.dispatchEvent(Object.assign(new CustomEvent("focusin", { bubbles: true, composed: true }), {
    composedPath: () => [c.root.querySelector(".main"), c.root, c.view, document.body],
  }));
  assert.equal(c.root.activeElement, street);
  street.fire("close");
  assert.deepEqual(street.calls.at(-1), ["dispose"]);
  assert.equal(c.root.querySelector(".overlay"), null);
  assert.equal(c.view.hasAttribute("overlay"), false);
  assert.equal(c.root.activeElement, button, "focus goes back where it was");
  // Escape closes it too; a pass on now is followed live.
  await c.clock.advance((FIRST.start + 10 - BOSTON_NOW) * 1000);
  c.root.querySelector(".main").click();
  await c.clock.advance(0);
  const live = c.root.querySelector(".overlay satellite-street-view");
  assert.equal(live.clock.mode, "live");
  keydown(c.root.querySelector(".overlay"), "Escape");
  assert.equal(c.root.querySelector(".overlay"), null);
  assert.deepEqual(live.calls.at(-1), ["dispose"]);
  await c.unmount();
});

test("where the browser can, the street view takes the whole screen, and leaves with it", async () => {
  const { FakeElement } = await import("./helpers/dom-fake.mjs");
  let exits = 0;
  FakeElement.prototype.requestFullscreen = function () {
    this.getRootNode().fullscreenElement = this;
    document.dispatchEvent(new CustomEvent("fullscreenchange"));
    return Promise.resolve();
  };
  document.exitFullscreen = async () => {
    exits++;
    c.root.fullscreenElement = null;
  };
  const c = await mount({ panel: false });
  try {
    c.root.querySelector(".btn.street").click();
    await c.clock.advance(0);
    const overlay = c.root.querySelector(".overlay");
    assert.equal(c.root.fullscreenElement, overlay);
    // Escape in the browser's fullscreen: the browser leaves it, the street view closes too.
    c.root.fullscreenElement = null;
    document.dispatchEvent(new CustomEvent("fullscreenchange"));
    assert.equal(c.root.querySelector(".overlay"), null);
    assert.equal(exits, 0, "already out");
    // Closed from inside: out of fullscreen as well.
    c.root.querySelector(".btn.street").click();
    await c.clock.advance(0);
    c.root.querySelector(".overlay satellite-street-view").fire("close");
    assert.equal(exits, 1);
  } finally {
    delete FakeElement.prototype.requestFullscreen;
    delete document.exitFullscreen;
    await c.unmount();
  }
});

test("the street view follows a pass live from two minutes before it, as the globe does, and replays one further off", async () => {
  for (const [before, mode] of [[90, "live"], [150, "sim"]]) {
    const c = await mount({ panel: false, at: FIRST.start - before });
    try {
      c.root.querySelector(".btn.street").click();
      await c.clock.advance(0);
      const street = c.root.querySelector(".overlay satellite-street-view");
      assert.equal(street.clock.mode, mode, `${before} s before it`);
      if (mode === "sim") {
        // From two minutes before it to a minute after.
        assert.deepEqual(street.clock.window, { fromS: FIRST.start - 120, toS: FIRST.end + 60, visibleStartS: FIRST.start, visibleEndS: FIRST.end });
      }
      street.fire("close");
    } finally {
      await c.unmount();
    }
  }
});

test("the street view stays open while the dashboard moves the card, and closes once the card is gone", async () => {
  const c = await mount({ panel: false });
  const column = document.createElement("div");
  document.body.appendChild(column);
  try {
    c.root.querySelector(".btn.street").click();
    await c.clock.advance(0);
    const overlay = c.root.querySelector(".overlay");
    const street = overlay.querySelector("satellite-street-view");
    assert.ok(document.activeElement === c.view);
    // A masonry view re-columns (the phone turned): its cards leave the page,
    // then go into their new columns one by one.
    c.view.remove();
    assert.ok(document.activeElement === document.body, "the focus left with the card");
    await c.clock.advance(300);
    column.appendChild(c.view);
    await c.clock.advance(5000);
    assert.ok(c.root.querySelector(".overlay") === overlay, "still open");
    assert.equal(c.view.hasAttribute("overlay"), true);
    assert.deepEqual(street.calls.map((call) => call[0]), ["open"], "the same street view, never disposed");
    assert.ok(document.activeElement === c.view, "the keyboard is back in the street view");
    assert.ok(c.root.activeElement === street);
    // Off the page for good (another view, another page): closed a moment later.
    c.view.remove();
    await c.clock.advance(900);
    assert.ok(c.root.querySelector(".overlay") === overlay, "open a little longer");
    await c.clock.advance(100);
    assert.ok(!c.root.querySelector(".overlay"), "closed");
    assert.equal(c.view.hasAttribute("overlay"), false);
    assert.deepEqual(street.calls.at(-1), ["dispose"]);
    assert.equal(c.clock.pending(), 0, "nothing left waiting");
  } finally {
    column.remove();
    await c.unmount();
  }
});

test("a card moved out of the browser's fullscreen keeps its street view, as the fixed overlay phones get", async () => {
  const { FakeElement } = await import("./helpers/dom-fake.mjs");
  FakeElement.prototype.requestFullscreen = function () {
    this.getRootNode().fullscreenElement = this;
    document.dispatchEvent(new CustomEvent("fullscreenchange"));
    return Promise.resolve();
  };
  document.exitFullscreen = async () => {};
  const c = await mount({ panel: false });
  const column = document.createElement("div");
  document.body.appendChild(column);
  try {
    // A fullscreen element taken off the page leaves fullscreen at once; the
    // browser says so a frame later, before or after the dashboard puts the card back.
    for (const late of [false, true]) {
      c.root.querySelector(".btn.street").click();
      await c.clock.advance(0);
      const overlay = c.root.querySelector(".overlay");
      assert.ok(c.root.fullscreenElement === overlay);
      c.view.remove();
      c.root.fullscreenElement = null;
      if (!late) document.dispatchEvent(new CustomEvent("fullscreenchange"));
      column.appendChild(c.view);
      if (late) document.dispatchEvent(new CustomEvent("fullscreenchange"));
      await c.clock.advance(2000);
      assert.ok(c.root.querySelector(".overlay") === overlay, late ? "told once the card was back" : "told while it was away");
      // Still the user's to close.
      keydown(overlay, "Escape");
      assert.ok(!c.root.querySelector(".overlay"), "closed");
    }
  } finally {
    delete FakeElement.prototype.requestFullscreen;
    delete document.exitFullscreen;
    column.remove();
    await c.unmount();
  }
});

test("taking the card off the page stops its timers and lets go of the connection", async () => {
  const c = await mount();
  assert.ok(c.clock.pending() >= 2, "a tick and a refresh");
  assert.equal(c.hass.connection.listeners.ready.size, 1);
  c.view.remove();
  assert.equal(c.clock.pending(), 0);
  assert.equal(c.hass.connection.listeners.ready.size, 0);
  // Back on the page: running again.
  document.body.appendChild(c.view);
  await c.clock.advance(0);
  assert.ok(c.clock.pending() >= 2);
  await c.unmount();
});

test("the countdown keeps Home Assistant's time, not the device's", async () => {
  const c = await mount({ serverAheadS: 30 });
  assert.equal(c.text(".clock"), "01:34:30");
  await c.unmount();
});

test("another location shows its own passes", async () => {
  const c = await mount({ config: { count: 3 } });
  assert.equal(c.asked[0].entry_id, undefined, "the first location");
  c.view.config = { count: 3, entry_id: "cabin" };
  await c.clock.advance(0);
  assert.equal(c.asked.filter((m) => m.type === "satellite_spotter/passes").at(-1).entry_id, "cabin");
  await c.unmount();
});

test("light dashboards get the light colours; the night sky stays dark", async () => {
  const c = await mount({ dark: false });
  assert.equal(c.view.hasAttribute("light"), true);
  c.view.hass = { ...c.hass, themes: { darkMode: true } };
  assert.equal(c.view.hasAttribute("light"), false);
  await c.unmount();
});

test("where a satellite is, between rows and across north", () => {
  const rows = [[0, 0, 0, 0, 1, 350, 10], [10, 0, 0, 0, 1, 10, 20], [20, 0, 0, 0, 1, 30, 40]];
  assert.deepEqual(lookAt(rows, 5), { azimuth: 0, elevation: 15 });
  assert.deepEqual(lookAt(rows, 15), { azimuth: 20, elevation: 30 });
  assert.equal(lookAt(rows, 2.5).azimuth, 355);
  assert.equal(lookAt(rows, -1), null);
  assert.equal(lookAt(rows, 21), null);
  assert.equal(lookAt(null, 5), null);
  assert.deepEqual([0, 11.2, 11.3, 202.5, 359, 348.7].map(compassPoint), ["N", "N", "NNE", "SSW", "N", "NNW"]);
  assert.equal(panelLink("1-2", { view: "street", entryId: "e" }), "/satellite-spotter?entry_id=e&pass=1-2&view=street");
  assert.equal(panelLink(null, { view: "street" }), "/satellite-spotter");
  assert.equal(hasPanel({ panels: { "satellite-spotter": { component_name: "lovelace", config: {} } } }), false, "a dashboard at the same address");
  assert.equal(hasPanel({ panels: {} }), false);
  assert.equal(hasPanel(undefined), false);
});

test("the card knows a light theme even before Home Assistant says which theme is on", () => {
  const { darkTheme } = card;
  assert.equal(darkTheme({ themes: { darkMode: false } }), false);
  assert.equal(darkTheme({ themes: { darkMode: true }, selectedTheme: { dark: false } }), true, "darkMode wins");
  // Home Assistant's frontend can leave darkMode unset after the first load.
  assert.equal(darkTheme({ themes: {}, selectedTheme: { dark: false } }), false);
  assert.equal(darkTheme({ themes: {} }, () => ({ matches: false })), false, "auto follows the system");
  assert.equal(darkTheme({ themes: {} }, () => ({ matches: true })), true);
  assert.equal(darkTheme(undefined, undefined), true, "with nothing to go on, the dark night-sky look");
});
