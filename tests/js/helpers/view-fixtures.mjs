// Synthetic data and fakes for the globe view tests (not a test file itself):
// a fake clock with HTML-spec animation frames, track rows, passes and their
// pass_track payloads in the integration's shapes (DESIGN §2.3), and a fake
// Home Assistant that answers the satellite_spotter/* commands from them.
import { lookAngles } from "../../../custom_components/satellite_spotter/frontend/sat-geo.js";

export const T0 = Date.parse("2026-10-10T22:00:00Z") / 1000;
export const HOME = { entry_id: "a", title: "Home", latitude: 42.36, longitude: -71.06, elevation: 10 };

/** Install fake time: Date.now, performance.now, animation frames and timeouts, and a document. */
export function installClock(startMs) {
  const clock = { now: startMs, rafs: new Map(), timeouts: new Map(), seq: 0 };
  const saved = {
    dateNow: Date.now,
    performance: globalThis.performance,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
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
  globalThis.setInterval = (fn, ms) => {
    const id = ++clock.seq;
    clock.timeouts.set(id, { fn, at: clock.now + ms, every: ms });
    return id;
  };
  globalThis.clearInterval = (id) => clock.timeouts.delete(id);
  const listeners = new Map();
  globalThis.document = {
    ...(saved.document || {}),
    hidden: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  clock.listeners = listeners;
  /** Advance by one display frame: run that frame's callbacks, then due timers. */
  clock.step = (ms = 16) => {
    clock.now += ms;
    for (const [id, cb] of [...clock.rafs]) {
      if (!clock.rafs.has(id)) continue;
      clock.rafs.delete(id); // A running callback's handle is already gone, as in browsers.
      cb(clock.now);
    }
    for (const [id, t] of [...clock.timeouts]) {
      if (t.at <= clock.now && clock.timeouts.has(id)) {
        if (t.every) t.at += t.every;
        else clock.timeouts.delete(id);
        t.fn();
      }
    }
  };
  clock.restore = () => {
    Date.now = saved.dateNow;
    Object.defineProperty(globalThis, "performance", { value: saved.performance, configurable: true, writable: true });
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
    globalThis.setInterval = saved.setInterval;
    globalThis.clearInterval = saved.clearInterval;
    globalThis.document = saved.document;
  };
  return clock;
}

/** Synthetic orbit rows [t, lat, lon, alt_km, sunlit]: an ISS-like ground track. */
export function rows(start, end, step) {
  const out = [];
  for (let t = start; t <= end; t += step) {
    const phase = ((t - T0) / 5560) * 2 * Math.PI;
    out.push([t, 51.6 * Math.sin(phase), ((((t - T0) / 5560) * 360 - 71 + 540) % 360) - 180, 420, 1]);
  }
  return out;
}

/**
 * pass_track rows [t, lat, lon, alt, lit, az, el, range, mag, vis] of a
 * satellite crossing over home from the south-west to the north-east.
 */
export function passRows(start, end, step = 2, home = HOME) {
  const out = [];
  const span = end - start;
  for (let t = start - 120; t <= end + 120; t += step) {
    const f = (t - start) / span;
    const lat = home.latitude - 8 + 16 * f;
    const lon = home.longitude - 10 + 20 * f;
    const look = lookAngles(home, { lat, lon, alt: 420 });
    const vis = t >= start && t <= end ? 1 : 0;
    out.push([t, lat, lon, 420, 1, +look.azimuth.toFixed(2), +look.elevation.toFixed(2), +look.range.toFixed(1), vis ? -2 : null, vis]);
  }
  return out;
}

/** A pass of the passes payload, with one transit per satellite id. */
export function makePass(start, end, { ids = [25544], kind = "iss", bright = true, title = "ISS", train = false, cloud = 12, ...extra } = {}) {
  const transits = ids.map((id, i) => ({
    norad_id: id,
    name: i ? `SAT ${id}` : title,
    kind: i ? "starlink" : kind,
    start: start + i * 20,
    end: end + i * 20,
    magnitude: -2.5,
    brightest_time: start + 60 + i * 20,
    rise: { azimuth: 225, elevation: 12, direction: "SW" },
    brightest: { azimuth: 150, elevation: 60, direction: "SSE" },
    set: { azimuth: 45, elevation: 11, direction: "NE" },
    peak: { time: start + 90, azimuth: 150, elevation: 67, direction: "SSE" },
    start_reason: "rise",
    end_reason: "set",
    period_s: 5574,
    info_url: "https://en.wikipedia.org/wiki/International_Space_Station",
    confidence: "high",
  }));
  return {
    id: `${ids[0]}-${start}`,
    title,
    kind,
    start,
    end: end + (ids.length - 1) * 20,
    duration: end - start,
    magnitude: -2.5,
    bright,
    before_sunset: false,
    limiting_magnitude: 4,
    cloud_cover: cloud,
    satellite_count: ids.length,
    train,
    peak: { time: start + 90, azimuth: 150, elevation: 67, direction: "SSE" },
    transits,
    ...extra,
  };
}

/** The pass_track payload of a pass: rows for the first `withRows` members, the rest shifted copies. */
export function makeDetail(pass, { withRows = 6 } = {}) {
  const lead = pass.transits[0];
  return {
    pass_id: pass.id,
    step: 2,
    sun: [],
    transits: pass.transits.map((t, i) => {
      const own = i < withRows;
      const offset = t.brightest_time - lead.brightest_time;
      const r = own ? passRows(t.start, t.end) : null;
      return {
        norad_id: t.norad_id,
        name: t.name,
        kind: t.kind,
        offset_s: offset,
        horizon_rise: own ? r[0][0] : lead.start - 120 + offset,
        horizon_set: own ? r[r.length - 1][0] : lead.end + 120 + offset,
        visible_start: t.start,
        visible_end: t.end,
        rows: r,
      };
    }),
  };
}

/** A passes payload. */
export function makePayload(passes = [], extra = {}) {
  return {
    generated_at: T0,
    server_time: T0,
    computed_at: T0,
    paused: null,
    paused_days: null,
    paused_error: null,
    location: HOME,
    settings: { max_magnitude: 3, cloud_cover: true, alert_lead_minutes: 15, units: "auto", days: 5, min_elevation: 10 },
    catalog: { updated: T0 - 3600, version: 3, satellites: 3, median_epoch_age_days: 1 },
    passes,
    ...extra,
  };
}

/**
 * A fake Home Assistant answering the integration's commands from `data`:
 * {payload, details: {id: pass_track}, track(msg) -> rows, positions(msg), catalog}.
 * Every call is kept in `calls`; `fail[type]` makes a command reject with it.
 */
export function fakeHass(data = {}) {
  const calls = [];
  const fail = {};
  const hass = {
    language: "en",
    locale: { language: "en", number_format: "language", time_format: "12", time_zone: "server" },
    config: { time_zone: "America/New_York", unit_system: { length: "km" }, components: [] },
    callWS: async (msg) => {
      calls.push(msg);
      if (fail[msg.type]) throw fail[msg.type];
      switch (msg.type) {
        case "satellite_spotter/passes":
          return data.payload;
        case "satellite_spotter/pass_track": {
          const d = data.details?.[msg.pass_id] ?? (data.alias?.[msg.pass_id] && data.details?.[data.alias[msg.pass_id]]);
          if (!d) throw { code: "unknown_pass", message: "No such pass" };
          return d;
        }
        case "satellite_spotter/track":
          return { norad_id: msg.norad_id, step: msg.step, track: data.track ? data.track(msg) : [] };
        case "satellite_spotter/positions":
          return data.positions ? data.positions(msg) : { start: T0, step: 60, count: 11, catalog_version: 3, ids: [], pos: [], lit: [] };
        case "satellite_spotter/catalog":
          return data.catalog ?? { updated: T0, version: 3, satellites: [] };
        case "map_tiles/access_token":
          throw { code: "unknown_command", message: "Unknown command." };
        default:
          throw { code: "unknown_command", message: "Unknown command." };
      }
    },
  };
  return { hass, calls, fail };
}

/** Let pending promises settle. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));
