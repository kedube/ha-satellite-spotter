// The views in a real browser: what a fake DOM and a fake WebGL cannot show. Needs Node 22 or newer
// and Chrome, and nothing else; everything leaving this machine is stopped:
//
//   node tests/browser/run.mjs
//
// (The path of Chrome can be given in CHROME. Test places only: never anyone's home.)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const CHROMES = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png", ".pbf": "application/x-protobuf", ".webp": "image/webp" };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const skyPhoto = readFileSync(join(ROOT, "tests/browser/sky.jpg"));

/** Files of the integration that a page asked for and that are not there. */
const missing = new Set();

/** Serve the repository, for the page to load the real modules from. */
function serve() {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname));
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      if (path.startsWith("/custom_components/")) missing.add(path);
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(readFileSync(file));
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

/** A PNG of flat ground for the terrain tiles: Terrarium keeps the height as red × 256 + green − 32768. */
function flatTerrain(meters) {
  const part = (kind, data) => {
    const body = Buffer.concat([Buffer.from(kind), data]);
    const [length, check] = [Buffer.alloc(4), Buffer.alloc(4)];
    length.writeUInt32BE(data.length);
    check.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0);
  header.writeUInt32BE(256, 4);
  header.set([8, 2], 8); // 8 bits, RGB.
  const height = meters + 32768;
  const row = Buffer.from([0, ...Array.from({ length: 256 }, () => [height >> 8, height & 255, 0]).flat()]);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return Buffer.concat([Buffer.from(signature), part("IHDR", header), part("IDAT", deflateSync(Buffer.concat(Array(256).fill(row)))), part("IEND", Buffer.alloc(0))]);
}

/** A vector tile with one square building in its middle, for MapLibre's worker to read and its layers to draw. */
function vectorTile() {
  const varint = (value) => {
    const out = [];
    for (; value > 127; value >>>= 7) out.push((value & 127) | 128);
    return Buffer.from([...out, value]);
  };
  const whole = (tag, value) => Buffer.concat([varint(tag << 3), varint(value)]);
  const bytes = (tag, ...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([varint((tag << 3) | 2), varint(body.length), body]);
  };
  const packed = (tag, values) => bytes(tag, ...values.map(varint));
  const side = 300 << 1; // Zigzag: positive numbers doubled, negative ones doubled and less one.
  const back = (300 << 1) - 1;
  const start = 1900 << 1;
  // MoveTo, three LineTos, ClosePath.
  const outline = [9, start, start, 26, side, 0, 0, side, back, 0, 15];
  const feature = bytes(2, whole(1, 1), packed(2, [0, 0]), whole(3, 3), packed(4, outline));
  return bytes(3, bytes(1, Buffer.from("building")), feature, bytes(3, Buffer.from("render_height")), bytes(4, whole(5, 20)), whole(5, 4096), whole(15, 2));
}

const TERRAIN_M = 500;
const openFreeMap = {
  tilejson: "3.0.0",
  tiles: ["https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf"],
  minzoom: 0,
  maxzoom: 14,
  vector_layers: [{ id: "building", fields: {} }],
};

const panoramaxFeature = (id, offset) => ({
  id,
  type: "Feature",
  geometry: { type: "Point", coordinates: [11 + offset, 48] },
  properties: { datetime: "2025-07-01T12:00:00Z", "geovisio:producer": "test", license: "CC-BY-4.0", "view:azimuth": 10, "pers:interior_orientation": { field_of_view: 360 } },
  assets: { sd: { href: `https://photos.example.test/${id}-sd.jpg` }, hd: { href: `https://photos.example.test/${id}-hd.jpg` } },
  links: [],
});
const panoramax = { type: "FeatureCollection", features: ["first", "second", "third"].map((id, i) => panoramaxFeature(id, 0.0002 * (i + 1))) };
let photoRequests = 0;

/** A check's own answers to some requests: an answer as outside() gives, "fail", or "hold" for answering later. */
let staged = () => null;
const held = [];

/** What the outside world answers: the street photos' search and its pictures, and the 3D street view's tiles. */
function outside(url) {
  const { host, pathname } = new URL(url);
  if (host === "tiles.openfreemap.org") {
    return pathname === "/planet"
      ? { body: Buffer.from(JSON.stringify(openFreeMap)), type: "application/json" }
      : { body: vectorTile(), type: "application/x-protobuf" };
  }
  if (host === "s3.amazonaws.com") return { body: flatTerrain(TERRAIN_M), type: "image/png" };
  if (host === "api.panoramax.xyz") return { body: Buffer.from(JSON.stringify(panoramax)), type: "application/json" };
  if (host === "photos.example.test") {
    photoRequests++;
    return { body: skyPhoto, type: "image/jpeg" };
  }
  return null;
}

async function startChrome() {
  const chrome = CHROMES.find((path) => path && existsSync(path));
  if (!chrome) throw new Error("Chrome was not found: give its path in CHROME");
  const profile = mkdtempSync(join(tmpdir(), "satellite-spotter-browser-test-"));
  const port = 19000 + (process.pid % 900);
  const browser = spawn(
    chrome,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-extensions",
      "--no-pings",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      // Real WebGL 2 without a graphics card.
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--window-size=1200,800",
      ...(process.env.CI ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    await sleep(200);
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      // Not yet.
    }
  }
  if (!version) throw new Error("Chrome did not start");
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  let nextId = 0;
  const waiting = new Map();
  const listeners = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { done, fail } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) fail(new Error(JSON.stringify(message.error)));
      else done(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((done, fail) => {
      const id = ++nextId;
      waiting.set(id, { done, fail });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const on = (method, params) => send(method, params, sessionId);
  const fulfill = (requestId, answer) => {
    if (!answer) {
      on("Fetch.failRequest", { requestId, errorReason: "NameNotResolved" }).catch(() => {});
      return;
    }
    on("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "Access-Control-Allow-Origin", value: "*" },
        { name: "Content-Type", value: answer.type },
      ],
      body: answer.body.toString("base64"),
    }).catch(() => {});
  };
  const console_ = [];
  listeners.push((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") console_.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") console_.push(`console.error: ${message.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      if (request.url.startsWith("http://127.0.0.1")) {
        on("Fetch.continueRequest", { requestId }).catch(() => {});
        return;
      }
      const plan = staged(request.url);
      if (plan === "hold") {
        held.push({ requestId, url: request.url });
        return;
      }
      fulfill(requestId, plan === "fail" ? null : plan ?? outside(request.url));
    }
  });
  await on("Runtime.enable");
  await on("Page.enable");
  await on("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  const evaluate = async (expression) => {
    const result = await on("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const stop = () => {
    socket.close();
    browser.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  return { on, evaluate, stop, fulfill, console: console_ };
}

const results = [];
function check(condition, what) {
  results.push([!!condition, what]);
  console.log(`${condition ? "ok  " : "FAIL"} ${what}`);
}

const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = await startChrome();

/** Open a view, wait for it, and say nothing went wrong on the way. */
async function open(mode, extra = "") {
  chrome.console.length = 0;
  await chrome.on("Page.navigate", { url: `${origin}/tests/browser/harness.html?mode=${mode}${extra}` });
  for (let i = 0; i < 120 && !(await chrome.evaluate("window.__ready === true").catch(() => false)); i++) await sleep(250);
  check(await chrome.evaluate("window.__ready === true"), `${mode}: it loads`);
}

/** Evaluate until it holds, for up to `ms`, and say whether it did. Only a failure takes that long, and GitHub's machines are slow. */
const until = async (expression, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await chrome.evaluate(expression).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
};
const stage = (call) => chrome.evaluate(`window.__stage.${call}`);
const press = async (key, code, keyCode) => {
  const event = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await chrome.on("Input.dispatchKeyEvent", { type: "keyDown", ...event });
  await chrome.on("Input.dispatchKeyEvent", { type: "keyUp", ...event });
};

const noErrors = async (mode) => {
  const errors = await chrome.evaluate("window.__errors");
  check(errors.length === 0, `${mode}: no errors on the page ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ""}`);
  // A blocked request is reported by the browser, not by the page's code.
  const real = chrome.console.filter((line) => !/ERR_NAME_NOT_RESOLVED|Failed to fetch|NetworkError|AJAXError/.test(line));
  check(real.length === 0, `${mode}: nothing in the console ${real.length ? JSON.stringify(real.slice(0, 3)) : ""}`);
};

/** How much of a page's text can be read, through its shadow roots. */
const TEXT_OF_PAGE = `(() => { const walk = (node) => { let out = ""; for (const child of node.childNodes ?? []) { if (child.nodeType === 3) out += child.textContent + " "; else if (child.tagName !== "STYLE" && child.tagName !== "SCRIPT") out += walk(child); } if (node.shadowRoot) out += walk(node.shadowRoot); return out; }; return walk(document.body); })()`;

try {
  // The atmosphere's Sun: a fake WebGL draws nothing to look at.
  await open("light");
  const june = await chrome.evaluate(`window.__limbs("2026-06-21T12:00:00Z")`);
  const december = await chrome.evaluate(`window.__limbs("2026-12-21T12:00:00Z")`);
  check(june.north > june.south, `light: in June the northern limb glows (${JSON.stringify(june)})`);
  check(december.south > december.north, `light: in December the southern limb glows (${JSON.stringify(december)})`);
  await noErrors("light");

  // The street view: taking a scene away gives up its WebGL context, which a fake WebGL never did.
  await open("street");
  const street = `(() => { const s = window.__view; return { mode: s._mode, photo: s._scene?.photo?.id }; })()`;
  for (let i = 0; i < 80 && (await chrome.evaluate(street)).mode !== "photo"; i++) await sleep(250);
  check((await chrome.evaluate(street)).mode === "photo", "street: a photo shows");
  await chrome.evaluate(`(() => { const s = window.__view; window.__restarts = 0; const go = s._restartScene.bind(s); s._restartScene = () => { window.__restarts++; go(); }; })()`);
  const before = photoRequests;
  await chrome.evaluate("window.__view._stepPhoto(1)");
  await sleep(13000);
  check((await chrome.evaluate("window.__restarts")) === 1, "street: stepping to another photo restarts it once, and not again");
  check(photoRequests - before <= 2, `street: and fetches one photo (${photoRequests - before} requests)`);
  check((await chrome.evaluate(street)).mode === "photo", "street: which stays up");
  // As a phone waking: the browser takes every WebGL context away, and gives it back.
  const photoLost = await stage("photoContext()");
  check(photoLost.veilWhileLost, "street: a context lost says it is reloading");
  check(!photoLost.veilAfter && photoLost.restarts === 0 && photoLost.sameScene, `street: and back within the wait, the photo goes on as it was (${JSON.stringify(photoLost)})`);
  const closed = await stage("closeWhileWaiting()");
  check(closed.thrown === null && !closed.scene, `street: closed during that wait, it lets go of the scene (${JSON.stringify(closed)})`);
  await noErrors("street");

  // Opened with the network down: when it is back, the street view has another go.
  staged = () => "fail";
  await open("street");
  const missed = `(() => { const s = window.__view; return !!s._mode && s._missedNetwork; })()`;
  check(await until(missed), `street, offline: it opens without what it could not reach (${await chrome.evaluate("window.__view._mode")})`);
  staged = () => null;
  await chrome.evaluate(`window.dispatchEvent(new Event("online"))`);
  check(await until(`window.__view._mode === "photo"`), `street, offline: the network back, the photo comes (${await chrome.evaluate("window.__view._mode")})`);
  await noErrors("street, offline");

  // The 3D street view on stand-in tiles: where MapLibre's internals are used.
  await open("street", "&source=model");
  const scene = `(() => { const s = window.__view, c = s._scene; return s._mode === "3d" && c._loaded.get("ofm") > 0 && c.map.queryTerrainElevation([c.longitude, c.latitude]) > 0; })()`;
  for (let i = 0; i < 240 && !(await chrome.evaluate(scene)); i++) await sleep(250);
  const camera = await chrome.evaluate("window.__streetCamera()");
  check(camera.mode === "3d", `street, 3D: the model shows (${camera.mode})`);
  check(camera.degraded.length === 0, `street, 3D: with nothing given up on ${camera.degraded}`);
  check(camera.tiles > 0, "street, 3D: MapLibre's worker read the map's tiles");
  check(Math.abs(camera.terrain - TERRAIN_M) < 1, `street, 3D: the terrain is drawn at its height (${camera.terrain})`);
  check(camera.eyeOffM < 0.01 && Math.abs(camera.altitudeOffM) < 0.01, `street, 3D: the camera is at the eye (${camera.eyeOffM} m off, ${camera.altitudeOffM} m up)`);
  check(camera.worldSize > 0, "street, 3D: the trees' layer can read the size of the world");
  check(camera.farPlane && Math.abs(camera.far - 1) < 1e-6 && Math.abs(camera.near - 1) < 1e-6, `street, 3D: the private near and far planes hold (${camera.near}, ${camera.far})`);
  check(Math.abs(camera.farAfter - 1) < 1e-6 && Math.abs(camera.nearAfter - 1) < 1e-6, `street, 3D: and outlast a move of the camera (${camera.nearAfter}, ${camera.farAfter})`);
  check(camera.skyOffPx < 0.5, `street, 3D: the sky stays on the map (${camera.skyOffPx} px off)`);
  const sceneBack = await stage("sceneContext()");
  check(sceneBack.newScene && sceneBack.mode === "3d" && sceneBack.tiles > 0, `street, 3D: a context lost and back brings a new map, its tiles read (${JSON.stringify(sceneBack)})`);
  await noErrors("street, 3D");

  // The globe: a real map, taken apart and built again.
  await open("globe");
  const globe = `(() => { const v = window.__view; return { loaded: !!v._loaded, cloud: !!v._space?._cloud, positions: window.__asked["satellite_spotter/positions"] ?? 0 }; })()`;
  for (let i = 0; i < 80 && !(await chrome.evaluate(globe)).cloud; i++) await sleep(250);
  check((await chrome.evaluate(globe)).cloud, "globe: the satellites are handed to the layer");
  const asked = (await chrome.evaluate(globe)).positions;
  await chrome.evaluate("(() => { window.__parent = window.__view.parentNode; window.__view.remove(); })()");
  await sleep(31000);
  check(!(await chrome.evaluate(globe)).loaded, "globe: away for half a minute, its map is freed");
  await chrome.evaluate("window.__parent.append(window.__view)");
  for (let i = 0; i < 60 && !(await chrome.evaluate(globe)).cloud; i++) await sleep(250);
  const back = await chrome.evaluate(globe);
  check(back.loaded && back.cloud, "globe: back again, the satellites are on the new map");
  check(back.positions === asked, "globe: without asking for them again");
  const pole = await chrome.evaluate("window.__globeNearThePole()");
  check(pole.over.latitude > 88.9, `globe: the camera can follow a satellite close to a pole (${pole.over.latitude}°)`);
  check(Math.abs(pole.over.radiusPx / pole.edge.radiusPx - 1) < 0.01, `globe: which grows no further there than at the edge of the map (${pole.edge.radiusPx} px, ${pole.over.radiusPx} px)`);
  check(pole.over.limit === pole.edge.limit, `globe: as the zoom limit of a camera following it assumes (${pole.edge.limit}, ${pole.over.limit})`);
  await noErrors("globe");

  // New predictions: a pass's id changes, and another can start close by.
  await open("globe");
  for (let i = 0; i < 80 && !(await chrome.evaluate("!!window.__view._loaded")); i++) await sleep(250);
  const picks = await chrome.evaluate("window.__search.picks()");
  check(picks.movedALittle.off === 5 && picks.movedALittle.user, `new predictions: a pick moved 5 s stays, with a pass starting 100 s before it (${JSON.stringify(picks.movedALittle)})`);
  check(picks.movedFar.off === 305 && picks.movedFar.user, `new predictions: and one moved 5 minutes (${JSON.stringify(picks.movedFar)})`);
  check(picks.split.off === 20220 && picks.split.user, `new predictions: a group that splits is followed by its brightest satellite, not the nearer part (${JSON.stringify(picks.split)})`);
  check(picks.gone.user === false, `new predictions: a pick that has gone is no pick, with a neighbor within 120 s (${JSON.stringify(picks.gone)})`);
  const paths = await chrome.evaluate("window.__search.globePath()");
  check(paths.refused, "new predictions: the globe refuses a neighbor's path");
  check(paths.taken, "new predictions: and takes a pass's own, under the id it has now");
  // The globe's answer, and the one the street view gets by asking Home Assistant itself a little later.
  const answered = (await chrome.evaluate("window.__search.openStreet()")) + 2;
  for (let i = 0; i < 40 && (await chrome.evaluate(`window.__asked["satellite_spotter/pass_track"]`)) < answered; i++) await sleep(250);
  await sleep(250);
  const refused = await chrome.evaluate("window.__search.street()");
  check(refused.tag === "SATELLITE-STREET-VIEW" && !refused.satellites && !refused.drawn, `new predictions: the street view refuses a neighbor's path, and draws nothing (${JSON.stringify(refused)})`);
  await chrome.evaluate("window.__search.ownPath()");
  const own = async () => chrome.evaluate("window.__search.street()");
  for (let i = 0; i < 80 && !(await own()).drawn; i++) await sleep(250);
  const drawn = await own();
  check(drawn.drawn && drawn.satellites?.includes(25544) && !drawn.satellites.includes(48274), `new predictions: it goes on asking, and draws the pass's own (${JSON.stringify(drawn)})`);
  const late = await chrome.evaluate("window.__search.latePath()");
  check(late.asking && late.movedOn && late.arrived, `new predictions: a path on its way as the street view moves on (${JSON.stringify(late)})`);
  check(late.stayed, "new predictions: which does not take it back");
  await noErrors("new predictions");

  // New predictions and time, with a street view or a replay running.
  const movedInStreet = await stage("movedInStreet()");
  check(movedInStreet.selected === movedInStreet.wanted && movedInStreet.street === movedInStreet.wanted && movedInStreet.path === movedInStreet.wanted, `new predictions: a street view goes on with the pass it shows, and its path (${JSON.stringify(movedInStreet)})`);
  check(movedInStreet.visibleStart, "new predictions: and so does the part of the replay that is highlighted");
  const dropped = await stage("droppedInReplay()");
  check(dropped.label === "Next pass" && dropped.clock !== "None soon" && dropped.selected && !dropped.user, `new predictions: a replay's pass gone, back to live the next one is shown (${JSON.stringify(dropped)})`);
  const past = await stage("pickPastItsPass()");
  check(past.stayed && past.selected && past.tookS < 15, `as time passes: a pick stays a minute past its pass, then gives way without waiting for a refresh (${JSON.stringify(past)})`);
  const offer = await stage("nextPass()");
  check(offer.live && /Next: Coming at/.test(offer.offered) && offer.offeredAt >= 0, `as time passes: a live pass over in the street view, the next is offered (${JSON.stringify(offer)})`);
  check(offer.now && offer.selected && offer.hiddenAgain, "as time passes: and the offer taken, page and street view are on that pass");
  await noErrors("new predictions, over time");

  // A tile that fails, and is asked for again: the globe goes on drawing until it comes.
  const failingTiles = new Set();
  let tileRequests = 0;
  let holdTiles = false;
  let failTiles = true;
  staged = (url) => {
    if (!/gibs\.earthdata/.test(url)) return null;
    if (holdTiles) return "hold";
    if (failTiles && tileRequests++ % 2) failingTiles.add(url);
    return failingTiles.has(url) ? "fail" : { body: skyPhoto, type: "image/jpeg" };
  };
  await open("globe");
  check(await until("!!window.__view._loaded && window.__stage.failedTiles() > 0 && window.__stage.imageryTiles().waiting === 0"), "a tile fails: the globe knows it is missing");
  const tilesAtFirst = await stage("imageryTiles()");
  check(tilesAtFirst.failed > 0 && tilesAtFirst.drawn > 0, `a tile fails: some of the globe's imagery came, and some did not (${JSON.stringify(tilesAtFirst)})`);
  holdTiles = true;
  const rendersHeld = await stage(`rendersDuring(() => window.__view._refreshFailedTiles(), 1500)`);
  check(rendersHeld >= 2, `a tile fails: asked for again, the globe goes on drawing until it comes (${rendersHeld} frames)`);
  check(held.some((h) => failingTiles.has(h.url)), `a tile fails: and it is asked for (${held.length} requests, ${failingTiles.size} had failed)`);
  holdTiles = failTiles = false;
  failingTiles.clear();
  for (const { requestId } of held.splice(0)) chrome.fulfill(requestId, { body: skyPhoto, type: "image/jpeg" });
  check(await until("(() => { const t = window.__stage.imageryTiles(); return !t.failed && !t.waiting && t.drawn > 0; })()"), `a tile fails: once it comes, it is drawn (${JSON.stringify(await stage("imageryTiles()"))})`);
  check((await stage("rendersDuring(() => {}, 300)")) >= 1, "a tile fails: and the globe is still drawing");
  check((await stage("failedTiles()")) === 0, "a tile fails: and nothing is left to ask for");
  await noErrors("a tile fails");
  staged = () => null;

  // The street view over the globe: the keyboard, storage that cannot be used, and the globe's own context.
  await open("globe");
  await until("!!window.__view._loaded");
  const blocked = await stage("openStreetBlockedStorage()");
  check(blocked.outcome === "opened" && blocked.street, `street view on the globe: opens where storage is blocked (${JSON.stringify(blocked)})`);
  await sleep(1500);
  const keys = await stage("keyboard()");
  check(keys.inStreet && /stage/.test(keys.focused), `street view on the globe: the keyboard goes with it (${JSON.stringify(keys)})`);
  check(keys.under === 0, `street view on the globe: nothing to Tab to under it (${keys.under})`);
  await press("ArrowRight", "ArrowRight", 39);
  check(await until(`window.__stage.keyboard().bearing !== ${keys.bearing}`), "street view on the globe: an arrow key turns it");
  for (let i = 0; i < 12; i++) await press("Tab", "Tab", 9);
  check((await stage("keyboard()")).inStreet, "street view on the globe: Tab stays in it");
  const french = await stage("globeLanguage()");
  check(french.french.layers === "Calques" && french.french.backToLive === "Retour au direct" && french.back.layers === "Layers", `street view on the globe: a new language reaches all of it (${JSON.stringify(french)})`);
  await stage("markMap()");
  await stage("loseGlobe(400)");
  check(await until("window.__stage.mapIsNew()"), "street view on the globe: the globe's context lost and back, a new map under it");
  const underIt = await stage("clockAndStreet()");
  check(underIt.street && underIt.clock === "sim", `street view on the globe: which stays open, its replay running (${JSON.stringify(underIt)})`);
  await press("Escape", "Escape", 27);
  check(await until("!window.__view._street"), "street view on the globe: Escape closes it");
  const closedOver = await stage("afterClosing()");
  check(/street-btn/.test(closedOver.focused) && closedOver.inert === 0, `street view on the globe: the keyboard is back on its button, with nothing left out of reach (${JSON.stringify(closedOver)})`);
  await noErrors("street view on the globe");

  // Fullscreen, through a map built again: real, and MapLibre's overlay where the browser has none.
  await open("globe");
  await until("!!window.__view._loaded");
  await chrome.on("Runtime.evaluate", { expression: "window.__view._els.map.querySelector('.maplibregl-ctrl-fullscreen').click()", userGesture: true });
  await until("window.__stage.fullscreen().real && window.__stage.fullscreen().attribute");
  const inFullscreen = await chrome.evaluate(`(() => { const { map, ...rest } = window.__stage.fullscreen(); return rest; })()`);
  check(inFullscreen.real && inFullscreen.attribute && inFullscreen.shrink, `fullscreen: it starts (${JSON.stringify(inFullscreen)})`);
  await stage("markMap()");
  await stage("loseGlobe(300)");
  await until("window.__stage.mapIsNew()");
  const stillFullscreen = await chrome.evaluate(`(() => { const { map, ...rest } = window.__stage.fullscreen(); return rest; })()`);
  check(stillFullscreen.real && stillFullscreen.attribute && stillFullscreen.shrink, `fullscreen: and stays through a map built again, whose button knows (${JSON.stringify(stillFullscreen)})`);
  await chrome.evaluate("document.fullscreenElement && document.exitFullscreen()");
  await until("!window.__stage.fullscreen().real && !window.__view.hasAttribute('fullscreen')");
  await stage("pseudoFullscreen()");
  await stage("markMap()");
  await stage("loseGlobe(300)");
  await until("window.__stage.mapIsNew()");
  const stillOverlay = await chrome.evaluate(`(() => { const { map, ...rest } = window.__stage.fullscreen(); return rest; })()`);
  check(stillOverlay.pseudo && stillOverlay.attribute && stillOverlay.shrink, `fullscreen: and so does the overlay where a browser has none (${JSON.stringify(stillOverlay)})`);
  await noErrors("fullscreen");

  // The rings of satellites visible now, the one thing that keeps a resting globe drawing.
  await open("globe");
  await until("!!window.__view._loaded");
  const rings = await stage("ringFrames()");
  check(rings.inSight > rings.behind * 2 && rings.behind <= 6, `rings: the globe draws for one in sight, and rests for one behind the Earth (${JSON.stringify(rings)})`);
  check(rings.backInSight, "rings: and draws again when it comes round");
  const staleGlobe = await stage("staleHint()");
  check(!staleGlobe.atFirst && staleGlobe.later && !staleGlobe.afterwards, `refreshes failing: after ten minutes the globe says how old its times are, until one works (${JSON.stringify(staleGlobe)})`);
  const switching = await stage("switching()");
  check(switching.during.data && switching.during.message === "Finding the satellites…" && switching.during.mission && switching.during.chart && switching.during.listed === 0, `another location: while its answer is on its way, it says so, with nothing of the last one under its name (${JSON.stringify(switching.during)})`);
  check(!switching.after.message && !switching.after.mission && !switching.after.chart && switching.after.listed > 0, `another location: and then shows it (${JSON.stringify(switching.after)})`);
  await noErrors("rings");

  // Midnight, on the clock of the page.
  await open("globe");
  await until("!!window.__view._loaded");
  const midnight = await stage("midnight()");
  check(/^Tomorrow morning/.test(midnight.before) && /^This morning/.test(midnight.after), `midnight: the chart's heading says what day it is now (${JSON.stringify(midnight)})`);
  await noErrors("midnight");

  // The panel and the card: they draw, in a language with long words too.
  await open("panel", "&lang=de");
  await sleep(4000);
  check(/Großartig|Gut|Mäßig/.test(await chrome.evaluate(TEXT_OF_PAGE)), "panel: the passes show their rating, in German");
  await noErrors("panel");

  // The address: what it says is what is on screen, and Back goes where a person expects.
  await open("panel");
  await until("!!window.__view._view?._loaded");
  const panelState = () => stage("panelState()");
  const ids = await stage("ids()");
  await stage("openStreetHere(0)");
  const opened = await panelState();
  check(opened.street === ids[0] && opened.search.includes(`pass=${ids[0]}`) && opened.search.includes("view=street"), `address: a street view opened is in it (${JSON.stringify(opened)})`);
  await chrome.evaluate("history.back()");
  check(await until("!window.__stage.panelState().street"), "address: Back closes the street view");
  const backed = await panelState();
  check(backed.on && backed.search.includes(`pass=${ids[0]}`) && !backed.search.includes("view=street"), `address: and stays on the page, with the pass (${JSON.stringify(backed)})`);
  check(backed.clock === "live", "address: and the replay that came with the street view is over, as the address says");
  // Somewhere on this page to go back to, or Back would leave it.
  await stage(`goTo("pass=${ids[0]}")`);
  await stage("openStreetHere(0)");
  await stage("closeStreetHere()");
  check(await until("!window.__stage.panelState().street && !location.search.includes('view=street')"), "address: its own button closes it, and takes it out of the address");
  await chrome.evaluate("history.back()");
  await until("!location.search.includes('view=')");
  const notBack = await panelState();
  check(notBack.street === null && !notBack.search.includes("view=street"), `address: and Back then does not open it again (${JSON.stringify(notBack)})`);
  await stage("openStreetHere(0)");
  await stage(`goTo("pass=${ids[1]}")`);
  check(await until(`(() => { const s = window.__stage.panelState(); return s.street === null && s.selected === "${ids[1]}"; })()`), `address: a link without a street view closes one left open (${JSON.stringify(await panelState())})`);
  await stage("openStreetHere(0)");
  await stage(`goTo("pass=${ids[1]}&view=street")`);
  check(await until(`window.__stage.panelState().street === "${ids[1]}"`), `address: and one with a street view shows that pass in it (${JSON.stringify(await panelState())})`);
  await stage("closeStreetHere()");
  await until("!window.__stage.panelState().street");
  const moved = await stage("movedPick()");
  check(moved.search.includes(`pass=${moved.wanted}`), `address: new predictions move a pick, and the address says where it went (${JSON.stringify(moved)})`);
  const failedLink = await stage("failedLink()");
  check(!failedLink.includes("pass="), `address: a link to a pass that is gone does not stay in it (${failedLink})`);
  await noErrors("address");

  await open("card");
  await sleep(1500);
  const card = await chrome.evaluate(TEXT_OF_PAGE);
  check(/Great/.test(card) && /Tiangong/.test(card), "card: the next pass and those after it");
  const inFlight = await stage("cardPathInFlight()");
  check(inFlight.rows === inFlight.wanted, `card: a path on its way as new predictions arrive is not the one kept (${JSON.stringify(inFlight)})`);
  const onCard = await stage("cardStreet()");
  check(onCard.street === onCard.wanted && onCard.path === onCard.wanted, `card: new predictions reach its street view, and the path too (${JSON.stringify(onCard)})`);
  const language = await stage("cardLanguage()");
  check(language.forwarded && language.layers === "Ebenen" && language.backToLive === "Zurück zu Live", `card: a new language reaches its street view, all of it (${JSON.stringify(language)})`);
  check(/\bO\b/.test(language.chart) && !/\bO\b/.test(language.chartWas), `card: and its chart (${language.chartWas} → ${language.chart})`);
  await noErrors("card");

  // No WebGL at all: only the globe is missing.
  await chrome.on("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...more) { return /webgl/.test(kind) && !window.__webglBack ? null : get.call(this, kind, ...more); }; })();`,
  });
  await open("globe");
  await sleep(2500);
  const bare = await chrome.evaluate(TEXT_OF_PAGE);
  check(/Tiangong/.test(bare), "no WebGL: the passes still show");
  check(await chrome.evaluate(`!window.__view.shadowRoot.querySelector(".reload-btn").hidden`), "no WebGL: with a way to try again");
  const withoutMap = await stage("withoutMap()");
  check(withoutMap.moved > 500, `no WebGL: a replay's clock still runs (${JSON.stringify(withoutMap)})`);
  check(withoutMap.attribute && withoutMap.selected, "no WebGL: and a link still selects its pass");
  await chrome.on("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const message = await stage("messageCovers()");
  check(message.shown && message.width === 375 && message.covers.length === 0, `no WebGL: on a phone, the message covers nothing (${JSON.stringify(message)})`);
  await chrome.on("Emulation.clearDeviceMetricsOverride");
  await sleep(300);
  const webglBack = await stage("webglBack()");
  check(webglBack.loaded && !webglBack.attribute && !webglBack.reload, `no WebGL: back on the page with WebGL by then, the map comes (${JSON.stringify(webglBack)})`);
  await noErrors("no WebGL");

  check(missing.size === 0, `none of the integration's files is missing ${[...missing].join(" ")}`);
} finally {
  chrome.stop();
  server.close();
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
