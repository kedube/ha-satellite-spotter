/**
 * The globe's side of the integration's websocket API (satellite_spotter/*),
 * plus the small rules every view follows around it: how errors are told
 * apart, how a device clock that is off gets corrected, and how retries back
 * off. Python predicts, this asks; nothing here touches the DOM or the map.
 */

/** The websocket commands (DESIGN §2.3). */
export const COMMANDS = Object.freeze({
  locations: "satellite_spotter/locations",
  passes: "satellite_spotter/passes",
  passTrack: "satellite_spotter/pass_track",
  track: "satellite_spotter/track",
  positions: "satellite_spotter/positions",
  catalog: "satellite_spotter/catalog",
  mapToken: "map_tiles/access_token",
});

/** The most rows the integration sends for one track request. */
export const MAX_TRACK_ROWS = 6000;

/**
 * An error's code: Home Assistant sends {code, message}; a dropped
 * connection can also come as a bare number (3) or wrapped in {error}.
 */
export function errorCode(err) {
  const e = err?.error ?? err;
  return typeof e === "number" ? e : e?.code;
}

/** An error as a short message (technical, usually English). */
export function errorMessage(err, connectionLost = "connection lost") {
  const e = err?.error ?? err;
  if (typeof e === "string") return e;
  if (e?.message) return e.message;
  const code = errorCode(err);
  if (code === 3) return connectionLost;
  if (code !== undefined) return String(code);
  try {
    return JSON.stringify(e)?.slice(0, 200) ?? String(e);
  } catch {
    return String(e);
  }
}

/**
 * Which sentence explains an error: {key, vars} in the "globe" group. `panel`
 * picks the wording for a deleted location (the panel offers others; a card
 * has to be edited).
 */
export function errorText(err, { panel = false, connectionLost } = {}) {
  switch (errorCode(err)) {
    case 3:
      return { key: "globe.reconnecting" };
    case "not_found":
      return { key: "globe.not_set_up" };
    case "unknown_location":
      return { key: panel ? "globe.location_gone_panel" : "globe.location_gone_card" };
    case "location_disabled":
      return { key: "globe.location_disabled" };
    case "stale_catalog":
      return { key: "globe.stale_catalog" };
    case "not_ready": {
      // The integration's own reason, unless it only says that it is waiting.
      const why = errorMessage(err, connectionLost);
      return why && !/^waiting/i.test(why) ? { key: "globe.waiting_because", vars: { reason: why } } : { key: "globe.waiting" };
    }
    default:
      return { key: "globe.data_failed", vars: { error: errorMessage(err, connectionLost) } };
  }
}

/** Whether an error is worth a spinner: the integration or the connection is on its way back. */
export function errorIsTransient(err) {
  const code = errorCode(err);
  return code === "not_ready" || code === 3;
}

/**
 * The correction for a device clock that is off, from the server's time and
 * the round trip that brought it: the new offset in ms (server − device).
 * A slow round trip is not trusted; small differences are left alone, and
 * once correcting it carries on until the clock is within a second, so one
 * about two seconds off does not make the countdown jump back and forth.
 */
export function nextClockOffset(current, serverTimeS, sentMs, receivedMs) {
  if (typeof serverTimeS !== "number" || !Number.isFinite(serverTimeS) || receivedMs - sentMs > 2000) return current;
  const offset = serverTimeS * 1000 - (sentMs + receivedMs) / 2;
  const limit = current ? 1000 : 2000;
  return Math.abs(offset) > limit ? offset : 0;
}

/** The next wait of a back-off that doubles from `min` up to `max` (ms). */
export function nextDelay(previous, min, max) {
  return Math.min(Math.max(2 * (previous || 0), min), max);
}

const iso = (unixS) => new Date(unixS * 1000).toISOString();

/**
 * A step (s) that keeps a track of `spanS` within the integration's row limit,
 * no finer than `step`.
 */
export function trackStep(spanS, step = 30) {
  return Math.max(step, Math.ceil(spanS / (MAX_TRACK_ROWS - 1)));
}

/**
 * Requests for one view. `getHass` is read on every call, so a view can swap
 * Home Assistant's object (and tests their fakes). Answers that do not change
 * once made are kept: pass tracks by pass, focus tracks by request, the
 * catalogue by version. A request already under way is shared, not repeated.
 */
export class SatClient {
  /** @param {() => object} getHass */
  constructor(getHass) {
    this._getHass = getHass;
    this._inflight = new Map();
    this._passTracks = new Map();
    this._tracks = new Map();
    this._catalog = null;
  }

  /** Forget what belonged to a location (pass ids and tracks are per location). */
  clear() {
    this._inflight.clear();
    this._passTracks.clear();
    this._tracks.clear();
  }

  _call(msg, entryId) {
    const hass = this._getHass();
    if (!hass?.callWS) return Promise.reject(new Error("Home Assistant is not connected"));
    if (entryId) msg.entry_id = entryId;
    return hass.callWS(msg);
  }

  /** Share one request between callers asking for the same thing at once. */
  _once(key, make) {
    let p = this._inflight.get(key);
    if (!p) {
      p = make().finally(() => {
        if (this._inflight.get(key) === p) this._inflight.delete(key);
      });
      this._inflight.set(key, p);
    }
    return p;
  }

  /** The passes payload (always fresh: the integration answers from its cache). */
  passes(entryId) {
    return this._call({ type: COMMANDS.passes }, entryId);
  }

  /**
   * Rows of every satellite of a pass ({pass_id, step, sun, transits}). An old
   * id may come back under the current one; both are kept.
   */
  async passTrack(passId, { entryId, step } = {}) {
    const key = `${entryId ?? ""}|${passId}|${step ?? ""}`;
    if (this._passTracks.has(key)) return this._passTracks.get(key);
    const result = await this._once(`pt:${key}`, () => {
      const msg = { type: COMMANDS.passTrack, pass_id: passId };
      if (step) msg.step = step;
      return this._call(msg, entryId);
    });
    this._remember(this._passTracks, key, result, 24);
    if (result?.pass_id && result.pass_id !== passId) {
      this._remember(this._passTracks, `${entryId ?? ""}|${result.pass_id}|${step ?? ""}`, result, 24);
    }
    return result;
  }

  /** A satellite's track rows [t, lat, lon, alt_km, lit] from startS to endS (unix s). */
  async track(noradId, startS, endS, { step = 30, entryId } = {}) {
    const s = Math.floor(startS);
    const e = Math.ceil(endS);
    const st = trackStep(e - s, step);
    const key = `${entryId ?? ""}|${noradId}|${s}|${e}|${st}`;
    if (this._tracks.has(key)) return this._tracks.get(key);
    const result = await this._once(`tr:${key}`, () =>
      this._call({ type: COMMANDS.track, norad_id: noradId, start: iso(s), end: iso(e), step: st }, entryId)
    );
    const rows = result?.track ?? [];
    this._remember(this._tracks, key, rows, 16);
    return rows;
  }

  /** Every catalogue satellite's positions, sampled from startS (default now). */
  positions({ startS, span = 600, step = 60, entryId } = {}) {
    const msg = { type: COMMANDS.positions, span, step };
    if (Number.isFinite(startS)) msg.start = iso(Math.floor(startS));
    return this._once(`pos:${entryId ?? ""}|${msg.start ?? "now"}|${span}|${step}`, () => this._call(msg, entryId));
  }

  /** The catalogue (names, kinds, magnitudes) of a version, kept until a newer one is asked for. */
  async catalog({ version, entryId } = {}) {
    if (this._catalog && (version === undefined || this._catalog.version === version)) return this._catalog;
    const result = await this._once(`cat:${version ?? ""}`, () => this._call({ type: COMMANDS.catalog }, entryId));
    this._catalog = result;
    return result;
  }

  /** Home Assistant's map tiles token ({token}). */
  mapToken() {
    return this._once("token", () => this._call({ type: COMMANDS.mapToken }));
  }

  _remember(map, key, value, limit) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  }
}
