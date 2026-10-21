/**
 * "Where to look" sky chart: the observer's sky as a dome seen from below,
 * north at the top and east to the right like a compass, with the pass drawn
 * across it: the satellite's path (gold where it can be seen), the other
 * satellites of the pass as thin paths, the moment it is brightest, and a dot
 * where it is now. Returns an SVG string; pure, so it is unit tested in node.
 */

const DEG = Math.PI / 180;

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const f1 = (v) => v.toFixed(1);

/** Polar position of an azimuth/elevation on a dome of radius r centred at (c, c). */
export function skyXY(azimuth, elevation, r, c) {
  const rr = (Math.max(0, 90 - elevation) / 90) * r;
  return [c + rr * Math.sin(azimuth * DEG), c - rr * Math.cos(azimuth * DEG)];
}

/** Where the live dot goes on a chart of this size; null while the satellite is below the horizon. */
export function skyDotXY(live, size = 220) {
  if (!live || !(live.elevation > 0)) return null;
  const c = size / 2;
  return skyXY(live.azimuth, live.elevation, c - 22, c);
}

/** The transform that puts the live dot (the chart's .live-dot group) at xy. */
export const skyDotTransform = ([x, y]) => `translate(${f1(x)} ${f1(y)})`;

/**
 * A pass_track transit's rows as sky points: [{t, azimuth, elevation, mag}]
 * (the rows carry the look angles: [t, lat, lon, alt, lit, az, el, range, mag, vis]).
 * `offsetS` shifts the times, for a train member drawn as a copy of the leader.
 */
export function skyPoints(rows, offsetS = 0) {
  return (rows || []).map((r) => ({ t: r[0] + offsetS, azimuth: r[5], elevation: r[6], mag: r[8] ?? null }));
}

function pathData(points, r, c) {
  return points
    .map((p, i) => {
      const [x, y] = skyXY(p.azimuth, p.elevation, r, c);
      return `${i ? "L" : "M"}${f1(x)} ${f1(y)}`;
    })
    .join("");
}

/** Points above the horizon, and the part of them inside the visible window (±1 s). */
function split(track, visibleStart, visibleEnd) {
  const above = (track || []).filter((p) => Number.isFinite(p.azimuth) && p.elevation >= 0);
  const visible = above.filter((p) => p.t >= visibleStart - 1 && p.t <= visibleEnd + 1);
  return { above, visible };
}

/** A five-pointed star of outer radius r centred at (x, y). */
function starPath(x, y, r) {
  let d = "";
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r;
    const a = (i * 36 - 90) * DEG;
    d += `${i ? "L" : "M"}${f1(x + rr * Math.cos(a))} ${f1(y + rr * Math.sin(a))}`;
  }
  return `${d}Z`;
}

// Label boxes: about this wide per character at 10 px, this tall above the baseline.
const CHAR_W = 5.9;
const TEXT_H = 10;

/**
 * Put each label beside its point where it covers no other label and no
 * marker (above, below, to either side, then the corners), inside the chart.
 * Greedy, in the order given: earlier labels get their first choice.
 * @returns {Array<{x:number, y:number}>} text anchors (middle, baseline)
 */
export function placeLabels(labels, { size, obstacles = [] }) {
  const boxes = obstacles.map((b) => ({ ...b }));
  const overlap = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  return labels.map(({ x, y, text }) => {
    const w = text.length * CHAR_W + 4;
    const candidates = [
      [0, -9], [0, 17], [w / 2 + 9, 4], [-w / 2 - 9, 4], [w / 2 + 4, -7], [-w / 2 - 4, -7], [w / 2 + 4, 15], [-w / 2 - 4, 15],
    ];
    let best = null;
    candidates.forEach(([dx, dy], rank) => {
      // Middle-anchored text, kept off the chart's edge.
      const ax = Math.min(size - w / 2 - 2, Math.max(w / 2 + 2, x + dx));
      const ay = Math.min(size - 3, Math.max(TEXT_H + 2, y + dy));
      const box = { x1: ax - w / 2, x2: ax + w / 2, y1: ay - TEXT_H + 1, y2: ay + 2 };
      const cost = boxes.reduce((sum, b) => sum + overlap(box, b), 0) * 10 + rank;
      if (!best || cost < best.cost) best = { cost, ax, ay, box };
    });
    boxes.push(best.box);
    return { x: best.ax, y: best.ay };
  });
}

/**
 * @param {object} o
 * @param {Array<{t:number, azimuth:number, elevation:number}>} o.track the satellite's whole pass above the horizon
 * @param {number} o.visibleStart unix seconds it becomes visible
 * @param {number} o.visibleEnd unix seconds it stops being visible
 * @param {{azimuth:number, elevation:number}|null} [o.live] where it is now, if overhead
 * @param {(t:number) => string} [o.formatTime] the times where the pass starts and ends
 * @param {boolean} [o.times] label the start and the end with their times (small charts leave them out)
 * @param {number} [o.size]
 * @param {string} [o.id] id of the dome's gradient; unique per chart in the same document
 * @param {string[]} [o.cardinals] names of north, east, south and west
 * @param {string} [o.label] what the chart is, for screen readers
 * @param {Array<{track: Array, visibleStart: number, visibleEnd: number}>} [o.members] the other
 *   satellites of the pass, drawn as thin paths
 * @param {{azimuth:number, elevation:number, text:string}|null} [o.brightest] where the pass is
 *   brightest, marked with a star and `text` (the magnitude, "−2.1")
 */
export function skyChartSvg({
  track, visibleStart, visibleEnd, live = null, formatTime = null, times = true, size = 220, id = "sky",
  cardinals = ["N", "E", "S", "W"], label = "Sky chart of the pass", members = [], brightest = null,
}) {
  const c = size / 2;
  const r = c - 22;
  const xy = (p) => skyXY(p.azimuth, p.elevation, r, c);
  const { above, visible } = split(track, visibleStart, visibleEnd);
  const rings = [0, 30, 60]
    .map((el) => `<circle cx="${c}" cy="${c}" r="${f1(((90 - el) / 90) * r)}" class="${el ? "ring" : "horizon"}"/>`)
    .join("");
  // The rings' degree labels go along whichever side of the north-south line
  // is furthest from the path (passes often cross the middle).
  const path = (track || []).filter((p) => Number.isFinite(p.azimuth) && p.elevation >= 0).map(xy);
  const ringAt = (side, el) => {
    const y = c + side * (((90 - el) / 90) * r - 10);
    return [c + 3, side < 0 ? y : y + 8];
  };
  const clearance = (side) =>
    Math.min(
      ...[30, 60].flatMap((el) => {
        const [x, y] = ringAt(side, el);
        return path.map(([px, py]) => Math.hypot(px - x - 6, py - y + 3));
      }),
      Infinity
    );
  const side = clearance(-1) >= Math.min(24, clearance(1)) ? -1 : 1;
  // What the pass's labels must not cover: the ring labels and the compass.
  const obstacles = [];
  const ringLabels = [30, 60]
    .map((el) => {
      const [x, y] = ringAt(side, el);
      obstacles.push({ x1: x, x2: x + 16, y1: y - 8, y2: y + 1 });
      return `<text x="${f1(x)}" y="${f1(y)}" class="rl">${el}°</text>`;
    })
    .join("");
  const compass = cardinals
    .map((name, i) => {
      const [x, y] = skyXY(i * 90, -11, r, c);
      obstacles.push({ x1: x - 7, x2: x + 7, y1: y - 6, y2: y + 6 });
      return `<text x="${f1(x)}" y="${f1(y + 4)}" class="card">${esc(name)}</text>`;
    })
    .join("");

  // The other satellites first, so the one the pass is named after is on top.
  let others = "";
  for (const m of (members || []).slice(0, 24)) {
    const part = split(m.track, m.visibleStart, m.visibleEnd);
    if (part.above.length > 1) others += `<path d="${pathData(part.above, r, c)}" class="m-above"/>`;
    if (part.visible.length > 1) others += `<path d="${pathData(part.visible, r, c)}" class="m-vis"/>`;
  }

  let pass = "";
  if (visible.length > 1) {
    const first = visible[0];
    const last = visible[visible.length - 1];
    const top = visible.reduce((a, b) => (b.elevation > a.elevation ? b : a));
    const [sx, sy] = xy(first);
    const [ex, ey] = xy(last);
    const [px, py] = xy(top);
    // Arrow head pointing along the direction of travel at the end.
    const prev = visible[Math.max(0, visible.length - 3)];
    const [qx, qy] = xy(prev);
    const ang = Math.atan2(ey - qy, ex - qx);
    const head = (d, s) => `${f1(ex - 9 * Math.cos(ang + s * d))} ${f1(ey - 9 * Math.sin(ang + s * d))}`;
    // The brightest moment: a star with the magnitude; at the highest point
    // too when the two are close, with one label for both.
    let star = "";
    let peakText = `${Math.round(top.elevation)}°`;
    let mag = null;
    if (brightest && Number.isFinite(brightest.azimuth) && Number.isFinite(brightest.elevation)) {
      const [bx, by] = skyXY(brightest.azimuth, Math.max(0, brightest.elevation), r, c);
      const near = Math.hypot(bx - px, by - py) < 16;
      const text = brightest.text ? String(brightest.text) : "";
      if (near) {
        star = `<path d="${starPath(px, py, 6.5)}" class="star"/>`;
        if (text) peakText += ` · ${text}`;
      } else {
        star = `<path d="${starPath(bx, by, 6.5)}" class="star"/>`;
        if (text) mag = { x: bx, y: by, text };
      }
    }
    // The markers themselves are taken; then each label finds a free place.
    for (const [x, y] of [[sx, sy], [px, py], [ex, ey], ...(mag ? [[mag.x, mag.y]] : [])]) {
      obstacles.push({ x1: x - 6, x2: x + 6, y1: y - 6, y2: y + 6 });
    }
    // Without times (a small chart) the other labels have the room to themselves.
    const timed = times && typeof formatTime === "function";
    const labels = [
      ...(timed ? [{ x: sx, y: sy, text: formatTime(first.t), cls: "lbl" }, { x: ex, y: ey, text: formatTime(last.t), cls: "lbl" }] : []),
      { x: px, y: py, text: peakText, cls: "lbl peak" },
      ...(mag ? [{ ...mag, cls: "lbl mag" }] : []),
    ];
    const at = placeLabels(labels, { size, obstacles });
    const texts = labels.map((l, i) => `<text x="${f1(at[i].x)}" y="${f1(at[i].y)}" class="${l.cls}">${esc(l.text)}</text>`).join("");
    pass = `
      <path d="${pathData(above, r, c)}" class="above"/>
      <path d="${pathData(visible, r, c)}" class="glow"/>
      <path d="${pathData(visible, r, c)}" class="vis"/>
      <path d="M${head(0.45, 1)}L${f1(ex)} ${f1(ey)}L${head(0.45, -1)}" class="arrow"/>
      <circle cx="${f1(sx)}" cy="${f1(sy)}" r="4" class="pt"/>
      <circle cx="${f1(px)}" cy="${f1(py)}" r="3.5" class="pt peak"/>
      ${star}${texts}`;
  }
  // Always there, hidden while the satellite is not up: a chart on screen
  // follows it by moving this group, not by being drawn again.
  const at = skyDotXY(live, size);
  const dot = `<g class="live-dot" transform="${skyDotTransform(at || [c, c])}"${at ? "" : ' display="none"'}>
      <circle r="9" class="live-halo"/><circle r="4.5" class="live"/></g>`;
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)}">
    <defs><radialGradient id="${esc(id)}" r="0.5"><stop offset="0" stop-color="#16244a"/><stop offset="1" stop-color="#070c1c"/></radialGradient></defs>
    <circle cx="${c}" cy="${c}" r="${r}" fill="url(#${esc(id)})"/>
    ${rings}
    <path d="M${c} ${c - r}V${c + r}M${c - r} ${c}H${c + r}" class="cross"/>
    ${ringLabels}${compass}${others}${pass}${dot}
  </svg>`;
}

export const SKY_STYLE = `
.sky svg { display: block; overflow: visible; }
.sky .horizon { fill: none; stroke: rgba(148,163,184,.55); stroke-width: 1.2; }
.sky .ring { fill: none; stroke: rgba(148,163,184,.25); stroke-dasharray: 3 3; }
.sky .cross { stroke: rgba(148,163,184,.14); }
.sky .rl { fill: rgba(203,213,225,.55); font-size: 9px; }
.sky .card { fill: #e2e8f0; font-size: 11px; font-weight: 700; text-anchor: middle; }
.sky .above { fill: none; stroke: rgba(226,232,240,.35); stroke-width: 1.4; stroke-dasharray: 2 3; }
.sky .m-above { fill: none; stroke: rgba(226,232,240,.18); stroke-width: 1; stroke-dasharray: 2 3; }
.sky .m-vis { fill: none; stroke: rgba(252,211,77,.55); stroke-width: 1.4; stroke-linecap: round; }
.sky .glow { fill: none; stroke: rgba(251,191,36,.35); stroke-width: 8; stroke-linecap: round; }
.sky .vis { fill: none; stroke: #fcd34d; stroke-width: 3; stroke-linecap: round; }
.sky .arrow { fill: none; stroke: #fcd34d; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.sky .pt { fill: #fcd34d; stroke: #78350f; stroke-width: 1.2; }
.sky .star { fill: #fff7d6; stroke: #b45309; stroke-width: 1; filter: drop-shadow(0 0 3px rgba(253,230,138,.9)); }
.sky .lbl { fill: #fef3c7; font-size: 10px; font-weight: 600; text-anchor: middle; paint-order: stroke; stroke: rgba(0,0,0,.7); stroke-width: 3px; }
.sky .lbl.mag { fill: #fff7d6; }
.sky .live { fill: #fff; }
.sky .live-halo { fill: rgba(253,230,138,.35); }
@media (prefers-reduced-motion: no-preference) { .sky .live-halo { animation: sky-pulse 1.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; } }
@keyframes sky-pulse { 50% { transform: scale(1.6); opacity: .25; } }
`;
