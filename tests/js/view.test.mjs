// Tests for the globe view's scheduling, data and state handling, with the
// real SatelliteGlobeView driven by fake timers: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { displayAltitudeKm, frameDelay, groundDistanceKm, positionAt } from "../../custom_components/satellite_spotter/frontend/sat-geo.js";
import { numberLocale, uses12Hour } from "../../custom_components/satellite_spotter/frontend/sat-format.js";
import { installDom } from "./helpers/view-dom.mjs";
import { HOME, T0, fakeHass, flush, installClock, makeDetail, makePass, makePayload, passRows, rows } from "./helpers/view-fixtures.mjs";

installDom();
const globe = await import("../../custom_components/satellite_spotter/frontend/sat-globe.js");
const { SatelliteGlobeView, mergeRows, rowsCover, simulationWindow, speedFromRows, tickStepMinutes, transitPositionAt, transitRows } = globe;
const passesModule = await import("../../custom_components/satellite_spotter/frontend/sat-passes.js");
const GERMAN = JSON.parse(readFileSync(new URL("../../custom_components/satellite_spotter/frontend/translations/de.json", import.meta.url), "utf8"));

globalThis.CustomEvent ??= class {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
    this.bubbles = !!init?.bubbles;
    this.composed = !!init?.composed;
  }
};

const fakeEl = () => ({
  hidden: false,
  disabled: false,
  style: { setProperty() {} },
  attrs: {},
  textContent: "",
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  focus() {},
  setAttribute(name, value) {
    this.attrs[name] = value;
  },
  removeAttribute(name) {
    delete this.attrs[name];
  },
  querySelector: () => null,
  contains: () => false,
});

function stubView(clock) {
  const view = new SatelliteGlobeView();
  view.hasAttribute = () => false; // No DOM in node.
  const calls = { frame: 0, render: 0, flyTo: [], jumpTo: [], events: [] };
  view._map = {
    getZoom: () => 2,
    getPixelRatio: () => 1,
    isMoving: () => false,
    jumpTo(opts) {
      calls.jumpTo.push(opts);
    },
    easeTo() {},
    flyTo(opts) {
      calls.flyTo.push(opts);
    },
    setLight() {},
    getCenter: () => ({ lng: -71, lat: 42 }),
    getPitch: () => 0,
    getBearing: () => 0,
    triggerRepaint() {
      calls.render++;
    },
  };
  view._space = {
    setFrame(state) {
      calls.state = state;
    },
    setLine() {},
    clearLines() {},
    setCone() {},
    setRing() {},
    project: () => null,
    setCloud() {},
    setCloudPositions() {},
    setCloudFlags() {},
    pick: () => -1,
  };
  view._els = { mission: fakeEl(), simBtn: fakeEl(), lookBtn: fakeEl(), streetBtn: fakeEl(), timebarHost: fakeEl() };
  view._loaded = true;
  view._mapSize = [800, 600];
  view._payload = makePayload([]);
  // The ISS's orbit (the view shows the ISS when no pass is on).
  view._focusTrack = { norad: 25544, rows: rows(T0 - 600, T0 + 6 * 3600, 30), from: T0 - 600, to: T0 + 6 * 3600 };
  view.dispatchEvent = (ev) => calls.events.push([ev.type, ev.detail]);
  // DOM-only rendering, not part of the scheduling under test.
  view._buildCourse = () => {};
  view._renderSky = () => {};
  view._tick = () => {};
  const frame = view._frame.bind(view);
  view._frame = () => {
    calls.frame++;
    frame();
  };
  return { view, calls };
}

// ---- pure helpers -------------------------------------------------------------

test("reduced motion: a simulation starts at its lead-in, without the fast-forward", () => {
  const pass = makePass(T0 + 6 * 3600, T0 + 6 * 3600 + 300);
  const w = simulationWindow(pass, T0);
  assert.equal(w.fromS, pass.start - 120);
  assert.equal(w.toS, pass.end + 60);
  assert.equal(w.visibleStartS, pass.start);
  assert.equal(w.visibleEndS, pass.end);
  assert.equal(w.approachFromS, T0, "sweeps from now");
  assert.equal(w.periodS, 5574);
  assert.equal(simulationWindow(pass, T0, { reduced: true }).approachFromS, null);
  // Too far away for a fast-forward, and too close to need one.
  assert.equal(simulationWindow(makePass(T0 + 40 * 3600, T0 + 40 * 3600 + 300), T0).approachFromS, null);
  assert.equal(simulationWindow(makePass(T0 + 200, T0 + 500), T0).approachFromS, null);
});

test("redraw cadence follows the satellite's speed on screen", () => {
  assert.equal(frameDelay(0), 1000); // off screen: once a second
  assert.equal(frameDelay(0.4), 1000); // globe zoom: under half a pixel a second
  assert.equal(frameDelay(1), 500);
  assert.equal(frameDelay(1.2), 500 / 1.2);
  assert.equal(frameDelay(5), 350); // under 2 px a step
  assert.equal(frameDelay(6), 0); // fast enough to animate every frame
  assert.equal(frameDelay(0.55, { chase: true }), 500 / 1.375); // the usual chase view
  assert.equal(frameDelay(1, { chase: true }), 350);
  assert.equal(frameDelay(0, { preview: true }), 0);
  // Never between one display frame and 350 ms (MapLibre's label fade).
  for (let speed = 0; speed < 100; speed += 0.05) {
    const d = frameDelay(speed);
    assert.ok(d === 0 || (d >= 350 && d <= 1000), `${speed} px/s -> ${d} ms`);
  }
});

test("clock and number formats follow Home Assistant's settings", () => {
  assert.equal(uses12Hour({ language: "en", time_format: "24" }), false);
  assert.equal(uses12Hour({ language: "de", time_format: "12" }), true);
  assert.equal(uses12Hour({ language: "en-US", time_format: "language" }), true);
  assert.equal(uses12Hour({ language: "de", time_format: "language" }), false);
  assert.deepEqual(numberLocale({ language: "en", number_format: "decimal_comma" }), [["de", "es", "it"], {}]);
  assert.deepEqual(numberLocale({ language: "fr", number_format: "language" }), ["fr", {}]);
  assert.deepEqual(numberLocale({ language: "en", number_format: "none" })[1], { useGrouping: false });
  const [locales, extra] = numberLocale({ language: "en", number_format: "decimal_comma" });
  assert.equal(new Intl.NumberFormat(locales, { ...extra, minimumFractionDigits: 1 }).format(1234.5), "1.234,5");
});

test("distances and speeds follow the location's Units option, else Home Assistant's unit system", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const show = async (units, length) => {
      const { view } = stubView(clock);
      const { hass } = fakeHass({ payload: makePayload([], { settings: { units, days: 5, min_elevation: 10 } }) });
      hass.config.unit_system.length = length;
      view._hass = hass;
      view._fmt.update(hass);
      view._renderList = view._renderStrip = () => {};
      await view._refresh();
      return [view._fmt.distance(400), view._fmt.speed(27600 / 3600)];
    };
    const metric = ["400 km", "27,600 km/h"];
    const imperial = ["249 mi", "17,150 mph"];
    assert.deepEqual(await show("auto", "km"), metric);
    assert.deepEqual(await show("auto", "mi"), imperial);
    assert.deepEqual(await show(undefined, "mi"), imperial);
    assert.deepEqual(await show("metric", "mi"), metric);
    assert.deepEqual(await show("imperial", "km"), imperial);
  } finally {
    clock.restore();
  }
});

test("rows merge in time order, the finer track winning where they overlap", () => {
  const coarse = [[0, 1, 1, 400, 1], [30, 2, 2, 400, 1], [60, 3, 3, 400, 1], [90, 4, 4, 400, 1]];
  const fine = [[28, 9, 9, 400, 1], [30, 9, 9, 400, 1], [32, 9, 9, 400, 1]];
  assert.deepEqual(mergeRows(coarse, fine).map((r) => r[0]), [0, 28, 30, 32, 60, 90]);
  assert.equal(mergeRows(coarse, fine)[2][1], 9);
  assert.deepEqual(mergeRows(null, coarse), coarse);
  assert.deepEqual(mergeRows(null, [[1]]), []);
  assert.equal(rowsCover(coarse, 0, 90), true);
  assert.equal(rowsCover(coarse, 0, 1000), false);
  assert.equal(rowsCover([[0], [400]], 0, 400), false, "a gap");
  assert.equal(rowsCover(null, 0, 1), false);
});

test("train members without rows are the leader moved later in time", () => {
  const pass = makePass(T0 + 600, T0 + 900, { ids: [101, 102, 103], train: true, kind: "starlink" });
  const detail = makeDetail(pass, { withRows: 1 });
  const lead = transitRows(detail, 0);
  const third = transitRows(detail, 2);
  assert.equal(third.length, lead.length);
  assert.equal(third[0][0] - lead[0][0], 40);
  assert.deepEqual(third[0].slice(1), lead[0].slice(1));
  assert.equal(transitRows(detail, 9), null);
  // Where each one is, every frame, without the copy.
  for (const t of [T0 + 500, T0 + 640, T0 + 777.25, T0 + 1000]) {
    for (const i of [0, 1, 2]) assert.deepEqual(transitPositionAt(detail, i, t), positionAt(transitRows(detail, i), t), `${i} at ${t - T0}`);
  }
  assert.equal(transitPositionAt(detail, 2, T0 - 3600), null, "nowhere near");
  assert.equal(transitPositionAt(detail, 9, T0 + 640), null);
});

test("the orbital speed comes from the track, Earth's rotation added back", () => {
  // A circular orbit 420 km up, inclined 51.6°, seen from the turning Earth:
  // 7.66 km/s in space, whichever way its ground track runs.
  const R = 6378.137 + 420;
  const P = 2 * Math.PI * Math.sqrt(R ** 3 / 398600.4418);
  const inc = 51.6 * (Math.PI / 180);
  const track = [];
  for (let t = 0; t <= P; t += 30) {
    const a = (2 * Math.PI * t) / P;
    const [x, y, z] = [Math.cos(a), Math.sin(a) * Math.cos(inc), Math.sin(a) * Math.sin(inc)];
    const lon = ((Math.atan2(y, x) - 7.2921159e-5 * t) * 180) / Math.PI;
    track.push([T0 + t, (Math.asin(z) * 180) / Math.PI, ((((lon + 180) % 360) + 360) % 360) - 180, 420, 1]);
  }
  for (const t of [T0 + 100, T0 + 1500, T0 + 2900, T0 + 4300]) {
    const v = speedFromRows(track, t);
    assert.ok(Math.abs(v - 7.657) < 0.01, `${v} km/s at ${t - T0} s`);
  }
  assert.equal(speedFromRows([[0, 0, 0, 400, 1]], 0), null);
  assert.equal(speedFromRows([[0, 0, 0, 400, 1], [600, 1, 1, 400, 1]], 10), null, "samples too far apart");
});

test("clock ticks along an orbit come about six to a period, on round minutes", () => {
  assert.equal(tickStepMinutes(5574), 15); // the ISS
  assert.equal(tickStepMinutes(6000), 15);
  assert.equal(tickStepMinutes(7200), 20);
  assert.equal(tickStepMinutes(12 * 3600), 120);
  assert.equal(tickStepMinutes(24 * 3600), 240);
  assert.equal(tickStepMinutes(undefined), 15);
});

// ---- the view -------------------------------------------------------------------

test("a simulation that ends leaves no animation-frame loop behind", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, calls } = stubView(clock);
    const pass = makePass(T0 + 3600, T0 + 3900);
    view._payload = makePayload([pass]);
    view._sim = { pass, modeBefore: "free", viewBefore: null };
    view._simRows = rows(T0, T0 + 3 * 3600, 30);
    view._running = true;
    view._clock.simulate({ fromS: pass.start - 120, toS: pass.end + 60, visibleStartS: pass.start, visibleEndS: pass.end, rate: 60, loop: false });
    view._scheduleFrames();
    assert.ok(view._raf, "a simulation animates every frame");
    for (let i = 0; i < 5000 && !view._clock.ended; i++) clock.step();
    assert.equal(view._clock.ended, true, "the replay reached its end");
    clock.step();
    assert.equal(view._raf, null, "no animation frame is pending");
    assert.equal(clock.rafs.size, 0);
    assert.ok(view._frameTimer, "frames continue on a timer");
    // Back to the idle cadence: about one redraw a second, not one per display frame.
    const before = calls.frame;
    for (let i = 0; i < 125; i++) clock.step(); // 2 s
    assert.ok(calls.frame - before <= 3, `${calls.frame - before} frames in 2 s`);
    // Playing again animates every frame once more.
    view._clock.play();
    assert.ok(view._raf);
    view._pause();
  } finally {
    clock.restore();
  }
});

test("the page visibility listener is removed when the view leaves the page", () => {
  const clock = installClock(T0 * 1000);
  try {
    const view = new SatelliteGlobeView();
    const count = () => clock.listeners.get("visibilitychange")?.size ?? 0;
    view.connectedCallback();
    assert.equal(count(), 1);
    view.disconnectedCallback();
    assert.equal(count(), 0, "a detached view must not stay reachable from the document");
    view.connectedCallback();
    view.connectedCallback();
    assert.equal(count(), 1);
    view.disconnectedCallback();
  } finally {
    clock.restore();
  }
});

test("switching location moves the home marker and drops the old approach and pass rows", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    delete view._buildCourse; // use the real one
    const lines = {};
    view._space.setLine = (name, r) => (lines[name] = r);
    const marker = { ll: null, el: { title: "" }, setLngLat(ll) { this.ll = ll; }, getElement() { return this.el; } };
    view._homeMarker = marker;
    view._makePins = () => {};
    view._approaches.set("x", rows(T0, T0 + 600, 30));
    view._details.set("x", { transits: [] });
    view._locationChanged();
    assert.equal(view._approaches.size, 0);
    assert.equal(view._details.size, 0);
    assert.deepEqual(lines.approach, []);
    view._payload = makePayload([], { location: { entry_id: "b", title: "Cabin", latitude: 39.74, longitude: -104.99, elevation: 1600 } });
    view._buildCourse();
    assert.deepEqual(marker.ll, [-104.99, 39.74]);
    assert.equal(marker.el.title, "Cabin");
  } finally {
    clock.restore();
  }
});

test("an approach that fails to load is asked for again with the next refresh", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    const lines = {};
    view._space.setLine = (name, r) => (lines[name] = r);
    const pass = makePass(T0 + 1800, T0 + 2100);
    view._payload = makePayload([pass]);
    view._selectedId = pass.id;
    let calls = 0;
    view._track = async (id, start, end) => {
      assert.equal(id, 25544);
      assert.deepEqual([start, end], [T0, T0 + 1800], "from now: the pass is less than 50 minutes away");
      if (++calls === 1) throw { code: "not_ready", message: "Starting up" };
      return rows(T0, T0 + 1800, 30);
    };
    await view._loadApproach();
    assert.equal(view._approaches.has(pass.id), false);
    await view._loadApproach();
    assert.equal(calls, 2);
    assert.equal(lines.approach.length, 61);
    await view._loadApproach();
    assert.equal(calls, 2, "a loaded approach is not asked for again");
    // None for a pass days away, nor for one under way.
    view._payload = makePayload([makePass(T0 + 50 * 3600, T0 + 50 * 3600 + 300)]);
    view._selectedId = view._payload.passes[0].id;
    await view._loadApproach();
    assert.equal(calls, 2);
  } finally {
    clock.restore();
  }
});

test("a new location's retries start quickly, however far the last one's backed off", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    for (let i = 0; i < 10; i++) view._retryRefresh();
    assert.equal(view._refreshDelay, 5 * 60 * 1000);
    view._locationChanged();
    assert.equal(clock.timeouts.size, 0, "the old location's retry is cancelled");
    view._retryRefresh();
    assert.equal(view._refreshDelay, 3000);
  } finally {
    clock.restore();
  }
});

test("the passes are asked for again once one is over, once, however late the tick", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    view._running = true;
    let refreshes = 0;
    view._refresh = () => refreshes++;
    const early = makePass(T0 - 1800, T0 - 1500); // over before the data was made: no refresh
    const pass = makePass(T0 - 300, T0 + 10);
    view._payload = makePayload([early, pass, makePass(T0 + 5400, T0 + 5700)], { generated_at: T0 - 600 });
    view._refreshAfterPass(T0);
    clock.step(5000);
    assert.equal(refreshes, 0, "not while the pass is on, nor for one over before the data");
    // The first tick after the end comes late (a busy page, a timer that slipped).
    clock.now = (T0 + 15) * 1000;
    view._refreshAfterPass(T0 + 15);
    view._refreshAfterPass(T0 + 16);
    clock.step(2000);
    assert.equal(refreshes, 1);
    // None while the view is away; one when it is back.
    view._pause();
    clock.step(5000);
    assert.equal(refreshes, 1);
    view._running = true;
    view._refreshAfterPass(T0 + 20);
    clock.step(2000);
    assert.equal(refreshes, 2);
    // Another refresh brings newer data before this request goes out: none.
    view._pause();
    view._running = true;
    view._refreshAfterPass(T0 + 25);
    view._payload = makePayload([makePass(T0 + 5400, T0 + 5700)], { generated_at: T0 + 20 });
    clock.step(2000);
    assert.equal(refreshes, 2);
    // Nor while simulating.
    view._payload = makePayload([makePass(T0 - 100, T0 + 26)], { generated_at: T0 });
    view._clock.simulate({ fromS: T0, toS: T0 + 600 });
    view._refreshAfterPass(T0 + 30);
    clock.step(2000);
    assert.equal(refreshes, 2);
  } finally {
    clock.restore();
  }
});

test("a globe does not open on another location's data while the one asked for cannot be fetched", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    view._map = null;
    view._loaded = false;
    view._els = null;
    view._buildDom = () => {};
    view._refreshMapToken = async () => {};
    let maps = 0;
    view._createMap = () => maps++;
    const messages = [];
    view._showMessage = (text) => messages.push(text);
    const error = { code: "not_ready", message: "Starting up" };
    view._hass = {
      callWS: async () => {
        throw error;
      },
    };
    // The data is still the last location's ("a"); this globe now shows "b".
    view._config = { entry_id: "b" };
    await view._start();
    assert.equal(maps, 0);
    assert.equal(messages.at(-1), view._errorText(error), "says why, and the message stays");
    assert.deepEqual([...clock.timeouts.values()].map((t) => t.at - clock.now), [30000], "one retry: the start's own");
  } finally {
    clock.restore();
  }
});

test("a WebGL context that stays lost gets a new map, and one that comes back gets just one", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    let starts = 0;
    view._start = () => starts++;
    view._teardown = () => (view._map = null);
    const messages = [];
    view._showMessage = (text) => messages.push(text);
    const newMap = () => {
      const canvas = { on: {}, addEventListener: (type, fn) => (canvas.on[type] = fn) };
      const map = { getCanvas: () => canvas, canvas };
      view._map = map;
      view._watchContext(map);
      return map;
    };
    const lost = newMap();
    lost.canvas.on.webglcontextlost();
    assert.equal(messages.at(-1), view._t("globe.reloading"));
    clock.step(4000);
    assert.equal(starts, 0, "the browser gets the chance to restore it");
    clock.step(1000);
    assert.equal(starts, 1);
    const back = newMap();
    back.canvas.on.webglcontextlost();
    clock.step(1000);
    back.canvas.on.webglcontextrestored();
    assert.equal(starts, 2);
    clock.step(5000);
    assert.equal(starts, 2);
  } finally {
    clock.restore();
  }
});

test("the sky chart is drawn when it can be seen, and then only its live dot moves", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    delete view._renderSky; // use the real one
    const el = () => ({
      hidden: false,
      textContent: "",
      attrs: {},
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      removeAttribute(name) {
        delete this.attrs[name];
      },
    });
    const chart = () => {
      const c = {
        draws: 0,
        dot: null,
        set innerHTML(svg) {
          c.draws++;
          c.svg = svg;
          c.dot = el();
        },
        querySelector: (sel) => (sel === ".live-dot" ? c.dot : null),
      };
      return c;
    };
    const panel = () => {
      const parts = { ".sub": el(), ".chart": chart(), ".caption": el() };
      return { ...el(), parts, querySelector: (sel) => parts[sel] };
    };
    view._els = { ...view._els, skyPop: panel(), skySide: panel(), lookBtn: el() };
    const pass = makePass(T0 + 600, T0 + 840);
    view._payload = makePayload([pass]);
    view._selectedId = pass.id;
    view._details.set(pass.id, makeDetail(pass));
    const pop = view._els.skyPop.parts[".chart"];
    view._renderSky(true);
    assert.equal(pop.draws, 0, "not while it is closed");
    view._skyOpen = true;
    view._renderSky(false);
    assert.equal(pop.draws, 1);
    assert.match(pop.svg, /class="vis"/);
    assert.match(pop.svg, /class="star"/, "the brightest moment");
    assert.equal(pop.dot.attrs.display, "none", "the satellite is not up yet");
    assert.match(view._els.skyPop.parts[".caption"].textContent, /^Appears low in the SW, climbs to 67° in the SSE, sets in the NE\.$/);
    // During the pass each render moves the dot, and draws nothing else.
    clock.now = (T0 + 660) * 1000;
    view._renderSky(false);
    const first = pop.dot.attrs.transform;
    assert.match(first, /^translate\(/);
    clock.now += 30000;
    view._renderSky(false);
    assert.equal(pop.draws, 1);
    assert.equal(pop.dot.attrs.display, undefined);
    assert.notEqual(pop.dot.attrs.transform, first);
  } finally {
    clock.restore();
  }
});

test("with the satellite out of sight the globe is redrawn now and then, and at once when its course changes", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, calls } = stubView(clock);
    view._frameDelay(); // project() places it nowhere on screen: out of sight
    for (let i = 0; i < 10; i++) {
      view._frame();
      clock.now += 1000;
    }
    assert.equal(calls.render, 2, "every five seconds, not every second");
    delete view._buildCourse; // use the real one
    view._homeMarker = { el: {}, setLngLat() {}, getElement() { return this.el; } };
    view._makePins = () => {};
    view._buildCourse();
    view._frame();
    assert.equal(calls.render, 3);
    // In sight, every frame.
    view._space.project = (lat, lon) => ({ x: lon * 50, y: lat * 50 });
    view._frameDelay();
    view._frame();
    view._frame();
    assert.equal(calls.render, 5);
    // The focus satellite is the primary sprite, with the period's fade spans.
    const focus = calls.state.objects.find((o) => o.primary);
    assert.equal(focus.id, 25544);
    assert.ok(calls.state.spans.past > 2000 && calls.state.spans.future > 5000);
  } finally {
    clock.restore();
  }
});

test("nothing the view keeps hides one of its own methods", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    view._frameDelay();
    view._frame();
    const proto = SatelliteGlobeView.prototype;
    const methods = Object.getOwnPropertyNames(proto).filter((name) => typeof Object.getOwnPropertyDescriptor(proto, name).value === "function");
    // The test's stubs are functions; state that took a method's name is not.
    assert.deepEqual(Object.keys(view).filter((key) => methods.includes(key) && typeof view[key] !== "function"), []);
  } finally {
    clock.restore();
  }
});

test("retries wait while the globe cannot be seen, and go as soon as it can", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    view._running = true; // only the retries are under test
    let refreshes = 0;
    view._refresh = () => refreshes++;
    document.hidden = true;
    view._retryRefresh();
    clock.step(3000);
    clock.step(60000);
    assert.equal(refreshes, 0, "not for a hidden tab");
    document.hidden = false;
    view._onVisibility();
    assert.equal(refreshes, 1);
    // Likewise for a card scrolled out of view.
    view._onScreen = false;
    view._retryRefresh();
    clock.step(6000);
    assert.equal(refreshes, 1);
    view._onScreen = true;
    view._resume();
    assert.equal(refreshes, 2);
  } finally {
    clock.restore();
  }
});

test("back on the page after a location switch failed, the new location is asked for at once", () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    let refreshes = 0;
    view._refresh = () => refreshes++;
    view._refreshMapToken = () => {};
    view._map.resize = () => {};
    view._els.map = { clientWidth: 800, clientHeight: 600 };
    // Fresh data, but the last location's.
    view._payloadAt = performance.now();
    view._config = { entry_id: "b" };
    view._resume();
    view._pause();
    assert.equal(refreshes, 1);
  } finally {
    clock.restore();
  }
});

test("a drawing bug is not shown as a failed request, and the new data stays in", async () => {
  const clock = installClock(T0 * 1000);
  const saved = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const { view } = stubView(clock);
    const messages = [];
    view._showMessage = (text) => messages.push(text);
    view._renderList = () => {};
    view._buildCourse = () => {
      throw new TypeError("pins is undefined");
    };
    const fresh = makePayload([], { generated_at: T0 + 1 });
    view._hass = { callWS: async () => fresh };
    assert.equal(await view._refresh(), true);
    assert.equal(view._payload, fresh);
    assert.ok(!messages.some((m) => /pins is undefined/.test(m)), messages.join(" | "));
    assert.equal(errors.length, 1);
  } finally {
    console.error = saved;
    clock.restore();
  }
});

test("a language that fails to apply does not hold up the globe", async () => {
  const saved = { fetch: globalThis.fetch, error: console.error };
  const errors = [];
  console.error = (...args) => errors.push(args);
  globalThis.fetch = async () => ({ ok: true, json: async () => GERMAN });
  try {
    const view = new SatelliteGlobeView();
    view._applyStrings = () => {
      throw new TypeError("no labels yet");
    };
    await view._useLanguage({ language: "de" }); // what starting the globe waits on
    assert.equal(errors.length, 1);
  } finally {
    globalThis.fetch = saved.fetch;
    console.error = saved.error;
  }
});

test("a clock about two seconds off is corrected steadily, not on and off", () => {
  const view = new SatelliteGlobeView();
  // The server's clock, ahead of the device's by this much (round trip 100 ms).
  const ahead = (ms) => view._syncClock(2000 + ms / 1000, 1_999_950, 2_000_050);
  ahead(2500);
  assert.equal(view._clockOffset, 2500);
  ahead(1500); // the same clock, measured a little differently
  assert.equal(view._clockOffset, 1500);
  ahead(500);
  assert.equal(view._clockOffset, 0, "set right meanwhile");
  ahead(1500);
  assert.equal(view._clockOffset, 0, "a clock that agrees is not corrected for noise");
});

test("a device clock that is off is corrected from the server's time, for the shared clock too", () => {
  const clock = installClock(2_000_050);
  try {
    const view = new SatelliteGlobeView();
    view._syncClock(1000, 2_000_000, 2_000_100); // 1000 s server time vs 2000 s device time
    assert.equal(view._clockOffset, 1_000_000 - 2_000_050);
    assert.equal(view._clock.simMs, 1_000_000, "live, the shared clock is Home Assistant's time");
    view._syncClock(2000.5, 2_000_000, 2_000_100); // half a second: left alone
    assert.equal(view._clockOffset, 0);
    view._syncClock(1000, 2_000_000, 2_005_000); // too slow a round trip to trust
    assert.equal(view._clockOffset, 0);
  } finally {
    clock.restore();
  }
});

test("orbit refreshes for a satellite whose track ran out back off while they fail", () => {
  const clock = installClock(T0 * 1000);
  try {
    const view = new SatelliteGlobeView();
    let calls = 0;
    view._loadFocusTrack = (force) => {
      assert.equal(force, true);
      calls++;
    };
    view._refreshStale();
    view._refreshStale();
    assert.equal(calls, 1, "one request, not one per frame");
    clock.now += 3000;
    view._refreshStale();
    assert.equal(calls, 2);
    clock.now += 3000;
    view._refreshStale();
    assert.equal(calls, 2, "the wait doubles");
    clock.now += 3000;
    view._refreshStale();
    assert.equal(calls, 3);
  } finally {
    clock.restore();
  }
});

test("a pass says what can make it easier or harder to see", () => {
  const view = new SatelliteGlobeView();
  const conds = (pass) => view._conditions(pass).map((c) => [c.cls, c.icon, c.text]);
  const pass = makePass(T0 + 600, T0 + 900, { cloud: 37 });
  // The cloud for its forecast hour, as See A Satellite Tonight says it.
  const hour = view._fmt.hour(Math.floor(pass.start / 3600) * 3600 + 3600);
  assert.deepEqual(conds(pass), [["partly", "cloud", `37% cloud at ${hour}`]]);
  assert.equal(passesModule.cloudText(pass, view._fmt), `37% cloud at ${hour}`);
  assert.deepEqual(conds({ ...pass, cloud_cover: null }), []);
  assert.deepEqual(conds({ ...pass, cloud_cover: 5 })[0][0], "clear");
  assert.deepEqual(conds({ ...pass, cloud_cover: 90 })[0][0], "cloudy");
  const daylight = conds({ ...pass, cloud_cover: null, before_sunset: true });
  assert.deepEqual(daylight, [["warn", "sun", "Before sunset: the sky is still bright"]]);
  const train = makePass(T0 + 600, T0 + 900, { ids: [101, 102, 103, 104, 105, 106, 107], kind: "starlink", train: true, cloud: null });
  assert.equal(conds(train)[0][1], "train");
  // A famous satellite riding along, and predictions from old orbit data.
  const group = makePass(T0 + 600, T0 + 900, { ids: [67304, 25544], kind: "satellite", title: "COSMO-SKYMED-FM3 +1", cloud: null });
  group.transits[1].kind = "iss";
  group.transits[1].name = "ISS";
  group.transits[0].confidence = "medium";
  assert.deepEqual(conds(group), [
    ["gold", "station", "With ISS"],
    ["dim", "info", "Medium confidence: orbit data a few days old"],
  ]);
  // A bright Moon up at the time: after the cloud, with its phase drawn.
  const evening = Date.parse("2026-10-20T22:45:00Z") / 1000; // Boston, a 71 % Moon in the SSE
  const moonlit = makePass(evening, evening + 240, { cloud: 9 });
  assert.equal(conds(moonlit).length, 1, "no place yet: no Moon");
  view._payload = makePayload([moonlit]);
  const moon = passesModule.passMoon(moonlit, HOME);
  assert.ok(moon && moon.fraction > 0.7 && moon.elevation > 20);
  const [cloud, moonCond] = view._conditions(moonlit);
  assert.equal(cloud.icon, "cloud");
  assert.equal(moonCond.cls, "moon");
  assert.equal(moonCond.text, passesModule.moonText(moon, view._fmt));
  assert.match(moonCond.text, /^Moon 7\d% lit, \d+° up in the S{1,2}E$/);
  assert.equal(moonCond.glyph, passesModule.moonGlyph(moon));
  // The new Moon of 10 October: no Moon.
  assert.equal(view._conditions(pass).some((c) => c.cls === "moon"), false);
});

test("the list's filters: handed to the list, told to the host, and followed by the strip and the pass shown", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const faint = makePass(T0 + 600, T0 + 900, { bright: false, ids: [53807], kind: "satellite", title: "BlueWalker 3" });
    const train = makePass(T0 + 1800, T0 + 2100, { bright: false, ids: [101, 102, 103, 104, 105, 106], kind: "starlink", train: true, title: "Starlink" });
    const iss = makePass(T0 + 7200, T0 + 7500);
    const { view, calls } = passView(clock, [faint, train, iss]);
    const rendered = [];
    view._passList = { render: (passes, opts) => rendered.push(opts), setNow() {} };
    view._els = { ...view._els, plist: {}, passesBox: { appendChild() {} }, strip: {} };
    view._passesMode = () => "list";
    view._wide = true;
    delete view._renderList; // the real one, with the stub list above
    view._reconcileSelection();
    assert.equal(view._selectedId, faint.id, "no filters: the next pass");
    // The chips: the host hears of it, the pass shown follows, the list gets them back.
    view._setFilters({ brightOnly: true });
    assert.deepEqual(calls.events.at(-1), ["filters-changed", { brightOnly: true, hideStarlink: false }]);
    assert.equal(view._selectedId, iss.id, "the next bright pass");
    assert.deepEqual(rendered.at(-1).filters, { brightOnly: true, hideStarlink: false });
    assert.equal(rendered.at(-1).location, view._payload.location, "for the Moon");
    assert.deepEqual(view._listedPasses().map((p) => p.id), [iss.id]);
    // The same filters again: nothing to tell.
    const events = calls.events.length;
    view._setFilters({ brightOnly: true, hideStarlink: false });
    assert.equal(calls.events.length, events);
    // Hiding Starlink only.
    view._setFilters({ hideStarlink: true });
    assert.equal(view._selectedId, faint.id);
    assert.deepEqual(view._listedPasses().map((p) => p.id), [faint.id, iss.id]);
    // Filters that would leave nothing to come show everything rather than "none soon".
    clock.now = (iss.end + 10) * 1000;
    view._payload = makePayload([faint, train, iss, makePass(T0 + 90000, T0 + 90300, { bright: false, ids: [101], kind: "starlink", train: true })]);
    view._setFilters({ brightOnly: true, hideStarlink: true });
    assert.equal(view._listedPasses().length, 4);
    clock.now = T0 * 1000;
    // The panel's remembered filters arrive with the config, without an event back.
    const before = calls.events.length;
    view.config = { ...view._config, filters: { brightOnly: false, hideStarlink: false } };
    assert.deepEqual(view._filters, { brightOnly: false, hideStarlink: false });
    assert.equal(calls.events.filter(([type]) => type === "filters-changed").length, calls.events.slice(0, before).filter(([type]) => type === "filters-changed").length);
    // A config without filters (a card) leaves them as they are.
    view._setFilters({ hideStarlink: true }, { emit: false });
    view.config = { ...view._config, filters: undefined };
    assert.deepEqual(view._filters, { brightOnly: false, hideStarlink: true });
  } finally {
    clock.restore();
  }
});

test("the view speaks Home Assistant's language once its text has loaded", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /translations\/de\.json$/);
    return { ok: true, json: async () => GERMAN };
  };
  try {
    const view = new SatelliteGlobeView();
    assert.equal(view._errorText(3), "Lost the connection to Home Assistant. Reconnecting…");
    view.hass = { language: "de", locale: { language: "de", number_format: "language" } };
    await view._languageReady;
    assert.equal(view._strings.language, "de");
    assert.equal(view._fmt.strings, view._strings, "the formatter speaks it too");
    assert.equal(view._errorText(3), GERMAN.globe.reconnecting);
    assert.equal(view._t("mission.look_up", { direction: "SW", elevation: 26 }), GERMAN.mission.look_up.replace("{direction}", "SW").replace("{elevation}", "26"));
    assert.deepEqual(view._placeNames(), ["coalesce", ["get", "name_de"], ["get", "name_en"], ["get", "name"]]);
    // The same language again downloads nothing.
    globalThis.fetch = () => assert.fail("downloaded again");
    view.hass = { language: "de", locale: view._hass.locale };
    await view._languageReady;
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("errors read as sentences, whatever shape the websocket gives them", () => {
  const view = new SatelliteGlobeView();
  assert.match(view._errorText(3), /Lost the connection/);
  assert.match(view._errorText({ code: 3, message: "Connection lost" }), /Lost the connection/);
  assert.match(view._errorText({ error: { code: "not_found", message: "x" } }), /Set up the Satellite Spotter/);
  assert.match(view._errorText({ code: "location_disabled", message: "x" }), /disabled/);
  assert.match(view._errorText({ code: "stale_catalog", message: "x" }), /out of date/);
  assert.equal(view._errorText({ code: "not_ready", message: "Waiting for the satellite catalogue" }), "Waiting for satellite data…");
  assert.equal(view._errorText({ code: "not_ready", message: "Catalogue download failed" }), "Waiting for satellite data… (Catalogue download failed)");
  assert.doesNotMatch(view._errorText({ error: { foo: 1 } }), /object Object/);
  assert.equal(view._errorMessage({ code: "home_assistant_error", message: "Not ready" }), "Not ready");
});

test("a location switch that fails at first says so, then flies to the new home", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, calls } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    const messages = [];
    view._showMessage = (text) => messages.push(text);
    view._renderList = () => {};
    view._padding = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
    const cabin = makePayload([], { location: { entry_id: "b", title: "Cabin", latitude: 39.74, longitude: -104.99, elevation: 1600 } });
    let fail = true;
    view._hass = {
      callWS: async (msg) => {
        if (msg.type !== "satellite_spotter/passes") return { track: [] };
        if (fail) {
          fail = false;
          throw { code: 3, message: "Connection lost" };
        }
        return cabin;
      },
    };
    view._config = { entry_id: "a" };
    view.config = { entry_id: "b" };
    await flush();
    assert.match(messages.at(-1), /Lost the connection/, "the old location is not shown as if nothing happened");
    assert.equal(calls.flyTo.length, 0);
    clock.step(3000); // the retry
    await flush();
    assert.equal(view._payload.location.entry_id, "b");
    assert.deepEqual(calls.flyTo.at(-1).center, [-104.99, 39.74]);
  } finally {
    clock.restore();
  }
});

test("a deleted location says so at once and tells the host, without retrying", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, calls } = stubView(clock);
    Object.defineProperty(view, "isConnected", { value: true });
    const messages = [];
    view._showMessage = (text) => messages.push(text);
    view._config = { entry_id: "a" };
    let error = { code: "unknown_location", message: "This location no longer exists" };
    view._hass = {
      callWS: async () => {
        throw error;
      },
    };
    // The cached passes are still there, but the location is gone for good.
    await view._refresh();
    assert.match(messages.at(-1), /Edit the card/);
    assert.deepEqual(calls.events, [["location-gone", "a"]]);
    assert.equal(clock.timeouts.size, 0, "nothing to retry");
    view._config = { entry_id: "a", panel: true };
    await view._refresh();
    assert.equal(messages.at(-1), "This location no longer exists. Choose another one.");
    // Passing trouble keeps the cached passes on screen, quietly.
    messages.length = calls.events.length = 0;
    error = { code: "not_ready", message: "Starting up" };
    await view._refresh();
    assert.deepEqual(messages, []);
    assert.deepEqual(calls.events, []);
    // Without anything to show, a deleted location waits for a new one.
    view._payload = null;
    view._map = null;
    view._els = null;
    view._buildDom = () => {};
    error = { code: "unknown_location", message: "gone" };
    await view._start();
    assert.ok(![...clock.timeouts.values()].some((t) => t.at - clock.now === 30000), "no 30 s retry");
  } finally {
    clock.restore();
  }
});

test("editor previews get a short grace, cards the editor dropped none", () => {
  const clock = installClock(T0 * 1000);
  try {
    const make = (cardParent) => {
      const view = new SatelliteGlobeView();
      view.editorPreview = true;
      view.getRootNode = () => ({ host: { parentNode: cardParent } });
      let connected = false;
      Object.defineProperty(view, "isConnected", { get: () => connected });
      view.teardowns = 0;
      view._teardown = () => view.teardowns++;
      view._start = () => {};
      view.attach = () => {
        connected = true;
        view.connectedCallback();
      };
      view.detach = () => {
        connected = false;
        view.disconnectedCallback();
      };
      return view;
    };
    // A masonry view in edit mode takes its columns apart and puts the cards back a few frames later.
    const moved = make({});
    moved.attach();
    moved.detach();
    for (let i = 0; i < 6; i++) clock.step();
    moved.attach();
    clock.step(3000);
    assert.equal(moved.teardowns, 0, "a card put back soon keeps its globe");
    moved.detach();
    clock.step(2000);
    assert.equal(moved.teardowns, 1, "a preview that stays away goes after 2 s");
    // The editor rebuilt its preview: the old card is out of the page for good.
    const dropped = make(null);
    dropped.attach();
    dropped.detach();
    clock.step();
    assert.equal(dropped.teardowns, 1);
    // Outside the editor, views wait 30 s.
    const card = make({});
    card.editorPreview = false;
    card.attach();
    card.detach();
    clock.step(29000);
    assert.equal(card.teardowns, 0);
    clock.step(1000);
    assert.equal(card.teardowns, 1);
  } finally {
    clock.restore();
  }
});

test("tearing the map down frees the city lights first, and the street view with it", () => {
  const clock = installClock(T0 * 1000);
  try {
    const view = new SatelliteGlobeView();
    const order = [];
    view.removeAttribute = () => {};
    view._night = { releaseLights: () => order.push("lights") };
    view._map = { remove: () => order.push("map") };
    view._street = { dispose: () => order.push("street"), remove() {} };
    view._teardown();
    assert.deepEqual(order, ["street", "lights", "map"]);
    assert.equal(view._night, null);
    assert.equal(view._map, null);
    assert.equal(view._street, null);
  } finally {
    clock.restore();
  }
});

// ---- selection, simulation, street view, cloud ---------------------------------

/** A view with passes, answering through a fake Home Assistant. */
function passView(clock, passes, extra = {}) {
  const { view, calls } = stubView(clock);
  const details = Object.fromEntries(passes.map((p) => [p.id, makeDetail(p)]));
  const fake = fakeHass({
    payload: makePayload(passes),
    details,
    track: (msg) => rows(Date.parse(msg.start) / 1000, Date.parse(msg.end) / 1000, msg.step),
    ...extra,
  });
  view._hass = fake.hass;
  view._payload = makePayload(passes);
  view._renderList = view._renderStrip = () => {};
  return { view, calls, fake, details };
}

test("the pass going on is shown, else the next; the user's pick stays until it is over", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const a = makePass(T0 + 600, T0 + 900);
    const b = makePass(T0 + 7200, T0 + 7500, { ids: [48274], kind: "tiangong", title: "Tiangong" });
    const c = makePass(T0 + 90000, T0 + 90300, { ids: [20580], kind: "hubble", title: "Hubble" });
    const { view, calls } = passView(clock, [a, b, c]);
    view._reconcileSelection();
    assert.equal(view._selectedId, a.id, "the next pass");
    assert.equal(view._userSelected, false);
    await view._select(c.id);
    await flush();
    assert.equal(view._selectedId, c.id);
    assert.deepEqual(calls.events.at(-1), ["pass-selected", { id: c.id, view: null }]);
    assert.equal(view._focusInfo().norad_id, 20580, "its satellite is the one drawn in full");
    assert.equal(calls.flyTo.length, 1, "the camera frames the pass");
    // Time passes: the pick stays, even once the automatic choice moves on.
    clock.now = (T0 + 1000) * 1000;
    view._reconcileSelection();
    assert.equal(view._selectedId, c.id);
    // It is over: back to the next one, and no event (the view chose).
    const events = calls.events.length;
    clock.now = (c.end + 61) * 1000;
    view._reconcileSelection();
    assert.equal(view._selectedId, null, "nothing after it");
    view._payload = makePayload([a, b, c, makePass(c.end + 3600, c.end + 3900)]);
    view._reconcileSelection();
    assert.equal(view._selectedId, view._payload.passes[3].id);
    assert.equal(calls.events.length, events);
    // A pass going on wins over the next.
    clock.now = (T0 + 700) * 1000;
    view._userSelected = false;
    view._reconcileSelection();
    assert.equal(view._selectedId, a.id);
  } finally {
    clock.restore();
  }
});

test("refreshed predictions keep the user's pass under its new id", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const a = makePass(T0 + 600, T0 + 900);
    const b = makePass(T0 + 7200, T0 + 7500);
    const { view } = passView(clock, [a, b]);
    await view._select(b.id);
    const moved = makePass(T0 + 7230, T0 + 7530);
    view._payload = makePayload([a, moved]);
    view._reconcileSelection();
    assert.equal(view._selectedId, moved.id);
    assert.equal(view._userSelected, true);
  } finally {
    clock.restore();
  }
});

test("a deep link waits for the data, and an id from older predictions finds the pass it became", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const a = makePass(T0 + 600, T0 + 900);
    const b = makePass(T0 + 7200, T0 + 7500);
    const { view, calls, fake } = passView(clock, [a, b], {});
    view._payload = null;
    view._loaded = false;
    view.selectPass(b.id);
    await flush();
    assert.equal(view._selectedId, null, "waits");
    view._payload = makePayload([a, b]);
    view._loaded = true;
    view._applyPendingSelect();
    await flush();
    assert.equal(view._selectedId, b.id);
    assert.equal(view._userSelected, true);
    assert.equal(calls.events.filter(([type]) => type === "pass-selected").length, 0, "the host asked for it: no event");
    // An old id: the integration says which pass it is now.
    fake.hass.callWS = async (msg) => {
      if (msg.type === "satellite_spotter/pass_track" && msg.pass_id === "25544-1") return { ...makeDetail(a), pass_id: a.id };
      throw { code: "unknown_pass", message: "No such pass" };
    };
    view.selectPass("25544-1");
    await flush();
    await flush();
    assert.equal(view._selectedId, a.id);
    // One it does not know: a notice, and the selection stays.
    view.selectPass("1-2");
    await flush();
    await flush();
    assert.equal(view._selectedId, a.id);
    assert.equal(calls.events.at(-1)[0], "hass-notification");
    assert.match(calls.events.at(-1)[1].message, /no longer/);
  } finally {
    clock.restore();
  }
});

test("a link that also switches location waits for that location's passes, and a late answer for the old one is let go", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const cottage = { entry_id: "b", title: "Cottage", latitude: 52.03, longitude: 5.56, elevation: 10 };
    const a = makePass(T0 + 600, T0 + 900);
    const b = makePass(T0 + 7200, T0 + 7500, { ids: [48274], kind: "tiangong", title: "Tiangong" });
    const payloads = { a: makePayload([a]), b: makePayload([b], { location: cottage }) };
    const { view, calls } = passView(clock, [a]);
    view._showMessage = () => {};
    view._padding = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
    const opened = [];
    view._openStreet = (pass) => opened.push([pass.id, view._payload.location.entry_id]);
    // Home Assistant, holding back the answers named in `holding` until the test lets them go.
    const asked = [];
    const held = new Map();
    const hold = (what) => new Promise((resolve) => held.set(what, resolve));
    let holding = new Set(["passes b"]);
    view._hass = {
      callWS: async (msg) => {
        const entry = msg.entry_id ?? "a";
        const what = `${msg.type.split("/")[1]} ${entry}`;
        asked.push(what);
        if (holding.has(what)) await hold(what);
        if (msg.type === "satellite_spotter/passes") return payloads[entry];
        if (msg.type === "satellite_spotter/pass_track") {
          // An old id finds the same satellite's pass.
          const pass = payloads[entry].passes.find((p) => p.id === msg.pass_id || p.id === msg.pass_id.replace(/-\d+$/, `-${p.start}`));
          if (!pass) throw { code: "unknown_pass", message: "No such pass" };
          return makeDetail(pass);
        }
        return { track: [] };
      },
    };
    const notices = () => calls.events.filter(([type]) => type === "hass-notification").length;
    view._config = { entry_id: "a" };
    // The panel follows a link to a pass at the other location: the location first, then the pass.
    view.config = { entry_id: "b" };
    view.selectPass(b.id, { view: "street" });
    await flush();
    await flush();
    assert.equal(view._userSelected, false, "waits for the cottage's passes");
    assert.ok(!asked.includes("pass_track a"), "not looked for at home");
    held.get("passes b")();
    await flush();
    await flush();
    assert.equal(view._selectedId, b.id);
    assert.equal(view._userSelected, true);
    assert.deepEqual(opened, [[b.id, "b"]], "the street view, at the cottage");
    assert.equal(notices(), 0, "never 'no longer in the predictions'");
    // An old id still being looked up when home is picked again: its answer is the cottage's, and is let go.
    holding = new Set(["pass_track b"]);
    view.selectPass(`48274-${b.start - 30}`);
    await flush();
    view.config = { entry_id: "a" };
    await flush();
    await flush();
    assert.equal(view._payload.location.entry_id, "a");
    held.get("pass_track b")();
    await flush();
    await flush();
    assert.equal(view._selectedId, a.id);
    assert.equal(view._userSelected, false);
    assert.equal(notices(), 0);
  } finally {
    clock.restore();
  }
});

test("simulating runs the shared clock over the pass, and Back to live ends it", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 3 * 3600, T0 + 3 * 3600 + 300);
    const { view, calls, fake } = passView(clock, [pass]);
    view._mode = "follow";
    await view._select(pass.id, { view: "simulate" });
    await flush();
    await flush();
    const c = view._clock;
    assert.equal(c.mode, "sim");
    assert.deepEqual({ ...c.window }, { fromS: pass.start - 120, toS: pass.end + 60, visibleStartS: pass.start, visibleEndS: pass.end });
    assert.equal(c.rateSetting, "fit");
    assert.equal(c.phase, "approach", "a fast-forward from now: the orbit covers it");
    assert.ok(view._simRows.length > 100);
    assert.deepEqual(calls.events.at(-1), ["pass-selected", { id: pass.id, view: "simulate" }]);
    const tracks = fake.calls.filter((m) => m.type === "satellite_spotter/track").map((m) => [Date.parse(m.start) / 1000, Date.parse(m.end) / 1000]);
    assert.ok(tracks.some(([s, e]) => s === T0 && e === pass.start - 120), "the orbit from now to the pass");
    // The fast-forward over, the camera frames the pass.
    const flights = calls.flyTo.length;
    for (let i = 0; i < 700 && c.phase === "approach"; i++) {
      clock.step();
      view._frame();
    }
    assert.equal(c.phase, "replay");
    assert.equal(calls.flyTo.length, flights + 1);
    assert.equal(calls.flyTo.at(-1).pitch, 50);
    assert.equal(calls.flyTo.at(-1).bearing, pass.peak.azimuth);
    // Back to live: real time, the camera and the mode as they were.
    view._stopSimulation({ user: true });
    assert.equal(c.mode, "live");
    assert.equal(view._mode, "follow");
    assert.equal(calls.flyTo.at(-1).zoom, 2);
    assert.deepEqual(calls.events.at(-1), ["pass-selected", { id: pass.id, view: null }]);
  } finally {
    clock.restore();
  }
});

test("a fast-forward cut short by a pause or a seek frames the pass all the same, once", async () => {
  for (const cut of ["pause", "seek"]) {
    const clock = installClock(T0 * 1000);
    try {
      const pass = makePass(T0 + 3 * 3600, T0 + 3 * 3600 + 300);
      const { view, calls } = passView(clock, [pass]);
      await view._select(pass.id, { view: "simulate" });
      await flush();
      await flush();
      const c = view._clock;
      for (let i = 0; i < 60; i++) {
        clock.step();
        view._frame();
      }
      assert.equal(c.phase, "approach", "still on the way");
      const flights = calls.flyTo.length;
      if (cut === "pause") c.pause();
      else c.seek(pass.start);
      for (let i = 0; i < 5; i++) {
        clock.step();
        view._frame();
      }
      assert.equal(c.phase, "replay");
      assert.equal(calls.flyTo.length, flights + 1, cut);
      assert.equal(calls.flyTo.at(-1).pitch, 50);
      assert.equal(calls.flyTo.at(-1).bearing, pass.peak.azimuth);
      // Played on from there: no second flight.
      c.play();
      c.seek(pass.start + 60);
      for (let i = 0; i < 5; i++) {
        clock.step();
        view._frame();
      }
      assert.equal(calls.flyTo.length, flights + 1);
    } finally {
      clock.restore();
    }
  }
});

test("the fast-forward keeps the globe one size at every latitude, hides the place names and leaves the sky chart shut", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 3 * 3600, T0 + 3 * 3600 + 300);
    const { view, calls } = passView(clock, [pass]);
    // The labels of a map with Home Assistant's tiles.
    const layers = new Map([["label-country", { visibility: "visible" }], ["label-places", { visibility: "visible" }]]);
    Object.assign(view._map, {
      getLayer: (id) => layers.get(id),
      getLayoutProperty: (id, name) => layers.get(id)?.[name],
      setLayoutProperty: (id, name, value) => {
        layers.get(id)[name] = value;
      },
    });
    await view._select(pass.id, { view: "simulate" });
    await flush();
    await flush();
    const c = view._clock;
    assert.equal(c.phase, "approach");
    assert.ok(!view._skyOpen, "the sky chart's popover would cover the mission card on phones");
    const jumps = calls.jumpTo.length;
    let hiddenOnTheWay = true;
    for (let i = 0; i < 700 && c.phase === "approach"; i++) {
      clock.step();
      view._frame();
      if (c.phase === "approach") hiddenOnTheWay &&= [...layers.values()].every((l) => l.visibility === "none");
    }
    assert.ok(hiddenOnTheWay, "no far-side names drawn through the globe while the camera jumps");
    const ride = calls.jumpTo.slice(jumps).filter((j) => j.zoom !== undefined);
    assert.ok(ride.length > 10);
    for (const j of ride) {
      const [, lat] = j.center;
      // MapLibre's globe grows by 1/cos(latitude) at the same zoom: taken back out, from one zoom.
      assert.ok(Math.abs(j.zoom - (2 + Math.log2(Math.max(Math.cos((lat * Math.PI) / 180), 0.15)))) < 1e-9, `zoom ${j.zoom} at ${lat}°`);
    }
    assert.ok(ride.some((j) => Math.abs(j.center[1]) > 45), "the ride reaches high latitudes");
    view._frame();
    assert.equal(c.phase, "replay");
    assert.ok([...layers.values()].every((l) => l.visibility === "visible"), "the names come back for the replay");
    view._stopSimulation({ user: true });
  } finally {
    clock.restore();
  }
});

test("a pass is framed the same size on the globe at every latitude, and as before at Boston's", () => {
  const clock = installClock(T0 * 1000);
  try {
    // The camera flies to a pass due north over home, `degrees` of latitude each way (as many km anywhere).
    const frame = (latitude, degrees = 8) => {
      const home = { ...HOME, latitude };
      const pass = makePass(T0 + 600, T0 + 900);
      const { view, calls } = passView(clock, [pass]);
      view._payload = makePayload([pass], { location: home });
      view._padding = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
      const lead = { ...makeDetail(pass).transits[0], rows: [] };
      for (let t = pass.start - 120; t <= pass.end + 120; t += 2) {
        lead.rows.push([t, latitude + (degrees * (2 * (t - pass.start) - 300)) / 300, home.longitude, 420, 1]);
      }
      view._details.set(pass.id, { pass_id: pass.id, step: 2, transits: [lead] });
      view._framePass(pass);
      const { center, zoom } = calls.flyTo.at(-1);
      assert.ok(Math.abs(center[1] - latitude) < 0.1, "between home and where the pass is highest");
      const seen = lead.rows.filter((r) => r[0] >= pass.start && r[0] <= pass.end);
      const reach = Math.max(...seen.map((r) => groundDistanceKm(center[1], center[0], r[1], r[2])));
      // How wide the pass is on screen: MapLibre's globe at a zoom is 1/cos(latitude) times larger.
      return { zoom, width: (reach * 2 ** zoom) / Math.cos((center[1] * Math.PI) / 180), reach };
    };
    const boston = frame(42.36);
    assert.ok(Math.abs(boston.zoom - (3.55 - Math.log2(boston.reach / 900))) < 0.005, `${boston.zoom}: as it was`);
    for (const latitude of [0, 30, 55, 69.65, -45]) {
      const { zoom, width } = frame(latitude);
      assert.ok(Math.abs(width / boston.width - 1) < 1e-9, `zoom ${zoom} at ${latitude}°: as wide as at Boston`);
    }
    // A short pass is framed as close as anywhere, short of where the globe turns into a map.
    assert.equal(frame(42.36, 1.5).zoom, 4.2);
    assert.equal(frame(0, 1.5).zoom, 4.2);
  } finally {
    clock.restore();
  }
});

test("a simulation without an orbit to fast-forward along starts at the pass; Escape ends it", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 3 * 3600, T0 + 3 * 3600 + 300);
    const { view } = passView(clock, [pass], {
      // The orbit from now is not there: only the one around the pass is.
      track: (msg) => {
        const s = Date.parse(msg.start) / 1000;
        return s === T0 ? [] : rows(s, Date.parse(msg.end) / 1000, msg.step);
      },
    });
    await view._select(pass.id, { view: "simulate" });
    await flush();
    await flush();
    assert.equal(view._clock.phase, "replay");
    assert.equal(view._clock.simS, pass.start - 120);
    const ev = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    view._onKey(ev);
    assert.equal(view._clock.mode, "live");
    assert.ok(ev.defaultPrevented && ev.stopped, "a dialog around the card stays open");
    const again = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    view._onKey(again);
    assert.equal(again.defaultPrevented, false, "nothing left to close");
  } finally {
    clock.restore();
  }
});

test("a simulation still loading when another location is picked does not start", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 3 * 3600, T0 + 3 * 3600 + 300);
    const { view } = passView(clock, [pass]);
    view._showMessage = () => {};
    view._config = { entry_id: "a" };
    view._select(pass.id, { view: "simulate" }); // its rows on their way...
    assert.equal(view._els.simBtn.disabled, true);
    view.config = { entry_id: "b" }; // ...when the location picker moves on
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(view._clock.mode, "live", "not the old location's pass, over the new home");
    assert.equal(view._sim, null);
    assert.equal(view._els.simBtn.disabled, false);
  } finally {
    clock.restore();
  }
});

test("the street view opens over the globe on the shared clock, and is freed when it closes", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 600, T0 + 900);
    const { view, calls } = passView(clock, [pass]);
    view._selectedId = pass.id;
    view._running = true;
    view._timers.push(setInterval(() => {}, 300000)); // stands in for the data refresh
    const made = [];
    const realCreate = document.createElement;
    document.createElement = (tag) => {
      if (tag !== "satellite-street-view") return realCreate(tag);
      const el = {
        tag,
        listeners: {},
        opened: 0,
        disposed: 0,
        removed: 0,
        passes: [],
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        },
        open() {
          this.opened++;
        },
        dispose() {
          this.disposed++;
        },
        remove() {
          this.removed++;
        },
        setPass(p, d) {
          this.passes.push([p.id, !!d]);
        },
      };
      made.push(el);
      return el;
    };
    const appended = [];
    view._wrap = { appendChild: (el) => appended.push(el) };
    let imports = 0;
    view._importStreet = async () => imports++;
    try {
      await view._openStreet(pass, { user: true });
      await flush();
      const el = made[0];
      assert.equal(imports, 1);
      assert.deepEqual(appended, [el], "inside the globe's wrapper, so its fullscreen covers it");
      assert.equal(el.opened, 1);
      assert.equal(el.clock, view._clock, "one clock for the globe, the street view and their time bars");
      assert.equal(el.pass, pass);
      // The location's entry too: the street view asks Home Assistant where its photos come from.
      assert.deepEqual(el.location, { entry_id: HOME.entry_id, latitude: HOME.latitude, longitude: HOME.longitude, elevation: HOME.elevation, title: HOME.title });
      assert.equal(el.formatter, view._fmt);
      // The street view keeps its own options; the globe only hands them back.
      assert.deepEqual(el.options, {}, "nothing stored: its own defaults");
      assert.equal(el.listeners["options-changed"], undefined, "not written here");
      assert.equal(view._clock.mode, "sim", "a later pass is simulated");
      assert.deepEqual(calls.events.find(([type]) => type === "pass-selected"), ["pass-selected", { id: pass.id, view: "street" }]);
      // The globe stops drawing, but its data keeps coming.
      assert.equal(view._suspended, true);
      view._scheduleFrames();
      assert.equal(view._raf, null);
      assert.equal(view._frameTimer, null);
      const frames = calls.frame;
      view._frame();
      assert.equal(calls.render, 0);
      assert.equal(calls.frame, frames + 1);
      assert.equal(view._timers.length, 1);
      // It asks for a pass's rows; they come.
      el.listeners["need-detail"]({ detail: { passId: pass.id } });
      await flush();
      assert.deepEqual(el.passes.at(-1), [pass.id, true]);
      // Opening it again does not make another.
      await view._openStreet(pass);
      assert.equal(made.length, 1);
      // Closed: freed, and the globe draws again.
      el.listeners.close();
      assert.equal(el.disposed, 1);
      assert.equal(el.removed, 1);
      assert.equal(view._street, null);
      assert.equal(view._suspended, false);
      assert.deepEqual(calls.events.at(-1), ["pass-selected", { id: pass.id, view: "simulate" }]);
      // A pass going on is shown live, not simulated.
      view._clock.live();
      clock.now = (pass.start + 30) * 1000;
      await view._openStreet(pass);
      assert.equal(view._clock.mode, "live");
      // Escape closes the street view before anything else.
      const ev = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
      view._onKey(ev);
      assert.equal(view._street, null);
      assert.equal(made[1].disposed, 1);
    } finally {
      document.createElement = realCreate;
    }
  } finally {
    clock.restore();
  }
});

test("a street view that cannot load says so, and the globe carries on", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 600, T0 + 900);
    const { view, calls } = passView(clock, [pass]);
    view._wrap = { appendChild: () => assert.fail("nothing to show") };
    view._importStreet = async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    };
    view._clock.live();
    clock.now = (pass.start + 10) * 1000;
    await view._openStreet(pass);
    assert.equal(view._street, undefined);
    assert.equal(view._suspended, undefined);
    assert.match(calls.events.at(-1)[1].message, /street view could not load/);
    // Turned off in the card: no street view at all.
    view._config = { street_view: false };
    view._importStreet = () => assert.fail("not loaded");
    await view._openStreet(pass);
  } finally {
    clock.restore();
  }
});

test("Escape while the street view is still loading keeps it from opening; the replay it started stays", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 3 * 3600, T0 + 3 * 3600 + 300);
    const { view, calls } = passView(clock, [pass]);
    view._selectedId = pass.id;
    const appended = [];
    view._wrap = { appendChild: (el) => appended.push(el) };
    let loaded;
    view._importStreet = () => new Promise((resolve) => (loaded = resolve));
    const realCreate = document.createElement;
    document.createElement = (tag) => (tag === "satellite-street-view" ? { tag, addEventListener() {}, open() {} } : realCreate(tag));
    try {
      const opening = view._openStreet(pass, { user: true });
      await flush();
      await flush();
      assert.equal(view._clock.mode, "sim", "a later pass is replayed for it");
      const escape = () => {
        const ev = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
        view._onKey(ev);
        return ev;
      };
      assert.equal(escape().defaultPrevented, true);
      assert.deepEqual(calls.events.at(-1), ["pass-selected", { id: pass.id, view: "simulate" }], "the address forgets it");
      loaded();
      await opening;
      assert.deepEqual(appended, [], "it never opens");
      assert.equal(view._street ?? null, null);
      assert.equal(view._clock.mode, "sim");
      escape();
      assert.equal(view._clock.mode, "live", "the next Escape ends the replay");
    } finally {
      document.createElement = realCreate;
    }
  } finally {
    clock.restore();
  }
});

test("Escape before the street view or its replay has loaded leaves nothing to start later", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 3 * 3600, T0 + 3 * 3600 + 300);
    const { view, calls } = passView(clock, [pass]);
    view._selectedId = pass.id;
    view._wrap = { appendChild() {} };
    let imported;
    view._importStreet = () => new Promise((resolve) => (imported = resolve));
    // The replay's path is a websocket round trip away.
    let arrive;
    const loadDetail = view._loadDetail.bind(view);
    view._loadDetail = (p) => new Promise((resolve) => (arrive = () => resolve(loadDetail(p))));
    const opening = view._openStreet(pass, { user: true });
    await flush();
    assert.equal(view._clock.mode, "live", "the replay is still loading");
    const ev = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    view._onKey(ev);
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual(calls.events.at(-1), ["pass-selected", { id: pass.id, view: null }]);
    arrive();
    imported();
    await opening;
    await flush();
    await flush();
    assert.equal(view._clock.mode, "live", "no replay starts after the Escape");
    assert.equal(view._street ?? null, null);
  } finally {
    clock.restore();
  }
});

test("every satellite's position: every five minutes while shown, around the pass when simulating, never when off", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 3 * 3600, T0 + 3 * 3600 + 300);
    const positions = (msg) => {
      const start = msg.start ? Date.parse(msg.start) / 1000 : Math.floor(Date.now() / 1000 / 60) * 60;
      const count = msg.span / msg.step + 1;
      return { start, step: msg.step, count, catalog_version: 3, ids: [25544, 48274], pos: [[], []], lit: ["1", "1"] };
    };
    const catalog = { updated: T0, version: 3, satellites: [{ norad_id: 25544, name: "ISS", kind: "iss", magnitude: -1.8, period_s: 5574 }] };
    const { view, fake } = passView(clock, [pass], { positions, catalog });
    const asked = () => fake.calls.filter((m) => m.type === "satellite_spotter/positions");
    let clouds = 0;
    view._space.setCloud = () => clouds++;
    // Off (a card's default): never asked for.
    await view._loadCloud();
    assert.equal(asked().length, 0);
    view._config = { show_satellites: true };
    await view._loadCloud();
    assert.deepEqual(asked().map((m) => [m.span, m.step, m.start]), [[600, 60, undefined]]);
    assert.equal(clouds, 1, "the cloud gets its satellites once per catalogue");
    assert.equal(view._catalogById.get(25544).name, "ISS");
    await view._loadCloud();
    clock.now += 4 * 60 * 1000;
    await view._loadCloud();
    assert.equal(asked().length, 1, "not again within five minutes");
    clock.now += 60 * 1000;
    await view._loadCloud();
    assert.equal(asked().length, 2, "after five minutes");
    assert.equal(clouds, 1);
    // A hidden tab came back after the positions ran out: at once.
    clock.now += 20 * 60 * 1000;
    view._positionsAt = performance.now();
    await view._loadCloud();
    assert.equal(asked().length, 3);
    // Simulating: the minutes around the pass.
    view._clock.simulate({ fromS: pass.start - 120, toS: pass.end + 60, visibleStartS: pass.start, visibleEndS: pass.end });
    await flush();
    await view._loadCloud();
    const sim = asked().at(-1);
    assert.equal(Date.parse(sim.start) / 1000, Math.floor((pass.start - 180) / 60) * 60);
    assert.ok(sim.span >= pass.end + 60 - (pass.start - 180) && sim.span <= 3600);
    const n = asked().length;
    await view._loadCloud();
    assert.equal(asked().length, n, "once per simulation");
    // The toggle turns it off.
    view._syncControls = () => {};
    view._toggleCloud();
    assert.equal(view._cloudWanted(), false);
    view._clock.live();
    clock.now += 60 * 60 * 1000;
    await view._loadCloud();
    assert.equal(asked().length, n);
  } finally {
    clock.restore();
  }
});

test("positions that come in for a moment no longer shown are let go, so the cloud stays up through a replay", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 3 * 3600, T0 + 3 * 3600 + 300);
    const pending = [];
    const positions = (msg) =>
      new Promise((resolve) => {
        const start = msg.start ? Date.parse(msg.start) / 1000 : Math.floor(Date.now() / 1000 / 60) * 60;
        const answer = { start, step: msg.step, count: msg.span / msg.step + 1, catalog_version: 3, ids: [25544], pos: [[]], lit: ["1"] };
        pending.push({ live: !msg.start, answer: () => resolve(answer) });
      });
    const { view } = passView(clock, [pass], { positions });
    view._config = { show_satellites: true };
    const shown = [];
    view._space.setCloudPositions = (xy, { visible }) => shown.push(visible);
    view._loadCloud(); // the live positions are on their way when...
    view._clock.simulate({ fromS: pass.start - 120, toS: pass.end + 60, visibleStartS: pass.start, visibleEndS: pass.end });
    await flush();
    assert.deepEqual(pending.map((p) => p.live), [true, false], "...a simulation asks for its own");
    pending[1].answer();
    await flush();
    await flush();
    pending[0].answer(); // the live ones last
    await flush();
    await flush();
    for (const t of [pass.start - 60, pass.start + 60, pass.end]) view._updateCloud(t);
    assert.deepEqual(shown.slice(-3), [true, true, true]);
    assert.equal(pending.length, 2, "nothing asked again");
  } finally {
    clock.restore();
  }
});

test("a satellite clicked in the cloud is followed, and its next pass shown", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const a = makePass(T0 + 600, T0 + 900);
    const b = makePass(T0 + 7200, T0 + 7500, { ids: [48274], kind: "tiangong", title: "Tiangong" });
    const { view, calls } = passView(clock, [a, b]);
    view._reconcileSelection();
    view._positions = { start: T0, step: 60, count: 11, catalog_version: 3, ids: [25544, 48274] };
    view._cloudIndex = new Map([[25544, 0], [48274, 1]]);
    view._catalogById = new Map([[48274, { norad_id: 48274, name: "Tiangong", kind: "tiangong", period_s: 5520 }]]);
    view._config = { panel: true };
    view._space.pick = (x, y) => (x === 10 && y === 20 ? 1 : -1);
    view._onMapClick({ x: 300, y: 300 });
    assert.equal(view._focus, null, "nothing there");
    view._onMapClick({ x: 10, y: 20 });
    await flush();
    assert.equal(view._focusInfo().norad_id, 48274);
    assert.equal(view._focusInfo().name, "Tiangong");
    assert.equal(view._selectedId, b.id, "its next pass");
    assert.deepEqual(calls.events.at(-1), ["pass-selected", { id: b.id, view: null }]);
    // Picking a pass again shows the pass's own satellite.
    await view._select(a.id);
    assert.equal(view._focusInfo().norad_id, 25544);
  } finally {
    clock.restore();
  }
});

test("following or chasing a satellite far out, the camera stays beyond it at any latitude, in any size of map", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 600, T0 + 900);
    const { view, calls } = passView(clock, [pass]);
    const eased = [];
    let zoom = 3.2;
    let height = 420;
    Object.assign(view._map, {
      getZoom: () => zoom,
      easeTo: (opts) => eased.push(opts),
      getCanvas: () => ({ clientHeight: height }),
      // MapLibre's default: its camera is 1.5 map heights from the point it looks at.
      getVerticalFieldOfView: () => 36.86989764584402,
    });
    // How far the camera is from the point it looks at, in Earth radii; a satellite drawn
    // `above` radii over that point is in front of a camera at this pitch while that is more.
    const reach = (z, lat) => (1.5 * height * 2 * Math.PI * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** z);
    const inFront = (z, lat, alt, pitch) =>
      reach(z, lat) >= (displayAltitudeKm(alt) / 6371.0088) * Math.cos((pitch * Math.PI) / 180) + 0.2 - 1e-9;
    for (const alt of [420, 2000, 20200, 35786, 39000]) {
      for (const lat of [0, 30, 56.2, 70, -65]) {
        for (const h of [360, 420, 760, 1000]) {
          height = h;
          zoom = 3.2;
          view._position = { lat, lon: 10, alt, heading: 90 };
          view._setMode("follow");
          const where = `${alt} km at ${lat}° in a ${h} px map`;
          assert.ok(eased.at(-1).zoom <= 3.2 && inFront(eased.at(-1).zoom, lat, alt, 0), `follow: ${where}`);
          view._setMode("chase");
          assert.equal(eased.at(-1).pitch, 64);
          assert.ok(eased.at(-1).zoom <= 3.3 && inFront(eased.at(-1).zoom, lat, alt, 64), `chase: ${where}`);
        }
      }
    }
    // The space station is followed as close as ever.
    height = 844;
    view._position = { lat: 42, lon: -71, alt: 420, heading: 90 };
    view._setMode("follow");
    assert.equal(eased.at(-1).zoom, 3.2);

    // Zoomed in past a satellite far out while following it: the next frame backs out.
    view._courseRows = () => [
      [T0 - 600, 56, 10, 38000, 1],
      [T0 + 600, 57, 12, 38500, 1],
    ];
    view._mode = "follow";
    zoom = 4.2;
    view._frame();
    const back = calls.jumpTo.at(-1);
    assert.ok(back.zoom < 4.2, `zoom ${back.zoom}`);
    assert.ok(inFront(back.zoom, back.center[1], 38250, 0));
  } finally {
    clock.restore();
  }
});

test("the cloud's flags: the pass's satellites gold, those in the sky now breathing, the drawn ones left out", () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 - 60, T0 + 240, { ids: [25544, 48274], kind: "iss" });
    const { view } = passView(clock, [pass]);
    view._selectedId = pass.id;
    view._cloudIndex = new Map([[25544, 0], [48274, 1], [20580, 2]]);
    view._cloudFlagBits = new Uint8Array(3);
    let flags = null;
    view._space.setCloudFlags = (f) => (flags = Array.from(f));
    view._updateCloudFlags();
    assert.deepEqual(flags, [8 | 4, 8 | 4, 0]);
    // With the pass's rows, its satellites are drawn as sprites, not dots.
    view._details.set(pass.id, makeDetail(pass));
    view._position = { lat: 0, lon: 0, alt: 420 };
    view._hover = 20580;
    view._updateCloudFlags();
    assert.deepEqual(flags, [8 | 4 | 1, 8 | 4 | 1, 2]);
    // Unchanged flags are not sent again.
    flags = null;
    view._updateCloudFlags();
    assert.equal(flags, null);
  } finally {
    clock.restore();
  }
});

test("the other satellites of a pass are drawn where their rows reach, a train's as copies of the leader", () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 60, T0 + 360, { ids: [101, 102, 103], kind: "starlink", train: true });
    const { view } = passView(clock, [pass]);
    view._selectedId = pass.id;
    view._details.set(pass.id, makeDetail(pass, { withRows: 2 }));
    // The leader is the focus satellite (drawn in full); the other two are dots.
    const objects = view._memberObjects(T0 + 200, 2);
    assert.deepEqual(objects.map((o) => o.id), [102, 103]);
    assert.ok(objects.every((o) => !o.primary && o.size >= 7));
    assert.equal(view._memberObjects(T0 - 3600, 2).length, 0, "nowhere near: none");
    // A train member without rows followed from the cloud: its course is made once, not every frame.
    view._focus = { norad_id: 103, name: "SAT 103", kind: "starlink", period_s: 5574, picked: true };
    view._focusTrack = { norad: 103, rows: rows(T0 - 2800, T0 + 7000, 30), from: T0 - 2800, to: T0 + 7000 };
    const course = view._courseRows();
    assert.ok(course.some((r) => r[0] === T0 + 60 + 40), "with its pass's 2 s rows");
    assert.equal(view._courseRows(), course);
  } finally {
    clock.restore();
  }
});

test("a simulation the street view's own time bar ends or starts is followed", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const pass = makePass(T0 + 3 * 3600, T0 + 3 * 3600 + 300);
    const { view, calls } = passView(clock, [pass]);
    view._selectedId = pass.id;
    view._mode = "follow";
    // Its "Back to live": the globe forgets the simulation, and its camera goes back.
    await view._simulate(pass, { approach: false });
    assert.ok(view._sim);
    view._clock.live();
    assert.equal(view._sim, null);
    assert.equal(view._simRows, null);
    assert.equal(view._mode, "follow");
    assert.equal(calls.flyTo.at(-1).zoom, 2);
    // Its "Replay the pass": the globe shows that pass, with its satellite's orbit.
    view._clock.simulate({ fromS: pass.start - 120, toS: pass.end + 60, visibleStartS: pass.start, visibleEndS: pass.end });
    assert.equal(view._sim.pass.id, pass.id);
    await flush();
    await flush();
    assert.ok(view._simRows.length > 100, "the orbit and the pass's own rows");
    assert.equal(view._shownPass().id, pass.id);
    // Clicks on the cloud do not change the satellite while a pass plays.
    view._positions = { ids: [48274] };
    view._cloudIndex = new Map([[48274, 0]]);
    view._catalogById = new Map([[48274, { norad_id: 48274, name: "Tiangong", kind: "tiangong" }]]);
    view._config = { panel: true };
    view._space.pick = () => 0;
    view._onMapClick({ x: 1, y: 1 });
    assert.equal(view._focus, null);
  } finally {
    clock.restore();
  }
});

test("positions that fail to load are asked for again after a back-off, not every frame", async () => {
  const clock = installClock(T0 * 1000);
  try {
    const { view, fake } = passView(clock, [], {
      positions: (msg) => ({ start: T0, step: 60, count: msg.span / 60 + 1, catalog_version: 3, ids: [25544], pos: [[]], lit: ["1"] }),
    });
    view._config = { show_satellites: true };
    Object.defineProperty(view, "isConnected", { value: true });
    const asked = () => fake.calls.filter((m) => m.type === "satellite_spotter/positions").length;
    fake.fail["satellite_spotter/positions"] = { code: "not_ready", message: "Starting up" };
    await view._loadCloud();
    assert.equal(asked(), 1);
    // Frames find nothing to show and ask again: they wait for the retry.
    for (let i = 0; i < 10; i++) {
      view._updateCloud(T0);
      await view._loadCloud();
    }
    assert.equal(asked(), 1);
    delete fake.fail["satellite_spotter/positions"];
    clock.step(30000); // the retry
    await flush();
    await flush();
    assert.equal(asked(), 2);
    assert.ok(view._positions, "in at last");
  } finally {
    clock.restore();
  }
});
