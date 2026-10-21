// Tests for the globe view's pass strip and the sheet that holds the pass
// list in narrow layouts, with the view's real DOM on a fake document (the
// map and the network left out): node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { installDom, keydown } from "./helpers/dom-fake.mjs";
import { anything } from "./helpers/gl-fake.mjs";
import { T0, makePass, makePayload } from "./helpers/view-fixtures.mjs";

const { document } = installDom();
// The stars behind the globe are drawn on a canvas.
const createElement = document.createElement.bind(document);
document.createElement = (tag) => {
  const el = createElement(tag);
  if (String(tag).toLowerCase() === "canvas") {
    el.getContext = () => anything();
    el.toDataURL = () => "data:image/png;base64,";
  }
  return el;
};

const { SatelliteGlobeView } = await import("../../custom_components/satellite_spotter/frontend/sat-globe.js");

const PASSES = [
  makePass(T0 + 600, T0 + 900),
  makePass(T0 + 7200, T0 + 7500, { ids: [48274], kind: "tiangong", title: "Tiangong" }),
  makePass(T0 + 9000, T0 + 9300, { ids: [20580], kind: "hubble", title: "Hubble" }),
  makePass(T0 + 12000, T0 + 12300),
];

/** A globe too narrow for the list beside it (a phone, a card, a small window): a strip, and a sheet. */
function narrowView() {
  const view = new SatelliteGlobeView();
  view.dispatchEvent = () => true;
  view._now = () => T0 * 1000;
  view._config = { panel: true, show_passes: "list" };
  view._buildDom();
  view._payload = makePayload(PASSES);
  view._loaded = true;
  view._wide = false;
  const did = [];
  for (const name of ["_framePass", "_loadApproach", "_loadFocusTrack", "_buildCourse", "_renderSky", "_updateCloudFlags", "_tick", "_simulate", "_openStreet"]) {
    view[name] = (pass) => did.push([name, pass?.id]);
  }
  view._loadDetail = async () => null;
  view._selectedId = PASSES[0].id;
  view._renderStrip();
  const sheet = view._els.sheet;
  const all = () => view._els.strip.querySelector(".pchip.all");
  const open = () => {
    all().focus();
    all().click();
    assert.equal(sheet.hidden, false);
  };
  // The row with keyboard focus, inside the list's own shadow root.
  const row = () => view._els.plist.shadowRoot.activeElement;
  const rowId = () => row()?.closest("li[data-id]")?.dataset.id;
  // Compared here: a failing assert.equal() of two elements would print the whole fake document.
  const focusedAll = () => view.shadowRoot.activeElement === all();
  return { view, did, sheet, open, row, rowId, focusedAll };
}

test("in the sheet the arrow keys browse the passes, and the sheet stays open", () => {
  const { view, did, sheet, open, row, rowId, focusedAll } = narrowView();
  open();
  assert.equal(rowId(), PASSES[0].id, "on the pass shown");
  keydown(row(), "ArrowDown");
  assert.equal(sheet.hidden, false);
  assert.equal(view._selectedId, PASSES[1].id, "shown on the globe as the keys go");
  assert.deepEqual(did.filter(([name]) => name === "_framePass").at(-1), ["_framePass", PASSES[1].id]);
  assert.equal(rowId(), PASSES[1].id);
  keydown(row(), "ArrowDown");
  keydown(row(), "End");
  keydown(row(), "ArrowUp");
  assert.equal(sheet.hidden, false);
  assert.equal(rowId(), PASSES[2].id);
  // Enter picks it: the sheet closes, and focus goes back to the button that opened it.
  keydown(row(), "Enter");
  assert.equal(sheet.hidden, true);
  assert.equal(view._selectedId, PASSES[2].id);
  assert.ok(focusedAll(), "on the strip's All passes button");
  // Escape closes it too.
  open();
  keydown(row(), "ArrowDown");
  keydown(row(), "Escape");
  assert.equal(sheet.hidden, true);
  assert.ok(focusedAll());
});

test("a pass simulated or opened in the street view from the sheet closes it, with focus back on the strip", () => {
  const { view, did, sheet, open, row, focusedAll } = narrowView();
  open();
  keydown(row(), "ArrowDown");
  keydown(row(), " ");
  assert.equal(sheet.hidden, true);
  assert.deepEqual(did.at(-1), ["_simulate", PASSES[1].id]);
  assert.ok(focusedAll(), "on the strip's All passes button");
  open();
  const street = view._els.plist.shadowRoot.querySelector(`li[data-id="${PASSES[3].id}"] button[data-action="street"]`);
  street.click();
  assert.equal(sheet.hidden, true);
  assert.deepEqual(did.at(-1), ["_openStreet", PASSES[3].id]);
  assert.ok(focusedAll(), "where focus comes back to when the street view closes");
});
