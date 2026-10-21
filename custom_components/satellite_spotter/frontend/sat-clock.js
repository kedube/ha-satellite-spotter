/**
 * The clock the globe, the street view and the time bar share.
 *
 * Live, it is Home Assistant's time. Simulating, it replays a pass the way
 * James Darpinian's See A Satellite Tonight does: the visible part in about
 * 20 seconds, looping, with a seek bar; optionally after an eased
 * fast-forward from now to the pass. Nothing here touches the DOM, so it is
 * unit tested in node.
 */

// The visible part of a pass replays in about this many seconds (James's pace)…
const FIT_SECONDS = 20;
// …but the whole loop, lead-in and tail included, takes no longer than this.
const MAX_LOOP_SECONDS = 45;
// A beat at the end before the replay starts over, so the end registers.
export const HOLD_MS = 1200;
// The most real time one tick may cover: a page that stalled (a hidden tab, a
// long frame) carries on where it was rather than minutes later.
export const MAX_STEP_MS = 500;
// The fast-forward to a pass: about 1.5 s per orbit on the way, 3 to 9 s in all.
const APPROACH_MS_PER_ORBIT = 1500;
const APPROACH_MIN_MS = 3000;
const APPROACH_MAX_MS = 9000;
const DEFAULT_PERIOD_S = 5574; // the ISS's, when the caller does not say
// A replay shows this much before and after the visible part of a pass, and a
// pass this near, or going on, is watched live instead (the globe, the street
// view and the passes card all decide the same way).
export const PASS_LEAD_S = 120;
export const PASS_TAIL_S = 60;

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Whether a pass is near enough, or going on, to watch live rather than as a replay. */
export function passIsLive(pass, nowS) {
  return pass.start - PASS_LEAD_S <= nowS && nowS < pass.end;
}

/**
 * Simulated seconds per real second for "fit": the visible window in about
 * 20 s, but never so slow that the whole window takes over 45 s, nor slower
 * than real time.
 * @param {{fromS:number, toS:number, visibleStartS:number, visibleEndS:number}} w
 */
export function fitRate(w) {
  if (!w) return 1;
  const visible = Math.max(0, w.visibleEndS - w.visibleStartS);
  const whole = Math.max(0, w.toS - w.fromS);
  return Math.max(1, visible / FIT_SECONDS, whole / MAX_LOOP_SECONDS);
}

/** How long the eased fast-forward over `seconds` of orbit takes, in ms. */
export function approachMs(seconds, periodS = DEFAULT_PERIOD_S) {
  const orbits = Math.max(0, seconds) / (periodS > 0 ? periodS : DEFAULT_PERIOD_S);
  return clamp(orbits * APPROACH_MS_PER_ORBIT, APPROACH_MIN_MS, APPROACH_MAX_MS);
}

export class PassClock {
  /** @param {{now?: () => number}} [options] now: real unix ms (Home Assistant's, clock offset applied) */
  constructor({ now = () => Date.now() } = {}) {
    this._nowFn = now;
    this._mode = "live";
    this._listeners = new Set();
    this._playing = true;
    this._rateSetting = "fit";
    this._window = null;
    this._loop = true;
    this._simMs = 0;
    // performance.now() of the last tick; null when the next tick only sets the baseline.
    this._lastReal = null;
    this._approach = null;
    this._holdUntil = null;
  }

  /** "live" (real time) or "sim" (replaying a pass). */
  get mode() {
    return this._mode;
  }

  /** The simulated moment in unix ms; live, Home Assistant's now. */
  get simMs() {
    return this._mode === "live" ? this._nowFn() : this._simMs;
  }

  /** The simulated moment in unix seconds. */
  get simS() {
    return this.simMs / 1000;
  }

  /** Whether time moves (always, live). */
  get playing() {
    return this._mode === "live" || this._playing || !!this._approach;
  }

  /** Simulated seconds per real second now ("fit" resolved; 1 live). */
  get rate() {
    if (this._mode === "live") return 1;
    return this._rateSetting === "fit" ? fitRate(this._window) : this._rateSetting;
  }

  /** The rate as chosen: "fit" or a number. */
  get rateSetting() {
    return this._rateSetting;
  }

  /** The replayed window {fromS, toS, visibleStartS, visibleEndS}; null live. */
  get window() {
    return this._mode === "live" ? null : this._window;
  }

  /** Whether a replay starts over at the end. */
  get loop() {
    return this._loop;
  }

  /** "live", "approach" (the fast-forward to the pass) or "replay". */
  get phase() {
    if (this._mode === "live") return "live";
    return this._approach ? "approach" : "replay";
  }

  /** How far through the window, 0..1 (0 during the approach). */
  get progress() {
    const w = this.window;
    if (!w || this._approach) return 0;
    return clamp((this._simMs / 1000 - w.fromS) / (w.toS - w.fromS), 0, 1);
  }

  /** Whether the replay stopped at the end of the window (loop off). */
  get ended() {
    return this._mode === "sim" && !this._playing && !this._approach && this._simMs >= this._window.toS * 1000;
  }

  /** Back to real time. */
  live() {
    if (this._mode === "live") return;
    this._mode = "live";
    this._window = null;
    this._approach = null;
    this._holdUntil = null;
    this._lastReal = null;
    this._emit("live");
  }

  /**
   * Replay a pass.
   * @param {object} o
   * @param {number} o.fromS start of the window (unix s), e.g. the pass start − 120 s
   * @param {number} o.toS end of the window, e.g. the pass end + 60 s
   * @param {number} [o.visibleStartS] the visible part, highlighted and used for "fit"
   * @param {number} [o.visibleEndS]
   * @param {number} [o.startS] where to start (default fromS)
   * @param {"fit"|number} [o.rate]
   * @param {boolean} [o.loop]
   * @param {boolean} [o.playing]
   * @param {number|null} [o.approachFromS] fast-forward from this moment (now) to startS first
   * @param {number} [o.periodS] orbital period, which paces the fast-forward
   */
  simulate({
    fromS, toS, visibleStartS = fromS, visibleEndS = toS, startS = fromS, rate = "fit", loop = true,
    playing = true, approachFromS = null, periodS = DEFAULT_PERIOD_S,
  }) {
    if (!Number.isFinite(fromS) || !Number.isFinite(toS) || !(toS > fromS)) {
      throw new RangeError(`PassClock: bad window ${fromS}..${toS}`);
    }
    const vs = Number.isFinite(visibleStartS) ? clamp(visibleStartS, fromS, toS) : fromS;
    const ve = Number.isFinite(visibleEndS) ? clamp(visibleEndS, vs, toS) : toS;
    const start = clamp(Number.isFinite(startS) ? startS : fromS, fromS, toS);
    this._mode = "sim";
    this._window = Object.freeze({ fromS, toS, visibleStartS: vs, visibleEndS: ve });
    this._loop = !!loop;
    this._playing = !!playing;
    if (this._validRate(rate)) this._rateSetting = rate;
    this._holdUntil = null;
    this._lastReal = null;
    this._approach = null;
    if (playing && Number.isFinite(approachFromS) && approachFromS < start - 1) {
      this._approach = { fromS: approachFromS, toS: start, durationMs: approachMs(start - approachFromS, periodS), began: null };
      this._simMs = approachFromS * 1000;
    } else {
      this._simMs = start * 1000;
    }
    this._emit("simulate");
  }

  play() {
    if (this._mode !== "sim" || this._playing) return;
    // From the end of a replay that does not loop, play starts it again.
    if (this._simMs >= this._window.toS * 1000) this._simMs = this._window.fromS * 1000;
    this._playing = true;
    this._holdUntil = null;
    this._lastReal = null;
    this._emit("play");
  }

  pause() {
    if (this._mode !== "sim" || (!this._playing && !this._approach)) return;
    // Paused on the way, the replay waits at its start.
    if (this._approach) {
      this._simMs = this._approach.toS * 1000;
      this._approach = null;
    }
    this._playing = false;
    this._holdUntil = null;
    this._emit("pause");
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Jump to a moment within the window (unix s); ignored live. */
  seek(simS) {
    if (this._mode !== "sim" || !Number.isFinite(simS)) return;
    this._approach = null;
    this._holdUntil = null;
    this._lastReal = null;
    this._simMs = clamp(simS, this._window.fromS, this._window.toS) * 1000;
    this._emit("seek");
  }

  /** @param {"fit"|number} rate simulated seconds per real second */
  setRate(rate) {
    if (!this._validRate(rate) || rate === this._rateSetting) return;
    this._rateSetting = rate;
    this._emit("rate");
  }

  setLoop(loop) {
    if (!!loop === this._loop) return;
    this._loop = !!loop;
    this._emit("loop");
  }

  /**
   * Move simulated time on to this real moment and return it (unix ms). Any
   * number of views may tick the same clock in a frame: each covers only the
   * real time since the last tick.
   * @param {number} [realMs] performance.now()
   */
  tick(realMs = performance.now()) {
    if (this._mode === "live") return this._nowFn();
    const last = this._lastReal;
    this._lastReal = realMs;
    const a = this._approach;
    if (a) {
      a.began ??= realMs;
      const f = Math.min(1, Math.max(0, realMs - a.began) / a.durationMs);
      this._simMs = (a.fromS + (a.toS - a.fromS) * ease(f)) * 1000;
      if (f >= 1) {
        this._approach = null;
        this._emit("phase");
      }
      return this._simMs;
    }
    if (!this._playing || last === null) return this._simMs;
    if (this._holdUntil !== null) {
      if (realMs < this._holdUntil) return this._simMs;
      this._holdUntil = null;
      this._simMs = this._window.fromS * 1000;
      this._emit("loop");
      return this._simMs;
    }
    const step = Math.min(MAX_STEP_MS, Math.max(0, realMs - last));
    this._simMs += step * this.rate;
    const end = this._window.toS * 1000;
    if (this._simMs >= end) {
      this._simMs = end;
      if (this._loop) {
        this._holdUntil = realMs + HOLD_MS;
      } else {
        this._playing = false;
        this._emit("end");
      }
    }
    return this._simMs;
  }

  /**
   * Listen for changes of mode, play state, rate, window or position (not for
   * time simply moving on: read simMs each frame for that).
   * @param {"change"} type
   * @param {(event: {type: string, reason: string, clock: PassClock}) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(type, fn) {
    if (type !== "change" || typeof fn !== "function") return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _validRate(rate) {
    return rate === "fit" || (typeof rate === "number" && Number.isFinite(rate) && rate > 0);
  }

  _emit(reason) {
    for (const fn of [...this._listeners]) {
      try {
        fn({ type: "change", reason, clock: this });
      } catch (err) {
        // One broken view must not stop the others from following the clock.
        console.error("Satellite Spotter: a clock listener failed:", err);
      }
    }
  }
}
