/**
 * What the street view's scene is up to, all in one place: which start is the current one, what is
 * still loading, what is showing, and what happens when a scene's WebGL context goes. No DOM, so it
 * can be tested alone.
 *
 * A start can be overtaken at any of its many awaits (a new place, another layer, a lost context),
 * so each is handed a token to ask whether it is still the current one. A scene that is not the
 * one showing, or the one loading, has no say: taking a scene away gives up its context, which looks
 * like any other loss to whoever hears of it.
 */

export class SceneLife {
  /**
   * @param {object} o
   * @param {(fn: () => void, ms: number) => unknown} o.later a timer the host cancels when it goes
   * @param {(id: unknown) => void} [o.cancel]
   * @param {number} o.restoreMs how long a lost context has to come back
   * @param {() => void} o.onStillLost it did not: time for another start
   */
  constructor({ later, cancel = clearTimeout, restoreMs, onStillLost }) {
    this._later = later;
    this._cancel = cancel;
    this._restoreMs = restoreMs;
    this._onStillLost = onStillLost;
    this._generation = 0;
    this._controller = null;
    this._lostTimer = null;
    /** The scene showing. */
    this.scene = null;
    /** The scene loading, which is not showing yet. */
    this.pending = null;
    /** "photo", "3d" or "2d" once something shows. */
    this.mode = null;
    /** Whether the 3D map has gone quiet since it started. */
    this.settled = false;
    /** The latest start, also when nothing else knows it. */
    this.current = null;
  }

  /** Whatever is going on is over: free it all, and let no late answer touch what comes next. */
  clear() {
    this._generation++;
    this._stopWaiting();
    this._controller?.abort();
    this._controller = null;
    const { scene, pending } = this;
    // Before they go, as a scene giving up its context is then no one's to restart for.
    this.scene = null;
    this.pending = null;
    this.mode = null;
    this.settled = false;
    scene?.remove();
    pending?.remove();
  }

  /** Begin again: how the start tells whether it still is the current one, and its downloads' signal. */
  start() {
    this.clear();
    const generation = this._generation;
    this._controller = globalThis.AbortController ? new AbortController() : null;
    this.current = { isCurrent: () => generation === this._generation, signal: this._controller?.signal };
    return this.current;
  }

  /** A scene is loading: a new start frees it, and its downloads. */
  loading(scene) {
    this.pending = scene;
  }

  /** It loaded, or it was made ready at once: this is what shows. */
  show(scene, mode) {
    if (this.pending === scene) this.pending = null;
    this.scene = scene;
    this.mode = mode;
  }

  /** Nothing to show but the sky, which needs no scene. */
  showSky() {
    this.mode = "2d";
  }

  /** A scene will not do after all (idempotent, as a scene may already have been freed). */
  discard(scene) {
    if (this.pending === scene) this.pending = null;
    if (this.scene === scene) {
      this.scene = null;
      this._stopWaiting();
    }
    scene.remove();
  }

  /** A scene's WebGL context went: true if that means anything, and then it has a while to come back. */
  lost(scene) {
    if (!this._isOurs(scene)) return false;
    this._stopWaiting();
    this._lostTimer = this._later(() => {
      this._lostTimer = null;
      this._onStillLost();
    }, this._restoreMs);
    return true;
  }

  /** A scene's WebGL context came back in time: true if that means anything. */
  restored(scene) {
    if (!this._isOurs(scene)) return false;
    this._stopWaiting();
    return true;
  }

  _isOurs(scene) {
    return !!scene && (scene === this.scene || scene === this.pending);
  }

  _stopWaiting() {
    if (this._lostTimer !== null) this._cancel(this._lostTimer);
    this._lostTimer = null;
  }
}
