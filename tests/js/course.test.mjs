// The rows a satellite moves along on the globe, apart from any drawing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { courseOf, mergeRows, orbitIsEnough, orbitSpan, rowsBetween, tickTimes } from "../../custom_components/satellite_spotter/frontend/sat-course.js";
import { MAX_ROW_GAP_S, positionAt } from "../../custom_components/satellite_spotter/frontend/sat-geo.js";

const P = 5574; // The ISS's period.
const T0 = 1_800_000_000;

/** A row every `step` seconds, its latitude telling its time. */
const rows = (from, to, step = 30) => {
  const out = [];
  for (let t = from; t <= to; t += step) out.push([t, ((t - T0) / 100) % 80, 0, 420, 1]);
  return out;
};

test("no position is made up between the orbit and a pass hours later", () => {
  const course = mergeRows(rows(T0, T0 + 3000), rows(T0 + 4 * 3600, T0 + 4 * 3600 + 300, 2));
  assert.ok(positionAt(course, T0 + 1500), "along the orbit");
  assert.ok(positionAt(course, T0 + 4 * 3600 + 100), "during the pass");
  assert.equal(positionAt(course, T0 + 3600), null, "and nothing in between");
  // Right up to the edges of the gap.
  assert.ok(positionAt(course, T0 + 3000));
  assert.equal(positionAt(course, T0 + 3001), null);
});

test("rows as far apart as a slow track can be are still a track", () => {
  assert.ok(positionAt([[0, 0, 0, 400, 1], [MAX_ROW_GAP_S, 1, 1, 400, 1]], 10));
  assert.equal(positionAt([[0, 0, 0, 400, 1], [MAX_ROW_GAP_S + 1, 1, 1, 400, 1]], 10), null);
});

test("a tick is only ever on the orbit, wherever the rows stop", () => {
  // As it was: the orbit run down to 0.75 of a period ahead, and the pass some hours on.
  const now = T0 + 0.5 * P;
  const orbit = rows(T0 - 0.5 * P, T0 + 1.25 * P);
  const course = mergeRows(orbit, rows(T0 + 5 * 3600, T0 + 5 * 3600 + 300, 2));
  const lastOfOrbit = orbit[orbit.length - 1][0];
  for (const t of tickTimes(course, now, P, 15 * 60)) {
    const position = positionAt(course, t);
    assert.ok(position === null || t <= lastOfOrbit, `a position at ${t - lastOfOrbit} s past the orbit`);
  }
});

test("the orbit is asked for again in good time, so that the ticks never run out", () => {
  let now = T0;
  let have = { norad: 25544, ...orbitSpan(now, P) };
  assert.equal(have.from, Math.floor(T0 - 0.5 * P));
  assert.equal(have.to, Math.ceil(T0 + 1.5 * P));
  let asked = 0;
  // A day and a half, minute by minute.
  for (; now < T0 + 36 * 3600; now += 60) {
    if (!orbitIsEnough(have, 25544, now, P)) {
      have = { norad: 25544, ...orbitSpan(now, P) };
      asked++;
    }
    assert.ok(have.to >= now + P, `the orbit reaches a whole period ahead, at ${now - T0} s`);
    assert.ok(have.from <= now);
  }
  assert.ok(asked > 20 && asked < 60, `asked ${asked} times`);
});

test("another satellite's orbit is no use", () => {
  const have = { norad: 1, ...orbitSpan(T0, P) };
  assert.equal(orbitIsEnough(have, 1, T0, P), true);
  assert.equal(orbitIsEnough(have, 2, T0, P), false);
  assert.equal(orbitIsEnough(null, 2, T0, P), false);
});

test("the course takes the pass's rows of the satellite followed, whichever of them it is", () => {
  const orbit = rows(T0, T0 + 3000);
  const detail = {
    transits: [
      { norad_id: 1, rows: rows(T0 + 100, T0 + 200, 2) },
      { norad_id: 2, rows: rows(T0 + 400, T0 + 500, 2) },
    ],
  };
  const second = courseOf(orbit, detail, 2);
  assert.ok(second.some((r) => r[0] === T0 + 402));
  assert.ok(!second.some((r) => r[0] === T0 + 102));
  assert.equal(courseOf(orbit, detail, 3), orbit, "a satellite not in the pass has only its orbit");
  assert.equal(courseOf(orbit, null, 1), orbit);
  assert.deepEqual(courseOf(null, null, 1), []);
});

test("the part of a pass that can be seen is cut out of its rows", () => {
  const cut = rowsBetween(rows(0, 100, 10), 30, 60);
  assert.deepEqual(cut.map((r) => r[0]), [30, 40, 50, 60]);
  assert.deepEqual(rowsBetween(null, 0, 1), []);
});
