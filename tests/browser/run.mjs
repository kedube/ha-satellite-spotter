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

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const CHROMES = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png", ".pbf": "application/x-protobuf", ".webp": "image/webp" };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const skyPhoto = readFileSync(join(ROOT, "tests/browser/sky.jpg"));

/** Serve the repository, for the page to load the real modules from. */
function serve() {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname));
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(readFileSync(file));
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

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

/** What the outside world answers: only the street photos' search, and its pictures. */
function outside(url) {
  const { host } = new URL(url);
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
  await noErrors("globe");

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
} finally {
  chrome.stop();
  server.close();
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
