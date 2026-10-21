// Fakes for the street view's tests (no DOM library): a recording 2D canvas,
// just enough DOM, a MapLibre map, timers and animation frames.

/** A 2D context that accepts every call and records them as [name, ...args]. */
export function fakeContext(canvas) {
  const calls = [];
  const state = { font: "10px sans-serif", fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, globalAlpha: 1, transform: [1, 0, 0, 1, 0, 0] };
  const special = {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (text) => ({ width: String(text).length * 6.5 }),
    setTransform: (...m) => {
      state.transform = m;
    },
    getTransform: () => ({ a: state.transform[0] }),
  };
  return new Proxy(state, {
    get(target, name) {
      if (name === "canvas") return canvas;
      if (name === "calls") return calls;
      if (name in special) {
        return (...args) => {
          calls.push([name, ...args]);
          return special[name](...args);
        };
      }
      if (name in target) return target[name];
      if (typeof name === "symbol") return undefined;
      return (...args) => {
        calls.push([name, ...args]);
      };
    },
    set(target, name, value) {
      target[name] = value;
      return true;
    },
  });
}

/** A canvas whose 2D context records its calls. */
export function fakeCanvas(width = 300, height = 150) {
  const canvas = { width, height, style: {} };
  const ctx = fakeContext(canvas);
  canvas.getContext = (type) => (type === "2d" ? ctx : null);
  canvas.ctx = ctx;
  return canvas;
}

/** A DOM element good enough for the street view's HUD code. */
export function fakeElement(tag = "div") {
  const listeners = new Map();
  const attributes = new Map();
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(),
    hidden: false,
    textContent: "",
    innerHTML: "",
    title: "",
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    children: [],
    firstElementChild: { style: {} },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on),
      contains: (c) => classes.has(c),
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) ?? []) fn({ type, target: el, preventDefault() {}, stopPropagation() {}, composedPath: () => [el], ...event });
    },
    listeners,
    querySelector: () => null,
    querySelectorAll: () => [],
    append: (...c) => el.children.push(...c),
    replaceChildren: () => {
      el.children = [];
    },
    remove() {},
    focus() {},
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    clientWidth: 0,
    clientHeight: 0,
  };
  return el;
}

/** The street view's element map (_els) made of fakes, with real-looking canvases. */
export function fakeHud(width = 1280, height = 800) {
  const names = ["root", "stage", "map", "title", "state", "chips", "icon", "name", "when", "look", "note", "tools", "cam", "layersBtn", "infoBtn",
    "closeBtn", "compassBtn", "lookBtn", "followBtn", "phoneBtn", "menu", "sheet", "banner", "bannerText", "bar", "veil", "veilMsg", "veilSub", "announce",
    "photoPick", "photoPrev", "photoNext", "photoWhere", "photoWhen", "photoNote", "sources", "photoCredit"];
  const els = Object.fromEntries(names.map((n) => [n, fakeElement()]));
  els.menu.hidden = true;
  els.sheet.hidden = true;
  els.banner.hidden = true;
  els.sky = fakeCanvas(width, height);
  els.overlay = fakeCanvas(width, height);
  els.root.clientWidth = width;
  els.root.clientHeight = height;
  return els;
}

/**
 * Fake time: Date.now, performance.now, animation frames and timeouts that
 * only move when told to (step), and a document with visibility listeners.
 */
export function installClock(startMs) {
  const clock = { now: startMs, rafs: new Map(), timeouts: new Map(), seq: 0 };
  const saved = {
    dateNow: Date.now,
    performance: globalThis.performance,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    document: globalThis.document,
  };
  Date.now = () => clock.now;
  Object.defineProperty(globalThis, "performance", { value: { now: () => clock.now - startMs }, configurable: true, writable: true });
  globalThis.requestAnimationFrame = (cb) => {
    const id = ++clock.seq;
    clock.rafs.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => clock.rafs.delete(id);
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = ++clock.seq;
    clock.timeouts.set(id, { fn, at: clock.now + ms });
    return id;
  };
  globalThis.clearTimeout = (id) => clock.timeouts.delete(id);
  const listeners = new Map();
  globalThis.document = {
    hidden: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    createElement: (tag) => (tag === "canvas" ? fakeCanvas(1, 1) : fakeElement(tag)),
  };
  clock.listeners = listeners;
  /** One display frame: its animation frame callbacks, then the timeouts due. */
  clock.step = (ms = 16) => {
    clock.now += ms;
    const t = clock.now - startMs;
    for (const [id, cb] of [...clock.rafs]) {
      if (!clock.rafs.has(id)) continue;
      clock.rafs.delete(id);
      cb(t);
    }
    for (const [id, task] of [...clock.timeouts]) {
      if (task.at <= clock.now && clock.timeouts.has(id)) {
        clock.timeouts.delete(id);
        task.fn();
      }
    }
  };
  /** Let promises settle (microtasks), then step. */
  clock.settle = async (frames = 1, ms = 16) => {
    for (let i = 0; i < frames; i++) {
      await new Promise((resolve) => saved.setTimeout(resolve, 0));
      clock.step(ms);
    }
    await new Promise((resolve) => saved.setTimeout(resolve, 0));
  };
  clock.restore = () => {
    Date.now = saved.dateNow;
    Object.defineProperty(globalThis, "performance", { value: saved.performance, configurable: true, writable: true });
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
    globalThis.document = saved.document;
  };
  return clock;
}

/** A MapLibre stand-in: records camera moves, paint changes and events; renders on demand. */
export function fakeMapLibre({ failWebGL = false } = {}) {
  const maps = [];
  class Map {
    constructor(options) {
      if (failWebGL) throw new Error("Failed to initialize WebGL");
      this.options = options;
      this.listeners = new globalThis.Map();
      this.jumps = [];
      this.paints = [];
      this.layout = [];
      this.images = new globalThis.Map();
      this.removed = false;
      this.terrain = options.style.terrain ?? null;
      this.style = options.style;
      this.fov = 36.87;
      this.repaints = 0;
      this.near = [];
      const transform = { overrideNearFarZ: (near, far) => this.near.push([near, far]) };
      this._camera = { transform, _requestedCameraState: { overrideNearFarZ: (near, far) => this.near.push([near, far]) } };
      this.canvas = { clientWidth: 1280, clientHeight: 800, getContext: () => null };
      this.container = { querySelector: () => null };
      maps.push(this);
    }
    on(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
      return this;
    }
    once(type, fn) {
      const wrapper = (e) => {
        this.listeners.get(type)?.delete(wrapper);
        fn(e);
      };
      return this.on(type, wrapper);
    }
    fire(type, event = {}) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...event });
    }
    getCanvas() {
      return this.canvas;
    }
    getContainer() {
      return this.container;
    }
    getVerticalFieldOfView() {
      return this.fov;
    }
    setVerticalFieldOfView(fov) {
      this.fov = fov;
    }
    jumpTo(options) {
      this.jumps.push(options);
    }
    triggerRepaint() {
      this.repaints++;
    }
    getPixelRatio() {
      return 1;
    }
    resize() {}
    loaded() {
      return true;
    }
    isMoving() {
      return false;
    }
    queryTerrainElevation() {
      return this.terrainHeight ?? null;
    }
    getLayer(id) {
      return this.style.layers.find((l) => l.id === id) ?? null;
    }
    addLayer(layer) {
      this.style = { ...this.style, layers: [...this.style.layers, layer] };
    }
    /** The features a test put in (map.features[sourceLayer]), as MapLibre returns those of its loaded tiles. */
    querySourceFeatures(source, { sourceLayer, filter } = {}) {
      this.queried = [...(this.queried ?? []), { source, sourceLayer, filter }];
      return this.features?.[sourceLayer] ?? [];
    }
    setPaintProperty(layer, name, value) {
      this.paints.push([layer, name, value]);
    }
    setLayoutProperty(layer, name, value) {
      this.layout.push([layer, name, value]);
    }
    setLight(light) {
      this.light = light;
    }
    setTerrain(terrain) {
      this.terrain = terrain;
    }
    setStyle(style) {
      this.style = style;
    }
    hasImage(id) {
      return this.images.has(id);
    }
    addImage(id, image, options) {
      this.images.set(id, { image, options });
    }
    updateImage(id, image) {
      this.images.set(id, { ...this.images.get(id), image });
    }
    remove() {
      this.removed = true;
    }
  }
  return { Map, maps };
}

/** A formatter with the methods the street view calls (English, 24 h, UTC). */
export function fakeFormatter() {
  const pad = (n) => String(n).padStart(2, "0");
  const time = (t) => {
    const d = new Date(t * 1000);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  return {
    imperial: false,
    t: (key, vars = {}) => `${key}${Object.keys(vars).length ? JSON.stringify(vars) : ""}`,
    html: (key, vars = {}) => `${key}${Object.keys(vars).length ? JSON.stringify(vars) : ""}`,
    time: (t) => time(t),
    dateTime: (t) => `day ${time(t)}`,
    duration: (s) => `${Math.round(s)} s`,
    magnitude: (m) => (Math.round(m * 10) / 10).toFixed(1).replace("-", "−"),
    countdown: (ms) => `${pad(Math.floor(ms / 60000))}:${pad(Math.floor(ms / 1000) % 60)}`,
    direction: (d) => d,
    degrees: (v) => `${v}°`,
    num: (v, digits = 0) => Number(v).toFixed(digits),
    passTitle: (p) => p?.title ?? "",
    update() {},
  };
}

/**
 * A synthetic pass over Boston with its pass_track: rises in the WSW, climbs
 * to `peak` degrees in the SSE, sets in the ENE, sunlit after `litFrom`.
 */
export function syntheticPass({ start = 1792400000, peak = 60, litFrom = 100, members = 0, train = false } = {}) {
  const rows = [];
  const span = 600;
  for (let k = 0; k <= span; k += 2) {
    const f = k / span;
    const az = (250 + 180 * f) % 360;
    const el = -1 + (peak + 1) * Math.sin(Math.PI * f);
    const lit = k >= litFrom ? 1 : 0;
    const mag = lit && el > 0 ? -1.5 + (1 - el / peak) * 2 : null;
    const vis = lit && el >= 10 ? 1 : 0;
    rows.push([start + k, 40, -80, 420, lit, az, el, 1200, mag, vis]);
  }
  const visible = rows.filter((r) => r[9]);
  const vs = visible[0][0];
  const ve = visible[visible.length - 1][0];
  const transit = (i) => ({
    norad_id: 25544 + i,
    name: i ? `MEMBER ${i}` : "ISS",
    kind: i ? "starlink" : "iss",
    offset_s: i * 20,
    horizon_rise: start + i * 20,
    horizon_set: start + span + i * 20,
    visible_start: vs + i * 20,
    visible_end: ve + i * 20,
    rows: i && train ? null : rows.map((r) => [r[0] + i * 20, ...r.slice(1)]),
  });
  const transits = [...Array(members + 1).keys()].map(transit);
  const brightest = rows.reduce((a, b) => (Number.isFinite(b[8]) && (!Number.isFinite(a[8]) || b[8] < a[8]) ? b : a));
  const pass = {
    id: `25544-${vs}`,
    title: train ? "Starlink train" : "ISS",
    kind: "iss",
    start: vs,
    end: ve,
    duration: ve - vs,
    magnitude: brightest[8],
    bright: true,
    before_sunset: false,
    satellite_count: members + 1,
    train,
    peak: { time: start + span / 2, azimuth: 340, elevation: peak, direction: "NNW" },
    transits: transits.map((t, i) => ({
      norad_id: t.norad_id,
      name: t.name,
      kind: t.kind,
      start: t.visible_start,
      end: t.visible_end,
      magnitude: brightest[8],
      brightest_time: brightest[0] + i * 20,
      rise: { azimuth: 250, elevation: 10, direction: "WSW" },
      brightest: { azimuth: brightest[5], elevation: brightest[6], direction: "S" },
      set: { azimuth: 70, elevation: 10, direction: "ENE" },
      peak: { time: start + span / 2, azimuth: 340, elevation: peak, direction: "NNW" },
      start_reason: litFrom > 0 ? "shadow" : "rise",
      end_reason: "set",
    })),
  };
  return { pass, detail: { pass_id: pass.id, step: 2, sun: [[start, 80, -20]], transits } };
}
