/**
 * Satellite Spotter's globe: a photo-real Earth with day and night, your
 * location and the satellites that pass over it. It shows one pass at a time
 * (the one going on, else the next, or the one picked): the satellite at its
 * true altitude on its orbit, the part of the pass you can see in gold, a
 * countdown, a sky chart of where to look, and a simulation of the pass that
 * plays on the globe or from your street (sat-street.js). Optionally every
 * satellite in the catalogue at once.
 *
 * Shared by the dashboard card (sat-card.js) and the sidebar panel
 * (sat-panel.js) as <satellite-globe-view>. The integration predicts the
 * passes and computes every position in Python, and sends them over the
 * websocket API (sat-client.js); this file only draws them.
 */

const VERSION = new URL(import.meta.url).search;

// Modules with a top-level await of their own are kept as namespaces and read
// when used (see sat-format.js).
const [maplibreModule, geo, spaceModule, skyModule, i18n, theme, client, clockModule, timebarModule, formatModule, passesModule] =
  await Promise.all([
    import(`./sat-maplibre.js${VERSION}`),
    import(`./sat-geo.js${VERSION}`),
    import(`./sat-space.js${VERSION}`),
    import(`./sat-sky.js${VERSION}`),
    import(`./sat-i18n.js${VERSION}`),
    import(`./sat-theme.js${VERSION}`),
    import(`./sat-client.js${VERSION}`),
    import(`./sat-clock.js${VERSION}`),
    import(`./sat-timebar.js${VERSION}`),
    import(`./sat-format.js${VERSION}`),
    import(`./sat-passes.js${VERSION}`),
  ]);
const {
  bearing, circleRing, closestApproach, compass, displayAltitudeKm, esc, frameDelay, groundDistanceKm, interpolatePositions,
  lookAngles, orbitalSpeed, positionAt, semiMajorAxisKm, subsolarPoint, sunVector, visibilityRadius, wrapLongitude,
} = geo;
const { skyChartSvg, skyDotTransform, skyDotXY, skyPoints, SKY_STYLE } = skyModule;
const { MAPLIBRE_DIR, loadMapLibre, mapLibreAttempts, mapLibreLocale, mapLibreNeedsReload } = maplibreModule;
const { svgIcon, kindIcon } = theme;
export { loadMapLibre, mapLibreNeedsReload };

const DEG = Math.PI / 180;
const EARTH_ROTATION = 7.2921159e-5; // rad/s
const WGS84_A_KM = 6378.137;

// Zoomed out the map is a globe; zooming in morphs it into a flat map.
const GLOBE_PROJECTION = ["interpolate", ["linear"], ["zoom"], 4.5, "vertical-perspective", 6, "mercator"];

const BLUE_MARBLE = {
  type: "raster",
  tiles: [
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
  ],
  tileSize: 256,
  maxzoom: 8,
  attribution:
    'NASA Blue Marble &amp; Black Marble via <a href="https://www.earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a>',
};

/** Close-up imagery; from space the globe is always NASA's Blue Marble. */
export const IMAGERY = {
  satellite: {
    tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg"],
    maxzoom: 15,
    attribution:
      '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2025)',
  },
  esri: {
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    maxzoom: 19,
    attribution: "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
  },
  streets: {
    homeAssistantTiles: "/api/map_tiles/raster/{z}/{x}/{y}.png",
    maxzoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  },
};
// Names used by earlier versions of the card.
const IMAGERY_ALIASES = { sentinel: "satellite", blue_marble: "satellite" };

// How long a lost WebGL context may take to come back before the map is rebuilt.
const CONTEXT_RESTORE_MS = 5000;
// With the satellite out of sight the picture changes slowly (the trail fades,
// the terminator creeps), so it is redrawn this often rather than every frame.
const IDLE_REPAINT_MS = 5000;
// The passes are asked for this often (Home Assistant answers from its cache),
// and so are the positions of every satellite while they are shown.
const REFRESH_MS = 5 * 60 * 1000;
const CLOUD_MS = 5 * 60 * 1000;
// Passes closer than this get the dashed approach line and the fast-forward.
const APPROACH_MAX_S = 36 * 3600;
// The approach line: the last 50 minutes of orbit leading into the pass.
const APPROACH_LINE_S = 50 * 60;
// The latitude (Boston's) at which the camera's framing of a pass was tuned; see _framePass.
const FRAME_LATITUDE = 42.36;
// Following or chasing a satellite, the camera keeps at least this far (in
// Earth radii) beyond it, so it never ends up behind the camera; see _trackZoomLimit.
const TRACK_CLEARANCE = 0.2;
const GLOBE_RADIUS_KM = 6371.0088; // MapLibre's globe
// Chasing a satellite, the camera rides behind it at this pitch.
const CHASE_PITCH = 64;
// When nothing says otherwise: the ISS's period.
const DEFAULT_PERIOD_S = 5574;
const ISS_NORAD_ID = 25544;
// The other satellites of a pass: lines for this many, dots for up to the other number.
const MAX_MEMBER_LINES = 6;
const MAX_MEMBER_DOTS = 60;
// Chips in the pass strip.
const STRIP_MAX = 16;
// The street view's options, kept per browser by the street view itself (sat-street.js).
const STREET_STORAGE = "satellite-spotter:street";

const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * MapLibre light pointing at the real Sun, so the atmosphere glows on the day
 * side. Live updates apply at once; the simulation eases its bigger jumps.
 */
function sunLight(date, transitionMs = 0) {
  const s = subsolarPoint(date);
  const lat = s.lat * DEG;
  const lon = s.lon * DEG;
  // A map-anchored light is expressed in a globe frame turned half a turn
  // about the poles from the one tiles are drawn in (found by rendering the
  // four candidate axis conventions over known day and night views).
  const v = [-Math.sin(lon) * Math.cos(lat), Math.sin(lat), -Math.cos(lon) * Math.cos(lat)];
  const polar = Math.acos(Math.max(-1, Math.min(1, v[2]))) / DEG;
  const az = (((Math.atan2(v[1], v[0]) / DEG - 90) % 360) + 360) % 360;
  return {
    anchor: "map",
    position: [1.5, az, polar],
    intensity: 0.5,
    "position-transition": { duration: transitionMs, delay: 0 },
  };
}

function prefersReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Set text only when it changed (cheaper, and keeps screen readers calm). */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function setHtml(el, html) {
  if (el && el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

/** The satellite a pass is named after (the first of its transits). */
const leader = (pass) => pass?.transits?.[0] ?? null;

/** Rows within [from, to] (unix s), the part of a pass that can be seen. */
function rowsBetween(rows, from, to) {
  return (rows || []).filter((r) => r[0] >= from - 1 && r[0] <= to + 1);
}

/**
 * One satellite's rows of a pass_track payload: its own, or, for a train
 * member sent without them, the leader's moved later by its offset.
 */
export function transitRows(detail, index) {
  const t = detail?.transits?.[index];
  if (!t) return null;
  if (t.rows) return t.rows;
  const lead = detail.transits[0]?.rows;
  const offset = t.offset_s || 0;
  return lead ? lead.map((r) => [r[0] + offset, ...r.slice(1)]) : null;
}

/**
 * Where one satellite of a pass_track payload is at t (as positionAt() on
 * transitRows()), for every frame: a train member sent without rows is where
 * the leader was offset_s earlier, without a copy of the leader's rows.
 */
export function transitPositionAt(detail, index, t) {
  const tr = detail?.transits?.[index];
  if (!tr) return null;
  if (tr.rows) return positionAt(tr.rows, t);
  const pos = positionAt(detail.transits[0]?.rows, t - (tr.offset_s || 0));
  if (pos) pos.t = t;
  return pos;
}

/**
 * Tracks of one satellite merged in time order, finer ones winning where
 * they overlap: the orbit at 30 s, the pass itself at 2 s.
 */
export function mergeRows(...tracks) {
  const parts = tracks.filter((t) => t?.length > 1);
  if (!parts.length) return [];
  if (parts.length === 1) return parts[0];
  // Finest last: it replaces the coarser rows over its own span.
  parts.sort((a, b) => (b[1][0] - b[0][0]) - (a[1][0] - a[0][0]));
  let merged = parts[0];
  for (const fine of parts.slice(1)) {
    const lo = fine[0][0];
    const hi = fine[fine.length - 1][0];
    merged = [...merged.filter((r) => r[0] < lo || r[0] > hi), ...fine].sort((a, b) => a[0] - b[0]);
  }
  return merged;
}

/** Whether rows cover [from, to] without a gap longer than `gap` seconds. */
export function rowsCover(rows, from, to, gap = 300) {
  if (!rows?.length || rows[0][0] > from + gap || rows[rows.length - 1][0] < to - gap) return false;
  for (let i = 1; i < rows.length; i++) if (rows[i][0] - rows[i - 1][0] > gap) return false;
  return true;
}

function ecef(lat, lon, altKm) {
  const r = WGS84_A_KM + altKm;
  return [r * Math.cos(lat * DEG) * Math.cos(lon * DEG), r * Math.cos(lat * DEG) * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
}

/**
 * Orbital speed in km/s from track rows around t: the Earth-fixed velocity
 * between the samples either side, plus the Earth's rotation under it (the
 * rows are Earth-fixed; an orbit's speed is not). Null without two samples.
 */
export function speedFromRows(rows, t) {
  if (!rows || rows.length < 2) return null;
  // The samples either side of t (the first or last two outside the rows).
  const after = rows.findIndex((r) => r[0] > t);
  const i = after < 0 ? rows.length - 1 : Math.max(1, after);
  const a = rows[i - 1];
  const b = rows[i];
  const dt = b[0] - a[0];
  if (!(dt > 0) || dt > 120) return null;
  const pa = ecef(a[1], a[2], a[3]);
  const pb = ecef(b[1], b[2], b[3]);
  const v = [(pb[0] - pa[0]) / dt, (pb[1] - pa[1]) / dt, (pb[2] - pa[2]) / dt];
  // ω × r, with r halfway between the samples.
  const m = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
  return Math.hypot(v[0] - EARTH_ROTATION * m[1], v[1] + EARTH_ROTATION * m[0], v[2]);
}

/** Minutes between clock ticks along an orbit: about six per period, on round numbers. */
export function tickStepMinutes(periodS) {
  const target = (periodS || DEFAULT_PERIOD_S) / 60 / 6;
  const steps = [5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720];
  return steps.find((s) => s >= target * 0.8) ?? 720;
}

/**
 * The simulation of a pass: the visible part with a lead-in and a tail, and,
 * unless motion is reduced, a fast-forward from now when the pass is less
 * than 36 h away (sat-clock.js simulate()).
 */
export function simulationWindow(pass, nowS, { reduced = false } = {}) {
  const fromS = pass.start - clockModule.PASS_LEAD_S;
  const toS = pass.end + clockModule.PASS_TAIL_S;
  const away = pass.start - nowS;
  const approachFromS = !reduced && fromS - nowS > 180 && away < APPROACH_MAX_S ? nowS : null;
  return {
    fromS,
    toS,
    visibleStartS: pass.start,
    visibleEndS: pass.end,
    approachFromS,
    periodS: leader(pass)?.period_s || DEFAULT_PERIOD_S,
  };
}

// ---------------------------------------------------------------------------

const STYLE = `
:host { display: block; position: relative; width: 100%; height: 100%; min-height: 240px;
  --safe-t: 0px; --safe-l: var(--sat-safe-left, 0px); --safe-r: var(--sat-safe-right, 0px); --safe-b: var(--sat-safe-bottom, 0px); }
.wrap { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; color: var(--sat-ink); --side-w: 0px;
  background: radial-gradient(ellipse at 50% 42%, #0b1a3a 0%, #040814 58%, #000 100%); }
/* Fullscreen covers the whole screen, notch and status bar included (iPhones
   get MapLibre's pseudo-fullscreen, a fixed overlay). :is() keeps the rule if
   a browser does not know one of the selectors. */
.wrap:is(.maplibregl-pseudo-fullscreen, :fullscreen) { border-radius: 0;
  --safe-t: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));
  --safe-l: var(--safe-area-inset-left, env(safe-area-inset-left, 0px));
  --safe-r: var(--safe-area-inset-right, env(safe-area-inset-right, 0px));
  --safe-b: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)); }
.wrap::before { content: ""; position: absolute; inset: 0; pointer-events: none; background-image: var(--sat-stars); opacity: .8; }
#map { position: absolute; inset: 0; }
.maplibregl-canvas { outline: none; }
.maplibregl-canvas:focus-visible { outline: 2px solid var(--sat-sky); outline-offset: -2px; }
.labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
.flabel { position: absolute; left: 0; top: 0; white-space: nowrap; will-change: transform; }
.flabel.tick { font-size: 10.5px; font-weight: 600; color: #e0f2fe; text-shadow: 0 0 4px #000, 0 0 8px #000; }
.flabel.pin { font: inherit; font-size: 11.5px; font-weight: 650; color: #1c1404; background: linear-gradient(180deg, #fde68a, #f59e0b);
  padding: 4px 10px; border: 0; border-radius: 999px; box-shadow: 0 4px 16px rgba(245,158,11,.45), 0 0 0 1px rgba(0,0,0,.25);
  pointer-events: auto; cursor: pointer; transition: opacity .3s; }
.flabel.pin.dim { color: #0f172a; background: linear-gradient(180deg, #e2e8f0, #94a3b8); box-shadow: 0 4px 14px rgba(148,163,184,.35); }
.flabel.pin::after { content: ""; position: absolute; left: 50%; bottom: -5px; margin-left: -5px; border: 5px solid transparent; border-bottom: 0; border-top-color: #f59e0b; }
.flabel.pin.dim::after { border-top-color: #94a3b8; }
.flabel.pin.away { opacity: 0; pointer-events: none; }
.flabel.pin:focus-visible { outline: 2px solid var(--sat-sky); outline-offset: 3px; }
.tip { position: absolute; left: 0; top: 0; z-index: 3; pointer-events: none; max-width: 240px; padding: 8px 11px 9px; font-size: 12px;
  line-height: 1.4; color: var(--sat-ink-2); border-radius: 12px; background: rgba(11,18,34,.92); border: 1px solid var(--sat-edge);
  box-shadow: 0 8px 22px rgba(0,0,0,.45); }
.tip b { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--sat-ink); font-weight: 650; }
.tip b svg { width: 15px; height: 15px; fill: currentColor; flex: none; }
.tip .now { color: var(--sat-gold); font-weight: 600; }
.tip .hint { display: block; margin-top: 3px; font-size: 11px; color: var(--sat-ink-3); }
.hud { position: absolute; z-index: 2; color: var(--sat-ink); }
.stack { top: calc(12px + var(--safe-t)); left: calc(12px + var(--safe-l)); display: flex; flex-direction: column; gap: 8px;
  width: min(406px, calc(100% - 64px - var(--safe-l) - var(--safe-r))); pointer-events: none; }
.stack > * { pointer-events: auto; }
.mission { padding: 13px 16px 14px; box-sizing: border-box; }
.mission .top { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--sat-sky); }
.mission .top .live { --ping: 34,197,94; width: 7px; height: 7px; border-radius: 50%; background: var(--sat-live); box-shadow: 0 0 0 0 rgba(var(--ping),.6); }
.mission.now .top { color: var(--sat-gold); }
.mission.now .top .live { --ping: 252,211,77; background: var(--sat-gold); }
.mission.sim .top { color: var(--sat-preview); }
.mission.sim .top .live { --ping: 240,171,252; background: var(--sat-preview); }
.mission.paused .top, .mission.empty .top { color: var(--sat-ink-3); }
.mission.paused .top .live, .mission.empty .top .live { background: var(--sat-ink-3); }
.mission .chip { margin-left: auto; }
.mission .chip.mag { color: var(--sat-ink-2); }
.mission .title { display: flex; align-items: center; gap: 7px; min-width: 0; margin-top: 7px; font-size: 15px; font-weight: 650; line-height: 1.25; }
.mission .title .kind { display: grid; place-items: center; width: 22px; height: 22px; flex: none; border-radius: 50%; background: rgba(148,163,184,.14); color: var(--sat-kind-satellite); }
.mission .title .kind svg { width: 15px; height: 15px; fill: currentColor; }
.mission .title .kind.station { color: var(--sat-kind-station); }
.mission .title .kind.telescope { color: #c4b5fd; }
.mission .title .kind.train { color: var(--sat-kind-starlink); }
.mission .title .kind.rocket { color: var(--sat-kind-rocket); }
.mission .title .kind.debris { color: var(--sat-kind-debris); }
.mission .title .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mission .about { display: grid; place-items: center; width: 22px; height: 22px; flex: none; border-radius: 50%; color: var(--sat-ink-3); }
.mission .about:hover { color: var(--sat-sky); background: rgba(125,211,252,.12); }
.mission .about svg { width: 16px; height: 16px; fill: currentColor; }
.mission .clock { font-size: 36px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.1; margin-top: 4px; }
.mission.now .clock { font-size: 26px; color: var(--sat-gold); }
.mission.sim.now .clock { color: #fde68a; }
.mission.paused .clock, .mission.empty .clock { font-size: 24px; color: var(--sat-ink-2); }
.mission .when { font-size: 13.5px; color: #e2e8f0; margin-top: 3px; }
.mission .detail { font-size: 12.5px; color: var(--sat-ink-2); margin-top: 3px; text-wrap: pretty; }
.mission .detail:empty { display: none; }
.mission .conds { display: flex; flex-wrap: wrap; gap: 5px 14px; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(148,163,184,.18); font-size: 12px; color: var(--sat-ink-2); }
.mission .conds:empty { display: none; }
.conds .c { display: inline-flex; align-items: center; gap: 5px; }
.conds .c svg { width: 14px; height: 14px; fill: currentColor; flex: none; }
.conds .clear { color: var(--sat-cloud-clear); } .conds .partly { color: var(--sat-cloud-partly); } .conds .cloudy { color: var(--sat-cloud-cloudy); }
.conds .warn { color: var(--sat-warn); } .conds .gold { color: var(--sat-gold); } .conds .dim { color: var(--sat-ink-3); }
.conds .moon { color: #e2e8f0; }
.conds .error { min-width: 0; align-items: flex-start; }
.conds .error > span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.mission .why { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(148,163,184,.18); font-size: 12px; line-height: 1.5; color: var(--sat-ink-3); }
.mission .why summary { cursor: pointer; color: var(--sat-sky); font-weight: 600; list-style: none; display: inline-flex; align-items: center; gap: 4px; }
.mission .why summary::-webkit-details-marker { display: none; }
.mission .why summary svg { width: 16px; height: 16px; fill: currentColor; transition: transform .2s; }
.mission .why[open] summary svg { transform: rotate(180deg); }
.mission .why p { margin: 6px 0 0; }
.mission .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.mission .actions:not(:has(> :not([hidden]))) { display: none; }
.btn .short { display: none; }
:host([compact]) .btn .long { display: none; }
:host([compact]) .btn .short { display: inline; }
.strip { display: flex; gap: 6px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; padding: 1px 1px 3px;
  scroll-snap-type: x proximity; -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent);
  mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent); }
.strip::-webkit-scrollbar { display: none; }
.pchip { flex: none; display: grid; gap: 2px; align-content: center; min-width: 74px; max-width: 150px; box-sizing: border-box; text-align: left;
  font: inherit; color: var(--sat-ink); background: var(--sat-glass); border: 1px solid var(--sat-edge); border-radius: 12px;
  padding: 6px 10px 7px; cursor: pointer; scroll-snap-align: start; -webkit-tap-highlight-color: transparent;
  backdrop-filter: blur(10px) saturate(1.2); -webkit-backdrop-filter: blur(10px) saturate(1.2); transition: border-color .15s, background .15s; }
.pchip:hover { border-color: rgba(125,211,252,.55); }
.pchip .t { display: flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 650; line-height: 1.2; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pchip .t small { font-size: 10.5px; font-weight: 600; color: var(--sat-ink-3); }
.pchip .t svg { width: 12px; height: 12px; fill: var(--sat-gold); filter: drop-shadow(0 0 3px rgba(252,211,77,.6)); }
.pchip .n { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 11px; line-height: 1.2; color: var(--sat-ink-2); }
.pchip .n span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pchip .n svg { width: 12px; height: 12px; flex: none; fill: currentColor; opacity: .8; }
.pchip[aria-pressed="true"] { border-color: rgba(125,211,252,.85); background: linear-gradient(160deg, rgba(14,52,84,.92), rgba(15,23,42,.8)); }
.pchip.live { border-color: rgba(252,211,77,.75); }
.pchip.live .t { color: var(--sat-gold); }
.pchip.all { display: grid; place-items: center; min-width: 0; width: 42px; padding: 0; color: var(--sat-sky); }
.pchip.all svg { width: 20px; height: 20px; fill: currentColor; }
.pchip:focus-visible { outline: 2px solid var(--sat-sky); outline-offset: 1px; }
.side { top: calc(12px + var(--safe-t)); right: calc(56px + var(--safe-r)); width: 316px; max-height: calc(100% - 92px - var(--safe-t) - var(--safe-b));
  display: flex; flex-direction: column; gap: 10px; }
.side .sky { padding: 12px 14px; flex: none; }
.side .passes { flex: 1 1 auto; min-height: 140px; display: flex; flex-direction: column; overflow: hidden; padding: 10px 0 0; }
.side .passes > h3 { padding: 0 14px 6px; }
.plist { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.hud h3 { margin: 0; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--sat-sky); font-weight: 600; }
.sky { display: grid; justify-items: center; }
.sky .sub { font-size: 12px; color: var(--sat-ink-2); margin: 3px 0 6px; }
.sky .caption { font-size: 11.5px; color: var(--sat-ink-2); margin-top: 6px; line-height: 1.45; text-align: center; max-width: 280px; }
.sky .street-link { margin-top: 8px; }
.sky-pop { top: calc(12px + var(--safe-t)); right: calc(56px + var(--safe-r)); z-index: 3; padding: 10px 14px 14px; box-sizing: border-box;
  width: min(268px, calc(100% - 24px - var(--safe-l) - var(--safe-r))); }
.pop-head, .sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; box-sizing: border-box; }
.sheet { left: calc(8px + var(--safe-l)); right: calc(8px + var(--safe-r)); bottom: calc(8px + var(--safe-b)); z-index: 3;
  max-height: min(72%, 600px); display: flex; flex-direction: column; overflow: hidden; background: var(--sat-glass-solid); }
.sheet-head { padding: 10px 10px 6px 16px; flex: none; }
.sheet-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.telemetry { left: calc(12px + var(--safe-l)); bottom: calc(34px + var(--safe-b)); padding: 7px 14px; font-size: 12px; color: var(--sat-ink-2);
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; max-width: calc(100% - 150px - var(--safe-l) - var(--safe-r)); box-sizing: border-box; }
.telemetry b { color: var(--sat-ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.telemetry .who { display: inline-flex; align-items: center; gap: 6px; color: var(--sat-ink); font-weight: 650; }
.telemetry .who svg { width: 15px; height: 15px; fill: var(--sat-gold); }
.telemetry .lit { color: var(--sat-lit); } .telemetry .dark { color: var(--sat-shadow); }
.timebar-host { left: calc((100% - var(--side-w)) / 2); bottom: calc(34px + var(--safe-b)); transform: translateX(-50%);
  width: min(680px, calc(100% - var(--side-w) - 24px - var(--safe-l) - var(--safe-r))); }
.loader { inset: 0; display: grid; place-items: center; text-align: center; color: var(--sat-ink-2); font-size: 13.5px; pointer-events: none; padding: 0 24px; }
.loader .msg { max-width: 420px; line-height: 1.5; }
.loader .orbit { width: 64px; height: 64px; margin: 0 auto 14px; border-radius: 50%; border: 1px solid rgba(125,211,252,.35); position: relative;
  background: radial-gradient(circle at 40% 35%, #1d4ed8, #0b1a3a 70%); box-shadow: 0 0 24px rgba(56,189,248,.35); }
.loader .orbit::after { content: ""; position: absolute; top: -4px; left: 50%; width: 8px; height: 8px; margin-left: -4px; border-radius: 50%;
  background: #fde68a; box-shadow: 0 0 10px #fde68a; transform-origin: 4px 36px; }
.loader .reload-btn { pointer-events: auto; margin-top: 12px; }
/* box-shadow cannot be animated on the compositor, so pulse only briefly,
   and continuously only while a pass is on or a simulation plays. */
@media (prefers-reduced-motion: no-preference) {
  .mission .top .live { animation: sat-ping 2s ease-out 3; }
  .mission.now .top .live, .mission.sim .top .live { animation: sat-ping 2s ease-out infinite; }
  .pchip.live { animation: sat-glow 2.4s ease-in-out infinite; }
  .loader .orbit::after { animation: sat-spin 2.2s linear infinite; }
  .sheet:not([hidden]), .sky-pop:not([hidden]) { animation: sat-rise .2s ease-out; }
}
.home { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
  background: var(--primary-color, #03a9f4); border: 2px solid #fff; box-shadow: 0 0 0 5px rgba(3,169,244,.22), 0 2px 8px rgba(0,0,0,.55); }
.home svg { width: 15px; height: 15px; fill: #fff; }
.maplibregl-marker-covered { pointer-events: none; }
/* Above the HUD, so the imagery menu that opens beside the buttons is not covered. */
.maplibregl-ctrl-top-right { margin: var(--safe-t) var(--safe-r) 0 0; z-index: 3; }
.maplibregl-ctrl-bottom-right { margin: 0 var(--safe-r) var(--safe-b) 0; }
.maplibregl-ctrl-bottom-left { margin: 0 0 var(--safe-b) var(--safe-l); }
.maplibregl-ctrl-group { background: rgba(15,23,42,.78) !important; border: 1px solid var(--sat-edge); box-shadow: 0 6px 18px rgba(0,0,0,.35) !important;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: 10px !important; overflow: hidden; }
.maplibregl-ctrl-group button + button { border-top: 1px solid rgba(148,163,184,.18) !important; }
.maplibregl-ctrl-group button:not([aria-pressed="true"]):hover { background-color: rgba(56,189,248,.18) !important; }
.maplibregl-ctrl button .maplibregl-ctrl-icon { filter: invert(1) brightness(1.4); }
/* The view controls hold the imagery menu, so they round their buttons instead of clipping. */
.maplibregl-ctrl-group.ctrl { overflow: visible; }
.ctrl button { width: 29px; height: 29px; display: grid; place-items: center; }
.ctrl button:first-of-type { border-radius: 9px 9px 0 0; }
.ctrl button:last-of-type { border-radius: 0 0 9px 9px; }
.ctrl button svg { width: 18px; height: 18px; fill: #e2e8f0; }
.ctrl button[aria-pressed="true"] { background-color: var(--sat-sky) !important; }
.ctrl button[aria-pressed="true"] svg { fill: #0f172a; }
.ctrl select { position: absolute; right: 34px; top: 0; font: inherit; font-size: 12px; padding: 5px; border-radius: 8px; background: #0f172a; color: var(--sat-ink); border: 1px solid var(--sat-edge); box-shadow: 0 6px 18px rgba(0,0,0,.45); }
/* Too short for the whole column: drop the fullscreen button rather than cover it. */
:host([short]) .maplibregl-ctrl-group:has(> .maplibregl-ctrl-fullscreen) { display: none; }
.maplibregl-ctrl-attrib { background: rgba(15,23,42,.62) !important; color: var(--sat-ink-2) !important; }
.maplibregl-ctrl-attrib a { color: #e2e8f0 !important; }
.maplibregl-ctrl-attrib-button { filter: invert(1); }
:host([compact]) .mission { padding: 10px 12px; }
:host([compact]) .stack { width: min(346px, calc(100% - 64px - var(--safe-l) - var(--safe-r))); }
:host([compact]) .mission .title { margin-top: 5px; font-size: 14px; }
:host([compact]) .mission .clock { font-size: 26px; }
:host([compact]) .mission.now .clock, :host([compact]) .mission.paused .clock, :host([compact]) .mission.empty .clock { font-size: 20px; }
:host([compact]) .mission .detail, :host([compact]) .mission .why { display: none; }
:host([compact]) .mission .conds { font-size: 11.5px; margin-top: 8px; padding-top: 8px; }
:host([compact]) .mission .actions { margin-top: 8px; }
:host([compact]) .btn { padding: 4px 10px 4px 8px; font-size: 12px; }
:host([compact]) .side { display: none; }
:host([compact]) .telemetry { font-size: 11px; padding: 6px 10px; gap: 2px 10px; max-width: calc(100% - 70px - var(--safe-l) - var(--safe-r)); }
:host([compact]) .telemetry .opt { display: none; }
/* Touch screens with room for it: bigger map buttons. */
:host([roomy]) .maplibregl-ctrl-group button, :host([roomy]) .ctrl button { width: 40px; height: 40px; }
:host([roomy]) .ctrl select { right: 45px; }
:host([roomy]) .side, :host([roomy]) .sky-pop { right: calc(68px + var(--safe-r)); }
:host([roomy]) .stack { width: min(406px, calc(100% - 76px - var(--safe-l) - var(--safe-r))); }
:host([roomy][compact]) .stack { width: min(346px, calc(100% - 76px - var(--safe-l) - var(--safe-r))); }
@media (max-width: 760px) { .mission .clock { font-size: 28px; } .telemetry .opt { display: none; } }
satellite-street-view { position: absolute; inset: 0; z-index: 4; }
`;

const BaseElement = globalThis.HTMLElement ?? class {};

export class SatelliteGlobeView extends BaseElement {
  static get observedAttributes() {
    return ["compact"];
  }

  constructor() {
    super();
    this._config = {};
    this._mode = "free";
    this._flat = false;
    this._timers = [];
    this._labels = new Map();
    // What each sky chart element shows, so an unchanged chart is not drawn again.
    this._skyCharts = new WeakMap();
    // English until Home Assistant's language has loaded (see _useLanguage).
    this._strings = i18n.english;
    this._language = "en";
    this._languageReady = Promise.resolve();
    this._fmt = new formatModule.Formatter(null, i18n.english);
    this._clockOffset = 0;
    this._gen = 0;
    // Home Assistant tiles to fetch again, by source: Map of "z/x/y" -> {x, y, z}.
    this._failedTiles = {};
    // Set by the card while Home Assistant shows it in an editor preview.
    this.editorPreview = false;
    // Set by the card: use the compact layout whenever the globe is narrow
    // (decided here, from the globe's own size, so fullscreen gets the full one).
    this.autoCompact = false;
    this._client = new client.SatClient(() => this._hass);
    // The shared clock: live, or replaying a pass (the time bar and the street view follow it too).
    this._clock = new clockModule.PassClock({ now: () => this._now() });
    this._clock.on("change", (ev) => this._onClockChange(ev));
    // The pass on show, by id; picked by the user, or else the live or next one.
    this._selectedId = null;
    this._userSelected = false;
    // The pass list's filters ("Bright only", "Hide Starlink"), which the strip
    // and the pass picked by itself follow too.
    this._filters = passesModule.normalizeFilters();
    // pass_track payloads by pass id, and the approach line's rows by pass id.
    this._details = new Map();
    this._approaches = new Map();
    // A satellite picked in the cloud, shown instead of the pass's leader.
    this._focus = null;
    this._focusTrack = null;
    this._sim = null;
    this._simRows = null;
    this._showCloud = null;
    this._onVisibility = () => (document.hidden ? this._pause() : this._resume());
    // Work put off while the globe cannot be seen, by kind (see _whenShown).
    this._pendingShown = new Map();
    this._onReady = () =>
      this._whenShown("ready", () => {
        // Home Assistant is back after a restart or a dropped connection.
        this._staleDelay = this._staleRetryAt = 0;
        if (!this._map) {
          if (this.isConnected) this._start();
          return;
        }
        this._refreshMapToken(true);
        this._refresh();
      });
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    this._useLanguage(hass);
    // Home Assistant replaces the locale object only when a setting changes.
    const localeChanged =
      !!old && (hass?.locale !== old.locale || hass?.config?.time_zone !== old.config?.time_zone);
    this._fmt.update(hass, this._strings);
    if (this._street) this._street.hass = hass;
    if (this.isConnected) this._watchConnection();
    if (!old) {
      if (this.isConnected) this._start();
    } else if (localeChanged && this._loaded && this._payload) {
      this._clearTicks();
      this._stripKey = null;
      this._buildCourse();
      this._renderList();
      this._renderStrip();
      this._renderSky(true);
      this._timebar?.refresh();
      this._tick();
    }
  }

  get hass() {
    return this._hass;
  }

  set config(config) {
    const previous = this._config;
    this._config = { ...config };
    const moved = previous.entry_id !== config.entry_id;
    if (moved) this._locationChanged();
    // The filters the panel remembers; a config without them leaves the list's as they are.
    if (config.filters !== undefined) this._setFilters(config.filters, { emit: false });
    if (previous.street_view !== config.street_view && this._timebar) this._makeTimebar();
    if (!this._map) {
      // Waiting to retry (or not started): try the new location straight away.
      if (moved && this._hass && this.isConnected) this._start();
      return;
    }
    // The camera flies to the new home when its data arrives (see _refresh).
    if (moved) this._refresh(true);
    if (previous.imagery !== config.imagery) this._setImagery(config.imagery);
    if (previous.show_satellites !== config.show_satellites) {
      this._showCloud = null;
      this._syncControls();
      this._loadCloud();
    }
    this._applyLayout();
    this._renderList();
    this._renderStrip();
    this._tick();
  }

  attributeChangedCallback() {
    // A card toggles "compact" from its own size; lay out again a frame later.
    if (this._layoutFrame || !this._els) return;
    this._layoutFrame = requestAnimationFrame(() => {
      this._layoutFrame = null;
      this._applyLayout();
    });
  }

  connectedCallback() {
    clearTimeout(this._teardownTimer);
    document.addEventListener("visibilitychange", this._onVisibility);
    if (this._hass) {
      this._watchConnection();
      this._start();
    }
    this._observeVisibility();
    this._resume();
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._unwatchConnection();
    this._pause();
    this._intersection?.disconnect();
    clearTimeout(this._retryTimer);
    clearTimeout(this._refreshTimer);
    clearTimeout(this._teardownTimer);
    clearTimeout(this._cloudTimer);
    // Coming back starts, or refreshes, whatever is needed then.
    this._pendingShown.clear();
    // Free the WebGL context if the view stays away (dashboards rebuild cards).
    // The card editor replaces its preview on every change and drops the old
    // card: let that go now. Masonry views in edit mode put their cards back
    // over several frames, so other previews get a moment rather than 30 s.
    const dropped = this.getRootNode?.().host?.parentNode === null;
    this._teardownTimer = setTimeout(
      () => !this.isConnected && this._teardown(),
      this.editorPreview ? (dropped ? 0 : 2000) : 30000
    );
  }

  // -- public -------------------------------------------------------------

  /**
   * Show a pass, and optionally simulate it or open it in the street view
   * (view "simulate" or "street"). Before the data is in, it waits for it; an
   * id from older predictions finds the pass it became.
   */
  selectPass(id, { view = null } = {}) {
    if (!id) return;
    this._pendingSelect = { id: String(id), view: view === "simulate" || view === "street" ? view : null };
    this._applyPendingSelect();
  }

  // -- lifecycle ----------------------------------------------------------

  _buildDom() {
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <link rel="stylesheet" href="${new URL("maplibre-gl.css", MAPLIBRE_DIR).href}">
      <style>${theme.TOKENS_CSS}${theme.UTIL_CSS}${theme.GLASS_CSS}${theme.BUTTON_CSS}${theme.CHIP_CSS}${theme.FOCUS_CSS}${theme.MOTION_CSS}${STYLE}${SKY_STYLE}</style>
      <div class="wrap" part="globe">
        <div id="map"></div>
        <div class="labels"></div>
        <div class="tip" hidden></div>
        <div class="hud stack">
          <section class="mission glass" hidden data-t-label="globe.name">
            <div class="top"><span class="live"></span><span class="label"></span><span class="chip" hidden></span></div>
            <div class="title" hidden><span class="kind"></span><span class="name"></span>
              <a class="about" target="_blank" rel="noopener" hidden data-t-title="mission.about">${svgIcon("info")}</a></div>
            <div class="clock"></div>
            <div class="when"></div>
            <div class="detail"></div>
            <div class="conds"></div>
            <details class="why" hidden><summary><span data-t="passes.why_not"></span>${svgIcon("chevron_down")}</summary>
              <p data-t="passes.why_not_text"></p><p class="check"></p></details>
            <div class="actions">
              <button class="btn pink sim-btn" type="button" data-t-title="mission.simulate_hint">${svgIcon("play")}<span class="long" data-t="mission.simulate"></span><span class="short" data-t="mission.simulate_short"></span></button>
              <button class="btn street-btn" type="button" data-t-title="mission.street_hint">${svgIcon("street")}<span class="long" data-t="mission.street"></span><span class="short" data-t="mission.street_short"></span></button>
              <button class="btn quiet look-btn" type="button" data-t-title="mission.look_hint" aria-expanded="false">${svgIcon("eye")}<span class="long" data-t="mission.look"></span><span class="short" data-t="mission.look_short"></span></button>
            </div>
            <div class="sr-only announce" aria-live="polite"></div>
          </section>
          <div class="strip" hidden role="group" data-t-label="pass.strip"></div>
        </div>
        <aside class="hud side" hidden>
          <div class="glass sky"><h3 data-t="mission.look"></h3><div class="sub"></div><div class="chart"></div><div class="caption"></div></div>
          <section class="glass passes" hidden><h3 data-t="pass.list"></h3></section>
        </aside>
        <div class="hud glass sky sky-pop" hidden role="dialog" data-t-label="mission.look">
          <div class="pop-head"><h3 data-t="mission.look"></h3>
            <button class="ibtn close" type="button" data-t-label="globe.close" data-t-title="globe.close">${svgIcon("close")}</button></div>
          <div class="sub"></div><div class="chart"></div><div class="caption"></div></div>
        <section class="hud glass sheet" hidden role="dialog" data-t-label="pass.all">
          <div class="sheet-head"><h3 data-t="pass.all"></h3>
            <button class="ibtn close" type="button" data-t-label="globe.close" data-t-title="globe.close">${svgIcon("close")}</button></div>
          <div class="sheet-body"><div class="plist"></div></div>
        </section>
        <div class="hud glass telemetry" hidden></div>
        <div class="hud timebar-host" hidden></div>
        <div class="hud loader"><div><div class="orbit"></div><div class="msg"></div>
          <button class="btn reload-btn" type="button" hidden data-t="globe.reload"></button></div></div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    this._wrap = $(".wrap");
    this._wrap.style.setProperty("--sat-stars", theme.starField());
    this._els = {
      map: $("#map"),
      labels: $(".labels"),
      tip: $(".tip"),
      stack: $(".stack"),
      mission: $(".mission"),
      label: $(".mission .label"),
      chip: $(".mission .chip"),
      title: $(".mission .title"),
      kind: $(".mission .title .kind"),
      name: $(".mission .title .name"),
      about: $(".mission .about"),
      clock: $(".mission .clock"),
      when: $(".mission .when"),
      detail: $(".mission .detail"),
      conds: $(".mission .conds"),
      why: $(".mission .why"),
      whyCheck: $(".mission .why .check"),
      announce: $(".mission .announce"),
      simBtn: $(".sim-btn"),
      streetBtn: $(".street-btn"),
      lookBtn: $(".look-btn"),
      strip: $(".strip"),
      side: $(".side"),
      skySide: $(".side .sky"),
      passesBox: $(".side .passes"),
      skyPop: $(".sky-pop"),
      sheet: $(".sheet"),
      sheetBody: $(".sheet-body"),
      plist: $(".plist"),
      telemetry: $(".telemetry"),
      timebarHost: $(".timebar-host"),
      loader: $(".loader"),
      loaderMsg: $(".loader .msg"),
      reloadBtn: $(".loader .reload-btn"),
    };
    this._els.loaderMsg.textContent = this._t("globe.acquiring");
    this._applyStrings();
    this._makeTimebar();
    const e = this._els;
    e.reloadBtn.addEventListener("click", () => location.reload());
    e.simBtn.addEventListener("click", () => {
      const pass = this._selectedPass();
      if (pass) this._select(pass.id, { view: "simulate", frame: false });
    });
    e.streetBtn.addEventListener("click", () => {
      const pass = this._shownPass();
      if (pass) this._openStreet(pass, { user: true });
    });
    e.lookBtn.addEventListener("click", () => {
      this._skyOpen = !this._skyOpen;
      this._renderSky(true);
      if (this._skyOpen) e.skyPop.querySelector(".close")?.focus({ preventScroll: true });
    });
    e.skyPop.querySelector(".close").addEventListener("click", () => this._closeSkyPop(true));
    e.sheet.querySelector(".close").addEventListener("click", () => this._closeSheet(true));
    e.strip.addEventListener("click", (ev) => {
      const chip = ev.target.closest?.(".pchip");
      if (!chip) return;
      if (chip.classList.contains("all")) this._openSheet();
      else this._select(chip.dataset.id, { frame: true });
    });
    e.strip.addEventListener("keydown", (ev) => this._onStripKey(ev));
    // A tap anywhere else puts the imagery menu away.
    this._wrap.addEventListener(
      "pointerdown",
      (ev) => {
        const path = ev.composedPath();
        if (this._menu && !path.includes(this._menu) && !path.includes(this._buttons?.layers)) this._toggleImageryMenu();
      },
      true
    );
    this._wrap.addEventListener("keydown", (ev) => this._onKey(ev));
  }

  /**
   * Escape closes, in turn: the imagery menu, the street view (or stops it
   * opening, while it loads), the simulation, the list of passes, the sky chart.
   */
  _onKey(ev) {
    if (ev.key !== "Escape" || ev.defaultPrevented) return;
    if (this._menu) this._toggleImageryMenu();
    else if (this._street || this._streetPending) this._closeStreet({ user: true });
    else if (this._clock.mode === "sim") this._stopSimulation({ user: true });
    else if (this._sheetOpen) this._closeSheet(true);
    else if (this._skyOpen && this._els?.skyPop && !this._els.skyPop.hidden) this._closeSkyPop(true);
    else return;
    ev.preventDefault();
    // A card shown inside a Home Assistant dialog must not close it too.
    ev.stopPropagation();
  }

  /** The time bar under a simulation (recreated when the street view option changes). */
  _makeTimebar() {
    this._timebar?.destroy();
    this._timebar = null;
    if (!this._els?.timebarHost) return;
    this._timebar = new timebarModule.Timebar(this._els.timebarHost, {
      clock: this._clock,
      formatter: this._fmt,
      onLive: () => this._stopSimulation({ user: true }),
      onToggleView: this._config.street_view === false ? undefined : () => this._openStreet(this._shownPass(), { user: true }),
    });
    const pass = this._shownPass();
    if (pass) this._timebar.setContext({ pass, label: this._fmt.passTitle(pass), view: "globe" });
  }

  /**
   * Switch to Home Assistant's language, downloading its text the first time;
   * what is on screen is reworded once it is in. If the download fails, the
   * text stays English and the language is tried again after a minute.
   */
  _useLanguage(hass) {
    const language = i18n.resolveLanguage(hass?.language || hass?.locale?.language);
    const retry = this._strings.language !== language && !(performance.now() - this._languageAt < 60000);
    if (language === this._language && !retry) return this._languageReady;
    this._language = language;
    this._languageAt = performance.now();
    this._languageReady = i18n
      .loadStrings(language)
      .then((strings) => {
        if (this._language !== language || strings === this._strings) return;
        this._strings = strings;
        this._fmt.update(this._hass, strings);
        this._applyStrings();
      })
      // Never rejects: starting the globe waits on it.
      .catch((err) => console.error("Satellite Spotter: could not apply the language:", err));
    return this._languageReady;
  }

  /** Put the text into the page in the current language, and redraw what shows it. */
  _applyStrings() {
    const root = this.shadowRoot;
    if (!this._els || !root) return;
    for (const el of root.querySelectorAll("[data-t]")) setText(el, this._t(el.dataset.t));
    for (const el of root.querySelectorAll("[data-t-title]")) el.title = this._t(el.dataset.tTitle);
    for (const el of root.querySelectorAll("[data-t-label]")) el.setAttribute("aria-label", this._t(el.dataset.tLabel));
    // The imagery menu is worded when it opens.
    if (this._menu) this._toggleImageryMenu();
    this._timebar?.refresh();
    if (!this._loaded || !this._payload) return;
    for (const id of ["label-country", "label-places"]) {
      if (this._map.getLayer(id)) this._map.setLayoutProperty(id, "text-field", this._placeNames());
    }
    this._clearTicks();
    this._stripKey = null;
    this._buildCourse();
    this._renderList();
    this._renderStrip();
    this._renderSky(true);
    this._tick();
  }

  async _start() {
    if (this._starting || this._map) return;
    this._starting = true;
    clearTimeout(this._retryTimer);
    const maplibre = loadMapLibre();
    // Everything on screen in the user's language from the start.
    await this._useLanguage(this._hass);
    if (!this._els) this._buildDom();
    let gen = this._gen;
    try {
      const [ml] = await Promise.all([maplibre, this._refresh(), this._refreshMapToken()]);
      if (!this.isConnected || this._map) {
        // Taken off the page meanwhile; connectedCallback starts it again.
        this._starting = false;
        return;
      }
      const wanted = this._config.entry_id;
      if (gen !== this._gen || (wanted && this._payload && this._payload.location.entry_id !== wanted)) {
        // The location changed while this was loading, perhaps more than once.
        do {
          gen = this._gen;
          await this._refresh(true);
          if (!this.isConnected || this._map) {
            this._starting = false;
            return;
          }
        } while (gen !== this._gen);
      }
      this._ml = ml;
      const wantedNow = this._config.entry_id;
      if (!this._payload || (wantedNow && this._payload.location.entry_id !== wantedNow)) {
        // Not set up yet, or still starting: try again shortly. That includes
        // a location that could not be fetched yet, whose name must not go on
        // another one's data. A deleted location waits for a new one instead
        // (see set config). The start asks for the data itself.
        this._starting = false;
        clearTimeout(this._refreshTimer);
        if (!this._gone) this._retry(30000);
        return;
      }
      this._createMap();
    } catch (err) {
      this._starting = false;
      const why = this._errorMessage(err);
      if (mapLibreNeedsReload()) {
        // A file that keeps failing (or one the browser now refuses to fetch again).
        this._showMessage(this._t("globe.load_failed", { error: why }), { reload: true });
      } else {
        this._showMessage(this._t("globe.load_retrying", { error: why }));
        this._retry(30000 * 2 ** Math.max(0, mapLibreAttempts() - 1));
      }
    }
  }

  _retry(ms) {
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._whenShown("start", () => this._start()), ms);
  }

  /**
   * Run fn now if the globe can be seen, else once it can be: retries and the
   * like wait rather than keep asking Home Assistant for a hidden tab or a
   * card scrolled out of view. Only the latest fn of each kind is kept.
   */
  _whenShown(kind, fn) {
    if (this._shown()) fn();
    else this._pendingShown.set(kind, fn);
  }

  _shown() {
    return this.isConnected && !document.hidden && this._onScreen !== false;
  }

  _runPendingShown() {
    if (!this._shown()) return;
    const pending = [...this._pendingShown.values()];
    this._pendingShown.clear();
    for (const fn of pending) fn();
  }

  _teardown() {
    this._closeStreet({ silent: true });
    this._stopSimulation({ silent: true });
    this._simPending = null;
    this._pause();
    this._resizeObserver?.disconnect();
    clearTimeout(this._lightsTimer);
    clearTimeout(this._tilesTimer);
    clearTimeout(this._contextTimer);
    clearTimeout(this._cloudTimer);
    cancelAnimationFrame(this._hoverRaf);
    this._hoverRaf = null;
    this._failedTiles = {};
    this._menu?.remove();
    this._menu = null;
    this._homeMarker?.remove();
    this._homeMarker = null;
    // Leave fullscreen with the map, or the next one would start covering the screen.
    if (this._wrap?.classList.contains("maplibregl-pseudo-fullscreen")) {
      this._wrap.classList.remove("maplibregl-pseudo-fullscreen");
    } else if (this._wrap && this.shadowRoot?.fullscreenElement === this._wrap) {
      document.exitFullscreen?.().catch(() => {});
    }
    this.removeAttribute("fullscreen");
    // map.remove() does not call the layers' onRemove: free the decoded lights here.
    this._night?.releaseLights();
    try {
      this._map?.remove();
    } catch {
      // Already gone.
    }
    this._map = null;
    this._loaded = false;
    this._starting = false;
    this._space = this._night = null;
    // The new layer needs the cloud handed to it again.
    this._cloudIdsKey = null;
    for (const el of this._labels.values()) el.remove();
    this._labels.clear();
  }

  _observeVisibility() {
    if (!globalThis.IntersectionObserver) return;
    this._intersection ??= new IntersectionObserver((entries) => {
      this._onScreen = entries[entries.length - 1].isIntersecting;
      if (this._onScreen) this._resume();
      else this._pause();
    });
    this._intersection.observe(this);
  }

  _watchConnection() {
    const connection = this._hass?.connection;
    if (!connection || connection === this._connection) return;
    this._unwatchConnection();
    this._connection = connection;
    connection.addEventListener?.("ready", this._onReady);
  }

  _unwatchConnection() {
    this._connection?.removeEventListener?.("ready", this._onReady);
    this._connection = null;
  }

  _resume() {
    this._runPendingShown();
    if (!this.isConnected || !this._map || !this._loaded || this._running || document.hidden || this._onScreen === false) {
      return;
    }
    this._running = true;
    this._timers.push(setInterval(() => this._tick(), 1000));
    this._timers.push(setInterval(() => this._refresh(), REFRESH_MS));
    this._timers.push(setInterval(() => this._refreshMapToken(), 10 * 60 * 1000));
    this._timers.push(setInterval(() => this._updateLight(), 30 * 1000));
    this._timers.push(setInterval(() => this._loadCloud(), CLOUD_MS));
    // Back after a while: tiles tokens last 30-60 minutes, and passes move on.
    // (An older Home Assistant has no token: not asked again every time.)
    if (this._mapToken !== null && !(performance.now() - this._mapTokenAt < 10 * 60 * 1000)) this._refreshMapToken();
    // Also when the data is another location's: a switch that failed while
    // the globe was away (whose retry went with it) is tried again now.
    const elsewhere = !!this._config.entry_id && this._payload?.location.entry_id !== this._config.entry_id;
    if (elsewhere || !(performance.now() - this._payloadAt < REFRESH_MS)) this._refresh();
    this._loadCloud();
    this._updateLight();
    this._map.resize();
    this._mapSize = [this._els.map.clientWidth, this._els.map.clientHeight];
    this._frame();
    this._scheduleFrames();
    this._tick();
  }

  _pause() {
    this._running = false;
    this._timers.forEach(clearInterval);
    this._timers = [];
    // Not while away: the first tick after resuming asks again if need be.
    clearTimeout(this._passRefreshTimer);
    this._refreshedAfter = null;
    clearTimeout(this._frameTimer);
    cancelAnimationFrame(this._raf);
    this._frameTimer = this._raf = null;
  }

  /** Redraw often enough for smooth motion, and no more. */
  _scheduleFrames() {
    clearTimeout(this._frameTimer);
    cancelAnimationFrame(this._raf);
    this._frameTimer = this._raf = null;
    // While the street view covers the globe, it draws nothing (its data keeps coming).
    if (!this._running || this._suspended) return;
    const run = () => {
      this._frameTimer = this._raf = null;
      this._frame();
      // _frame() may already have rescheduled.
      if (this._frameTimer === null && this._raf === null) this._scheduleFrames();
    };
    const delay = this._frameDelay();
    if (delay === 0) this._raf = requestAnimationFrame(run);
    else this._frameTimer = setTimeout(run, delay);
  }

  _frameDelay() {
    // Kept for _frame: 0 while the satellite is out of sight.
    this._onScreenSpeed = this._screenSpeed();
    // A simulation that plays, and the breathing rings of satellites visible now, need every frame.
    const animating = (this._clock.mode === "sim" && this._clock.playing) || !!this._space?.animating;
    return frameDelay(this._onScreenSpeed, { chase: this._mode === "chase", preview: animating });
  }

  /** How fast things move across the screen, in CSS pixels per second (0 when nothing is in sight). */
  _screenSpeed() {
    const rows = this._courseRows();
    if (!this._space || !this._mapSize) return 0;
    const [w, h] = this._mapSize;
    const t = this._simNow();
    let speed = 0;
    const a = positionAt(rows, t);
    const b = positionAt(rows, t + 1);
    if (a && b) {
      const pa = this._space.project(a.lat, a.lon, a.alt * 1000, w, h);
      const pb = this._space.project(b.lat, b.lon, b.alt * 1000, w, h);
      if (pa && pb) speed = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    }
    // The satellite cloud: a low satellite (500 km, 7.6 km/s) over the middle of the view.
    if (this._cloudShown() && this._map?.getCenter) {
      const c = this._map.getCenter();
      const pa = this._space.project(c.lat, c.lng, 500000, w, h);
      const pb = this._space.project(c.lat + 0.064, c.lng, 500000, w, h);
      if (pa && pb) speed = Math.max(speed, Math.hypot(pb.x - pa.x, pb.y - pa.y));
    }
    return speed;
  }

  _showMessage(text, { spinner = false, reload = false } = {}) {
    if (!this._els) return;
    this._els.loaderMsg.textContent = text;
    this._els.loader.hidden = !text;
    this._els.loader.querySelector(".orbit").hidden = !spinner;
    this._els.reloadBtn.hidden = !reload;
  }

  /** Short notice from Home Assistant's own toast. */
  _notify(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  // -- data -----------------------------------------------------------------

  /** Home Assistant's time, in ms; corrects a device clock that is off. */
  _now() {
    return Date.now() + this._clockOffset;
  }

  _syncClock(serverTime, sentMs, receivedMs) {
    this._clockOffset = client.nextClockOffset(this._clockOffset, serverTime, sentMs, receivedMs);
  }

  _entryId() {
    return this._payload?.location?.entry_id ?? this._config.entry_id;
  }

  /** Fetch the passes; resolves true once fresh data is in. */
  async _refresh(force = false) {
    if (!this._hass || (this._fetching && !force)) return false;
    this._fetching = true;
    const gen = this._gen;
    const entry = this._config.entry_id;
    let payload;
    let relocated;
    try {
      const sent = Date.now();
      payload = await this._client.passes(entry);
      if (gen !== this._gen) return false; // The location changed meanwhile.
      this._syncClock(payload.server_time, sent, Date.now());
      relocated = !!this._payload && payload.location?.entry_id !== this._payload.location?.entry_id;
      this._gone = false;
      this._payload = payload;
      this._payloadAt = performance.now();
      this._refreshDelay = 0;
      clearTimeout(this._refreshTimer);
      this._fmt.setUnits(payload.settings?.units);
    } catch (err) {
      if (gen !== this._gen) return false;
      const code = this._errorCode(err);
      // A deleted location does not come back: say so now (the old data stays
      // underneath), and let the panel pick another one.
      this._gone = code === "unknown_location";
      if (this._gone) this.dispatchEvent(new CustomEvent("location-gone", { detail: entry }));
      // Otherwise keep showing what we have, unless it is a location that was
      // just switched away from.
      const elsewhere = !!entry && !!this._payload && this._payload.location?.entry_id !== entry;
      if (this._gone || !this._payload || elsewhere) {
        this._showMessage(this._errorText(err), { spinner: client.errorIsTransient(err) });
      }
      if (elsewhere && !this._gone) this._retryRefresh();
      return false;
    } finally {
      if (gen === this._gen) this._fetching = false;
    }
    if (!this._loaded) return true;
    // Drawn apart from the request: a drawing bug is not a failed request, so
    // it is not shown as one, and the new data stays in.
    try {
      this._showMessage("");
      this._dataChanged();
      if (relocated) this._setMode("home");
    } catch (err) {
      console.error("Satellite Spotter: could not draw the new data:", err);
    }
    return true;
  }

  /** New passes: keep the selection, and draw them everywhere. */
  _dataChanged() {
    this._reconcileSelection();
    this._buildCourse();
    this._renderList();
    this._renderStrip();
    this._renderSky(true);
    this._tick();
    this._loadCloud();
    this._applyPendingSelect();
  }

  /** Try the new location again soon, backing off while it keeps failing. */
  _retryRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshDelay = client.nextDelay(this._refreshDelay, 3000, 5 * 60 * 1000);
    this._refreshTimer = setTimeout(() => this._whenShown("refresh", () => this._refresh()), this._refreshDelay);
  }

  _errorCode(err) {
    return client.errorCode(err);
  }

  _errorMessage(err) {
    return client.errorMessage(err, this._t("globe.connection_lost"));
  }

  _errorText(err) {
    const { key, vars } = client.errorText(err, { panel: !!this._config.panel, connectionLost: this._t("globe.connection_lost") });
    return this._t(key, vars);
  }

  /** The satellite's track has run out: fetch a new one, backing off while that keeps failing. */
  _refreshStale() {
    const now = performance.now();
    if (now < (this._staleRetryAt || 0)) return;
    this._staleDelay = client.nextDelay(this._staleDelay, 3000, 10 * 60 * 1000);
    this._staleRetryAt = now + this._staleDelay;
    this._loadFocusTrack(true);
  }

  async _refreshMapToken(retryTiles = false) {
    if (!this._hass) return;
    try {
      const { token } = await this._client.mapToken();
      this._mapToken = token;
      this._mapTokenAt = performance.now();
      if (retryTiles) {
        this._refreshHaTiles();
        // Requests already under way with the old token fail a moment later.
        clearTimeout(this._tilesTimer);
        this._tilesTimer = setTimeout(() => this._refreshHaTiles(), 2000);
      }
    } catch (err) {
      // Keep a token that may still be valid; only an older Home Assistant has none.
      if (this._errorCode(err) === "unknown_command") this._mapToken = null;
    }
  }

  /**
   * Fetch again the Home Assistant tiles that failed (an expired token, or a
   * restart). They are named one by one: refreshing a whole vector source
   * leaves its failed tiles waiting for a reply that never comes.
   */
  _refreshHaTiles() {
    const map = this._map;
    if (!map || !this._loaded) return;
    for (const [id, tiles] of Object.entries(this._failedTiles)) {
      if (!tiles.size || !map.getSource(id)) continue;
      try {
        map.refreshTiles(id, [...tiles.values()]);
      } catch {
        // The source changed meanwhile.
      }
      tiles.clear();
    }
  }

  _haTilesAvailable() {
    return !!this._mapToken || !!this._hass?.config?.components?.includes?.("map_tiles");
  }

  /** A satellite's track rows between two unix times. */
  _track(noradId, start, end, step = 30) {
    return this._client.track(noradId, start, end, { step, entryId: this._entryId() });
  }

  /** A pass's pass_track payload (cached); null for no pass. */
  async _loadDetail(pass) {
    if (!pass) return null;
    const have = this._details.get(pass.id);
    if (have) return have;
    const gen = this._gen;
    const detail = await this._client.passTrack(pass.id, { entryId: this._entryId() });
    if (gen !== this._gen || !detail?.transits) return null;
    this._details.set(pass.id, detail);
    while (this._details.size > 24) this._details.delete(this._details.keys().next().value);
    this._detailArrived(pass);
    return detail;
  }

  /** A pass's rows are in: draw them where they are wanted. */
  _detailArrived(pass) {
    if (this._street && this._street.pass?.id === pass.id) this._street.setPass?.(pass, this._details.get(pass.id));
    if (pass.id !== this._shownPass()?.id) return;
    this._buildCourse();
    this._renderSky(true);
    this._updateCloudFlags();
    if (this._frameWhenLoaded === pass.id) {
      this._frameWhenLoaded = null;
      this._framePass(pass);
    }
    this._courseChanged = true;
  }

  /** Approach to the selected pass: the last part of the orbit leading into it. */
  async _loadApproach() {
    const pass = this._selectedPass();
    const lead = leader(pass);
    const now = this._now() / 1000;
    if (!pass || !lead || pass.start - now > APPROACH_MAX_S || pass.start <= now) return;
    if (this._approaches.has(pass.id) || this._approachLoading === pass.id) return;
    this._approachLoading = pass.id;
    const gen = this._gen;
    try {
      const rows = await this._track(lead.norad_id, Math.max(now, pass.start - APPROACH_LINE_S), pass.start, 30);
      if (gen !== this._gen) return;
      this._approaches.set(pass.id, rows);
      if (this._selectedId === pass.id && this._loaded && this._clock.mode === "live") {
        this._space?.setLine("approach", rows, this._baseT);
        this._courseChanged = true;
      }
    } catch {
      // Asked for again with the next refresh: the location may have been reloading.
    } finally {
      if (this._approachLoading === pass.id) this._approachLoading = null;
    }
  }

  _clearApproach() {
    this._approaches.clear();
    if (this._loaded && this._space) {
      this._space.setLine("approach", [], 0);
      this._courseChanged = true;
    }
  }

  /** A different location: drop everything that belonged to the old one. */
  _locationChanged() {
    this._gen++;
    this._fetching = false;
    this._gone = false;
    // The back-off was for the old location; the new one starts afresh.
    clearTimeout(this._refreshTimer);
    this._refreshDelay = 0;
    this._client.clear();
    this._details.clear();
    this._clearApproach();
    this._focus = null;
    this._focusTrack = null;
    this._positions = null;
    this._cloudFor = null;
    this._selectedId = null;
    this._userSelected = false;
    this._pendingSelect = null;
    // A simulation still loading was of the old location's pass: it does not start.
    this._simPending = null;
    if (this._els?.simBtn) this._els.simBtn.disabled = false;
    this._closeStreet({ silent: true });
    if (this._clock.mode === "sim") {
      this._stopSimulation({ silent: true });
      this._scheduleFrames();
      this._updateLight();
    }
  }

  _haUrl(path) {
    // Built by hand: URL() would escape the {z}/{x}/{y} placeholders.
    const base = this._hass?.hassUrl ? this._hass.hassUrl("") : location.origin;
    return base.replace(/\/+$/, "") + path;
  }

  // -- selection ------------------------------------------------------------

  _passes() {
    return this._payload?.paused ? [] : this._payload?.passes || [];
  }

  _passById(id) {
    return id ? this._passes().find((p) => p.id === id) ?? null : null;
  }

  _selectedPass() {
    return this._passById(this._selectedId);
  }

  /** The pass on show: the one simulated, else the selected one. */
  _shownPass() {
    if (this._clock.mode === "sim" && this._sim?.pass) return this._passById(this._sim.pass.id) ?? this._sim.pass;
    return this._selectedPass();
  }

  /**
   * The passes the list shows: those through its filters, or all of them
   * when the filters leave none to come (so the globe never says "none soon"
   * about passes it has).
   */
  _listedPasses(nowS = this._now() / 1000) {
    const passes = this._passes();
    const f = this._filters;
    if (!f.brightOnly && !f.hideStarlink) return passes;
    const shown = passes.filter((p) => passesModule.matchesFilters(p, f));
    return shown.some((p) => p.end > nowS) ? shown : passes;
  }

  /** The pass the view would pick by itself: the one going on, else the next (of those listed). */
  _autoPass(nowS = this._now() / 1000) {
    const passes = this._listedPasses(nowS);
    return passesModule.currentPass(passes, nowS) ?? passesModule.nextPass(passes, nowS);
  }

  /**
   * The pass list's filters changed (its chips, or the panel's remembered
   * ones): the strip and the pass picked by itself follow, and the panel
   * hears of it ("filters-changed") to keep them.
   */
  _setFilters(filters, { emit = true } = {}) {
    const next = passesModule.normalizeFilters(filters);
    if (next.brightOnly === this._filters.brightOnly && next.hideStarlink === this._filters.hideStarlink) return;
    this._filters = next;
    if (emit) this.dispatchEvent(new CustomEvent("filters-changed", { detail: { ...next }, bubbles: true, composed: true }));
    if (!this._loaded || !this._payload) return;
    this._stripKey = null;
    this._reconcileSelection();
    this._renderList();
    this._renderStrip();
    this._tick();
  }

  /**
   * After new data or as time passes: keep the user's pass while it lasts
   * (finding it again when refreshed predictions gave it a new id), else
   * show the live or next pass.
   */
  _reconcileSelection() {
    const nowS = this._now() / 1000;
    let pass = this._selectedPass();
    if (!pass && this._selectedId) {
      // Refreshed predictions move a pass by a few seconds, and so its id.
      const [norad, start] = this._selectedId.split("-").map(Number);
      pass = this._passes().find((p) => leader(p)?.norad_id === norad && Math.abs(p.start - start) <= 120) ?? null;
    }
    // The user's pass stays until it is over (and while it is simulated or in the street view).
    const busy = this._clock.mode === "sim" || !!this._street;
    if (this._userSelected && (!pass || (!busy && pass.end + clockModule.PASS_TAIL_S < nowS))) {
      if (!busy) this._userSelected = false;
    }
    if (!this._userSelected) pass = this._autoPass(nowS);
    const id = pass?.id ?? (busy ? this._selectedId : null);
    if (id !== this._selectedId) {
      this._selectedId = id;
      this._selectionChanged();
    } else if (pass) {
      this._loadDetail(pass).catch(() => {});
      this._loadApproach();
      this._loadFocusTrack();
    }
  }

  /** The selected pass changed: fetch what it needs and show it. */
  _selectionChanged() {
    const pass = this._selectedPass();
    this._skyData = null;
    this._loadDetail(pass).catch((err) => {
      if (this._errorCode(err) !== "unknown_pass") console.debug("Satellite Spotter: pass track:", err);
    });
    this._loadApproach();
    this._loadFocusTrack();
    if (pass) this._timebar?.setContext({ pass, label: this._fmt.passTitle(pass), view: "globe" });
    this._buildCourse();
    this._renderList();
    this._renderStrip();
    this._renderSky(true);
    this._updateCloudFlags();
    this._tick();
  }

  /**
   * The user picked a pass (list, strip, pin, deep link, a satellite in the
   * cloud): show it, frame it, and maybe simulate it or open the street view.
   */
  async _select(id, { view = null, frame = true, emit = true, keepFocus = false } = {}) {
    let pass = this._passById(id);
    if (!pass && id) {
      // A pass from older predictions (a notification, a bookmark): the
      // integration knows which one it became.
      const gen = this._gen;
      let detail = null;
      try {
        detail = await this._client.passTrack(id, { entryId: this._entryId() });
      } catch {
        // Unknown: said below.
      }
      // Another location meanwhile: the answer was the old one's.
      if (gen !== this._gen) return;
      pass = this._passById(detail?.pass_id);
      if (!pass) {
        this._notify(this._t("globe.pass_gone"));
        return;
      }
      this._details.set(pass.id, detail);
    }
    if (!pass) return;
    const changed = pass.id !== this._selectedId;
    // Another pass while one is simulated: back to live first (a new
    // simulation takes over the old one's clock, and its way back).
    if (this._clock.mode === "sim" && this._sim?.pass.id !== pass.id && view !== "simulate") {
      this._stopSimulation({ silent: view === "street" || frame });
    }
    if (!keepFocus) this._focus = null;
    this._userSelected = true;
    if (changed) {
      this._selectedId = pass.id;
      this._selectionChanged();
    } else if (!keepFocus) {
      this._loadFocusTrack();
      this._buildCourse();
    }
    if (view === "simulate") this._simulate(pass);
    else if (view === "street") this._openStreet(pass, { user: true, emit: false });
    else if (frame) this._framePass(pass);
    if (emit) this._emitSelected(view);
  }

  /** A deep link waiting for the data (of its location: a link can switch location too). */
  _applyPendingSelect() {
    const pending = this._pendingSelect;
    if (!pending || !this._payload || !this._loaded) return;
    const wanted = this._config.entry_id;
    if (wanted && this._payload.location?.entry_id !== wanted) return;
    this._pendingSelect = null;
    this._select(pending.id, { view: pending.view, emit: false });
  }

  _emitSelected(view = null) {
    this.dispatchEvent(
      new CustomEvent("pass-selected", { detail: { id: this._selectedId, view }, bubbles: true, composed: true })
    );
  }

  // -- the focus satellite --------------------------------------------------

  /** The satellite drawn in full: one picked in the cloud, else the shown pass's leader, else the ISS. */
  _focusInfo() {
    if (this._focus) return this._focus;
    const lead = leader(this._shownPass());
    if (lead) return { norad_id: lead.norad_id, name: lead.name, kind: lead.kind, period_s: lead.period_s };
    const iss = this._catalogById?.get(ISS_NORAD_ID);
    return { norad_id: ISS_NORAD_ID, name: iss?.name ?? "ISS", kind: "iss", period_s: iss?.period_s ?? DEFAULT_PERIOD_S };
  }

  _periodS() {
    return this._focusInfo()?.period_s || DEFAULT_PERIOD_S;
  }

  /** The focus satellite's orbit around now (live): half a period back, more than one ahead. */
  async _loadFocusTrack(force = false) {
    const f = this._focusInfo();
    if (!f || !this._hass || this._payload?.paused) return;
    const P = f.period_s || DEFAULT_PERIOD_S;
    const now = this._now() / 1000;
    const have = this._focusTrack;
    if (!force && have?.norad === f.norad_id && have.from <= now && have.to >= now + 0.75 * P) return;
    if (this._focusLoading === f.norad_id) return;
    this._focusLoading = f.norad_id;
    const gen = this._gen;
    const from = Math.floor(now - P / 2);
    const to = Math.ceil(now + 1.25 * P);
    try {
      const rows = await this._track(f.norad_id, from, to, 30);
      if (gen !== this._gen || this._focusInfo()?.norad_id !== f.norad_id) return;
      this._focusTrack = { norad: f.norad_id, rows, from, to };
      this._staleDelay = this._staleRetryAt = 0;
      this._buildCourse();
      this._tick();
    } catch (err) {
      if (gen === this._gen && have?.norad !== f.norad_id) this._focusTrack = null;
      console.debug("Satellite Spotter: orbit:", this._errorMessage(err));
    } finally {
      if (this._focusLoading === f.norad_id) this._focusLoading = null;
    }
  }

  /** The rows the focus satellite moves along now: its simulated track, else its orbit plus its pass. */
  _courseRows() {
    if (this._clock.mode === "sim" && this._simRows) return this._simRows;
    const f = this._focusInfo();
    const orbit = this._focusTrack?.norad === f?.norad_id ? this._focusTrack.rows : null;
    const pass = this._shownPass();
    const detail = pass && this._details.get(pass.id);
    // Near home during its pass the 2 s rows move the satellite smoothly (a
    // train member's are made from the leader's, so they are kept by payload).
    const index = detail ? detail.transits.findIndex((t) => t.norad_id === f?.norad_id) : -1;
    const c = this._courseCache;
    if (c && c.orbit === orbit && c.detail === detail && c.index === index) return c.rows;
    const rows = mergeRows(orbit, index >= 0 ? transitRows(detail, index) : null);
    this._courseCache = { orbit, detail, index, rows };
    return rows;
  }

  /** Follow a satellite picked in the cloud; show its next pass, if it has one. */
  _focusSatellite(noradId) {
    const sat = this._catalogById?.get(noradId);
    if (!sat) return;
    this._focus = { norad_id: noradId, name: sat.name, kind: sat.kind, period_s: sat.period_s || DEFAULT_PERIOD_S, picked: true };
    this._focusTrack = null;
    const nowS = this._now() / 1000;
    const pass = passesModule.nextPass(this._passes(), nowS, (p) => (p.transits || []).some((t) => t.norad_id === noradId));
    if (pass) this._select(pass.id, { frame: false, keepFocus: true });
    this._loadFocusTrack(true);
    this._buildCourse();
    this._updateCloudFlags();
    this._announce(this._t("globe.following", { name: sat.name }), `focus|${noradId}`);
    this._tick();
  }

  // -- simulation -----------------------------------------------------------

  /**
   * Replay a pass on the shared clock: the orbit leading in (fast-forward),
   * then the visible part in about 20 seconds, looping, with the time bar.
   */
  async _simulate(pass, { approach = true } = {}) {
    const lead = leader(pass);
    if (!pass || !lead || !this._payload || this._payload.paused) return;
    const token = (this._simPending = {});
    // Started from the keyboard: focus goes on to the time bar (the button hides).
    const hadFocus = !!this._els?.simBtn && this.shadowRoot?.activeElement === this._els.simBtn;
    if (this._els?.simBtn) this._els.simBtn.disabled = true;
    const opts = simulationWindow(pass, this._now() / 1000, { reduced: !approach || prefersReducedMotion() });
    const P = opts.periodS;
    const peak = pass.peak?.time ?? (pass.start + pass.end) / 2;
    let detail;
    let orbit;
    let coarse;
    try {
      [detail, orbit, coarse] = await Promise.all([
        this._loadDetail(pass),
        this._track(lead.norad_id, peak - P / 2, peak + P / 2, 30).catch(() => null),
        opts.approachFromS !== null
          ? this._track(lead.norad_id, opts.approachFromS, opts.fromS, Math.max(30, Math.ceil((opts.fromS - opts.approachFromS) / 3000))).catch(() => null)
          : null,
      ]);
    } catch (err) {
      if (this._simPending !== token) return;
      this._simPending = null;
      if (this._els?.simBtn) this._els.simBtn.disabled = false;
      this._notify(this._t("globe.simulation_failed", { error: this._errorMessage(err) }));
      return;
    }
    if (this._simPending !== token) return;
    this._simPending = null;
    if (this._els?.simBtn) this._els.simBtn.disabled = false;
    // The fast-forward only along an orbit that covers it.
    if (opts.approachFromS !== null && !rowsCover(coarse, opts.approachFromS, opts.fromS)) opts.approachFromS = null;
    const map = this._map;
    this._sim = {
      pass,
      modeBefore: this._sim?.modeBefore ?? this._mode,
      viewBefore:
        this._sim?.viewBefore ??
        (map ? { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() } : null),
    };
    this._focus = null;
    this._simRows = mergeRows(opts.approachFromS !== null ? coarse : null, orbit, transitRows(detail, 0));
    // The sky chart is not opened for the simulation: on phones and in cards
    // its popover would cover the mission card's "Look NE, 51° up", and the
    // satellite already moves on the globe. "Where to look" opens it on request.
    this._clock.simulate({ ...opts, rate: "fit", loop: true });
    if (hadFocus) this._els.timebarHost?.querySelector?.(".tb-live")?.focus();
  }

  /** A simulation ended elsewhere (the street view's "Back to live"): forget it, quietly. */
  _simulationEnded() {
    const sim = this._sim;
    this._sim = null;
    this._simRows = null;
    if (sim?.modeBefore) this._mode = sim.modeBefore;
    this._syncControls();
    // Under the street view the camera stays; it is where the pass was framed.
    if (!this._suspended && this._map && sim?.viewBefore) {
      this._map.flyTo({ ...sim.viewBefore, duration: prefersReducedMotion() ? 0 : 1800 });
    }
  }

  /**
   * A simulation started elsewhere (the street view's replay): show the pass
   * it replays, and fetch its satellite's orbit around it.
   */
  _adoptSimulation() {
    const w = this._clock.window;
    const pass = this._passes().find((p) => w && p.start >= w.fromS && p.end <= w.toS) ?? this._selectedPass();
    if (!pass) return;
    const map = this._map;
    this._sim = {
      pass,
      modeBefore: this._mode,
      viewBefore: map ? { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() } : null,
    };
    this._focus = null;
    const lead = leader(pass);
    const P = lead?.period_s || DEFAULT_PERIOD_S;
    const peak = pass.peak?.time ?? (pass.start + pass.end) / 2;
    const sim = this._sim;
    Promise.all([this._loadDetail(pass), lead ? this._track(lead.norad_id, peak - P / 2, peak + P / 2, 30) : null])
      .then(([detail, orbit]) => {
        if (this._sim !== sim) return;
        this._simRows = mergeRows(orbit, transitRows(detail, 0));
        this._buildCourse();
      })
      .catch(() => {});
  }

  /** Back to real time (Escape, "Back to live"); the camera goes back to where it was. */
  _stopSimulation({ silent = false, user = false } = {}) {
    this._simPending = null;
    const sim = this._sim;
    if (this._clock.mode !== "sim" && !sim) return;
    const hadFocus = !!this._els && this.shadowRoot?.activeElement && this._els.timebarHost?.contains?.(this.shadowRoot.activeElement);
    this._sim = null;
    this._simRows = null;
    this._clock.live();
    if (silent || !this._map) return;
    if (sim?.modeBefore) this._mode = sim.modeBefore;
    this._syncControls();
    if (sim?.viewBefore) this._map.flyTo({ ...sim.viewBefore, duration: prefersReducedMotion() ? 0 : 1800 });
    if (hadFocus) this._els.simBtn?.focus();
    if (user) this._emitSelected(this._street ? "street" : null);
  }

  /** The shared clock changed (mode, play state, speed, seeking): follow it. */
  _onClockChange(ev) {
    const sim = this._clock.mode === "sim";
    // At the pass after the fast-forward: it ran its course ("phase"), or a
    // pause or a seek cut it short. A new simulation frames its pass itself.
    const arrived = this._lastPhase === "approach" && this._clock.phase === "replay" && ev.reason !== "simulate";
    this._lastPhase = this._clock.phase;
    if (this._els?.timebarHost) this._els.timebarHost.hidden = !sim;
    this._els?.mission?.classList.toggle("sim", sim);
    // The street view's own time bar can end a simulation, or start one.
    if (ev.reason === "live" && this._sim) this._simulationEnded();
    if (ev.reason === "simulate" && !this._sim) this._adoptSimulation();
    if (ev.reason === "simulate" || ev.reason === "live") {
      this._buildCourse();
      this._renderSky(true);
      this._loadCloud();
      this._updateLight(300);
      if (ev.reason === "simulate") {
        const pass = this._sim?.pass;
        if (pass) this._timebar?.setContext({ pass, label: this._fmt.passTitle(pass), view: "globe" });
        // Straight to the pass, or follow the fast-forward there first.
        if (this._clock.phase !== "approach") this._framePass(pass, { fromSim: true });
      }
    }
    if (arrived) {
      this._framePass(this._sim?.pass, { fromSim: true });
      this._loadCloud();
    }
    this._courseChanged = true;
    this._scheduleFrames();
    this._tick();
    // Paused or seeking: one frame shows the new moment (unless this is that frame).
    if (!this._clock.playing && this._running && !this._suspended && !this._inFrame) this._frame();
  }

  /**
   * Fly to see a pass: the camera behind home, looking the way the
   * satellite will be at its highest, between home and the point beneath it.
   * Waits for the pass's rows if they are not in yet.
   */
  _framePass(pass, { fromSim = false } = {}) {
    const map = this._map;
    if (!pass || !map) return;
    const detail = this._details.get(pass.id);
    // Under the street view the camera waits; and for the pass's rows.
    if (!detail || this._suspended) {
      this._frameWhenLoaded = pass.id;
      return;
    }
    const home = this._payload.location;
    const rows = rowsBetween(transitRows(detail, 0), pass.start, pass.end);
    const top = rows.length ? rows[closestApproach(home, rows)] : null;
    // Halfway between home and the point beneath the satellite at its highest.
    const center = top
      ? [home.longitude + 0.5 * wrapLongitude(top[2] - home.longitude), (home.latitude + top[1]) / 2]
      : [home.longitude, home.latitude];
    // Wide enough for every satellite's visible part (a train can be long).
    let reach = 0;
    for (const [i] of detail.transits.entries()) {
      const t = detail.transits[i];
      for (const r of rowsBetween(transitRows(detail, i), t.visible_start ?? t.start, t.visible_end ?? t.end)) {
        reach = Math.max(reach, groundDistanceKm(center[1], center[0], r[1], r[2]));
      }
    }
    // The zoom for that reach was tuned at Boston's latitude. MapLibre's globe is
    // 1/cos(latitude) times larger at the same zoom (see the fast-forward in
    // _drawFrame), so elsewhere that is taken back out; never so close that the
    // globe starts to flatten into the map (from zoom 4.5).
    const atLatitude = Math.log2(Math.max(Math.cos(center[1] * DEG), 0.15) / Math.cos(FRAME_LATITUDE * DEG));
    const zoom = Math.min(4.2, clamp(3.55 - Math.log2(Math.max(reach, 400) / 900), 2.1, 4.2) + atLatitude);
    this._mode = "free";
    this._syncControls();
    // Clear of the cards at the top as well: the pass is what this is for.
    map.flyTo({
      center,
      zoom,
      pitch: 50,
      bearing: pass.peak?.azimuth ?? leader(pass)?.peak?.azimuth ?? 180,
      padding: this._tiltPadding(),
      duration: prefersReducedMotion() ? 0 : fromSim ? 2500 : 1800,
      essential: true,
    });
  }

  // -- street view ----------------------------------------------------------

  /** Load the street view's module (separate so tests can stand in for it). */
  _importStreet() {
    return import(`./sat-street.js${VERSION}`);
  }

  /** The street view's options as it keeps them (only it writes them); none: its own defaults. */
  _streetOptions() {
    try {
      const saved = JSON.parse(localStorage.getItem(STREET_STORAGE) || "null");
      if (saved && typeof saved === "object") return saved;
    } catch {
      // Private window, or blocked storage: its defaults.
    }
    return {};
  }

  /**
   * See a pass from the street: the street view opens over the globe, on the
   * same clock. A pass about to start or going on is shown live; a later one
   * is simulated (unless a simulation runs already, whose moment it keeps).
   */
  async _openStreet(pass, { user = false, emit = true } = {}) {
    if (!pass || this._config.street_view === false || !this._payload || !this._els) return;
    if (this._street) {
      if (this._street.pass?.id !== pass.id) this._street.setPass?.(pass, this._details.get(pass.id) ?? null);
      return;
    }
    if (this._clock.mode !== "sim" && !clockModule.passIsLive(pass, this._now() / 1000)) {
      this._simulate(pass, { approach: false });
    }
    const token = (this._streetPending = {});
    try {
      await this._importStreet();
    } catch (err) {
      if (this._streetPending !== token) return;
      this._streetPending = null;
      this._notify(this._t("globe.street_failed", { error: this._errorMessage(err) }));
      return;
    }
    if (this._streetPending !== token || !this._wrap) return;
    this._streetPending = null;
    const el = document.createElement("satellite-street-view");
    const home = this._payload.location;
    el.hass = this._hass;
    el.formatter = this._fmt;
    el.location = { entry_id: home.entry_id, latitude: home.latitude, longitude: home.longitude, elevation: home.elevation, title: home.title };
    el.units = this._payload.settings?.units ?? "auto";
    el.clock = this._clock;
    el.options = this._streetOptions();
    el.pass = pass;
    el.detail = this._details.get(pass.id) ?? null;
    el.addEventListener("close", () => this._closeStreet({ user: true }));
    el.addEventListener("need-detail", (ev) => {
      const wanted = this._passById(ev.detail?.passId) ?? pass;
      this._loadDetail(wanted)
        .then((detail) => detail && el.setPass?.(wanted, detail))
        .catch(() => {});
    });
    this._streetReturn = user ? this.shadowRoot?.activeElement ?? null : null;
    this._street = el;
    this._wrap.appendChild(el);
    this._suspend(true);
    el.open?.();
    if (!el.detail) this._loadDetail(pass).catch(() => {});
    if (emit) this._emitSelected("street");
  }

  /** Close the street view and free its WebGL context; the globe draws again. One still loading stays shut. */
  _closeStreet({ silent = false, user = false } = {}) {
    const loading = !!this._streetPending;
    this._streetPending = null;
    const el = this._street;
    if (!el) {
      // Stopped while it loaded: so is the replay it asked for, if that is still
      // loading too (one already playing stays), and the panel's address stops
      // asking for either.
      if (loading && user) {
        if (this._simPending) {
          this._simPending = null;
          if (this._els?.simBtn) this._els.simBtn.disabled = false;
        }
        this._emitSelected(this._clock.mode === "sim" ? "simulate" : null);
      }
      return;
    }
    this._street = null;
    try {
      el.dispose?.();
    } catch (err) {
      console.error("Satellite Spotter: could not close the street view:", err);
    }
    el.remove?.();
    if (silent) {
      // Torn down or moved elsewhere: the globe draws again when it can.
      this._suspended = false;
      this._scheduleFrames();
      return;
    }
    this._suspend(false);
    const back = this._streetReturn;
    this._streetReturn = null;
    (back?.isConnected ? back : this._els?.streetBtn)?.focus?.({ preventScroll: true });
    if (user) this._emitSelected(this._clock.mode === "sim" ? "simulate" : null);
  }

  /** Stop drawing the globe (the street view covers it), or start again; its data keeps coming. */
  _suspend(on) {
    if (this._suspended === on) return;
    this._suspended = on;
    if (on) {
      clearTimeout(this._frameTimer);
      cancelAnimationFrame(this._raf);
      this._frameTimer = this._raf = null;
      return;
    }
    this._courseChanged = true;
    this._map?.resize?.();
    this._buildCourse();
    const waiting = this._frameWhenLoaded && this._passById(this._frameWhenLoaded);
    if (waiting && this._details.has(waiting.id)) {
      this._frameWhenLoaded = null;
      this._framePass(waiting);
    }
    this._frame();
    this._scheduleFrames();
    this._tick();
  }

  // -- the satellite cloud ----------------------------------------------------

  /** Whether every satellite is shown: the toggle, else the card's option (on in the panel). */
  _cloudWanted() {
    if (this._showCloud !== null && this._showCloud !== undefined) return this._showCloud;
    return this._config.show_satellites ?? !!this._config.panel;
  }

  _cloudShown() {
    return this._cloudWanted() && !!this._positions && !!this._cloudIndex;
  }

  /** The positions the cloud needs: the next ten minutes live, or those around the pass being simulated. */
  _cloudRequest() {
    const w = this._clock.mode === "sim" ? this._clock.window : null;
    if (!w) return { key: "live", want: { span: 600 } };
    const startS = Math.floor((w.fromS - 60) / 60) * 60;
    return { key: `sim:${startS}`, want: { startS, span: Math.min(3600, Math.ceil((w.toS - w.fromS + 180) / 60) * 60) } };
  }

  /**
   * Positions of every satellite: every five minutes for the next ten
   * minutes live, or around the pass being simulated.
   */
  async _loadCloud(force = false) {
    if (!this._cloudWanted() || !this._hass || !this._loaded || this._payload?.paused) return;
    const { key, want } = this._cloudRequest();
    const have = this._positions;
    const nowS = this._now() / 1000;
    const end = have ? have.start + (have.count - 1) * have.step : -Infinity;
    const fresh =
      !!have &&
      this._cloudFor === key &&
      (key !== "live" || (performance.now() - this._positionsAt < CLOUD_MS - 1000 && end >= nowS + 60));
    if ((fresh && !force) || this._cloudLoading === key) return;
    // After a failure, frames that find the positions run out wait for the retry.
    if (!force && this._cloudFailed === key && performance.now() < (this._cloudRetryAt || 0)) return;
    this._cloudLoading = key;
    clearTimeout(this._cloudTimer);
    const gen = this._gen;
    // Another location, or another moment: a simulation that started or ended
    // meanwhile has asked for its own, and these would hide the cloud.
    const unwanted = () => gen !== this._gen || this._cloudRequest().key !== key;
    try {
      const positions = await this._client.positions({ ...want, step: 60, entryId: this._entryId() });
      if (unwanted()) return;
      // The satellites first: positions in a new order need the catalogue's order too.
      await this._ensureCloudCatalog(positions);
      if (unwanted()) return;
      this._positions = positions;
      this._positionsAt = performance.now();
      this._cloudFor = key;
      this._cloudDelay = 0;
      this._cloudFailed = null;
      this._updateCloudFlags();
      this._courseChanged = true;
    } catch (err) {
      if (unwanted()) return;
      // Try again later, backing off; the satellites that are shown stay.
      this._cloudFailed = key;
      this._cloudDelay = client.nextDelay(this._cloudDelay, 30000, CLOUD_MS);
      this._cloudRetryAt = performance.now() + this._cloudDelay;
      this._cloudTimer = setTimeout(() => this._whenShown("cloud", () => this._loadCloud()), this._cloudDelay);
      console.debug("Satellite Spotter: positions:", this._errorMessage(err));
    } finally {
      if (this._cloudLoading === key) this._cloudLoading = null;
    }
  }

  /** Hand the cloud its satellites (kinds, magnitudes) when they change. */
  async _ensureCloudCatalog(positions) {
    const ids = positions.ids || [];
    const key = `${positions.catalog_version}|${ids.length}|${ids[0]}|${ids[ids.length - 1]}`;
    if (key === this._cloudIdsKey && this._catalog) return;
    const catalog = await this._client.catalog({ version: positions.catalog_version, entryId: this._entryId() });
    this._catalog = catalog;
    this._catalogById = new Map((catalog?.satellites || []).map((s) => [s.norad_id, s]));
    this._cloudIndex = new Map(ids.map((id, i) => [id, i]));
    this._cloudFlagBits = new Uint8Array(ids.length);
    this._cloudLL = this._cloudXY = null;
    this._space?.setCloud(spaceModule.cloudFromCatalog(catalog, ids));
    this._cloudIdsKey = key;
  }

  /** Move the cloud to time t (each frame). */
  _updateCloud(t) {
    const space = this._space;
    const pos = this._positions;
    if (!space?.setCloudPositions) return;
    if (!this._cloudWanted() || !pos || !this._cloudIndex) {
      space.setCloudPositions(null, { visible: false });
      return;
    }
    const end = pos.start + (pos.count - 1) * pos.step;
    const covered = t >= pos.start - 30 && t <= end + 30;
    // Hidden during the fast-forward: the positions are for the pass, not on the way to it.
    const visible = covered && this._clock.phase !== "approach";
    if (visible) {
      this._cloudLL = interpolatePositions(pos, t, this._cloudLL);
      this._cloudXY = spaceModule.cloudPositions(this._cloudLL, this._cloudXY);
    }
    space.setCloudPositions(visible ? this._cloudXY : null, { visible });
    if (!covered && this._clock.mode === "live") this._loadCloud();
  }

  /**
   * The cloud's flags: the satellites drawn as sprites are left out, the
   * selected pass's are gold, those visible from home now breathe, and the
   * one under the pointer stands out.
   */
  _updateCloudFlags() {
    const index = this._cloudIndex;
    const bits = this._cloudFlagBits;
    if (!index || !bits || !this._space?.setCloudFlags) return;
    const before = Uint8Array.from(bits);
    bits.fill(0);
    const set = (id, bit) => {
      const i = index.get(id);
      if (i !== undefined) bits[i] |= bit;
    };
    const t = this._simNow();
    const pass = this._shownPass();
    const detail = pass && this._details.get(pass.id);
    for (const [i, tr] of (pass?.transits || []).entries()) {
      set(tr.norad_id, 8);
      // Drawn as sprites while their rows reach (see _memberObjects); a train
      // member's horizon times already carry its offset.
      const d = detail?.transits?.[i];
      if (d && t >= d.horizon_rise && t <= d.horizon_set) set(tr.norad_id, 1);
    }
    // Every satellite in the sky from home right now, in any pass.
    const passes = this._clock.mode === "sim" ? (pass ? [pass] : []) : this._passes();
    for (const p of passes) {
      if (!(p.start <= t && t < p.end)) continue;
      for (const tr of p.transits || []) if (tr.start <= t && t < tr.end) set(tr.norad_id, 4);
    }
    if (this._position) set(this._focusInfo()?.norad_id, 1);
    if (this._hover) set(this._hover, 2);
    if (bits.some((b, i) => b !== before[i])) {
      this._space.setCloudFlags(bits);
      this._courseChanged = true;
    }
  }

  _onPointerMove(point) {
    this._hoverPoint = point;
    if (!point || !this._cloudShown() || this._clock.phase === "approach") {
      this._setHover(null);
      return;
    }
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = null;
      const pt = this._hoverPoint;
      if (!pt || !this._space || !this._mapSize) return;
      const i = this._space.pick(pt.x, pt.y, this._mapSize[0], this._mapSize[1], 10);
      this._setHover(i >= 0 ? this._positions?.ids?.[i] ?? null : null, pt);
    });
  }

  _setHover(noradId, pt = null) {
    const changed = noradId !== (this._hover ?? null);
    this._hover = noradId;
    const tip = this._els?.tip;
    const canvas = this._map?.getCanvas?.();
    if (canvas) canvas.style.cursor = noradId ? "pointer" : "";
    if (!tip) return;
    if (!noradId) {
      tip.hidden = true;
      if (changed) this._updateCloudFlags();
      return;
    }
    if (changed) {
      setHtml(tip, this._tipHtml(noradId));
      this._updateCloudFlags();
    }
    tip.hidden = false;
    // Beside the pointer, kept inside the globe.
    const [w, h] = this._mapSize || [0, 0];
    const tw = tip.offsetWidth || 200;
    const th = tip.offsetHeight || 60;
    const x = pt.x + 14 + tw > w ? pt.x - 14 - tw : pt.x + 14;
    const y = Math.min(Math.max(8, pt.y + 14), Math.max(8, h - th - 8));
    tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  /** The hover tooltip: name, kind and altitude, and when it can be seen. */
  _tipHtml(noradId) {
    const sat = this._catalogById?.get(noradId);
    const i = this._cloudIndex?.get(noradId);
    const alt = i !== undefined && this._cloudLL ? this._cloudLL[i * 4 + 2] : null;
    const fmt = this._fmt;
    const t = this._simNow();
    const live = this._passes().find((p) => p.start <= t && t < p.end && (p.transits || []).some((tr) => tr.norad_id === noradId));
    const next = passesModule.nextPass(this._passes(), t, (p) => (p.transits || []).some((tr) => tr.norad_id === noradId));
    let when;
    if (live) when = `<span class="now">${esc(this._t("globe.tip_visible_now"))}</span>`;
    else if (next) when = esc(this._t("globe.tip_next", { when: `${fmt.group(next.start, t).label} ${fmt.time(next.start)}` }));
    else when = esc(this._t("globe.tip_no_pass", { count: this._payload?.settings?.days ?? 5 }));
    const facts = [fmt.kind(sat?.kind)];
    if (Number.isFinite(alt)) facts.push(fmt.altitude(alt));
    return `<b>${svgIcon(kindIcon(sat?.kind))}${esc(sat?.name ?? String(noradId))}</b>${esc(facts.join(" · "))}<br>${when}
      <span class="hint">${esc(this._t("globe.tip_follow"))}</span>`;
  }

  _onMapClick(point) {
    // While a pass is simulated the globe shows that pass's satellites.
    if (!point || !this._cloudShown() || !this._space || !this._mapSize || this._clock.mode === "sim") return;
    const i = this._space.pick(point.x, point.y, this._mapSize[0], this._mapSize[1], 12);
    const id = i >= 0 ? this._positions?.ids?.[i] : null;
    if (id) this._focusSatellite(id);
  }

  // -- map ------------------------------------------------------------------

  _imageryKey() {
    let key = this._config.imagery || "satellite";
    key = IMAGERY_ALIASES[key] || key;
    if (!IMAGERY[key] || (IMAGERY[key].homeAssistantTiles && !this._haTilesAvailable())) return "satellite";
    return key;
  }

  _closeupSource(key) {
    const def = IMAGERY[key];
    return {
      type: "raster",
      tiles: def.homeAssistantTiles ? [this._haUrl(def.homeAssistantTiles)] : def.tiles,
      tileSize: 256,
      maxzoom: def.maxzoom,
      attribution: def.attribution,
    };
  }

  _labelsWanted() {
    return this._config.labels !== false && this._haTilesAvailable();
  }

  _buildStyle() {
    this._closeupKey = this._imageryKey();
    const sources = { bluemarble: BLUE_MARBLE, closeup: this._closeupSource(this._closeupKey) };
    const layers = [
      { id: "closeup", type: "raster", source: "closeup", minzoom: 4.4, paint: { "raster-fade-duration": 200 } },
      {
        id: "bluemarble", type: "raster", source: "bluemarble", maxzoom: 7,
        paint: { "raster-fade-duration": 200, "raster-opacity": ["interpolate", ["linear"], ["zoom"], 5, 1, 6.5, 0] },
      },
    ];
    const style = {
      version: 8,
      projection: { type: this._flat ? "mercator" : GLOBE_PROJECTION },
      light: sunLight(new Date(this._now())),
      sky: {
        "sky-color": "#04091c",
        "horizon-color": "#1e3a8a",
        "fog-color": "#0b1a3a",
        "sky-horizon-blend": 0.6,
        "horizon-fog-blend": 0.4,
        // Enough for a glowing limb without washing out the day side.
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.4, 5, 0.4, 7, 0],
      },
      sources,
      layers,
    };
    if (this._labelsWanted()) {
      style.glyphs = this._haUrl("/api/map_tiles/fonts/{fontstack}/{range}.pbf");
      sources.osm = {
        type: "vector",
        tiles: [this._haUrl("/api/map_tiles/vector/{z}/{x}/{y}.mvt")],
        maxzoom: 14,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      };
      layers.push(
        {
          id: "borders-country", type: "line", source: "osm", "source-layer": "boundaries",
          filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], true]],
          paint: { "line-color": "rgba(255,255,255,0.42)", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 6, 1.2] },
        },
        {
          id: "borders-state", type: "line", source: "osm", "source-layer": "boundaries", minzoom: 3.5,
          filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], true]],
          paint: { "line-color": "rgba(255,255,255,0.26)", "line-width": 0.8, "line-dasharray": [3, 2] },
        },
        {
          id: "roads", type: "line", source: "osm", "source-layer": "streets", minzoom: 9,
          filter: ["in", ["get", "kind"], ["literal", ["motorway", "trunk", "primary", "secondary"]]],
          paint: { "line-color": "rgba(253, 230, 138, 0.42)", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.6, 14, 2.2] },
        }
      );
      const halo = { "text-color": "#f8fafc", "text-halo-color": "rgba(0,0,0,0.85)", "text-halo-width": 1.4 };
      const name = this._placeNames();
      layers.push(
        {
          id: "label-country", type: "symbol", source: "osm", "source-layer": "boundary_labels", minzoom: 2, maxzoom: 7,
          filter: ["==", ["get", "admin_level"], 2],
          layout: {
            "text-field": name, "text-font": ["noto_sans_bold"], "text-transform": "uppercase", "text-letter-spacing": 0.1,
            "text-size": ["interpolate", ["linear"], ["zoom"], 2, 9.5, 6, 13], "text-max-width": 8,
          },
          paint: { ...halo, "text-color": "rgba(248,250,252,0.72)" },
        },
        {
          id: "label-places", type: "symbol", source: "osm", "source-layer": "place_labels", minzoom: 3,
          filter: [
            "any",
            ["in", ["get", "kind"], ["literal", ["capital", "state_capital"]]],
            ["all", [">=", ["zoom"], 5], ["==", ["get", "kind"], "city"]],
            ["all", [">=", ["zoom"], 8], ["==", ["get", "kind"], "town"]],
            ["all", [">=", ["zoom"], 11], ["in", ["get", "kind"], ["literal", ["village", "suburb"]]]],
          ],
          layout: {
            "text-field": name, "text-font": ["noto_sans_regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 10, 13],
            "symbol-sort-key": ["-", 0, ["coalesce", ["get", "population"], 0]],
          },
          paint: halo,
        }
      );
    }
    return style;
  }

  /** Place names in the user's language where the tiles have it (German), else in English. */
  _placeNames() {
    const language = this._strings.language.split("-")[0];
    const own = language === "en" ? [] : [["get", `name_${language}`]];
    return ["coalesce", ...own, ["get", "name_en"], ["get", "name"]];
  }

  _createMap() {
    const ml = this._ml;
    const home = this._payload.location;
    this._updateCompact();
    let map;
    try {
      map = new ml.Map({
        container: this._els.map,
        style: this._buildStyle(),
        center: [home.longitude, home.latitude],
        zoom: this.hasAttribute("compact") ? 1.25 : 1.65,
        maxPitch: 80,
        pixelRatio: Math.min(globalThis.devicePixelRatio || 1, 2),
        // Resizing is handled here, a frame later (see _resizeObserver).
        trackResize: false,
        attributionControl: { compact: true },
        cooperativeGestures: !!this._config.cooperative_gestures,
        locale: mapLibreLocale((key) => this._t(key)),
        transformRequest: (url) => {
          if (this._mapToken && url.startsWith(this._haUrl("/api/map_tiles/"))) {
            return { url, headers: { "X-Map-Tiles-Token": this._mapToken } };
          }
          return { url };
        },
      });
    } catch (err) {
      this._starting = false;
      this._showMessage(this._t("globe.no_webgl", { error: err?.message || err }));
      return;
    }
    this._map = map;
    this._showMessage(this._t("globe.acquiring"), { spinner: true });
    map.addControl(new ml.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(this._viewControl(), "top-right");
    const fullscreen = new ml.FullscreenControl({ container: this._wrap });
    // Tell the card, which lifts itself above the dashboard meanwhile.
    fullscreen.on("fullscreenstart", () => this.toggleAttribute("fullscreen", true));
    fullscreen.on("fullscreenend", () => this.toggleAttribute("fullscreen", false));
    map.addControl(fullscreen, "top-right");

    for (const ev of ["dragstart", "rotatestart", "pitchstart"]) {
      map.on(ev, (e) => {
        if (e.originalEvent && this._mode !== "free" && this._clock.phase !== "approach") this._setMode("free");
      });
    }
    // Zooming changes how fast the satellite crosses the screen.
    map.on("zoomend", () => this._scheduleFrames());
    map.on("render", () => this._placeLabels());
    map.on("error", (e) => this._onMapError(e));
    map.on("mousemove", (e) => this._onPointerMove(e.point));
    map.on("mouseout", () => this._onPointerMove(null));
    map.on("click", (e) => this._onMapClick(e.point));
    this._watchContext(map);

    const homeEl = document.createElement("div");
    homeEl.className = "home";
    homeEl.innerHTML = svgIcon("home");
    homeEl.title = home.title;
    // Hidden, not faded, while home is round the far side of the globe.
    this._homeMarker = new ml.Marker({ element: homeEl, opacityWhenCovered: "0" }).setLngLat([home.longitude, home.latitude]).addTo(map);

    this._night = new spaceModule.NightLayer({ getState: () => this._nightState });
    this._space = new spaceModule.SpaceLayer();
    this._cloudIdsKey = null;
    this._mapSize = [this._els.map.clientWidth, this._els.map.clientHeight];
    // The map element rather than the host: in fullscreen only the map grows.
    this._resizeObserver = new ResizeObserver(() => {
      if (this._resizePending) return;
      this._resizePending = true;
      requestAnimationFrame(() => {
        this._resizePending = false;
        if (!this._map) return;
        this._map.resize();
        this._mapSize = [this._els.map.clientWidth, this._els.map.clientHeight];
        this._applyLayout();
      });
    });
    this._resizeObserver.observe(this._els.map);
    this._loadLights(map);

    // The layers and the satellite go in as soon as the style is ready, without
    // waiting for every tile (the "load" event).
    map.once("style.load", () => {
      if (this._map !== map) return;
      map.addLayer(this._night, map.getLayer("borders-country") ? "borders-country" : undefined);
      map.addLayer(this._space);
      this._loaded = true;
      this._starting = false;
      if (this._closeupKey !== this._imageryKey()) this._setImagery();
      this._applyLayout();
      this._dataChanged();
      this._frame();
      this._setMode(this._config.view || "home", true);
      this._resume();
      map.once("render", () => this._map === map && this._showMessage(""));
    });
    map.once("load", () => {
      // Collapse the imagery credits behind (i) on small screens.
      if (this._map === map && this.clientWidth < 720) {
        this.shadowRoot.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
      }
    });
  }

  /** Start a new map when the browser takes the WebGL context away for good. */
  _watchContext(map) {
    const rebuild = () => {
      if (this._map !== map) return;
      this._teardown();
      // Off the page meanwhile: connectedCallback starts it again.
      if (this.isConnected) this._start();
    };
    const canvas = map.getCanvas();
    canvas.addEventListener("webglcontextlost", () => {
      if (this._map !== map) return;
      this._showMessage(this._t("globe.reloading"), { spinner: true });
      // The browser restores a lost context when it can. One that stays lost
      // (the GPU was reset, or too many pages use WebGL) needs a new map.
      clearTimeout(this._contextTimer);
      this._contextTimer = setTimeout(rebuild, CONTEXT_RESTORE_MS);
    });
    canvas.addEventListener("webglcontextrestored", rebuild);
  }

  _onMapError(e) {
    const status = e?.error?.status;
    const url = String(e?.error?.url || "");
    const haTiles =
      url.startsWith(this._haUrl("/api/map_tiles/")) ||
      e?.sourceId === "osm" ||
      (e?.sourceId === "closeup" && !!IMAGERY[this._closeupKey]?.homeAssistantTiles);
    const tile = e?.tile?.tileID?.canonical;
    if (haTiles && tile && e.sourceId) {
      // Remember it, to fetch again with a fresh token or once Home Assistant is back.
      const { x, y, z } = tile;
      (this._failedTiles[e.sourceId] ??= new Map()).set(`${z}/${x}/${y}`, { x, y, z });
    }
    if (status === 403 && haTiles) {
      // Home Assistant's tiles token rotated: get a new one and fetch again.
      if (!(performance.now() - this._tokenRetryAt < 30000)) {
        this._tokenRetryAt = performance.now();
        this._refreshMapToken(true);
      } else if (this._mapTokenAt > this._tokenRetryAt) {
        // Sent with the old token just before the new one came: try once more.
        clearTimeout(this._tilesTimer);
        this._tilesTimer = setTimeout(() => this._refreshHaTiles(), 1000);
      }
      return;
    }
    // Tile errors (offline, blocked) are expected now and then; keep going.
    if (status) return;
    console.debug("Satellite Spotter globe:", e?.error || e);
  }

  /** NASA's city lights for the night side; tried again later if the download fails. */
  _loadLights(map, attempt = 0) {
    if (this._config.show_night === false) return;
    const gl = map.getCanvas().getContext("webgl2");
    const maxTexture = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 2048;
    const width = maxTexture >= 4096 && this.clientWidth > 700 ? 4096 : 2048;
    spaceModule.loadCityLights(width).then((img) => {
      if (this._map !== map) return;
      if (img) this._night?.setLights(img);
      else if (attempt < 3) {
        this._lightsTimer = setTimeout(
          () => this._whenShown("lights", () => this._map === map && this._loadLights(map, attempt + 1)),
          [1, 5, 15][attempt] * 60000
        );
      }
    });
  }

  _viewControl() {
    const host = this;
    return {
      onAdd() {
        const div = document.createElement("div");
        div.className = "maplibregl-ctrl maplibregl-ctrl-group ctrl";
        // The keys of their text, so a change of language can reword them (see _applyStrings).
        const button = (key, title, onClick, label = title) => {
          const b = document.createElement("button");
          b.type = "button";
          b.dataset.tTitle = title;
          b.dataset.tLabel = label;
          b.title = host._t(title);
          b.setAttribute("aria-label", host._t(label));
          b.innerHTML = svgIcon(key);
          b.addEventListener("click", onClick);
          div.appendChild(b);
          return b;
        };
        host._buttons = {
          home: button("home", "controls.home", () => host._setMode("home")),
          follow: button("follow", "controls.follow", () => host._setMode(host._mode === "follow" ? "free" : "follow")),
          chase: button("chase", "controls.chase", () => host._setMode(host._mode === "chase" ? "free" : "chase")),
          flat: button("globe", "controls.flat", () => host._toggleFlat(), "controls.flat_label"),
          cloud: button("cloud_of_satellites", "controls.satellites", () => host._toggleCloud(), "controls.satellites_label"),
          layers: button("layers", "controls.imagery", () => host._toggleImageryMenu()),
        };
        host._buttons.layers.setAttribute("aria-expanded", "false");
        host._controlDiv = div;
        host._syncControls();
        return div;
      },
      onRemove() {},
    };
  }

  /** Show which camera modes and layers are on, to the eye and to assistive technology. */
  _syncControls() {
    const b = this._buttons;
    if (!b) return;
    for (const [key, on] of [
      ["follow", this._mode === "follow"],
      ["chase", this._mode === "chase"],
      ["flat", this._flat],
      ["cloud", this._cloudWanted()],
    ]) {
      b[key].classList.toggle("active", on);
      b[key].setAttribute("aria-pressed", String(on));
    }
  }

  /** Every satellite in the catalogue, on or off. */
  _toggleCloud() {
    this._showCloud = !this._cloudWanted();
    this._syncControls();
    if (!this._showCloud) this._setHover(null);
    this._loadCloud();
    this._courseChanged = true;
    this._frame();
    this._scheduleFrames();
    this.dispatchEvent(new CustomEvent("satellites-changed", { detail: this._showCloud, bubbles: true, composed: true }));
  }

  _toggleImageryMenu() {
    if (this._menu) {
      const hadFocus = this.shadowRoot?.activeElement === this._menu;
      this._menu.remove();
      this._menu = null;
      this._buttons?.layers?.setAttribute("aria-expanded", "false");
      if (hadFocus) this._buttons?.layers?.focus();
      return;
    }
    if (!this._controlDiv) return;
    const select = document.createElement("select");
    select.setAttribute("aria-label", this._t("controls.imagery_menu"));
    for (const [key, def] of Object.entries(IMAGERY)) {
      if (def.homeAssistantTiles && !this._haTilesAvailable()) continue;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = this._t(`controls.imagery_${key}`);
      opt.selected = key === this._imageryKey();
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this._setImagery(select.value);
      this.dispatchEvent(new CustomEvent("imagery-changed", { detail: select.value, bubbles: true, composed: true }));
      this._toggleImageryMenu();
    });
    this._controlDiv.style.position = "relative";
    // Beside the layers button that opened it.
    select.style.top = `${this._buttons.layers.offsetTop}px`;
    this._controlDiv.appendChild(select);
    this._menu = select;
    this._buttons.layers.setAttribute("aria-expanded", "true");
    select.focus();
  }

  /** Switch the close-up imagery; before the style has loaded, the change waits for it. */
  _setImagery(key) {
    if (key) this._config = { ...this._config, imagery: key };
    if (!this._map || !this._loaded) return;
    const next = this._imageryKey();
    if (next === this._closeupKey) return;
    this._map.removeLayer("closeup");
    this._map.removeSource("closeup");
    this._map.addSource("closeup", this._closeupSource(next));
    this._map.addLayer({ id: "closeup", type: "raster", source: "closeup", minzoom: 4.4, paint: { "raster-fade-duration": 200 } }, "bluemarble");
    this._closeupKey = next;
  }

  _toggleFlat() {
    this._flat = !this._flat;
    this._map.setProjection({ type: this._flat ? "mercator" : GLOBE_PROJECTION });
    this._syncControls();
  }

  /**
   * Smaller overlays where the globe is short (a phone on its side, a low
   * card), and on cards that are narrow. Fullscreen gets the full layout.
   */
  _updateCompact() {
    if (!this._wrap) return;
    const width = this._wrap.clientWidth || this.clientWidth;
    const height = this._wrap.clientHeight || this.clientHeight;
    if (!width || !height) return;
    const compact = (this.autoCompact && width < 560) || height < 420;
    if (compact !== this.hasAttribute("compact")) this.toggleAttribute("compact", compact);
  }

  /** Safe-area insets (notches, home indicators) the panel passes in, in px. */
  _insets() {
    const px = (el, prop, base) => (el ? Math.max(0, (parseFloat(getComputedStyle(el)[prop]) || 0) - base) : 0);
    const controls = this._els.map.querySelector(".maplibregl-ctrl-top-right");
    return {
      top: px(controls, "marginTop", 0),
      left: px(this._els.stack, "left", 12),
      right: px(controls, "marginRight", 0),
      bottom: px(this._els.telemetry, "bottom", 34),
    };
  }

  /** How passes are listed: "list" (beside the globe, or in a sheet), "strip" (chips) or none. */
  _passesMode() {
    const v = this._config.show_passes ?? (this._config.panel ? "list" : false);
    return v === "list" || v === "strip" ? v : false;
  }

  /** Wide views show the sky chart and pass list beside the map; narrow ones use a popover, a strip and a sheet. */
  _applyLayout() {
    if (!this._els || !this._wrap) return;
    this._updateCompact();
    const width = this._wrap.clientWidth || this.clientWidth;
    const height = this._wrap.clientHeight || this.clientHeight;
    const inset = this._insets();
    // Room for both the countdown and the side column (a landscape phone has
    // the width but not the height), clear of any notch.
    const wide = !this.hasAttribute("compact") && width - inset.left - inset.right >= 760 && height - inset.bottom >= 480;
    const changed = wide !== this._wide;
    this._wide = wide;
    this._paddingCache = null;
    this._els.side.hidden = !wide;
    this._els.passesBox.hidden = !(wide && this._passesMode() === "list");
    this._els.lookBtn.hidden = wide;
    const coarse = globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
    this.toggleAttribute("roomy", coarse && height >= 480);
    // The map buttons reach 330 px down, and the credits' (i) sits 34 px up
    // from the bottom: with less room, drop the fullscreen button rather than cover it.
    this.toggleAttribute("short", height - inset.top - inset.bottom < 372);
    // The time bar centres in the room the side column leaves.
    const side = wide ? this._els.side.offsetWidth + 56 + 12 : 0;
    this._wrap.style.setProperty("--side-w", `${side}px`);
    if (changed && this._loaded) {
      if (wide) this._closeSheet(false);
      this._renderSky(false);
      this._renderList();
      this._renderStrip();
    }
  }

  /** Camera padding so the subject stays in the part of the map the overlays leave free. */
  _padding() {
    if (this._paddingCache) return this._paddingCache;
    const width = this._wrap?.clientWidth || this.clientWidth;
    const height = this._wrap?.clientHeight || this.clientHeight;
    const side = this._els?.side;
    const right = side && !side.hidden ? side.offsetWidth + 64 : 48;
    const stack = this._els?.stack;
    const visible = stack && !this._els.mission?.hidden;
    const top = visible ? (this.hasAttribute("compact") || !this._wide ? Math.min(stack.offsetHeight * 0.9, height * 0.45) : 40) : 0;
    const bottom = this._clock.mode === "sim" ? 96 : 40;
    this._paddingCache = { top, bottom, left: 0, right: Math.min(right, width * 0.4) };
    return this._paddingCache;
  }

  /**
   * Padding for a tilted camera: the satellite, high above the point the
   * camera looks at, shows above it, so the cards at the top leave it room.
   */
  _tiltPadding() {
    const pad = this._padding();
    const stack = this._els?.stack;
    const height = this._wrap?.clientHeight || this.clientHeight || 0;
    const top = stack && !this._els.mission?.hidden ? stack.offsetHeight + 8 : pad.top;
    return { ...pad, top: Math.max(pad.top, Math.min(top, height * 0.5)) };
  }

  /** "home" is a one-off camera move; "follow" and "chase" keep tracking the satellite. */
  _setMode(mode, initial = false) {
    const previous = this._mode;
    this._mode = mode === "home" ? "free" : mode;
    this._syncControls();
    const map = this._map;
    if (!map) return;
    const pos = this._position;
    const home = this._payload?.location;
    const duration = initial || prefersReducedMotion() ? 0 : 1600;
    const padding = this._padding();
    this._pendingCamera = null;
    if (mode === "home" && home) {
      map.flyTo({
        center: [home.longitude, home.latitude],
        zoom: initial ? map.getZoom() : Math.max(Math.min(map.getZoom(), 3), 1.8),
        pitch: 0,
        bearing: 0,
        padding,
        duration,
      });
    } else if (mode === "follow" || mode === "chase") {
      if (!pos) {
        // No position yet: the first frame with one moves the camera.
        this._pendingCamera = mode;
      } else if (mode === "follow") {
        const zoom = Math.min(map.getZoom(), 3.2, this._trackZoomLimit(pos, 0));
        map.easeTo({ center: [pos.lon, pos.lat], pitch: 0, bearing: 0, zoom, padding, duration });
      } else {
        const zoom = Math.min(3.3, this._trackZoomLimit(pos, CHASE_PITCH));
        map.easeTo({ center: [pos.lon, pos.lat], zoom, pitch: CHASE_PITCH, bearing: pos.heading, padding: this._tiltPadding(), duration });
      }
    }
    if (previous !== this._mode) this._scheduleFrames();
  }

  /**
   * The closest zoom from which a camera at this pitch, looking at the point
   * under a satellite, still has the satellite in front of it. MapLibre's
   * camera is height / (2 tan(fov / 2)) px from that point, where an Earth
   * radius is 512 * 2^zoom / (2π cos latitude) px; the satellite is drawn at
   * its display altitude above it, so a camera zoomed in past it (high orbits,
   * small maps, high latitudes) would leave it behind and draw nothing of it.
   */
  _trackZoomLimit(pos, pitch) {
    const map = this._map;
    const height = map?.getCanvas?.().clientHeight;
    const fov = map?.getVerticalFieldOfView?.();
    if (!(height > 0) || !(fov > 0)) return Infinity;
    const cameraPx = height / (2 * Math.tan((fov * DEG) / 2));
    // The satellite's height along the line of sight, and the room the camera keeps beyond it, in Earth radii.
    const needed = (displayAltitudeKm(pos.alt) / GLOBE_RADIUS_KM) * Math.cos(pitch * DEG) + TRACK_CLEARANCE;
    return Math.log2((cameraPx * 2 * Math.PI * Math.max(Math.cos(pos.lat * DEG), 0.01)) / (512 * needed));
  }

  // -- course -------------------------------------------------------------

  /** Rebuild the orbit, the pass, the cone and the pins (when the data changes, not every frame). */
  _buildCourse() {
    const p = this._payload;
    if (!this._space || !p) return;
    const space = this._space;
    const rows = this._courseRows();
    this._baseT = rows[0]?.[0] ?? Math.floor(this._simNow());
    this._courseChanged = true;
    space.setLine("orbit", rows, this._baseT);

    // The shown pass: its leader's visible part in gold, the others' thin.
    const pass = this._shownPass();
    const detail = pass && this._details.get(pass.id);
    space.clearLines?.("member:");
    if (detail) {
      const lead = detail.transits[0];
      space.setLine("pass", rowsBetween(lead.rows, lead.visible_start ?? pass.start, lead.visible_end ?? pass.end), this._baseT);
      let lines = 0;
      for (const t of detail.transits.slice(1)) {
        if (!t.rows || lines >= MAX_MEMBER_LINES) continue;
        lines++;
        space.setLine(`member:${t.norad_id}`, rowsBetween(t.rows, t.visible_start, t.visible_end), this._baseT, { style: "member" });
      }
    } else {
      space.setLine("pass", [], 0);
    }
    const approach = this._clock.mode === "sim" ? null : this._approaches.get(pass?.id);
    space.setLine("approach", approach || [], this._baseT);

    const home = p.location;
    if (this._homeMarker) {
      this._homeMarker.setLngLat([home.longitude, home.latitude]);
      this._homeMarker.getElement().title = home.title;
    }
    // The cone of sky the satellite can be seen in: at its altitude over home, above 10°.
    const near = detail ? rowsBetween(detail.transits[0].rows, pass.start, pass.end) : rows;
    const alts = (near.length ? near : rows).map((r) => r[3]).filter(Number.isFinite);
    const alt = alts.length ? alts.reduce((s, a) => s + a, 0) / alts.length : 420;
    this._meanAlt = alt;
    const radius = visibilityRadius(alt, p.settings?.min_elevation ?? 10);
    const ring = circleRing(home.latitude, home.longitude, radius, 128);
    space.setCone(home, ring, alt * 1000, radius);
    space.setRing("coneRing", ring, alt * 1000);
    this._makePins(pass, detail);
  }

  _makePins(pass, detail) {
    const pins = [];
    const lead = detail?.transits?.[0];
    const rows = lead ? rowsBetween(lead.rows, lead.visible_start ?? pass.start, lead.visible_end ?? pass.end) : [];
    if (pass && rows.length && this._config.show_track !== false) {
      const r = rows[0];
      const cloudy = this._fmt.cloud(pass.cloud_cover)?.level === "cloudy";
      pins.push({
        key: "pin-pass",
        cls: pass.bright && !cloudy && !pass.before_sunset ? "pin" : "pin dim",
        lat: r[1], lon: r[2], alt: r[3] * 1000,
        start: pass.start, end: pass.end,
        text: this._t("pass.pin", {
          title: this._fmt.passTitle(pass),
          time: this._fmt.time(pass.start),
          magnitude: this._fmt.magnitude(pass.magnitude),
        }),
        title: this._t("pass.simulate_this"),
        onClick: () => this._select(pass.id, { view: "simulate", frame: false }),
      });
    }
    this._pins = pins;
    for (const [key, el] of this._labels) {
      if (key.startsWith("pin") && !pins.some((q) => q.key === key)) {
        el.remove();
        this._labels.delete(key);
      }
    }
    for (const pin of pins) {
      let el = this._labels.get(pin.key);
      if (!el) {
        el = document.createElement("button");
        el.type = "button";
        el.addEventListener("click", () => this._pins.find((q) => q.key === pin.key)?.onClick());
        this._els.labels.appendChild(el);
        this._labels.set(pin.key, el);
      }
      el.className = `flabel ${pin.cls}`;
      el.textContent = pin.text;
      el.title = pin.title;
    }
  }

  _clearTicks() {
    for (const [key, el] of this._labels) {
      if (key.startsWith("tick-")) {
        el.remove();
        this._labels.delete(key);
      }
    }
  }

  /** Clock ticks along the orbit ahead, about six per period (live only). */
  _ticks(now) {
    if (this._clock.mode === "sim" || this._config.show_track === false) return [];
    const rows = this._courseRows();
    if (!rows.length) return [];
    const step = tickStepMinutes(this._periodS()) * 60;
    const out = [];
    const last = Math.min(now + this._periodS(), rows[rows.length - 1][0]);
    for (let t = Math.ceil((now + 120) / step) * step; t <= last; t += step) {
      const pos = positionAt(rows, t);
      if (pos) out.push({ t, ...pos });
    }
    return out;
  }

  /** The moment shown: the simulation's, else Home Assistant's now (unix s). */
  _simNow() {
    return this._clock.simMs / 1000;
  }

  /** The other satellites of the shown pass, where their rows reach, as small sprites. */
  _memberObjects(t, zoom) {
    const pass = this._shownPass();
    const detail = pass && this._details.get(pass.id);
    if (!detail) return [];
    const focus = this._focusInfo()?.norad_id;
    const size = clamp(6 + zoom * 1.8, 7, 15);
    const out = [];
    for (let i = 0; i < detail.transits.length && out.length < MAX_MEMBER_DOTS; i++) {
      const tr = detail.transits[i];
      if (tr.norad_id === focus) continue;
      const pos = transitPositionAt(detail, i, t);
      if (!pos) continue;
      const ahead = transitPositionAt(detail, i, t + 20) || pos;
      const [mx, my] = spaceModule.toMercator(pos.lat, pos.lon);
      const [ax, ay] = spaceModule.toMercator(ahead.lat, ahead.lon);
      out.push({
        id: tr.norad_id, kind: tr.kind, center: [mx, my, pos.alt * 1000], ahead: [ax, ay, ahead.alt * 1000],
        ground: [mx, my, 0], sunlit: pos.sunlit, size, primary: false,
      });
    }
    return out;
  }

  /** Move the satellites, the camera and the lighting to the current moment. */
  _frame() {
    const p = this._payload;
    const map = this._map;
    if (!map || !this._loaded || !p || this._suspended) return;
    this._inFrame = true;
    try {
      this._drawFrame(p, map);
    } finally {
      this._inFrame = false;
    }
  }

  _drawFrame(p, map) {
    // Advance the shared clock (the time bar and the street view read it too).
    const t = this._clock.tick(performance.now()) / 1000;
    const rows = this._courseRows();
    const pos = positionAt(rows, t);
    const zoom = map.getZoom();
    const objects = [];
    const focus = this._focusInfo();
    let footprint = null;
    if (pos) {
      this._staleDelay = this._staleRetryAt = 0;
      const ahead = positionAt(rows, t + 20) || pos;
      pos.heading = bearing(pos.lat, pos.lon, ahead.lat, ahead.lon);
      this._position = pos;
      if (this._pendingCamera) this._setMode(this._pendingCamera);
      const [mx, my] = spaceModule.toMercator(pos.lat, pos.lon);
      const [ax, ay] = spaceModule.toMercator(ahead.lat, ahead.lon);
      objects.push({
        id: focus?.norad_id, kind: focus?.kind, center: [mx, my, pos.alt * 1000], ahead: [ax, ay, ahead.alt * 1000],
        ground: [mx, my, 0], sunlit: pos.sunlit, size: Math.max(15, Math.min(34, 13 + zoom * 3.2)), primary: true,
      });
      footprint = circleRing(pos.lat, pos.lon, visibilityRadius(pos.alt, 0));
    } else {
      this._position = null;
      // Live, the orbit ran out (or never came): fetch it again, backing off.
      if (this._clock.mode === "live" && !this._payload.paused) this._refreshStale();
    }
    objects.push(...this._memberObjects(t, zoom));
    const ticks = this._ticks(t);
    this._tickList = ticks;
    const showFootprint = this._config.show_footprint !== false && !!footprint;
    if (showFootprint) this._space.setRing("footprint", footprint, 0);
    this._space.setFrame({
      now: t - this._baseT,
      pixelRatio: map.getPixelRatio(),
      showTrack: this._config.show_track !== false,
      showCone: this._config.show_home_zone !== false,
      showFootprint,
      coneAlpha: lerp(0.16, 0.08, (zoom - 3) / 3),
      objects,
      ticks: ticks.map((k) => [...spaceModule.toMercator(k.lat, k.lon), k.alt * 1000]),
      spans: spaceModule.orbitSpans?.(this._periodS()),
      reducedMotion: prefersReducedMotion(),
    });
    this._updateCloud(t);
    this._nightState = {
      visible: this._config.show_night !== false,
      sun: sunVector(new Date(t * 1000)),
      strength: lerp(0.95, 0.32, (zoom - 4.5) / 3.5),
      lightsMix: lerp(1, 0, (zoom - 4.5) / 2),
    };
    const sim = this._clock.mode === "sim";
    if (sim) {
      // The sky chart's dot and the sunlight follow the simulation, a few times a second.
      const nowReal = performance.now();
      if (nowReal - (this._skyAt || 0) > 120) {
        this._skyAt = nowReal;
        this._renderSky(false);
      }
      if (nowReal - (this._lightAt || 0) > 400) {
        this._lightAt = nowReal;
        map.setLight(sunLight(new Date(t * 1000), 300));
      }
      // Simulated time runs fast: the card's countdown follows it a few times a second.
      if (nowReal - (this._missionAt || 0) > 200 && this._els?.mission) {
        this._missionAt = nowReal;
        this._renderMission();
      }
      this._timebar?.update();
    }
    // During the fast-forward the camera jumps every frame and MapLibre's label
    // placement lags behind it, drawing the far side's names through the globe:
    // the labels wait for the replay.
    this._hideLabels(!!(sim && this._clock.phase === "approach"));
    // Moving the camera repaints by itself; otherwise ask for one frame.
    let moved = false;
    if (!map.isMoving()) {
      if (sim && this._clock.phase === "approach" && pos) {
        // On the way to the pass the camera rides along, from far enough out to
        // see the globe turn. MapLibre's globe keeps Mercator zoom, so the same
        // zoom shows the globe 1/cos(latitude) times larger near the poles,
        // where most of these orbits go: take that back out (from a zoom fixed
        // when the ride starts, so it cannot creep in from frame to frame).
        const ride = this._sim ?? {};
        ride.approachZoom ??= clamp(zoom, 1.4, 2);
        const shrink = Math.log2(Math.max(Math.cos(pos.lat * DEG), 0.15));
        map.jumpTo({ center: [pos.lon, pos.lat], zoom: ride.approachZoom + shrink, pitch: 0, bearing: 0, padding: this._padding() });
        moved = true;
      } else if (pos && this._mode === "follow") {
        // Out again if the satellite climbs, nears a pole or the user zoomed in past it.
        const capped = Math.min(zoom, this._trackZoomLimit(pos, 0));
        map.jumpTo({ center: [pos.lon, pos.lat], zoom: capped, padding: this._padding() });
        moved = true;
      } else if (pos && this._mode === "chase") {
        const capped = Math.min(zoom, this._trackZoomLimit(pos, CHASE_PITCH));
        map.jumpTo({ center: [pos.lon, pos.lat], zoom: capped, bearing: pos.heading, padding: this._tiltPadding() });
        moved = true;
      }
    }
    if (!moved) {
      // Every frame while something can be seen moving; otherwise now and
      // then, or as soon as the course changes.
      const idle = !(sim && this._clock.playing) && this._onScreenSpeed === 0 && !this._space.animating;
      const now = performance.now();
      if (!idle || this._courseChanged || !(now - this._repaintAt < IDLE_REPAINT_MS)) {
        this._courseChanged = false;
        this._repaintAt = now;
        map.triggerRepaint();
      }
    }
  }

  /** Hide or show the place names (read from the layers, so a new style cannot leave them hidden). */
  _hideLabels(hidden) {
    const map = this._map;
    const want = hidden ? "none" : "visible";
    for (const id of ["label-country", "label-places"]) {
      if (!map?.getLayer?.(id)) continue;
      if ((map.getLayoutProperty(id, "visibility") ?? "visible") !== want) map.setLayoutProperty(id, "visibility", want);
    }
  }

  _updateLight(transitionMs = 0) {
    if (!this._map || !this._loaded) return;
    this._map.setLight(sunLight(new Date(this._simNow() * 1000), transitionMs));
  }

  /** Floating labels at true 3D positions, after each rendered frame. */
  _placeLabels() {
    const space = this._space;
    if (!space || !this._els) return;
    const [w, h] = this._mapSize || [this._els.map.clientWidth, this._els.map.clientHeight];
    const show = (el, pt, dx, dy) => {
      if (!pt) {
        el.style.visibility = "hidden";
        return;
      }
      el.style.visibility = "visible";
      el.style.transform = `translate3d(${(pt.x + dx).toFixed(1)}px, ${(pt.y + dy).toFixed(1)}px, 0)`;
    };
    const t = this._simNow();
    for (const pin of this._pins || []) {
      const el = this._labels.get(pin.key);
      if (!el) continue;
      if (!el._size || el._text !== el.textContent) {
        el._size = [el.offsetWidth, el.offsetHeight];
        el._text = el.textContent;
      }
      const pt = space.project(pin.lat, pin.lon, pin.alt, w, h);
      // Kept left of the map's control column (on phones the label would run
      // under it), and never off the left edge for that.
      let dx = -el._size[0] / 2;
      const ctrl = this._ctrlRect;
      if (pt && ctrl && pt.y - el._size[1] - 12 < ctrl.bottom) {
        const over = pt.x + dx + el._size[0] - (ctrl.left - 6);
        if (over > 0) dx -= Math.min(over, Math.max(0, pt.x + dx - 6));
      }
      // While the pass is on, the pin would cover the satellite; under a
      // panel it would peek out in pieces: it steps aside.
      const box = pt && { left: pt.x + dx, top: pt.y - el._size[1] - 12, right: pt.x + dx + el._size[0], bottom: pt.y - 12 };
      const covered = !!box && (this._hudRects || []).some((r) => box.left < r.right && r.left < box.right && box.top < r.bottom && r.top < box.bottom);
      el.classList.toggle("away", covered || (t >= pin.start - 30 && t <= pin.end + 30));
      show(el, pt, dx, -el._size[1] - 12);
    }
    const keep = new Set();
    for (const tk of this._tickList || []) {
      const key = `tick-${tk.t}`;
      keep.add(key);
      let el = this._labels.get(key);
      if (!el) {
        el = document.createElement("div");
        el.className = "flabel tick";
        el.textContent = this._fmt.time(tk.t);
        this._els.labels.appendChild(el);
        this._labels.set(key, el);
      }
      show(el, space.project(tk.lat, tk.lon, tk.alt * 1000, w, h), 8, -7);
    }
    for (const [key, el] of this._labels) {
      if (key.startsWith("tick-") && !keep.has(key)) {
        el.remove();
        this._labels.delete(key);
      }
    }
  }

  // -- HUD ------------------------------------------------------------------

  /** Text in the user's language. */
  _t(key, vars) {
    return this._strings.t(key, vars);
  }

  /** The same as HTML; the values go in as they are, so escape them first. */
  _html(key, vars) {
    return this._strings.html(key, vars);
  }

  /** "SW → ENE · up to 67° · 6 min · very bright, mag −3.4". */
  _passSummary(pass) {
    const fmt = this._fmt;
    const lead = leader(pass);
    const parts = [];
    if (lead?.rise?.direction && lead?.set?.direction) {
      parts.push(`${fmt.direction(lead.rise.direction)} → ${fmt.direction(lead.set.direction)}`);
    }
    if (Number.isFinite(pass.peak?.elevation)) parts.push(this._t("pass.up_to", { elevation: Math.round(pass.peak.elevation) }));
    if (Number.isFinite(pass.duration)) parts.push(fmt.duration(pass.duration));
    if (Number.isFinite(pass.magnitude)) {
      parts.push(this._t("mission.brightness", { word: fmt.brightness(pass.magnitude).word, magnitude: fmt.magnitude(pass.magnitude) }));
    }
    return parts.join(" · ");
  }

  /**
   * What can make a pass harder (or easier) to see: the forecast cloud (for
   * its hour), a bright Moon up at the time, a sky still bright before
   * sunset, a train to scan for, a famous satellite riding along,
   * predictions from old orbit data. [{cls, icon | glyph, text}]
   */
  _conditions(pass) {
    const out = [];
    const cloud = this._fmt.cloud(pass.cloud_cover);
    if (cloud) out.push({ cls: cloud.level, icon: "cloud", text: passesModule.cloudText(pass, this._fmt) });
    const moon = passesModule.passMoon(pass, this._payload?.location);
    if (moon) out.push({ cls: "moon", glyph: passesModule.moonGlyph(moon), text: passesModule.moonText(moon, this._fmt) });
    if (pass.before_sunset) out.push({ cls: "warn", icon: "sun", text: this._t("mission.before_sunset") });
    if (pass.train) out.push({ cls: "", icon: "train", text: this._t("mission.train_hint") });
    const notable = passesModule.notableMember?.(pass);
    if (notable) out.push({ cls: "gold", icon: kindIcon(notable.kind), text: this._t("mission.with", { name: notable.name }) });
    const confidence = leader(pass)?.confidence;
    if (confidence === "medium" || confidence === "low") {
      out.push({ cls: "dim", icon: "info", text: this._t(`mission.confidence_${confidence}`) });
    }
    return out;
  }

  _tick() {
    const p = this._payload;
    if (!p || !this._els || !this._loaded) return;
    const realS = this._now() / 1000;
    this._measureHud();
    // As time passes, the live or next pass changes.
    if (!this._userSelected && this._clock.mode === "live" && (this._autoPass(realS)?.id ?? null) !== this._selectedId) {
      this._reconcileSelection();
    }
    this._paddingCache = null;
    const pos = this._position;
    const look = pos ? lookAngles(p.location, pos) : null;
    this._renderMission();
    this._renderTelemetry(pos, look);
    this._passList?.setNow?.(realS);
    this._renderStrip();
    const pass = this._shownPass();
    const t = this._simNow();
    if (pass && t >= pass.start - 60 && t <= pass.end + 60 && this._clock.mode === "live") this._renderSky(false);
    this._updateCloudFlags();
    this._loadFocusTrack();
    this._refreshAfterPass(realS);
  }

  /** Where the panels are over the map (for labels to keep out from under them). */
  _measureHud() {
    const wrap = this._wrap?.getBoundingClientRect?.();
    if (!wrap) return;
    const e = this._els;
    this._hudRects = [e.stack, e.side, e.telemetry, e.timebarHost, e.skyPop, e.sheet]
      .filter((el) => el && !el.hidden && el.offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left - wrap.left, top: r.top - wrap.top, right: r.right - wrap.left, bottom: r.bottom - wrap.top };
      })
      .filter((r) => r.right > r.left && r.bottom > r.top);
    const ctrl = this._map?.getContainer?.()?.querySelector?.(".maplibregl-ctrl-top-right")?.getBoundingClientRect?.();
    this._ctrlRect = ctrl?.width ? { left: ctrl.left - wrap.left, bottom: ctrl.bottom - wrap.top } : null;
  }

  /** The mission card: the shown pass, its countdown, and what to expect. */
  _renderMission() {
    const e = this._els;
    const p = this._payload;
    const fmt = this._fmt;
    if (!e?.label || !p) return;
    e.mission.hidden = this._config.show_countdown === false;
    const sim = this._clock.mode === "sim";
    const paused = !!p.paused && !sim;
    const pass = paused ? null : this._shownPass();
    const t = this._simNow();
    const realS = this._now() / 1000;
    const state = paused ? "paused" : !pass ? "empty" : t >= pass.start && t < pass.end ? "now" : t >= pass.end ? "after" : "before";
    e.mission.classList.toggle("now", state === "now");
    e.mission.classList.toggle("sim", sim);
    e.mission.classList.toggle("paused", paused);
    e.mission.classList.toggle("empty", state === "empty");
    const lead = leader(pass);
    // The state line and the brightness chip.
    let label;
    if (paused) label = "mission.paused";
    else if (sim) label = this._clock.phase === "approach" ? "mission.sim_approach" : "mission.simulation";
    else if (state === "now") label = "mission.visible_now";
    else if (!pass) label = "mission.next_pass";
    else if (passesModule.nextPass(this._listedPasses(realS), realS)?.id !== pass.id) label = "mission.selected_pass";
    // "Bright only" in the list: the next of those (the passes card's words).
    else label = this._filters.brightOnly && pass.bright ? "card.next_bright_pass" : "mission.next_pass";
    setText(e.label, this._t(label));
    e.chip.hidden = !pass;
    if (pass) {
      const cls = pass.bright ? "chip gold" : "chip mag";
      if (e.chip.className !== cls) e.chip.className = cls;
      setHtml(e.chip, pass.bright ? `${svgIcon("star")}${esc(this._t("mission.bright"))}` : esc(this._t("mission.mag", { magnitude: fmt.magnitude(pass.magnitude) })));
    }
    // What it is.
    e.title.hidden = !pass;
    if (pass) {
      const icon = kindIcon(pass.kind, { train: pass.train });
      const kindCls = `kind ${icon}`;
      if (e.kind.className !== kindCls) e.kind.className = kindCls;
      setHtml(e.kind, svgIcon(icon));
      setText(e.name, fmt.passTitle(pass));
      const url = lead?.info_url;
      e.about.hidden = !url;
      if (url && e.about.getAttribute("href") !== url) e.about.setAttribute("href", url);
      e.about.setAttribute("aria-label", this._t("mission.about_name", { name: lead?.name ?? "" }));
    }
    // Why there is nothing, unless the list beside says so already.
    e.why.hidden = state !== "empty" || (!!this._wide && this._passesMode() === "list");
    // The countdown, or where to look while it is up.
    if (paused) {
      setText(e.clock, this._t("mission.paused_clock"));
      setText(e.when, Number.isFinite(p.paused_days) ? this._t("mission.paused_age", { count: p.paused_days }) : p.paused);
      setText(e.detail, this._t("mission.paused_detail"));
    } else if (!pass) {
      const days = p.settings?.days ?? 5;
      setText(e.clock, this._t("mission.none_soon"));
      setText(e.when, this._t("passes.empty", { count: days }));
      setText(e.detail, "");
      setText(e.whyCheck, this._t("passes.check_back_text", { count: days }));
    } else if (state === "now") {
      const at = this._lookTarget(pass, t);
      const look = at ? lookAngles(p.location, at) : null;
      setText(
        e.clock,
        look && look.elevation > 0
          ? this._t("mission.look_up", { direction: fmt.direction(compass(look.azimuth)), elevation: Math.round(look.elevation) })
          : this._t("mission.look_towards", { direction: fmt.direction(pass.peak?.direction ?? lead?.peak?.direction) })
      );
      const endKey = lead?.end_reason === "shadow" ? "mission.ends_shadow" : lead?.end_reason === "sky" ? "mission.ends_sky" : "mission.ends_in";
      setText(e.when, this._t(endKey, { countdown: fmt.countdown((pass.end - t) * 1000), direction: fmt.direction(lead?.set?.direction) }));
      setText(
        e.detail,
        Number.isFinite(pass.magnitude)
          ? this._t("mission.brightness_now", { word: fmt.brightness(pass.magnitude).word, magnitude: fmt.magnitude(pass.magnitude) })
          : ""
      );
    } else {
      setText(e.clock, state === "after" ? this._t("mission.passed") : fmt.countdown((pass.start - t) * 1000));
      let when = this._t("mission.when", { day: fmt.group(pass.start, realS).label, time: fmt.time(pass.start) });
      // A pass soon but a few times round the Earth away: how many.
      const orbits = Math.floor((pass.start - t) / (lead?.period_s || DEFAULT_PERIOD_S));
      if (state === "before" && orbits >= 1 && pass.start - t < APPROACH_MAX_S) when += ` · ${this._t("pass.orbits_away", { count: orbits })}`;
      setText(e.when, when);
      setText(e.detail, this._passSummary(pass));
    }
    const conds = pass && !paused ? this._conditions(pass) : [];
    // Why the catalogue is old: the download's error, which can be long (an address).
    if (paused && p.paused_error && Number.isFinite(p.paused_days)) conds.push({ cls: "dim error", icon: "info", text: p.paused_error });
    setHtml(e.conds, conds.map((c) => `<span class="c ${c.cls}" title="${esc(c.text)}">${c.glyph ?? svgIcon(c.icon)}<span>${esc(c.text)}</span></span>`).join(""));
    // The buttons.
    e.simBtn.hidden = !pass || sim;
    e.simBtn.disabled = !!this._simPending;
    e.streetBtn.hidden = !pass || this._config.street_view === false;
    e.lookBtn.hidden = !pass || !!this._wide;
    e.lookBtn.setAttribute("aria-expanded", String(!!this._skyOpen && !e.skyPop.hidden));
    // Said once per change of state or pass: "Visible now. Look NNE, 25° up".
    const key = `${state}|${sim}|${pass?.id ?? ""}`;
    const said = state === "now" ? [`${e.label.textContent}.`, e.clock.textContent] : [`${e.label.textContent}:`, pass ? e.name.textContent : "", e.when.textContent];
    this._announce(said.filter(Boolean).join(" "), key);
  }

  /**
   * Where to look at t: the highest satellite of the pass that can be seen
   * then (a train's leader may have set while the others still pass), else
   * the leader.
   */
  _lookTarget(pass, t) {
    const detail = this._details.get(pass.id);
    let best = null;
    let bestEl = -Infinity;
    for (let i = 0; detail && i < detail.transits.length; i++) {
      const tr = detail.transits[i];
      if (!(t >= tr.visible_start && t <= tr.visible_end)) continue;
      const pos = transitPositionAt(detail, i, t);
      if (!pos) continue;
      const el = lookAngles(this._payload.location, pos).elevation;
      if (el > bestEl) {
        bestEl = el;
        best = pos;
      }
    }
    return best ?? this._leaderPosition(pass, t);
  }

  /** Where the pass's leader is at t (from its rows, else the orbit). */
  _leaderPosition(pass, t) {
    const detail = this._details.get(pass.id);
    return positionAt(detail ? transitRows(detail, 0) : null, t) ?? (leader(pass)?.norad_id === this._focusInfo()?.norad_id ? this._position : null);
  }

  /**
   * Once a pass in the data is over, ask for the passes again, rather than
   * wait for the five-minute refresh (cloud forecasts move on). Once per
   * pass; re-armed when the view resumes.
   */
  _refreshAfterPass(nowS) {
    if (!this._running || this._clock.mode === "sim") return;
    const over = passesModule.endedPass(this._passes(), nowS);
    // Passes that ended before the data was made (it starts a little in the past) do not count.
    if (!over || !(over.end > (this._payload?.generated_at ?? 0)) || over.id === this._refreshedAfter) return;
    this._refreshedAfter = over.id;
    clearTimeout(this._passRefreshTimer);
    // A moment after the end, so Home Assistant has moved on too; not if
    // another refresh has brought newer passes meanwhile.
    this._passRefreshTimer = setTimeout(() => {
      if (passesModule.endedPass(this._passes(), this._now() / 1000)?.id === over.id) this._refresh();
    }, 2000);
  }

  /** Tell screen readers when the state changes, not every second. */
  _announce(text, key) {
    if (key === this._announcedKey) return;
    const first = this._announcedKey === undefined;
    this._announcedKey = key;
    if (!first && this._els?.announce) this._els.announce.textContent = text;
  }

  _renderTelemetry(pos, look) {
    const el = this._els.telemetry;
    // During a simulation its time bar takes this place at the bottom.
    if (!pos || this._config.show_stats === false || this._clock.mode === "sim") {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const fmt = this._fmt;
    const f = this._focusInfo();
    const speed = speedFromRows(this._courseRows(), pos.t) ?? orbitalSpeed(pos.alt, semiMajorAxisKm(f.period_s || DEFAULT_PERIOD_S));
    const lat = `${fmt.num(Math.abs(pos.lat), 2)}° ${fmt.direction(pos.lat >= 0 ? "N" : "S")}`;
    const lon = `${fmt.num(Math.abs(pos.lon), 2)}° ${fmt.direction(pos.lon >= 0 ? "E" : "W")}`;
    const home = this._payload.location;
    const ground = groundDistanceKm(home.latitude, home.longitude, pos.lat, pos.lon);
    const approx = this._payload.paused ? ` ${esc(this._t("telemetry.approximate"))}` : "";
    let away = this._html("telemetry.distance", { distance: `<b>${esc(fmt.distance(ground))}</b>`, place: esc(home.title) });
    if (look && look.elevation > 0) away += ` · ${esc(this._t("telemetry.above_horizon", { elevation: Math.round(look.elevation) }))}`;
    const html = `
      <span class="who">${svgIcon(kindIcon(f.kind))}${esc(f.name)}</span>
      <span>${this._html("telemetry.altitude", { value: `<b>${esc(fmt.altitude(pos.alt))}</b>` })}</span>
      <span>${this._html("telemetry.speed", { value: `<b>${esc(fmt.speed(speed))}</b>` })}</span>
      <span class="opt"><b>${esc(lat)}, ${esc(lon)}</b>${approx}</span>
      <span class="${pos.sunlit ? "lit" : "dark"}">${esc(this._t(pos.sunlit ? "telemetry.sunlit" : "telemetry.shadow"))}</span>
      <span class="opt">${away}</span>`;
    if (html !== this._telemetryHtml) {
      el.innerHTML = html;
      this._telemetryHtml = html;
    }
  }

  _closeSkyPop(returnFocus) {
    this._skyOpen = false;
    this._renderSky(false);
    if (returnFocus && !this._els.lookBtn.hidden) this._els.lookBtn.focus();
  }

  /** The sky chart's data for a pass: from its rows, or from the three look angles until they come. */
  _skyDataFor(pass) {
    const detail = this._details.get(pass.id);
    const lead = leader(pass);
    if (detail) {
      const [first, ...others] = detail.transits;
      const track = skyPoints(first.rows);
      const members = others
        .filter((m) => m.rows)
        .map((m) => ({ track: skyPoints(m.rows), visibleStart: m.visible_start, visibleEnd: m.visible_end }));
      return { track, members, visibleStart: first.visible_start ?? pass.start, visibleEnd: first.visible_end ?? pass.end };
    }
    // Rise, highest point and set until the rows are in.
    const pts = [
      lead?.rise && { t: lead.start, azimuth: lead.rise.azimuth, elevation: lead.rise.elevation },
      lead?.peak && { t: lead.peak.time, azimuth: lead.peak.azimuth, elevation: lead.peak.elevation },
      lead?.set && { t: lead.end, azimuth: lead.set.azimuth, elevation: lead.set.elevation },
    ].filter((q) => q && Number.isFinite(q.t) && Number.isFinite(q.azimuth));
    return { track: pts.sort((a, b) => a.t - b.t), members: [], visibleStart: pass.start, visibleEnd: pass.end };
  }

  _renderSky(rebuild) {
    const p = this._payload;
    if (!p || !this._els) return;
    const paused = p.paused && this._clock.mode !== "sim";
    const pass = paused ? null : this._shownPass();
    const wide = !!this._wide;
    const target = wide ? this._els.skySide : this._els.skyPop;
    this._els.skyPop.hidden = wide || !this._skyOpen || !pass;
    this._els.skySide.hidden = !pass;
    this._els.lookBtn.setAttribute("aria-expanded", String(!this._els.skyPop.hidden));
    if (!pass) return;
    if (target.hidden) {
      // Nothing to draw while no one can see it: opening it draws it, and
      // rebuilds then what was asked to be rebuilt meanwhile.
      if (rebuild) this._skyData = null;
      return;
    }
    const fmt = this._fmt;
    const key = `${pass.id}|${this._details.has(pass.id)}`;
    if (rebuild || !this._skyData || this._skyFor !== key) {
      this._skyData = this._skyDataFor(pass);
      this._skyFor = key;
    }
    // The star marks the group's brightest satellite: the magnitude the mission card gives.
    const best = passesModule.brightestMember(pass);
    const t = this._simNow();
    const inPass = t >= this._skyData.visibleStart - 60 && t <= this._skyData.visibleEnd + 60;
    // The dot shows where to look: a train's leader may have set while the others still pass.
    const at = inPass ? this._lookTarget(pass, t) : null;
    const live = at ? lookAngles(p.location, at) : null;
    const size = wide ? 232 : 200;
    // Without the live position: that only moves the dot (below).
    const svg = skyChartSvg({
      ...this._skyData,
      brightest: best?.brightest ? { ...best.brightest, text: fmt.magnitude(best.magnitude ?? pass.magnitude) } : null,
      formatTime: (s) => fmt.time(s),
      size,
      // Both charts can be in the page at once; each needs its own gradient.
      id: wide ? "sky-side" : "sky-pop",
      cardinals: fmt.list("sky.cardinals"),
      label: this._t("sky.chart"),
    });
    setText(target.querySelector(".sub"), `${fmt.group(pass.start, this._now() / 1000).label} · ${fmt.time(pass.start)}`);
    const chart = target.querySelector(".chart");
    if (this._skyCharts.get(chart) !== svg) {
      chart.innerHTML = svg;
      this._skyCharts.set(chart, svg);
      // Keep the live dot's pulse in step across redraws instead of restarting it.
      const pulse = chart.querySelector(".live-halo")?.getAnimations?.()[0];
      if (pulse) pulse.startTime = 0;
    }
    const dot = chart.querySelector(".live-dot");
    const xy = skyDotXY(live, size);
    if (dot && xy) {
      dot.setAttribute("transform", skyDotTransform(xy));
      dot.removeAttribute("display");
    } else if (dot) {
      dot.setAttribute("display", "none");
    }
    setText(target.querySelector(".caption"), this._skyCaption(pass));
  }

  /** "Appears out of Earth's shadow in the NNE, 56° up, climbs to 56° in the NNE, fades from view in the NE." */
  _skyCaption(pass) {
    const lead = leader(pass);
    if (!lead?.rise || !lead?.set) return "";
    const fmt = this._fmt;
    const start = this._t(`sky.start_${lead.start_reason === "shadow" ? "shadow" : lead.start_reason === "rise" ? "rise" : "sky"}`, {
      direction: fmt.direction(lead.rise.direction),
      elevation: Math.round(lead.rise.elevation),
    });
    const top = lead.peak ?? pass.peak;
    const end = this._t(`sky.end_${lead.end_reason === "shadow" ? "shadow" : lead.end_reason === "set" ? "set" : "sky"}`, {
      direction: fmt.direction(lead.set.direction),
      elevation: Math.round(lead.set.elevation),
    });
    // Highest as it appears (out of Earth's shadow, say): nothing to climb.
    if (!top || Math.round(top.elevation) <= Math.round(lead.rise.elevation) + 1) return this._t("sky.caption_short", { start, end });
    const peak = this._t("sky.peak", { direction: fmt.direction(top.direction), elevation: Math.round(top.elevation) });
    return this._t("sky.caption", { start, peak, end });
  }

  // -- passes: list, strip and sheet -----------------------------------------

  _ensurePassList() {
    if (this._passList || !this._els?.plist || !passesModule.PassList) return this._passList;
    // A pass picked in the sheet closes it, and focus goes back to the strip
    // (after the pick, which redraws the strip); the arrow keys only browse.
    this._passList = new passesModule.PassList(this._els.plist, {
      formatter: this._fmt,
      onSelect: (id, how) => {
        this._select(id, { frame: true });
        if (this._sheetOpen && !how?.browse) this._closeSheet(true);
      },
      onSimulate: (id) => {
        this._select(id, { view: "simulate", frame: false });
        if (this._sheetOpen) this._closeSheet(true);
      },
      onStreet: this._config.street_view === false ? undefined : (id) => {
        this._select(id, { view: "street", frame: false });
        if (this._sheetOpen) this._closeSheet(true);
      },
      onFilter: (filters) => this._setFilters(filters),
    });
    return this._passList;
  }

  /** The list of passes: beside the globe when wide, else in the sheet. */
  _renderList() {
    const e = this._els;
    if (!e?.plist || !this._payload) return;
    const mode = this._passesMode();
    const inSide = this._wide && mode === "list";
    if (!inSide && !this._sheetOpen) return;
    const list = this._ensurePassList();
    if (!list) return;
    const home = inSide ? e.passesBox : e.sheetBody;
    if (e.plist.parentNode !== home) home.appendChild(e.plist);
    list.render(this._passes(), {
      selectedId: this._selectedId,
      nowS: this._now() / 1000,
      days: this._payload.settings?.days ?? 5,
      emptyText: this._payload.paused ? this._t("mission.paused_list") : undefined,
      filters: this._filters,
      location: this._payload.location,
    });
  }

  _openSheet() {
    if (!this._els) return;
    this._sheetOpen = true;
    this._sheetReturn = this.shadowRoot?.activeElement ?? null;
    this._els.sheet.hidden = false;
    this._renderList();
    this._passList?.focusSelected?.();
  }

  _closeSheet(returnFocus) {
    if (!this._sheetOpen || !this._els) return;
    this._sheetOpen = false;
    this._els.sheet.hidden = true;
    if (returnFocus) (this._sheetReturn?.isConnected ? this._sheetReturn : this._els.strip.querySelector(".pchip.all"))?.focus?.();
    this._sheetReturn = null;
  }

  /** The strip of pass chips under the mission card (narrow layouts, and cards that ask for it). */
  _renderStrip() {
    const e = this._els;
    const p = this._payload;
    if (!e?.strip || !p) return;
    const mode = this._passesMode();
    const nowS = this._now() / 1000;
    // The chips follow the list's filters, as the sheet that holds the list sets them.
    const passes = this._listedPasses(nowS).filter((q) => q.end > nowS).slice(0, STRIP_MAX);
    const show = !!mode && (mode === "strip" || !this._wide) && passes.length > 0 && this._config.show_countdown !== false;
    e.strip.hidden = !show;
    if (!show) return;
    const fmt = this._fmt;
    const day = this._chipDay(nowS);
    const chips = [];
    // The whole list, in a sheet, where there is room for one: first, so it is found.
    if (mode === "list" || (this.clientHeight || 0) >= 420) {
      const all = this._t("pass.all");
      chips.push(`<button type="button" class="pchip all" tabindex="-1" aria-haspopup="dialog" aria-label="${esc(all)}" title="${esc(all)}">${svgIcon("list")}</button>`);
    }
    chips.push(...passes.map((q) => {
      const live = q.start <= nowS && nowS < q.end;
      const sel = q.id === this._selectedId;
      const star = q.bright ? svgIcon("star", { title: this._t("mission.bright") }) : "";
      const d = day(q.start);
      return `<button type="button" class="pchip${live ? " live" : ""}" data-id="${esc(q.id)}" aria-pressed="${sel}" tabindex="${sel ? 0 : -1}">
        <span class="t">${esc(live ? this._t("pass.now") : fmt.time(q.start))}${d ? ` <small>${esc(d)}</small>` : ""}${star}</span>
        <span class="n">${svgIcon(kindIcon(q.kind, { train: q.train }))}<span>${esc(fmt.passTitle(q))}</span></span></button>`;
    }));
    const html = chips.join("");
    if (html === this._stripKey) return;
    const focused = this.shadowRoot?.activeElement?.closest?.(".pchip")?.dataset.id;
    this._stripKey = html;
    e.strip.innerHTML = html;
    if (!e.strip.querySelector('[tabindex="0"]')) e.strip.querySelector(".pchip")?.setAttribute("tabindex", "0");
    if (focused) {
      const value = globalThis.CSS?.escape ? CSS.escape(focused) : focused;
      e.strip.querySelector(`.pchip[data-id="${value}"]`)?.focus({ preventScroll: true });
    }
    // The selected chip in view (scrolling the strip only, never the page).
    const sel = e.strip.querySelector('.pchip[aria-pressed="true"]');
    if (sel && (sel.offsetLeft < e.strip.scrollLeft || sel.offsetLeft + sel.offsetWidth > e.strip.scrollLeft + e.strip.clientWidth)) {
      e.strip.scrollLeft = Math.max(0, sel.offsetLeft - 8);
    }
  }

  /** A short day for a strip chip ("Sun"), none for today. */
  _chipDay(nowS) {
    const lang = this._fmt.language;
    const tz = this._fmt.timeZone;
    let c = this._chipFormats;
    if (!c || c.lang !== lang || c.tz !== tz) {
      const make = (l, o) => {
        try {
          return new Intl.DateTimeFormat(l, { ...o, timeZone: tz });
        } catch {
          return new Intl.DateTimeFormat(undefined, o);
        }
      };
      c = this._chipFormats = {
        lang,
        tz,
        weekday: make(lang || undefined, { weekday: "short" }),
        day: make("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }),
      };
    }
    const today = c.day.format(new Date(nowS * 1000));
    return (s) => (c.day.format(new Date(s * 1000)) === today ? "" : c.weekday.format(new Date(s * 1000)));
  }

  /** Arrow keys move along the strip (one tab stop for the whole strip). */
  _onStripKey(ev) {
    const chips = [...this._els.strip.querySelectorAll(".pchip")];
    const i = chips.indexOf(ev.target.closest?.(".pchip"));
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: chips.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    const next = chips[Math.max(0, Math.min(chips.length - 1, to))];
    for (const c of chips) c.setAttribute("tabindex", c === next ? "0" : "-1");
    next.focus();
  }
}

if (globalThis.customElements && !customElements.get("satellite-globe-view")) {
  customElements.define("satellite-globe-view", SatelliteGlobeView);
}
