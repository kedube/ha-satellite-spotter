/**
 * <satellite-street-view>: a pass seen from the street. A 360° street photo
 * near home (Panoramax, and with the integration's keys Mapillary and Google
 * Street View: sat-photo*.js), or else an eye-level 3D model of the
 * neighbourhood from open data (OpenFreeMap buildings, trees and street
 * lights on AWS terrain, optional aerial imagery: sat-street-scene.js), lit
 * for the moment of the pass, under the planetarium sky of that moment, with
 * the satellite's path, time ticks, markers and a moving dot sized by its
 * brightness; buildings, trees and hills hide what they would hide, and an
 * x-ray shows where it goes behind them. Without a GPU that keeps up it draws
 * the same sky over the terrain skyline instead.
 *
 * Hosted by the globe view (sat-globe.js) over its map, by the passes card in
 * a full-screen overlay, or anywhere else:
 *   properties  hass, formatter, location {latitude, longitude, elevation, title},
 *               pass, detail (pass_track), clock (PassClock), options, units
 *   methods     open(), dispose(), setPass(pass, detail)
 *   events      "close", "need-detail" {passId}, "options-changed" {options} (none bubble)
 * The host owns its lifetime: taken off the page the view only pauses (the
 * host may put it back), and dispose() frees it.
 */

const VERSION = new URL(import.meta.url).search;
// Like any of these, a time bar that does not load fails the module, which the host reports.
const [theme, planetariumModule, sceneModule, horizonModule, maplibreModule, timebarModule, clockModule, magneticModule, photoModule, photoSceneModule, astroModule, sourcesModule] =
  await Promise.all([
    import(`./sat-theme.js${VERSION}`),
    import(`./sat-planetarium.js${VERSION}`),
    import(`./sat-street-scene.js${VERSION}`),
    import(`./sat-horizon.js${VERSION}`),
    import(`./sat-maplibre.js${VERSION}`),
    import(`./sat-timebar.js${VERSION}`),
    import(`./sat-clock.js${VERSION}`),
    import(`./sat-magnetic.js${VERSION}`),
    import(`./sat-photo.js${VERSION}`),
    import(`./sat-photo-scene.js${VERSION}`),
    import(`./sat-astro.js${VERSION}`),
    import(`./sat-photo-sources.js${VERSION}`),
  ]);
const { BUTTON_CSS, CHIP_CSS, FOCUS_CSS, GLASS_CSS, MOTION_CSS, TOKENS_CSS, UTIL_CSS, kindIcon, svgIcon } = theme;
const { Planetarium, frameView, makeProjector, trackFromRows } = planetariumModule;
const { EYE_HEIGHTS, PITCH_MAX, PITCH_MIN, StreetScene, sceneLook } = sceneModule;
const { groundElevation, hiddenByTerrain, skyline } = horizonModule;
const { MAPLIBRE_DIR, loadMapLibre, mapLibreLocale } = maplibreModule;
const { Timebar } = timebarModule;
const { PASS_LEAD_S, PASS_TAIL_S, PassClock, passIsLive } = clockModule;
const { declination } = magneticModule;
const { PHOTO_MAX_M, findPhotos, hiddenByPhoto } = photoModule;
const { PhotoScene } = photoSceneModule;
const { sunAzEl } = astroModule;
const { PHOTO_SOURCES, SOURCE_NAMES, findGooglePhotos, findMapillaryPhotos, rankPhotos } = sourcesModule;

const STORAGE_KEY = "satellite-spotter:street";
// The photo chosen for each place: {"lat,lon": id}.
const PHOTO_STORAGE_KEY = "satellite-spotter:street-photo";
export const DEFAULT_OPTIONS = Object.freeze({
  // A photo or the 3D model ("photo" | "model"), and which service's photos
  // ("auto": the best of every service there is a key for): null follows the
  // integration's options, and a choice in the layers menu overrides them.
  street: null,
  photoSource: null,
  imagery: "map",
  eyeHeightM: 1.7,
  constellations: true,
  follow: true,
  buildings: true,
  props: true,
  lightPollution: "suburban",
});
// Photos that do not load are passed over for the next nearest, this many at most.
const PHOTO_TRIES = 3;
// The photos offered to choose from, of every service together.
const PHOTO_LIST_MAX = 24;
// Home Assistant's photo settings (the services and their keys) are waited for this long (ms).
const SETTINGS_MS = 4000;
// The integration's street sources (const.py STREET_SOURCES).
const STREET_SOURCES = ["auto", ...PHOTO_SOURCES, "model"];
const LIGHT_POLLUTION = ["rural", "suburban", "city"];
const FOV_MIN = 30;
const FOV_MAX = 90;
// A frame slower than this (median, ms) is a software GPU: the 2D sky is kinder.
const SLOW_FRAME_MS = 80;
// Wait this long for the map to settle before showing it anyway (ms).
const VEIL_MAX_MS = 15000;
// Ask the host for the pass's path first; fetch it ourselves if nobody answers.
const DETAIL_GRACE_MS = 2500;
// A path that does not come is asked for again after these waits (ms), then
// given up on until Home Assistant's connection comes back.
const DETAIL_RETRY_MS = [5000, 15000, 60000];
// A lost WebGL context that is not back after this long is rebuilt.
const CONTEXT_RESTORE_MS = 5000;
// After the user turns the view, follow leaves it alone this long (ms).
const FOLLOW_PAUSE_MS = 6000;
// Live, the dot creeps: redraw about this often (ms) unless something else moves.
const LIVE_FRAME_MS = 100;
// The HUD's words change at most this often (ms).
const HUD_MS = 250;
// Credits by source. The links fill the translated sentences; Esri's line is
// their required wording, and the engine is a name and a licence.
const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
const CREDIT_LINKS = {
  openfreemap: link("https://openfreemap.org", "OpenFreeMap"),
  openmaptiles: link("https://www.openmaptiles.org/", "OpenMapTiles"),
  openstreetmap: link("https://www.openstreetmap.org/copyright", "OpenStreetMap"),
  tiles: link("https://github.com/tilezen/joerd/blob/master/docs/attribution.md", "Mapzen Terrain Tiles"),
  d3celestial: link("https://github.com/ofrohn/d3-celestial", "d3-celestial"),
  panoramax: link("https://panoramax.fr", "Panoramax"),
  mapillary: link("https://www.mapillary.com", "Mapillary"),
};
const CREDITS_FIXED = {
  imagery: "Powered by Esri. Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
  engine: `${link("https://maplibre.org", "MapLibre GL JS")} (BSD-3-Clause)`,
};
const COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const wrap360 = (x) => ((x % 360) + 360) % 360;
/** Shortest signed turn from a to b, degrees. */
const turn = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;
const compass16 = (az) => COMPASS16[Math.round(wrap360(az) / 22.5) % 16];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

function prefersReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Set text only when it changed (cheaper, and keeps screen readers calm). */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function readStoredOptions() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) : {};
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

/** A place's key for the photo chosen there (about 10 m). */
export const placeKey = (l) => `${(+l.latitude).toFixed(4)},${(+l.longitude).toFixed(4)}`;

function storedPhotoChoice(location) {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(PHOTO_STORAGE_KEY) ?? "{}");
    return typeof stored?.[placeKey(location)] === "string" ? stored[placeKey(location)] : null;
  } catch {
    return null;
  }
}

function storePhotoChoice(location, id) {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(PHOTO_STORAGE_KEY) ?? "{}");
    const next = stored && typeof stored === "object" ? stored : {};
    next[placeKey(location)] = id;
    globalThis.localStorage?.setItem(PHOTO_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or storage full: the choice lasts until the page closes.
  }
}

/** The order to try a place's photos in: the one chosen before first, then the best. */
export function photoOrder(list, chosenId) {
  const chosen = list.find((p) => p.id === chosenId);
  return chosen ? [chosen, ...list.filter((p) => p !== chosen)] : [...list];
}

/** Options with every value checked (stored ones may come from an older version). */
export function normalizeOptions(o = {}) {
  const out = { ...DEFAULT_OPTIONS };
  if (o.street === "photo" || o.street === "model") out.street = o.street;
  if (o.photoSource === "auto" || PHOTO_SOURCES.includes(o.photoSource)) out.photoSource = o.photoSource;
  if (o.imagery === "map" || o.imagery === "aerial") out.imagery = o.imagery;
  // The globe card's imagery names: any satellite imagery means aerial here.
  if (["esri", "satellite"].includes(o.imagery)) out.imagery = "aerial";
  if (Number.isFinite(o.eyeHeightM) && o.eyeHeightM > 0 && o.eyeHeightM <= 100) out.eyeHeightM = o.eyeHeightM;
  for (const key of ["constellations", "follow", "buildings", "props"]) if (typeof o[key] === "boolean") out[key] = o[key];
  if (LIGHT_POLLUTION.includes(o.lightPollution)) out.lightPollution = o.lightPollution;
  return out;
}

/**
 * The integration's street photo settings (satellite_spotter/street),
 * checked: where the photos come from, and the keys of Mapillary and Google
 * (null without). Without an answer: the best photo of Panoramax's.
 */
export function streetSettings(answer) {
  const key = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    source: STREET_SOURCES.includes(answer?.source) ? answer.source : "auto",
    mapillary: key(answer?.mapillary_token),
    google: key(answer?.google_api_key),
  };
}
const NO_SETTINGS = Object.freeze(streetSettings(null));

/** Whether a set of options shows a photo: as chosen in the layers menu, else as the integration's options say. */
export function wantsPhoto(options, settings = NO_SETTINGS) {
  return (options.street ?? (settings.source === "model" ? "model" : "photo")) === "photo";
}

/** The services there are photos from: Panoramax, and those there is a key for. */
export function photoSources(settings = NO_SETTINGS) {
  return PHOTO_SOURCES.filter((source) => source === "panoramax" || !!settings[source]);
}

/** The service whose photos to show ("auto": the best of all): the layers menu's, else the options'; one without its key gives way to "auto". */
export function photoSource(options, settings = NO_SETTINGS) {
  const wanted = options.photoSource ?? (PHOTO_SOURCES.includes(settings.source) ? settings.source : "auto");
  return wanted !== "auto" && photoSources(settings).includes(wanted) ? wanted : "auto";
}

/** A promise that gives up after ms. */
function timeLimit(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

/** Whether this browser can give the street a WebGL 2 context on a real GPU. */
export function supportsWebGL2(doc = globalThis.document) {
  try {
    const canvas = doc.createElement("canvas");
    const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Whether a pass_track payload belongs to a pass (an id from before a refresh still matches its satellite). */
export function detailMatches(pass, detail) {
  if (!pass || !detail) return false;
  if (detail.pass_id === pass.id) return true;
  const [norad, start] = String(detail.pass_id ?? "").split("-").map(Number);
  return norad === pass.transits?.[0]?.norad_id && Math.abs(start - pass.start) <= 120;
}

/** The points of a pass known before its path has loaded: rise, brightest, peak and set. */
export function summaryArc(pass) {
  const t = pass?.transits?.[0];
  return [t?.rise, t?.brightest, pass?.peak ?? t?.peak, t?.set].filter((p) => p && Number.isFinite(p.azimuth) && Number.isFinite(p.elevation));
}

/** The visible part of the primary's path as {azimuth, elevation} (or all of it above 5°). */
export function visibleArc(detail, pass) {
  const transits = detail?.transits ?? [];
  const primary = transits.find((tr) => tr.rows && tr.norad_id === pass?.transits?.[0]?.norad_id) ?? transits.find((tr) => tr.rows);
  if (!primary) return [];
  const rows = primary.rows;
  let arc = rows.filter((r) => r[9] && r[6] > 0);
  if (arc.length < 2) arc = rows.filter((r) => r[0] >= primary.visible_start && r[0] <= primary.visible_end && r[6] > 0);
  if (arc.length < 2) arc = rows.filter((r) => r[6] > 5);
  return arc.map((r) => ({ azimuth: r[5], elevation: r[6] }));
}

// ---------------------------------------------------------------------------

const STYLE = `
:host { display: block; position: relative; width: 100%; height: 100%; min-height: 240px; overflow: hidden;
  color: var(--sat-ink); contain: strict; isolation: isolate;
  --safe-t: var(--sat-safe-top, 0px); --safe-r: var(--sat-safe-right, 0px);
  --safe-b: var(--sat-safe-bottom, 0px); --safe-l: var(--sat-safe-left, 0px); }
.root { position: absolute; inset: 0; background: #02040b; overflow: hidden; }
.stage { position: absolute; inset: 0; touch-action: none; cursor: grab; outline: none; user-select: none; -webkit-user-select: none; }
.stage.dragging { cursor: grabbing; }
.stage:focus-visible { box-shadow: inset 0 0 0 2px var(--sat-sky); }
.stage > canvas, .stage > .map { position: absolute; inset: 0; width: 100%; height: 100%; }
.sky { z-index: 0; }
.map { z-index: 1; background: transparent; }
.overlay { z-index: 2; pointer-events: none; }
.maplibregl-canvas { outline: none; }
.maplibregl-ctrl-bottom-right { bottom: calc(var(--bar-h, 64px) + 4px + var(--safe-b)); right: calc(4px + var(--safe-r)); z-index: 3; }
.maplibregl-ctrl-attrib { background: rgba(15,23,42,.7) !important; color: var(--sat-ink-2) !important; font-size: 10.5px; }
.maplibregl-ctrl-attrib a { color: var(--sat-ink) !important; }
.maplibregl-ctrl-attrib.maplibregl-compact { min-height: 22px; }
.maplibregl-ctrl-attrib-button { filter: invert(1) brightness(1.4); }

.hud { position: absolute; z-index: 4; }
.title { top: calc(12px + var(--safe-t)); left: calc(12px + var(--safe-l)); box-sizing: border-box;
  width: min(390px, calc(100% - 128px - var(--safe-l) - var(--safe-r))); padding: 11px 15px 12px; }
.title .top { display: flex; align-items: center; gap: 6px 8px; flex-wrap: wrap; font-size: 11px; letter-spacing: .14em;
  text-transform: uppercase; color: var(--sat-sky); font-weight: 600; }
.title .top .live { --ping: 125,211,252; width: 7px; height: 7px; border-radius: 50%; background: var(--sat-sky); flex: none; }
.title.sim .top { color: var(--sat-preview); } .title.sim .top .live { --ping: 240,171,252; background: var(--sat-preview); }
.title.now .top { color: var(--sat-gold); } .title.now .top .live { --ping: 252,211,77; background: var(--sat-gold); }
.title .top .chips { margin-left: auto; display: inline-flex; gap: 6px; letter-spacing: .06em; }
.title h2 { display: flex; align-items: center; gap: 8px; margin: 6px 0 0; font-size: 20px; font-weight: 650; letter-spacing: -.01em; line-height: 1.2; }
.title h2 svg { width: 20px; height: 20px; fill: var(--sat-gold); flex: none; }
.title h2 .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title .when { font-size: 12.5px; color: var(--sat-ink-2); margin-top: 2px; font-variant-numeric: tabular-nums; }
.title .look { font-size: 15px; font-weight: 650; color: var(--sat-gold); margin-top: 8px; font-variant-numeric: tabular-nums; }
.title .look.dim { color: var(--sat-ink-2); font-weight: 600; }
.title .look .mag { color: var(--sat-ink-2); font-weight: 500; font-size: 12.5px; }
.title .note { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #fde68a; margin-top: 7px; padding-top: 7px; border-top: 1px solid var(--sat-rule); }
.title .note::before { content: ""; width: 9px; height: 9px; border-radius: 50%; border: 1.5px dashed #fde68a; flex: none; }

.tools { top: calc(12px + var(--safe-t)); right: calc(12px + var(--safe-r)); display: flex; gap: 6px; padding: 5px; border-radius: 999px; }
.cam { top: calc(66px + var(--safe-t)); right: calc(12px + var(--safe-r)); display: flex; flex-direction: column; gap: 6px; padding: 5px; border-radius: 999px; }
.ibtn { width: 34px; height: 34px; }
.ibtn[aria-expanded="true"] { background: rgba(125,211,252,.28); }
.compass-btn svg { transition: transform .2s; }
.compass-btn .needle { fill: #fda4af; }

.menu { top: calc(60px + var(--safe-t)); right: calc(12px + var(--safe-r)); width: min(300px, calc(100% - 24px)); box-sizing: border-box; padding: 12px 14px 14px; display: grid; gap: 12px; }
.menu h3, .sheet h3 { margin: 0; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--sat-sky); font-weight: 600; }
.menu .group { display: grid; gap: 6px; }
.menu .lbl { font-size: 12px; color: var(--sat-ink-2); }
.seg { display: flex; padding: 3px; gap: 3px; border-radius: 999px; background: rgba(148,163,184,.12); border: 1px solid var(--sat-rule); }
.seg button { flex: 1; font: inherit; font-size: 12px; font-weight: 600; color: var(--sat-ink-2); background: transparent; border: 0; border-radius: 999px;
  padding: 6px 8px; cursor: pointer; white-space: nowrap; }
.seg button[aria-checked="true"] { background: var(--sat-sky); color: #0f172a; }
.seg button:not([aria-checked="true"]):hover { color: var(--sat-ink); background: rgba(148,163,184,.16); }
.check { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; cursor: pointer; }
.check input { appearance: none; -webkit-appearance: none; width: 34px; height: 20px; border-radius: 999px; background: rgba(148,163,184,.3);
  position: relative; cursor: pointer; transition: background .15s; flex: none; margin: 0; }
.check input::after { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #e2e8f0; transition: transform .15s; }
.check input:checked { background: var(--sat-sky); }
.check input:checked::after { transform: translateX(14px); background: #0f172a; }
.photo-pick { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px; }
.photo-pick .ibtn { width: 30px; height: 30px; }
.photo-pick .ibtn:disabled { opacity: .35; cursor: default; }
.photo-pick .ibtn:disabled:hover { background: transparent; }
.photo-info { min-width: 0; text-align: center; font-size: 12px; line-height: 1.35; }
.photo-info .where { color: var(--sat-ink); font-weight: 600; }
.photo-info .when { color: var(--sat-ink-3); font-variant-numeric: tabular-nums; }
.photo-note { font-size: 12px; line-height: 1.4; color: var(--sat-ink-3); }
.photo-note p { margin: 0; }
.photo-note p + p { margin-top: 4px; }
.sources { display: grid; gap: 6px; }
.seg.tight button { padding: 6px 4px; font-size: 11.5px; }
.photo-credit { position: absolute; z-index: 3; right: calc(4px + var(--safe-r)); bottom: calc(var(--bar-h, 64px) + 4px + var(--safe-b));
  max-width: calc(100% - 24px - var(--safe-l) - var(--safe-r)); box-sizing: border-box; padding: 2px 8px; border-radius: 10px;
  background: rgba(15,23,42,.7); color: var(--sat-ink-2); font-size: 10.5px; line-height: 1.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.photo-credit a { color: var(--sat-ink); }

.sheet { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(520px, calc(100% - 24px)); max-height: calc(100% - 120px - var(--safe-t) - var(--safe-b));
  overflow: auto; box-sizing: border-box; padding: 16px 18px 18px; font-size: 13px; line-height: 1.5; color: var(--sat-ink-2); z-index: 6; }
.sheet h3 { margin-bottom: 8px; }
.sheet h4 { margin: 14px 0 4px; font-size: 12.5px; color: var(--sat-ink); font-weight: 650; }
.sheet p { margin: 0 0 6px; }
.sheet ul { margin: 0; padding-left: 18px; }
.sheet li { margin: 2px 0; }
.sheet a { color: var(--sat-sky); }
.sheet .legend { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; margin: 8px 0 4px; }
.sheet .legend i { display: block; width: 28px; height: 0; border-top: 3px solid #fde68a; }
.sheet .legend i.faint { border-top: 2px solid rgba(252,211,77,.55); }
.sheet .legend i.shadow { border-top: 2px dashed rgba(196,181,253,.7); }
.sheet .legend i.xray { border-top: 2px dotted rgba(253,230,138,.8); }
.sheet .actions { display: flex; justify-content: flex-end; margin-top: 12px; }

.title .banner { display: flex; align-items: flex-start; gap: 7px; font-size: 12px; line-height: 1.4; color: var(--sat-warn); margin-top: 7px; padding-top: 7px;
  border-top: 1px solid var(--sat-rule); }
.title .banner svg { width: 14px; height: 14px; fill: currentColor; flex: none; margin-top: 1px; }

.bar { left: 50%; transform: translateX(-50%); bottom: calc(12px + var(--safe-b)); width: min(680px, calc(100% - 24px - var(--safe-l) - var(--safe-r))); }

.veil { position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; pointer-events: none;
  background: radial-gradient(ellipse at 50% 40%, #0b1a3a 0%, #040814 60%, #000 100%); transition: opacity .45s ease; }
.veil.gone { opacity: 0; }
.veil .box { display: grid; justify-items: center; gap: 12px; text-align: center; padding: 0 24px; }
.veil .orbit { position: relative; width: 42px; height: 42px; border-radius: 50%; border: 1.5px solid rgba(125,211,252,.25); }
.veil .orbit::after { content: ""; position: absolute; top: -4px; left: 50%; margin-left: -4px; width: 8px; height: 8px; border-radius: 50%;
  background: var(--sat-gold); box-shadow: 0 0 10px rgba(252,211,77,.8); transform-origin: 4px 25px; }
.veil .msg { font-size: 13.5px; color: var(--sat-ink); font-weight: 600; }
.veil .sub { font-size: 12px; color: var(--sat-ink-3); max-width: 340px; }

@media (prefers-reduced-motion: no-preference) {
  .veil .orbit::after { animation: sat-spin 1.6s linear infinite; }
  .title.now .top .live, .title.sim .top .live { animation: sat-ping 2s infinite; }
  .menu, .sheet:not([hidden]) { animation: sat-rise .18s ease-out; }
}
@media (prefers-reduced-motion: reduce) { .veil { transition: none; } }

.root.narrow .title { width: calc(100% - 24px - var(--safe-l) - var(--safe-r)); padding: 9px 12px 10px; }
.root.narrow .title h2 { font-size: 17px; margin-top: 4px; padding-right: 116px; }
.root.narrow .title .top { padding-right: 116px; }
.root.narrow .title .look { font-size: 14px; margin-top: 6px; }
.root.narrow .tools { top: calc(18px + var(--safe-t)); right: calc(18px + var(--safe-r)); background: none; border: 0; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; padding: 0; }
.root.narrow .cam { top: auto; flex-direction: row; bottom: calc(var(--bar-h, 64px) + 16px + var(--safe-b)); }
.root.narrow.has-credit .cam { bottom: calc(var(--bar-h, 64px) + 30px + var(--safe-b)); }
.root.narrow .menu { top: calc(var(--title-h, 120px) + 18px + var(--safe-t)); }
.root.narrow .sheet { top: auto; bottom: 0; left: 0; transform: none; width: 100%; max-height: 78%; border-radius: 18px 18px 0 0; padding-bottom: calc(18px + var(--safe-b)); }
.root.narrow .bar { width: calc(100% - 16px - var(--safe-l) - var(--safe-r)); bottom: calc(8px + var(--safe-b)); }
`;

const PHONE_ICON =
  "M17,19H7V5H17M17,1H7C5.89,1 5,1.89 5,3V21A2,2 0 0,0 7,23H17A2,2 0 0,0 19,21V3C19,1.89 18.1,1 17,1Z";
const WARN_ICON = "M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z";

// In node (the tests) an EventTarget stands in for HTMLElement.
const BaseElement = globalThis.HTMLElement ?? globalThis.EventTarget ?? class {};

export class SatelliteStreetView extends BaseElement {
  constructor() {
    super();
    this._hass = null;
    this._formatter = null;
    this._ownFormatter = false;
    this._location = null;
    this._pass = null;
    this._detail = null;
    this._clock = null;
    this._ownClock = false;
    this._hostOptions = {};
    this._options = normalizeOptions(readStoredOptions());
    this._units = null;
    this._opened = false;
    this._mode = null; // "photo" | "3d" | "2d" once something shows
    this._view = { bearing: 180, pitch: 100, fov: 60, roll: 0 };
    this._userMoved = false;
    this._following = false;
    this._followPausedUntil = 0;
    this._timers = new Set();
    this._raf = null;
    // Generations: of open/dispose, and of the scene (a new place restarts only the scene).
    this._gen = 0;
    this._sceneGen = 0;
    this._drawn = null;
    this._hudAt = 0;
    this._lastFrame = null;
    this._tween = null;
    this._pointers = new Map();
    this._orientation = null;
    // Swappable in tests (no network, no WebGL in node).
    this._loadMapLibre = loadMapLibre;
    this._groundElevation = groundElevation;
    this._skyline = skyline;
    this._supportsWebGL2 = supportsWebGL2;
    this._createScene = (container, options) => new StreetScene(container, options);
    // One service's photos near a place ({source, keys, signal, language, region}).
    this._findPhotos = (location, { source = "panoramax", keys = NO_SETTINGS, signal = null, language, region } = {}) => {
      const sunElevation = (date, place) => sunAzEl(date, place).elevation;
      if (source === "mapillary") return findMapillaryPhotos(location, { token: keys.mapillary, signal, sunElevation });
      if (source === "google") return findGooglePhotos(location, { key: keys.google, signal, language, region });
      return findPhotos(location, { signal, sunElevation });
    };
    this._fetchStreetSettings = (msg) => this._hass.callWS(msg);
    this._createPhotoScene = (container, options) => new PhotoScene(container, options);
    // The integration's photo settings ({entry, value}), the photos near the
    // place shown ({key, searches, failed, list}), and why there is none.
    this._settings = null;
    this._photos = null;
    this._photoNote = null;
    this._onVisibility = () => (globalThis.document?.hidden ? this._stopLoop() : this._kick());
    this._onKeyDown = (ev) => this._keyDown(ev);
    this._onMotion = () => this._planetarium?.setOptions({ reducedMotion: prefersReducedMotion() });
    // Home Assistant is back after a restart or a dropped connection: a path still missing is asked for again.
    this._onReady = () => this._asking && this._requestDetail({ again: true });
  }

  // -- properties ----------------------------------------------------------------

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    this._watchConnection();
    const reworded = !old || hass?.language !== old.language || hass?.locale !== old.locale || hass?.config?.time_zone !== old.config?.time_zone;
    if (!reworded) return;
    if (this._ownFormatter) {
      // Our own formatter: in the new language once its text is in.
      const formatter = this._formatter;
      import(`./sat-i18n.js${VERSION}`)
        .then(({ loadStrings }) => loadStrings(hass?.language || hass?.locale?.language))
        .then((strings) => {
          if (this._formatter !== formatter) return;
          formatter.update(hass, strings);
          this._reword();
        })
        .catch(() => {});
    } else if (this._formatter) {
      // The host's formatter follows the same hass: reword once it has.
      queueMicrotask(() => this._reword());
    }
  }

  get hass() {
    return this._hass;
  }

  set formatter(formatter) {
    if (!formatter) return;
    // The same one again: its language or locale changed in place.
    if (formatter === this._formatter) {
      this._reword();
      return;
    }
    this._formatter = formatter;
    this._ownFormatter = false;
    this._planetarium?.setFormatter(formatter);
    this._timebar?.destroy?.();
    this._timebar = null;
    if (this._els) {
      this._applyText();
      this._mountTimebar();
    }
  }

  /** Words, times and numbers again, after the formatter changed its language or locale. */
  _reword() {
    if (!this._formatter || !this._els) return;
    this._planetarium?.setFormatter(this._formatter);
    this._applyText();
    this._drawn = null;
    this._kick();
  }

  get formatter() {
    return this._formatter;
  }

  set location(location) {
    const moved = location?.latitude !== this._location?.latitude || location?.longitude !== this._location?.longitude;
    this._location = location;
    if (!moved || !this._opened) return;
    if (this._orientation) this._orientation.declination = this._declination();
    // Another place: start the scene again there.
    this._planetarium?.setObserver(this._observer());
    this._restartScene();
  }

  get location() {
    return this._location;
  }

  set pass(pass) {
    this.setPass(pass, detailMatches(pass, this._detail) ? this._detail : null);
  }

  get pass() {
    return this._pass;
  }

  set detail(detail) {
    if (detail === this._detail) return;
    if (this._pass && detail && !detailMatches(this._pass, detail)) return;
    this._detail = detail;
    this._passChanged(false);
  }

  get detail() {
    return this._detail;
  }

  set clock(clock) {
    if (clock === this._clock) return;
    this._unsubscribeClock?.();
    this._clock = clock;
    this._ownClock = false;
    this._subscribeClock();
    if (this._timebar) {
      this._timebar.destroy?.();
      this._timebar = null;
      this._mountTimebar();
    }
    // A clock handed over while open: show the pass on it.
    if (this._opened && clock) this._passChanged(false);
  }

  get clock() {
    return this._clock;
  }

  set options(options) {
    this._hostOptions = options || {};
    this._setOptions({ ...this._options, ...this._hostOptions }, { emit: false });
  }

  get options() {
    return { ...this._options };
  }

  set units(units) {
    this._units = units;
    if (this._els) this._applyText();
  }

  get units() {
    return this._units;
  }

  /**
   * Whether the time bar offers a way back to the globe (its "Globe" button
   * closes the street view). Hosts without a globe behind it, such as the
   * passes card's full-screen view, turn it off before open().
   */
  set globeToggle(on) {
    this._globeToggle = on !== false;
  }

  get globeToggle() {
    return this._globeToggle !== false;
  }

  // -- public methods ----------------------------------------------------------

  /** Start loading and showing (idempotent). */
  open() {
    if (this._opened) return;
    this._opened = true;
    this._gen++;
    this._buildDom();
    globalThis.document?.addEventListener("visibilitychange", this._onVisibility);
    this.addEventListener?.("keydown", this._onKeyDown);
    this._watchConnection();
    this._motionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    this._motionQuery?.addEventListener?.("change", this._onMotion);
    this._observeSize();
    this._planetarium = new Planetarium({ sky: this._els.sky, overlay: this._els.overlay, font: this._font() });
    this._planetarium.setObserver(this._observer());
    this._planetarium.setOptions({ constellations: this._options.constellations, lightPollution: this._options.lightPollution, reducedMotion: prefersReducedMotion() });
    this._resize();
    const gen = this._gen;
    // Text and a clock first (the host normally hands both over).
    this._ready = Promise.all([this._ensureFormatter(), this._ensureClock()]);
    this._ready
      .then(() => {
        if (gen !== this._gen) return;
        this._planetarium.setFormatter(this._formatter);
        this._applyText();
        this._mountTimebar();
        this._passChanged(true);
        this._kick();
      })
      .catch((err) => console.error("Satellite Spotter: the street view could not start:", err));
    this._startScene();
  }

  /** Stop, and free the WebGL context and everything else; open() starts again. */
  dispose() {
    if (!this._opened && !this._scene) return;
    this._opened = false;
    this._gen++;
    this._sceneGen++;
    this._stopLoop();
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    this._stopAsking();
    this._abort?.abort();
    this._abort = null;
    globalThis.document?.removeEventListener("visibilitychange", this._onVisibility);
    this.removeEventListener?.("keydown", this._onKeyDown);
    this._watchConnection();
    this._motionQuery?.removeEventListener?.("change", this._onMotion);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._stopOrientation();
    this._unsubscribeClock?.();
    this._unsubscribeClock = null;
    this._timebar?.destroy?.();
    this._timebar = null;
    this._scene?.remove();
    this._scene = null;
    this._pendingScene?.remove();
    this._pendingScene = null;
    this._planetarium?.dispose();
    this._planetarium = null;
    this._mode = null;
    this._skylineData = null;
    this._settled = false;
    this._size = null;
    this._drawn = null;
    this._state = null;
    this._lastFrame = null;
    this._tween = null;
    this._following = false;
    if (this._els) {
      // Free the canvases' memory; the DOM is rebuilt by the next open().
      for (const c of [this._els.sky, this._els.overlay]) {
        c.width = 0;
        c.height = 0;
      }
      this.shadowRoot.innerHTML = "";
      this._els = null;
    }
  }

  /** Show another pass (detail: its pass_track payload, or null to ask for it). */
  setPass(pass, detail = null) {
    const changed = pass?.id !== this._pass?.id;
    this._pass = pass;
    this._detail = detail && detailMatches(pass, detail) ? detail : changed ? null : this._detail;
    if (changed) {
      this._userMoved = false;
      this._following = false;
    }
    this._passChanged(changed);
  }

  connectedCallback() {
    if (!this._opened) return;
    // Back on the page: fit everything again. A map rebuilt while the view
    // was away (after a lost WebGL context) took the size of a detached box,
    // and the view's own size has not changed for _resize() to notice.
    this._size = null;
    this._resize();
    this._kick();
  }

  disconnectedCallback() {
    // Off the page nothing is drawn. Only the host knows whether it puts the
    // view back (a dashboard keeps its cards across a change of view): it
    // calls dispose() when it is done with it.
    this._stopLoop();
  }

  // -- DOM -------------------------------------------------------------------------

  _buildDom() {
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <link rel="stylesheet" href="${new URL("maplibre-gl.css", MAPLIBRE_DIR).href}">
      <style>${TOKENS_CSS}${UTIL_CSS}${GLASS_CSS}${BUTTON_CSS}${CHIP_CSS}${FOCUS_CSS}${MOTION_CSS}${STYLE}</style>
      <div class="root">
        <div class="stage" tabindex="0" role="application" aria-describedby="keys">
          <canvas class="sky" aria-hidden="true"></canvas>
          <div class="map"></div>
          <canvas class="overlay" aria-hidden="true"></canvas>
        </div>
        <section class="hud title glass" aria-live="off">
          <div class="top"><span class="live"></span><span class="state"></span><span class="chips"></span></div>
          <h2><span class="icon"></span><span class="name"></span></h2>
          <div class="when"></div>
          <div class="look"></div>
          <div class="note" hidden></div>
          <div class="banner" role="status" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${WARN_ICON}"/></svg><span></span></div>
        </section>
        <div class="hud tools glass">
          <button class="ibtn layers-btn" type="button" aria-expanded="false" aria-haspopup="dialog">${svgIcon("layers")}</button>
          <button class="ibtn info-btn" type="button" aria-expanded="false" aria-haspopup="dialog">${svgIcon("info")}</button>
          <button class="ibtn close-btn" type="button">${svgIcon("close")}</button>
        </div>
        <div class="hud cam glass">
          <button class="ibtn compass-btn" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12,2L15,12H9Z" class="needle"/><path d="M12,22L9,12H15Z" fill="currentColor" opacity=".7"/></svg></button>
          <button class="ibtn look-btn" type="button">${svgIcon("crosshair")}</button>
          <button class="ibtn follow-btn" type="button" aria-pressed="false">${svgIcon("follow")}</button>
          <button class="ibtn phone-btn" type="button" aria-pressed="false" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${PHONE_ICON}"/></svg></button>
        </div>
        <div class="hud menu glass" role="dialog" hidden>
          <h3 data-t="street.layers"></h3>
          <div class="group"><div class="lbl" data-t="street.street"></div>
            <div class="seg" role="radiogroup" data-key="street">
              <button type="button" role="radio" data-value="photo" data-t="street.street_photo"></button>
              <button type="button" role="radio" data-value="model" data-t="street.street_model"></button>
            </div>
            <div class="sources" hidden><div class="lbl" data-t="street.photo_source"></div>
              <div class="seg tight" role="radiogroup" data-key="photoSource">
                <button type="button" role="radio" data-value="auto" data-t="street.photo_source_auto"></button>
                ${PHOTO_SOURCES.map((s) => `<button type="button" role="radio" data-value="${s}">${s === "google" ? "Google" : SOURCE_NAMES[s]}</button>`).join("")}
              </div></div>
            <div class="photo-pick" hidden>
              <button class="ibtn photo-prev" type="button">${svgIcon("chevron_left")}</button>
              <div class="photo-info" aria-live="polite"><div class="where"></div><div class="when"></div></div>
              <button class="ibtn photo-next" type="button">${svgIcon("chevron_right")}</button>
            </div>
            <div class="photo-note" hidden></div></div>
          <div class="group model-only"><div class="lbl" data-t="street.ground"></div>
            <div class="seg" role="radiogroup" data-key="imagery">
              <button type="button" role="radio" data-value="map" data-t="street.ground_map"></button>
              <button type="button" role="radio" data-value="aerial" data-t="street.ground_aerial"></button>
            </div></div>
          <label class="check model-only"><span data-t="street.buildings"></span><input type="checkbox" data-key="buildings"></label>
          <label class="check model-only"><span data-t="street.props"></span><input type="checkbox" data-key="props"></label>
          <label class="check"><span data-t="street.constellations"></span><input type="checkbox" data-key="constellations"></label>
          <div class="group model-only"><div class="lbl" data-t="street.eye_height"></div>
            <div class="seg eye" role="radiogroup" data-key="eyeHeightM">
              ${EYE_HEIGHTS.map((h) => `<button type="button" role="radio" data-value="${h}"></button>`).join("")}
            </div></div>
          <div class="group"><div class="lbl" data-t="street.sky"></div>
            <div class="seg" role="radiogroup" data-key="lightPollution">
              ${LIGHT_POLLUTION.map((v) => `<button type="button" role="radio" data-value="${v}" data-t="street.sky_${v}"></button>`).join("")}
            </div></div>
        </div>
        <div class="hud sheet glass" role="dialog" aria-labelledby="sheet-title" tabindex="-1" hidden></div>
        <div class="hud bar"></div>
        <div class="photo-credit" hidden></div>
        <div class="veil"><div class="box"><div class="orbit"></div><div class="msg"></div><div class="sub"></div></div></div>
        <div class="sr-only" id="keys" data-t="street.keys"></div>
        <div class="sr-only announce" aria-live="polite"></div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    this._els = {
      root: $(".root"),
      stage: $(".stage"),
      sky: $(".sky"),
      map: $(".map"),
      overlay: $(".overlay"),
      title: $(".title"),
      state: $(".title .state"),
      chips: $(".title .chips"),
      icon: $(".title .icon"),
      name: $(".title .name"),
      when: $(".title .when"),
      look: $(".title .look"),
      note: $(".title .note"),
      tools: $(".tools"),
      cam: $(".cam"),
      layersBtn: $(".layers-btn"),
      infoBtn: $(".info-btn"),
      closeBtn: $(".close-btn"),
      compassBtn: $(".compass-btn"),
      lookBtn: $(".look-btn"),
      followBtn: $(".follow-btn"),
      phoneBtn: $(".phone-btn"),
      menu: $(".menu"),
      sources: $(".sources"),
      photoCredit: $(".photo-credit"),
      photoPick: $(".photo-pick"),
      photoPrev: $(".photo-prev"),
      photoNext: $(".photo-next"),
      photoWhere: $(".photo-info .where"),
      photoWhen: $(".photo-info .when"),
      photoNote: $(".photo-note"),
      sheet: $(".sheet"),
      banner: $(".banner"),
      bannerText: $(".banner span"),
      bar: $(".bar"),
      veil: $(".veil"),
      veilMsg: $(".veil .msg"),
      veilSub: $(".veil .sub"),
      announce: $(".announce"),
    };
    const els = this._els;
    els.closeBtn.addEventListener("click", () => this._close());
    els.layersBtn.addEventListener("click", () => this._toggleMenu());
    els.infoBtn.addEventListener("click", () => this._toggleSheet());
    els.compassBtn.addEventListener("click", () => this._frame(true));
    els.lookBtn.addEventListener("click", () => this._lookAtSatellite());
    els.followBtn.addEventListener("click", () => this._setOptions({ ...this._options, follow: !this._options.follow }));
    els.phoneBtn.addEventListener("click", () => this._toggleOrientation());
    els.phoneBtn.hidden = !this._orientationAvailable();
    els.photoPrev.addEventListener("click", () => this._stepPhoto(-1));
    els.photoNext.addEventListener("click", () => this._stepPhoto(1));
    els.menu.addEventListener("click", (ev) => {
      const button = ev.target.closest("button[data-value]");
      if (!button) return;
      const key = button.parentElement.dataset.key;
      const value = key === "eyeHeightM" ? Number(button.dataset.value) : button.dataset.value;
      this._setOptions({ ...this._options, [key]: value });
    });
    els.menu.addEventListener("change", (ev) => {
      const input = ev.target.closest("input[data-key]");
      if (input) this._setOptions({ ...this._options, [input.dataset.key]: input.checked });
    });
    // A tap outside puts the menu or the sheet away.
    els.root.addEventListener(
      "pointerdown",
      (ev) => {
        const path = ev.composedPath();
        if (!els.menu.hidden && !path.includes(els.menu) && !path.includes(els.layersBtn)) this._toggleMenu(false);
        if (!els.sheet.hidden && !path.includes(els.sheet) && !path.includes(els.infoBtn)) this._toggleSheet(false);
      },
      true,
    );
    this._installLookAround(els.stage);
  }

  _font() {
    try {
      const family = getComputedStyle(this).fontFamily;
      if (family && !family.includes("var(")) return family;
    } catch {
      // Not in a document.
    }
    return "Roboto, system-ui, -apple-system, 'Segoe UI', sans-serif";
  }

  /** Put the text into the page in the current language, and refresh what shows it. */
  _applyText() {
    const root = this.shadowRoot;
    if (!this._els || !root || !this._formatter) return;
    for (const el of root.querySelectorAll("[data-t]")) setText(el, this._t(el.dataset.t));
    const label = (el, key) => {
      const text = this._t(key);
      el.setAttribute("aria-label", text);
      el.title = text;
    };
    label(this._els.closeBtn, "street.close");
    label(this._els.layersBtn, "street.layers");
    label(this._els.infoBtn, "street.info");
    label(this._els.compassBtn, "street.frame");
    label(this._els.lookBtn, "street.look_at");
    label(this._els.followBtn, "street.follow");
    label(this._els.phoneBtn, "street.phone");
    label(this._els.photoPrev, "street.photo_prev");
    label(this._els.photoNext, "street.photo_next");
    this._els.menu.setAttribute("aria-label", this._t("street.layers"));
    this._els.title.setAttribute("aria-label", this._t("street.title"));
    for (const button of this._els.menu.querySelectorAll(".eye button")) setText(button, this._height(Number(button.dataset.value)));
    this._syncControls();
    this._renderCredit();
    this._renderTitle();
    if (!this._els.sheet.hidden) this._renderSheet();
    this._veilText();
    this._hudAt = 0;
  }

  _t(key, vars) {
    return this._formatter ? this._formatter.t(key, vars) : key;
  }

  /** A translated sentence as HTML: the template is escaped, the values (links) go in as they are. */
  _html(key, vars) {
    return this._formatter ? this._formatter.html(key, vars) : escapeHtml(key);
  }

  /** An eye height in the user's units: "1.7 m", "6 ft" ("auto" follows Home Assistant's unit system). */
  _height(m) {
    const imperial = this._units === "imperial" || (this._units !== "metric" && !!this._formatter?.imperial);
    if (imperial) return this._t("street.feet", { value: this._formatter?.num(Math.round(m * 3.28084)) ?? Math.round(m * 3.28084) });
    return this._t("street.metres", { value: this._formatter?.num(m, m < 10 && m % 1 ? 1 : 0) ?? m });
  }

  _syncControls() {
    const els = this._els;
    if (!els) return;
    const settings = this._settings?.value ?? NO_SETTINGS;
    // The street and the service as shown: chosen here, or as the integration's options say.
    const shown = { ...this._options, street: wantsPhoto(this._options, settings) ? "photo" : "model", photoSource: photoSource(this._options, settings) };
    for (const seg of els.menu.querySelectorAll(".seg")) {
      const key = seg.dataset.key;
      for (const b of seg.querySelectorAll("button")) {
        const value = key === "eyeHeightM" ? Number(b.dataset.value) : b.dataset.value;
        b.setAttribute("aria-checked", String(value === shown[key]));
      }
    }
    // The services to choose from: those there is a key for (with only Panoramax, nothing to choose).
    const sources = photoSources(settings);
    els.sources.hidden = shown.street !== "photo" || sources.length < 2;
    for (const b of els.sources.querySelectorAll("button")) b.hidden = b.dataset.value !== "auto" && !sources.includes(b.dataset.value);
    for (const input of els.menu.querySelectorAll("input[data-key]")) input.checked = !!this._options[input.dataset.key];
    els.followBtn.setAttribute("aria-pressed", String(!!this._options.follow));
    els.phoneBtn.setAttribute("aria-pressed", String(!!this._orientation));
    // The ground, buildings and eye height are the 3D model's: a photo is what it is.
    const photo = this._mode === "photo";
    for (const el of els.menu.querySelectorAll(".model-only")) el.hidden = photo;
    this._syncPhotoPick();
  }

  /** Which photo is up and where it was taken, or why there is none (and which service did not answer). */
  _syncPhotoPick() {
    const els = this._els;
    const list = this._photos?.list ?? [];
    const scene = this._mode === "photo" ? this._scene : null;
    const index = scene ? list.findIndex((p) => p.id === scene.photo?.id) : -1;
    els.photoPick.hidden = index < 0;
    const settings = this._settings?.value ?? NO_SETTINGS;
    const notes = [];
    if (wantsPhoto(this._options, settings)) {
      if (!scene && this._photoNote) notes.push(this._t(this._photoNote, { distance: this._distance(PHOTO_MAX_M) }));
      // With several services, one that failed while another answered is worth a word (its key may be wrong).
      if (this._photos && photoSources(settings).length > 1) {
        for (const [source, why] of this._photos.failed) notes.push(this._t(`street.photo_source_${why}`, { source: SOURCE_NAMES[source] }));
      }
    }
    els.photoNote.hidden = !notes.length;
    const text = notes.join(" ");
    if (els.photoNote.dataset.text !== text) {
      els.photoNote.dataset.text = text;
      els.photoNote.innerHTML = notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("");
    }
    if (index < 0) return;
    const photo = list[index];
    const f = this._formatter;
    const where =
      photo.distance < 8
        ? this._t("street.photo_here")
        : this._t("street.photo_where", { distance: this._distance(photo.distance), direction: f?.direction(compass16(photo.bearing)) ?? compass16(photo.bearing) });
    setText(els.photoWhere, where);
    // The service, once there is more than one.
    const service = photoSources(settings).length > 1 ? (photo.source === "google" ? "Google" : SOURCE_NAMES[photo.source ?? "panoramax"]) : "";
    setText(els.photoWhen, [this._t("street.photo_count", { index: f?.num(index + 1) ?? index + 1, count: f?.num(list.length) ?? list.length }), service, this._monthYear(photo.taken)].filter(Boolean).join(" · "));
    els.photoPrev.disabled = list.length < 2;
    els.photoNext.disabled = list.length < 2;
  }

  /** A distance in the user's units, rounded for reading: "40 m", "130 ft". */
  _distance(m) {
    const imperial = this._units === "imperial" || (this._units !== "metric" && !!this._formatter?.imperial);
    const value = imperial ? Math.round((m * 3.28084) / 5) * 5 : m < 20 ? Math.round(m) : Math.round(m / 5) * 5;
    return this._t(imperial ? "street.feet" : "street.metres", { value: this._formatter?.num(value) ?? value });
  }

  /** "July 2025", in the user's language. */
  _monthYear(unixS) {
    if (!Number.isFinite(unixS)) return "";
    try {
      const locale = this._hass?.locale?.language || this._hass?.language || undefined;
      return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(unixS * 1000));
    } catch {
      return "";
    }
  }

  _veilText() {
    const els = this._els;
    if (!els) return;
    setText(els.veilMsg, this._t(this._veilKey ?? "street.loading"));
    setText(els.veilSub, this._t(this._veilSubKey ?? "street.loading_detail"));
  }

  _showVeil(key = "street.loading", sub = "street.loading_detail") {
    this._veilKey = key;
    this._veilSubKey = sub;
    if (!this._els) return;
    this._els.veil.hidden = false;
    this._els.veil.classList.remove("gone");
    this._veilText();
  }

  _hideVeil() {
    const veil = this._els?.veil;
    if (!veil || veil.hidden || veil.classList.contains("gone")) return;
    veil.classList.add("gone");
    this._later(() => {
      if (veil.classList.contains("gone")) veil.hidden = true;
    }, prefersReducedMotion() ? 0 : 500);
  }

  /** A word in the title card about what is missing (the 3D street, the terrain…). */
  _banner(text) {
    const els = this._els;
    if (!els) return;
    els.banner.hidden = !text;
    setText(els.bannerText, text || "");
    this._measureHud();
  }

  _toggleMenu(open = this._els.menu.hidden) {
    const els = this._els;
    if (open) this._toggleSheet(false);
    els.menu.hidden = !open;
    els.layersBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      this._syncControls();
      els.menu.querySelector("[aria-checked='true'], input")?.focus();
    }
  }

  _toggleSheet(open = this._els.sheet.hidden) {
    const els = this._els;
    if (open) {
      this._toggleMenu(false);
      this._renderSheet();
    }
    els.sheet.hidden = !open;
    els.infoBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      // The sheet itself, from the top: its last button would scroll a long sheet to the end.
      els.sheet.scrollTop = 0;
      els.sheet.focus({ preventScroll: true });
    }
  }

  /** About this view: how to read it, privacy and credits for the sources in use. */
  _renderSheet() {
    const t = (key, vars) => escapeHtml(this._t(key, vars));
    const photo = this._mode === "photo" ? this._scene?.photo : null;
    const keys = photo ? ["photo", "stars"] : ["map", "terrain", ...(this._options.imagery === "aerial" ? ["imagery"] : []), "stars", "engine"];
    const credit = (key) => (key === "photo" ? this._photoCredit(photo) : CREDITS_FIXED[key] ?? this._html(`street.credit_${key}_text`, CREDIT_LINKS));
    const credits = keys.map((key) => `<li><b>${t(`street.credit_${key}`)}</b>: ${credit(key)}</li>`).join("");
    // With street photos on, the search for them goes out too (even when it found none), to every service there is a key for.
    const settings = this._settings?.value ?? NO_SETTINGS;
    const asked = wantsPhoto(this._options, settings) && this._photos;
    const keyed = photoSources(settings).filter((source) => source !== "panoramax");
    const services = keyed.length ? `<p>${t("street.privacy_photo_services", { services: this._list(keyed.map((source) => SOURCE_NAMES[source])) })}</p>` : "";
    this._els.sheet.innerHTML = `
      <h3 id="sheet-title">${t("street.info")}</h3>
      <p>${t(photo ? "street.about_photo" : "street.about")}</p>
      <div class="legend">
        <i></i><span>${t("street.legend_visible")}</span>
        <i class="faint"></i><span>${t("street.legend_faint")}</span>
        <i class="shadow"></i><span>${t("street.legend_shadow")}</span>
        <i class="xray"></i><span>${t(photo ? "street.legend_hidden_photo" : this._mode === "3d" && this._scene?.props && this._scene.treeCount > 0 ? "street.legend_hidden_model" : "street.legend_hidden")}</span>
      </div>
      <h4>${t("street.privacy_title")}</h4>
      <p>${t(photo ? "street.privacy_photo" : "street.privacy")}</p>
      ${asked && !photo ? `<p>${t("street.privacy_photo_search")}</p>` : ""}
      ${asked || photo ? services : ""}
      <h4>${t("street.credits")}</h4>
      <ul>${credits}</ul>
      <div class="actions"><button class="btn quiet" type="button">${t("street.done")}</button></div>`;
    this._els.sheet.querySelector(".actions button").addEventListener("click", () => {
      this._toggleSheet(false);
      this._els.infoBtn.focus();
    });
  }

  /**
   * A photo's credit, as its service asks: the photographer and the licence
   * (CC BY-SA asks for both) for Panoramax and Mapillary; Google's
   * copyright, and its link to report a problem with the image.
   */
  _photoCredit(photo) {
    if (photo.source === "google") {
      const text = this._html("street.credit_photo_google_text", { copyright: escapeHtml(photo.copyright || "© Google"), google: link(escapeHtml(photo.page), "Google Street View") });
      return photo.reportLink ? `${text} · ${link(escapeHtml(photo.reportLink), escapeHtml(this._t("street.photo_report")))}` : text;
    }
    const license = photo.licenseUrl ? link(escapeHtml(photo.licenseUrl), escapeHtml(photo.license || photo.licenseUrl)) : escapeHtml(photo.license);
    const author = photo.page ? link(escapeHtml(photo.page), escapeHtml(photo.author || this._t("street.photo_open"))) : escapeHtml(photo.author);
    if (photo.source === "mapillary") return this._html("street.credit_photo_mapillary_text", { author, license, mapillary: CREDIT_LINKS.mapillary });
    return this._html("street.credit_photo_text", { author, license, panoramax: CREDIT_LINKS.panoramax });
  }

  /**
   * The photo's credit in the corner, over the photo: Google asks for its
   * copyright and its report link at the bottom right of the image; the
   * others' photographers and licences are shown the same way.
   */
  _renderCredit() {
    const els = this._els;
    if (!els) return;
    const photo = this._mode === "photo" ? this._scene?.photo : null;
    els.photoCredit.hidden = !photo;
    els.root.classList.toggle("has-credit", !!photo);
    if (!photo) {
      els.photoCredit.innerHTML = "";
      return;
    }
    let html;
    if (photo.source === "google") {
      html = escapeHtml(photo.copyright || "© Google");
      if (photo.reportLink) html += ` · ${link(escapeHtml(photo.reportLink), escapeHtml(this._t("street.photo_report")))}`;
    } else {
      const author = photo.author ? (photo.page ? link(escapeHtml(photo.page), `© ${escapeHtml(photo.author)}`) : `© ${escapeHtml(photo.author)}`) : "";
      const license = photo.license ? (photo.licenseUrl ? link(escapeHtml(photo.licenseUrl), escapeHtml(photo.license)) : escapeHtml(photo.license)) : "";
      html = [author, license, photo.source === "mapillary" ? CREDIT_LINKS.mapillary : CREDIT_LINKS.panoramax].filter(Boolean).join(" · ");
    }
    if (els.photoCredit.innerHTML !== html) els.photoCredit.innerHTML = html;
  }

  /** "A, B and C" in the user's language. */
  _list(items) {
    try {
      const locale = this._hass?.locale?.language || this._hass?.language || undefined;
      return new Intl.ListFormat(locale, { type: "conjunction" }).format(items);
    } catch {
      return items.join(", ");
    }
  }

  // -- formatter, clock, timebar -------------------------------------------------

  async _ensureFormatter() {
    if (this._formatter) return;
    const [{ Formatter }, { loadStrings }] = await Promise.all([
      import(`./sat-format.js${VERSION}`),
      import(`./sat-i18n.js${VERSION}`),
    ]);
    const strings = await loadStrings(this._hass?.language || this._hass?.locale?.language);
    if (this._formatter) return;
    this._formatter = new Formatter(this._hass, strings);
    this._ownFormatter = true;
  }

  async _ensureClock() {
    if (this._clock) {
      // Open again after dispose(), which stopped listening to it.
      if (!this._unsubscribeClock) this._subscribeClock();
      return;
    }
    this._clock = new PassClock();
    this._ownClock = true;
    this._subscribeClock();
  }

  _subscribeClock() {
    this._unsubscribeClock?.();
    this._unsubscribeClock = this._clock?.on?.("change", () => {
      this._hudAt = 0;
      this._kick();
    });
  }

  /** The shared time bar (sat-timebar.js), bound to the clock; its globe button closes the street view. */
  _mountTimebar() {
    if (this._timebar || !this._els || !this._clock || !this._formatter) return;
    const host = this._els.bar;
    host.innerHTML = "";
    this._timebar = new Timebar(host, {
      clock: this._clock,
      formatter: this._formatter,
      onLive: () => this._clock.live(),
      onToggleView: this.globeToggle ? () => this._close() : undefined,
      onClose: () => this._close(),
    });
    this._timebar.setContext({ pass: this._pass, label: this._formatter.passTitle?.(this._pass) ?? this._pass?.title, view: "street" });
    this._measureHud();
  }

  // -- pass ---------------------------------------------------------------------------

  /** A pass or its path arrived: draw it, frame it, and ask for the path if it is missing. */
  _passChanged(newPass) {
    if (!this._opened || !this._els) return;
    const pass = this._pass;
    this._planetarium?.setPass(pass, this._detail);
    this._occlusionFor = null;
    this._timebar?.setContext?.({ pass, label: this._formatter?.passTitle?.(pass) ?? pass?.title, view: "street" });
    this._renderTitle();
    if (pass && this._clock) this._simulateIfNeeded();
    if (pass && !this._detail) this._requestDetail();
    else this._stopAsking();
    if (newPass || !this._userMoved) this._frame(false);
    if (this._mode === "2d") this._terrainOcclusion();
    if (this._mode === "photo") this._photoOcclusion();
    this._probeSoon();
    this._kick();
  }

  /**
   * Replay the pass unless the clock already shows it: live from a little
   * before the pass to its end (the rule the hosts follow too), or simulating it.
   */
  _simulateIfNeeded() {
    const clock = this._clock;
    const pass = this._pass;
    if (!clock?.simulate || !pass) return;
    const nowS = clock.simMs / 1000;
    const w = clock.window;
    if (clock.mode === "live" && passIsLive(pass, nowS)) return;
    if (w && w.fromS <= pass.start && w.toS >= pass.end) return;
    const reduced = prefersReducedMotion();
    clock.simulate({
      fromS: pass.start - PASS_LEAD_S,
      toS: pass.end + PASS_TAIL_S,
      visibleStartS: pass.start,
      visibleEndS: pass.end,
      startS: reduced ? pass.start - 10 : pass.start - PASS_LEAD_S,
      rate: "fit",
      loop: true,
      playing: true,
      periodS: pass.transits?.[0]?.period_s,
    });
  }

  /** Ask for the pass's path, once for each pass (`again`: start over, as when the connection is back). */
  _requestDetail({ again = false } = {}) {
    const pass = this._pass;
    if (!pass || (!again && this._asking?.passId === pass.id)) return;
    this._stopAsking();
    this._asking = { passId: pass.id, tries: 0, failed: false, timer: null };
    this._askForDetail(this._asking);
  }

  /**
   * One round: the host first ("need-detail"), then Home Assistant directly.
   * While the path does not come, another round after a wait; after the last,
   * the HUD says it could not load.
   */
  _askForDetail(ask) {
    const gen = this._gen;
    // The path is still wanted (same opening, same pass, none yet), and still this request's to get (none newer).
    const missing = () => gen === this._gen && !this._detail && this._pass?.id === ask.passId;
    const mine = () => missing() && this._asking === ask;
    this.dispatchEvent(new CustomEvent("need-detail", { detail: { passId: ask.passId }, bubbles: false }));
    // Nobody answered: ask Home Assistant directly.
    ask.timer = this._later(async () => {
      if (!mine()) return;
      if (this._hass?.callWS) {
        try {
          const msg = { type: "satellite_spotter/pass_track", pass_id: ask.passId };
          if (this._location?.entry_id) msg.entry_id = this._location.entry_id;
          const detail = await this._hass.callWS(msg);
          if (missing()) this.detail = detail;
        } catch (err) {
          console.warn("Satellite Spotter: could not load the pass's path:", err?.message || err);
        }
      }
      if (!mine()) return;
      const wait = DETAIL_RETRY_MS[ask.tries++];
      if (wait !== undefined) {
        ask.timer = this._later(() => mine() && this._askForDetail(ask), wait);
        return;
      }
      // Given up: the HUD says so, until the connection comes back and it starts over.
      ask.failed = true;
      this._drawn = null;
      this._hudAt = 0;
      this._kick();
    }, DETAIL_GRACE_MS);
  }

  _stopAsking() {
    clearTimeout(this._asking?.timer);
    this._asking = null;
  }

  /** Hear Home Assistant's connection come back while open (a path still missing is asked for again). */
  _watchConnection() {
    const connection = (this._opened && this._hass?.connection) || null;
    if (connection === this._connection) return;
    this._connection?.removeEventListener?.("ready", this._onReady);
    connection?.addEventListener?.("ready", this._onReady);
    this._connection = connection;
  }

  // -- the 3D scene and the 2D fallback ---------------------------------------------

  _observer() {
    const l = this._location ?? {};
    return { latitude: l.latitude ?? 0, longitude: l.longitude ?? 0, elevation: l.elevation ?? 0 };
  }

  async _startScene() {
    const gen = ++this._sceneGen;
    const loc = this._location;
    if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) {
      this._showVeil("street.no_location");
      return;
    }
    this._showVeil("street.loading", this._options.street !== "model" ? "street.loading_photo" : "street.loading_detail");
    await this._ready?.catch(() => {});
    if (gen !== this._sceneGen) return;
    // Where the photos come from (and the keys) are the integration's options.
    const settings = await this._streetSettings();
    if (gen !== this._sceneGen || !this._els) return;
    const photo = wantsPhoto(this._options, settings);
    this._syncControls();
    if (!photo) this._showVeil("street.loading", "street.loading_detail");
    this._abort = globalThis.AbortController ? new AbortController() : null;
    const signal = this._abort?.signal;
    if (photo && (await this._startPhoto(gen, signal))) return;
    if (gen !== this._sceneGen || !this._els) return;
    if (photo) this._showVeil("street.loading", "street.loading_detail");
    // The ground under the eye comes from the terrain tiles (Home Assistant's elevation is typed in by hand).
    const ground = this._groundElevation(loc.latitude, loc.longitude, { signal }).catch(() => null);
    if (!this._supportsWebGL2()) {
      this._fallback("webgl", await ground, gen);
      return;
    }
    let ml;
    try {
      ml = await this._loadMapLibre();
    } catch (err) {
      console.warn("Satellite Spotter: could not load the map library:", err?.message || err);
      if (gen === this._sceneGen) this._fallback("failed", await ground, gen);
      return;
    }
    const groundM = await ground;
    if (gen !== this._sceneGen || !this._els) return;
    const tS = this._timeS();
    const sky = this._planetarium.skyAt(tS);
    try {
      this._scene = this._createScene(this._els.map, {
        ml,
        latitude: loc.latitude,
        longitude: loc.longitude,
        ground: Number.isFinite(groundM) ? groundM : 0,
        eyeHeight: this._options.eyeHeightM,
        look: sceneLook(sky.sun, sky.moon, { solarHour: (((tS / 3600 + loc.longitude / 15) % 24) + 24) % 24 }),
        imagery: this._options.imagery,
        buildings: this._options.buildings,
        props: this._options.props,
        view: this._view,
        locale: mapLibreLocale((key) => this._t(key)),
        onDegrade: (e) => this._degraded(e),
        // Trees placed (or moved): what hides the path again.
        onProps: () => {
          this._occlusionFor = null;
          this._probeSoon();
        },
      });
    } catch (err) {
      console.warn("Satellite Spotter: the 3D street view is not available here:", err?.message || err);
      this._els.map.replaceChildren();
      this._fallback("webgl", groundM, gen);
      return;
    }
    this._mode = "3d";
    const map = this._scene.map;
    this._scene.resize();
    map.on("render", () => this._draw());
    map.on("idle", () => this._idle());
    map.on("webglcontextlost", () => this._contextLost());
    map.on("webglcontextrestored", () => this._contextRestored());
    map.once("load", () => {
      // Credits are in the info sheet; MapLibre's stay a small button.
      map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    });
    this._later(() => this._hideVeil(), VEIL_MAX_MS);
    this._kick();
  }

  /**
   * A street photo near home in place of the 3D model: the one chosen
   * before for this place, else the best, else the next that loads and
   * shows enough sky. True when a photo is up (or this start was
   * superseded); false sends the street view on to the 3D model, with a
   * word in the layers menu about why.
   */
  async _startPhoto(gen, signal) {
    const loc = this._location;
    let list;
    try {
      list = await this._photoList(loc, photoSource(this._options, this._settings?.value), signal);
    } catch (err) {
      if (gen !== this._sceneGen) return true;
      console.info("Satellite Spotter: no street photos (no service answered):", err?.message || err);
      this._photoNote = "street.photo_unavailable";
      this._syncControls();
      return false;
    }
    if (gen !== this._sceneGen || !this._els) return true;
    if (!list.length) {
      this._photoNote = "street.photo_none";
      this._syncControls();
      return false;
    }
    const sky = this._planetarium?.skyAt(this._timeS());
    for (const photo of photoOrder(list, storedPhotoChoice(loc)).slice(0, PHOTO_TRIES)) {
      let scene;
      try {
        scene = this._createPhotoScene(this._els.map, {
          photo,
          view: this._view,
          sunAt: (ms, place) => sunAzEl(ms, place),
          onContextLost: () => this._contextLost(),
          onContextRestored: () => this._contextRestored(),
        });
      } catch (err) {
        console.warn("Satellite Spotter: the street photo cannot be drawn here:", err?.message || err);
        break;
      }
      if (sky) scene.setLook(scene.lookFor(sky.sun, sky.moon));
      // Loading, it is not the scene yet; a close or a restart meanwhile frees it (and its downloads).
      this._pendingScene = scene;
      try {
        await scene.load();
      } catch (err) {
        scene.remove();
        if (this._pendingScene === scene) this._pendingScene = null;
        if (gen !== this._sceneGen || !this._els) return true;
        console.info(`Satellite Spotter: street photo ${photo.id} not used:`, err?.message || err);
        continue;
      }
      if (this._pendingScene === scene) this._pendingScene = null;
      if (gen !== this._sceneGen || !this._els) {
        scene.remove();
        return true;
      }
      this._scene = scene;
      this._mode = "photo";
      this._photoNote = null;
      scene.setView(this._view);
      this._lookAt = 0;
      this._updateLook(this._timeS());
      this._photoOcclusion();
      this._syncControls();
      this._renderCredit();
      if (!this._els.sheet.hidden) this._renderSheet();
      this._hideVeil();
      this._announce(this._t("street.ready"));
      this._kick();
      return true;
    }
    this._photoNote = "street.photo_failed";
    this._syncControls();
    return false;
  }

  /**
   * The photos near a place of a service, or of all there is a key for
   * ("auto"), best first. Each service is asked once per place (again after
   * it failed); rejects when none answered.
   */
  async _photoList(loc, source, signal) {
    const key = placeKey(loc);
    if (this._photos?.key !== key) this._photos = { key, searches: new Map(), failed: new Map(), list: [] };
    const photos = this._photos;
    const settings = this._settings?.value ?? NO_SETTINGS;
    const sources = source === "auto" ? photoSources(settings) : [source];
    const locale = { language: this._hass?.locale?.language || this._hass?.language || "en", region: this._hass?.config?.country || "US" };
    const lists = await Promise.all(
      sources.map(async (s) => {
        if (!photos.searches.has(s)) photos.searches.set(s, this._findPhotos({ latitude: loc.latitude, longitude: loc.longitude }, { source: s, keys: settings, signal, ...locale }));
        try {
          const list = await photos.searches.get(s);
          photos.failed.delete(s);
          return list;
        } catch (err) {
          if (photos.searches.has(s)) photos.searches.delete(s);
          if (err?.name !== "AbortError") {
            // A refusal is about the key; anything else, the service is out of reach.
            photos.failed.set(s, err?.refused ? "refused" : "failed");
            console.info(`Satellite Spotter: no street photos from ${SOURCE_NAMES[s] ?? s}:`, err?.message || err);
          }
          return null;
        }
      }),
    );
    if (lists.every((list) => list === null)) throw new Error(sources.map((s) => SOURCE_NAMES[s] ?? s).join(", ") + " did not answer");
    photos.list = rankPhotos(lists.filter(Boolean)).slice(0, PHOTO_LIST_MAX);
    return photos.list;
  }

  /** The integration's photo settings for this location, asked for once per location (and given up on after a few seconds). */
  async _streetSettings() {
    const entry = this._location?.entry_id ?? null;
    if (this._settings?.entry === entry) return this._settings.value;
    if (!this._hass?.callWS) return NO_SETTINGS;
    const msg = { type: "satellite_spotter/street" };
    if (entry) msg.entry_id = entry;
    try {
      const value = streetSettings(await timeLimit(this._fetchStreetSettings(msg), SETTINGS_MS));
      // Only an answer is kept: without one, the next start asks again.
      this._settings = { entry, value };
      return value;
    } catch (err) {
      console.info("Satellite Spotter: no street photo settings from Home Assistant (photos from Panoramax):", err?.message || err);
      return NO_SETTINGS;
    }
  }

  /** The previous or next photo near home (remembered for this place). */
  _stepPhoto(delta) {
    const list = this._photos?.list ?? [];
    const current = this._mode === "photo" ? this._scene?.photo : null;
    if (list.length < 2 || !current || !this._location) return;
    const index = list.findIndex((p) => p.id === current.id);
    const next = list[(index + delta + list.length) % list.length];
    storePhotoChoice(this._location, next.id);
    this._restartScene();
  }

  /** What the photo hides of the pass (the whole path: the photo needs no read-back). */
  _photoOcclusion() {
    const p = this._planetarium;
    const scene = this._scene;
    if (this._mode !== "photo" || !scene?.found || !p?.primary) return;
    p.setOcclusion(hiddenByPhoto(scene.found, scene.rotation, p.primary.data), "photo");
    this._hudAt = 0;
  }

  /** The map settled: show it, check the GPU keeps up, re-seat the eye, and see what the buildings hide. */
  async _idle() {
    const scene = this._scene;
    if (!scene || !this._opened) return;
    if (!this._settled) {
      this._settled = true;
      this._hideVeil();
      this._announce(this._t("street.ready"));
      const gen = this._sceneGen;
      const median = await scene.benchmark();
      if (gen !== this._sceneGen || this._scene !== scene) return;
      if (median > SLOW_FRAME_MS) {
        console.info(`Satellite Spotter: the 3D street view draws a frame in ${Math.round(median)} ms here; showing the 2D sky instead`);
        this._scene.remove();
        this._scene = null;
        this._fallback("slow", scene.ground, gen);
        return;
      }
    }
    if (scene.reseat()) return; // The next idle probes.
    this._probe();
  }

  _probeSoon() {
    if (this._mode !== "3d" || !this._scene) return;
    clearTimeout(this._probeTimer);
    this._probeTimer = this._later(() => {
      if (this._scene?.map?.loaded?.() && !this._scene.map.isMoving?.()) this._probe();
    }, 400);
  }

  /** Read which stretches of the path the map hides, for this view. */
  async _probe() {
    const scene = this._scene;
    const planetarium = this._planetarium;
    if (!scene || !planetarium?.primary || this._dragging || this._tween) return;
    const P = this._projector();
    const key = `${P.key}|${this._pass?.id}|${scene.eyeHeight}|${this._options.buildings}|${this._options.props}|${scene.treeCount}|${this._options.imagery}`;
    if (this._occlusionFor === key) return;
    const result = await scene.probe(planetarium.probeSamples(P));
    if (!result || this._scene !== scene || this._projector().key !== P.key) return;
    this._occlusionFor = key;
    // The read-back cannot tell a building from a tree or a hill: the HUD names what the map has.
    const buildings = scene.buildings && !scene.degraded.has("ofm");
    const terrain = !scene.degraded.has("terrain");
    const trees = !!scene.props && scene.treeCount > 0;
    planetarium.setOcclusion(result, trees ? "model" : terrain ? (buildings ? "buildings_or_terrain" : "terrain") : "buildings");
    this._hudAt = 0;
    this._kick();
  }

  /** No 3D street here: the sky over the terrain skyline, with a word about why. */
  async _fallback(reason, groundM, gen) {
    if (gen !== this._sceneGen || !this._els) return;
    this._mode = "2d";
    this._fallbackReason = reason;
    this._banner(this._t("street.fallback", { reason: this._t(`street.reason_${reason}`) }));
    this._hideVeil();
    this._kick();
    const loc = this._location;
    const eye = (Number.isFinite(groundM) ? groundM : loc.elevation ?? 0) + this._options.eyeHeightM;
    try {
      const data = await this._skyline(loc.latitude, loc.longitude, eye, { signal: this._abort?.signal });
      if (gen !== this._sceneGen || !this._planetarium) return;
      this._skylineData = data;
      this._planetarium.setSkyline(data);
      this._terrainOcclusion();
      this._kick();
    } catch (err) {
      if (gen !== this._sceneGen) return;
      console.warn("Satellite Spotter: could not load the terrain skyline:", err?.message || err);
    }
  }

  _terrainOcclusion() {
    const p = this._planetarium;
    if (!this._skylineData || !p?.primary) return;
    p.setOcclusion(hiddenByTerrain(this._skylineData, p.primary.data), "terrain");
    this._hudAt = 0;
  }

  _degraded({ source }) {
    const key = `street.degraded_${source}`;
    this._banner(this._t(key));
    if (source === "imagery") this._syncControls();
    this._occlusionFor = null;
    this._probeSoon();
  }

  _restartScene() {
    this._scene?.remove();
    this._scene = null;
    this._pendingScene?.remove();
    this._pendingScene = null;
    this._settled = false;
    this._mode = null;
    this._renderCredit();
    this._skylineData = null;
    this._photoNote = null;
    this._occlusionFor = null;
    this._planetarium?.setSkyline(null);
    this._planetarium?.setOcclusion(null);
    this._banner(null);
    this._abort?.abort();
    this._startScene();
  }

  _contextLost() {
    this._showVeil("street.reloading");
    clearTimeout(this._contextTimer);
    this._contextTimer = this._later(() => this._opened && this._restartScene(), CONTEXT_RESTORE_MS);
  }

  _contextRestored() {
    clearTimeout(this._contextTimer);
    this._hideVeil();
    this._scene?.setView(this._view);
  }

  // -- options --------------------------------------------------------------------------

  _setOptions(next, { emit = true } = {}) {
    const old = this._options;
    const o = normalizeOptions(next);
    this._options = o;
    if (JSON.stringify(o) === JSON.stringify(old)) return;
    if (emit) {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(o));
      } catch {
        // Private mode or storage full: the choice lasts until the page closes.
      }
      this.dispatchEvent(new CustomEvent("options-changed", { detail: { ...o }, bubbles: false }));
    }
    this._syncControls();
    if (!this._opened) return;
    this._planetarium?.setOptions({ constellations: o.constellations, lightPollution: o.lightPollution });
    const settings = this._settings?.value ?? NO_SETTINGS;
    const photo = wantsPhoto(o, settings);
    if (photo !== wantsPhoto(old, settings) || (photo && photoSource(o, settings) !== photoSource(old, settings))) {
      // A photo or the 3D model, or another service's photos: another scene.
      this._restartScene();
    } else if (this._scene && this._mode === "3d") {
      const scene = this._scene;
      if (o.imagery !== old.imagery) scene.setImagery(o.imagery);
      if (o.buildings !== old.buildings) scene.setBuildings(o.buildings);
      if (o.props !== old.props) scene.setProps?.(o.props);
      if (o.eyeHeightM !== old.eyeHeightM) scene.setEyeHeight(o.eyeHeightM);
      this._occlusionFor = null;
      this._probeSoon();
    }
    if (o.follow && !old.follow) this._following = false;
    if (!this._els.sheet.hidden) this._renderSheet();
    this._kick();
  }

  // -- camera -----------------------------------------------------------------------------

  _projector() {
    const w = this._size?.width || 1;
    const h = this._size?.height || 1;
    return makeProjector({ ...this._view, width: w, height: h });
  }

  /** Turn the camera (and the map's) to a view. */
  _setView(view) {
    const v = { ...this._view, ...view };
    v.pitch = clamp(v.pitch, PITCH_MIN, PITCH_MAX);
    v.fov = clamp(v.fov, FOV_MIN, FOV_MAX);
    v.bearing = wrap360(v.bearing);
    this._view = v;
    this._scene?.setView(v);
    this._updateCompass();
    this._kick();
  }

  /** Frame the whole pass (the compass button, a new pass). */
  _frame(animate) {
    const pass = this._pass;
    if (!pass) return;
    const arc = this._detail ? visibleArc(this._detail, pass) : summaryArc(pass);
    if (!arc.length) return;
    const width = this._size?.width || 1280;
    const height = this._size?.height || 800;
    const view = frameView(arc, { aspect: width / height, safe: this._safeArea(width, height) });
    this._userMoved = false;
    this._following = false;
    this._followPausedUntil = 0;
    this._moveTo(view, animate);
  }

  _lookAtSatellite() {
    const s = this._state?.current;
    const target = s && s.elevation > 0 ? s : null;
    const track = this._state?.focus ?? this._planetarium?.primary;
    let az = target?.azimuth;
    let el = target?.elevation;
    if (target == null && track) {
      // Not up yet (or gone): where it appears.
      const i = track.data.t.findIndex((t) => t + track.offset >= track.visibleStart);
      if (i >= 0) [az, el] = [track.data.az[i], track.data.el[i]];
    }
    if (!Number.isFinite(az)) return;
    this._following = !!this._options.follow;
    this._followPausedUntil = 0;
    this._moveTo({ bearing: az, pitch: 90 + el }, true);
  }

  /** Move the camera, eased (or at once with reduced motion). */
  _moveTo(view, animate) {
    const from = { ...this._view };
    const to = { ...from, ...view };
    if (!animate || prefersReducedMotion() || (!this._scene && this._mode !== "2d")) {
      this._tween = null;
      this._setView(to);
      return;
    }
    this._tween = { from, to, start: null, ms: 700 };
    this._kick();
  }

  _stepTween(now) {
    const tw = this._tween;
    if (!tw) return false;
    tw.start ??= now;
    const f = Math.min(1, (now - tw.start) / tw.ms);
    const k = ease(f);
    this._setView({
      bearing: tw.from.bearing + turn(tw.from.bearing, tw.to.bearing) * k,
      pitch: tw.from.pitch + (tw.to.pitch - tw.from.pitch) * k,
      fov: tw.from.fov + (tw.to.fov - tw.from.fov) * k,
    });
    if (f >= 1) {
      this._tween = null;
      this._probeSoon();
    }
    return true;
  }

  /**
   * Keep the satellite in view while it can be seen: nothing while it is on
   * screen (a framed pass stays still); once it is about to leave the view
   * the camera locks on and follows it smoothly (with reduced motion: jumps).
   */
  _follow(now, dtMs) {
    // Live, during the pass, the view always keeps the satellite (as James's site centres on it).
    const pass = this._pass;
    const tS = this._timeS();
    const live = this._clock?.mode === "live" && pass && tS >= pass.start && tS < pass.end;
    if (this._orientation || !(this._options.follow || live)) return;
    if (this._dragging || this._tween || now < this._followPausedUntil) return;
    const s = this._state?.current;
    const track = this._state?.focus;
    if (!s || !track || s.elevation < 1 || !this._clock?.playing) return;
    // Only while it can be seen: not on its way up in Earth's shadow, nor after it has gone.
    if (tS < track.visibleStart - 2 || tS > track.visibleEnd) {
      this._following = false;
      return;
    }
    const P = this._projector();
    const q = P.project(s.azimuth, s.elevation);
    const ins = this._insets();
    const w = P.width - ins.left - ins.right;
    const h = P.height - ins.top - ins.bottom;
    const inside = (m) => q && q[0] > ins.left + w * m && q[0] < P.width - ins.right - w * m && q[1] > ins.top + h * m && q[1] < P.height - ins.bottom - h * m;
    if (!this._following) {
      if (inside(0.03)) return;
      this._following = true;
    }
    const target = { bearing: s.azimuth, pitch: clamp(90 + s.elevation, PITCH_MIN, 160) };
    if (prefersReducedMotion()) {
      this._setView(target);
      this._following = false;
      return;
    }
    const k = 1 - Math.exp(-dtMs / 450);
    this._setView({
      bearing: this._view.bearing + turn(this._view.bearing, target.bearing) * k,
      pitch: this._view.pitch + (target.pitch - this._view.pitch) * k,
    });
  }

  _installLookAround(stage) {
    const view = () => this._view;
    // A click on the scene keeps the keyboard on the scene: MapLibre's canvas
    // would otherwise take the focus, and with it the arrow keys. Its
    // attribution button stays clickable.
    stage.addEventListener("mousedown", (ev) => {
      if (ev.target?.closest?.(".maplibregl-ctrl")) return;
      ev.preventDefault();
      stage.focus({ preventScroll: true });
    });
    stage.addEventListener("pointerdown", (ev) => {
      if (ev.button !== undefined && ev.button !== 0 && ev.pointerType === "mouse") return;
      stage.setPointerCapture?.(ev.pointerId);
      this._pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      this._gesture = { view: { ...view() }, pointers: new Map([...this._pointers].map(([id, p]) => [id, { ...p }])) };
      this._dragging = true;
      this._tween = null;
      stage.classList.add("dragging");
    });
    const end = (ev) => {
      this._pointers.delete(ev.pointerId);
      this._gesture = this._pointers.size ? { view: { ...view() }, pointers: new Map([...this._pointers].map(([id, p]) => [id, { ...p }])) } : null;
      if (!this._pointers.size) {
        this._dragging = false;
        stage.classList.remove("dragging");
        this._probeSoon();
      }
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("pointermove", (ev) => {
      if (!this._pointers.has(ev.pointerId) || !this._gesture) return;
      this._pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const g = this._gesture;
      const height = this._size?.height || 1;
      this._userTurned();
      if (this._pointers.size >= 2 && g.pointers.size >= 2) {
        // Pinch: the field of view scales with the fingers' spread.
        const [a, b] = [...this._pointers.values()];
        const [a0, b0] = [...g.pointers.values()];
        const spread = Math.hypot(a.x - b.x, a.y - b.y);
        const spread0 = Math.hypot(a0.x - b0.x, a0.y - b0.y) || 1;
        this._setView({ fov: clamp((g.view.fov * spread0) / Math.max(spread, 1), FOV_MIN, FOV_MAX) });
        return;
      }
      const start = g.pointers.get(ev.pointerId);
      if (!start) return;
      // The sky follows the finger: drag right to turn left, down to look up.
      const degPerPx = g.view.fov / height;
      this._setView({
        bearing: g.view.bearing - (ev.clientX - start.x) * degPerPx,
        pitch: g.view.pitch + (ev.clientY - start.y) * degPerPx,
      });
    });
    stage.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        this._userTurned();
        const scale = ev.deltaMode === 1 ? 40 : 1;
        this._setView({ fov: clamp(this._view.fov * Math.exp(ev.deltaY * scale * 0.0015), FOV_MIN, FOV_MAX) });
        this._probeSoon();
      },
      { passive: false },
    );
  }

  _userTurned() {
    this._userMoved = true;
    this._following = false;
    this._followPausedUntil = performance.now() + FOLLOW_PAUSE_MS;
  }

  _keyDown(ev) {
    if (ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const els = this._els;
    if (!els) return;
    if (ev.key === "Escape") {
      if (!els.menu.hidden) {
        this._toggleMenu(false);
        els.layersBtn.focus();
      } else if (!els.sheet.hidden) {
        this._toggleSheet(false);
        els.infoBtn.focus();
      } else {
        this._close();
      }
      ev.preventDefault();
      // A host dialog (or the globe's simulation) must not close too.
      ev.stopPropagation();
      return;
    }
    // The rest only while the scene itself has the focus.
    if (this.shadowRoot.activeElement !== els.stage) return;
    const step = ev.shiftKey ? 15 : 5;
    const v = this._view;
    const keys = {
      ArrowLeft: () => this._setView({ bearing: v.bearing - step }),
      ArrowRight: () => this._setView({ bearing: v.bearing + step }),
      ArrowUp: () => this._setView({ pitch: v.pitch + step }),
      ArrowDown: () => this._setView({ pitch: v.pitch - step }),
      "+": () => this._setView({ fov: v.fov / 1.15 }),
      "=": () => this._setView({ fov: v.fov / 1.15 }),
      "-": () => this._setView({ fov: v.fov * 1.15 }),
      Home: () => this._frame(true),
      f: () => this._setOptions({ ...this._options, follow: !this._options.follow }),
      l: () => this._lookAtSatellite(),
      " ": () => this._clock?.toggle?.(),
    };
    const action = keys[ev.key];
    if (!action) return;
    ev.preventDefault();
    if (ev.key.startsWith("Arrow") || ["+", "=", "-"].includes(ev.key)) {
      this._userTurned();
      this._probeSoon();
    }
    action();
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: false }));
  }

  // -- "Point your phone at the sky" ------------------------------------------------------

  _orientationAvailable() {
    return !!globalThis.DeviceOrientationEvent && !!globalThis.matchMedia?.("(pointer: coarse)").matches;
  }

  async _toggleOrientation() {
    if (this._orientation) {
      this._stopOrientation();
      this._syncControls();
      return;
    }
    const DOE = globalThis.DeviceOrientationEvent;
    try {
      // iOS asks for permission, and only from a tap.
      if (typeof DOE?.requestPermission === "function" && (await DOE.requestPermission()) !== "granted") return;
    } catch {
      return;
    }
    const type = "ondeviceorientationabsolute" in globalThis ? "deviceorientationabsolute" : "deviceorientation";
    const handler = (e) => {
      const o = this._orientation;
      // Off the page (the host may put it back) the map is not turned.
      if (!o || this.isConnected === false) return;
      // alpha from north, counterclockwise: iOS gives a compass heading (clockwise) instead.
      const alpha = Number.isFinite(e.webkitCompassHeading) ? 360 - e.webkitCompassHeading : e.absolute || type === "deviceorientationabsolute" ? e.alpha : null;
      if (!Number.isFinite(alpha) || !Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
      // Both are from magnetic north, the sky and the streets from true north: turn by the declination.
      const view = deviceView(alpha - o.declination, e.beta, e.gamma);
      // Smooth the sensors' jitter.
      o.bearing = o.bearing == null ? view.bearing : o.bearing + turn(o.bearing, view.bearing) * 0.25;
      o.pitch = o.pitch == null ? view.pitch : o.pitch + (view.pitch - o.pitch) * 0.25;
      this._setView({ bearing: o.bearing, pitch: o.pitch });
    };
    this._orientation = { type, handler, bearing: null, pitch: null, declination: this._declination() };
    globalThis.addEventListener(type, handler);
    this._syncControls();
  }

  /** The magnetic declination at the observer (degrees, east positive): a compass heading plus it is a true bearing. */
  _declination() {
    const l = this._location;
    if (!Number.isFinite(l?.latitude) || !Number.isFinite(l?.longitude)) return 0;
    const d = declination(l.latitude, l.longitude, (Number.isFinite(l.elevation) ? l.elevation : 0) / 1000);
    return Number.isFinite(d) ? d : 0;
  }

  _stopOrientation() {
    const o = this._orientation;
    if (!o) return;
    globalThis.removeEventListener(o.type, o.handler);
    this._orientation = null;
    this._probeSoon();
  }

  // -- size ----------------------------------------------------------------------------------

  _observeSize() {
    if (!globalThis.ResizeObserver) return;
    this._resizeObserver = new ResizeObserver(() => {
      this._resize();
      this._measureHud();
      this._kick();
    });
    // The HUD's panels too: labels and arrows keep clear of them as they grow and shrink.
    for (const el of [this, this._els.title, this._els.bar]) this._resizeObserver.observe(el);
  }

  _resize() {
    if (!this._els) return;
    const width = this.clientWidth || this._els.root.clientWidth || 0;
    const height = this.clientHeight || this._els.root.clientHeight || 0;
    if (!width || !height) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const same = this._size && this._size.width === width && this._size.height === height && this._size.dpr === dpr;
    this._size = { width, height, dpr };
    this._els.root.classList.toggle("narrow", width < 640);
    if (same) return;
    this._planetarium?.resize(width, height, dpr);
    this._scene?.resize();
    this._measureHud();
    this._drawn = null;
  }

  /** How much of the screen the HUD covers, for labels and arrows to keep clear of. */
  _measureHud() {
    const els = this._els;
    if (!els?.title?.getBoundingClientRect) return;
    const host = els.root.getBoundingClientRect();
    const bar = els.bar.getBoundingClientRect();
    const title = els.title.getBoundingClientRect();
    const barH = bar.height ? host.bottom - bar.top : 0;
    els.root.style.setProperty("--bar-h", `${Math.round(barH)}px`);
    els.root.style.setProperty("--title-h", `${Math.round(title.height)}px`);
    this._hudBoxes = [els.title, els.tools, els.cam]
      .filter((el) => !el.hidden)
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width)
      .map((r) => ({ x0: r.left - host.left - 6, y0: r.top - host.top - 6, x1: r.right - host.left + 6, y1: r.bottom - host.top + 6 }));
    this._barHeight = barH;
    // Labels are laid out around the HUD: draw again.
    this._drawn = null;
  }

  /** The part of the screen the HUD leaves free, as fractions at each edge (for framing a pass). */
  _safeArea(width, height) {
    const narrow = width < 640;
    const titleBottom = Math.max(0, ...(this._hudBoxes ?? []).map((b) => (b.x0 < width * 0.6 ? b.y1 : 0)));
    return {
      top: clamp((titleBottom || (narrow ? 150 : 130)) / height + 0.02, 0.08, 0.4),
      bottom: clamp(((this._barHeight || 70) + 16) / height, 0.08, 0.3),
      left: 0.04,
      right: narrow ? 0.14 : 0.06,
    };
  }

  _insets() {
    return { top: 0, right: 0, bottom: (this._barHeight || 0) + 6, left: 0 };
  }

  // -- the frame loop ---------------------------------------------------------------------------

  _timeS() {
    return (this._clock?.simMs ?? Date.now()) / 1000;
  }

  /** Make sure a frame comes (the loop stops itself when nothing moves; off the page none comes). */
  _kick() {
    if (!this._opened || this._raf !== null || globalThis.document?.hidden || this.isConnected === false) return;
    this._raf = requestAnimationFrame((now) => this._tick(now));
  }

  _stopLoop() {
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
    clearTimeout(this._liveTimer);
  }

  _tick(now) {
    this._raf = null;
    if (!this._opened || !this._els) return;
    const dt = this._lastFrame === null ? 16 : Math.min(100, now - this._lastFrame);
    this._lastFrame = now;
    this._clock?.tick?.(now);
    const tween = this._stepTween(now);
    this._follow(now, dt);
    this._draw();
    this._timebar?.update?.();
    const playing = !!this._clock?.playing;
    const live = this._clock?.mode === "live";
    // Following waits while the replay is paused: nothing moves until it plays (which kicks the loop again).
    if (tween || this._tween || this._dragging || (playing && !live) || (this._following && playing)) {
      this._kick();
    } else if (playing && live) {
      // Real time: the dot creeps across the sky; ten frames a second are plenty.
      clearTimeout(this._liveTimer);
      this._liveTimer = setTimeout(() => this._kick(), LIVE_FRAME_MS);
    } else {
      this._lastFrame = null;
    }
  }

  /** Draw the sky and the labels for the camera and time now (once per change). */
  _draw() {
    const p = this._planetarium;
    if (!p || !this._size || !this._els) return;
    const P = this._projector();
    const tS = this._timeS();
    const key = `${P.key}|${tS.toFixed(3)}|${p.stamp}`;
    // The map renders as its tiles arrive too; the canvases only need drawing when something changed.
    if (key === this._drawn) return;
    this._drawn = key;
    this._state = p.draw(P, tS, { insets: this._insets(), obstacles: this._hudBoxes });
    this._updateLook(tS);
    const now = performance.now();
    if (now - this._hudAt >= HUD_MS) {
      this._hudAt = now;
      this._renderHud(tS);
    }
  }

  /** Light the street for the moment shown (only when the look changes: each change redraws the map). */
  _updateLook(tS) {
    const scene = this._scene;
    const sky = this._planetarium?._skyAt;
    if (!scene || !sky) return;
    // Each kind of scene has its own look (the photo's is a grade, the model's its colours and light,
    // with as many windows lit as at that hour: local solar time is near enough).
    const solarHour = (((tS / 3600 + (this._location?.longitude ?? 0) / 15) % 24) + 24) % 24;
    const look = scene.lookFor ? scene.lookFor(sky.sun, sky.moon) : sceneLook(sky.sun, sky.moon, { solarHour });
    if (look.key === scene.look?.key) return;
    const now = performance.now();
    if (this._lookAt && now - this._lookAt < 1000) return;
    this._lookAt = now;
    scene.setLook(look);
  }

  // -- the HUD ------------------------------------------------------------------------------------

  _renderTitle() {
    const els = this._els;
    const pass = this._pass;
    if (!els || !this._formatter) return;
    const f = this._formatter;
    els.root.classList.toggle("has-title", !!pass);
    els.icon.innerHTML = svgIcon(kindIcon(pass?.kind, { train: !!pass?.train }));
    setText(els.name, pass ? f.passTitle?.(pass) ?? pass.title : this._location?.title ?? "");
    setText(els.when, pass ? `${f.dateTime(pass.start)} · ${f.duration?.(pass.duration ?? pass.end - pass.start) ?? ""}` : "");
    const chips = [];
    if (pass?.bright) chips.push(`<span class="chip gold">★ ${escapeHtml(this._t("street.bright"))}</span>`);
    if (pass?.before_sunset) chips.push(`<span class="chip warn">${escapeHtml(this._t("street.daylight"))}</span>`);
    els.chips.innerHTML = chips.join("");
    this._measureHud();
  }

  /** The words that change with time: where to look, how bright, and what hides it. */
  _renderHud(tS) {
    const els = this._els;
    const f = this._formatter;
    const pass = this._pass;
    const s = this._state;
    if (!els || !f) return;
    const clock = this._clock;
    const live = clock?.mode === "live";
    const during = pass && tS >= pass.start && tS < pass.end;
    els.title.classList.toggle("now", !!(live && during));
    els.title.classList.toggle("sim", !live);
    const state = this._t(live ? (during ? "street.state_live_now" : "street.state_live") : "street.state_sim");
    setText(els.state, this._size?.width < 640 ? state : `${this._t("street.title")} · ${state}`);
    const cur = s?.current;
    let look = "";
    let dim = false;
    let mag = "";
    // The satellite to look for: the primary, or the member of a group still to be seen.
    const track = s?.focus ?? this._planetarium?.primary;
    if (!pass) {
      look = "";
    } else if (!track) {
      look = this._t(this._asking?.failed ? "street.path_failed" : "street.loading_path");
      dim = true;
    } else if (cur && cur.elevation > 0 && tS <= track.visibleEnd + 2 && tS >= track.rise) {
      const where = { direction: f.direction(compass16(cur.azimuth)), elevation: f.num(Math.round(cur.elevation)) };
      if (!cur.lit) {
        look = this._t("street.in_shadow", where);
        dim = true;
      } else {
        look = this._t("street.look_up", where);
        dim = !cur.visible;
        if (Number.isFinite(cur.magnitude)) mag = this._t("street.magnitude", { magnitude: f.magnitude(cur.magnitude) });
      }
    } else if (tS < track.visibleStart) {
      const start = sampleStart(track);
      look = this._t("street.appears_in", { countdown: f.countdown((track.visibleStart - tS) * 1000), direction: f.direction(compass16(start.azimuth)) });
      dim = true;
    } else {
      look = this._t("street.gone");
      dim = true;
    }
    if (els.look.dataset.text !== `${look}|${mag}`) {
      els.look.dataset.text = `${look}|${mag}`;
      els.look.innerHTML = `${escapeHtml(look)}${mag ? ` <span class="mag">· ${escapeHtml(mag)}</span>` : ""}`;
    }
    els.look.classList.toggle("dim", dim);
    const note = s?.note;
    let noteText = "";
    if (note) {
      const where = ["terrain", "buildings_or_terrain", "photo", "model"].includes(note.source) ? note.source : "buildings";
      noteText = this._t(`street.hidden_${note.kind}_${where}`, { time: f.time(note.time, { seconds: true }) });
    }
    if (els.note.hidden !== !noteText) {
      els.note.hidden = !noteText;
      this._measureHud();
    }
    setText(els.note, noteText);
    this._updateCompass();
    this._updateStageLabel();
    // The visible moment, live, is worth saying out loud.
    const visibleNow = !!(live && cur?.visible && !cur.hidden);
    if (visibleNow && !this._saidVisible) this._announce(look);
    this._saidVisible = visibleNow;
  }

  _updateCompass() {
    const svg = this._els?.compassBtn.firstElementChild;
    if (svg) svg.style.transform = `rotate(${-this._view.bearing}deg)`;
  }

  _updateStageLabel() {
    const els = this._els;
    if (!els || !this._formatter) return;
    const label = this._t("street.facing", {
      direction: this._formatter.direction(compass16(this._view.bearing)),
      elevation: this._formatter.num(Math.round(this._view.pitch - 90)),
    });
    if (els.stage.getAttribute("aria-label") !== label) els.stage.setAttribute("aria-label", label);
  }

  _announce(text) {
    if (!text || !this._els) return;
    setText(this._els.announce, "");
    this._later(() => setText(this._els?.announce, text), 50);
  }

  /** setTimeout that dispose() cancels. */
  _later(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }
}

/** Where a phone's back camera looks, from its orientation (W3C: alpha about up, beta about x, gamma about y). */
export function deviceView(alpha, beta, gamma) {
  const D = Math.PI / 180;
  const [a, b, g] = [alpha * D, beta * D, gamma * D];
  // R = Rz(alpha) Rx(beta) Ry(gamma) applied to the camera's direction (0, 0, -1): x east, y north, z up.
  const x = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
  const y = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
  const z = -Math.cos(b) * Math.cos(g);
  return { bearing: wrap360(Math.atan2(x, y) / D), pitch: clamp(90 + Math.asin(clamp(z, -1, 1)) / D, PITCH_MIN, PITCH_MAX) };
}

/** Where a track's visible part begins: {azimuth, elevation}. */
function sampleStart(track) {
  const d = track.data;
  let i = 0;
  while (i < d.n - 1 && d.t[i] + track.offset < track.visibleStart) i++;
  return { azimuth: d.az[i], elevation: d.el[i] };
}

if (globalThis.customElements && !customElements.get("satellite-street-view")) {
  customElements.define("satellite-street-view", SatelliteStreetView);
}

// Used by tests: the pure path helper the element relies on.
export { trackFromRows };
