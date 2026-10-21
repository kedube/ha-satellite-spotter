// Tests for the dashboard cards' loader (sat-card.js): registration, the
// card picker, the editors and lazy loading, on a fake DOM with the globe and
// the passes card stubbed out: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { installDom } from "./helpers/dom-fake.mjs";
import { failModule, stubLoads, stubModules } from "./helpers/dom-stubs.mjs";

// Timers run fast, so none keeps the process waiting (the editor's 3 s wait
// for its text). They stay referenced: a test that waits on one must keep the
// event loop alive until it fires. The 15 s registration timeout keeps its
// length (the first test defines Home Assistant's app well before it), so a
// busy machine cannot make the cards register early.
const realSetTimeout = setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 15000 ? ms : Math.min(ms ?? 0, 20), ...args);

stubModules(["sat-globe.js", "sat-passes-card.js"]);
const { document, flush } = installDom({ lang: "de" });
// The German text never arrives.
globalThis.fetch = () => new Promise(() => {});

await import("../../custom_components/satellite_spotter/frontend/sat-card.js");
await flush();

const DOCS = "https://github.com/kedube/ha-satellite-spotter";

test("the cards wait for Home Assistant's app before they register", async () => {
  assert.equal(customElements.get("satellite-spotter-card"), undefined);
  assert.equal(customElements.get("satellite-passes-card"), undefined);
  customElements.define("home-assistant", class extends HTMLElement {});
  await flush();
  assert.ok(customElements.get("satellite-spotter-card"));
  assert.ok(customElements.get("satellite-passes-card"));
});

test("the loader's English stand-ins are the English text", async () => {
  const { ENGLISH } = await import("../../custom_components/satellite_spotter/frontend/sat-card.js");
  const { default: EN } = await import("../../custom_components/satellite_spotter/frontend/translations/en.js");
  for (const [key, text] of Object.entries(ENGLISH)) assert.equal(text, EN.card[key], `card.${key}`);
});

test("the card picker lists both cards", () => {
  const cards = window.customCards.map((c) => ({ ...c, name: c.name, description: c.description }));
  assert.deepEqual(
    cards.map((c) => [c.type, c.name, c.preview, c.documentationURL]),
    [
      ["satellite-spotter-card", "Satellite globe", false, DOCS],
      ["satellite-passes-card", "Satellite passes", true, DOCS],
    ]
  );
  assert.match(cards[0].description, /3D Earth/);
  assert.match(cards[1].description, /where to look/);
});

test("the editors open in English when their translation is slow to come", async () => {
  const Globe = customElements.get("satellite-spotter-card");
  const form = await Globe.getConfigForm();
  assert.equal(form.computeLabel({ name: "entry_id" }), "Location");
  assert.equal(form.computeHelper({ name: "entry_id" }), "Leave empty to show the first location.");
  assert.equal(form.computeLabel({ name: "street_view" }), "Street view button");
  assert.equal(form.computeLabel({ name: "" }), undefined);
  const Passes = customElements.get("satellite-passes-card");
  const passes = await Passes.getConfigForm();
  assert.equal(passes.computeLabel({ name: "count" }), "Passes listed");
  assert.equal(passes.computeHelper({ name: "count" }), "How many passes to list after the next one.");
  assert.equal(passes.computeHelper({ name: "bright_only" }), undefined);
});

test("the globe card's editor has every option, with the defaults the card uses", async () => {
  const { schema, computeLabel } = await customElements.get("satellite-spotter-card").getConfigForm();
  assert.deepEqual(schema[0], { name: "entry_id", selector: { config_entry: { integration: "satellite_spotter" } } });
  assert.deepEqual(schema[1].selector.select.options.map((o) => o.value), ["satellite", "esri", "streets"]);
  assert.deepEqual(schema[2].selector.select.options.map((o) => [o.value, o.label]), [
    ["home", "My location"], ["follow", "Follow the satellite"], ["chase", "Fly along with the satellite"],
  ]);
  const switches = Object.fromEntries(schema[3].schema.map((s) => [s.name, s.default]));
  assert.deepEqual(switches, {
    labels: true, show_track: true, show_night: true, show_footprint: true, show_home_zone: true, show_countdown: true,
    show_stats: true, show_satellites: false, show_passes: false, street_view: true, cooperative_gestures: false,
  });
  assert.deepEqual(schema[4].selector.number, { min: 340, max: 1200, step: 10, mode: "box", unit_of_measurement: "px" });
  for (const field of [...schema.filter((f) => f.name), ...schema[3].schema]) {
    assert.ok(computeLabel(field) && computeLabel(field) !== field.name, `${field.name} has a label`);
  }
});

test("the passes card's editor", async () => {
  const { schema } = await customElements.get("satellite-passes-card").getConfigForm();
  assert.deepEqual(schema.map((f) => f.name), ["entry_id", "count", ""]);
  assert.deepEqual(schema[1], { name: "count", default: 5, selector: { number: { min: 1, max: 20, step: 1, mode: "slider" } } });
  assert.deepEqual(schema[2].schema.map((s) => [s.name, s.default]), [["bright_only", false], ["hide_starlink", false], ["show_chart", true]]);
});

test("new cards start from a small config, and size themselves for both dashboard kinds", () => {
  const Globe = customElements.get("satellite-spotter-card");
  const Passes = customElements.get("satellite-passes-card");
  assert.deepEqual(Globe.getStubConfig(), { imagery: "satellite", view: "home" });
  assert.deepEqual(Passes.getStubConfig(), { count: 5 });
  const globe = document.createElement("satellite-spotter-card");
  globe.setConfig({ height: 600 });
  assert.deepEqual(globe.getGridOptions(), { columns: 12, rows: 8, min_columns: 12, min_rows: 6 });
  assert.equal(globe.getCardSize(), 12);
  const passes = document.createElement("satellite-passes-card");
  passes.setConfig({ count: 3 });
  assert.deepEqual(passes.getGridOptions(), { columns: 12, rows: "auto", min_columns: 6, max_columns: 12 });
  assert.equal(passes.getCardSize(), 7);
});

test("configs are filled in with the defaults and tidied", () => {
  const globe = document.createElement("satellite-spotter-card");
  globe.setConfig({ type: "custom:satellite-spotter-card", show_passes: true });
  assert.equal(globe._config.show_passes, "strip", "the switch turns on the strip");
  assert.equal(globe._config.street_view, true);
  assert.equal(globe._config.show_satellites, false);
  globe.setConfig({ show_passes: "list" });
  assert.equal(globe._config.show_passes, "list");
  globe.setConfig({ show_passes: "sometimes" });
  assert.equal(globe._config.show_passes, false);
  const passes = document.createElement("satellite-passes-card");
  passes.setConfig({ count: 50 });
  assert.equal(passes._config.count, 20);
  passes.setConfig({ count: "3" });
  assert.equal(passes._config.count, 3);
  passes.setConfig({ count: "lots" });
  assert.equal(passes._config.count, 5);
  assert.equal(passes._config.show_chart, true);
});

test("a card downloads its code only once it is shown with Home Assistant, then hands everything on", async () => {
  const card = document.createElement("satellite-spotter-card");
  card.setConfig({ entry_id: "home" });
  const hass = { language: "en" };
  card.hass = hass;
  assert.equal(card.shadowRoot, null, "not on the page yet");
  card.preview = true;
  document.body.appendChild(card);
  await flush();
  const view = card.shadowRoot.querySelector("ha-card > satellite-globe-view");
  assert.ok(view);
  assert.equal(view.hass, hass);
  assert.equal(view.config.entry_id, "home");
  assert.equal(view.config.imagery, "satellite");
  assert.equal(view.editorPreview, true);
  assert.equal(view.autoCompact, true);
  const next = { language: "en" };
  card.hass = next;
  card.preview = false;
  card.setConfig({ entry_id: "cabin" });
  assert.equal(view.hass, next);
  assert.equal(view.editorPreview, false);
  assert.equal(view.config.entry_id, "cabin");
  card.remove();

  const passes = document.createElement("satellite-passes-card");
  passes.setConfig({ count: 4 });
  passes.hass = hass;
  document.body.appendChild(passes);
  await flush();
  const passesView = passes.shadowRoot.querySelector("ha-card > satellite-passes-view");
  assert.ok(passesView);
  assert.equal(passesView.config.count, 4);
  assert.equal(passesView.autoCompact, undefined, "only the globe shrinks its overlays");
  passes.remove();
});

test("a card's code that does not download is tried again later, under a new address", async () => {
  // A copy of the loader of its own version, so the passes card's code is downloaded afresh.
  const fresh = await import("../../custom_components/satellite_spotter/frontend/sat-card.js?v=fresh");
  customElements.define("fresh-passes-card", fresh.SatellitePassesCard);
  const realNow = Date.now;
  const realWarn = console.warn;
  let now = realNow();
  Date.now = () => now;
  console.warn = () => {};
  try {
    failModule("sat-passes-card.js", 1);
    const card = document.createElement("fresh-passes-card");
    card.setConfig({});
    card.hass = { language: "en" };
    document.body.appendChild(card);
    await flush();
    assert.equal(card.shadowRoot.querySelector(".error").textContent, "Could not load the satellite passes. Check the connection, or reload the page.");
    card.hass = { language: "en" };
    await flush();
    assert.ok(!card.shadowRoot.querySelector("satellite-passes-view"), "not straight away");
    now += 31000;
    card.hass = { language: "en" };
    await flush();
    assert.ok(card.shadowRoot.querySelector("ha-card > satellite-passes-view"));
    assert.match(stubLoads().at(-1), /^sat-passes-card\.js\?v=fresh&retry=1&stub=/);
    card.remove();
  } finally {
    Date.now = realNow;
    console.warn = realWarn;
  }
});

test("heights: the globe's own in masonry dashboards, the grid's in sections, its content's for the passes", async () => {
  const globe = document.createElement("satellite-spotter-card");
  globe.setConfig({ height: 500 });
  globe.hass = {};
  document.body.appendChild(globe);
  await flush();
  // Home Assistant says which layout just after making a card: the height waits a frame.
  const frame = () => new Promise((resolve) => realSetTimeout(resolve, 10));
  await frame();
  const card = globe.shadowRoot.querySelector("ha-card");
  assert.equal(card.style.height, "500px");
  globe.layout = "grid";
  assert.equal(card.style.height, "100%");
  globe.layout = "masonry";
  await frame();
  assert.equal(card.style.height, "500px");
  globe.remove();

  const passes = document.createElement("satellite-passes-card");
  passes.setConfig({});
  passes.hass = {};
  document.body.appendChild(passes);
  await flush();
  const passesCard = passes.shadowRoot.querySelector("ha-card");
  assert.equal(passesCard.style.height, "auto");
  passes.layout = "grid";
  assert.equal(passesCard.style.height, "auto");
  passes.layout = "panel";
  assert.equal(passesCard.style.height, "100%");
  passes.remove();
});

test("a globe height written with its unit, or not a height at all, still gives a card of a size", async () => {
  const frame = () => new Promise((resolve) => realSetTimeout(resolve, 10));
  const globe = document.createElement("satellite-spotter-card");
  globe.setConfig({ height: "500px" });
  assert.equal(globe.getCardSize(), 10, "what a masonry view places it by");
  globe.hass = {};
  document.body.appendChild(globe);
  await flush();
  await frame();
  const card = globe.shadowRoot.querySelector("ha-card");
  assert.equal(card.style.height, "500px");
  globe.setConfig({ height: " 450 PX " });
  await frame();
  assert.equal(card.style.height, "450px");
  for (const junk of ["tall", "50vh", "", -100, 0, null, true]) {
    globe.setConfig({ height: junk });
    assert.equal(globe.getCardSize(), 8, `${JSON.stringify(junk)}: the default 420 px`);
    await frame();
    assert.equal(card.style.height, "420px", JSON.stringify(junk));
  }
  globe.remove();
});

test("the card picker speaks the dashboard's language once its text is in", async () => {
  const passes = () => window.customCards.find((c) => c.type === "satellite-passes-card");
  assert.equal(passes().name, "Satellite passes", "German never came: English");
  globalThis.fetch = async (url) => {
    assert.match(String(url), /translations\/fr\.json/);
    return { ok: true, json: async () => ({ card: { passes_name: "Passages de satellites" } }) };
  };
  // Home Assistant changes <html lang> when the user picks another language.
  document.documentElement.lang = "fr";
  await flush();
  assert.equal(passes().name, "Passages de satellites");
  assert.match(passes().description, /where to look/, "what the translation lacks stays English");
  document.documentElement.lang = "en";
  await flush();
  assert.equal(passes().name, "Satellite passes");
});
