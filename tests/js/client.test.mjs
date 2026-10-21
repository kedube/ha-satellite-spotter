// Tests for the globe's websocket client and its rules for errors, clocks and
// retries: node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMANDS,
  MAX_TRACK_ROWS,
  SatClient,
  errorCode,
  errorIsTransient,
  errorMessage,
  errorText,
  nextClockOffset,
  nextDelay,
  trackStep,
} from "../../custom_components/satellite_spotter/frontend/sat-client.js";

function fakeHass(answer) {
  const calls = [];
  return {
    calls,
    hass: {
      callWS: async (msg) => {
        calls.push(msg);
        return answer(msg);
      },
    },
  };
}

test("errors are told apart whatever shape the websocket gives them", () => {
  assert.equal(errorCode(3), 3);
  assert.equal(errorCode({ code: 3, message: "Connection lost" }), 3);
  assert.equal(errorCode({ error: { code: "not_found", message: "x" } }), "not_found");
  assert.equal(errorCode("boom"), undefined);
  assert.equal(errorMessage({ code: "home_assistant_error", message: "Not ready" }), "Not ready");
  assert.equal(errorMessage(3, "Verbindung verloren"), "Verbindung verloren");
  assert.equal(errorMessage({ code: "x" }), "x");
  assert.equal(errorMessage("plain text"), "plain text");
  assert.doesNotMatch(errorMessage({ error: { foo: 1 } }), /object Object/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(typeof errorMessage(cyclic), "string");
  assert.equal(errorIsTransient({ code: "not_ready" }), true);
  assert.equal(errorIsTransient(3), true);
  assert.equal(errorIsTransient({ code: "unknown_pass" }), false);
  // A location that failed to set up will not recover by waiting: no spinner.
  assert.equal(errorIsTransient({ code: "setup_failed" }), false);
});

test("each error gets its sentence", () => {
  assert.deepEqual(errorText(3), { key: "globe.reconnecting" });
  assert.deepEqual(errorText({ code: "not_found" }), { key: "globe.not_set_up" });
  assert.deepEqual(errorText({ code: "unknown_location" }), { key: "globe.location_gone_card" });
  assert.deepEqual(errorText({ code: "unknown_location" }, { panel: true }), { key: "globe.location_gone_panel" });
  assert.deepEqual(errorText({ code: "location_disabled" }), { key: "globe.location_disabled" });
  assert.deepEqual(errorText({ code: "stale_catalog" }), { key: "globe.stale_catalog" });
  // The integration's reason, unless it only says that it is waiting.
  assert.deepEqual(errorText({ code: "not_ready", message: "Waiting for the satellite catalogue" }), { key: "globe.waiting" });
  assert.deepEqual(errorText({ code: "not_ready", message: "Catalogue download failed: HTTP 503" }), {
    key: "globe.waiting_because",
    vars: { reason: "Catalogue download failed: HTTP 503" },
  });
  assert.deepEqual(errorText({ code: "home_assistant_error", message: "Boom" }), { key: "globe.data_failed", vars: { error: "Boom" } });
  assert.deepEqual(errorText({ code: "setup_failed", message: "Setup failed; see the Home Assistant log" }), {
    key: "globe.data_failed",
    vars: { error: "Setup failed; see the Home Assistant log" },
  });
});

test("a device clock that is off is corrected from the server's time, steadily", () => {
  // 1000 s server time against 2000 s on the device, round trip 100 ms.
  assert.equal(nextClockOffset(0, 1000, 2_000_000, 2_000_100), 1_000_000 - 2_000_050);
  assert.equal(nextClockOffset(0, 2000.5, 2_000_000, 2_000_100), 0, "half a second: left alone");
  assert.equal(nextClockOffset(123, 1000, 2_000_000, 2_005_000), 123, "too slow a round trip to trust");
  assert.equal(nextClockOffset(123, undefined, 0, 10), 123);
  // About two seconds off: once correcting, keep correcting until within a second.
  const ahead = (current, ms) => nextClockOffset(current, 2000 + ms / 1000, 1_999_950, 2_000_050);
  let offset = ahead(0, 2500);
  assert.equal(offset, 2500);
  offset = ahead(offset, 1500);
  assert.equal(offset, 1500);
  offset = ahead(offset, 500);
  assert.equal(offset, 0);
  assert.equal(ahead(offset, 1500), 0, "a clock that agrees is not corrected for noise");
});

test("back-offs double from the minimum up to the maximum", () => {
  let d = 0;
  const seen = [];
  for (let i = 0; i < 10; i++) seen.push((d = nextDelay(d, 3000, 60000)));
  assert.deepEqual(seen, [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000, 60000, 60000]);
});

test("a long track asks for a coarser step, within the integration's limit", () => {
  assert.equal(trackStep(3600, 30), 30);
  assert.equal(trackStep(36 * 3600, 30), 30);
  assert.equal(trackStep(7 * 86400, 30), Math.ceil((7 * 86400) / (MAX_TRACK_ROWS - 1)));
  assert.ok((7 * 86400) / trackStep(7 * 86400, 30) < MAX_TRACK_ROWS);
});

test("pass tracks are asked for once per pass, and an old id finds the current one", async () => {
  const { hass, calls } = fakeHass((msg) => ({ pass_id: msg.pass_id === "old-1" ? "25544-100" : msg.pass_id, step: 2, transits: [] }));
  const client = new SatClient(() => hass);
  const [a, b] = await Promise.all([client.passTrack("25544-100", { entryId: "E" }), client.passTrack("25544-100", { entryId: "E" })]);
  assert.equal(a, b);
  assert.equal(calls.length, 1, "one request for two callers");
  assert.deepEqual(calls[0], { type: COMMANDS.passTrack, pass_id: "25544-100", entry_id: "E" });
  await client.passTrack("25544-100", { entryId: "E" });
  assert.equal(calls.length, 1, "kept");
  const moved = await client.passTrack("old-1", { entryId: "E" });
  assert.equal(moved.pass_id, "25544-100");
  await client.passTrack("old-1", { entryId: "E" });
  assert.equal(calls.length, 2);
  // Another location's pass of the same id is another pass.
  await client.passTrack("25544-100", { entryId: "F" });
  assert.equal(calls.length, 3);
  client.clear();
  await client.passTrack("25544-100", { entryId: "E" });
  assert.equal(calls.length, 4, "a new location starts afresh");
});

test("a failed request is not kept, so it is asked for again", async () => {
  let fail = true;
  const { hass, calls } = fakeHass(() => {
    if (fail) {
      fail = false;
      throw { code: "not_ready", message: "Starting up" };
    }
    return { track: [[0, 1, 2, 400, 1]] };
  });
  const client = new SatClient(() => hass);
  await assert.rejects(client.track(25544, 0, 600), (err) => err.code === "not_ready");
  assert.deepEqual(await client.track(25544, 0, 600), [[0, 1, 2, 400, 1]]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    type: COMMANDS.track,
    norad_id: 25544,
    start: "1970-01-01T00:00:00.000Z",
    end: "1970-01-01T00:10:00.000Z",
    step: 30,
  });
});

test("positions, the catalogue and the tiles token", async () => {
  const { hass, calls } = fakeHass((msg) => {
    if (msg.type === COMMANDS.catalog) return { version: 3, satellites: [] };
    if (msg.type === COMMANDS.mapToken) return { token: "abc" };
    return { start: 0, step: 60, count: 11, ids: [] };
  });
  const client = new SatClient(() => hass);
  await client.positions();
  await client.positions({ startS: 1792400860.4, span: 1800, step: 60, entryId: "E" });
  assert.deepEqual(calls[0], { type: COMMANDS.positions, span: 600, step: 60 });
  assert.deepEqual(calls[1], { type: COMMANDS.positions, span: 1800, step: 60, start: "2026-10-19T09:07:40.000Z", entry_id: "E" });
  assert.equal((await client.catalog({ version: 3 })).version, 3);
  await client.catalog({ version: 3 });
  await client.catalog();
  assert.equal(calls.filter((c) => c.type === COMMANDS.catalog).length, 1, "kept per version");
  await client.catalog({ version: 4 });
  assert.equal(calls.filter((c) => c.type === COMMANDS.catalog).length, 2, "a new version is fetched");
  assert.deepEqual(await client.mapToken(), { token: "abc" });
  // Without Home Assistant there is nothing to ask.
  await assert.rejects(new SatClient(() => null).passes());
});
