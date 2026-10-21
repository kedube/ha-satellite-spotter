// Tests for sat-astro.js against Skyfield (JPL DE421) and Meeus' worked examples:
// node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  airmass,
  azElVector,
  azimuthElevation,
  bvToRgb,
  bvToTemperature,
  cssColor,
  eclipticToRaDec,
  extinction,
  galacticToRaDec,
  greenwichSiderealTime,
  horizonMatrix,
  horizonVectors,
  localSiderealTime,
  moonAzEl,
  moonLitPath,
  moonPhase,
  moonPhaseState,
  moonPosition,
  planetPositions,
  precessionMatrix,
  applyMatrix,
  raDecToAzEl,
  raDecVector,
  refraction,
  skyAt,
  skyColor,
  skyDirection,
  skyGradient,
  skyPalette,
  starAlpha,
  starRadius,
  starVectors,
  sunAzEl,
  sunPosition,
  toHorizon,
  towards,
  twilight,
  vectorRaDec,
} from "../../custom_components/satellite_spotter/frontend/sat-astro.js";
import { STARS } from "../../custom_components/satellite_spotter/frontend/sat-stars.js";
// The globe's Sun, to check the sky agrees with it.
import { subsolarPoint, sunElevation, sunVector } from "../../custom_components/satellite_spotter/frontend/sat-geo.js";
import REF from "./helpers/street-skyfield.mjs";

const DEG = Math.PI / 180;
const close = (actual, expected, tolerance, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} ± ${tolerance}`);
/** Angle between two {azimuth, elevation} or {ra, dec} directions, degrees. */
const apart = (a, b) => {
  const [u, v] = "ra" in a ? [raDecVector(a.ra, a.dec), raDecVector(b.ra, b.dec)] : [azElVector(a.azimuth, a.elevation), azElVector(b.azimuth, b.elevation)];
  return Math.acos(Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])) / DEG;
};
const turn = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
/** A date whose Terrestrial Time is the Julian ephemeris date jde (sat-astro takes TT = UTC + 69.184 s). */
const fromJDE = (jde) => (jde - 2440587.5) * 86400000 - 69184;

test("sidereal time matches Meeus and Skyfield", () => {
  close(greenwichSiderealTime(Date.UTC(1987, 3, 10)), 197.693195, 1e-6, "Meeus 12.a");
  close(localSiderealTime(Date.UTC(1987, 3, 10), -90), 107.693195, 1e-6);
  for (const c of REF.cases) close(turn(greenwichSiderealTime(new Date(c.time)), c.gmst), 0, 0.002, c.time);
});

test("precession matches Meeus 21.b and keeps vectors unit length", () => {
  // theta Persei, J2000 (proper motion applied) to 2028 November 13.19 TD.
  const p = vectorRaDec(applyMatrix(precessionMatrix(fromJDE(2462088.69)), raDecVector(41.054063, 49.22775)));
  close(p.ra, 41.547214, 2e-6);
  close(p.dec, 49.348483, 2e-6);
  const m = horizonMatrix(new Date("2026-10-17T02:00:00Z"), { latitude: 40, longitude: -105 });
  for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) close(Math.hypot(...applyMatrix(m, v)), 1, 1e-12);
});

test("stars are within 0.1 deg of Skyfield", () => {
  for (const c of REF.cases) {
    const m = horizonMatrix(new Date(c.time), c.observer);
    for (const s of c.stars) {
      const p = toHorizon(m, s.ra, s.dec);
      const label = `${c.time} ${c.place} ${s.name}`;
      assert.ok(apart(p, s) <= 0.1, `${label}: ${apart(p, s)} deg off`);
      close(p.elevation, s.elevation, 0.1, label);
    }
  }
  // The same through the batch path the renderers use.
  const c = REF.cases[6];
  const p = raDecToAzEl(c.stars[0].ra, c.stars[0].dec, new Date(c.time), c.observer);
  assert.ok(apart(p, c.stars[0]) <= 0.1);
});

test("star vectors turned in bulk match one at a time", () => {
  const date = new Date("2026-06-21T21:15:00Z");
  const observer = { latitude: -33.87, longitude: 151.21 };
  const m = horizonMatrix(date, observer);
  const enu = horizonVectors(m, starVectors(STARS));
  assert.equal(enu.length, (STARS.length / 4) * 3);
  for (let i = 0; i < 200; i += 7) {
    const a = azimuthElevation([enu[i * 3], enu[i * 3 + 1], enu[i * 3 + 2]]);
    const b = toHorizon(m, STARS[i * 4], STARS[i * 4 + 1]);
    assert.ok(apart(a, b) < 1e-4, `star ${i}`);
  }
});

test("the Sun is within 0.05 deg of Skyfield", () => {
  for (const c of REF.cases) {
    const date = new Date(c.time);
    const sun = sunAzEl(date, c.observer);
    assert.ok(apart(sun, c.sun) <= 0.05, `${c.time} ${c.place}: ${apart(sun, c.sun)}`);
    close(sunPosition(date).distance, c.sun.distance, 2e-4);
    close(sun.radius, 0.2666 / c.sun.distance, 2e-4);
  }
});

test("the Sun is the globe's Sun (sat-geo.js)", () => {
  for (let i = 0; i < 400; i++) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 13.3e6);
    const [latitude, longitude] = [-80 + ((i * 37) % 160), -180 + ((i * 53) % 360)];
    close(sunAzEl(date, { latitude, longitude }).elevation, sunElevation(latitude, longitude, subsolarPoint(date)), 1e-8);
    const s = sunPosition(date);
    const v = raDecVector(s.ra - greenwichSiderealTime(date), s.dec);
    const w = sunVector(date);
    close(Math.hypot(v[0] - w[0], v[1] - w[1], v[2] - w[2]), 0, 1e-9);
  }
});

test("the Moon matches Meeus 47.a and 48.a", () => {
  const m = moonPosition(fromJDE(2448724.5)); // 1992 April 12, 0h TD
  close(m.longitude, 133.162655, 1e-6, "longitude");
  close(m.latitude, -3.229126, 1e-6, "latitude");
  close(m.distance, 368409.7, 0.1, "distance");
  const p = moonPhase(fromJDE(2448724.5));
  close(p.fraction, 0.6786, 1e-4, "fraction");
  close(p.positionAngle, 285.0, 0.1, "bright limb");
  assert.equal(p.waxing, true);
});

test("the Moon is within 0.5 deg of Skyfield, seen from the ground", () => {
  for (const c of REF.cases) {
    const date = new Date(c.time);
    const label = `${c.time} ${c.place}`;
    const moon = moonAzEl(date, c.observer);
    assert.ok(apart(moon, c.moon) <= 0.5, `${label}: ${apart(moon, c.moon)}`);
    close(moon.distance, c.moon.distance, 100, label);
    const geo = moonPosition(date);
    assert.ok(apart(geo, c.moon.geocentric) <= 0.05, label);
    const phase = moonPhase(date);
    close(phase.fraction, c.moon.fraction, 0.005, label);
    close(phase.phaseAngle, c.moon.phaseAngle, 0.1, label);
    if (c.moon.fraction > 0.02 && c.moon.fraction < 0.98) {
      // The bright limb only has a direction when there is a terminator to see.
      assert.ok(turn(phase.positionAngle, c.moon.positionAngle) <= 1, `${label} limb`);
      assert.ok(turn(skyDirection(moon, sunAzEl(date, c.observer)), c.moon.litSide) <= 1, `${label} lit side`);
    }
  }
});

test("the planets are within 1 deg of Skyfield, with its magnitudes", () => {
  for (const c of REF.cases) {
    const date = new Date(c.time);
    const m = horizonMatrix(date, c.observer);
    for (const p of planetPositions(date)) {
      const r = c.planets.find((x) => x.name === p.name);
      const label = `${c.time} ${c.place} ${p.name}`;
      assert.ok(apart(toHorizon(m, p.ra, p.dec), r) <= 1, `${label}: ${apart(toHorizon(m, p.ra, p.dec), r)}`);
      assert.ok(apart(p, r) <= 1, label);
      close(p.distance, r.distance, 0.03, label);
      // Mercury's formula is steep near inferior conjunction (2010-01-01: 0.11 mag).
      close(p.magnitude, r.magnitude, p.name === "mercury" ? 0.15 : 0.05, label);
    }
  }
});

test("refraction matches Skyfield's refract()", () => {
  for (const [h, expected] of REF.refraction.samples) close(refraction(h), expected, 0.01, `h=${h}`);
  // A body on the geometric horizon is lifted by 29'; the familiar 34' is for one
  // that already appears on the horizon, which is 34' below it.
  close(refraction(0), 0.48, 0.01);
  close(refraction(-0.57), 0.57, 0.02);
  assert.equal(refraction(90), 0);
  close(refraction(-5), refraction(-1), 1e-12);
  assert.ok(refraction(0, 900, 30) < refraction(0, 1030, -10));
});

test("air mass and extinction grow towards the horizon", () => {
  close(airmass(90), 1, 1e-3, "zenith");
  close(airmass(30), 1.995, 0.01, "30 deg");
  close(airmass(10), 5.59, 0.02, "10 deg");
  close(airmass(0), 38, 0.2, "horizon");
  assert.equal(airmass(-3), airmass(0));
  close(extinction(90), 0, 1e-3);
  close(extinction(10), 0.25 * 4.59, 0.01, "about a magnitude at 10 deg");
  close(extinction(10, 0.2), 0.2 * 4.59, 0.01);
  let previous = -1;
  for (let h = 90; h >= 0; h -= 5) {
    assert.ok(extinction(h) > previous, `monotonic at ${h}`);
    previous = extinction(h);
  }
});

test("sky directions and great-circle steps", () => {
  const north = { azimuth: 0, elevation: 0 };
  close(skyDirection(north, { azimuth: 10, elevation: 0 }), 90, 1e-9, "right");
  close(skyDirection(north, { azimuth: 350, elevation: 0 }), 270, 1e-9, "left");
  close(skyDirection(north, { azimuth: 0, elevation: 10 }), 0, 1e-9, "up");
  close(skyDirection({ azimuth: 180, elevation: 30 }, { azimuth: 180, elevation: 10 }), 180, 1e-9, "down");
  const a = { azimuth: 120, elevation: 20 };
  const b = { azimuth: 200, elevation: 55 };
  assert.ok(apart(towards(a, b, 0), a) < 1e-6);
  assert.ok(apart(towards(a, b, apart(a, b)), b) < 1e-6);
  close(apart(towards(a, b, 5), a), 5, 1e-9);
});

test("moon phase names follow Home Assistant's moon sensor", () => {
  const states = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.99].map(moonPhaseState);
  assert.deepEqual(states, [
    "new_moon", "waxing_crescent", "first_quarter", "waxing_gibbous", "full_moon",
    "waning_gibbous", "last_quarter", "waning_crescent", "new_moon",
  ]);
});

test("the lit part of the Moon as a path", () => {
  assert.equal(moonLitPath(10, 0.5, 90), "M0 -10A10 10 0 0 1 0 10A0 10 0 0 0 0 -10Z");
  assert.equal(moonLitPath(10, 1, 90), "M0 -10A10 10 0 0 1 0 10A10 10 0 0 1 0 -10Z");
  // Lit side down: the limb starts at the right-hand end of the terminator.
  assert.match(moonLitPath(10, 0.25, 180), /^M10 0A10 10 0 0 1 -10 0A5 10 90 0 0 10 0Z$/);
});

test("the sky darkens through twilight and glows on the Sun's side", () => {
  assert.deepEqual([10, -0.5, -3, -9, -15, -30].map(twilight), ["day", "day", "civil", "nautical", "astronomical", "night"]);
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let previous = Infinity;
  let limit = -Infinity;
  for (let h = 30; h >= -30; h -= 1) {
    const p = skyPalette(h);
    assert.ok(lum(p.zenith) <= previous + 1e-9, `zenith brightens at ${h}`);
    assert.ok(p.limit >= limit - 1e-9, `limit drops at ${h}`);
    previous = lum(p.zenith);
    limit = p.limit;
  }
  assert.equal(skyPalette(-40).limit, 6);
  const sun = { azimuth: 250, elevation: -4 };
  assert.ok(lum(skyColor(250, 3, sun)) > lum(skyColor(70, 3, sun)) + 20, "glow");
  assert.ok(lum(skyColor(250, 3, sun)) > lum(skyColor(250, 60, sun)), "glow hugs the horizon");
  const stops = skyGradient(250, sun);
  assert.equal(stops[0].elevation, 0);
  assert.equal(stops.at(-1).elevation, 90);
  assert.ok(stops.every((s) => s.color.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)));
  // A high full Moon lights the night and hides the faint stars.
  const moonlit = skyPalette(-30, { elevation: 50, fraction: 1 });
  assert.ok(lum(moonlit.zenith) > lum(skyPalette(-30).zenith) + 5);
  assert.ok(moonlit.limit < 4.5);
  assert.equal(skyPalette(-30, { elevation: -10, fraction: 1 }).limit, 6);
  assert.equal(cssColor([1, 2, 3]), "rgb(1 2 3)");
  assert.equal(cssColor([1, 2, 3], 0.5), "rgb(1 2 3 / 0.5)");
});

test("star colours, sizes and opacities", () => {
  close(bvToTemperature(0.65), 5780, 100, "the Sun");
  close(bvToTemperature(0), 10000, 300, "Vega");
  const [r1, , b1] = bvToRgb(-0.3);
  const [r2, , b2] = bvToRgb(1.8);
  assert.ok(b1 > r1 && r2 > b2, "blue and red ends");
  assert.deepEqual(bvToRgb(1.8, 0), [255, 255, 255]);
  assert.ok(starRadius(-1.5) > starRadius(1) && starRadius(1) > starRadius(5));
  close(starRadius(6), 0.6, 1e-12);
  assert.equal(starRadius(-4.5), 5); // Venus, capped
  close(starAlpha(6.5), 0, 1e-12);
  assert.equal(starAlpha(4.5), 1);
  assert.ok(starAlpha(5.9) > 0 && starAlpha(5.9) < 1);
});

test("ecliptic and galactic coordinates", () => {
  const centre = galacticToRaDec(0, 0);
  close(centre.ra, 266.405, 0.001);
  close(centre.dec, -28.936, 0.001);
  const pole = galacticToRaDec(123, 90);
  close(pole.ra, 192.8595, 0.001);
  close(pole.dec, 27.1283, 0.001);
  const solstice = eclipticToRaDec(90);
  close(solstice.ra, 90, 1e-9);
  close(solstice.dec, 23.4393, 1e-4);
});

test("the sky at a moment, in one call", () => {
  const date = new Date("2026-01-15T03:30:00Z");
  const observer = { latitude: 39.74, longitude: -104.99, elevation: 1609 };
  const sky = skyAt(date, observer);
  assert.equal(sky.twilight, "night");
  assert.equal(sky.matrix.length, 9);
  assert.deepEqual(sky.planets.map((p) => p.name), ["mercury", "venus", "mars", "jupiter", "saturn"]);
  const jupiter = sky.planets.find((p) => p.name === "jupiter");
  assert.ok(jupiter.elevation > 30 && jupiter.magnitude < -2.5, "Jupiter at opposition in Gemini");
  for (const key of ["azimuth", "elevation", "distance", "radius", "fraction", "cycle", "litSide", "positionAngle"]) {
    assert.equal(typeof sky.moon[key], "number", key);
  }
  assert.equal(sky.palette.limit, 6);
});
