/**
 * The pass list: every visible pass of the next days, grouped into mornings,
 * afternoons and evenings, each with how bright it will be, how high it climbs,
 * which way it goes, how long it lasts, the forecast cloud and a bright Moon,
 * and buttons to simulate it on the globe or watch it from the street. Also
 * the helpers the views share to find the pass going on now, the next one and
 * the one that just ended, and to tell what the sky will be like.
 *
 * Used by the globe view (sidebar panel and globe card) and the passes card.
 * The list draws itself in its own shadow root inside the container it is
 * given, so it looks the same in each; colours come from the --sat-* tokens
 * the host sets (sat-theme.js), with the dark glass look as the fallback.
 */

const VERSION = new URL(import.meta.url).search;
// Modules are kept as namespaces and read when used: see sat-format.js.
const [theme, geo, astro] = await Promise.all([
  import(`./sat-theme.js${VERSION}`),
  import(`./sat-geo.js${VERSION}`),
  import(`./sat-astro.js${VERSION}`),
]);

// A pass this close to starting shows "in 2 h" under its time.
const SOON_S = 6 * 3600;
// Holding an arrow key down moves through the list; the pass is selected once it stops.
const KEY_REPEAT_SELECT_MS = 160;
// Objects worth naming when they ride along in another satellite's group.
const NOTABLE = new Set(["iss", "tiangong", "hubble"]);
// A Moon at least this lit, above the horizon, washes out the fainter satellites.
const MOON_LIT = 0.4;
// The Moon's state is worked out once per pass and place (the list redraws often).
const MOON_CACHE_SIZE = 256;

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const byStart = (a, b) => a.start - b.start || a.end - b.end;

// ---- Helpers shared by the views ---------------------------------------------------

/** The pass going on now (start ≤ now < end), or null. */
export function currentPass(passes, nowS) {
  let found = null;
  for (const p of passes || []) {
    if (p.start <= nowS && nowS < p.end && (!found || p.start < found.start)) found = p;
  }
  return found;
}

/**
 * The first pass that has not ended (one going on counts), or null; with a
 * predicate, the first it accepts.
 */
export function nextPass(passes, nowS, predicate) {
  let found = null;
  for (const p of passes || []) {
    if (!(p.end > nowS) || (predicate && !predicate(p))) continue;
    if (!found || byStart(p, found) < 0) found = p;
  }
  return found;
}

/** The pass that ended most recently (end ≤ now), or null: refresh once it is over. */
export function endedPass(passes, nowS) {
  let found = null;
  for (const p of passes || []) {
    if (p.end <= nowS && (!found || p.end > found.end)) found = p;
  }
  return found;
}

/** The list's filters, every value checked (stored ones may come from elsewhere). */
export function normalizeFilters(filters) {
  return { brightOnly: filters?.brightOnly === true, hideStarlink: filters?.hideStarlink === true };
}

/** Whether a pass gets through the list's filters ("Bright only", "Hide Starlink"). */
export function matchesFilters(pass, filters) {
  if (filters?.brightOnly && !pass.bright) return false;
  if (filters?.hideStarlink && pass.kind === "starlink") return false;
  return true;
}

/**
 * The passes not over yet that get through the filters, in order, in groups
 * by the part of the day they start in ("Tonight", "Tomorrow morning"…).
 * @returns {{key: string, label: string, sub: string, passes: object[]}[]}
 */
export function groupPasses(passes, fmt, nowS, { filters } = {}) {
  const groups = [];
  let group = null;
  for (const pass of [...(passes || [])].sort(byStart)) {
    if (!(pass.end > nowS) || !matchesFilters(pass, filters)) continue;
    const g = fmt.group(pass.start, nowS);
    if (g.key !== group?.key) groups.push((group = { ...g, passes: [] }));
    group.passes.push(pass);
  }
  return groups;
}

/** A satellite of note (the ISS, Tiangong, Hubble) travelling in another one's group, or null. */
export function notableMember(pass) {
  const members = pass?.transits || [];
  if (NOTABLE.has(pass?.kind)) return null;
  return members.slice(1).find((t) => NOTABLE.has(t.kind)) ?? null;
}

/**
 * The satellite of a pass that gets brightest (the pass's magnitude is its):
 * the first satellite unless another outshines it, such as the ISS riding
 * along in another satellite's group.
 */
export function brightestMember(pass) {
  let best = null;
  for (const t of pass?.transits || []) {
    if (Number.isFinite(t.magnitude) && (!best || t.magnitude < best.magnitude)) best = t;
  }
  return best ?? pass?.transits?.[0] ?? null;
}

/** Where a pass starts and ends, as compass points: ["SW", "ENE"] (the first satellite's). */
export function passDirections(pass) {
  const t = pass?.transits?.[0];
  return [t?.rise?.direction, t?.set?.direction];
}

/**
 * The hour a pass's cloud forecast is for (unix s): the first forecast hour
 * after the pass starts, as the integration and See A Satellite Tonight pick
 * it (Open-Meteo's hours are whole hours of UTC). Null without a start.
 */
export function cloudHour(pass) {
  return Number.isFinite(pass?.start) ? Math.floor(pass.start / 3600) * 3600 + 3600 : null;
}

/** "13% cloud at 6 AM", or "" without a forecast. */
export function cloudText(pass, fmt) {
  const cloud = fmt.cloud(pass?.cloud_cover);
  return cloud ? fmt.t("passes.cloud_at", { cloud: cloud.text, time: fmt.hour(cloudHour(pass)) }) : "";
}

const moonCache = new Map();

/**
 * The Moon during a pass, when it can spoil the view: above the horizon at
 * the pass's highest point and more than 40 % lit (a bright Moon washes out
 * the fainter satellites; See A Satellite Tonight leaves it out). Null
 * otherwise, for a pass in daylight (the sky is bright anyway) and without a
 * place. {time, fraction 0..1, elevation, azimuth, direction (16-point),
 * waxing, litSide (degrees clockwise from up, as it is seen)}.
 * @param {{latitude: number, longitude: number, elevation?: number}} observer
 */
export function passMoon(pass, observer) {
  const t = pass?.peak?.time ?? (pass?.start + pass?.end) / 2;
  if (!pass || pass.before_sunset || !Number.isFinite(t)) return null;
  if (!Number.isFinite(observer?.latitude) || !Number.isFinite(observer?.longitude)) return null;
  const key = `${t}|${observer.latitude}|${observer.longitude}|${observer.elevation ?? 0}`;
  if (moonCache.has(key)) return moonCache.get(key);
  const date = t * 1000;
  const place = { latitude: observer.latitude, longitude: observer.longitude, elevation: observer.elevation ?? 0 };
  const moon = astro.moonAzEl(date, place);
  let result = null;
  if (moon.elevation > 0) {
    const phase = astro.moonPhase(date);
    if (phase.fraction > MOON_LIT) {
      result = {
        time: t,
        fraction: phase.fraction,
        elevation: moon.elevation,
        azimuth: moon.azimuth,
        direction: geo.compass(moon.azimuth),
        waxing: phase.waxing,
        litSide: astro.skyDirection(moon, astro.sunAzEl(date, place)),
      };
    }
  }
  if (moonCache.size >= MOON_CACHE_SIZE) moonCache.delete(moonCache.keys().next().value);
  moonCache.set(key, result);
  return result;
}

/** "Moon 78% lit, 25° up in the SE". */
export function moonText(moon, fmt) {
  if (!moon) return "";
  return fmt.t("passes.moon", {
    percent: fmt.percent(moon.fraction),
    elevation: fmt.degrees(moon.elevation),
    direction: fmt.direction(moon.direction),
  });
}

/**
 * The Moon's phase as a small icon in the current colour: the lit part on a
 * faint disc, turned the way it will be seen in the sky. Decorative unless
 * it has a title.
 */
export function moonGlyph(moon, { title } = {}) {
  const r = 8.6;
  const lit = moon ? astro.moonLitPath(r, moon.fraction, moon.litSide ?? 90) : "";
  const a11y = title ? `role="img" aria-label="${esc(title)}"` : `aria-hidden="true" focusable="false"`;
  return `<svg class="moon-glyph" viewBox="-12 -12 24 24" ${a11y}>${title ? `<title>${esc(title)}</title>` : ""}<circle r="${r}" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-opacity=".5" stroke-width="1.1"/><path d="${lit}" fill="currentColor"/></svg>`;
}

// ---- Rows -------------------------------------------------------------------------

/** "8:41 PM" → ["8:41", "PM"]; a 24-hour time, or a language that puts the period first, stays whole. */
function splitPeriod(text) {
  const m = /^(.*\d)\s*([^\d\s][^\d]*)$/.exec(text);
  return m ? [m[1], m[2]] : [text, ""];
}

function meterHtml(level) {
  let bars = "";
  for (let i = 0; i < 5; i++) bars += `<i class="${i <= level ? "on" : ""}"></i>`;
  return `<span class="meter l${level}" aria-hidden="true">${bars}</span>`;
}

/**
 * Everything a row shows, as HTML, and its accessible name. Pure: the time
 * until a pass (which changes by the minute) is filled in separately.
 * `moon` is passMoon()'s answer for the pass (a small Moon beside the cloud).
 */
export function rowParts(pass, fmt, { live = false, moon = null } = {}) {
  const title = fmt.passTitle(pass);
  const [hm, period] = splitPeriod(fmt.time(pass.start));
  const kind = theme.kindIcon(pass.kind, { train: !!pass.train });
  const kindWord = pass.train ? fmt.t("kinds.train") : fmt.kind(pass.kind);
  const { level, word } = fmt.brightness(pass.magnitude);
  const magnitude = fmt.magnitude(pass.magnitude);
  const elevation = fmt.degrees(pass.peak?.elevation);
  const [from, to] = passDirections(pass).map((d) => (d ? fmt.direction(d) : ""));
  const duration = fmt.duration(pass.duration ?? pass.end - pass.start);
  const cloud = fmt.cloud(pass.cloud_cover);
  const member = notableMember(pass);
  const moonSays = moonText(moon, fmt);

  const badges = [
    pass.bright ? `<span class="badge star" title="${esc(fmt.t("passes.bright"))}">${theme.svgIcon("star")}</span>` : "",
    pass.before_sunset
      ? `<span class="badge day" title="${esc(fmt.t("passes.daylight_hint"))}">${esc(fmt.t("passes.daylight"))}</span>`
      : "",
    member ? `<span class="badge with">${esc(fmt.t("passes.with", { name: member.name }))}</span>` : "",
  ].join("");

  const html = `
    <button class="pick" type="button">
      <span class="when"><span class="t"><b>${esc(hm)}</b>${period ? `<small>${esc(period)}</small>` : ""}</span>${
        live ? `<span class="now">${esc(fmt.t("passes.now"))}</span>` : `<span class="rel"></span>`
      }</span>
      <span class="body">
        <span class="line">
          <span class="kind k-${esc(kind)}" title="${esc(kindWord)}">${theme.svgIcon(kind)}</span>
          <span class="title">${esc(title)}</span>${badges}
        </span>
        <span class="line meta">
          <span class="mag" title="${esc(`${word} (${fmt.t("passes.magnitude", { magnitude })})`)}">${meterHtml(level)}<span class="word">${esc(word)}</span><span class="num">${esc(magnitude)}</span></span>
          ${from && to ? `<span class="dir">${esc(from)}<span class="arrow" aria-hidden="true">→</span>${esc(to)}</span>` : ""}
          <span class="dur">${esc(duration)}</span>
        </span>
      </span>
      <span class="side">
        <span class="el" title="${esc(fmt.t("passes.up_to", { elevation }))}">${esc(elevation)}</span>
        ${cloud || moon ? `<span class="sky">${moon ? `<span class="moon" title="${esc(moonSays)}">${moonGlyph(moon)}</span>` : ""}${
          cloud ? `<span class="cloud ${cloud.level}" title="${esc(`${cloud.word} · ${cloudText(pass, fmt)}`)}">${theme.svgIcon("cloud")}${esc(cloud.text)}</span>` : ""
        }</span>` : ""}
      </span>
    </button>
    <span class="acts"></span>`;

  // The accessible name says it all in words, rather than reading out the layout.
  const label = [
    fmt.time(pass.start),
    title,
    pass.bright ? fmt.t("passes.bright") : "",
    pass.before_sunset ? fmt.t("passes.daylight") : "",
    member ? fmt.t("passes.with", { name: member.name }) : "",
    `${word}, ${fmt.t("passes.magnitude", { magnitude })}`,
    elevation ? fmt.t("passes.up_to", { elevation }) : "",
    from && to ? fmt.t("passes.from_to", { from, to }) : "",
    duration,
    cloud ? fmt.t("passes.cloud_cover", { percent: cloud.text }) : "",
    moonSays,
  ].filter(Boolean);
  return { html, label: label.join(", "), title, time: fmt.time(pass.start) };
}

// ---- Styles -------------------------------------------------------------------------

const CSS = `
:host { display: block; min-height: 0; color: var(--sat-ink, #f8fafc); font-family: var(--sat-font, var(--ha-font-family-body, Roboto, system-ui, sans-serif)); }
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
button { font: inherit; color: inherit; }
button:focus { outline: none; }
button:focus-visible { outline: 2px solid var(--sat-sky, #7dd3fc); outline-offset: -2px; }
svg { display: block; fill: currentColor; }

/* --pl-head is the sticky group heading's height: a row brought into view
   (by the list, or by the browser following keyboard focus) stops below it. */
.pl { display: flex; flex-direction: column; height: 100%; min-height: 0; container-type: inline-size; --pl-head: 26px; }
.filters { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 10px 8px; flex: none; }
.filter { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; line-height: 1;
  padding: 6px 11px 6px 9px; border-radius: 999px; cursor: pointer; color: var(--sat-ink-2, #cbd5e1);
  background: var(--sat-pl-chip, rgba(148,163,184,.1)); border: 1px solid var(--sat-pl-chip-edge, rgba(148,163,184,.3));
  -webkit-tap-highlight-color: transparent; transition: background .15s, border-color .15s, color .15s; }
.filter svg { width: 13px; height: 13px; }
.filter[aria-pressed="true"] { color: var(--sat-sky-ink, var(--sat-sky, #7dd3fc)); background: rgba(125,211,252,.14); border-color: rgba(125,211,252,.6); }
.filter.bright[aria-pressed="true"] { color: var(--sat-gold-ink, var(--sat-gold, #fcd34d)); background: rgba(252,211,77,.14); border-color: rgba(252,211,77,.6); }
.filter:focus-visible { outline-offset: 2px; }

.scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin;
  scrollbar-color: rgba(148,163,184,.35) transparent; padding: 0 4px 2px; }
.grp + .grp { margin-top: 2px; }
/* Opaque, so the rows scrolled beneath it do not show through. */
.head { position: sticky; top: 0; z-index: 2; display: flex; align-items: baseline; gap: 8px; box-sizing: border-box;
  height: var(--pl-head); margin: 0; padding: 8px 8px 0; overflow: hidden; white-space: nowrap;
  font-size: 11px; line-height: 13px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--sat-sky-ink, var(--sat-sky, #7dd3fc));
  background: var(--sat-pl-head, #0e1527); }
.head .lbl { flex: none; }
.head .sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 11px; font-weight: 500; letter-spacing: .02em; text-transform: none; color: var(--sat-ink-3, #94a3b8); }
ol { list-style: none; margin: 0; padding: 0; }

.row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: stretch; border-radius: 10px;
  transition: background .15s; scroll-margin-top: var(--pl-head); }
.row button { scroll-margin-top: var(--pl-head); }
.row + .row { margin-top: 1px; }
.row::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px; border-radius: 3px; background: transparent; transition: background .15s; }
@media (hover: hover) { .row:hover { background: var(--sat-pl-hover, rgba(148,163,184,.08)); } }
.row.sel { background: var(--sat-pl-selected, rgba(125,211,252,.12)); }
.row.sel::before { background: var(--sat-sky, #7dd3fc); }
.row.live { background: var(--sat-pl-live, rgba(252,211,77,.1)); box-shadow: inset 0 0 0 1px rgba(252,211,77,.35); }
.row.live::before { background: var(--sat-gold, #fcd34d); }

.pick { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; gap: 0 10px; min-width: 0; width: 100%;
  padding: 8px 10px 8px 12px; background: none; border: 0; border-radius: 10px; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.when { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.t { font-size: 14px; line-height: 1.1; white-space: nowrap; font-variant-numeric: tabular-nums; }
.t b { font-weight: 650; }
.t small { font-size: 9.5px; font-weight: 600; margin-left: 2px; letter-spacing: .04em; color: var(--sat-ink-3, #94a3b8); }
.rel { font-size: 10.5px; line-height: 1.1; color: var(--sat-sky-ink, var(--sat-sky, #7dd3fc)); white-space: nowrap; }
.rel:empty { display: none; }
.now { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; font-size: 9.5px; font-weight: 700; letter-spacing: .1em;
  text-transform: uppercase; line-height: 1; padding: 3px 6px 3px 5px; border-radius: 999px; color: #1c1404; background: var(--sat-gold, #fcd34d); }
.now::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #1c1404; }

.body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.line { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; }
.kind { flex: none; width: 16px; height: 16px; color: var(--sat-kind-satellite, #e0f2fe); }
.kind svg { width: 16px; height: 16px; }
.k-station { color: var(--sat-kind-station, #fcd34d); }
.k-telescope { color: var(--sat-kind-telescope, #c4b5fd); }
.k-train { color: var(--sat-kind-starlink, #7dd3fc); }
.k-rocket { color: var(--sat-kind-rocket, #fb923c); }
.k-debris { color: var(--sat-kind-debris, #94a3b8); }
.title { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 13.5px; font-weight: 600; line-height: 1.2; }
.badge { flex: none; display: inline-flex; align-items: center; font-size: 9px; font-weight: 700; letter-spacing: .08em;
  text-transform: uppercase; line-height: 1; border-radius: 999px; }
.badge.star { width: 16px; height: 16px; justify-content: center; color: #1c1404; background: var(--sat-gold, #fcd34d);
  box-shadow: 0 0 10px rgba(252,211,77,.45); }
.badge.star svg { width: 11px; height: 11px; }
.badge.day { padding: 2px 6px; color: var(--sat-warn, #fdba74); border: 1px solid currentColor; }
.badge.with { padding: 2px 6px; color: var(--sat-gold-ink, var(--sat-gold, #fcd34d)); border: 1px solid rgba(252,211,77,.45); text-transform: none; letter-spacing: .02em; font-size: 10px; }
.side { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 5px; min-width: 2.4em; }
.side .sky { display: inline-flex; align-items: center; gap: 6px; }
.moon { display: inline-flex; color: var(--sat-ink, #f8fafc); }
.moon svg { width: 13px; height: 13px; }
.cloud { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; font-weight: 600; line-height: 1;
  font-variant-numeric: tabular-nums; white-space: nowrap; }
.cloud svg { width: 13px; height: 13px; }
.cloud.clear { color: var(--sat-cloud-clear, #86efac); }
.cloud.partly { color: var(--sat-cloud-partly, #fde68a); }
.cloud.cloudy { color: var(--sat-cloud-cloudy, #fda4af); }
.meta { gap: 0; overflow: hidden; font-size: 11.5px; color: var(--sat-ink-2, #cbd5e1); }
.meta > * + *::before { content: "·"; margin: 0 6px; color: var(--sat-ink-3, #94a3b8); }
.mag { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
.mag .word { display: none; }
.dir .arrow { margin: 0 3px; color: var(--sat-ink-3, #94a3b8); }
.meter { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 11px; }
.meter i { width: 3px; border-radius: 1px; background: var(--sat-pl-meter-off, rgba(148,163,184,.3)); }
.meter i:nth-child(1) { height: 3px; } .meter i:nth-child(2) { height: 5px; } .meter i:nth-child(3) { height: 7px; }
.meter i:nth-child(4) { height: 9px; } .meter i:nth-child(5) { height: 11px; }
.meter i.on { background: var(--sat-pl-meter-on, linear-gradient(180deg, #fef3c7, var(--sat-gold, #fcd34d))); }
.meter.l4 i.on { box-shadow: 0 0 5px rgba(252,211,77,.7); }
.el { font-size: 15px; font-weight: 650; line-height: 1.1; color: var(--sat-gold-ink, var(--sat-gold, #fcd34d)); font-variant-numeric: tabular-nums; }

/* Narrow lists: the selected pass spells out its buttons on a line of their own. */
.acts { grid-column: 1 / -1; display: none; gap: 8px; padding: 0 10px 10px 74px; }
.row.sel .acts { display: flex; }
.acts:empty { display: none !important; }
.act { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px 0 9px; border-radius: 999px; cursor: pointer;
  font-size: 12px; font-weight: 600; line-height: 1; white-space: nowrap; -webkit-tap-highlight-color: transparent;
  color: var(--sat-pl-btn-ink, #e0f2fe); background: rgba(56,189,248,.14); border: 1px solid rgba(56,189,248,.45);
  transition: background .15s, border-color .15s, color .15s, transform .15s; }
.act.sim { color: var(--sat-pl-sim-ink, #fae8ff); background: rgba(240,171,252,.13); border-color: rgba(240,171,252,.5); }
.act svg { width: 15px; height: 15px; }
@media (hover: hover) { .act:hover { background: rgba(56,189,248,.26); } .act.sim:hover { background: rgba(240,171,252,.24); } }
.act:active { transform: scale(.95); }
.act:focus-visible { outline-offset: 2px; }

.foot { margin: 0; padding: 12px 12px 14px; text-align: center; font-size: 11.5px; line-height: 1.5; color: var(--sat-ink-3, #94a3b8); }
.foot .hidden-note { display: block; margin-top: 2px; }
.link { padding: 0; border: 0; background: none; cursor: pointer; font-weight: 600; color: var(--sat-sky-ink, var(--sat-sky, #7dd3fc));
  text-decoration: underline; text-underline-offset: 2px; }

.empty { padding: 18px 16px 20px; color: var(--sat-ink-2, #cbd5e1); font-size: 12.5px; line-height: 1.5; }
.empty .icon { width: 30px; height: 30px; margin: 2px 0 10px; color: var(--sat-ink-3, #94a3b8); opacity: .8; }
.empty .icon svg { width: 30px; height: 30px; }
.empty h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; line-height: 1.35; color: var(--sat-ink, #f8fafc); }
.empty h4 { margin: 12px 0 3px; font-size: 10.5px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
  color: var(--sat-sky-ink, var(--sat-sky, #7dd3fc)); }
.empty p { margin: 0; color: var(--sat-ink-3, #94a3b8); }
.empty .link { margin-top: 10px; }

/* Wide lists: every pass has its two buttons, as icons, at the end of the row. */
@container (min-width: 400px) {
  .acts { grid-column: 2; grid-row: 1; display: flex; align-items: center; gap: 2px; padding: 0 8px 0 0; }
  .act { justify-content: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; background: transparent;
    color: var(--sat-ink-3, #94a3b8); }
  .act.sim { background: transparent; color: var(--sat-ink-3, #94a3b8); }
  .act svg { width: 17px; height: 17px; }
  .act .lbl { display: none; }
  .row.sel .act, .row.live .act { color: var(--sat-ink-2, #cbd5e1); }
  @media (hover: hover) { .act:hover, .act.sim:hover { background: rgba(148,163,184,.18); }
    .act.sim:hover { color: var(--sat-preview, #f0abfc); } .act.street:hover { color: var(--sat-sky, #7dd3fc); } }
  .pick { padding-right: 6px; }
}
/* Room for words: the brightness in words. */
@container (min-width: 480px) {
  .mag .word { display: inline; }
  .pick { grid-template-columns: 58px minmax(0, 1fr) auto; gap: 0 12px; padding-left: 14px; }
}
@container (max-width: 339px) {
  .acts { flex-wrap: wrap; padding-left: 12px; }
}
@container (max-width: 319px) {
  .dur { display: none; }
  .badge.with { display: none; }
}
@container (max-width: 279px) {
  .pick { grid-template-columns: 46px minmax(0, 1fr) auto; gap: 0 8px; padding: 7px 8px 7px 10px; }
  .t { font-size: 13px; }
  .title { font-size: 13px; }
  .el { font-size: 14px; }
  .meta > * + *::before { margin: 0 4px; }
  .dir .arrow { margin: 0 1px; }
  /* Room for where it goes: the number says how bright, and the Moon is left
     to the words above the list (it stays in each row's spoken name). */
  .meter, .moon { display: none; }
}

/* Cards: tighter rows, the headings scroll away with them. */
.compact .head { position: static; height: auto; padding: 8px 8px 3px; background: none; }
.compact .pick { padding-top: 6px; padding-bottom: 6px; }
.compact .acts { padding-bottom: 8px; }
.compact .row + .row { margin-top: 0; }
.compact .scroll { overflow: visible; padding: 0; }

@media (prefers-reduced-motion: no-preference) {
  .row.live { animation: pl-glow 2.4s ease-in-out infinite; }
  .row.live .now::before { animation: pl-blink 1.2s ease-in-out infinite; }
}
@keyframes pl-glow { 50% { box-shadow: inset 0 0 0 1px rgba(252,211,77,.65), 0 0 16px rgba(252,211,77,.18); } }
@keyframes pl-blink { 50% { opacity: .25; } }
@media (forced-colors: active) { .row.sel, .row.live { outline: 2px solid CanvasText; } .meter i.on { background: CanvasText; } }
`;

// ---- The list ----------------------------------------------------------------------

export class PassList {
  /**
   * @param {HTMLElement} container where the list draws itself (in its own shadow root)
   * @param {object} o
   * @param {import("./sat-format.js").Formatter} o.formatter
   * @param {(id: string, how: {browse?: boolean}) => void} [o.onSelect] a row was picked (click, Enter, arrow
   *   keys); `browse` when the arrow keys only moved through the list, so a host can keep it open
   * @param {(id: string) => void} [o.onSimulate] its ▶ button (or Space); no button without it
   * @param {(id: string) => void} [o.onStreet] its street view button; no button without it
   * @param {(filters: {brightOnly: boolean, hideStarlink: boolean}) => void} [o.onFilter]
   *   the filter chips changed; pass them back to render() to keep them, or leave
   *   render()'s filters out and the list keeps its own
   * @param {boolean} [o.compact] smaller rows for cards: no filters, no footer, headings not sticky
   * @param {boolean} [o.showFilters] the filter chips (default: unless compact)
   */
  constructor(container, { formatter, onSelect, onSimulate, onStreet, onFilter, compact = false, showFilters } = {}) {
    this._fmt = formatter;
    this._on = { select: onSelect, simulate: onSimulate, street: onStreet, filter: onFilter };
    this._compact = compact;
    this._showFilters = showFilters ?? !compact;
    this._filters = { brightOnly: false, hideStarlink: false };
    this._passes = [];
    this._opts = {};
    this._now = Date.now() / 1000;
    this._groups = new Map(); // key → {el, head, label, sub, ol}
    this._rows = new Map(); // id → {li, pick, rel, html, label, pass, state}
    this._order = []; // ids in display order
    this._cursor = null; // the row Tab lands on
    this._container = container;

    const root = (this._root = container.shadowRoot ?? container.attachShadow({ mode: "open" }));
    root.innerHTML = `<style>${CSS}</style>
      <div class="pl${compact ? " compact" : ""}" part="list">
        <div class="filters" role="group" hidden>
          <button class="filter bright" type="button" data-filter="brightOnly" aria-pressed="false">${theme.svgIcon("star")}<span></span></button>
          <button class="filter" type="button" data-filter="hideStarlink" aria-pressed="false">${theme.svgIcon("train")}<span></span></button>
        </div>
        <div class="scroll" part="scroll"><p class="foot" hidden></p></div>
        <div class="empty" hidden></div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    this._els = { filters: $(".filters"), scroll: $(".scroll"), foot: $(".foot"), empty: $(".empty") };

    this._onClick = (ev) => this._click(ev);
    this._onKey = (ev) => this._key(ev);
    root.addEventListener("click", this._onClick);
    root.addEventListener("keydown", this._onKey);
  }

  /**
   * Draw the passes. Cheap to call again: rows that did not change are kept,
   * and so is keyboard focus.
   * @param {object[]} passes the passes payload's passes
   * @param {object} [o]
   * @param {string|null} [o.selectedId] the pass shown elsewhere (mission card, sky chart)
   * @param {number} [o.nowS] Home Assistant's time, unix seconds
   * @param {{brightOnly?: boolean, hideStarlink?: boolean}} [o.filters] left out: the chips' own state
   * @param {string} [o.emptyText] what to say when there is nothing to list (default: why not)
   * @param {number} [o.days] how many days the predictions cover (5)
   * @param {{latitude: number, longitude: number, elevation?: number}} [o.location] where the passes are
   *   seen from, for the Moon (passMoon)
   */
  render(passes, { selectedId = null, nowS, filters, emptyText, days = 5, location = null } = {}) {
    if (!this._root) return;
    this._passes = Array.isArray(passes) ? passes : [];
    if (Number.isFinite(nowS)) this._now = nowS;
    if (filters) this._filters = normalizeFilters(filters);
    const changed = selectedId !== this._opts.selectedId;
    // Tab lands on the selected pass; a pass picked here is already in view.
    if (changed) this._cursor = selectedId;
    const reveal = changed && selectedId !== this._picked;
    this._picked = null;
    this._opts = { selectedId, emptyText, days, location };
    this._draw({ reveal: reveal ? "start" : null });
  }

  /** Move the list to a new time: "in 2 h", the live row, passes that ended, the headings. Cheap; call it every second. */
  setNow(nowS) {
    if (!this._root || !Number.isFinite(nowS)) return;
    this._now = nowS;
    // A new part of the day words the headings anew: after midnight "Tomorrow morning" is "This morning".
    if (this._period && this._fmt.group(nowS, nowS).key !== this._period) {
      this._draw({ reveal: false });
      return;
    }
    for (const row of this._rows.values()) {
      if (this._state(row.pass) !== row.state) {
        // A pass started or ended: rows come and go, the live one is drawn anew.
        this._draw({ reveal: false });
        return;
      }
    }
    this._times();
  }

  /** Put keyboard focus on the selected pass (or the first) and scroll it into view. */
  focusSelected() {
    const id = this._rows.has(this._opts.selectedId) ? this._opts.selectedId : this._order[0];
    const row = this._rows.get(id);
    if (!row) return;
    this._setCursor(id);
    row.pick.focus({ preventScroll: true });
    this._reveal(row, "start");
  }

  destroy() {
    clearTimeout(this._repeatTimer);
    if (!this._root) return;
    this._root.removeEventListener("click", this._onClick);
    this._root.removeEventListener("keydown", this._onKey);
    this._root.innerHTML = "";
    this._root = null;
    this._rows.clear();
    this._groups.clear();
  }

  /** The filters in use. */
  get filters() {
    return { ...this._filters };
  }

  // ---- Drawing ----

  _state(pass) {
    if (pass.end <= this._now) return "ended";
    return pass.start <= this._now ? "live" : "soon";
  }

  _draw({ reveal }) {
    const fmt = this._fmt;
    const t = (key, vars) => fmt.t(key, vars);
    const scroll = this._els.scroll;
    const before = this._focus();

    // Filter chips.
    const chips = this._els.filters;
    chips.hidden = !this._showFilters;
    chips.setAttribute("aria-label", t("passes.filters"));
    for (const chip of chips.querySelectorAll("button[data-filter]")) {
      const key = chip.dataset.filter;
      chip.querySelector("span").textContent = t(key === "brightOnly" ? "passes.bright_only" : "passes.hide_starlink");
      chip.setAttribute("aria-pressed", String(!!this._filters[key]));
    }

    const all = this._passes.filter((p) => p.end > this._now);
    const groups = groupPasses(all, fmt, this._now, { filters: this._filters });
    // The part of the day the headings are worded from (see setNow).
    this._period = fmt.group(this._now, this._now).key;
    const shown = groups.reduce((n, g) => n + g.passes.length, 0);

    // Groups and rows, keyed, in order.
    const seenGroups = new Set();
    const seenRows = new Set();
    const order = [];
    let anchor = scroll.firstChild;
    for (const g of groups) {
      seenGroups.add(g.key);
      let group = this._groups.get(g.key);
      if (!group) {
        const el = document.createElement("section");
        el.className = "grp";
        el.innerHTML = `<h3 class="head"><span class="lbl"></span><span class="sub"></span></h3><ol></ol>`;
        group = { el, label: el.querySelector(".lbl"), sub: el.querySelector(".sub"), ol: el.querySelector("ol") };
        this._groups.set(g.key, group);
      }
      if (group.label.textContent !== g.label) group.label.textContent = g.label;
      if (group.sub.textContent !== g.sub) group.sub.textContent = g.sub;
      if (group.el !== anchor) scroll.insertBefore(group.el, anchor);
      anchor = group.el.nextSibling;

      let rowAnchor = group.ol.firstChild;
      for (const pass of g.passes) {
        seenRows.add(pass.id);
        order.push(pass.id);
        const row = this._row(pass);
        if (row.li !== rowAnchor) group.ol.insertBefore(row.li, rowAnchor);
        rowAnchor = row.li.nextSibling;
      }
      // Rows that moved to another group are re-inserted there; anything after the anchor is stale.
      while (rowAnchor) {
        const next = rowAnchor.nextSibling;
        if (!seenRows.has(rowAnchor.dataset?.id)) rowAnchor.remove();
        rowAnchor = next;
      }
    }
    for (const [key, group] of this._groups) {
      if (!seenGroups.has(key)) {
        group.el.remove();
        this._groups.delete(key);
      }
    }
    for (const [id, row] of this._rows) {
      if (!seenRows.has(id)) {
        row.li.remove();
        this._rows.delete(id);
      }
    }
    this._order = order;

    // Selection and the row Tab lands on.
    const selected = this._opts.selectedId;
    for (const [id, row] of this._rows) {
      const sel = id === selected;
      row.li.classList.toggle("sel", sel);
      row.pick.setAttribute("aria-pressed", String(sel));
    }
    this._setCursor(this._rows.has(this._cursor) ? this._cursor : this._rows.has(selected) ? selected : order[0]);

    // Footer and empty state.
    const hiddenCount = all.length - shown;
    const foot = this._els.foot;
    foot.hidden = this._compact || !shown;
    if (!foot.hidden) {
      foot.innerHTML = `${esc(t("passes.footer", { count: this._opts.days }))}${
        hiddenCount
          ? `<span class="hidden-note">${esc(t("passes.hidden", { count: hiddenCount }))} <button class="link" type="button" data-action="show-all">${esc(t("passes.show_all"))}</button></span>`
          : ""
      }`;
    }
    if (foot.parentNode !== scroll || foot.nextSibling) scroll.appendChild(foot);
    this._drawEmpty(shown, all.length);

    this._times();
    this._restoreFocus(before);
    if (reveal && this._rows.has(selected)) this._reveal(this._rows.get(selected), reveal);
  }

  /** The row for a pass, made or brought up to date. */
  _row(pass) {
    const fmt = this._fmt;
    const state = this._state(pass);
    const parts = rowParts(pass, fmt, { live: state === "live", moon: passMoon(pass, this._opts.location) });
    let row = this._rows.get(pass.id);
    if (!row) {
      const li = document.createElement("li");
      li.className = "row";
      li.dataset.id = pass.id;
      row = { li };
      this._rows.set(pass.id, row);
    }
    const acts = [
      this._on.simulate ? ["sim", "play", "simulate"] : null,
      this._on.street ? ["street", "street", "street"] : null,
    ]
      .filter(Boolean)
      .map(
        ([cls, icon, key]) =>
          `<button class="act ${cls}" type="button" data-action="${cls}" aria-label="${esc(fmt.t(`passes.${key}`, parts))}" title="${esc(fmt.t(`passes.${key}_hint`))}">${theme.svgIcon(icon)}<span class="lbl" aria-hidden="true">${esc(fmt.t(`passes.${key}_short`))}</span></button>`
      )
      .join("");
    const html = parts.html.replace('<span class="acts"></span>', `<span class="acts">${acts}</span>`);
    if (html !== row.html) {
      row.li.innerHTML = html;
      row.html = html;
      row.pick = row.li.querySelector("button.pick");
      row.rel = row.li.querySelector(".rel");
      row.relText = "";
    }
    if (parts.label !== row.label) {
      row.pick.setAttribute("aria-label", parts.label);
      row.label = parts.label;
    }
    row.li.classList.toggle("live", state === "live");
    row.pass = pass;
    row.state = state;
    return row;
  }

  /** "in 2 h" under the passes starting within six hours. */
  _times() {
    const fmt = this._fmt;
    for (const row of this._rows.values()) {
      if (!row.rel) continue;
      const wait = row.pass.start - this._now;
      let text = "";
      if (wait > 0 && wait < SOON_S) {
        const minutes = Math.max(1, Math.round(wait / 60));
        const duration = minutes < 60 ? fmt.t("time.minutes", { minutes }) : fmt.t("time.hours", { hours: Math.round(minutes / 60) });
        text = fmt.t("time.in", { duration });
      }
      if (text !== row.relText) {
        row.rel.textContent = text;
        row.relText = text;
      }
    }
  }

  _drawEmpty(shown, total) {
    const empty = this._els.empty;
    empty.hidden = shown > 0;
    this._els.scroll.hidden = shown === 0;
    if (shown) return;
    const t = (key, vars) => this._fmt.t(key, vars);
    const days = this._opts.days;
    let html;
    if (total) {
      // The filters hide every pass there is.
      html = `<h3>${esc(t("passes.empty_filtered"))}</h3>
        <p>${esc(t("passes.hidden", { count: total }))}</p>
        <button class="link" type="button" data-action="show-all">${esc(t("passes.show_all"))}</button>`;
    } else {
      html = `<div class="icon">${theme.svgIcon("satellite")}</div>
        <h3>${esc(this._opts.emptyText || t("passes.empty", { count: days }))}</h3>
        ${this._opts.emptyText ? "" : `<h4>${esc(t("passes.why_not"))}</h4><p>${esc(t("passes.why_not_text"))}</p>
        <h4>${esc(t("passes.check_back"))}</h4><p>${esc(t("passes.check_back_text", { count: days }))}</p>`}`;
    }
    if (html !== this._emptyHtml) {
      empty.innerHTML = html;
      this._emptyHtml = html;
    }
  }

  // ---- Focus and keys ----

  /** Which button has keyboard focus, so a redraw can give it back. */
  _focus() {
    const el = this._root.activeElement;
    const li = el?.closest?.("li[data-id]");
    if (li) return { id: li.dataset.id, action: el.dataset?.action ?? "pick" };
    if (el?.dataset?.filter) return { filter: el.dataset.filter };
    if (el?.dataset?.action === "show-all") return { showAll: true };
    return null;
  }

  _restoreFocus(before) {
    if (!before || this._root.activeElement) return;
    let target = null;
    if (before.id) {
      const row = this._rows.get(before.id) ?? this._rows.get(this._cursor);
      target = row?.li.querySelector(before.action === "pick" ? "button.pick" : `button[data-action="${before.action}"]`) ?? row?.pick;
    } else if (before.filter) {
      target = this._els.filters.querySelector(`button[data-filter="${before.filter}"]`);
    } else if (before.showAll) {
      target = this._rows.get(this._cursor)?.pick;
    }
    // The pass is gone (or filtered out): somewhere close by rather than nowhere.
    target ??= this._rows.get(this._cursor)?.pick ?? this._els.empty.querySelector("button");
    if (!target && this._showFilters) target = this._els.filters.querySelector("button");
    target?.focus({ preventScroll: true });
  }

  /** Only one row is a Tab stop; the arrow keys move between rows. */
  _setCursor(id) {
    this._cursor = this._rows.has(id) ? id : null;
    for (const [rowId, row] of this._rows) {
      const tab = rowId === this._cursor ? "0" : "-1";
      for (const button of row.li.querySelectorAll("button")) {
        if (button.getAttribute("tabindex") !== tab) button.setAttribute("tabindex", tab);
      }
    }
  }

  _click(ev) {
    const button = ev.target?.closest?.("button");
    if (!button) return;
    if (button.dataset.filter) {
      this._toggleFilter(button.dataset.filter);
      return;
    }
    if (button.dataset.action === "show-all") {
      this._setFilters({ brightOnly: false, hideStarlink: false });
      return;
    }
    const id = button.closest("li[data-id]")?.dataset.id;
    if (!id) return;
    this._setCursor(id);
    const action = button.dataset.action;
    if (action === "street") this._on.street?.(id);
    else if (action === "sim") this._on.simulate?.(id);
    else this._select(id);
  }

  _key(ev) {
    const li = ev.target?.closest?.("li[data-id]");
    if (!li) return;
    const id = li.dataset.id;
    const i = this._order.indexOf(id);
    const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: this._order.length - 1 }[ev.key];
    if (go !== undefined) {
      ev.preventDefault();
      const next = this._order[Math.max(0, Math.min(this._order.length - 1, go))];
      if (next === undefined) return;
      const row = this._rows.get(next);
      this._setCursor(next);
      row.pick.focus({ preventScroll: true });
      this._reveal(row, "nearest");
      clearTimeout(this._repeatTimer);
      // Holding the key down skims the list; the pass under it is selected when it stops.
      if (ev.repeat) this._repeatTimer = setTimeout(() => this._select(next, { browse: true }), KEY_REPEAT_SELECT_MS);
      else if (next !== this._opts.selectedId) this._select(next, { browse: true });
      return;
    }
    // Enter and Space act on the row's main button; the small buttons keep their own meaning.
    if (ev.target.dataset?.action) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (!ev.repeat) this._select(id);
    } else if (ev.key === " " || ev.key === "Spacebar") {
      ev.preventDefault(); // Space would also scroll the list.
      if (!ev.repeat) (this._on.simulate ?? this._on.select)?.(id);
    }
  }

  _select(id, how = {}) {
    clearTimeout(this._repeatTimer);
    // The host draws the selection with render(); no need to scroll to a row just picked.
    this._picked = id;
    this._on.select?.(id, how);
  }

  _toggleFilter(key) {
    this._setFilters({ ...this._filters, [key]: !this._filters[key] });
  }

  _setFilters(filters) {
    this._filters = normalizeFilters(filters);
    this._draw({ reveal: false });
    this._on.filter?.({ ...this._filters });
  }

  /**
   * Scroll the list (only the list, never the page) so a row shows whole
   * below its sticky heading: "nearest" moves as little as it can (arrow
   * keys), "start" brings a row out of view up to the top (a pass selected
   * elsewhere). The row lands right under the heading, which then hides the
   * one before it entirely (the rows' scroll-margin does the same for the
   * browser's own scrolling).
   */
  _reveal(row, align = "nearest") {
    const scroll = this._els.scroll;
    if (this._compact || !row?.li?.getBoundingClientRect || !scroll.getBoundingClientRect) return;
    const r = row.li.getBoundingClientRect();
    const s = scroll.getBoundingClientRect();
    if (!s.height) return;
    const head = row.li.closest("section")?.querySelector(".head")?.getBoundingClientRect?.().height ?? 0;
    const top = s.top + head;
    if (r.top >= top && r.bottom <= s.bottom) return;
    if (align === "start" || r.top < top) scroll.scrollTop += r.top - top;
    else scroll.scrollTop += r.bottom - s.bottom;
  }
}
