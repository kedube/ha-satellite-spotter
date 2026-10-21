// Tests for the pass list and the pass helpers the views share, on a fake DOM:
// node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { installDom, keydown } from "./helpers/dom-fake.mjs";
import { makePass, BOSTON_NOW, bostonHass } from "./helpers/dom-passes.mjs";

const { document, flush } = installDom();

const { english } = await import("../../custom_components/satellite_spotter/frontend/sat-i18n.js");
const { Formatter } = await import("../../custom_components/satellite_spotter/frontend/sat-format.js");
const {
  PassList, brightestMember, cloudHour, cloudText, currentPass, endedPass, groupPasses, matchesFilters, moonGlyph, moonText,
  nextPass, normalizeFilters, notableMember, passDirections, passMoon, rowParts,
} = await import("../../custom_components/satellite_spotter/frontend/sat-passes.js");
const astro = await import("../../custom_components/satellite_spotter/frontend/sat-astro.js");
const { compass } = await import("../../custom_components/satellite_spotter/frontend/sat-geo.js");

const fmt = new Formatter(bostonHass(), english);
const at = (iso) => Date.parse(iso) / 1000;
const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);
const BOSTON = { latitude: 42.3601, longitude: -71.0589, elevation: 10 };
const VEENENDAAL = { latitude: 52.03, longitude: 5.56, elevation: 10 };
const plain = (text) => text.replace(/[  ]/g, " ");

// Boston, from Saturday 17 October 2026 17:00 EDT: a week-end of passes.
const PASSES = [
  makePass({ id: "53807-1792276513", title: "BlueWalker 3", start: at("2026-10-17T18:35:13-04:00"), duration: 206, magnitude: 1.7, elevation: 25, from: "SSW", to: "E", cloud: 7 }),
  makePass({ id: "62078-1792277102", title: "CZ-2C R/B", kind: "rocket", start: at("2026-10-17T18:45:02-04:00"), duration: 115, magnitude: 2.3, elevation: 58.9, from: "NW", to: "SE", cloud: 7 }),
  makePass({
    id: "67304-1792317273", title: "COSMO-SKYMED-FM3 +1", start: at("2026-10-18T05:54:33-04:00"), duration: 305, magnitude: -2.7,
    bright: true, elevation: 80.3, from: "N", to: "S", cloud: 41, members: [{ norad_id: 25544, name: "ISS", kind: "iss" }],
  }),
  makePass({
    id: "101007-1792318250", title: "Starlink Group 15-25 D +21", kind: "starlink", train: true, count: 22, start: at("2026-10-18T06:10:50-04:00"),
    duration: 878, magnitude: 2.0, elevation: 74.6, from: "SW", to: "N", cloud: 45,
  }),
  makePass({ id: "53807-1792366428", title: "BlueWalker 3", start: at("2026-10-18T19:33:48-04:00"), duration: 118, magnitude: -0.1, bright: true, elevation: 85.4, from: "W", to: "ENE", cloud: 97 }),
  makePass({ id: "25544-1792400980", title: "ISS", kind: "iss", start: at("2026-10-19T05:09:40-04:00"), duration: 146, magnitude: -2.1, bright: true, elevation: 56.1, from: "NW", to: "ENE", cloud: 13 }),
  makePass({ id: "25544-1792479451", title: "ISS", kind: "iss", start: at("2026-10-20T08:55:36-04:00"), duration: 53, magnitude: -2.7, before_sunset: true, elevation: 33, from: "WSW", to: "SSE", cloud: null }),
];
const byId = (id) => PASSES.find((p) => p.id === id);

function mount(options = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const calls = [];
  const record = (name) => (id) => calls.push([name, id]);
  const list = new PassList(host, {
    formatter: fmt, onSelect: record("select"), onSimulate: record("simulate"), onStreet: record("street"),
    onFilter: (f) => calls.push(["filter", f]), ...options,
  });
  const root = host.shadowRoot;
  const rows = () => root.querySelectorAll("li.row").map((li) => li.dataset.id);
  const row = (id) => root.querySelector(`li[data-id="${id}"]`);
  return { host, list, root, calls, rows, row };
}

// ---- Helpers ----

test("the pass on now: start counts, the end does not", () => {
  const p = byId("53807-1792276513");
  assert.equal(currentPass(PASSES, p.start - 1), null);
  assert.equal(currentPass(PASSES, p.start), p);
  assert.equal(currentPass(PASSES, p.end - 1), p);
  assert.equal(currentPass(PASSES, p.end), null);
  assert.equal(currentPass(undefined, p.start), null);
});

test("the next pass: one going on counts, ended ones do not, a filter may choose", () => {
  const first = byId("53807-1792276513");
  assert.equal(nextPass(PASSES, BOSTON_NOW), first);
  assert.equal(nextPass(PASSES, first.start + 10), first, "still going on");
  assert.equal(nextPass(PASSES, first.end), byId("62078-1792277102"));
  assert.equal(nextPass(PASSES, BOSTON_NOW, (p) => p.bright), byId("67304-1792317273"));
  assert.equal(nextPass([...PASSES].reverse(), BOSTON_NOW), first, "in any order");
  assert.equal(nextPass(PASSES, at("2026-10-25T00:00:00Z")), null);
  assert.equal(nextPass(null, BOSTON_NOW), null);
});

test("the pass that ended last", () => {
  const first = byId("53807-1792276513");
  const second = byId("62078-1792277102");
  assert.equal(endedPass(PASSES, BOSTON_NOW), null);
  assert.equal(endedPass(PASSES, first.end), first);
  assert.equal(endedPass(PASSES, second.end + 3600), second);
});

test("filters: bright only, and no Starlink", () => {
  assert.equal(matchesFilters(byId("25544-1792400980"), { brightOnly: true }), true);
  assert.equal(matchesFilters(byId("53807-1792276513"), { brightOnly: true }), false);
  assert.equal(matchesFilters(byId("101007-1792318250"), { hideStarlink: true }), false);
  assert.equal(matchesFilters(byId("101007-1792318250"), {}), true);
  assert.equal(matchesFilters(byId("101007-1792318250"), undefined), true);
});

test("passes are grouped by the part of the day they start in", () => {
  const groups = groupPasses(PASSES, fmt, BOSTON_NOW);
  assert.deepEqual(
    groups.map((g) => [g.label, g.sub, g.passes.length]),
    [
      ["Tonight", "Sat, Oct 17", 2],
      ["Tomorrow morning", "Sun, Oct 18", 2],
      ["Tomorrow evening", "Sun, Oct 18", 1],
      ["Monday morning", "Mon, Oct 19", 1],
      ["Tuesday morning", "Tue, Oct 20", 1],
    ]
  );
  const bright = groupPasses(PASSES, fmt, BOSTON_NOW, { filters: { brightOnly: true } });
  assert.deepEqual(bright.flatMap((g) => g.passes.map((p) => p.id)), ["67304-1792317273", "53807-1792366428", "25544-1792400980"]);
  // Passes that are over leave the list; one going on stays, under the heading of when it began.
  const later = groupPasses(PASSES, fmt, byId("53807-1792276513").end + 5);
  assert.equal(later[0].passes[0].id, "62078-1792277102");
  assert.deepEqual(groupPasses([], fmt, BOSTON_NOW), []);
  assert.deepEqual(groupPasses(undefined, fmt, BOSTON_NOW), []);
  assert.equal(PASSES[0].id, "53807-1792276513", "the caller's list is not reordered");
});

test("a satellite of note riding along is named, and directions come from the first satellite", () => {
  assert.equal(notableMember(byId("67304-1792317273")).name, "ISS");
  assert.equal(notableMember(byId("25544-1792400980")), null, "the ISS itself");
  assert.equal(notableMember(byId("101007-1792318250")), null);
  assert.deepEqual(passDirections(byId("25544-1792400980")), ["NW", "ENE"]);
  assert.deepEqual(passDirections({}), [undefined, undefined]);
});

test("a row says everything about its pass, in words for screen readers", () => {
  const iss = rowParts(byId("25544-1792400980"), fmt);
  assert.equal(
    plain(iss.label),
    "5:09 AM, ISS, Bright pass, dazzling, magnitude −2.1, up to 56°, from NW to ENE, 2 min, 13% cloud cover"
  );
  assert.match(iss.html, /<b>5:09<\/b><small>AM<\/small>/);
  assert.match(iss.html, /class="el"[^>]*>56°</);
  assert.match(iss.html, /class="cloud clear"/);
  assert.match(iss.html, /class="meter l4"/);
  assert.equal((iss.html.match(/<i class="on">/g) || []).length, 5, "all five bars: dazzling");
  const easy = rowParts(byId("62078-1792277102"), fmt);
  assert.equal((easy.html.match(/<i class="on">/g) || []).length, 2, "two bars: easy to see");
  assert.match(iss.html, /class="kind k-station" title="Space station"/);
  assert.match(iss.html, /class="badge star"/);
  assert.doesNotMatch(iss.html, /class="now"/);

  const train = rowParts(byId("101007-1792318250"), fmt);
  assert.equal(train.title, "Starlink train · 22");
  assert.match(train.html, /k-train" title="Starlink train"/);
  assert.match(train.html, /class="cloud partly"/);

  const group = rowParts(byId("67304-1792317273"), fmt);
  assert.match(group.label, /COSMO-SKYMED-FM3 \+1, Bright pass, with ISS, dazzling/);
  assert.match(group.html, /class="badge with">with ISS</);

  const day = rowParts(byId("25544-1792479451"), fmt, { live: true });
  assert.match(day.html, /class="badge day"[^>]*>Daylight</);
  assert.doesNotMatch(day.html, /class="cloud/, "no forecast, no cloud");
  assert.match(day.html, /<span class="now">Now<\/span>/);
  assert.match(day.label, /Daylight/);

  const hostile = rowParts(makePass({ id: "1-1", title: `<img src=x onerror="alert(1)">`, start: BOSTON_NOW + 600 }), fmt);
  assert.doesNotMatch(hostile.html, /<img/);
  assert.match(hostile.html, /&#60;img src=x onerror=&#34;alert\(1\)&#34;&#62;/);
});

test("24-hour times stay whole", () => {
  const h24 = new Formatter(bostonHass({ timeFormat: "24" }), english);
  assert.match(rowParts(byId("53807-1792276513"), h24).html, /<b>18:35<\/b><\/span>/);
});

// ---- The list ----

test("the list draws groups under sticky headings, in order, with the selected pass marked", () => {
  const { list, root, rows, row } = mount();
  list.render(PASSES, { selectedId: "25544-1792400980", nowS: BOSTON_NOW });
  assert.deepEqual(rows(), PASSES.map((p) => p.id));
  const heads = root.querySelectorAll("h3.head").map((h) => [h.querySelector(".lbl").textContent, h.querySelector(".sub").textContent]);
  assert.deepEqual(heads[0], ["Tonight", "Sat, Oct 17"]);
  assert.equal(heads.length, 5);
  assert.equal(row("25544-1792400980").querySelector("button.pick").getAttribute("aria-pressed"), "true");
  assert.equal(row("25544-1792400980").classList.contains("sel"), true);
  assert.equal(row("53807-1792276513").querySelector("button.pick").getAttribute("aria-pressed"), "false");
  assert.equal(root.querySelector(".foot").textContent, "That's all for the next 5 days.");
  assert.equal(root.querySelector(".filters").hidden, false);
  assert.deepEqual(root.querySelectorAll(".filter span").map((s) => s.textContent), ["Bright only", "Hide Starlink"]);
  assert.equal(root.querySelector(".empty").hidden, true);
  // Each row has its two buttons, named for the pass.
  const acts = row("25544-1792400980").querySelectorAll("button.act");
  assert.deepEqual(acts.map((b) => b.dataset.action), ["sim", "street"]);
  assert.equal(plain(acts[0].getAttribute("aria-label")), "Simulate ISS at 5:09 AM");
  assert.equal(plain(acts[1].getAttribute("aria-label")), "Street view of ISS at 5:09 AM");
  assert.deepEqual(acts.map((b) => b.querySelector(".lbl").textContent), ["Simulate", "Street view"]);
  list.destroy();
});

test("only one row is a Tab stop: the selected pass", () => {
  const { list, root } = mount();
  list.render(PASSES, { selectedId: "53807-1792366428", nowS: BOSTON_NOW });
  const stops = root.querySelectorAll("button").filter((b) => b.closest("li") && b.getAttribute("tabindex") === "0");
  assert.deepEqual([...new Set(stops.map((b) => b.closest("li").dataset.id))], ["53807-1792366428"]);
  list.render(PASSES, { selectedId: null, nowS: BOSTON_NOW });
  const first = root.querySelectorAll("li.row")[0].querySelector("button.pick");
  assert.equal(first.getAttribute("tabindex"), "0", "nothing selected: the first pass");
  list.destroy();
});

test("redrawing keeps the rows that did not change, and keyboard focus", () => {
  const { list, root, row } = mount();
  list.render(PASSES, { selectedId: "53807-1792276513", nowS: BOSTON_NOW });
  const li = row("25544-1792400980");
  const pick = li.querySelector("button.pick");
  pick.focus();
  assert.equal(root.activeElement, pick);
  list.render(PASSES, { selectedId: "25544-1792400980", nowS: BOSTON_NOW });
  assert.equal(row("25544-1792400980"), li, "the same element");
  assert.equal(li.querySelector("button.pick"), pick, "not rebuilt: only its state changed");
  assert.equal(root.activeElement, pick);
  // New data for the focused pass rebuilds its row; the focus follows.
  const changed = PASSES.map((p) => (p.id === "25544-1792400980" ? { ...p, cloud_cover: 80 } : p));
  list.render(changed, { selectedId: "25544-1792400980", nowS: BOSTON_NOW });
  assert.notEqual(row("25544-1792400980").querySelector("button.pick"), pick);
  assert.equal(root.activeElement, row("25544-1792400980").querySelector("button.pick"));
  assert.match(row("25544-1792400980").querySelector(".cloud").className, /cloudy/);
  // Focus on a small button stays on the same small button.
  row("53807-1792366428").querySelector('button[data-action="sim"]').focus();
  list.render(PASSES.map((p) => ({ ...p, cloud_cover: 50 })), { selectedId: "25544-1792400980", nowS: BOSTON_NOW });
  assert.equal(root.activeElement, row("53807-1792366428").querySelector('button[data-action="sim"]'));
  list.destroy();
});

test("clicks pick, simulate or open the street view", () => {
  const { list, calls, row } = mount();
  list.render(PASSES, { nowS: BOSTON_NOW });
  row("62078-1792277102").querySelector("button.pick").click();
  row("62078-1792277102").querySelector(".title").click(); // anywhere on the row
  row("25544-1792400980").querySelector('button[data-action="sim"]').click();
  row("25544-1792400980").querySelector('button[data-action="street"] svg').click();
  assert.deepEqual(calls, [
    ["select", "62078-1792277102"], ["select", "62078-1792277102"], ["simulate", "25544-1792400980"], ["street", "25544-1792400980"],
  ]);
  list.destroy();
});

test("without handlers there are no buttons for them", () => {
  const { list, row } = mount({ onSimulate: undefined, onStreet: undefined });
  list.render(PASSES, { nowS: BOSTON_NOW });
  assert.equal(row("25544-1792400980").querySelectorAll("button.act").length, 0);
  list.destroy();
});

test("arrow keys move through the list and select; Enter selects; Space simulates", async () => {
  const { list, root, calls, row } = mount();
  list.render(PASSES, { selectedId: "53807-1792276513", nowS: BOSTON_NOW });
  const pick = (id) => row(id).querySelector("button.pick");
  pick("53807-1792276513").focus();
  const ev = keydown(pick("53807-1792276513"), "ArrowDown");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(root.activeElement, pick("62078-1792277102"));
  assert.deepEqual(calls.at(-1), ["select", "62078-1792277102"]);
  list.render(PASSES, { selectedId: "62078-1792277102", nowS: BOSTON_NOW });
  assert.equal(pick("62078-1792277102").getAttribute("tabindex"), "0");
  keydown(pick("62078-1792277102"), "ArrowUp");
  assert.deepEqual(calls.at(-1), ["select", "53807-1792276513"]);
  keydown(root.activeElement, "End");
  assert.equal(root.activeElement, pick("25544-1792479451"));
  keydown(root.activeElement, "Home");
  assert.equal(root.activeElement, pick("53807-1792276513"));
  keydown(root.activeElement, "ArrowUp");
  assert.equal(root.activeElement, pick("53807-1792276513"), "stays at the top");
  // Held down, the arrow skims the list and selects where it stops.
  calls.length = 0;
  keydown(root.activeElement, "ArrowDown", { repeat: true });
  keydown(root.activeElement, "ArrowDown", { repeat: true });
  keydown(root.activeElement, "ArrowDown", { repeat: true });
  assert.deepEqual(calls, []);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(calls, [["select", "101007-1792318250"]]);
  calls.length = 0;
  const enter = keydown(root.activeElement, "Enter");
  assert.equal(enter.defaultPrevented, true, "no click as well");
  const space = keydown(root.activeElement, " ");
  assert.equal(space.defaultPrevented, true, "the list does not scroll");
  assert.deepEqual(calls, [["select", "101007-1792318250"], ["simulate", "101007-1792318250"]]);
  // On a small button, Enter and Space are that button's own.
  calls.length = 0;
  const street = row("101007-1792318250").querySelector('button[data-action="street"]');
  street.focus();
  assert.equal(keydown(street, "Enter").defaultPrevented, false);
  keydown(street, "ArrowDown");
  assert.equal(root.activeElement, pick("53807-1792366428"), "arrows still move between rows");
  list.destroy();
});

test("the arrow keys only browse: the host is told, so a sheet holding the list can stay open", async () => {
  const picks = [];
  const { list, row } = mount({ onSelect: (id, how) => picks.push([id, !!how?.browse]) });
  list.render(PASSES, { selectedId: "53807-1792276513", nowS: BOSTON_NOW });
  const pick = (id) => row(id).querySelector("button.pick");
  keydown(pick("53807-1792276513"), "ArrowDown");
  keydown(pick("62078-1792277102"), "ArrowDown", { repeat: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  keydown(pick("67304-1792317273"), "Enter");
  pick("101007-1792318250").click();
  assert.deepEqual(picks, [
    ["62078-1792277102", true],
    ["67304-1792317273", true],
    ["67304-1792317273", false],
    ["101007-1792318250", false],
  ]);
  list.destroy();
});

test("the filter chips filter, say what they hide, and are handed back", () => {
  const { list, root, calls, rows } = mount();
  list.render(PASSES, { nowS: BOSTON_NOW });
  const bright = root.querySelector('button[data-filter="brightOnly"]');
  bright.click();
  assert.equal(bright.getAttribute("aria-pressed"), "true");
  assert.deepEqual(calls.at(-1), ["filter", { brightOnly: true, hideStarlink: false }]);
  assert.deepEqual(rows(), ["67304-1792317273", "53807-1792366428", "25544-1792400980"]);
  assert.equal(root.querySelector(".foot .hidden-note").textContent, "4 passes are hidden by the filters. Show all");
  // Kept across redraws that leave the filters out…
  list.render(PASSES, { nowS: BOSTON_NOW });
  assert.equal(rows().length, 3);
  assert.deepEqual(list.filters, { brightOnly: true, hideStarlink: false });
  // …and "Show all" clears them.
  root.querySelector('.foot button[data-action="show-all"]').click();
  assert.equal(rows().length, PASSES.length);
  assert.deepEqual(calls.at(-1), ["filter", { brightOnly: false, hideStarlink: false }]);
  // Filters given to render() win.
  list.render(PASSES, { nowS: BOSTON_NOW, filters: { hideStarlink: true } });
  assert.equal(rows().includes("101007-1792318250"), false);
  assert.equal(root.querySelector('button[data-filter="hideStarlink"]').getAttribute("aria-pressed"), "true");
  list.destroy();
});

test("time moves on: 'in 35 min', then the pass is live, then gone", () => {
  const { list, row } = mount();
  const first = byId("53807-1792276513");
  list.render(PASSES, { nowS: first.start - 35 * 60 });
  assert.equal(row(first.id).querySelector(".rel").textContent, "in 35 min");
  assert.equal(row("62078-1792277102").querySelector(".rel").textContent, "in 45 min");
  assert.equal(row("25544-1792400980").querySelector(".rel").textContent, "", "days away: no countdown");
  list.setNow(first.start - 2 * 3600 - 600);
  assert.equal(row(first.id).querySelector(".rel").textContent, "in 2 h");
  const li = row(first.id);
  list.setNow(first.start + 1);
  assert.equal(row(first.id).classList.contains("live"), true);
  assert.equal(row(first.id).querySelector(".now").textContent, "Now");
  assert.equal(row(first.id), li, "the same row, drawn live");
  row(first.id).querySelector("button.pick").focus();
  list.setNow(first.end);
  assert.equal(row(first.id), null, "over: off the list");
  assert.equal(list._root.activeElement, row("62078-1792277102").querySelector("button.pick"), "focus moves to the next pass");
  list.destroy();
});

test("the headings follow the clock: after midnight tomorrow's passes are this morning's and tonight's", () => {
  const { list, root } = mount();
  const passes = [
    makePass({ id: "25544-1792228200", title: "ISS", kind: "iss", start: at("2026-10-18T05:10:00-04:00") }),
    makePass({ id: "53807-1792278600", title: "BlueWalker 3", start: at("2026-10-18T19:10:00-04:00") }),
  ];
  const headings = () => root.querySelectorAll(".head .lbl").map((el) => el.textContent);
  const before = at("2026-10-17T23:58:00-04:00");
  list.render(passes, { nowS: before });
  assert.deepEqual(headings(), ["Tomorrow morning", "Tomorrow evening"]);
  // Only the hosts' every-second setNow(), no new passes.
  for (let s = before; s <= at("2026-10-18T00:04:00-04:00"); s++) list.setNow(s);
  assert.deepEqual(headings(), ["This morning", "Tonight"]);
  list.destroy();
});

test("nothing to list: why not, or what the filters hide", () => {
  const { list, root } = mount();
  list.render([], { nowS: BOSTON_NOW });
  const empty = root.querySelector(".empty");
  assert.equal(empty.hidden, false);
  assert.equal(root.querySelector(".scroll").hidden, true);
  assert.equal(empty.querySelector("h3").textContent, "No satellites bright enough to see in the next 5 days.");
  assert.deepEqual(empty.querySelectorAll("h4").map((h) => h.textContent), ["Why not?", "Check back later"]);
  assert.match(empty.textContent, /in Earth's shadow/);
  list.render([], { nowS: BOSTON_NOW, emptyText: "Predictions paused" });
  assert.equal(empty.querySelector("h3").textContent, "Predictions paused");
  assert.equal(empty.querySelectorAll("h4").length, 0);
  list.render([PASSES[0]], { nowS: BOSTON_NOW, filters: { brightOnly: true } });
  assert.equal(empty.querySelector("h3").textContent, "No pass matches the filters.");
  empty.querySelector('button[data-action="show-all"]').click();
  assert.equal(empty.hidden, true);
  assert.equal(root.querySelectorAll("li.row").length, 1);
  list.render([], { nowS: BOSTON_NOW, days: 1 });
  assert.equal(empty.querySelector("h3").textContent, "No satellites bright enough to see in the next day.");
  list.destroy();
});

test("compact lists, for cards, have no chips and no footer", () => {
  const { list, root } = mount({ compact: true });
  list.render(PASSES.slice(0, 3), { nowS: BOSTON_NOW });
  assert.equal(root.querySelector(".filters").hidden, true);
  assert.equal(root.querySelector(".foot").hidden, true);
  assert.equal(root.querySelector(".pl").classList.contains("compact"), true);
  assert.equal(root.querySelectorAll("li.row").length, 3);
  list.destroy();
});

test("focusSelected focuses the selected pass and scrolls only the list to it", () => {
  const { list, root, row } = mount();
  list.render(PASSES, { selectedId: "25544-1792400980", nowS: BOSTON_NOW });
  const scroll = root.querySelector(".scroll");
  scroll.rect = { top: 100, left: 0, width: 300, height: 200 };
  row("25544-1792400980").rect = { top: 420, left: 0, width: 300, height: 52 };
  row("25544-1792400980").closest("section").querySelector(".head").rect = { top: 100, left: 0, width: 300, height: 26 };
  list.focusSelected();
  assert.equal(root.activeElement, row("25544-1792400980").querySelector("button.pick"));
  assert.equal(scroll.scrollTop, 294, "up to the top of the list, right under its sticky heading");
  // The arrow keys scroll no more than they must: the next row's bottom lines up with the list's.
  scroll.scrollTop = 0;
  row("25544-1792479451").rect = { top: 330, left: 0, width: 300, height: 52 };
  keydown(root.activeElement, "ArrowDown");
  assert.equal(scroll.scrollTop, 82);
  list.destroy();
});

test("a pass selected from outside is scrolled into view; one picked in the list is not", () => {
  const { list, root, row } = mount();
  list.render(PASSES, { selectedId: null, nowS: BOSTON_NOW });
  const scroll = root.querySelector(".scroll");
  scroll.rect = { top: 0, left: 0, width: 300, height: 200 };
  row("25544-1792400980").rect = { top: 400, left: 0, width: 300, height: 50 };
  row("25544-1792400980").closest("section").querySelector(".head").rect = { top: 0, left: 0, width: 300, height: 26 };
  list.render(PASSES, { selectedId: "25544-1792400980", nowS: BOSTON_NOW });
  assert.equal(scroll.scrollTop, 374, "to the top, right below the heading, so the pass before is hidden under it");
  scroll.scrollTop = 0;
  row("25544-1792479451").rect = { top: 460, left: 0, width: 300, height: 50 };
  row("25544-1792479451").querySelector("button.pick").click();
  list.render(PASSES, { selectedId: "25544-1792479451", nowS: BOSTON_NOW });
  assert.equal(scroll.scrollTop, 0);
  list.destroy();
});

test("the sticky headings are opaque, and rows stop below them when the browser scrolls to one", () => {
  const { list, root } = mount();
  list.render(PASSES, { nowS: BOSTON_NOW });
  const css = root.querySelector("style").textContent;
  // The declarations of the rule for exactly this selector.
  const rule = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    return start < 0 ? "" : css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  };
  const height = /--pl-head: (\d+)px/.exec(rule(".pl"))?.[1];
  assert.ok(Number(height) > 0, "the heading height is a token");
  assert.match(rule(".head"), /height: var\(--pl-head\)/);
  assert.match(rule(".head"), /background: var\(--sat-pl-head, #[0-9a-f]{6}\)/, "opaque by default");
  assert.match(rule(".row"), /scroll-margin-top: var\(--pl-head\)/);
  assert.match(rule(".row button"), /scroll-margin-top: var\(--pl-head\)/, "keyboard focus lands below the heading too");
  list.destroy();
});

// ---- The sky: cloud and Moon ----

test("the cloud forecast is for the first hour after the pass starts", () => {
  const iss = byId("25544-1792400980"); // 05:09:40 EDT
  assert.equal(cloudHour(iss), at("2026-10-19T06:00:00-04:00"));
  assert.equal(cloudHour({ start: at("2026-10-19T06:00:00-04:00") }), at("2026-10-19T07:00:00-04:00"), "on the hour: the next one");
  assert.equal(cloudHour({}), null);
  assert.equal(plain(cloudText(iss, fmt)), "13% cloud at 6 AM");
  assert.equal(plain(cloudText(byId("53807-1792276513"), fmt)), "7% cloud at 7 PM");
  assert.equal(cloudText(byId("25544-1792479451"), fmt), "", "no forecast");
  const h24 = new Formatter(bostonHass({ timeFormat: "24" }), english);
  assert.equal(plain(cloudText(iss, h24)), "13% cloud at 06:00");
  // A time zone half an hour off UTC keeps its minutes.
  const india = new Formatter({ ...bostonHass(), config: { time_zone: "Asia/Kolkata", unit_system: { length: "km" } } }, english);
  assert.equal(plain(cloudText(iss, india)), "13% cloud at 3:30 PM");
  // The row says it when asked.
  assert.match(rowParts(iss, fmt).html, /class="cloud clear" title="Clear sky · 13% cloud at 6 AM"/);
});

test("the Moon during a pass is sat-astro's, and agrees with Skyfield", () => {
  // Skyfield 1.55 with JPL DE421, no refraction (build/i1/skyref/moon_ref.py).
  const SKYFIELD = [
    { observer: BOSTON, t: 1792276616, elevation: 20.795, azimuth: 185.962, fraction: 0.4321 },
    { observer: BOSTON, t: 1792537775, elevation: 29.726, azimuth: 157.651, fraction: 0.7158 },
    { observer: VEENENDAAL, t: 1792604930, elevation: 21.318, azimuth: 146.149, fraction: 0.7833 },
  ];
  for (const ref of SKYFIELD) {
    const pass = { id: `x-${ref.t}`, start: ref.t - 100, end: ref.t + 100, peak: { time: ref.t } };
    const moon = passMoon(pass, ref.observer);
    const date = ref.t * 1000;
    const sky = astro.moonAzEl(date, ref.observer);
    const phase = astro.moonPhase(date);
    // Exactly sat-astro's Moon and phase, at the pass's highest point.
    assert.equal(moon.time, ref.t);
    assert.equal(moon.elevation, sky.elevation);
    assert.equal(moon.azimuth, sky.azimuth);
    assert.equal(moon.fraction, phase.fraction);
    assert.equal(moon.waxing, phase.waxing);
    assert.equal(moon.direction, compass(sky.azimuth));
    assert.equal(moon.litSide, astro.skyDirection(sky, astro.sunAzEl(date, ref.observer)));
    // And where Skyfield puts it.
    close(moon.elevation, ref.elevation, 0.5, "elevation");
    close(moon.azimuth, ref.azimuth, 0.5, "azimuth");
    close(moon.fraction, ref.fraction, 0.01, "lit");
  }
});

test("the Moon counts only when it is up and over 40 % lit, at night", () => {
  const evening = byId("53807-1792276513"); // Saturday 18:35 EDT: a 43 % Moon low in the south
  const moon = passMoon(evening, BOSTON);
  assert.ok(moon);
  assert.equal(plain(moonText(moon, fmt)), "Moon 43% lit, 21° up in the S");
  assert.ok(moon.waxing);
  close(moon.litSide, 90, 25, "lit on the right, towards the set Sun");
  assert.equal(passMoon(byId("25544-1792400980"), BOSTON), null, "Monday 05:09 EDT: the Moon has set");
  assert.equal(passMoon({ ...evening, before_sunset: true }, BOSTON), null, "a daylight pass: the sky is bright anyway");
  assert.equal(passMoon(evening, null), null, "no place, no Moon");
  assert.equal(passMoon(evening, { latitude: "x", longitude: 1 }), null);
  // A thin crescent, up in the evening twilight (Wednesday 14 Oct, 9 % lit): no matter.
  const crescent = { id: "c", start: at("2026-10-14T18:40:00-04:00"), end: at("2026-10-14T18:44:00-04:00"), peak: { time: at("2026-10-14T18:42:00-04:00") } };
  assert.ok(astro.moonAzEl(crescent.peak.time * 1000, BOSTON).elevation > 0, "the crescent is up");
  assert.ok(astro.moonPhase(crescent.peak.time * 1000).fraction < 0.4);
  assert.equal(passMoon(crescent, BOSTON), null);
  // Without a peak time, the middle of the pass.
  assert.equal(passMoon({ ...evening, peak: undefined }, BOSTON).time, (evening.start + evening.end) / 2);
  // Worked out once per pass and place.
  assert.equal(passMoon(evening, BOSTON), moon);
});

test("the Moon's glyph shows its lit part, turned as it is in the sky", () => {
  const moon = passMoon(byId("53807-1792276513"), BOSTON);
  const svg = moonGlyph(moon);
  assert.match(svg, /^<svg class="moon-glyph" viewBox="-12 -12 24 24" aria-hidden="true"/);
  assert.match(svg, /<circle r="8.6" fill="currentColor" fill-opacity=".18"/);
  assert.ok(svg.includes(`<path d="${astro.moonLitPath(8.6, moon.fraction, moon.litSide)}" fill="currentColor"/>`));
  const titled = moonGlyph(moon, { title: "Moon <43%>" });
  assert.match(titled, /role="img" aria-label="Moon &#60;43%&#62;"><title>Moon &#60;43%&#62;<\/title>/);
});

test("a row shows a small Moon beside the cloud when it applies, with the same words", () => {
  const evening = byId("53807-1792276513");
  const moon = passMoon(evening, BOSTON);
  const parts = rowParts(evening, fmt, { moon });
  assert.match(parts.html, /<span class="sky"><span class="moon" title="Moon 43% lit, 21° up in the S"><svg class="moon-glyph"/);
  assert.ok(parts.html.indexOf('class="moon"') < parts.html.indexOf('class="cloud'), "the Moon, then the cloud");
  assert.match(plain(parts.label), /7% cloud cover, Moon 43% lit, 21° up in the S$/);
  assert.doesNotMatch(rowParts(evening, fmt).html, /class="moon"/);
  // A Moon and no forecast: the Moon alone.
  assert.match(rowParts({ ...evening, cloud_cover: null }, fmt, { moon }).html, /<span class="sky"><span class="moon"[^]*<\/svg><\/span><\/span>/);
  // The list works it out for each pass, given the place.
  const { list, row } = mount();
  list.render(PASSES, { nowS: BOSTON_NOW, location: BOSTON });
  const moons = PASSES.filter((p) => row(p.id).querySelector(".moon")).map((p) => p.id);
  assert.deepEqual(moons, PASSES.filter((p) => passMoon(p, BOSTON)).map((p) => p.id));
  assert.deepEqual(moons, ["53807-1792276513", "62078-1792277102", "53807-1792366428"], "the evening passes");
  list.render(PASSES, { nowS: BOSTON_NOW });
  assert.equal(PASSES.filter((p) => row(p.id).querySelector(".moon")).length, 0, "no place, no Moon");
  list.destroy();
});

test("the brightest satellite of a pass, and the filters' values", () => {
  const group = structuredClone(byId("67304-1792317273"));
  group.transits[1].magnitude = -2.7;
  group.transits[0].magnitude = 1.7;
  assert.equal(brightestMember(group).name, "ISS");
  assert.equal(brightestMember(byId("25544-1792400980")).name, "ISS", "alone");
  assert.equal(brightestMember({ transits: [{ name: "A" }, { name: "B" }] }).name, "A", "no magnitudes: the first");
  assert.equal(brightestMember({}), null);
  assert.deepEqual(normalizeFilters(), { brightOnly: false, hideStarlink: false });
  assert.deepEqual(normalizeFilters({ brightOnly: true, hideStarlink: "yes" }), { brightOnly: true, hideStarlink: false });
});

test("destroy lets go of everything", async () => {
  const { list, root, calls, host } = mount();
  list.render(PASSES, { nowS: BOSTON_NOW });
  const pick = root.querySelector("button.pick");
  list.destroy();
  assert.equal(host.shadowRoot.childNodes.length, 0);
  pick.click();
  assert.deepEqual(calls, []);
  list.render(PASSES, { nowS: BOSTON_NOW }); // harmless
  list.setNow(BOSTON_NOW);
  await flush();
});
