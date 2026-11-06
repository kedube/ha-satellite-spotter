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
function flatTerrain(metres) {
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
  const height = metres + 32768;
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
      const answer = outside(request.url);
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
  return { on, evaluate, stop, console: console_ };
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
  await noErrors("street");

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
  check(picks.gone.user === false, `new predictions: a pick that has gone is no pick, with a neighbour within 120 s (${JSON.stringify(picks.gone)})`);
  const paths = await chrome.evaluate("window.__search.globePath()");
  check(paths.refused, "new predictions: the globe refuses a neighbour's path");
  check(paths.taken, "new predictions: and takes a pass's own, under the id it has now");
  // The globe's answer, and the one the street view gets by asking Home Assistant itself a little later.
  const answered = (await chrome.evaluate("window.__search.openStreet()")) + 2;
  for (let i = 0; i < 40 && (await chrome.evaluate(`window.__asked["satellite_spotter/pass_track"]`)) < answered; i++) await sleep(250);
  await sleep(250);
  const refused = await chrome.evaluate("window.__search.street()");
  check(refused.tag === "SATELLITE-STREET-VIEW" && !refused.satellites && !refused.drawn, `new predictions: the street view refuses a neighbour's path, and draws nothing (${JSON.stringify(refused)})`);
  await chrome.evaluate("window.__search.ownPath()");
  const own = async () => chrome.evaluate("window.__search.street()");
  for (let i = 0; i < 80 && !(await own()).drawn; i++) await sleep(250);
  const drawn = await own();
  check(drawn.drawn && drawn.satellites?.includes(25544) && !drawn.satellites.includes(48274), `new predictions: it goes on asking, and draws the pass's own (${JSON.stringify(drawn)})`);
  const late = await chrome.evaluate("window.__search.latePath()");
  check(late.asking && late.movedOn && late.arrived, `new predictions: a path on its way as the street view moves on (${JSON.stringify(late)})`);
  check(late.stayed, "new predictions: which does not take it back");
  await noErrors("new predictions");

  // The panel and the card: they draw, in a language with long words too.
  await open("panel", "&lang=de");
  await sleep(4000);
  check(/Großartig|Gut|Mäßig/.test(await chrome.evaluate(TEXT_OF_PAGE)), "panel: the passes show their rating, in German");
  await noErrors("panel");

  await open("card");
  await sleep(1500);
  const card = await chrome.evaluate(TEXT_OF_PAGE);
  check(/Great/.test(card) && /Tiangong/.test(card), "card: the next pass and those after it");
  await noErrors("card");

  // No WebGL at all: only the globe is missing.
  await chrome.on("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...more) { return /webgl/.test(kind) ? null : get.call(this, kind, ...more); }; })();`,
  });
  await open("globe");
  await sleep(2500);
  const bare = await chrome.evaluate(TEXT_OF_PAGE);
  check(/Tiangong/.test(bare), "no WebGL: the passes still show");
  check(await chrome.evaluate(`!window.__view.shadowRoot.querySelector(".reload-btn").hidden`), "no WebGL: with a way to try again");
  await noErrors("no WebGL");

  check(missing.size === 0, `none of the integration's files is missing ${[...missing].join(" ")}`);
} finally {
  chrome.stop();
  server.close();
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
