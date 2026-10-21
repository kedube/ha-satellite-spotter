/**
 * The time bar under a simulated pass, shared by the globe and the street
 * view: play/pause, the simulated time, the speed, a seek slider with the
 * visible part of the pass in gold, "Back to live" and the globe/street
 * switch. It drives the shared PassClock (sat-clock.js) and follows it.
 *
 * Self-contained: it brings its own CSS (scoped to .sat-tb), and builds its
 * DOM with createElement so it is unit tested in node with a tiny fake DOM.
 */

const VERSION = new URL(import.meta.url).search;
const { svgIcon } = await import(`./sat-theme.js${VERSION}`);

/** Speeds offered besides "fit" (simulated seconds per real second). */
export const SPEEDS = [1, 5, 10, 30, 60];

// The slider's resolution: a thousandth of the window (a third of a second for an ISS pass).
const STEPS = 1000;

export const TIMEBAR_CSS = `
.sat-tb { container-type: inline-size; box-sizing: border-box; color: var(--sat-ink, #f8fafc);
  background: var(--sat-glass, linear-gradient(160deg, rgba(15,23,42,.86), rgba(15,23,42,.66)));
  border: 1px solid var(--sat-edge, rgba(148,163,184,.24)); border-radius: 16px;
  box-shadow: 0 12px 32px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter: blur(10px) saturate(1.2); -webkit-backdrop-filter: blur(10px) saturate(1.2);
  font-family: var(--sat-font, var(--ha-font-family-body, Roboto, system-ui, sans-serif)); font-size: 12.5px; }
.sat-tb .tb-in { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px 12px; padding: 10px 14px 8px 10px; }
.sat-tb .tb-play { grid-row: 1; width: 38px; height: 38px; flex: none; display: grid; place-items: center; padding: 0; border-radius: 50%;
  border: 1px solid rgba(240,171,252,.55); background: rgba(240,171,252,.16); color: #fae8ff; cursor: pointer;
  -webkit-tap-highlight-color: transparent; transition: background .15s, transform .15s, border-color .15s; }
.sat-tb .tb-play:hover { background: rgba(240,171,252,.28); border-color: rgba(245,208,254,.9); }
.sat-tb .tb-play:active { transform: scale(.94); }
.sat-tb .tb-play svg { width: 20px; height: 20px; fill: currentColor; }
.sat-tb.live .tb-play { border-color: rgba(125,211,252,.55); background: rgba(56,189,248,.16); color: #e0f2fe; }
.sat-tb .tb-info { min-width: 0; display: grid; gap: 1px; line-height: 1.3; }
.sat-tb .tb-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; white-space: nowrap; overflow: hidden; }
.sat-tb .tb-tag { flex: none; font-size: 10.5px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--sat-preview, #f0abfc); }
.sat-tb.approach .tb-tag { color: #f5d0fe; }
.sat-tb.live .tb-tag { color: #4ade80; }
.sat-tb .tb-time { flex: none; font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; color: var(--sat-ink, #f8fafc); }
.sat-tb .tb-date { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--sat-ink-3, #94a3b8); }
.sat-tb .tb-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--sat-ink-2, #cbd5e1); font-weight: 600; }
.sat-tb .tb-status { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--sat-ink-2, #cbd5e1); font-variant-numeric: tabular-nums; }
.sat-tb .tb-status.on { color: var(--sat-gold, #fcd34d); font-weight: 600; }
.sat-tb .tb-label:empty, .sat-tb .tb-status:empty { display: none; }
.sat-tb .tb-label:not(:empty) + .tb-status:not(:empty)::before { content: "·"; margin-right: 8px; color: var(--sat-ink-3, #94a3b8); font-weight: 400; }
.sat-tb .tb-actions { display: flex; align-items: center; gap: 8px; }
.sat-tb .tb-speed { position: relative; display: inline-flex; }
.sat-tb .tb-speed select { appearance: none; -webkit-appearance: none; font: inherit; font-size: 12px; font-weight: 600;
  font-variant-numeric: tabular-nums; color: var(--sat-ink, #f8fafc); background: rgba(148,163,184,.14);
  border: 1px solid rgba(148,163,184,.3); border-radius: 999px; padding: 5px 24px 5px 10px; cursor: pointer; }
.sat-tb .tb-speed select:hover { background: rgba(148,163,184,.24); }
.sat-tb .tb-speed svg { position: absolute; right: 6px; top: 50%; width: 14px; height: 14px; margin-top: -7px; fill: var(--sat-ink-2, #cbd5e1); pointer-events: none; }
.sat-tb .tb-speed option { color: #0f172a; }
.sat-tb .tb-btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12.5px; font-weight: 600; color: #e0f2fe;
  background: rgba(56,189,248,.14); border: 1px solid rgba(56,189,248,.45); border-radius: 999px; padding: 5px 12px 5px 10px;
  cursor: pointer; white-space: nowrap; -webkit-tap-highlight-color: transparent; transition: background .15s, border-color .15s, transform .15s; }
.sat-tb .tb-btn:hover { background: rgba(56,189,248,.26); border-color: rgba(125,211,252,.8); }
.sat-tb .tb-btn:active { transform: scale(.97); }
.sat-tb .tb-btn svg { width: 16px; height: 16px; fill: currentColor; flex: none; }
.sat-tb .tb-btn.quiet { color: var(--sat-ink-2, #cbd5e1); background: rgba(148,163,184,.1); border-color: rgba(148,163,184,.3); }
.sat-tb .tb-btn.quiet:hover { color: var(--sat-ink, #f8fafc); background: rgba(148,163,184,.2); }
.sat-tb .tb-loop { width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border-radius: 50%; cursor: pointer;
  border: 1px solid rgba(148,163,184,.3); background: rgba(148,163,184,.1); color: var(--sat-ink-3, #94a3b8);
  -webkit-tap-highlight-color: transparent; transition: background .15s, color .15s, border-color .15s; }
.sat-tb .tb-loop:hover { color: var(--sat-ink, #f8fafc); background: rgba(148,163,184,.2); }
.sat-tb .tb-loop[aria-pressed="true"] { color: var(--sat-sky, #7dd3fc); border-color: rgba(125,211,252,.55); background: rgba(125,211,252,.12); }
.sat-tb .tb-loop svg { width: 16px; height: 16px; fill: currentColor; }
.sat-tb .tb-close { width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%;
  background: rgba(148,163,184,.16); color: var(--sat-ink, #f8fafc); cursor: pointer; }
.sat-tb .tb-close:hover { background: rgba(148,163,184,.3); }
.sat-tb .tb-close svg { width: 18px; height: 18px; fill: currentColor; }
.sat-tb .short { display: none; }
.sat-tb .tb-track { grid-column: 1 / -1; position: relative; height: 18px; margin: 0 2px; --p: 0; --vs: 0; --ve: 0; }
.sat-tb .tb-rail, .sat-tb .tb-vis, .sat-tb .tb-fill { position: absolute; top: 7px; height: 4px; border-radius: 4px; pointer-events: none; }
.sat-tb .tb-rail { left: 0; right: 0; background: rgba(148,163,184,.22); }
.sat-tb .tb-vis { left: calc(7px + (100% - 14px) * var(--vs)); width: calc((100% - 14px) * (var(--ve) - var(--vs)));
  background: rgba(252,211,77,.42); box-shadow: 0 0 10px rgba(252,211,77,.35); }
.sat-tb .tb-fill { left: 0; width: calc(7px + (100% - 14px) * var(--p)); background: linear-gradient(90deg, rgba(240,171,252,.85), var(--sat-gold, #fcd34d)); }
.sat-tb .tb-seek { position: absolute; inset: 0; width: 100%; height: 18px; margin: 0; padding: 0; background: transparent;
  appearance: none; -webkit-appearance: none; cursor: pointer; touch-action: none; }
.sat-tb .tb-seek:focus { outline: none; }
.sat-tb .tb-seek::-webkit-slider-runnable-track { height: 18px; background: transparent; border: 0; }
.sat-tb .tb-seek::-moz-range-track { height: 18px; background: transparent; border: 0; }
.sat-tb .tb-seek::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: 2px; border-radius: 50%;
  background: #fff; border: 2px solid var(--sat-gold, #fcd34d); box-shadow: 0 0 0 4px rgba(252,211,77,.16), 0 2px 6px rgba(0,0,0,.55);
  transition: transform .15s; }
.sat-tb .tb-seek::-moz-range-thumb { width: 10px; height: 10px; border-radius: 50%; background: #fff; border: 2px solid var(--sat-gold, #fcd34d);
  box-shadow: 0 0 0 4px rgba(252,211,77,.16), 0 2px 6px rgba(0,0,0,.55); }
.sat-tb .tb-seek:hover::-webkit-slider-thumb, .sat-tb .tb-seek:active::-webkit-slider-thumb { transform: scale(1.2); }
.sat-tb .tb-seek:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px var(--sat-sky, #7dd3fc), 0 2px 6px rgba(0,0,0,.55); }
.sat-tb .tb-seek:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 3px var(--sat-sky, #7dd3fc); }
.sat-tb.live .tb-track, .sat-tb.approach .tb-vis { display: none; }
.sat-tb button:focus { outline: none; }
.sat-tb :is(button, select):focus-visible { outline: 2px solid var(--sat-sky, #7dd3fc); outline-offset: 2px; }
.sat-tb [hidden] { display: none !important; }
.sat-tb .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
/* Short of room: the globe/street switch shows only its icon, leaving room for the date. */
@container (max-width: 760px) {
  .sat-tb .tb-view .long { display: none; }
  .sat-tb .tb-view { padding: 5px 7px; }
}
@container (max-width: 600px) {
  /* Phones and cards: the buttons get a row of their own, under the time
     (side by side, the time and the speed menu overlap below about 560 px). */
  .sat-tb .tb-in { grid-template-columns: auto minmax(0, 1fr); gap: 6px 10px; padding: 8px 10px 6px 8px; }
  .sat-tb .tb-actions { grid-column: 1 / -1; grid-row: 2; flex-wrap: wrap; gap: 6px; }
  .sat-tb .tb-live { margin-left: auto; }
  .sat-tb .tb-track { grid-row: 3; }
  .sat-tb .tb-date { display: none; }
  .sat-tb .long { display: none; }
  .sat-tb .short { display: inline; }
  .sat-tb .tb-btn { padding: 5px 10px; }
  .sat-tb .tb-btn.icon { padding: 5px 7px; }
}
@container (max-width: 340px) {
  .sat-tb .tb-label { display: none; }
  .sat-tb .tb-label + .tb-status::before { display: none; }
}
`;

/** A rate as "7.3" (one decimal under 10) or "44". */
export function formatRate(rate, num = (v, d) => v.toFixed(d)) {
  const r = Math.max(0, rate);
  if (r < 10 && Math.abs(r - Math.round(r)) > 0.05) return num(r, 1);
  return num(Math.round(r), 0);
}

/**
 * What the bar shows, from the clock and the pass it is about; pure, so the
 * wording and the arithmetic are tested without a DOM.
 * @param {import("./sat-clock.js").PassClock} clock
 * @param {{pass?: {start:number, end:number}|null, label?: string}} context
 */
export function timebarState(clock, context = {}) {
  const live = clock.mode === "live";
  const phase = clock.phase;
  const simS = clock.simMs / 1000;
  const w = clock.window;
  const pass = context.pass;
  let status = null;
  if (live) {
    if (pass && simS < pass.start) status = { key: "starts_in", ms: (pass.start - simS) * 1000 };
    else if (pass && simS < pass.end) status = { key: "visible_left", ms: (pass.end - simS) * 1000, on: true };
  } else if (w && phase !== "approach") {
    if (simS < w.visibleStartS) status = { key: "appears_in", ms: (w.visibleStartS - simS) * 1000 };
    else if (simS <= w.visibleEndS) status = { key: "visible_left", ms: (w.visibleEndS - simS) * 1000, on: true };
    else status = { key: "after" };
  }
  const span = w ? w.toS - w.fromS : 1;
  return {
    live,
    phase,
    simS,
    playing: clock.playing,
    ended: clock.ended,
    rate: clock.rate,
    rateSetting: clock.rateSetting,
    progress: clock.progress,
    visible: w ? [(w.visibleStartS - w.fromS) / span, (w.visibleEndS - w.fromS) / span] : [0, 0],
    status,
  };
}

/** createElement with properties, attributes ("aria-*", "data-*", "role") and children. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("aria-") || key.startsWith("data-") || key === "role") node.setAttribute(key, String(value));
    else node[key] = value;
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

const setText = (node, text) => {
  if (node.textContent !== text) node.textContent = text;
};

export class Timebar {
  /**
   * @param {HTMLElement} container the bar is appended to it; the container places it
   * @param {object} o
   * @param {import("./sat-clock.js").PassClock} o.clock shared with the views
   * @param {object} o.formatter sat-format.js Formatter
   * @param {() => void} o.onLive "Back to live"
   * @param {() => void} [o.onToggleView] globe ⇄ street view (no button without it)
   * @param {() => void} [o.onClose] a close button (none without it)
   * @param {() => void} [o.onSimulate] live, the play button replays the pass (hidden without it)
   */
  constructor(container, { clock, formatter, onLive, onToggleView, onClose, onSimulate } = {}) {
    this._container = container;
    this._clock = clock;
    this._fmt = formatter;
    this._on = { onLive, onToggleView, onClose, onSimulate };
    this._context = { pass: null, label: "", view: "globe" };
    this._dragging = false;
    this._shown = {};
    this._build();
    this._unsubscribe = clock.on("change", () => this._sync());
    this._sync();
  }

  /**
   * What the bar is about.
   * @param {{pass?: object|null, label?: string, view?: "globe"|"street"}} context
   *   pass: a pass from the passes payload (start/end in unix s), for the live countdown
   */
  setContext({ pass = this._context.pass, label = this._context.label, view = this._context.view } = {}) {
    this._context = { pass: pass || null, label: label || "", view: view === "street" ? "street" : "globe" };
    this.refresh();
  }

  /** Word everything again (after a change of language). */
  refresh() {
    this._shown = {};
    this._applyStrings();
    this._sync();
  }

  /** Cheap per-frame refresh: the time, the status and the slider. */
  update() {
    if (!this._root) return;
    const s = timebarState(this._clock, this._context);
    const e = this._els;
    const whole = Math.floor(s.simS);
    if (whole !== this._shown.second || s.live !== this._shown.live) {
      this._shown.second = whole;
      this._shown.live = s.live;
      const time = this._fmt.time(whole, { seconds: true });
      setText(e.time, time);
      setText(e.date, this._fmt.date(whole));
      const status = s.status ? this._t(`timebar.${s.status.key}`, { countdown: this._fmt.countdown(s.status.ms ?? 0) }) : "";
      setText(e.status, status);
      e.status.classList.toggle("on", !!s.status?.on);
      e.seek.setAttribute("aria-valuetext", `${time}, ${this._fmt.date(whole)}`);
    }
    if (!s.live) {
      const p = s.progress;
      if (p !== this._shown.progress) {
        this._shown.progress = p;
        e.track.style.setProperty("--p", p.toFixed(4));
        if (!this._dragging) {
          const value = String(Math.round(p * STEPS));
          if (e.seek.value !== value) e.seek.value = value;
        }
      }
    }
  }

  destroy() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._root?.remove();
    this._root = null;
  }

  _t(key, vars) {
    return this._fmt.t(key, vars);
  }

  _build() {
    const button = (cls, key, onClick, ...children) => {
      const b = el("button", { type: "button", class: cls }, ...children);
      b.dataset.icon = key;
      b.addEventListener("click", onClick);
      return b;
    };
    const span = (cls, text = "") => el("span", { class: cls, text });
    const e = {};
    e.play = button("tb-play", "play", () => this._playPressed());
    e.tag = span("tb-tag");
    e.time = span("tb-time");
    e.date = span("tb-date");
    e.label = span("tb-label");
    e.status = span("tb-status");
    e.select = el("select", { class: "tb-rate" });
    e.select.addEventListener("change", () => {
      const v = e.select.value;
      this._clock.setRate(v === "fit" ? "fit" : Number(v));
    });
    e.speedLabel = span("sr-only");
    e.speed = el("label", { class: "tb-speed" }, e.speedLabel, e.select, el("span", { html: svgIcon("chevron_down") }));
    e.viewLong = span("long");
    e.view = button("tb-btn quiet icon tb-view", "street", () => this._on.onToggleView?.(), el("span", { class: "tb-ico" }), e.viewLong);
    e.liveLong = span("long");
    e.liveShort = span("short");
    e.live = button("tb-btn tb-live", "live", () => this._on.onLive?.(), e.liveLong, e.liveShort);
    e.loop = button("tb-loop", "loop", () => this._clock.setLoop(!this._clock.loop), el("span", { html: svgIcon("loop") }));
    e.close = button("tb-close", "close", () => this._on.onClose?.(), el("span", { html: svgIcon("close") }));
    e.seek = el("input", { class: "tb-seek", type: "range", min: "0", max: String(STEPS), step: "1", value: "0" });
    e.seek.addEventListener("input", () => this._seekTo(Number(e.seek.value)));
    e.seek.addEventListener("pointerdown", () => (this._dragging = true));
    for (const type of ["pointerup", "pointercancel", "change", "blur"]) e.seek.addEventListener(type, () => (this._dragging = false));
    e.seek.addEventListener("keydown", (ev) => {
      // Space plays and pauses, as in a video player.
      if (ev.key !== " " || ev.repeat) return;
      ev.preventDefault();
      this._playPressed();
    });
    e.rail = span("tb-rail");
    e.vis = span("tb-vis");
    e.fill = span("tb-fill");
    e.track = el("div", { class: "tb-track" }, e.rail, e.vis, e.fill, e.seek);
    e.actions = el("div", { class: "tb-actions" }, e.speed, e.loop, e.view, e.live, e.close);
    e.info = el(
      "div",
      { class: "tb-info" },
      el("div", { class: "tb-line" }, e.tag, e.time, e.date),
      el("div", { class: "tb-line" }, e.label, e.status)
    );
    e.inner = el("div", { class: "tb-in" }, e.play, e.info, e.actions, e.track);
    this._root = el("div", { class: "sat-tb", role: "group" }, el("style", { text: TIMEBAR_CSS }), e.inner);
    this._els = e;
    this._applyStrings();
    this._container.appendChild(this._root);
  }

  _applyStrings() {
    const e = this._els;
    const street = this._context.view !== "street";
    // The switch names where it goes.
    e.view.querySelector(".tb-ico").innerHTML = svgIcon(street ? "street" : "globe");
    setText(e.viewLong, this._t(street ? "timebar.street" : "timebar.globe"));
    e.view.title = this._t(street ? "timebar.street_hint" : "timebar.globe_hint");
    e.view.setAttribute("aria-label", this._t(street ? "timebar.street" : "timebar.globe"));
    e.view.hidden = !this._on.onToggleView;
    setText(e.liveLong, this._t("timebar.live"));
    setText(e.liveShort, this._t("timebar.live_short"));
    e.live.setAttribute("aria-label", this._t("timebar.live"));
    e.close.setAttribute("aria-label", this._t("timebar.close"));
    e.close.title = this._t("timebar.close");
    e.close.hidden = !this._on.onClose;
    setText(e.speedLabel, this._t("timebar.speed_label"));
    e.loop.setAttribute("aria-label", this._t("timebar.loop"));
    e.loop.title = this._t("timebar.loop");
    e.select.setAttribute("aria-label", this._t("timebar.speed_label"));
    e.seek.setAttribute("aria-label", this._t("timebar.seek"));
    this._root.setAttribute("aria-label", this._t("timebar.name"));
    this._speedOptions = null;
  }

  /** Follow the clock's mode, play state and speed (on its change events). */
  _sync() {
    if (!this._root) return;
    const s = timebarState(this._clock, this._context);
    const e = this._els;
    const root = this._root;
    root.classList.toggle("live", s.live);
    root.classList.toggle("approach", s.phase === "approach");
    setText(e.tag, this._t(s.live ? "timebar.live_tag" : s.phase === "approach" ? "timebar.fast_forward" : "timebar.simulation"));
    setText(e.label, this._context.label);
    // Live there is nothing to pause; the button replays the pass, if the host can.
    const replay = s.live || s.ended;
    const icon = replay ? (s.live ? "play" : "replay") : s.playing ? "pause" : "play";
    if (e.play.dataset.icon !== icon || !e.play.innerHTML) {
      e.play.dataset.icon = icon;
      e.play.innerHTML = svgIcon(icon);
    }
    const playLabel = s.live ? "timebar.replay" : s.ended ? "timebar.again" : s.playing ? "timebar.pause" : "timebar.play";
    e.play.setAttribute("aria-label", this._t(playLabel));
    e.play.title = this._t(playLabel);
    e.play.hidden = s.live && !this._on.onSimulate;
    e.live.hidden = s.live;
    e.speed.hidden = s.live;
    // Replays start over at the end unless this is off.
    e.loop.hidden = s.live;
    e.loop.setAttribute("aria-pressed", String(this._clock.loop));
    this._renderSpeeds(s);
    e.track.style.setProperty("--vs", s.visible[0].toFixed(4));
    e.track.style.setProperty("--ve", s.visible[1].toFixed(4));
    this._shown.second = this._shown.progress = undefined;
    this.update();
  }

  _renderSpeeds(s) {
    const select = this._els.select;
    const setting = s.rateSetting;
    const values = ["fit", ...SPEEDS];
    if (typeof setting === "number" && !SPEEDS.includes(setting)) values.push(setting);
    const fit = s.live ? 1 : this._clock.rate;
    const fitRate = setting === "fit" ? fit : null;
    const key = `${values.join(",")}|${fitRate ?? ""}|${setting}`;
    if (key !== this._speedOptions) {
      this._speedOptions = key;
      const num = (v, d) => this._fmt.num(v, d);
      select.replaceChildren(
        ...values.map((v) => {
          const text =
            v === "fit"
              ? this._t("timebar.speed_fit", { rate: fitRate === null ? "…" : formatRate(fitRate, num) })
              : this._t("timebar.speed", { rate: formatRate(v, num) });
          return el("option", { value: String(v), text });
        })
      );
    }
    select.value = String(setting);
  }

  _playPressed() {
    const clock = this._clock;
    if (clock.mode === "live") this._on.onSimulate?.();
    else clock.toggle();
  }

  _seekTo(step) {
    const w = this._clock.window;
    if (!w || !Number.isFinite(step)) return;
    this._clock.seek(w.fromS + (step / STEPS) * (w.toS - w.fromS));
  }
}
