// Unit tests for the magnetic declination (sat-magnetic.js): node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { decimalYear, declination, magneticField } from "../../custom_components/satellite_spotter/frontend/sat-magnetic.js";

// From WMM2025_TestValues.txt, NOAA's official test values for the model:
// decimal year, height (km), latitude, longitude, declination (degrees), and
// the field's north, east and down components (nT).
const OFFICIAL = [
  [2025, 28, 89, -121, -99.77, -255.389, -1482.461, 56194.289],
  [2025, 48, 80, -96, -29.91, 1875.982, -1079.269, 55623.044],
  [2025, 65, 43, 93, 0.50, 24299.853, 210.517, 50037.924],
  [2025, 66, 14, 143, -0.19, 35003.441, -116.625, 7966.315],
  [2025.5, 22, -37, 140, 9.28, 21404.762, 3498.897, -55397.588],
  [2026.5, 44, -46, -42, -11.36, 13863.177, -2785.834, -19744.304],
  [2027, 61, 59, -77, -16.48, 10437.776, -3087.392, 54397.714],
  [2027.5, 96, -46, -85, 17.93, 18947.658, 6129.590, -21631.434],
  [2028.5, 39, -65, -88, 29.45, 17946.906, 10131.663, -35982.873],
  [2029, 95, -60, -59, 8.58, 17893.019, 2700.106, -26011.846],
  [2029, 41, 42, -19, -4.13, 24439.978, -1762.894, 36929.898],
  [2029.5, 18, 9, -172, 9.24, 30520.999, 4966.942, 8779.472],
];

test("the World Magnetic Model gives NOAA's official test values", () => {
  for (const [year, altKm, lat, lon, D, X, Y, Z] of OFFICIAL) {
    const where = `${lat}, ${lon} at ${altKm} km in ${year}`;
    // The declinations are published to 2 decimals.
    assert.ok(Math.abs(declination(lat, lon, altKm, year) - D) <= 0.005, `declination at ${where}`);
    const field = magneticField(lat, lon, altKm, year);
    for (const [got, want, name] of [[field.north, X, "north"], [field.east, Y, "east"], [field.down, Z, "down"]]) {
      assert.ok(Math.abs(got - want) <= 0.01, `${name} at ${where}: ${got} != ${want}`);
    }
  }
});

test("a compass in Boston points about 14 degrees west of true north, in Seattle 15 east", () => {
  const year = decimalYear(Date.parse("2026-10-17T21:00:00Z"));
  assert.ok(year > 2026.79 && year < 2026.8);
  const boston = declination(42.3601, -71.0589, 0, year);
  const seattle = declination(47.6062, -122.3321, 0, year);
  assert.ok(boston > -14.5 && boston < -13.5, `Boston ${boston}`);
  assert.ok(seattle > 14.5 && seattle < 15.5, `Seattle ${seattle}`);
});

test("decimal years count from the start of the year in UTC, leap years included", () => {
  assert.equal(decimalYear(Date.parse("2025-01-01T00:00:00Z")), 2025);
  assert.equal(decimalYear(new Date("2025-07-02T12:00:00Z")), 2025.5);
  assert.equal(decimalYear(Date.parse("2028-07-02T00:00:00Z")), 2028.5);
});
