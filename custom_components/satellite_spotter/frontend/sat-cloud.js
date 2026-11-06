/**
 * The globe's cloud of every satellite in the catalogue: asking for where they are, backing off when
 * that fails, handing the layer what it draws and moving it along. Its life is three calls:
 *
 *   attach(layer)   a new layer, after a rebuild: it gets what is known at once
 *   detach()        the layer is gone, and nothing is lost with it
 *   reset()         another location: nothing is kept, not even a request on its way
 *
 * No DOM. What it needs of the page comes in as functions.
 */

const VERSION = new URL(import.meta.url).search;
const [{ interpolatePositions }, client] = await Promise.all([import(`./sat-geo.js${VERSION}`), import(`./sat-client.js${VERSION}`)]);

/** How long positions last before they are asked for again (ms). */
export const CLOUD_MS = 5 * 60000;
const RETRY_MIN_MS = 30000;
// Frames that only keep a ring breathing need the satellites no fresher than this (s).
const MOVE_AT_LEAST_S = 0.5;

const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

export class SatelliteCloud {
  /**
   * @param {object} o
   * @param {() => boolean} o.canAsk whether it is wanted, and Home Assistant can be asked
   * @param {() => {key: string, want: object}} o.request which positions are wanted now
   * @param {(want: object) => Promise<object>} o.fetchPositions
   * @param {(version: number) => Promise<object>} o.fetchCatalog
   * @param {() => number} o.nowS
   * @param {(catalog: object, ids: number[]) => object} o.cloudOf what the layer draws of a catalogue
   * @param {(positions: Float32Array, out: Float32Array) => Float32Array} o.toLayer positions as the layer takes them
   * @param {() => void} o.onLoaded new positions are in
   * @param {(fn: () => void) => void} o.whenShown run this once the globe is on show
   * @param {(err: unknown) => string} [o.describe]
   */
  constructor(o) {
    this._o = o;
    this._layer = null;
    this.reset();
  }

  /** Another location: nothing is kept, and answers on their way are not listened to. */
  reset() {
    this._generation = (this._generation ?? 0) + 1;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    /** The latest positions payload. */
    this.positions = null;
    this.positionsAt = 0;
    this._for = null;
    this._loading = null;
    this._failed = null;
    this._retryAt = 0;
    this._delay = 0;
    this._ids = null;
    this._version = null;
    this._drawn = null;
    /** Satellites by NORAD id; the catalogue itself stays through a reset only in the client's cache. */
    this.byId = null;
    this._index = null;
    this._bits = null;
    this._ll = null;
    this._xy = null;
    this._movedTo = null;
  }

  /** A new layer, after the map was rebuilt: what is known goes to it at once, with nothing to ask for. */
  attach(layer) {
    this._layer = layer;
    if (this._drawn) layer.setCloud?.(this._drawn);
    this._xy = null;
    this._movedTo = null;
    // Its flags start clear, and the next look at them hands it what they are.
    this._bits?.fill(0);
  }

  /** The layer is gone with its map. */
  detach() {
    this._layer = null;
    this.stopRetrying();
  }

  /** The globe is away: what it needs is looked at again when it is back. */
  stopRetrying() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
  }

  /** Stop waiting after failures: the connection is back. */
  retrySoon() {
    this._failed = null;
    this._retryAt = 0;
    this._delay = 0;
  }

  /** Whether there is something to show. */
  get ready() {
    return !!this.positions && !!this._index;
  }

  /** Ask for positions if the ones there are will not do. */
  async load(force = false) {
    const o = this._o;
    if (!o.canAsk()) return;
    const { key, want } = o.request();
    const have = this.positions;
    const nowS = o.nowS();
    const end = have ? have.start + (have.count - 1) * have.step : -Infinity;
    const fresh = !!have && this._for === key && (key !== "live" || (performance.now() - this.positionsAt < CLOUD_MS - 1000 && end >= nowS + 60));
    if ((fresh && !force) || this._loading === key) return;
    // After a failure, frames that find the positions run out wait for the retry.
    if (!force && this._failed === key && performance.now() < this._retryAt) return;
    this._loading = key;
    clearTimeout(this._retryTimer);
    const generation = this._generation;
    // Another location, or another moment: a simulation that started or ended
    // meanwhile has asked for its own, and these would hide the cloud.
    const unwanted = () => generation !== this._generation || o.request().key !== key;
    try {
      const positions = await o.fetchPositions(want);
      if (unwanted()) return;
      // The satellites first: positions in a new order need the catalogue's order too.
      await this._ensureCatalog(positions);
      if (unwanted()) return;
      this.positions = positions;
      this.positionsAt = performance.now();
      this._for = key;
      this._delay = 0;
      this._failed = null;
      this._movedTo = null;
      o.onLoaded();
    } catch (err) {
      if (unwanted()) return;
      // Try again later, backing off; the satellites that are shown stay.
      this._failed = key;
      this._delay = client.nextDelay(this._delay, RETRY_MIN_MS, CLOUD_MS);
      this._retryAt = performance.now() + this._delay;
      this._retryTimer = setTimeout(() => o.whenShown(() => this.load()), this._delay);
      console.debug("Satellite Spotter: positions:", o.describe?.(err) ?? err);
    } finally {
      if (this._loading === key) this._loading = null;
    }
  }

  /** The satellites' kinds and magnitudes, when the list of them changes in any way. */
  async _ensureCatalog(positions) {
    const ids = positions.ids || [];
    if (this._version === positions.catalog_version && this._ids && sameIds(this._ids, ids)) return;
    const catalog = await this._o.fetchCatalog(positions.catalog_version);
    this.byId = new Map((catalog?.satellites || []).map((s) => [s.norad_id, s]));
    this._index = new Map(ids.map((id, i) => [id, i]));
    this._bits = new Uint8Array(ids.length);
    this._ll = this._xy = null;
    this._drawn = this._o.cloudOf(catalog, ids);
    this._layer?.setCloud?.(this._drawn);
    this._ids = ids;
    this._version = positions.catalog_version;
  }

  /**
   * Move the cloud to time t (each frame). `hidden`: not to be seen now. `slow`: nothing moves fast
   * enough to notice, so it need not be worked out every frame. Returns whether t is covered.
   */
  moveTo(t, { wanted = true, hidden = false, slow = false } = {}) {
    const layer = this._layer;
    const pos = this.positions;
    if (!layer?.setCloudPositions) return true;
    if (!wanted || !pos || !this._index) {
      layer.setCloudPositions(null, { visible: false });
      return true;
    }
    const end = pos.start + (pos.count - 1) * pos.step;
    const covered = t >= pos.start - 30 && t <= end + 30;
    const visible = covered && !hidden;
    if (visible && !(slow && this._xy && Math.abs(t - this._movedTo) < MOVE_AT_LEAST_S)) {
      this._ll = interpolatePositions(pos, t, this._ll);
      this._xy = this._o.toLayer(this._ll, this._xy);
      this._movedTo = t;
    }
    layer.setCloudPositions(visible ? this._xy : null, { visible });
    return covered;
  }

  /**
   * Mark satellites: `marks(set)` calls set(id, bit) for each. The layer hears of it only if anything
   * changed; returns whether it did.
   */
  setFlags(marks) {
    const bits = this._bits;
    if (!this._index || !bits || !this._layer?.setCloudFlags) return false;
    const before = Uint8Array.from(bits);
    bits.fill(0);
    marks((id, bit) => {
      const i = this._index.get(id);
      if (i !== undefined) bits[i] |= bit;
    });
    if (!bits.some((b, i) => b !== before[i])) return false;
    this._layer.setCloudFlags(bits);
    return true;
  }

  /** Which satellite is under a point on the globe. */
  pick(x, y, width, height, radius) {
    const i = this._layer?.pick?.(x, y, width, height, radius) ?? -1;
    return i >= 0 ? this.positions?.ids?.[i] ?? null : null;
  }

  /** How high a satellite is now (km), if the cloud knows. */
  altitudeOf(noradId) {
    const i = this._index?.get(noradId);
    return i !== undefined && this._ll ? this._ll[i * 4 + 2] : null;
  }
}
