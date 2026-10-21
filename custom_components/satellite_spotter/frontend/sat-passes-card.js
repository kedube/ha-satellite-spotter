/**
 * The passes card's own code, loaded by sat-card.js the first time a passes
 * card is shown: a countdown to the next pass (or, while one is up, where to
 * look right now) with a small sky chart, then the passes after it.
 *
 * No WebGL, so it is quick on wall tablets. A tap opens the pass in the
 * sidebar panel; without the panel, the street view opens over the card.
 * Predictions come from the integration (satellite_spotter/passes), every
 * five minutes and just after a pass ends; the countdown ticks only while
 * the page is visible.
 */

const VERSION = new URL(import.meta.url).search;
// Modules are kept as namespaces and read when used: see sat-format.js.
const [theme, client, passesModule, formatModule, sky, i18n] = await Promise.all([
  import(`./sat-theme.js${VERSION}`),
  import(`./sat-client.js${VERSION}`),
  import(`./sat-passes.js${VERSION}`),
  import(`./sat-format.js${VERSION}`),
  import(`./sat-sky.js${VERSION}`),
  import(`./sat-i18n.js${VERSION}`),
]);

const PANEL = "satellite-spotter";
const PANEL_ELEMENT = "satellite-spotter-panel";
const STREET_STORE = "satellite-spotter:street";
export const REFRESH_MS = 5 * 60000;
// After an error: try again in 10 s, then doubling, up to the refresh interval.
const RETRY_MIN_MS = 10000;
// Refresh this long after a pass ends, so the integration has moved on too.
const AFTER_END_MS = 2000;
// The pass track for the sky chart and the live look angles: one row every 10 s is plenty.
const CHART_STEP_S = 10;
const DETAIL_RETRY_MS = 60000;
// Dashboards take cards off the page and put them straight back (a masonry
// view re-columns when a phone turns or the window widens): an open street
// view waits this long for the card before it closes.
const OVERLAY_GRACE_MS = 1000;
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Countdowns round up, so they reach 00:00 as the pass starts (or ends), not a second before.
const wholeSeconds = (s) => Math.ceil(s - 1e-6) * 1000;

/**
 * Whether Home Assistant shows a dark theme. Its frontend sometimes leaves
 * themes.darkMode unset after the first load: then the theme the user picked
 * decides, and "auto" follows the system, as Home Assistant itself does.
 */
export function darkTheme(hass, media = globalThis.matchMedia) {
  const chosen = hass?.themes?.darkMode ?? hass?.selectedTheme?.dark;
  if (typeof chosen === "boolean") return chosen;
  return media?.("(prefers-color-scheme: dark)")?.matches ?? true;
}

/** The street view's options as it keeps them (only it writes them), to hand back to it. */
function loadStreetOptions() {
  try {
    const options = JSON.parse(localStorage.getItem(STREET_STORE));
    return options && typeof options === "object" ? options : undefined;
  } catch {
    return undefined;
  }
}

/** Where a pass_track transit is at a time: azimuth and elevation, interpolated; null outside its rows. */
export function lookAt(rows, tS) {
  if (!rows?.length || !(tS >= rows[0][0]) || tS > rows[rows.length - 1][0]) return null;
  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= tS) lo = mid;
    else hi = mid;
  }
  const a = rows[lo];
  const b = rows[hi];
  const f = b[0] > a[0] ? (tS - a[0]) / (b[0] - a[0]) : 0;
  // The short way round through north.
  const turn = ((((b[5] - a[5]) % 360) + 540) % 360) - 180;
  return { azimuth: (((a[5] + turn * f) % 360) + 360) % 360, elevation: a[6] + (b[6] - a[6]) * f };
}

/** The 16-point compass point of an azimuth, as the integration names it ("SSW"). */
export const compassPoint = (azimuth) => COMPASS[Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16];

/** The address that opens a pass in the panel: /satellite-spotter?entry_id=…&pass=…&view=… */
export function panelLink(passId, { view = null, entryId = null } = {}) {
  const q = new URLSearchParams();
  if (entryId) q.set("entry_id", entryId);
  if (passId) q.set("pass", passId);
  if (passId && view) q.set("view", view);
  const query = q.toString();
  return `/${PANEL}${query ? `?${query}` : ""}`;
}

/** Whether Home Assistant has the integration's sidebar panel (not a dashboard at the same address). */
export function hasPanel(hass) {
  const panel = hass?.panels?.[PANEL];
  return !!panel && (panel.config?._panel_custom?.name === PANEL_ELEMENT || panel.component_name === "custom");
}

/** Go to an address inside Home Assistant, as its own links do. */
function navigate(path) {
  history.pushState(null, "", path);
  window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
}

const CSS = `
:host { display: block; position: relative;
  font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif); color: var(--primary-text-color, #f8fafc);
  /* The list follows the dashboard's theme. */
  --sat-ink: var(--primary-text-color, #f8fafc);
  --sat-ink-2: var(--secondary-text-color, #cbd5e1);
  --sat-ink-3: color-mix(in srgb, var(--secondary-text-color, #94a3b8) 80%, transparent);
  --sat-pl-head: transparent; --sat-pl-hover: rgba(127,127,127,.08); --sat-pl-selected: rgba(125,211,252,.1);
  --sat-pl-chip: rgba(127,127,127,.1); --sat-pl-chip-edge: rgba(127,127,127,.3); }
:host([light]) {
  --sat-gold-ink: #b45309; --sat-sky-ink: #0369a1; --sat-warn: #c2410c;
  --sat-cloud-clear: #15803d; --sat-cloud-partly: #a16207; --sat-cloud-cloudy: #be123c;
  --sat-kind-station: #b45309; --sat-kind-satellite: #475569; --sat-kind-starlink: #0369a1; --sat-kind-rocket: #c2410c;
  --sat-kind-debris: #64748b; --sat-kind-telescope: #6d28d9; --sat-pl-meter-off: rgba(100,116,139,.3);
  --sat-pl-btn-ink: #075985; --sat-pl-sim-ink: #86198f; --sat-pl-live: rgba(252,211,77,.18);
  --sat-pl-meter-on: linear-gradient(180deg, #fbbf24, #d97706); }
[hidden] { display: none !important; }
/* The card's width decides its layout; the overlay stays outside (layout containment would hold it in). */
.card { container-type: inline-size; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
button { font: inherit; }
button:focus { outline: none; }
button:focus-visible { outline: 2px solid var(--sat-sky, #7dd3fc); outline-offset: 2px; }
svg { fill: currentColor; }

/* The night sky: dark in every theme. */
.hero { position: relative; display: block; padding: 14px 16px 16px; color: #f8fafc; overflow: hidden; isolation: isolate;
  background: radial-gradient(ellipse 120% 90% at 18% 0%, #16295a 0%, #0a1430 46%, #050a18 78%, #02040b 100%);
  --sat-ink: #f8fafc; --sat-ink-2: #cbd5e1; --sat-ink-3: #94a3b8; --sat-gold: #fcd34d; --sat-sky: #7dd3fc;
  --sat-gold-ink: #fcd34d; --sat-sky-ink: #7dd3fc; --sat-warn: #fdba74;
  --sat-kind-station: #fcd34d; --sat-kind-satellite: #e0f2fe; --sat-kind-starlink: #7dd3fc; --sat-kind-rocket: #fb923c;
  --sat-kind-debris: #94a3b8; --sat-kind-telescope: #c4b5fd;
  --sat-cloud-clear: #86efac; --sat-cloud-partly: #fde68a; --sat-cloud-cloudy: #fda4af; }
.hero::before { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; background-image: var(--stars, none); opacity: .7; }
.hero::after { content: ""; position: absolute; inset: auto -20% -60% -20%; height: 70%; z-index: -1; pointer-events: none;
  background: radial-gradient(ellipse at 50% 100%, rgba(56,189,248,.16), transparent 70%); }
.hero.live { box-shadow: inset 0 0 0 1px rgba(252,211,77,.55), inset 0 0 36px rgba(252,211,77,.14); }
.hero.live::after { background: radial-gradient(ellipse at 50% 100%, rgba(252,211,77,.22), transparent 70%); }
.main { display: block; width: 100%; min-width: 0; padding: 0; margin: 0; border: 0; background: none; color: inherit;
  text-align: left; cursor: pointer; border-radius: 10px; -webkit-tap-highlight-color: transparent; }
.main::after { content: ""; display: block; clear: both; }
.main[disabled] { cursor: default; }
.state { display: flex; align-items: center; gap: 8px; min-height: 18px; font-size: 11px; font-weight: 600; letter-spacing: .14em;
  text-transform: uppercase; color: #7dd3fc; }
.state .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.18); }
.hero.live .state { color: #fcd34d; }
.hero.live .state .dot { background: #fcd34d; box-shadow: 0 0 0 3px rgba(252,211,77,.22); }
.hero.quiet .state { color: #94a3b8; }
.hero.quiet .state .dot { background: #94a3b8; box-shadow: none; }
.chip { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px 2px 6px; border-radius: 999px;
  font-size: 10px; letter-spacing: .08em; color: #fcd34d; background: rgba(252,211,77,.12); border: 1px solid rgba(252,211,77,.55); }
.chip svg { width: 11px; height: 11px; }
.clock { display: block; margin-top: 4px; font-size: 36px; font-weight: 650; line-height: 1.1; letter-spacing: -.02em; font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hero.live .clock { font-size: 26px; letter-spacing: -.01em; color: #fcd34d; }
.hero.quiet .clock { font-size: 22px; letter-spacing: 0; font-weight: 600; color: #e2e8f0; white-space: normal; }
.when { margin-top: 3px; font-size: 13.5px; color: #e2e8f0; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; }
.when .cloud { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.when .cloud svg { width: 14px; height: 14px; }
.cloud.clear { color: #86efac; } .cloud.partly { color: #fde68a; } .cloud.cloudy { color: #fda4af; }
.name { margin-top: 12px; display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 15px; font-weight: 600; }
.name .kind { flex: none; width: 18px; height: 18px; color: var(--sat-kind-satellite); }
.name .kind svg { width: 18px; height: 18px; display: block; }
.name .k-station { color: var(--sat-kind-station); } .name .k-telescope { color: var(--sat-kind-telescope); }
.name .k-train { color: var(--sat-kind-starlink); } .name .k-rocket { color: var(--sat-kind-rocket); } .name .k-debris { color: var(--sat-kind-debris); }
.name .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name .with { flex: none; padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; color: #fcd34d; border: 1px solid rgba(252,211,77,.45); }
.facts { margin-top: 4px; font-size: 12.5px; color: #cbd5e1; display: flex; flex-wrap: wrap; align-items: center; row-gap: 2px; }
.facts > * + *::before { content: "·"; margin: 0 7px; color: #94a3b8; }
.facts .mag { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.facts .arrow { margin: 0 3px; color: #94a3b8; }
.facts.path { margin-top: 3px; }
.facts .el { font-weight: 650; color: #fcd34d; font-variant-numeric: tabular-nums; }
.facts.moon { margin-top: 5px; gap: 6px; flex-wrap: nowrap; align-items: flex-start; color: #e2e8f0; }
.facts.moon svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }
.facts.moon span { text-wrap: balance; }
.facts.moon > * + *::before { content: none; }
.meter { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 12px; }
.meter i { width: 3px; border-radius: 1px; background: rgba(148,163,184,.32); }
.meter i:nth-child(1) { height: 3px; } .meter i:nth-child(2) { height: 5.5px; } .meter i:nth-child(3) { height: 8px; }
.meter i:nth-child(4) { height: 10px; } .meter i:nth-child(5) { height: 12px; }
.meter i.on { background: linear-gradient(180deg, #fef3c7, #fcd34d); }
.meter.l4 i.on { box-shadow: 0 0 5px rgba(252,211,77,.7); }
.text { display: block; margin-top: 6px; font-size: 12.5px; line-height: 1.5; color: #94a3b8; max-width: 46ch; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 13px 0 10px; border-radius: 999px; cursor: pointer;
  font-size: 12.5px; font-weight: 600; white-space: nowrap; color: #e0f2fe; background: rgba(56,189,248,.14);
  border: 1px solid rgba(56,189,248,.45); -webkit-tap-highlight-color: transparent; transition: background .15s, border-color .15s, transform .15s; }
.btn svg { width: 16px; height: 16px; }
.btn:hover { background: rgba(56,189,248,.26); border-color: rgba(125,211,252,.8); }
.btn:active { transform: scale(.97); }
.btn.sim { color: #fae8ff; background: rgba(240,171,252,.13); border-color: rgba(240,171,252,.5); }
.btn.sim:hover { background: rgba(240,171,252,.24); border-color: rgba(245,208,254,.9); }
.hero.live .btn.street { color: #fef3c7; background: rgba(252,211,77,.14); border-color: rgba(252,211,77,.55); }
/* The sky chart sits at the top right; the text flows round its dome. */
.chart { float: right; width: 144px; height: 144px; margin: -4px -8px 2px 10px; shape-outside: circle(47%); }
.chart svg { display: block; width: 100%; height: 100%; }
.spinner { width: 22px; height: 22px; margin: 10px 0 2px; border-radius: 50%; border: 2px solid rgba(125,211,252,.25); border-top-color: #7dd3fc; }
.shimmer { display: block; width: 62%; height: 30px; margin-top: 8px; border-radius: 8px;
  background: linear-gradient(90deg, rgba(148,163,184,.12), rgba(148,163,184,.24), rgba(148,163,184,.12)); background-size: 200% 100%; }

.list { padding: 6px 6px 2px; }
.foot { display: flex; justify-content: flex-end; padding: 0 10px 10px; }
.all { display: inline-flex; align-items: center; gap: 2px; padding: 6px 4px 6px 10px; border: 0; border-radius: 999px; background: none;
  cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--sat-sky-ink, var(--primary-color, #7dd3fc)); }
.all svg { width: 18px; height: 18px; }
.all:hover { background: rgba(127,127,127,.1); }

/* The street view, over the whole screen. */
.overlay { position: fixed; inset: 0; z-index: 10; background: #02040b; display: flex; flex-direction: column; }
.overlay satellite-street-view { flex: 1; min-height: 0; }
.overlay .loading { margin: auto; display: grid; justify-items: center; gap: 14px; color: #cbd5e1; font-size: 13px; text-align: center; padding: 24px; }
.overlay .close { position: absolute; top: calc(12px + env(safe-area-inset-top, 0px)); right: calc(12px + env(safe-area-inset-right, 0px));
  z-index: 2; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; border: 1px solid rgba(148,163,184,.3);
  background: rgba(15,23,42,.8); color: #f8fafc; cursor: pointer; }
.overlay .close svg { width: 22px; height: 22px; }
.overlay.ready > .close { display: none; }

@container (max-width: 380px) {
  .chart { width: 116px; height: 116px; margin-right: -6px; }
  .clock { font-size: 32px; }
  .hero { padding: 12px 12px 14px 14px; }
}
@container (max-width: 280px) {
  .chart { display: none; }
}
@media (prefers-reduced-motion: no-preference) {
  .hero.live { animation: hero-glow 2.6s ease-in-out infinite; }
  .hero.live .state .dot { animation: hero-ping 1.6s ease-out infinite; }
  .spinner { animation: spin .9s linear infinite; }
  .shimmer { animation: shimmer 1.4s ease-in-out infinite; }
}
@keyframes hero-glow { 50% { box-shadow: inset 0 0 0 1px rgba(252,211,77,.8), inset 0 0 46px rgba(252,211,77,.24); } }
@keyframes hero-ping { 0% { box-shadow: 0 0 0 0 rgba(252,211,77,.6); } 80%, 100% { box-shadow: 0 0 0 9px rgba(252,211,77,0); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
`;

const BaseElement = globalThis.HTMLElement ?? class {};

export class SatellitePassesView extends BaseElement {
  constructor() {
    super();
    this._config = {};
    this._offsetMs = 0;
    this._delay = 0;
    this._gen = 0;
    this._fmt = new formatModule.Formatter(undefined);
    this._client = new client.SatClient(() => this._hass);
    this._onVisibility = () => this._visibilityChanged();
    this._onReconnect = () => this._refresh();
    this._onFullscreen = () => this._fullscreenChanged();
    this._onFocusIn = (ev) => this._focusIn(ev);
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    this._fmt.update(hass);
    this.toggleAttribute("light", !darkTheme(hass));
    this._useLanguage();
    this._watchConnection();
    if (!old && this.isConnected) this._start();
    else if (old && (hass?.locale !== old.locale || hass?.config?.time_zone !== old.config?.time_zone)) this._render();
  }

  get hass() {
    return this._hass;
  }

  set config(config) {
    const old = this._config;
    this._config = { ...config };
    if (old.entry_id !== this._config.entry_id) {
      // Another location: its passes, not the last one's.
      this._client.clear();
      this._payload = null;
      this._detail = null;
      this._error = null;
      if (this._started) this._refresh();
    }
    if (this._started) this._render();
  }

  get config() {
    return this._config;
  }

  /** Home Assistant's card editor shows the card: it stays put (no navigating away from the editor). */
  set editorPreview(value) {
    this._editorPreview = !!value;
    if (this._els) this._render();
  }

  get editorPreview() {
    return !!this._editorPreview;
  }

  connectedCallback() {
    clearTimeout(this._overlayTimer);
    this._overlayTimer = null;
    this._build();
    document.addEventListener("visibilitychange", this._onVisibility);
    this._watchConnection();
    if (this._hass) this._start();
    // Moved by the dashboard with the street view open: the focus left with
    // the card, and goes back to the street view.
    if (this._overlay) this._focusOverlay();
  }

  disconnectedCallback() {
    this._started = false;
    clearTimeout(this._tickTimer);
    clearTimeout(this._refreshTimer);
    this._tickTimer = this._refreshTimer = null;
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._unwatchConnection();
    if (!this._overlay) return;
    // The street view closes only if the card stays away. Leaving the page
    // also takes the overlay out of the browser's fullscreen, which is not
    // the user leaving it: it stays open as the fixed overlay phones get.
    this._wasFullscreen = false;
    clearTimeout(this._overlayTimer);
    this._overlayTimer = setTimeout(() => {
      this._overlayTimer = null;
      if (!this.isConnected) this._closeStreet({ restoreFocus: false });
    }, OVERLAY_GRACE_MS);
  }

  // ---- Data ----

  _start() {
    if (this._started || !this._hass || !this.isConnected) return;
    this._started = true;
    this._render();
    this._refresh();
    this._tick();
  }

  /** Refresh when Home Assistant's connection comes back. */
  _watchConnection() {
    const connection = this.isConnected ? this._hass?.connection : null;
    if (connection === this._connection) return;
    this._unwatchConnection();
    connection?.addEventListener?.("ready", this._onReconnect);
    this._connection = connection;
  }

  _unwatchConnection() {
    this._connection?.removeEventListener?.("ready", this._onReconnect);
    this._connection = null;
  }

  /** Home Assistant's time (unix s): the device clock, corrected by the server's. */
  _nowS() {
    return (Date.now() + this._offsetMs) / 1000;
  }

  async _refresh() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = null;
    if (!this._hass || !this._started) return;
    const gen = ++this._gen;
    const sent = Date.now();
    try {
      const payload = await this._client.passes(this._config.entry_id);
      if (gen !== this._gen || !this._started) return;
      this._offsetMs = client.nextClockOffset(this._offsetMs, payload?.server_time, sent, Date.now());
      this._payload = payload;
      this._error = null;
      this._delay = 0;
      this._fmt.setUnits(payload?.settings?.units);
      this._render();
      this._schedule(REFRESH_MS);
    } catch (err) {
      if (gen !== this._gen || !this._started) return;
      this._error = err;
      this._delay = client.nextDelay(this._delay, RETRY_MIN_MS, REFRESH_MS);
      this._render();
      this._schedule(this._delay);
    }
  }

  /** The next refresh: after `ms`, or just after the pass on screen ends, whichever is sooner. */
  _schedule(ms) {
    clearTimeout(this._refreshTimer);
    const hero = this._hero?.pass;
    let wait = ms;
    if (hero && !this._error) {
      const untilEnd = (hero.end - this._nowS()) * 1000 + AFTER_END_MS;
      if (untilEnd > 0) wait = Math.min(wait, untilEnd);
    }
    this._refreshAt = Date.now() + wait;
    this._refreshTimer = document.hidden ? null : setTimeout(() => this._refresh(), wait);
  }

  _visibilityChanged() {
    if (!this._started) return;
    if (document.hidden) {
      // Nothing to show: no ticking, no polling. Picked up again on return.
      clearTimeout(this._tickTimer);
      clearTimeout(this._refreshTimer);
      this._tickTimer = this._refreshTimer = null;
      return;
    }
    if (Date.now() >= (this._refreshAt ?? 0)) this._refresh();
    else this._schedule(this._refreshAt - Date.now());
    this._tick();
  }

  async _useLanguage() {
    const language = this._hass?.language || "en";
    if (language === this._language) return;
    this._language = language;
    const strings = await i18n.loadStrings(language);
    if (this._language !== language) return;
    this._fmt.update(this._hass, strings);
    // English standing in for a translation that did not download: ask again next time.
    if (strings.language !== i18n.resolveLanguage(language)) this._language = undefined;
    this._render();
  }

  /** The pass track of the pass on screen, for its sky chart and where to look. */
  async _loadDetail(pass) {
    if (!pass || this._detailFor === pass.id || Date.now() < (this._detailRetryAt ?? 0)) return;
    this._detailFor = pass.id;
    try {
      const detail = await this._client.passTrack(pass.id, { entryId: this._config.entry_id, step: CHART_STEP_S });
      if (this._detailFor !== pass.id) return;
      this._detail = detail;
      this._detailRetryAt = 0;
      this._chartKey = null;
      this._render();
    } catch {
      // The rest of the card does without; the chart is asked for again in a minute.
      if (this._detailFor !== pass.id) return;
      this._detail = null;
      this._detailFor = null;
      this._detailRetryAt = Date.now() + DETAIL_RETRY_MS;
    }
  }

  // ---- Drawing ----

  _build() {
    if (this._els) return;
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}${sky.SKY_STYLE}</style>
      <div class="card">
      <section class="hero" part="hero">
        <button class="main" type="button">
          <span class="chart sky" aria-hidden="true" hidden></span>
          <span class="state"><span class="dot"></span><span class="label"></span><span class="chip" hidden>${theme.svgIcon("star")}<span></span></span></span>
          <span class="clock"></span>
          <span class="when"></span>
          <span class="name" hidden></span>
          <span class="facts bright" hidden></span>
          <span class="facts path" hidden></span>
          <span class="facts moon" hidden></span>
          <span class="text" hidden></span>
        </button>
        <div class="actions" hidden>
          <button class="btn sim" type="button" data-view="simulate">${theme.svgIcon("play")}<span></span></button>
          <button class="btn street" type="button" data-view="street">${theme.svgIcon("street")}<span></span></button>
        </div>
        <div class="sr-only" aria-live="polite"></div>
      </section>
      <div class="list" hidden></div>
      <div class="foot" hidden><button class="all" type="button"><span></span>${theme.svgIcon("chevron_right")}</button></div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    this._els = {
      hero: $(".hero"), main: $(".main"), state: $(".state"), label: $(".state .label"), chip: $(".state .chip"),
      clock: $(".clock"), when: $(".when"), name: $(".name"), facts: $(".facts.bright"), text: $(".text"), chart: $(".chart"),
      path: $(".facts.path"), moon: $(".facts.moon"), actions: $(".actions"), sim: $(".btn.sim"), street: $(".btn.street"),
      announce: $("[aria-live]"),
      list: $(".list"), foot: $(".foot"), all: $(".all"),
    };
    try {
      this._els.hero.style.setProperty("--stars", theme.starField());
    } catch {
      // No canvas (a test page): the sky stays plain.
    }
    this._els.main.addEventListener("click", () => this._open(this._hero?.pass?.id));
    for (const button of [this._els.sim, this._els.street]) {
      button.addEventListener("click", () => this._open(this._hero?.pass?.id, button.dataset.view, button));
    }
    this._els.all.addEventListener("click", () => this._open(null));
    this._list = new passesModule.PassList(this._els.list, {
      formatter: this._fmt,
      compact: true,
      // The arrow keys only move through the list; a tap or Enter opens the pass.
      onSelect: (id, how) => {
        if (!how?.browse) this._open(id);
      },
      onSimulate: (id) => this._open(id, "simulate"),
      onStreet: (id) => this._open(id, "street"),
    });
  }

  /** What the card shows now: {kind, pass}; kind is live, next, paused, empty, loading or error. */
  _state(nowS) {
    const p = this._payload;
    if (!p) return { kind: this._error ? "error" : "loading" };
    if (p.paused) return { kind: "paused" };
    const filters = this._filters();
    const passes = p.passes || [];
    const live = passesModule.currentPass(passes.filter((q) => passesModule.matchesFilters(q, filters)), nowS);
    if (live) return { kind: "live", pass: live };
    const next = passesModule.nextPass(passes, nowS, (q) => passesModule.matchesFilters(q, filters));
    return next ? { kind: "next", pass: next } : { kind: "empty" };
  }

  _filters() {
    return { brightOnly: !!this._config.bright_only, hideStarlink: !!this._config.hide_starlink };
  }

  _render() {
    if (!this._els || !this._hass) return;
    const nowS = this._nowS();
    const state = this._state(nowS);
    const changed = state.kind !== this._hero?.kind || state.pass?.id !== this._hero?.pass?.id;
    this._hero = state;
    const t = (key, vars) => this._fmt.t(key, vars);
    const e = this._els;
    const panel = hasPanel(this._hass);
    const pass = state.pass;

    e.hero.classList.toggle("live", state.kind === "live");
    e.hero.classList.toggle("quiet", !pass);
    e.main.disabled = !pass;
    e.actions.hidden = !pass;
    e.sim.hidden = !panel;
    e.sim.querySelector("span").textContent = t("card.simulate");
    e.street.querySelector("span").textContent = t("card.street_view");
    if (pass) {
      e.main.setAttribute("aria-label", t("card.open", { title: this._fmt.passTitle(pass), time: this._fmt.time(pass.start) }));
      e.sim.setAttribute("aria-label", t("passes.simulate", { title: this._fmt.passTitle(pass), time: this._fmt.time(pass.start) }));
      e.street.setAttribute("aria-label", t("passes.street", { title: this._fmt.passTitle(pass), time: this._fmt.time(pass.start) }));
    } else {
      e.main.removeAttribute("aria-label");
    }

    if (pass) this._renderPass(state, nowS);
    else this._renderMessage(state);

    // The passes after the one on top.
    const rest = pass
      ? (this._payload?.passes || [])
          .filter((q) => q.id !== pass.id && q.end > nowS && passesModule.matchesFilters(q, this._filters()))
          .slice(0, Math.max(0, Number(this._config.count) || 5))
      : [];
    e.list.hidden = !rest.length;
    this._list.render(rest, { nowS, filters: {}, days: this._payload?.settings?.days ?? 5, location: this._payload?.location });
    e.foot.hidden = !panel || !pass;
    e.all.querySelector("span").textContent = t("card.all_passes");

    if (changed) {
      this._chartKey = null;
      this._announce(state);
    }
    if (pass) this._loadDetail(pass);
    this._renderChart(state, nowS);
  }

  _renderPass(state, nowS) {
    const { pass } = state;
    const fmt = this._fmt;
    const t = (key, vars) => fmt.t(key, vars);
    const e = this._els;
    const live = state.kind === "live";
    setText(e.label, live ? t("card.visible_now") : t(this._config.bright_only ? "card.next_bright_pass" : "card.next_pass"));
    e.chip.hidden = !pass.bright;
    setText(e.chip.querySelector("span"), t("card.bright"));
    e.text.hidden = true;

    const primary = pass.transits?.[0];
    const [from, to] = passesModule.passDirections(pass).map((d) => (d ? fmt.direction(d) : ""));
    e.when.hidden = false;
    if (live) {
      // Where it is now, from the pass track; until that is in, which way it goes.
      const at = lookAt(this._primaryRows(), nowS);
      setText(
        e.clock,
        at && at.elevation > 0
          ? t("card.look_up", { direction: fmt.direction(compassPoint(at.azimuth)), elevation: fmt.degrees(at.elevation) })
          : t("card.look_towards", { direction: from && to ? `${from} → ${to}` : fmt.direction(pass.peak?.direction ?? "") })
      );
      const ending = { set: "card.ends_set", shadow: "card.ends_shadow", sky: "card.ends_sky" }[primary?.end_reason] ?? "card.ends_set";
      const endsIn = t("card.ends_in", { countdown: fmt.countdown(wholeSeconds(pass.end - nowS)) });
      const where = primary?.set?.direction ? t(ending, { direction: fmt.direction(primary.set.direction) }) : "";
      this._setWhen(where ? `${esc(endsIn)} · ${esc(where)}` : esc(endsIn), pass);
    } else {
      setText(e.clock, fmt.countdown(wholeSeconds(pass.start - nowS)));
      const day = fmt.group(pass.start, nowS).label;
      this._setWhen(esc(t("card.when", { day, time: fmt.time(pass.start) })), pass);
    }

    // The satellite, how bright, which way and how high.
    const kind = theme.kindIcon(pass.kind, { train: !!pass.train });
    const member = passesModule.notableMember(pass);
    const name = `<span class="kind k-${esc(kind)}" title="${esc(pass.train ? t("kinds.train") : fmt.kind(pass.kind))}">${theme.svgIcon(kind)}</span><span class="title">${esc(fmt.passTitle(pass))}</span>${
      member ? `<span class="with">${esc(t("passes.with", { name: member.name }))}</span>` : ""
    }`;
    const { level, word } = fmt.brightness(pass.magnitude);
    let bars = "";
    for (let i = 0; i < 5; i++) bars += `<i class="${i <= level ? "on" : ""}"></i>`;
    const facts = `<span class="mag"><span class="meter l${level}" aria-hidden="true">${bars}</span>${esc(word)} ${esc(fmt.magnitude(pass.magnitude))}</span>`;
    const path = [
      from && to ? `<span>${esc(from)}<span class="arrow" aria-hidden="true">→</span>${esc(to)}</span>` : "",
      `<span>${around(t("passes.up_to", { elevation: MARK }), `<b class="el">${esc(fmt.degrees(pass.peak?.elevation))}</b>`)}</span>`,
      `<span>${esc(fmt.duration(pass.duration ?? pass.end - pass.start))}</span>`,
    ].join("");
    setHtml(e.name, name);
    setHtml(e.facts, facts);
    setHtml(e.path, path);
    e.name.hidden = e.facts.hidden = e.path.hidden = false;
    // A bright Moon up during the pass washes out the fainter satellites.
    const moon = passesModule.passMoon(pass, this._payload?.location);
    setHtml(e.moon, moon ? `${passesModule.moonGlyph(moon)}<span>${esc(passesModule.moonText(moon, fmt))}</span>` : "");
    e.moon.hidden = !moon;
  }

  /** The time line, with the forecast cloud for its hour. */
  _setWhen(html, pass) {
    const cloud = this._fmt.cloud(pass.cloud_cover);
    setHtml(
      this._els.when,
      `<span>${html}</span>${
        cloud
          ? `<span class="cloud ${cloud.level}" title="${esc(cloud.word)}">${theme.svgIcon("cloud")}${esc(passesModule.cloudText(pass, this._fmt))}</span>`
          : ""
      }`
    );
  }

  _renderMessage(state) {
    const e = this._els;
    const t = (key, vars) => this._fmt.t(key, vars);
    e.chip.hidden = true;
    e.name.hidden = e.facts.hidden = e.path.hidden = e.moon.hidden = true;
    let label = t("card.spotter");
    let clock = "";
    let when = "";
    let text = "";
    let busy = false;
    if (state.kind === "loading") {
      busy = true;
    } else if (state.kind === "paused") {
      const p = this._payload;
      label = t("card.paused");
      clock = t("card.paused_clock");
      when = Number.isFinite(p.paused_days)
        ? t("card.paused_age", { count: p.paused_days })
        : typeof p.paused === "string"
          ? p.paused
          : "";
      if (when && p.paused_error) when = t("card.with_error", { text: when, error: p.paused_error });
      text = t("card.paused_detail");
    } else if (state.kind === "empty") {
      label = t(this._config.bright_only ? "card.next_bright_pass" : "card.next_pass");
      clock = t("card.none_soon");
      when = t("passes.empty", { count: this._payload?.settings?.days ?? 5 });
      text = t("card.none_why");
    } else {
      // An error, with no passes to fall back on.
      const err = this._error;
      const code = client.errorCode(err);
      const message = client.errorMessage(err, this._fmt.t("globe.connection_lost"));
      busy = code === "not_ready" || code === 3;
      clock = "";
      text =
        code === "not_found"
          ? t("card.not_set_up")
          : code === "unknown_location"
            ? t("card.location_gone")
            : code === "location_disabled"
              ? t("card.location_disabled")
              : code === "not_ready"
                ? message && !/^waiting/i.test(message)
                  ? t("card.waiting_because", { reason: message })
                  : t("card.waiting")
                : t("card.failed", { error: message });
    }
    setText(e.label, label);
    setHtml(e.clock, busy && !clock ? `<span class="${state.kind === "loading" ? "shimmer" : "spinner"}"></span>` : esc(clock));
    setText(e.when, when);
    e.when.hidden = !when;
    setText(e.text, text);
    e.text.hidden = !text;
  }

  _primaryRows() {
    const detail = this._detail;
    const pass = this._hero?.pass;
    if (!detail || !pass || detail.pass_id !== pass.id) return null;
    return detail.transits?.[0]?.rows ?? null;
  }

  /** The sky chart: drawn again when the pass changes, its live dot moved every second. */
  _renderChart(state, nowS) {
    const el = this._els.chart;
    const pass = state.pass;
    const rows = this._primaryRows();
    const show = this._config.show_chart !== false && !!pass && !!rows;
    el.hidden = !show;
    if (!show) return;
    const key = `${pass.id}|${this._fmt.language}|${this._fmt.timeZone}`;
    if (key !== this._chartKey) {
      this._chartKey = key;
      const detail = this._detail;
      const primary = detail.transits[0];
      const members = detail.transits.slice(1).map((m) => ({
        track: sky.skyPoints(m.rows ?? primary.rows, m.rows ? 0 : m.offset_s ?? 0),
        visibleStart: m.visible_start,
        visibleEnd: m.visible_end,
      }));
      // The star marks the group's brightest satellite, so it says the magnitude the card does.
      const best = passesModule.brightestMember(pass);
      el.innerHTML = sky.skyChartSvg({
        track: sky.skyPoints(primary.rows),
        visibleStart: primary.visible_start,
        visibleEnd: primary.visible_end,
        members,
        brightest: best?.brightest ? { ...best.brightest, text: this._fmt.magnitude(best.magnitude ?? pass.magnitude) } : null,
        // Too small for times: the hero says when.
        times: false,
        size: 168,
        id: `pc-${pass.id}`,
        cardinals: this._fmt.list("sky.cardinals"),
        label: this._fmt.t("sky.chart"),
      });
      this._dot = el.querySelector(".live-dot");
    }
    // Where the satellite is now, while it is up.
    const at = state.kind === "live" ? lookAt(rows, nowS) : null;
    const xy = sky.skyDotXY(at, 168);
    if (this._dot) {
      if (xy) {
        this._dot.setAttribute("transform", sky.skyDotTransform(xy));
        this._dot.removeAttribute("display");
      } else {
        this._dot.setAttribute("display", "none");
      }
    }
  }

  /** Say it once when a pass starts, or the next one changes; never every second. */
  _announce(state) {
    if (state.kind === "loading") return;
    if (!this._announced) {
      this._announced = true; // Not what the card first shows: only what changes.
      return;
    }
    const pass = state.pass;
    let text = "";
    if (state.kind === "live") text = `${this._fmt.t("card.visible_now")}: ${this._fmt.passTitle(pass)}`;
    else if (state.kind === "next") text = `${this._fmt.t("card.next_pass")}: ${this._fmt.passTitle(pass)}, ${this._fmt.dateTime(pass.start)}`;
    if (text) this._els.announce.textContent = text;
  }

  /** Once a second, on the second, while the page is visible. */
  _tick() {
    clearTimeout(this._tickTimer);
    this._tickTimer = null;
    if (!this._started || document.hidden) return;
    const nowS = this._nowS();
    const state = this._state(nowS);
    if (state.kind !== this._hero?.kind || state.pass?.id !== this._hero?.pass?.id) {
      this._render();
    } else if (state.pass) {
      this._renderPass(state, nowS);
      this._renderChart(state, nowS);
      this._list.setNow(nowS);
    }
    const ms = Date.now() + this._offsetMs;
    this._tickTimer = setTimeout(() => this._tick(), 1000 - (ms % 1000) + 5);
  }

  // ---- Opening a pass ----

  /** Show a pass in the panel (or the panel itself); without the panel, in the street view here. */
  _open(passId, view = null, from = null) {
    if (this._editorPreview) return;
    const entryId = this._payload?.location?.entry_id ?? this._config.entry_id ?? null;
    if (hasPanel(this._hass)) {
      navigate(panelLink(passId, { view, entryId }));
      return;
    }
    const pass = (this._payload?.passes || []).find((p) => p.id === passId);
    if (pass) this._openStreet(pass, from);
  }

  async _openStreet(pass, from) {
    if (this._overlay) return;
    const root = this.shadowRoot;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", `${this._fmt.t("card.street_view")}: ${this._fmt.passTitle(pass)}`);
    overlay.innerHTML = `<div class="loading"><span class="spinner"></span><span>${esc(this._fmt.passTitle(pass))} · ${esc(this._fmt.dateTime(pass.start))}</span></div>
      <button class="close" type="button" aria-label="${esc(this._fmt.t("card.close"))}">${theme.svgIcon("close")}</button>`;
    overlay.querySelector(".close").addEventListener("click", () => this._closeStreet());
    overlay.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        this._closeStreet();
      }
    });
    this._overlay = overlay;
    this._returnFocus = from ?? this.shadowRoot.activeElement ?? null;
    root.append(overlay);
    this.setAttribute("overlay", "");
    document.addEventListener("fullscreenchange", this._onFullscreen);
    document.addEventListener("focusin", this._onFocusIn);
    // The browser's own fullscreen where it has one (not iPhones): above
    // everything, whatever the dashboard around the card does. Asked for
    // now, while the tap still counts as the user's.
    overlay.requestFullscreen?.({ navigationUI: "hide" })?.catch?.(() => {});
    overlay.querySelector(".close").focus();
    try {
      const [, clockModule, detail] = await Promise.all([
        import(`./sat-street.js${VERSION}`),
        import(`./sat-clock.js${VERSION}`),
        this._client.passTrack(pass.id, { entryId: this._config.entry_id }),
      ]);
      if (this._overlay !== overlay) return;
      const clock = new clockModule.PassClock({ now: () => Date.now() + this._offsetMs });
      // Live or replayed, as the globe and the street view decide it.
      const { passIsLive, PASS_LEAD_S, PASS_TAIL_S } = clockModule;
      if (passIsLive(pass, this._nowS())) clock.live();
      else clock.simulate({ fromS: pass.start - PASS_LEAD_S, toS: pass.end + PASS_TAIL_S, visibleStartS: pass.start, visibleEndS: pass.end });
      const street = document.createElement("satellite-street-view");
      street.hass = this._hass;
      street.formatter = this._fmt;
      street.location = this._payload?.location;
      street.units = this._payload?.settings?.units;
      const options = loadStreetOptions();
      if (options) street.options = options;
      street.clock = clock;
      // No globe behind this view: its time bar offers only the close button.
      street.globeToggle = false;
      street.pass = pass;
      street.detail = detail;
      street.addEventListener("close", () => this._closeStreet());
      street.addEventListener("need-detail", async (ev) => {
        const id = ev.detail?.passId ?? pass.id;
        const next = (this._payload?.passes || []).find((p) => p.id === id) ?? pass;
        try {
          street.setPass?.(next, await this._client.passTrack(id, { entryId: this._config.entry_id }));
        } catch {
          // The street view keeps what it has.
        }
      });
      overlay.querySelector(".loading").replaceWith(street);
      overlay.classList.add("ready");
      this._street = street;
      street.open?.();
      // The close button that held the focus is hidden now: hand the keyboard
      // to the scene, so that Escape and the arrow keys work straight away.
      this._focusOverlay();
    } catch (err) {
      if (this._overlay !== overlay) return;
      console.warn("Satellite Spotter: could not open the street view", err);
      overlay.querySelector(".loading").innerHTML = `<span>${esc(this._fmt.t("card.failed", { error: client.errorMessage(err, this._fmt.t("globe.connection_lost")) }))}</span>`;
    }
  }

  /** The keyboard to the street view's scene, or to the close button while it loads. */
  _focusOverlay() {
    const street = this._street;
    const target = street ? street.shadowRoot?.querySelector(".stage") ?? street : this._overlay?.querySelector(".close");
    target?.focus?.({ preventScroll: true });
  }

  _closeStreet({ restoreFocus = true } = {}) {
    const overlay = this._overlay;
    if (!overlay) return;
    this._overlay = null;
    this._wasFullscreen = false;
    clearTimeout(this._overlayTimer);
    this._overlayTimer = null;
    document.removeEventListener("fullscreenchange", this._onFullscreen);
    document.removeEventListener("focusin", this._onFocusIn);
    if (this.shadowRoot?.fullscreenElement === overlay) document.exitFullscreen?.()?.catch?.(() => {});
    try {
      this._street?.dispose?.();
    } catch (err) {
      console.warn("Satellite Spotter:", err);
    }
    this._street = null;
    overlay.remove();
    this.removeAttribute("overlay");
    if (restoreFocus) this._returnFocus?.focus?.();
    this._returnFocus = null;
  }

  /** The browser left fullscreen (Escape, a gesture): so does the street view. */
  _fullscreenChanged() {
    if (this._overlay && !this.shadowRoot?.fullscreenElement && this._wasFullscreen) this._closeStreet();
    this._wasFullscreen = this.shadowRoot?.fullscreenElement === this._overlay;
  }

  /** Keyboard focus stays in the open street view (it is a modal dialog). */
  _focusIn(ev) {
    const overlay = this._overlay;
    if (!overlay || ev.composedPath?.().includes(overlay)) return;
    (overlay.querySelector("satellite-street-view") ?? overlay.querySelector(".close"))?.focus?.();
  }
}

/** Replace an element's HTML only when it changed, so a 1 Hz redraw costs nothing when nothing moved. */
function setHtml(el, html) {
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

const setText = (el, text) => setHtml(el, esc(text));

// A translation with HTML in place of one value: the text around it is escaped, wherever the language puts it.
const MARK = "\u0001";
const around = (text, html) => text.split(MARK).map(esc).join(html);

if (globalThis.customElements && !customElements.get("satellite-passes-view")) {
  customElements.define("satellite-passes-view", SatellitePassesView);
}
