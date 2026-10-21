// Tests for the sidebar panel: its header, location picker, links to a pass
// and its language, on a fake DOM with the globe stubbed out:
// node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { installDom, installLocation } from "./helpers/dom-fake.mjs";
import { failModule, stubLoads, stubModules } from "./helpers/dom-stubs.mjs";

stubModules(["sat-globe.js"]);
const { document, flush } = installDom();
const nav = installLocation("http://ha.local/satellite-spotter");
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

const { SatelliteSpotterPanel, readLink, writeLink } = await import(
  "../../custom_components/satellite_spotter/frontend/sat-panel.js"
);

const HOME = { entry_id: "home", title: "Home", show_in_sidebar: true };
const CABIN = { entry_id: "cabin", title: "Cabin", show_in_sidebar: true };
const BOAT = { entry_id: "boat", title: "Boat", show_in_sidebar: false };

/** A panel on the page, as Home Assistant puts it there, with its locations. */
async function open({ locations = [HOME, CABIN], language = "en", at = "/satellite-spotter" } = {}) {
  nav.go(at);
  const panel = document.createElement("satellite-spotter-panel");
  panel.route = { prefix: "/satellite-spotter", path: "" };
  const asked = [];
  panel.hass = {
    language,
    callWS: async (msg) => {
      asked.push(msg);
      return typeof locations === "function" ? locations() : locations;
    },
  };
  document.body.appendChild(panel);
  await flush();
  await panel._languageReady;
  await flush();
  const root = panel.shadowRoot;
  return { panel, root, asked, view: () => panel._view, select: root.querySelector("select.location") };
}

test("the panel shows the globe with the pass list, its title and the location picker", async () => {
  store.clear();
  const { panel, root, view, select, asked } = await open();
  assert.equal(root.querySelector("h1").textContent, "Satellite Spotter");
  assert.equal(view().localName, "satellite-globe-view");
  assert.deepEqual(view().config, {
    entry_id: "home", panel: true, imagery: "satellite", view: "home", show_passes: "list", show_satellites: true, street_view: true,
    filters: { brightOnly: false, hideStarlink: false },
  });
  assert.equal(view().hass, panel.hass);
  assert.deepEqual(asked[0], { type: "satellite_spotter/locations" });
  assert.deepEqual(select.querySelectorAll("option").map((o) => [o.value, o.textContent]), [["home", "Home"], ["cabin", "Cabin"]]);
  assert.equal(root.querySelector(".where").hidden, false);
  assert.equal(select.getAttribute("aria-label"), "Location");
  assert.equal(root.querySelector("button.menu").getAttribute("aria-label"), "Sidebar");
  panel.remove();
});

test("the chosen location and imagery are remembered", async () => {
  store.clear();
  const first = await open();
  first.select.value = "cabin";
  first.select.dispatchEvent(new CustomEvent("change"));
  assert.equal(first.view().config.entry_id, "cabin");
  first.view().fire("imagery-changed", "esri");
  assert.deepEqual(JSON.parse(store.get("satellite-spotter:panel")), { entry_id: "cabin", imagery: "esri" });
  first.panel.remove();
  const second = await open();
  assert.equal(second.view().config.entry_id, "cabin");
  assert.equal(second.view().config.imagery, "esri");
  second.panel.remove();
  // Storage that cannot be read is no reason not to open.
  store.set("satellite-spotter:panel", "{not json");
  const third = await open();
  assert.equal(third.view().config.entry_id, "home");
  third.panel.remove();
});

test("the pass list's filters and every satellite on or off are remembered too", async () => {
  store.clear();
  const first = await open();
  first.view().fire("filters-changed", { brightOnly: true, hideStarlink: false }, { bubbles: true, composed: true });
  first.view().fire("satellites-changed", false, { bubbles: true, composed: true });
  assert.deepEqual(JSON.parse(store.get("satellite-spotter:panel")), {
    filters: { brightOnly: true, hideStarlink: false }, show_satellites: false,
  });
  // The view has them already: they are not handed back to it now…
  assert.deepEqual(first.view().config.filters, { brightOnly: false, hideStarlink: false });
  // …but they go with the next config, so a change of location keeps them.
  first.select.value = "cabin";
  first.select.dispatchEvent(new CustomEvent("change"));
  assert.deepEqual(first.view().config.filters, { brightOnly: true, hideStarlink: false });
  assert.equal(first.view().config.show_satellites, false);
  first.panel.remove();
  // Next time the panel opens with them.
  const second = await open();
  assert.deepEqual(second.view().config.filters, { brightOnly: true, hideStarlink: false });
  assert.equal(second.view().config.show_satellites, false);
  second.panel.remove();
  // Stored values that make no sense are not taken.
  store.set("satellite-spotter:panel", JSON.stringify({ filters: { brightOnly: "yes", hideStarlink: true }, show_satellites: "no" }));
  const third = await open();
  assert.deepEqual(third.view().config.filters, { brightOnly: false, hideStarlink: true });
  assert.equal(third.view().config.show_satellites, true);
  third.panel.remove();
});

test("a deleted location makes the panel switch to one that is left", async () => {
  store.set("satellite-spotter:panel", JSON.stringify({ entry_id: "cabin" }));
  let locations = [HOME, CABIN];
  const { panel, view, select, root } = await open({ locations: () => locations });
  assert.equal(view().config.entry_id, "cabin");
  locations = [HOME];
  view().fire("location-gone", "cabin");
  await flush();
  assert.equal(view().config.entry_id, "home");
  assert.deepEqual(select.querySelectorAll("option").map((o) => o.value), ["home"]);
  assert.equal(root.querySelector(".where").hidden, true, "no picker for a single location");
  panel.remove();
});

test("locations kept out of the sidebar are offered only when no other is", async () => {
  store.clear();
  const some = await open({ locations: [HOME, BOAT] });
  assert.deepEqual(some.select.querySelectorAll("option").map((o) => o.value), ["home"]);
  some.panel.remove();
  const none = await open({ locations: [{ ...HOME, show_in_sidebar: false }, BOAT] });
  assert.deepEqual(none.select.querySelectorAll("option").map((o) => o.value), ["home", "boat"]);
  none.panel.remove();
});

test("a link opens its pass, in the view it asks for", async () => {
  store.clear();
  const { panel, view } = await open({ at: "/satellite-spotter?pass=25544-1792400980&view=street" });
  assert.deepEqual(view().calls, [["selectPass", "25544-1792400980", { view: "street" }]]);
  // Home Assistant navigating to another pass, while the panel is open.
  nav.go("/satellite-spotter?pass=53807-1792276513");
  assert.deepEqual(view().calls.at(-1), ["selectPass", "53807-1792276513", { view: null }]);
  // The same address again, or the panel's address without a pass, changes nothing.
  const count = view().calls.length;
  nav.go("/satellite-spotter?pass=53807-1792276513");
  nav.go("/satellite-spotter");
  assert.equal(view().calls.length, count);
  panel.remove();
  // Once the panel is gone it no longer listens.
  nav.go("/satellite-spotter?pass=25544-1792490244");
  assert.equal(view().calls.length, count);
});

test("a link to another location shows that location, without remembering it", async () => {
  store.set("satellite-spotter:panel", JSON.stringify({ entry_id: "home" }));
  const { panel, view, select } = await open({
    locations: [HOME, CABIN, BOAT],
    at: "/satellite-spotter?entry_id=boat&pass=25544-1792400980&view=simulate",
  });
  assert.equal(view().config.entry_id, "boat");
  assert.deepEqual(select.querySelectorAll("option").map((o) => o.value), ["home", "cabin", "boat"], "offered while shown");
  assert.equal(select.value, "boat");
  assert.deepEqual(view().calls, [["selectPass", "25544-1792400980", { view: "simulate" }]]);
  assert.equal(JSON.parse(store.get("satellite-spotter:panel")).entry_id, "home");
  // Navigating to a pass of another location while open.
  nav.go("/satellite-spotter?entry_id=cabin&pass=1-2");
  assert.equal(view().config.entry_id, "cabin");
  assert.deepEqual(view().calls.at(-1), ["selectPass", "1-2", { view: null }]);
  // An unknown location in a link is ignored.
  nav.go("/satellite-spotter?entry_id=nowhere&pass=1-3");
  assert.equal(view().config.entry_id, "cabin");
  panel.remove();
});

test("the address follows the pass picked on the globe", async () => {
  store.clear();
  const { panel, view, select } = await open({ at: "/satellite-spotter?foo=1" });
  const pushed = nav.pushed.length;
  view().fire("pass-selected", { id: "25544-1792400980", view: "simulate" }, { bubbles: true, composed: true });
  assert.equal(location.search, "?foo=1&entry_id=home&pass=25544-1792400980&view=simulate");
  assert.equal(nav.pushed.length, pushed, "no new history entry");
  view().fire("pass-selected", { id: "53807-1792276513", view: null });
  assert.equal(location.search, "?foo=1&entry_id=home&pass=53807-1792276513");
  // What the panel wrote itself is not followed again.
  const calls = view().calls.length;
  globalThis.dispatchEvent(new CustomEvent("location-changed"));
  assert.equal(view().calls.length, calls);
  // Another location: its passes are not the last one's.
  select.value = "cabin";
  select.dispatchEvent(new CustomEvent("change"));
  assert.equal(location.search, "?foo=1");
  panel.remove();
  // One location: no need to name it.
  const single = await open({ locations: [HOME] });
  single.view().fire("pass-selected", { id: "1-1", view: "street" });
  assert.equal(location.search, "?pass=1-1&view=street");
  // The address is only ever written on the panel's own.
  history.pushState(null, "", "/lovelace/0");
  single.view().fire("pass-selected", { id: "1-2", view: null });
  assert.equal(location.href, "http://ha.local/lovelace/0");
  single.panel.remove();
});

test("links are read and written", () => {
  assert.deepEqual(readLink("?pass=1-2&view=street&entry_id=e"), { pass: "1-2", view: "street", entry_id: "e" });
  assert.deepEqual(readLink("?view=street"), { pass: null, view: null, entry_id: null }, "a view needs a pass");
  assert.deepEqual(readLink("?pass=1-2&view=globe"), { pass: "1-2", view: null, entry_id: null });
  assert.deepEqual(readLink(""), { pass: null, view: null, entry_id: null });
  assert.equal(writeLink("http://h/satellite-spotter?x=1&view=street", { pass: "1-2" }), "http://h/satellite-spotter?x=1&pass=1-2");
  assert.equal(writeLink("http://h/satellite-spotter?pass=1-2&view=street", {}), "http://h/satellite-spotter");
});

test("a globe that does not download is tried again a while later, under a new address", async () => {
  store.clear();
  // A copy of the panel module of its own version, so its globe is downloaded afresh.
  const { SatelliteSpotterPanel: Fresh } = await import("../../custom_components/satellite_spotter/frontend/sat-panel.js?v=fresh");
  customElements.define("fresh-spotter-panel", Fresh);
  const realNow = Date.now;
  const realWarn = console.warn;
  let now = realNow();
  Date.now = () => now;
  console.warn = () => {};
  try {
    failModule("sat-globe.js", 1);
    nav.go("/satellite-spotter");
    const panel = document.createElement("fresh-spotter-panel");
    panel.hass = { language: "en", callWS: async () => [HOME] };
    document.body.appendChild(panel);
    await flush();
    const root = panel.shadowRoot;
    assert.ok(!panel._view);
    // In English straight away: the panel's own copy of the text, which is en.js's.
    const { default: EN } = await import("../../custom_components/satellite_spotter/frontend/translations/en.js");
    assert.equal(root.querySelector(".error p").textContent, EN.card.load_failed);
    panel.hass = { ...panel.hass };
    await flush();
    assert.ok(!panel._view, "not straight away");
    now += 31000;
    panel.hass = { ...panel.hass };
    await flush();
    assert.equal(panel._view?.localName, "satellite-globe-view");
    assert.match(stubLoads().at(-1), /^sat-globe\.js\?v=fresh&retry=1&stub=/);
    assert.equal(root.querySelector(".error"), null);
    panel.remove();
  } finally {
    Date.now = realNow;
    console.warn = realWarn;
  }
});

test("the panel asks for its language again a while after the download failed, not on every update", async () => {
  const saved = { fetch: globalThis.fetch, now: Date.now, warn: console.warn };
  let now = saved.now();
  Date.now = () => now;
  console.warn = () => {};
  let downloads = 0;
  globalThis.fetch = async (url) => {
    if (++downloads === 1) throw new TypeError("Failed to fetch");
    return { ok: true, json: async () => JSON.parse(readFileSync(new URL(url), "utf8")) };
  };
  try {
    const GERMAN = JSON.parse(readFileSync(new URL("../../custom_components/satellite_spotter/frontend/translations/de.json", import.meta.url), "utf8"));
    const { panel, root } = await open({ language: "de", locations: [HOME] });
    const menu = root.querySelector("button.menu");
    assert.equal(menu.getAttribute("aria-label"), "Sidebar", "English while German cannot load");
    const hass = panel.hass;
    panel.hass = hass;
    await panel._languageReady;
    assert.equal(downloads, 1);
    now += 61000;
    panel.hass = hass;
    await panel._languageReady;
    assert.equal(downloads, 2);
    assert.equal(menu.getAttribute("aria-label"), GERMAN.panel.sidebar);
    assert.notEqual(GERMAN.panel.sidebar, "Sidebar");
    // The title in German, or in English while German has none.
    assert.equal(root.querySelector("h1").textContent, GERMAN.panel.title ?? "Satellite Spotter");
    panel.remove();
  } finally {
    globalThis.fetch = saved.fetch;
    Date.now = saved.now;
    console.warn = saved.warn;
  }
});

test("the panel knows when Home Assistant's sidebar sits beside it", () => {
  const panel = new SatelliteSpotterPanel();
  panel._render = () => {};
  const docked = (hass, narrow = false) => {
    panel.narrow = narrow;
    panel.hass = hass;
    return panel.hasAttribute("docked");
  };
  assert.equal(docked({ dockedSidebar: "docked" }), true);
  assert.equal(docked({ dockedSidebar: "auto" }), true, "collapsed to icons, still beside the panel");
  assert.equal(docked({ dockedSidebar: "docked" }, true), false, "narrow screens slide it over the panel");
  assert.equal(docked({ dockedSidebar: "always_hidden" }), false);
  assert.equal(docked({ dockedSidebar: "docked", kioskMode: true }), false);
  assert.equal(docked({ dockedSidebar: "docked", auth: { external: { config: { hasSidebar: true } } } }), false);
  assert.equal(panel.hasAttribute("rtl"), false);
  document.dir = "rtl";
  docked({ dockedSidebar: "docked" });
  assert.equal(panel.hasAttribute("rtl"), true);
  document.dir = "ltr";
});

test("the menu button opens Home Assistant's sidebar, and shows only when its own would", async () => {
  store.clear();
  const { panel, root } = await open({ locations: [HOME] });
  const menu = root.querySelector("button.menu");
  panel.narrow = false;
  panel.hass = { ...panel.hass, dockedSidebar: "docked" };
  assert.equal(menu.hidden, true);
  panel.narrow = true;
  assert.equal(menu.hidden, false);
  let toggled = 0;
  document.body.addEventListener("hass-toggle-menu", () => toggled++);
  menu.click();
  assert.equal(toggled, 1);
  panel.remove();
});
