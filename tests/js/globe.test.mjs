// Unit tests for the globe's pure geometry (sat-geo.js) and the CPU side of its layers: node --test "tests/js/*.test.mjs"
// (The sky chart's tests are in sky.test.mjs.)
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bearing,
  circleRing,
  closestApproach,
  compass,
  displayAltitudeKm,
  esc,
  gmst,
  groundDistanceKm,
  interpolatePositions,
  lookAngles,
  mercator,
  orbitalSpeed,
  periodFromMeanMotion,
  positionAt,
  previewTimeline,
  satelliteKind,
  semiMajorAxisKm,
  skyTrack,
  subsolarPoint,
  sunElevation,
  sunVector,
  visibilityRadius,
  wrapLongitude,
} from "../../custom_components/satellite_spotter/frontend/sat-geo.js";
import { SpaceLayer, buildRibbon, toMercator } from "../../custom_components/satellite_spotter/frontend/sat-space.js";

const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);
const DEG = Math.PI / 180;

// Reference values from the Python engine (itself checked against Skyfield).
const SUN = [
  { time: "2026-03-20T12:00:00Z", lat: -0.0434, lon: 1.8656 },
  { time: "2026-06-21T18:30:00Z", lat: 23.4345, lon: -97.0288 },
  { time: "2026-10-09T23:15:00Z", lat: -6.5515, lon: -171.9686 },
  { time: "2026-12-21T03:00:00Z", lat: -23.4329, lon: 134.4689 },
];
const DENVER = { latitude: 39.74, longitude: -104.99, elevation: 1609 };
const LOOKS = [
  { lat: 43.496015, lon: -121.088092, alt: 427.0063, azimuth: 292.534, elevation: 10.001, range: 1507.09 },
  { lat: 36.36276, lon: -108.981291, alt: 424.6421, azimuth: 224.301, elevation: 36.269, range: 677.89 },
  { lat: 28.432903, lon: -98.278892, alt: 425.5809, azimuth: 151.771, elevation: 10.0, range: 1502.1 },
  { lat: 40.628149, lon: -105.855932, alt: 428.3167, azimuth: 323.496, elevation: 72.835, range: 445.27 },
];
const rows = LOOKS.map((l, i) => [1000 + i * 60, l.lat, l.lon, l.alt, 1]);

test("subsolar point and sun vector match the Python engine", () => {
  for (const s of SUN) {
    const p = subsolarPoint(new Date(s.time));
    close(p.lat, s.lat, 0.01, s.time);
    close(wrapLongitude(p.lon - s.lon), 0, 0.01, s.time);
    const v = sunVector(new Date(s.time));
    close(Math.hypot(...v), 1, 1e-12);
    close(Math.asin(v[2]) * (180 / Math.PI), s.lat, 0.01);
  }
});

test("Greenwich sidereal time, for the stars", () => {
  // IAU 1982 at J2000.0: 18h 41m 50.548s, that is 280.46061837 degrees.
  close(gmst(2451545.0) / DEG, 280.46061837, 1e-6);
  // One sidereal day later the Earth has turned once more.
  close(gmst(2451545.0 + 0.99726957) / DEG, 280.46061837, 1e-3);
  // Always 0..2 pi, before J2000 too.
  for (const jd of [2440587.5, 2451545.0, 2461330.375]) assert.ok(gmst(jd) >= 0 && gmst(jd) < 2 * Math.PI);
});

test("look angles match the Python engine", () => {
  for (const l of LOOKS) {
    const a = lookAngles(DENVER, { lat: l.lat, lon: l.lon, alt: l.alt });
    close(a.elevation, l.elevation, 0.01, "elevation");
    close(wrapLongitude(a.azimuth - l.azimuth), 0, 0.01, "azimuth");
    close(a.range, l.range, 0.1, "range");
  }
  const sky = skyTrack(DENVER, rows);
  assert.equal(sky.length, rows.length);
  close(sky[1].elevation, 36.269, 0.01);
  assert.equal(closestApproach(DENVER, rows), 3); // the 72.8 deg point
});

test("sun elevation is 90 at the subsolar point and -90 opposite", () => {
  const sun = { lat: 10, lon: 20 };
  close(sunElevation(10, 20, sun), 90, 1e-6);
  close(sunElevation(-10, -160, sun), -90, 1e-6);
});

test("mercator coordinates", () => {
  assert.deepEqual(mercator(0, 0), [0.5, 0.5]);
  close(mercator(0, -180)[0], 0, 1e-12);
  close(mercator(85.051129, 90)[1], 0, 1e-6);
  close(mercator(-89, 90)[1], 1, 1e-6); // clamped to the mercator limit
  close(mercator(0, 190)[0], mercator(0, -170)[0], 1e-12);
  // A limit past the flat map's: what the globe's layers use, so polar orbits go over the top.
  assert.ok(mercator(89, 90, 89.9999)[1] < 0, "beyond the flat map's edge");
  close(mercator(-89, 90, 89.9999)[1], 1 - mercator(89, 90, 89.9999)[1], 1e-12);
  // The layers' toMercator() is the same function with that limit.
  for (const [lat, lon] of [[0, 0], [42.36, -71.06], [89.5, 179.9], [-89.5, -180], [52.03, 365.56]]) {
    assert.deepEqual(toMercator(lat, lon), mercator(lat, lon, 89.9999));
    assert.deepEqual(toMercator(lat, lon, 85.051129), mercator(lat, lon));
  }
});

test("interpolates position across the antimeridian", () => {
  const track = [
    [0, 10, 179, 420, 1],
    [30, 11, -179, 422, 0],
  ];
  const mid = positionAt(track, 15);
  close(mid.lat, 10.5, 1e-9);
  close(Math.abs(mid.lon), 180, 1e-9);
  close(mid.alt, 421, 1e-9);
  assert.equal(positionAt(track, -1), null);
  assert.equal(positionAt(track, 31), null);
  assert.equal(positionAt(track, 10).sunlit, true);
  assert.equal(positionAt(track, 20).sunlit, false);
});

test("circle radius, distance, bearing and speed", () => {
  // From 420 km the horizon is acos(R / (R + h)) = 20.25 deg of arc away;
  // the satellite is above 10 deg elevation within 12.49 deg.
  close(visibilityRadius(420, 0), 20.2455, 0.001);
  close(visibilityRadius(420, 10), 12.4872, 0.001);
  // Generic: a geostationary satellite is above 10 deg from within 71.4 deg of arc.
  close(visibilityRadius(35786, 10), 71.4, 0.05);
  const ring = circleRing(0, 179, 10, 36);
  assert.equal(ring.length, 37);
  assert.ok(ring.every(([lon]) => Math.abs(lon - 179) <= 10.01));
  close(groundDistanceKm(0, 0, 0, 90), 10007.5, 1);
  close(bearing(0, 0, 10, 0), 0, 1e-9);
  close(bearing(0, 0, 0, 10), 90, 1e-9);
  close(orbitalSpeed(420), 7.66, 0.01);
});

test("each satellite's own period, orbit size and speed (vis-viva)", () => {
  // The ISS makes about 15.49 orbits a day: 92.9 minutes, an orbit 6,796 km across from the centre.
  close(periodFromMeanMotion(15.49) / 60, 92.96, 0.01);
  assert.ok(Number.isNaN(periodFromMeanMotion(0)));
  close(semiMajorAxisKm(5574), 6796, 2);
  close(semiMajorAxisKm(86164.1), 42164, 1, "geostationary");
  assert.ok(Number.isNaN(semiMajorAxisKm(-1)));
  // Circular: the same as before, for the ISS.
  close(orbitalSpeed(420, semiMajorAxisKm(5574)), orbitalSpeed(420), 0.005);
  close(orbitalSpeed(35786, 42164.137), 3.0747, 0.001, "geostationary");
  // A rocket body in a transfer orbit, 250 x 35,786 km: fast at perigee, slow at apogee, the
  // same angular momentum at both (r v), as Kepler's second law says.
  const rp = 6378.137 + 250;
  const ra = 6378.137 + 35786;
  const a = (rp + ra) / 2;
  const vp = orbitalSpeed(250, a);
  const va = orbitalSpeed(35786, a);
  close(vp, 10.195, 0.005, "perigee");
  close(va, 1.6, 0.01, "apogee");
  close(rp * vp, ra * va, 1e-9 * rp * vp, "angular momentum");
  assert.ok(vp > orbitalSpeed(250), "faster than circular at perigee");
});

test("display altitude: true up to 2,000 km, then compressed so high orbits stay in front of the camera", () => {
  for (const km of [0, 200, 420, 1200, 2000]) assert.equal(displayAltitudeKm(km), km);
  let last = -Infinity;
  for (let km = 0; km <= 80000; km += 250) {
    const d = displayAltitudeKm(km);
    assert.ok(d > last, `${km} km`);
    assert.ok(d <= km);
    last = d;
  }
  // Smooth at the knee: the slope is 1 on both sides.
  close(displayAltitudeKm(2001) - displayAltitudeKm(2000), 1, 0.001);
  close(displayAltitudeKm(35786), 6737, 2, "geostationary");
  // The highest apogee in the catalogue (an Ariane 44 upper stage) is drawn within 1.25 globe radii above the ground.
  assert.ok(displayAltitudeKm(73958) / 6371 < 1.25);
});

// Real names from the "brightest" catalogue, with the kind the integration gives them.
const CATALOGUE = [
  [29649, "BREEZE-M DEB (TANK)", "debris"], [27048, "ARIANE 44LP DEB", "debris"],
  [21818, "ARIANE 44L DEB (SPELDA)", "debris"], [20580, "Hubble", "hubble"], [25544, "ISS", "iss"],
  [28415, "CZ-4B R/B", "rocket"], [40548, "PSLV R/B", "rocket"], [12904, "SL-3 R/B", "rocket"],
  [100177, "CZ-6A R/B", "rocket"], [23608, "ARIANE 40+3 R/B", "rocket"], [10779, "ATLAS CENTAUR R/B", "rocket"],
  [15390, "LEASAT 1 PKM", "rocket"], [20411, "LEASAT 5 PKM (SSUS-A)", "rocket"], [17911, "COSMOS 1842", "satellite"],
  [43641, "SAOCOM 1-A", "satellite"], [41634, "SJ 16-02", "satellite"], [25023, "MAQSAT H", "satellite"],
  [54035, "HJ-2E", "satellite"], [42758, "HXMT", "satellite"], [45044, "Starlink 3 A", "starlink"],
  [100864, "Starlink Group 31-1 (Starship Flight 14) K", "starlink"], [101004, "Starlink Group 15-25 A", "starlink"],
  [48274, "Tiangong", "tiangong"],
];

test("satellite kinds follow the integration's rules", () => {
  for (const [norad_id, name, kind] of CATALOGUE) assert.equal(satelliteKind({ norad_id, name }), kind, name);
  // The stations by NORAD id, whatever their name and even as text.
  assert.equal(satelliteKind({ norad_id: "25544", name: "ISS (ZARYA)" }), "iss");
  assert.equal(satelliteKind({ norad_id: 48274, name: "CSS (TIANHE)" }), "tiangong");
  // Then by name, ignoring case; a rocket body beats debris, Starlink beats both.
  assert.equal(satelliteKind({ norad_id: 1, name: "STARLINK-1007" }), "starlink");
  assert.equal(satelliteKind({ norad_id: 2, name: "intelsat 5 akm" }), "rocket");
  assert.equal(satelliteKind({ norad_id: 3, name: "SL-16 R/B DEB" }), "rocket");
  assert.equal(satelliteKind({ norad_id: 4, name: "IRIDIUM 33 DEB" }), "debris");
  assert.equal(satelliteKind({ norad_id: 5 }), "satellite");
  assert.equal(satelliteKind(), "satellite");
});

// 30 s samples of real orbits from the integration: CZ-8 R/B (69419, 89 deg) over the North Pole,
// and the ISS across the antimeridian. [t, lat, lon, alt km, lit]
const POLE = [
  [1792552800, 72.3502, -170.8751, 740.5, 1], [1792552830, 74.1551, -170.6183, 742.0, 1], [1792552860, 75.9583, -170.2664, 743.5, 1],
  [1792552890, 77.7592, -169.7774, 745.0, 1], [1792552920, 79.5574, -169.0808, 746.5, 1], [1792552950, 81.3517, -168.0478, 748.0, 1],
  [1792552980, 83.1399, -166.416, 749.5, 1], [1792553010, 84.9164, -163.5601, 750.9, 1], [1792553040, 86.6639, -157.5601, 752.4, 1],
  [1792553070, 88.2936, -139.1816, 753.9, 1], [1792553100, 88.9132, -62.5771, 755.4, 1], [1792553130, 87.565, -19.7092, 756.8, 1],
  [1792553160, 85.8589, -9.5206, 758.3, 1], [1792553190, 84.0981, -5.405, 759.7, 1], [1792553220, 82.3206, -3.2409, 761.1, 1],
  [1792553250, 80.5361, -1.9352, 762.5, 1], [1792553280, 78.7481, -1.0809, 763.9, 1], [1792553310, 76.9584, -0.4927, 765.2, 1],
  [1792553340, 75.1677, -0.0743, 766.6, 1], [1792553370, 73.3764, 0.2292, 767.9, 1], [1792553400, 71.5849, 0.4512, 769.2, 1],
];
const ANTIMERIDIAN = [
  [1792643370, -41.3152, 157.402, 430.5, 1], [1792643400, -42.3915, 159.4304, 430.9, 1], [1792643430, -43.4259, 161.532, 431.2, 1],
  [1792643460, -44.4153, 163.7088, 431.5, 1], [1792643490, -45.3567, 165.9624, 431.7, 1], [1792643520, -46.2467, 168.2938, 432.0, 1],
  [1792643550, -47.0823, 170.7033, 432.2, 1], [1792643580, -47.8599, 173.1903, 432.4, 1], [1792643610, -48.5763, 175.7533, 432.6, 1],
  [1792643640, -49.2283, 178.3897, 432.8, 1], [1792643670, -49.8125, -178.9043, 432.9, 1], [1792643700, -50.3261, -176.1336, 433.1, 1],
  [1792643730, -50.766, -173.3046, 433.2, 1], [1792643760, -51.1299, -170.4245, 433.2, 1], [1792643790, -51.4155, -167.5021, 433.3, 1],
  [1792643820, -51.6211, -164.5468, 433.3, 1], [1792643850, -51.7454, -161.5691, 433.3, 1], [1792643880, -51.7874, -158.5801, 433.2, 1],
  [1792643910, -51.7471, -155.5908, 433.2, 1], [1792643940, -51.6246, -152.6127, 433.1, 1], [1792643970, -51.4207, -149.6566, 433.0, 1],
];

/** A `satellite_spotter/positions` payload from every `every`-th row, rounded as the integration sends it. */
function positionsFrom(samples, every, extra = []) {
  const kept = samples.filter((_, i) => i % every === 0);
  return {
    start: kept[0][0],
    step: kept[1][0] - kept[0][0],
    count: kept.length,
    catalog_version: 3,
    ids: [69419, ...extra.map((e) => e.id)],
    pos: [kept.flatMap((r) => [Math.round(r[1] * 100) / 100, Math.round(r[2] * 100) / 100, Math.round(r[3])]), ...extra.map((e) => e.pos)],
    lit: [kept.map((r) => String(r[4])).join(""), ...extra.map((e) => e.lit)],
  };
}

/** Straight-line distance in km between two [lat, lon, alt km] positions (spherical Earth). */
function apart(a, b) {
  const xyz = ([lat, lon, alt]) => {
    const r = 6371 + alt;
    return [r * Math.cos(lat * DEG) * Math.cos(lon * DEG), r * Math.cos(lat * DEG) * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
  };
  const p = xyz(a);
  const q = xyz(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

test("the cloud's positions are interpolated along the orbit, over the pole and across the antimeridian", () => {
  for (const [name, samples] of [["over the pole", POLE], ["across the antimeridian", ANTIMERIDIAN]]) {
    // Every minute, as the integration sends them, and every two minutes, to show the margin.
    for (const [every, limitKm] of [[2, 1.5], [4, 3]]) {
      const payload = positionsFrom(samples, every);
      let worst = 0;
      for (const r of samples) {
        const p = interpolatePositions(payload, r[0]);
        assert.ok(p[1] >= -180 && p[1] <= 180, `${name}: longitude ${p[1]}`);
        worst = Math.max(worst, apart([p[0], p[1], p[2]], [r[1], r[2], r[3]]));
      }
      assert.ok(worst <= limitKm, `${name}, ${payload.step} s apart: off by up to ${worst.toFixed(2)} km`);
    }
  }
  // Interpolating latitude and longitude separately would cut across the polar cap instead.
  const payload = positionsFrom(POLE, 2);
  const i = POLE.findIndex((r) => r[2] === -62.5771);
  const [a, b] = [POLE[i - 1], POLE[i + 1]];
  const naive = [(a[1] + b[1]) / 2, wrapLongitude(a[2] + wrapLongitude(b[2] - a[2]) / 2), (a[3] + b[3]) / 2];
  assert.ok(apart(naive, POLE[i].slice(1, 4)) > 50, "the naive way is far off");
  const p = interpolatePositions(payload, POLE[i][0]);
  assert.ok(apart([p[0], p[1], p[2]], POLE[i].slice(1, 4)) < 1.5);
});

test("between two samples a satellite follows the great circle through them", () => {
  // Two points on the meridian 0/180, over the North Pole: the path stays on it and peaks at 90 N.
  const payload = { start: 0, step: 60, count: 2, ids: [1], pos: [[80, 0, 500, 80, 180, 700]], lit: ["10"] };
  const mid = interpolatePositions(payload, 30);
  close(mid[0], 90, 1e-3, "over the pole");
  close(mid[2], 600, 1e-9, "altitude: linear");
  close(mid[3], 0.5, 1e-9, "half lit: it leaves the light over this minute");
  for (const f of [0.1, 0.3, 0.7, 0.9]) {
    const p = interpolatePositions(payload, 60 * f);
    // Its angle from the first point grows evenly with time (20 deg in all).
    const angle = p[1] > 90 || p[1] < -90 ? 90 - p[0] + 10 : p[0] - 80;
    close(angle, 20 * f, 1e-3, `at ${f}`);
  }
});

test("interpolated positions: every satellite in order, held at the ends, NaN without a position, into a reused array", () => {
  const payload = positionsFrom(ANTIMERIDIAN, 2, [
    { id: 2, pos: Array(33).fill(null), lit: "00000000000" },
    { id: 3, pos: Array.from({ length: 11 }, (_, k) => [10, 20 + k, 35786]).flat(), lit: "11111111111" },
  ]);
  const out = new Float32Array(12);
  const p = interpolatePositions(payload, ANTIMERIDIAN[3][0], out);
  assert.equal(p, out, "reused");
  assert.ok(Number.isNaN(p[4]) && Number.isNaN(p[5]) && Number.isNaN(p[6]), "no position");
  assert.equal(p[7], 0);
  close(p[9], 21.5, 1e-4, "the third satellite, half way between 21 and 22 E");
  close(p[10], 35786, 1e-3);
  // Before the first sample and after the last: held there.
  const before = interpolatePositions(payload, payload.start - 600);
  close(before[0], -41.32, 1e-4);
  close(before[1], 157.4, 1e-4);
  const after = interpolatePositions(payload, payload.start + 3600);
  close(after[0], -51.42, 1e-4);
  // A short array is replaced, not overrun.
  assert.equal(interpolatePositions(payload, payload.start, new Float32Array(4)).length, 12);
  // Nothing to interpolate.
  assert.equal(interpolatePositions(null, 0).length, 0);
  const none = interpolatePositions({ ...payload, count: 0 }, 0);
  assert.ok([0, 1, 2, 4, 5, 6, 8, 9, 10].every((k) => Number.isNaN(none[k])), "no samples: no positions");
  assert.deepEqual([none[3], none[7], none[11]], [0, 0, 0]);
  const single = interpolatePositions({ start: 0, step: 60, count: 1, ids: [1], pos: [[1, 2, 3]], lit: ["1"] }, 999);
  assert.deepEqual([...single], [1, 2, 3, 1].map(Math.fround));
});

test("compass points and escaping", () => {
  assert.equal(compass(0), "N");
  assert.equal(compass(202), "SSW");
  assert.equal(compass(-90), "W");
  assert.equal(esc(`<b a="x">&'`), "&#60;b a=&#34;x&#34;&#62;&#38;&#39;");
});

test("preview timeline sweeps to the pass, plays it, then ends", () => {
  const start = 0;
  const passStart = 3 * 3600; // two orbits away
  const passEnd = passStart + 360;
  const tl = previewTimeline(start, passStart, passEnd);
  assert.ok(tl.durationMs > 3000 && tl.durationMs < 40000, `${tl.durationMs}`);
  assert.equal(tl.at(0).sim, 0);
  assert.equal(tl.at(0).phase, "approach");
  // Monotonic simulated time.
  let last = -1;
  for (let ms = 0; ms <= tl.durationMs; ms += 50) {
    const s = tl.at(ms);
    assert.ok(s.sim >= last - 1e-9, `time went backwards at ${ms} ms`);
    last = s.sim;
  }
  const passMoment = [...Array(400).keys()].map((i) => tl.at((i / 400) * tl.durationMs)).find((s) => s.phase === "pass");
  assert.ok(passMoment.sim >= passStart - 240 - 1 && passMoment.sim <= passEnd + 60);
  assert.equal(tl.at(tl.durationMs).done, true);
  // A pass starting within the lead time skips the fast part.
  assert.equal(previewTimeline(0, 100, 400).at(0).phase, "pass");
});

test("the preview's sweep counts the satellite's own orbits", () => {
  const passStart = 6 * 3600;
  const fast = (tl) => [...Array(2000).keys()].map((i) => i * 10).find((ms) => tl.at(ms).phase !== "approach");
  // Over the same six hours: four orbits of the ISS (6 s), a third of a 17-hour transfer orbit (3 s, the least).
  const iss = previewTimeline(0, passStart, passStart + 300);
  const same = previewTimeline(0, passStart, passStart + 300, { periodS: 92.9 * 60 });
  const slow = previewTimeline(0, passStart, passStart + 300, { periodS: 17 * 3600 });
  assert.equal(fast(iss), fast(same));
  close(fast(iss), ((passStart - 240) / (92.9 * 60)) * 1500, 10);
  assert.equal(fast(slow), 3000);
  // No period, or nonsense: the ISS's.
  assert.equal(fast(previewTimeline(0, passStart, passStart + 300, { periodS: 0 })), fast(iss));
});

test("ribbons split at the antimeridian", () => {
  const pts = [
    [0.97, 0.4, 400000, 0, 1],
    [0.99, 0.41, 400000, 30, 1],
    [0.01, 0.42, 400000, 60, 0],
    [0.03, 0.43, 400000, 90, 0],
  ];
  const { data, segments } = buildRibbon(pts);
  assert.equal(segments.length, 2);
  const stride = 12;
  // The first piece ends on the right edge, the second starts on the left edge.
  const lastOfFirst = (segments[0][0] + segments[0][1] - 1) * stride;
  const firstOfSecond = segments[1][0] * stride;
  close(data[lastOfFirst], 1, 1e-6);
  close(data[firstOfSecond], 0, 1e-6);
  close(data[lastOfFirst + 1], data[firstOfSecond + 1], 1e-6); // same latitude at the seam
  assert.ok(data.every(Number.isFinite));
  assert.equal(buildRibbon([pts[0]]).segments.length, 0);
});

test("CPU projection uses MapLibre's globe axes and hides the far side", () => {
  const layer = new SpaceLayer();
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // Globe variant, identity matrix: the clip position is the unit-sphere position.
  layer._last = { main: identity, fallback: identity, plane: [0, 0, 1, 0], transition: 1, globe: true };
  const front = layer.project(0, 0, 0, 200, 200); // (0, 0) faces +z
  close(front.x, 100, 1e-6);
  close(front.y, 100, 1e-6);
  const east = layer.project(0, 60, 0, 200, 200); // 60E: x = sin(60) > 0, right of centre
  assert.ok(east.x > 150);
  const north = layer.project(45, 0, 0, 200, 200); // north is up the screen
  assert.ok(north.y < 100);
  assert.equal(layer.project(0, 180, 0, 200, 200), null); // behind the globe
  // Flat variant: mercator in, clip out.
  layer._last = { main: identity, fallback: identity, plane: [0, 0, 0, 0], transition: 0, globe: false };
  const flat = layer.project(0, 0, 0, 200, 200);
  close(flat.x, 150, 1e-6); // mercator x 0.5 -> clip 0.5 -> 150 px
});
