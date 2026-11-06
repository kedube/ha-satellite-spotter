// Tests for loading MapLibre: node --test "tests/js/*.test.mjs"
// A file of its own, as the loader keeps its state for the life of the page
// (here, of the test process).
import assert from "node:assert/strict";
import { test } from "node:test";

const { loadMapLibre, mapLibreNeedsReload } = await import("../../custom_components/satellite_spotter/frontend/sat-maplibre.js");

test("MapLibre is asked for again under a new URL, a reload is offered if it keeps failing, and once loaded it is kept", async () => {
  const asked = [];
  let works = false;
  const maplibre = { Map: class {} };
  const load = async (url) => {
    asked.push(url.slice(url.lastIndexOf("/") + 1));
    if (works) return maplibre;
    throw new TypeError("Failed to fetch dynamically imported module");
  };
  await assert.rejects(loadMapLibre(load));
  await assert.rejects(loadMapLibre(load));
  assert.equal(mapLibreNeedsReload(), false, "two failures may still pass");
  await assert.rejects(loadMapLibre(load));
  assert.equal(mapLibreNeedsReload(), true);
  assert.deepEqual(asked, ["maplibre-gl.mjs", "maplibre-gl.mjs?retry=1", "maplibre-gl.mjs?retry=2"]);
  // A browser that does fetch it again still gets the globe, and keeps it.
  works = true;
  assert.equal(await loadMapLibre(load), maplibre);
  assert.equal(await loadMapLibre(load), maplibre);
  assert.deepEqual(asked.slice(3), ["maplibre-gl.mjs?retry=3"]);
});
