// Tests for the street view's sky (sat-planetarium.js): the projector against
// MapLibre's own camera matrix, framing, the sky's colours and the stars'
// visibility, the satellite paths, ticks, labels, the edge arrow and the
// occlusion read-back: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { skyColor, skyPalette } from "../../custom_components/satellite_spotter/frontend/sat-astro.js";
import {
  LABEL_SPACING_PX,
  LIGHT_POLLUTION,
  Planetarium,
  apparentMagnitude,
  bandFor,
  buildTracks,
  dotRadius,
  edgeArrow,
  frameView,
  hiddenStretches,
  horizonGlowPenalty,
  limitingMagnitude,
  magnitudeWidth,
  makeProjector,
  occlusionFromBand,
  pathRuns,
  placeLabels,
  sampleAt,
  skyColorAt,
  skyModel,
  skylineAt,
  spacedLabels,
  starVisible,
  tickTimes,
  timeToEntry,
  trackFromRows,
  arrowPill,
} from "../../custom_components/satellite_spotter/frontend/sat-planetarium.js";
import { fakeCanvas, fakeFormatter, syntheticPass } from "./helpers/street-fakes.mjs";
import { maplibreCamera, maplibrePixel } from "./helpers/street-math.mjs";

const DEG = Math.PI / 180;
const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);
const dirOf = (az, el) => [Math.sin(az * DEG) * Math.cos(el * DEG), -Math.cos(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG)];

// ---- the camera --------------------------------------------------------------

test("the projector puts directions exactly where MapLibre's camera matrix does", () => {
  const views = [
    { bearing: 35, pitch: 95, fov: 50, width: 1280, height: 720 },
    { bearing: 125, pitch: 120, fov: 50, width: 1280, height: 720 },
    { bearing: 240, pitch: 150, fov: 70, width: 390, height: 844 },
    { bearing: 300, pitch: 178, fov: 90, width: 800, height: 600 },
    { bearing: 10, pitch: 82, fov: 40, width: 500, height: 300 },
    { bearing: 77, pitch: 104, roll: 12, fov: 55, width: 1280, height: 720 },
  ];
  let worst = 0;
  let checked = 0;
  for (const view of views) {
    const P = makeProjector(view);
    const cam = maplibreCamera(view);
    for (let az = 0; az < 360; az += 7.5) {
      for (let el = -5; el <= 89; el += 6.5) {
        const ours = P.project(az, el);
        const theirs = maplibrePixel(cam, dirOf(az, el));
        assert.equal(ours === null, theirs === null, `${JSON.stringify(view)} az ${az} el ${el}: in front`);
        if (!ours || Math.abs(ours[0]) > 1e5 || Math.abs(ours[1]) > 1e5) continue;
        worst = Math.max(worst, Math.hypot(ours[0] - theirs[0], ours[1] - theirs[1]));
        checked++;
      }
    }
  }
  assert.ok(checked > 500, `${checked} points`);
  assert.ok(worst < 1e-6, `${worst} px`);
});

test("unproject inverts project, and the horizon is elevation 0", () => {
  const P = makeProjector({ bearing: 212, pitch: 113, roll: 4, fov: 64, width: 1000, height: 700 });
  for (const [x, y] of [[0, 0], [500, 350], [999, 699], [123, 456], [870, 40]]) {
    const { azimuth, elevation } = P.unproject(x, y);
    const back = P.project(azimuth, elevation);
    close(back[0], x, 1e-6, "x");
    close(back[1], y, 1e-6, "y");
  }
  // Level camera: the horizon runs through the middle; 90 straight up is behind the top edge.
  const level = makeProjector({ bearing: 0, pitch: 90, fov: 60, width: 800, height: 600 });
  close(level.project(0, 0)[1], 300, 1e-9);
  close(level.project(0, 30)[1], 0, 1e-9, "the top edge is half the field of view up");
  assert.equal(level.project(180, 0), null, "behind");
  assert.ok(level.project(90, 0) === null || level.project(90, 0)[0] > 1e6, "90° to the side is at infinity");
});

test("a pass is framed inside the HUD's safe area, with the horizon when it fits", () => {
  const arc = (from, to, peak) =>
    Array.from({ length: 61 }, (_, i) => {
      const f = i / 60;
      return { azimuth: (from + (to - from) * f + 360) % 360, elevation: 10 + (peak - 10) * Math.sin(Math.PI * f) };
    });
  const safe = { top: 0.17, bottom: 0.14, left: 0.04, right: 0.06 };
  const fit = (points, view, aspect = 1.6) => {
    const P = makeProjector({ ...view, width: 1600, height: 1000 * (1.6 / aspect) });
    return points.filter((s) => {
      const q = P.project(s.azimuth, s.elevation);
      return q && q[0] >= 1600 * 0.04 && q[0] <= 1600 * 0.94 && q[1] >= P.height * 0.17 && q[1] <= P.height * 0.86;
    }).length / points.length;
  };
  // A low pass in the south: all of it, and the skyline.
  const low = arc(150, 210, 25);
  const v1 = frameView(low, { aspect: 1.6, safe });
  assert.equal(fit(low, v1), 1);
  const P1 = makeProjector({ ...v1, width: 1600, height: 1000 });
  const horizon = P1.project(v1.bearing, 0);
  assert.ok(horizon && horizon[1] > 170 && horizon[1] < 860, "horizon in view");
  assert.ok(v1.fov <= 70, `zoomed in: fov ${v1.fov}`);
  // A higher, longer pass: nearly all of it, its peak included.
  const mid = arc(200, 330, 55);
  const v2 = frameView(mid, { aspect: 1.6, safe });
  assert.ok(fit(mid, v2) >= 0.85, `${fit(mid, v2)}`);
  assert.equal(fit([mid[30]], v2), 1, "the peak");
  // An overhead pass from horizon to horizon cannot fit in 90°: most of it, looking up.
  const over = arc(230, 410, 88);
  const v3 = frameView(over, { aspect: 1.6, safe });
  assert.ok(fit(over, v3) >= 0.5, `${fit(over, v3)}`);
  assert.ok(v3.pitch > 100, "looks up");
  // Phones: narrow and tall.
  const v4 = frameView(mid, { aspect: 390 / 844, safe: { top: 0.2, bottom: 0.12, left: 0.04, right: 0.14 } });
  assert.ok(v4.fov >= 50 && v4.fov <= 90);
  assert.deepEqual(frameView([]), { bearing: 180, pitch: 100, fov: 60 });
});

// ---- the sky's light ---------------------------------------------------------

test("the sky's colour follows sat-astro's, plus the town's glow and the haze below the horizon", () => {
  const sun = { azimuth: 250, elevation: -6 };
  // Rural with the Sun high enough for no town glow: exactly sat-astro's colours.
  const day = { azimuth: 120, elevation: 15 };
  const m = skyModel(day, { lightPollution: "rural" });
  for (const [az, el] of [[0, 0], [120, 2], [300, 40], [120, 85]]) {
    const ours = skyColorAt(m, az, el);
    const theirs = skyColor(az, el, day, skyPalette(day.elevation));
    for (let i = 0; i < 3; i++) close(ours[i], theirs[i], 0.51, `${az}/${el}`);
  }
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const twilight = skyModel(sun, { lightPollution: "rural" });
  assert.ok(lum(skyColorAt(twilight, 250, 3)) > lum(skyColorAt(twilight, 70, 3)) + 15, "glow on the Sun's side");
  assert.ok(lum(skyColorAt(twilight, 250, -4)) < lum(skyColorAt(twilight, 250, 1)), "darker haze below the horizon");
  // At night a city's glow lights the bottom of the sky, not the top.
  const night = { azimuth: 0, elevation: -30 };
  const city = skyModel(night, { lightPollution: "city" });
  const rural = skyModel(night, { lightPollution: "rural" });
  assert.ok(lum(skyColorAt(city, 90, 2)) > lum(skyColorAt(rural, 90, 2)) + 20);
  close(lum(skyColorAt(city, 90, 85)), lum(skyColorAt(rural, 90, 85)), 4, "zenith barely changes");
  // No town glow while the twilight is still bright.
  assert.equal(skyModel({ azimuth: 0, elevation: -1 }, { lightPollution: "city" }).dome, 0);
});

test("how faint a star can be: twilight, the Moon, light pollution and the air", () => {
  assert.equal(limitingMagnitude(-30, { lightPollution: "rural" }), 6);
  assert.equal(limitingMagnitude(-30, { lightPollution: "suburban" }), LIGHT_POLLUTION.suburban.limit);
  assert.equal(limitingMagnitude(-30, { lightPollution: "city" }), 4);
  assert.ok(limitingMagnitude(-8) < 3, "nautical twilight shows the brightest stars only");
  assert.ok(limitingMagnitude(5) < 0, "day: none");
  assert.ok(limitingMagnitude(-30, { lightPollution: "rural", moon: { elevation: 50, fraction: 1 } }) < 4.5, "full Moon");
  // Extinction: a magnitude 2 star at the zenith, but not near the horizon.
  close(apparentMagnitude(2, 90), 2, 1e-9);
  assert.ok(apparentMagnitude(2, 5) > 4);
  assert.ok(starVisible(2, 60, 4));
  assert.ok(!starVisible(2, 3, 4), "lost in the murk low down");
  assert.ok(!starVisible(-1, -0.5, 6), "below the horizon");
  assert.ok(starVisible(3.5, 40, 4.5));
  assert.ok(!starVisible(3.5, 10, 4.5, 1), "a city's glow over the horizon");
  assert.ok(horizonGlowPenalty(5, 1) > horizonGlowPenalty(45, 1));
  assert.equal(horizonGlowPenalty(10, 0), 0);
});

// ---- the satellites' paths ---------------------------------------------------

test("pass_track rows become typed tracks; a train's members without rows follow the primary", () => {
  const { pass, detail } = syntheticPass({ members: 3, train: true });
  const tracks = buildTracks(pass, detail);
  assert.equal(tracks.length, 4);
  assert.ok(tracks[0].primary && !tracks[1].primary);
  assert.equal(tracks[0].data.n, detail.transits[0].rows.length);
  assert.equal(tracks[2].data, tracks[0].data, "shares the primary's samples");
  assert.ok(tracks[2].shifted);
  assert.equal(tracks[2].offset, 40);
  assert.equal(tracks[0].startReason, "shadow");
  assert.equal(tracks[0].endReason, "set");
  // A member 40 s behind is where the primary was 40 s before.
  const t = pass.start + 100;
  const member = sampleAt(tracks[2].data, t, tracks[2].offset);
  const primary = sampleAt(tracks[0].data, t - 40);
  close(member.azimuth, primary.azimuth, 1e-9);
  close(member.elevation, primary.elevation, 1e-9);
  // The primary is found by its id even when it is not first.
  const swapped = { ...detail, transits: [detail.transits[1], detail.transits[0]].map((tr, i) => ({ ...tr, rows: detail.transits[0].rows, offset_s: i ? 0 : 20 })) };
  assert.equal(buildTracks(pass, swapped)[0].id, 25544);
  assert.deepEqual(buildTracks(pass, { transits: [] }), []);
});

test("positions between samples are interpolated, across north too", () => {
  const rows = [
    [100, 0, 0, 400, 1, 358, 20, 1000, -1, 1],
    [102, 0, 0, 400, 1, 2, 22, 1000, -1.4, 1],
    [104, 0, 0, 400, 0, 6, 24, 1000, null, 0],
  ];
  const d = trackFromRows(rows);
  const s = sampleAt(d, 101);
  close(s.azimuth > 180 ? s.azimuth - 360 : s.azimuth, 0, 0.05, "through north, not round the back");
  close(s.elevation, 21, 0.05);
  close(s.magnitude, -1.2, 1e-6);
  assert.equal(s.lit, true);
  assert.equal(sampleAt(d, 103.5).lit, false);
  assert.equal(sampleAt(d, 103.5).magnitude, null, "no magnitude in shadow");
  assert.equal(sampleAt(d, 99), null);
  assert.equal(sampleAt(d, 104.5), null);
  assert.equal(sampleAt(d, 104).elevation.toFixed(6), (24).toFixed(6));
});

test("paths split into visible, sunlit and shadow runs that join up", () => {
  const { detail } = syntheticPass({ litFrom: 100 });
  const d = trackFromRows(detail.transits[0].rows);
  const runs = pathRuns(d);
  const styles = runs.map((r) => r[0]);
  // In Earth's shadow on the way up, visible from 10° once sunlit, then too low on the way down.
  assert.deepEqual(styles, ["shadow", "visible", "lit"]);
  for (let i = 1; i < runs.length; i++) {
    if (runs[i][1] <= runs[i - 1][2]) assert.equal(runs[i][1], runs[i - 1][2], "consecutive runs share a sample");
  }
  for (const [style, a, b] of runs) {
    for (let i = a + 1; i < b; i++) {
      const expected = d.lit[i] ? (d.vis[i] ? "visible" : "lit") : "shadow";
      assert.equal(expected, style);
    }
  }
  assert.ok(runs.every(([, a, b]) => b > a));
});

test("ticks every 30 s on the clock, labelled at least 70 px apart", () => {
  assert.deepEqual(tickTimes(1000, 1100), [1020, 1050, 1080]);
  assert.deepEqual(tickTimes(990, 1020, 15), [990, 1005, 1020]);
  assert.deepEqual(tickTimes(5, 4), []);
  const points = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 10 }, null, { x: 75, y: 0 }, { x: 140, y: 0 }, { x: 150, y: 0 }, { x: 260, y: 0 }];
  assert.deepEqual(spacedLabels(points), [0, 4, 6, 7]);
  assert.deepEqual(spacedLabels(points, 200), [0, 7]);
  assert.equal(LABEL_SPACING_PX, 70);
});

test("labels are placed without overlapping each other, the screen edge or the HUD", () => {
  const offsets = [[0, -16], [0, 16], [40, 0], [-40, 0]];
  const labels = [
    { id: "a", x: 100, y: 100, w: 60, h: 14, priority: 0, offsets },
    { id: "b", x: 110, y: 104, w: 60, h: 14, priority: 1, offsets },
    { id: "c", x: 105, y: 102, w: 60, h: 14, priority: 1, offsets },
    { id: "d", x: 3, y: 50, w: 60, h: 14, priority: 2, offsets: [[0, 0]] },
    { id: "e", x: 300, y: 40, w: 60, h: 14, priority: 2, offsets },
  ];
  const placed = placeLabels(labels, { width: 400, height: 300, obstacles: [{ x0: 260, y0: 0, x1: 400, y1: 70 }] });
  const ids = placed.map((l) => l.id);
  assert.deepEqual(ids.slice(0, 2), ["a", "b"], "most important first");
  assert.ok(!ids.includes("c"), "crowded out: every spot around it is taken");
  assert.ok(!ids.includes("d"), "off the screen's edge");
  const e = placed.find((l) => l.id === "e");
  assert.ok(!e || e.box.y0 >= 70 - 3, "clear of the HUD");
  for (const p of placed) {
    for (const q of placed) {
      if (p === q) continue;
      const overlap = p.box.x0 < q.box.x1 && q.box.x0 < p.box.x1 && p.box.y0 < q.box.y1 && q.box.y0 < p.box.y1;
      assert.ok(!overlap, `${p.id} and ${q.id} overlap`);
    }
  }
});

test("the edge arrow points the way to turn, and goes away when the satellite is in view", () => {
  const P = makeProjector({ bearing: 0, pitch: 100, fov: 60, width: 1000, height: 600 });
  assert.equal(edgeArrow(P, 0, 15), null, "in view");
  const right = edgeArrow(P, 70, 10);
  assert.ok(right.x > 900 && Math.abs(right.angle) < Math.PI / 4, "to the right");
  const left = edgeArrow(P, 290, 10);
  assert.ok(left.x < 100 && Math.abs(Math.abs(left.angle) - Math.PI) < Math.PI / 4, "to the left");
  const up = edgeArrow(P, 0, 70);
  assert.ok(up.y < 100 && up.angle < 0, "up");
  const behindRight = edgeArrow(P, 150, 20);
  assert.ok(behindRight.x > 500, "behind on the right: turn right");
  const behindLeft = edgeArrow(P, 210, 20);
  assert.ok(behindLeft.x < 500, "behind on the left: turn left");
  // Insets keep it clear of the time bar.
  const low = edgeArrow(P, 0, -40, { insets: { bottom: 80 }, margin: 30 });
  assert.ok(low.y <= 600 - 80 - 30 + 1e-9, `${low.y}`);
  for (const a of [right, left, up, behindRight, behindLeft, low]) {
    assert.ok(a.x >= 30 - 1e-9 && a.x <= 970 + 1e-9 && a.y >= 30 - 1e-9 && a.y <= 570 + 1e-9, "inside the margin");
  }
});

test("how long until the satellite comes into view", () => {
  const { pass, detail } = syntheticPass({ peak: 60 });
  const d = trackFromRows(detail.transits[0].rows);
  // Looking at the peak: from the start it takes a while to get there.
  const peak = sampleAt(d, pass.peak.time);
  const P = makeProjector({ bearing: peak.azimuth, pitch: 90 + peak.elevation, fov: 40, width: 800, height: 600 });
  const wait = timeToEntry(P, d, d.t[0]);
  assert.ok(wait > 60 && wait < 300, `${wait} s`);
  assert.equal(timeToEntry(P, d, pass.peak.time), 0);
  // Looking away from the path entirely: never.
  const away = makeProjector({ bearing: (peak.azimuth + 180) % 360, pitch: 90, fov: 30, width: 800, height: 600 });
  assert.equal(timeToEntry(away, d, d.t[0]), null);
});

// ---- occlusion ---------------------------------------------------------------

test("the occlusion probe reads the map's alpha along the path from one band", () => {
  const width = 8;
  const height = 6;
  const samples = [
    { t: 1, x: 1, y: 1 },
    { t: 2, x: 3.4, y: 2.2 },
    { t: 3, x: 6, y: 4 },
    { t: 4, x: 20, y: 4 }, // off the canvas
  ];
  const band = bandFor(samples, width, height);
  // GL rows count from the bottom: y 1 -> row 4, y 4 -> row 1.
  assert.deepEqual(band, { y0: 1, rows: 4 });
  const buffer = new Uint8Array(width * band.rows * 4);
  const alpha = (x, yTop, a) => {
    const row = height - 1 - yTop - band.y0;
    buffer[(row * width + x) * 4 + 3] = a;
  };
  alpha(1, 1, 255); // a building
  alpha(3, 2, 0); // sky
  alpha(6, 4, 210); // ground
  const hidden = occlusionFromBand(buffer, width, height, band.y0, band.rows, samples);
  assert.deepEqual([...hidden], [[1, true], [2, false], [3, true]]);
  assert.equal(bandFor([{ x: -1, y: 2 }], width, height), null);
});

test("hidden stretches merge neighbouring samples within the visible window", () => {
  const d = trackFromRows([0, 2, 4, 6, 8, 10, 12, 14].map((t) => [t, 0, 0, 400, 1, 100, 30, 1000, 0, 1]));
  const hidden = new Map([[2, true], [4, true], [6, false], [10, true], [12, true], [14, true]]);
  assert.deepEqual(hiddenStretches(d, hidden, 0, 14), [[2, 4], [10, 14]]);
  assert.deepEqual(hiddenStretches(d, hidden, 0, 11), [[2, 4], [10, 10]]);
  assert.deepEqual(hiddenStretches(d, null, 0, 14), []);
});

test("skyline lookups interpolate and wrap around north", () => {
  const skyline = { stepDeg: 90, profile: [0, 1, 2, 3].map((i) => ({ azimuth: i * 90, elevation: [2, 4, 6, 8][i] })) };
  close(skylineAt(skyline, 45), 3, 1e-9);
  close(skylineAt(skyline, 315), 5, 1e-9, "between 270 and 360 = 0");
  close(skylineAt(skyline, -45), 5, 1e-9);
});

test("the dot and the path grow with brightness", () => {
  assert.ok(dotRadius(-3.5) > dotRadius(0) && dotRadius(0) > dotRadius(3));
  assert.ok(dotRadius(-10) <= 6.5 && dotRadius(10) >= 1.8);
  assert.ok(magnitudeWidth(-3) > magnitudeWidth(2.5));
  assert.equal(dotRadius(null), dotRadius(3));
});

// ---- drawing -----------------------------------------------------------------

test("a frame draws, says where to look, and only repaints the backdrop when the camera or the sky changes", () => {
  globalThis.Path2D ??= class {};
  const sky = fakeCanvas(1280, 800);
  const overlay = fakeCanvas(1280, 800);
  const p = new Planetarium({ sky, overlay, createCanvas: () => fakeCanvas(1, 1) });
  const { pass, detail } = syntheticPass({ peak: 60 });
  p.setObserver({ latitude: 42.36, longitude: -71.06, elevation: 10 });
  p.setFormatter(fakeFormatter());
  p.resize(1280, 800, 1);
  p.setPass(pass, detail);
  const peak = sampleAt(p.primary.data, pass.peak.time);
  const P = makeProjector({ bearing: peak.azimuth, pitch: 90 + peak.elevation - 10, fov: 70, width: 1280, height: 800 });
  const state = p.draw(P, pass.peak.time - 4, { insets: { bottom: 80 } });
  assert.ok(state.current?.onScreen, "the satellite is in view");
  assert.ok(state.current.visible && state.current.lit);
  assert.equal(state.entry, null);
  assert.equal(state.focus, p.primary);
  // The compass names the points in view, the in-between ones (NE, SE…) too.
  const texts = p._staticOverlay.ctx.calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  const inView = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].filter((point, k) => {
    const q = P.project(k * 45, 0);
    return q && q[0] > 0 && q[0] < 1280;
  });
  assert.ok(inView.length >= 1);
  for (const point of inView) assert.ok(texts.includes(point), `${point} on the horizon`);
  const backdrops = () => p._backdrop.ctx.calls.filter((c) => c[0] === "putImageData" || c[0] === "drawImage").length;
  const before = backdrops();
  // A few seconds on, same camera: the cached backdrop is reused.
  p.draw(P, pass.peak.time - 2, { insets: { bottom: 80 } });
  assert.equal(backdrops(), before, "no repaint for a moving dot");
  // The camera turns: repainted.
  p.draw(makeProjector({ ...P, bearing: P.bearing + 5 }), pass.peak.time - 2, { insets: { bottom: 80 } });
  assert.ok(backdrops() > before);
  // Looking the other way: an arrow says where, and how long until it comes into view.
  const away = makeProjector({ bearing: (peak.azimuth + 180) % 360, pitch: 95, fov: 60, width: 1280, height: 800 });
  const turned = p.draw(away, pass.peak.time, { insets: { bottom: 80 } });
  assert.ok(turned.entry && !turned.current.onScreen);
  // Hidden by a building: the note says until when.
  const hidden = new Map();
  for (let i = 0; i < p.primary.data.n; i++) hidden.set(p.primary.data.t[i], Math.abs(p.primary.data.t[i] - pass.peak.time) < 20);
  p.setOcclusion(hidden);
  const behind = p.draw(P, pass.peak.time, { insets: { bottom: 80 } });
  assert.equal(behind.note?.kind, "until");
  assert.ok(behind.current.hidden);
  assert.ok(Math.abs(behind.note.time - (pass.peak.time + 20)) <= 4);
});

test("in the 2D fallback the hills hide the path and the dot behind them, as the map does in 3D", () => {
  globalThis.Path2D ??= class {};
  const sky = fakeCanvas(1280, 800);
  const p = new Planetarium({ sky, overlay: fakeCanvas(1280, 800), createCanvas: () => fakeCanvas(1, 1) });
  p.setObserver({ latitude: 40.01, longitude: -105.27, elevation: 1650 });
  p.setFormatter(fakeFormatter());
  p.resize(1280, 800, 1);
  // A low pass (15° at most, in the NNW) behind a ridge 20° high all round.
  const { pass, detail } = syntheticPass({ peak: 15 });
  p.setPass(pass, detail);
  const ridge = (elevation) => ({ stepDeg: 1, profile: Array.from({ length: 360 }, (_, i) => ({ azimuth: i, elevation, distance: 3000 })) });
  p.setSkyline(ridge(20));
  const P = makeProjector({ bearing: 340, pitch: 100, fov: 70, width: 1280, height: 800 });
  p.draw(P, pass.peak.time);
  // The backdrop: the ground goes on last, so only its rim is stroked after it, and the paths before.
  const calls = p._backdrop.ctx.calls.map((c) => c[0]);
  const ground = calls.lastIndexOf("createLinearGradient");
  assert.ok(ground > 0, "the ground is painted");
  assert.equal(calls.slice(ground).filter((name) => name === "stroke").length, 1, "nothing but the ridge's rim over the ground");
  // The dot: drawn, then the backdrop's ground copied over it, clipped to the ground.
  const after = (from) => sky.ctx.calls.slice(from).map((c) => c[0]);
  const dot = after(0).lastIndexOf("arc");
  const clip = after(0).indexOf("clip", dot);
  assert.ok(dot > 0 && clip > dot, "the ground is laid over the dot");
  assert.ok(sky.ctx.calls.slice(clip).some((c) => c[0] === "drawImage" && c[1] === p._backdrop));
  // A ridge well below the dot hides nothing: no second copy of the ground.
  p.setSkyline(ridge(0));
  const from = sky.ctx.calls.length;
  p.draw(P, pass.peak.time);
  assert.ok(after(from).includes("arc"), "the dot is drawn");
  assert.ok(!after(from).includes("clip"), "and left alone");
});

test("a train's members carry on after the first satellite has gone", () => {
  globalThis.Path2D ??= class {};
  const p = new Planetarium({ sky: fakeCanvas(800, 600), overlay: fakeCanvas(800, 600), createCanvas: () => fakeCanvas(1, 1) });
  const { pass, detail } = syntheticPass({ members: 3, train: true });
  p.setObserver({ latitude: 42.36, longitude: -71.06 });
  p.setFormatter(fakeFormatter());
  p.resize(800, 600, 1);
  p.setPass(pass, detail);
  const primary = p.primary;
  assert.equal(p.focusAt(primary.visibleStart + 5).track, primary);
  const later = p.focusAt(primary.visibleEnd + 30);
  assert.notEqual(later.track, primary, "a member is still up");
  assert.ok(later.track.visibleEnd >= primary.visibleEnd + 30);
  assert.equal(p.focusAt(primary.visibleEnd + 3600).track, primary, "all gone: back to the primary");
});

test("the edge arrow's label moves beside the arrow when its usual place is taken", () => {
  const P = makeProjector({ bearing: 0, pitch: 100, fov: 60, width: 800, height: 600 });
  // At the right edge, pointing right: the label goes inside, to its left.
  const entry = { x: 770, y: 300, angle: 0 };
  const free = arrowPill(P, entry, 60, []);
  assert.ok(free.cx < 770 - 30 && Math.abs(free.cy - 300) < 1);
  // The "Appears 7:18:28 AM" pill sits there: the label steps across the arrow's direction.
  const taken = { x0: free.cx - 50, y0: free.cy - 14, x1: free.cx + 50, y1: free.cy + 14 };
  const moved = arrowPill(P, entry, 60, [taken]);
  assert.ok(moved, "a clear place is found");
  const box = { x0: moved.cx - 38, y0: moved.cy - 10, x1: moved.cx + 38, y1: moved.cy + 10 };
  assert.ok(box.y1 <= taken.y0 || box.y0 >= taken.y1 || box.x1 <= taken.x0 || box.x0 >= taken.x1, "clear of it");
  // Nowhere clear: null, and the arrow falls back to the inside.
  assert.equal(arrowPill(P, entry, 60, [{ x0: 0, y0: 0, x1: 800, y1: 600 }]), null);
});
