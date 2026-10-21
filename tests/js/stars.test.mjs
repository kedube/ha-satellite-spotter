// Checks of the generated star and constellation data (sat-stars.js, made by
// scripts/make_sky_data.py): node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import { CONSTELLATIONS, STAR_COUNT, STAR_NAMES, STARS } from "../../custom_components/satellite_spotter/frontend/sat-stars.js";

const MODULE = new URL("../../custom_components/satellite_spotter/frontend/sat-stars.js", import.meta.url);
const flat = STARS;
const count = flat.length / 4;
const star = (i) => ({ ra: flat[i * 4], dec: flat[i * 4 + 1], mag: flat[i * 4 + 2], bv: flat[i * 4 + 3] });
const byName = new Map(STAR_NAMES.map(([i, name]) => [name, i]));

const IAU = (
  "And Ant Aps Aqr Aql Ara Ari Aur Boo Cae Cam Cnc CVn CMa CMi Cap Car Cas Cen Cep Cet Cha Cir Col " +
  "Com CrA CrB Crv Crt Cru Cyg Del Dor Dra Equ Eri For Gem Gru Her Hor Hya Hyi Ind Lac Leo LMi Lep " +
  "Lib Lup Lyn Lyr Men Mic Mon Mus Nor Oct Oph Ori Pav Peg Per Phe Pic Psc PsA Pup Pyx Ret Sge Sgr " +
  "Sco Scl Sct Ser Sex Tau Tel Tri TrA Tuc UMa UMi Vel Vir Vol Vul"
).split(" ");

test("the stars are a flat list, brightest first, to about magnitude 5.5", () => {
  assert.equal(STAR_COUNT, count);
  assert.ok(Number.isInteger(count) && count > 2500 && count < 3200, `${count} stars`);
  for (let i = 0; i < count; i++) {
    const s = star(i);
    assert.ok(s.ra >= 0 && s.ra < 360 && Math.abs(s.dec) <= 90, `star ${i} position`);
    // Carbon stars are the reddest: U Hya +2.68, TX Psc +2.60, U Ant +2.88.
    assert.ok(s.bv >= -0.5 && s.bv <= 3, `star ${i} colour ${s.bv}`);
    if (i) assert.ok(s.mag >= star(i - 1).mag, `star ${i} out of order`);
  }
  assert.ok(star(count - 1).mag < 6.5);
  assert.equal(flat.filter((x, i) => i % 4 === 2 && x > 5.5).length <= 5, true, "only a few figure stars past 5.5");
});

test("well known stars are where they should be (SIMBAD, J2000)", () => {
  const known = {
    Sirius: [101.2872, -16.7161, -1.5], Canopus: [95.9880, -52.6957, -0.7], Arcturus: [213.9153, 19.1824, 0],
    Vega: [279.2347, 38.7837, 0], Polaris: [37.9546, 89.2641, 2], Betelgeuse: [88.7929, 7.4071, 0.5],
    "Rigil Kentaurus": [219.90, -60.835, -0.3], Deneb: [310.3580, 45.2803, 1.3], Acrux: [186.6496, -63.0991, 0.8],
  };
  for (const [name, [ra, dec, mag]] of Object.entries(known)) {
    const s = star(byName.get(name));
    assert.ok(Math.abs(s.ra - ra) * Math.cos((dec * Math.PI) / 180) < 0.02 && Math.abs(s.dec - dec) < 0.02, name);
    assert.ok(Math.abs(s.mag - mag) <= 0.15, `${name} ${s.mag}`);
  }
  assert.ok(star(byName.get("Betelgeuse")).bv > 1.5 && star(byName.get("Rigel")).bv < 0.1, "colours");
});

test("the brightest stars carry their IAU names", () => {
  assert.deepEqual(STAR_NAMES.slice(0, 10).map(([, n]) => n), [
    "Sirius", "Canopus", "Rigil Kentaurus", "Arcturus", "Vega", "Capella", "Rigel", "Procyon", "Achernar", "Betelgeuse",
  ]);
  assert.ok(STAR_NAMES.length >= 40);
  assert.equal(new Set(STAR_NAMES.map(([, n]) => n)).size, STAR_NAMES.length);
  for (const [i] of STAR_NAMES) assert.ok(Number.isInteger(i) && i >= 0 && i < count);
  assert.ok(byName.has("Polaris"));
});

test("the 88 IAU constellations are drawn through catalogue stars", () => {
  assert.deepEqual([...new Set(CONSTELLATIONS.map((c) => c.id))].sort(), [...IAU].sort());
  const serpens = CONSTELLATIONS.filter((c) => c.id === "Ser").map((c) => c.name);
  assert.deepEqual(serpens, ["Serpens Caput", "Serpens Cauda"]);
  for (const c of CONSTELLATIONS) {
    assert.ok(c.name && [1, 2, 3].includes(c.rank), c.id);
    assert.ok(c.label[0] >= 0 && c.label[0] < 360 && Math.abs(c.label[1]) <= 90, c.id);
    assert.ok(c.lines.length > 0, `${c.id} has a figure`);
    for (const line of c.lines) {
      assert.ok(line.length > 1, c.id);
      for (const i of line) assert.ok(Number.isInteger(i) && i >= 0 && i < count, `${c.id} ${i}`);
    }
  }
});

test("figures connect the right stars", () => {
  const lines = (id) => CONSTELLATIONS.filter((c) => c.id === id).flatMap((c) => c.lines);
  const joined = (id, a, b) =>
    lines(id).some((l) => l.some((x, k) => k && ((x === a && l[k - 1] === b) || (x === b && l[k - 1] === a))));
  const [alnitak, alnilam, mintaka] = ["Alnitak", "Alnilam", "Mintaka"].map((n) => byName.get(n) ?? -1);
  assert.ok(alnitak >= 0 && alnilam >= 0, "belt stars are named");
  assert.ok(joined("Ori", alnitak, alnilam), "Orion's belt");
  for (const n of ["Betelgeuse", "Rigel", "Bellatrix", "Saiph"]) {
    assert.ok(lines("Ori").flat().includes(byName.get(n)), n);
  }
  assert.ok(joined("UMa", byName.get("Dubhe"), byName.get("Alkaid")) === false, "the Dipper is not a triangle");
  assert.ok(lines("UMa").flat().includes(byName.get("Mizar")), "Mizar in the Dipper's handle");
  assert.ok(lines("Cru").flat().includes(byName.get("Acrux")) && lines("Cru").flat().includes(byName.get("Gacrux")));
  assert.ok(lines("Lyr").flat().includes(byName.get("Vega")));
  assert.equal(mintaka === -1 || lines("Ori").flat().includes(mintaka), true);
});

test("the data stays small and keeps its attribution", () => {
  const size = statSync(MODULE).size;
  assert.ok(size < 100 * 1024, `${size} bytes`);
  const source = readFileSync(MODULE, "utf8");
  const header = source.slice(0, source.indexOf("*/")).replace(/\n \*\s?/g, " ");
  for (const credit of ["Bright Star Catalogue", "IAU Working Group on Star Names", "d3-celestial", "Copyright (c) 2015, Olaf Frohn",
    "Redistributions of source code must retain the above copyright notice", "Sky & Telescope"]) {
    assert.ok(header.includes(credit), credit);
  }
});
