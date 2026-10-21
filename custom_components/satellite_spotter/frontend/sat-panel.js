/**
 * Sidebar panel: the satellite globe full screen, with the pass list, the
 * sky chart and the street view. Registered by the integration while a
 * location has "Show Satellite Spotter in the sidebar" on.
 *
 * Links can open a pass: /satellite-spotter?pass=<id>&view=street|simulate
 * (and entry_id=<location> when there are several). The panel follows them
 * when it opens and whenever Home Assistant navigates, and keeps the address
 * up to date as passes are picked, so a link always shows what is on screen.
 */

const VERSION = new URL(import.meta.url).searchParams.get("v") || "";
const STORE = "satellite-spotter:panel";
const MENU_ICON = "M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z";
const PANEL_PATH = "/satellite-spotter";
const VIEWS = new Set(["street", "simulate"]);
// Retry a failed module download at most this often.
const RETRY_MS = 30000;
// Shown when the globe cannot load, in English if its text cannot load either.
const TITLE = "Satellite Spotter";
const LOAD_FAILED = "Could not load the satellite globe. Check the connection, or reload the page.";

function loadSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(STORE));
    return settings && typeof settings === "object" ? settings : {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {
    // Private mode or storage disabled: settings just are not remembered.
  }
}

/** The pass list's filters, every value checked (as sat-passes.js normalizeFilters, without loading it). */
const filtersOf = (f) => ({ brightOnly: f?.brightOnly === true, hideStarlink: f?.hideStarlink === true });

/** The pass, view and location a link asks for: ?pass=<id>&view=street&entry_id=<id>. */
export function readLink(search) {
  const q = new URLSearchParams(search || "");
  const pass = q.get("pass") || null;
  const view = VIEWS.has(q.get("view")) ? q.get("view") : null;
  return { pass, view: pass ? view : null, entry_id: q.get("entry_id") || null };
}

/** The address with the pass (and view, and location) in it; other parameters stay. */
export function writeLink(href, { pass = null, view = null, entry_id = null } = {}) {
  const url = new URL(href);
  const q = url.searchParams;
  for (const [key, value] of [["entry_id", entry_id], ["pass", pass], ["view", pass && VIEWS.has(view) ? view : null]]) {
    if (value) q.set(key, value);
    else q.delete(key);
  }
  url.search = q.toString();
  return url.href;
}

const linkKey = (link) => `${link.entry_id ?? ""}|${link.pass ?? ""}|${link.view ?? ""}`;

// The panel draws edge to edge and keeps clear of notches and home indicators itself.
const inset = (side) => `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`;

const BaseElement = globalThis.HTMLElement ?? class {};

export class SatelliteSpotterPanel extends BaseElement {
  constructor() {
    super();
    this._onLocationChanged = () => this._followLink();
  }

  set hass(hass) {
    this._hass = hass;
    this._languageReady = this._useLanguage();
    this._updateMenu();
    if (this._view) {
      this._view.hass = hass;
      // Opened while the locations were still starting up: look again.
      if (Date.now() >= (this._locationsRetryAt ?? Infinity)) this._reloadLocations();
    } else {
      this._render();
    }
  }

  get hass() {
    return this._hass;
  }

  set narrow(narrow) {
    this._narrow = narrow;
    this._updateMenu();
  }

  set panel(panel) {
    this._panel = panel;
  }

  /** Home Assistant's route for the panel ({prefix, path}); the prefix is its address. */
  set route(route) {
    this._route = route;
  }

  connectedCallback() {
    window.addEventListener("location-changed", this._onLocationChanged);
    window.addEventListener("popstate", this._onLocationChanged);
    // Back on the panel, perhaps through a link to another pass.
    if (this._view) this._followLink();
    this._render();
  }

  disconnectedCallback() {
    window.removeEventListener("location-changed", this._onLocationChanged);
    window.removeEventListener("popstate", this._onLocationChanged);
  }

  /** Load the panel's text in Home Assistant's language (the globe loads its own). */
  async _useLanguage() {
    const language = this._hass?.language || "en";
    if (language === this._language || Date.now() < (this._languageRetryAt || 0)) return;
    this._language = language;
    try {
      // Browsers remember a failed module fetch, so a retry asks under a new URL.
      const query = [VERSION && `v=${VERSION}`, this._languageAttempt && `retry=${this._languageAttempt}`].filter(Boolean).join("&");
      const i18n = await import(`./sat-i18n.js${query ? `?${query}` : ""}`);
      const strings = await i18n.loadStrings(language);
      if (this._language !== language) return;
      this._strings = strings;
      this._applyStrings();
      if (strings.language !== i18n.resolveLanguage(language)) {
        // English stands in for a translation that did not download: try it again later.
        this._language = undefined;
        this._languageRetryAt = Date.now() + RETRY_MS;
      }
    } catch (err) {
      // Let an update after RETRY_MS try again, not every update fail at once.
      if (this._language === language) this._language = undefined;
      this._languageAttempt = (this._languageAttempt || 0) + 1;
      this._languageRetryAt = Date.now() + RETRY_MS;
      console.warn("Satellite Spotter:", err);
    }
  }

  _applyStrings() {
    const strings = this._strings;
    if (!strings || !this._menu) return;
    this._title.textContent = strings.t("panel.title");
    this._menu.title = strings.t("panel.sidebar");
    this._menu.setAttribute("aria-label", strings.t("panel.sidebar"));
    this._select.setAttribute("aria-label", strings.t("panel.location"));
    this._select.title = strings.t("panel.location");
    if (this._error) this._error.querySelector("p").textContent = strings.t("card.load_failed");
  }

  /** The sidebar button, shown when Home Assistant would show its own. */
  _updateMenu() {
    const hass = this._hass;
    const sidebarHidden = this._narrow || hass?.dockedSidebar === "always_hidden";
    const external = hass?.auth?.external?.config?.hasSidebar === true;
    // Home Assistant's own test for a sidebar beside the panel, which keeps
    // clear of the notch on that side itself.
    this.toggleAttribute("docked", !sidebarHidden && !hass?.kioskMode && !external);
    this.toggleAttribute("rtl", document.dir === "rtl");
    if (!this._menu) return;
    this._menu.hidden = !(sidebarHidden && !hass?.kioskMode && !external);
  }

  async _render() {
    if (this._rendering || this._view || !this._hass || !this.isConnected) return;
    if (Date.now() < (this._retryAt || 0)) return;
    this._rendering = true;
    this._settings = loadSettings();
    // Start loading the globe while the locations are being looked up.
    const query = [VERSION && `v=${VERSION}`, this._attempt && `retry=${this._attempt}`].filter(Boolean).join("&");
    const globe = import(`./sat-globe.js${query ? `?${query}` : ""}`);
    globe.catch(() => {}); // Handled below.

    if (!this._menu) this._build();
    const link = readLink(location.search);
    const entryId = await this._loadLocations(link.entry_id);
    this._viewConfig = {
      entry_id: entryId,
      panel: true,
      imagery: this._settings.imagery || "satellite",
      view: "home",
      show_passes: "list",
      show_satellites: this._settings.show_satellites !== false,
      street_view: true,
      filters: filtersOf(this._settings.filters),
    };

    try {
      await globe;
    } catch (err) {
      // Browsers remember a failed module fetch, so the retry uses a new URL.
      this._attempt = (this._attempt || 0) + 1;
      this._retryAt = Date.now() + RETRY_MS;
      this._rendering = false;
      this._error = document.createElement("div");
      this._error.className = "error";
      this._error.innerHTML = `<p></p>`;
      this._error.querySelector("p").textContent = this._strings?.t("card.load_failed") ?? LOAD_FAILED;
      this._main.replaceChildren(this._error);
      console.warn("Satellite Spotter:", err);
      return;
    }
    this._error = null;
    const view = document.createElement("satellite-globe-view");
    view.config = this._viewConfig;
    view.hass = this._hass;
    // The globe's choices, kept for next time: the imagery, every satellite on
    // or off, and the pass list's filters. (The view has them already.)
    view.addEventListener("imagery-changed", (e) => this._remember({ imagery: e.detail }));
    view.addEventListener("satellites-changed", (e) => this._remember({ show_satellites: e.detail === true }));
    view.addEventListener("filters-changed", (e) => this._remember({ filters: filtersOf(e.detail) }));
    // The location shown was deleted: offer the ones left, and show the first.
    view.addEventListener("location-gone", () => this._reloadLocations());
    // Keep the address showing the pass on screen.
    view.addEventListener("pass-selected", (e) => this._mirrorLink(e.detail));
    this._main.replaceChildren(view);
    this._view = view;
    this._rendering = false;
    // The address now: Home Assistant may have navigated while the globe loaded.
    this._followLink();
  }

  _build() {
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        /* Clear of the notch on the sides that reach the screen's edge: not
           the one a docked sidebar covers. Home Assistant zeroes its left
           content inset beside the sidebar, whatever the text direction. */
        :host { display: flex; flex-direction: column; height: 100vh; height: 100dvh; background: #000;
          --sat-l: var(--safe-area-content-inset-left, ${inset("left")}); --sat-r: ${inset("right")}; }
        :host([rtl]) { --sat-l: ${inset("left")}; }
        :host([rtl][docked]) { --sat-r: 0px; }
        [hidden] { display: none !important; }
        header { display: flex; align-items: center; gap: 8px; flex: none; box-sizing: border-box;
          height: calc(var(--header-height, 56px) + ${inset("top")});
          padding: ${inset("top")} calc(12px + var(--sat-r)) 0 calc(12px + var(--sat-l));
          background: var(--app-header-background-color, var(--primary-color));
          color: var(--app-header-text-color, #fff);
          border-bottom: var(--app-header-border-bottom, none);
          font-family: var(--ha-font-family-body, Roboto, sans-serif); }
        header h1 { font-size: 20px; font-weight: 400; margin: 0 0 0 4px; flex: 1; min-width: 0;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        button.menu { flex: none; background: none; border: 0; color: inherit; width: 40px; height: 40px; border-radius: 50%;
          cursor: pointer; display: grid; place-items: center; }
        button.menu:hover { background: rgba(255,255,255,.12); }
        button.menu svg { width: 24px; height: 24px; fill: currentColor; }
        button.menu:focus-visible, select:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
        .where { position: relative; flex: none; display: flex; align-items: center; max-width: 45vw; }
        select { appearance: none; -webkit-appearance: none; font: inherit; font-size: 14px; font-weight: 500; color: inherit;
          max-width: 100%; height: 32px; padding: 0 30px 0 12px; border-radius: 999px; cursor: pointer;
          background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.3); text-overflow: ellipsis; }
        select:hover { background: rgba(255,255,255,.2); }
        select option { color: #000; }
        .where svg { position: absolute; right: 9px; width: 16px; height: 16px; fill: currentColor; pointer-events: none; opacity: .8; }
        main { position: relative; flex: 1; min-height: 0; }
        satellite-globe-view { position: absolute; inset: 0;
          --sat-safe-left: var(--sat-l); --sat-safe-right: var(--sat-r); --sat-safe-bottom: ${inset("bottom")}; }
        .error { display: grid; place-items: center; height: 100%; padding: 24px; box-sizing: border-box; text-align: center;
          color: #cbd5e1; font-family: var(--ha-font-family-body, Roboto, sans-serif);
          background: radial-gradient(ellipse at 50% 42%, #0b1a3a 0%, #040814 58%, #000 100%); }
        .error p { max-width: 420px; margin: 0; line-height: 1.5; }
      </style>
      <header>
        <button class="menu" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${MENU_ICON}"/></svg></button>
        <h1></h1>
        <div class="where" hidden>
          <select class="location"></select>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>
        </div>
      </header>
      <main></main>`;
    this._menu = root.querySelector("button.menu");
    this._title = root.querySelector("h1");
    this._title.textContent = TITLE;
    this._where = root.querySelector(".where");
    this._select = root.querySelector("select.location");
    this._main = root.querySelector("main");
    this._updateMenu();
    this._menu.addEventListener("click", () =>
      this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }))
    );
    // Listen before the globe has loaded, so an early choice is not lost.
    this._select.addEventListener("change", () => {
      this._settings.entry_id = this._select.value;
      saveSettings(this._settings);
      this._configureView({ entry_id: this._select.value });
      // A pass of the last location means nothing here.
      this._mirrorLink({ id: null, view: null });
    });
    this._applyStrings();
  }

  _configureView(changes) {
    this._viewConfig = { ...this._viewConfig, ...changes };
    if (this._view) this._view.config = this._viewConfig;
  }

  /** Keep a choice made on the globe: stored, and in the config the view gets next (it has it already). */
  _remember(settings) {
    Object.assign(this._settings, settings);
    saveSettings(this._settings);
    this._viewConfig = { ...this._viewConfig, ...settings };
  }

  /**
   * Fill the location picker; returns the location to show: the one a link
   * asks for, else the one last chosen, else the first.
   */
  async _loadLocations(wanted = null) {
    let locations = [];
    try {
      locations = (await this._hass.callWS({ type: "satellite_spotter/locations" })) || [];
    } catch {
      // The globe shows its own message when nothing is set up.
    }
    this._locations = locations;
    // The list is empty while locations are still starting up; look again later.
    this._locationsRetryAt = locations.length ? null : Date.now() + RETRY_MS;
    return this._fillPicker(wanted);
  }

  /** The picker's choices: the sidebar's locations (all when none is), plus one a link asks for. */
  _fillPicker(wanted) {
    const locations = this._locations || [];
    const shown = locations.filter((l) => l.show_in_sidebar);
    let choices = shown.length ? shown : locations;
    // A link may open a location kept out of the sidebar.
    const linked = locations.find((l) => l.entry_id === wanted);
    if (linked && !choices.includes(linked)) choices = [...choices, linked];
    const select = this._select;
    select.replaceChildren(
      ...choices.map((l) => {
        const opt = document.createElement("option");
        opt.value = l.entry_id;
        opt.textContent = l.title;
        return opt;
      })
    );
    this._where.hidden = choices.length < 2;
    const pick = (id) => choices.some((l) => l.entry_id === id) && id;
    const entryId = pick(wanted) || pick(this._settings.entry_id) || choices[0]?.entry_id;
    select.value = entryId ?? "";
    return entryId;
  }

  async _reloadLocations() {
    this._locationsRetryAt = Infinity; // One look at a time.
    const entryId = await this._loadLocations(this._viewConfig?.entry_id);
    if (entryId && entryId !== this._viewConfig?.entry_id) this._configureView({ entry_id: entryId });
  }

  /**
   * Open what the address asks for, once: on load, and when Home Assistant
   * navigates here. (Home Assistant takes the panel off the page when it
   * navigates elsewhere, so an address seen while on the page is the panel's.)
   */
  _followLink(link = readLink(location.search)) {
    const view = this._view;
    if (!view || !this.isConnected) return;
    const key = linkKey(link);
    if (key === this._linkKey) return;
    this._linkKey = key;
    const known = this._locations?.some((l) => l.entry_id === link.entry_id);
    if (link.entry_id && known && link.entry_id !== this._viewConfig.entry_id) {
      // Not remembered: the picker's own choice is what the panel opens with next time.
      this._fillPicker(link.entry_id);
      this._configureView({ entry_id: link.entry_id });
    }
    if (link.pass) view.selectPass?.(link.pass, { view: link.view });
  }

  /** Put the pass picked on the globe into the address, without a new history entry. */
  _mirrorLink({ id = null, view = null } = {}) {
    if (!this._onPanel()) return;
    const several = (this._locations?.length ?? 0) > 1;
    const link = { pass: id || null, view: id ? view : null, entry_id: several && id ? this._viewConfig?.entry_id ?? null : null };
    const href = writeLink(location.href, link);
    if (href !== location.href) history.replaceState(history.state, "", href);
    this._linkKey = linkKey(readLink(new URL(href).search));
  }

  /** Whether the address is this panel's: the address is only ever written there. */
  _onPanel() {
    const prefix = this._route?.prefix || PANEL_PATH;
    const path = location.pathname;
    return path === prefix || path.startsWith(`${prefix}/`);
  }
}

if (globalThis.customElements && !customElements.get("satellite-spotter-panel")) {
  customElements.define("satellite-spotter-panel", SatelliteSpotterPanel);
}
