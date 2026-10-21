/**
 * Dashboard cards: the satellite globe (custom:satellite-spotter-card) and
 * the visible passes (custom:satellite-passes-card).
 *
 * Loaded on every Home Assistant page by the integration, so it stays tiny:
 * a card's own code (the globe and MapLibre, or the pass list) downloads only
 * once that card is actually shown.
 */

const VERSION = new URL(import.meta.url).searchParams.get("v") || "";
const QUERY = VERSION ? `?v=${VERSION}` : "";
const DOCS = "https://github.com/kedube/ha-satellite-spotter";

// Retry a failed module download at most this often.
const RETRY_MS = 30000;
// The card editor waits no longer than this for its text, then opens in English.
const FORM_TEXT_WAIT_MS = 3000;

// The text in the user's language comes from sat-i18n.js, loaded only when
// it is needed; until then (and if it cannot load) these stay English. They
// are the card group's text in translations/en.js (a test keeps them equal).
export const ENGLISH = {
  name: "Satellite globe",
  description:
    "A 3D Earth with the satellites you can see from home: the next pass, its orbit, a countdown and the view from your street.",
  load_failed: "Could not load the satellite globe. Check the connection, or reload the page.",
  passes_name: "Satellite passes",
  passes_description:
    "The next satellites you can see from home: when, where to look and how bright, with a countdown and a sky chart.",
  passes_load_failed: "Could not load the satellite passes. Check the connection, or reload the page.",
};

let i18nModule;
// The module once it is in, for English while a translation is slow to come.
let i18nLoaded = null;
function loadI18n() {
  // A failed import is not kept, so the next use tries again.
  i18nModule ??= import(`./sat-i18n.js${QUERY}`).then(
    (module) => (i18nLoaded = module),
    (err) => {
      i18nModule = null;
      throw err;
    }
  );
  return i18nModule;
}

/** The text for Home Assistant's language, which it puts on the page; null if it cannot load. */
async function pageStrings() {
  try {
    return await (await loadI18n()).loadStrings(document.documentElement.lang);
  } catch {
    return null;
  }
}

/** pageStrings, but after waitMs whatever there is: English once the module is in, else null. */
function pageStringsWithin(waitMs) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(i18nLoaded?.english ?? null), waitMs);
  });
  return Promise.race([pageStrings(), late]).finally(() => clearTimeout(timer));
}

/** Home Assistant's form editor for a card: labels and helpers from the editor group. */
async function configForm(schema, helpers = {}) {
  const strings = await pageStringsWithin(FORM_TEXT_WAIT_MS);
  const text = (key) => strings?.t(`editor.${key}`);
  const options = (name, values) => values.map((value) => ({ value, label: text(`${name}_${value}`) ?? value }));
  return {
    schema: schema(options),
    computeLabel: (field) => (field.name ? text(field.name) : undefined),
    computeHelper: (field) => (helpers[field.name] ? text(helpers[field.name]) : undefined),
  };
}

const LOCATION = { name: "entry_id", selector: { config_entry: { integration: "satellite_spotter" } } };
// The defaults let the switches show what the card actually does.
const switches = (names, defaults) => ({
  type: "grid",
  name: "",
  schema: names.map((name) => ({ name, default: defaults[name] === true, selector: { boolean: {} } })),
});

const BaseElement = globalThis.HTMLElement ?? class {};

/**
 * A card that draws itself with an element from a module downloaded on first
 * show. Subclasses say which module and element, and how big the card is.
 */
class LazyCard extends BaseElement {
  setConfig(config) {
    this._config = this.constructor.normalize({ ...this.constructor.DEFAULTS, ...config });
    if (this._view) this._view.config = this._config;
    this._applyHeight();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._view) this._view.hass = hass;
    else this._ensure();
  }

  get hass() {
    return this._hass;
  }

  set layout(layout) {
    this._layout = layout;
    this._applyHeight();
  }

  /** Home Assistant sets this on cards shown in the editor. */
  set preview(preview) {
    this._editorPreview = !!preview;
    if (this._view) this._view.editorPreview = this._editorPreview;
  }

  connectedCallback() {
    this._ensure();
  }

  async _ensure() {
    if (this._loading || this._view || !this._hass || !this.isConnected) return;
    if (Date.now() < (this._retryAt || 0)) return;
    this._loading = true;
    const { MODULE, VIEW, TEXT } = this.constructor;
    if (!this._card) {
      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      root.innerHTML = `
        <style>
          :host { display: block; height: 100%; }
          ha-card { overflow: hidden; height: 100%; isolation: isolate; ${this.constructor.CARD_CSS} }
          /* Full screen without the browser's fullscreen (iPhones) is a fixed
             overlay: lift the card above the dashboard's header and cards, and
             drop a theme's backdrop filter, which would hold it inside the card. */
          ha-card:has(> [fullscreen]), ha-card:has(> [overlay]) { position: relative; z-index: 10000;
            backdrop-filter: none; -webkit-backdrop-filter: none; }
          ${VIEW} { border-radius: var(--ha-card-border-radius, 12px); }
          .error { padding: 16px; color: var(--secondary-text-color); }
        </style>
        <ha-card></ha-card>`;
      this._card = root.querySelector("ha-card");
      this._applyHeight();
    }
    const query = [VERSION && `v=${VERSION}`, this._attempt && `retry=${this._attempt}`].filter(Boolean).join("&");
    try {
      await import(`./${MODULE}${query ? `?${query}` : ""}`);
    } catch (err) {
      // Browsers remember a failed module fetch, so the retry uses a new URL.
      this._attempt = (this._attempt || 0) + 1;
      this._retryAt = Date.now() + RETRY_MS;
      const message = document.createElement("div");
      message.className = "error";
      message.textContent = ENGLISH[TEXT.loadFailed];
      this._card.replaceChildren(message);
      console.warn(`Satellite Spotter: could not load ${MODULE}`, err);
      pageStrings().then((strings) => {
        if (strings && message.isConnected) message.textContent = strings.t(`card.${TEXT.loadFailed}`);
      });
      return;
    } finally {
      this._loading = false;
    }
    if (this._view || !this.isConnected) return;
    this._card.replaceChildren();
    const view = document.createElement(VIEW);
    view.editorPreview = !!this._editorPreview;
    this.prepareView(view);
    view.config = this._config;
    view.hass = this._hass;
    this._card.appendChild(view);
    this._view = view;
  }

  /** Anything the element needs before its first config and hass. */
  prepareView() {}

  _applyHeight(settled = false) {
    if (!this._card) return;
    const height = this.constructor.fixedHeight(this._config);
    if (this._layout === "grid" || this._layout === "panel" || height == null) {
      // Sections grids and panel views give the card its size; a card without
      // a height of its own takes its content's.
      this._card.style.height = height == null && this._layout !== "panel" ? "auto" : "100%";
      return;
    }
    if (!settled) {
      // Home Assistant tells a card its layout just after creating it; wait
      // a frame rather than flip heights and make the view lay out twice.
      cancelAnimationFrame(this._heightFrame);
      this._heightFrame = requestAnimationFrame(() => this._applyHeight(true));
      return;
    }
    this._card.style.height = `${height}px`;
  }

  static normalize(config) {
    return config;
  }

  static fixedHeight() {
    return null;
  }
}

const GLOBE_DEFAULTS = {
  imagery: "satellite",
  view: "home",
  labels: true,
  show_track: true,
  show_night: true,
  show_footprint: true,
  show_home_zone: true,
  show_countdown: true,
  show_stats: true,
  show_satellites: false,
  show_passes: false,
  street_view: true,
  height: 420,
};

const GLOBE_SWITCHES = [
  "labels", "show_track", "show_night", "show_footprint", "show_home_zone", "show_countdown",
  "show_stats", "show_satellites", "show_passes", "street_view", "cooperative_gestures",
];

/** The globe: a 3D Earth with the next pass, its orbit and a countdown. */
export class SatelliteSpotterCard extends LazyCard {
  static MODULE = "sat-globe.js";
  static VIEW = "satellite-globe-view";
  static DEFAULTS = GLOBE_DEFAULTS;
  static TEXT = { loadFailed: "load_failed" };
  static CARD_CSS = "min-height: 240px;";

  // Home Assistant waits for the form, so the editor opens in the user's
  // language, or in English if that is slow to come.
  static getConfigForm() {
    return configForm(
      (options) => [
        LOCATION,
        { name: "imagery", selector: { select: { mode: "dropdown", options: options("imagery", ["satellite", "esri", "streets"]) } } },
        { name: "view", selector: { select: { mode: "dropdown", options: options("view", ["home", "follow", "chase"]) } } },
        switches(GLOBE_SWITCHES, GLOBE_DEFAULTS),
        {
          name: "height",
          default: GLOBE_DEFAULTS.height,
          selector: { number: { min: 340, max: 1200, step: 10, mode: "box", unit_of_measurement: "px" } },
        },
      ],
      { entry_id: "entry_id_helper", show_satellites: "show_satellites_helper", show_passes: "show_passes_helper" }
    );
  }

  static getStubConfig() {
    return { imagery: GLOBE_DEFAULTS.imagery, view: GLOBE_DEFAULTS.view };
  }

  /**
   * The switch turns the pass strip on; YAML may also ask for the full list.
   * The height is in pixels, as the editor writes it, or "500px" as YAML often
   * does; anything else gets the default rather than an unusable card.
   */
  static normalize(config) {
    const passes = config.show_passes;
    const height = Number(String(config.height ?? "").trim().replace(/px$/i, ""));
    return {
      ...config,
      show_passes: passes === true ? "strip" : passes === "strip" || passes === "list" ? passes : false,
      height: Number.isFinite(height) && height > 0 ? height : GLOBE_DEFAULTS.height,
    };
  }

  static fixedHeight(config) {
    return config?.height ?? GLOBE_DEFAULTS.height;
  }

  prepareView(view) {
    // Smaller overlays on narrow cards; the globe decides from its own size.
    view.autoCompact = true;
  }

  getCardSize() {
    return Math.max(4, Math.round((this._config?.height ?? GLOBE_DEFAULTS.height) / 50));
  }

  getGridOptions() {
    // The countdown, the map controls and the telemetry need a full section width.
    return { columns: 12, rows: 8, min_columns: 12, min_rows: 6 };
  }
}

const PASSES_DEFAULTS = { count: 5, bright_only: false, hide_starlink: false, show_chart: true };
const MAX_COUNT = 20;

/** The passes: a countdown to the next one, where to look, and the ones after it. No WebGL. */
export class SatellitePassesCard extends LazyCard {
  static MODULE = "sat-passes-card.js";
  static VIEW = "satellite-passes-view";
  static DEFAULTS = PASSES_DEFAULTS;
  static TEXT = { loadFailed: "passes_load_failed" };
  static CARD_CSS = "";

  static getConfigForm() {
    return configForm(
      () => [
        LOCATION,
        { name: "count", default: PASSES_DEFAULTS.count, selector: { number: { min: 1, max: MAX_COUNT, step: 1, mode: "slider" } } },
        switches(["bright_only", "hide_starlink", "show_chart"], PASSES_DEFAULTS),
      ],
      { entry_id: "entry_id_helper", count: "count_helper" }
    );
  }

  static getStubConfig() {
    return { count: PASSES_DEFAULTS.count };
  }

  static normalize(config) {
    const count = Math.round(Number(config.count));
    return { ...config, count: Number.isFinite(count) ? Math.min(MAX_COUNT, Math.max(1, count)) : PASSES_DEFAULTS.count };
  }

  getCardSize() {
    // About 50 px a unit: the countdown and sky chart, then a row a pass.
    return 4 + (this._config?.count ?? PASSES_DEFAULTS.count);
  }

  getGridOptions() {
    return { columns: 12, rows: "auto", min_columns: 6, max_columns: 12 };
  }
}

// The card picker's entries, in the user's language once their text has loaded.
let pickerStrings = null;

/** Load the picker's text when Home Assistant's language is not English (it sets <html lang>). */
function preparePicker() {
  const language = document.documentElement.lang;
  if (!language || /^en\b/i.test(language)) {
    pickerStrings = null;
    return;
  }
  pageStrings().then((strings) => {
    if (document.documentElement.lang === language) pickerStrings = strings;
  });
}

const pickerText = (key) => pickerStrings?.t(`card.${key}`) ?? ENGLISH[key];

const CARDS = [
  { type: "satellite-spotter-card", element: SatelliteSpotterCard, name: "name", description: "description", preview: false },
  // Quick to draw (no WebGL), so the picker can show it with real passes.
  { type: "satellite-passes-card", element: SatellitePassesCard, name: "passes_name", description: "passes_description", preview: true },
];

function register() {
  window.customCards = window.customCards || [];
  for (const card of CARDS) {
    if (!customElements.get(card.type)) customElements.define(card.type, card.element);
    if (window.customCards.some((c) => c.type === card.type)) continue;
    window.customCards.push({
      type: card.type,
      // Read when the card picker opens.
      get name() {
        return pickerText(card.name);
      },
      get description() {
        return pickerText(card.description);
      },
      preview: card.preview,
      documentationURL: DOCS,
    });
  }
  preparePicker();
  new MutationObserver(preparePicker).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
}

// Home Assistant installs a scoped custom element registry while its app
// starts. This module is loaded early, and a card defined before that switch
// is invisible to dashboards ("Custom element doesn't exist"), so wait for the
// app's own element first. The timeout covers pages without it.
if (globalThis.customElements && globalThis.document) {
  let timer;
  Promise.race([
    customElements.whenDefined("home-assistant"),
    new Promise((resolve) => (timer = setTimeout(resolve, 15000))),
  ]).then(() => {
    clearTimeout(timer);
    register();
  });
}
