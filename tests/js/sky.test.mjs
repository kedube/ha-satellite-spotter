// Tests for the "Where to look" sky chart: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { placeLabels, skyChartSvg, skyDotTransform, skyDotXY, skyPoints, skyXY } from "../../custom_components/satellite_spotter/frontend/sat-sky.js";

const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);

const track = [
  { t: 0, azimuth: 225, elevation: 2 },
  { t: 60, azimuth: 200, elevation: 30 },
  { t: 120, azimuth: 120, elevation: 67 },
  { t: 180, azimuth: 60, elevation: 25 },
  { t: 240, azimuth: 45, elevation: 3 },
];

test("sky chart geometry and SVG", () => {
  const [cx, cy] = skyXY(0, 90, 100, 110); // zenith is the centre
  close(cx, 110, 1e-9);
  close(cy, 110, 1e-9);
  const [nx, ny] = skyXY(0, 0, 100, 110); // north on the horizon is at the top
  close(nx, 110, 1e-9);
  close(ny, 10, 1e-9);
  const [ex] = skyXY(90, 0, 100, 110); // east to the right
  close(ex, 210, 1e-9);

  const svg = skyChartSvg({
    track, visibleStart: 60, visibleEnd: 180, live: { azimuth: 120, elevation: 67 },
    formatTime: (t) => `T${t}`,
  });
  assert.match(svg, /^<svg/);
  assert.match(svg, />T60</);
  assert.match(svg, />T180</);
  assert.match(svg, />67°</);
  assert.match(svg, /class="live"/);
  assert.doesNotMatch(svg, /NaN/);
  assert.match(svg, /aria-label="Sky chart of the pass"/);
  assert.doesNotMatch(skyChartSvg({ track: [], visibleStart: 0, visibleEnd: 1, formatTime: String }), /class="vis"/);
  // Translated, and escaped.
  const de = skyChartSvg({ track, visibleStart: 60, visibleEnd: 180, formatTime: String, cardinals: ["N", "O", "S", "W"], label: `Himmels"karte` });
  assert.deepEqual([...de.matchAll(/class="card">([^<]*)</g)].map((m) => m[1]), ["N", "O", "S", "W"]);
  assert.match(de, /aria-label="Himmels&#34;karte"/);
  assert.match(skyChartSvg({ track, visibleStart: 60, visibleEnd: 180, formatTime: () => "<b>" }), /&#60;b&#62;/);
});

test("the live dot moves only while the satellite is above the horizon", () => {
  assert.equal(skyDotXY(null), null);
  assert.equal(skyDotXY({ azimuth: 10, elevation: -1 }), null);
  const [x, y] = skyDotXY({ azimuth: 0, elevation: 90 }, 200);
  assert.deepEqual([x, y], [100, 100]);
  assert.equal(skyDotTransform([12.345, 6.789]), "translate(12.3 6.8)");
  const hidden = skyChartSvg({ track, visibleStart: 60, visibleEnd: 180, formatTime: String });
  assert.match(hidden, /class="live-dot"[^>]*display="none"/);
});

test("the other satellites of a pass are thin paths beneath the main one", () => {
  const member = { track: track.map((p) => ({ ...p, azimuth: p.azimuth + 8 })), visibleStart: 50, visibleEnd: 200 };
  const svg = skyChartSvg({ track, visibleStart: 60, visibleEnd: 180, formatTime: String, members: [member, member] });
  assert.equal([...svg.matchAll(/class="m-vis"/g)].length, 2);
  assert.equal([...svg.matchAll(/class="m-above"/g)].length, 2);
  assert.ok(svg.indexOf('class="m-vis"') < svg.indexOf('class="vis"'), "members first, the main path on top");
  // Members below the horizon, or with nothing visible, draw nothing visible.
  const low = { track: [{ t: 0, azimuth: 10, elevation: -5 }, { t: 60, azimuth: 20, elevation: -1 }], visibleStart: 0, visibleEnd: 60 };
  assert.doesNotMatch(skyChartSvg({ track, visibleStart: 60, visibleEnd: 180, formatTime: String, members: [low] }), /m-vis|m-above/);
  // A whole train is capped.
  const many = Array.from({ length: 40 }, () => member);
  assert.equal([...skyChartSvg({ track, visibleStart: 60, visibleEnd: 180, formatTime: String, members: many }).matchAll(/class="m-vis"/g)].length, 24);
});

test("the brightest moment gets a star with the magnitude, sharing the top's label when close", () => {
  // Brightest at the highest point: one label for both.
  const atTop = skyChartSvg({
    track, visibleStart: 60, visibleEnd: 180, formatTime: String, brightest: { azimuth: 120, elevation: 67, text: "−3.4" },
  });
  assert.match(atTop, /class="star"/);
  assert.match(atTop, />67° · −3\.4</);
  // Elsewhere: its own label.
  const apart = skyChartSvg({
    track, visibleStart: 60, visibleEnd: 180, formatTime: String, brightest: { azimuth: 200, elevation: 30, text: "<−1.2>" },
  });
  assert.match(apart, /class="star"/);
  assert.match(apart, /class="lbl mag">&#60;−1\.2&#62;</);
  assert.match(apart, />67°</);
  assert.doesNotMatch(apart, /NaN/);
  // No visible path, no star.
  assert.doesNotMatch(skyChartSvg({ track: [], visibleStart: 0, visibleEnd: 1, formatTime: String, brightest: { azimuth: 0, elevation: 10, text: "1" } }), /class="star"/);
});

test("the sky chart's gradient id can be chosen, for two charts in one page", () => {
  const args = { track: [], visibleStart: 0, visibleEnd: 1, formatTime: String };
  const plain = skyChartSvg(args);
  assert.match(plain, /<radialGradient id="sky"/);
  assert.match(plain, /fill="url\(#sky\)"/);
  const pop = skyChartSvg({ ...args, id: "sky-pop" });
  assert.match(pop, /<radialGradient id="sky-pop"/);
  assert.match(pop, /fill="url\(#sky-pop\)"/);
  assert.doesNotMatch(pop, /id="sky"/);
});

test("a small chart can leave the times out, and its other labels keep their places", () => {
  const brightest = { azimuth: 200, elevation: 30, text: "−1.2" };
  const timed = skyChartSvg({ track, visibleStart: 60, visibleEnd: 180, formatTime: (t) => `T${t}`, brightest, size: 168 });
  const quiet = skyChartSvg({ track, visibleStart: 60, visibleEnd: 180, formatTime: (t) => `T${t}`, times: false, brightest, size: 168 });
  const texts = (svg) => [...svg.matchAll(/<text [^>]*class="lbl[^"]*">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(texts(timed).sort(), ["67°", "T180", "T60", "−1.2"].sort());
  assert.deepEqual(texts(quiet).sort(), ["67°", "−1.2"].sort(), "no time labels, and no empty ones");
  // No formatter at all: no times either.
  assert.deepEqual(texts(skyChartSvg({ track, visibleStart: 60, visibleEnd: 180, size: 168 })), ["67°"]);
  // The highest point's label stays beside its point, no further than with the times.
  const peak = (svg) => /<text x="([\d.]+)" y="([\d.]+)" class="lbl peak">/.exec(svg).slice(1).map(Number);
  const c = 168 / 2;
  const [px, py] = skyXY(120, 67, c - 22, c);
  const away = (svg) => Math.hypot(peak(svg)[0] - px, peak(svg)[1] - py);
  assert.ok(away(quiet) <= Math.max(away(timed), 20), `${away(quiet)} px from its point`);
});

test("labels stay inside the chart", () => {
  const edge = [
    { t: 0, azimuth: 270, elevation: 0.5 },
    { t: 60, azimuth: 300, elevation: 20 },
    { t: 120, azimuth: 90, elevation: 0.5 },
  ];
  const svg = skyChartSvg({ track: edge, visibleStart: 0, visibleEnd: 120, formatTime: () => "8:41 PM", size: 200 });
  for (const [, x] of svg.matchAll(/<text x="([\d.-]+)"[^>]*class="lbl/g)) {
    assert.ok(Number(x) >= 16 && Number(x) <= 184, `label at x ${x}`);
  }
});

test("pass_track rows give the chart its points directly", () => {
  const rows = [
    [1000, 30, -90, 423, 0, 239.2, -0.1, 2373, null, 0],
    [1002, 30.1, -89.9, 423, 1, 239.5, 0.3, 2350, 3.4, 0],
  ];
  assert.deepEqual(skyPoints(rows), [
    { t: 1000, azimuth: 239.2, elevation: -0.1, mag: null },
    { t: 1002, azimuth: 239.5, elevation: 0.3, mag: 3.4 },
  ]);
  assert.equal(skyPoints(rows, 60)[0].t, 1060, "a train member drawn as a later copy of the leader");
  assert.deepEqual(skyPoints(null), []);
});

test("labels make way for each other and for the chart's own", () => {
  // An end and a highest point close together (a short pass low in the east).
  const labels = [
    { x: 150, y: 96, text: "7:20 PM" },
    { x: 152, y: 128, text: "7:22 PM" },
    { x: 150, y: 122, text: "30° · 2.2" },
  ];
  const at = placeLabels(labels, { size: 200, obstacles: [{ x1: 140, x2: 160, y1: 80, y2: 89 }] });
  const box = (i) => {
    const w = labels[i].text.length * 5.9 + 4;
    return { x1: at[i].x - w / 2, x2: at[i].x + w / 2, y1: at[i].y - 9, y2: at[i].y + 2 };
  };
  const overlaps = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) assert.ok(!overlaps(box(i), box(j)), `labels ${i} and ${j} overlap`);
    assert.ok(box(i).x1 >= 0 && box(i).x2 <= 200 && box(i).y1 >= 0 && box(i).y2 <= 200, `label ${i} inside`);
  }
  assert.ok(!overlaps(box(0), { x1: 140, x2: 160, y1: 80, y2: 89 }), "clear of the ring label");
  // With room, a label sits right above its point.
  assert.deepEqual(placeLabels([{ x: 100, y: 100, text: "8:41 PM" }], { size: 200 }), [{ x: 100, y: 91 }]);
});
