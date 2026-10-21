/**
 * Satellite sprites: canvas drawings of each kind of satellite, nose (the
 * direction of travel) up, on a transparent background. The globe draws the
 * focus satellite from a 256 px sprite and the cloud of every satellite from
 * 128 px layers of a texture array; the same drawings make icons for the UI.
 *
 * Every glyph is drawn in a 256 x 256 space and scaled to the size asked for,
 * with bold shapes and a light rim, so it still reads at 20 px across.
 */

/** Kind codes of the satellite cloud's per-instance data (and its texture layers). */
export const KIND_CODES = Object.freeze({ iss: 0, tiangong: 1, hubble: 2, satellite: 3, starlink: 4, rocket: 5, debris: 6 });

/** The kinds by code. */
export const KINDS = Object.freeze(Object.keys(KIND_CODES).sort((a, b) => KIND_CODES[a] - KIND_CODES[b]));

/** Everything drawSprite() can draw: the kinds, a Starlink train, and the glow and dot of the globe. */
export const SPRITES = Object.freeze([...KINDS, "train", "glow", "dot"]);

/**
 * Colour of each kind in the satellite cloud, [r, g, b] in 0..1: the stations
 * gold and amber, Hubble lilac, other satellites cyan, Starlinks periwinkle,
 * rocket bodies a warm peach, debris grey.
 */
export const KIND_COLORS = Object.freeze({
  iss: [0.99, 0.83, 0.3],
  tiangong: [1, 0.64, 0.3],
  hubble: [0.9, 0.62, 1],
  satellite: [0.42, 0.85, 1],
  starlink: [0.56, 0.6, 1],
  rocket: [1, 0.7, 0.46],
  debris: [0.62, 0.68, 0.76],
});

/** A known kind, or "satellite" for anything else. */
export function spriteKind(kind) {
  return SPRITES.includes(kind) ? kind : "satellite";
}

function canvas(size) {
  const c = globalThis.document?.createElement("canvas") ?? new OffscreenCanvas(size, size);
  c.width = c.height = size;
  return c;
}

// -- shared bits ---------------------------------------------------------------

/** A rectangle with rounded corners; square corners where roundRect is missing (Safari before 16, Firefox before 112). */
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

/** A solar array: a dark cell grid with a light frame. `cells` = [across, along]. */
function solarArray(g, x, y, w, h, { cells = [2, 6], tones = ["#13235c", "#2c4fb8", "#1a2f7a"], frame = "rgba(203,213,225,.85)", grid = "rgba(147,197,253,.35)" } = {}) {
  const grad = g.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, tones[0]);
  grad.addColorStop(0.5, tones[1]);
  grad.addColorStop(1, tones[2]);
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);
  g.strokeStyle = grid;
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 1; i < cells[0]; i++) {
    g.moveTo(x + (w * i) / cells[0], y);
    g.lineTo(x + (w * i) / cells[0], y + h);
  }
  for (let j = 1; j < cells[1]; j++) {
    g.moveTo(x, y + (h * j) / cells[1]);
    g.lineTo(x + w, y + (h * j) / cells[1]);
  }
  g.stroke();
  // A glint across the cells, as on a photo of an array.
  const glint = g.createLinearGradient(x, y, x + w, y + h);
  glint.addColorStop(0, "rgba(255,255,255,0)");
  glint.addColorStop(0.45, "rgba(191,219,254,.22)");
  glint.addColorStop(0.55, "rgba(191,219,254,0)");
  g.fillStyle = glint;
  g.fillRect(x, y, w, h);
  g.strokeStyle = frame;
  g.lineWidth = 2;
  g.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

/** A metal cylinder seen from the side, lit from the left: [x, y] is its top-left corner. */
function cylinder(g, x, y, w, h, { r = w / 2.6, light = "#ffffff", mid = "#cbd5e1", dark = "#64748b" } = {}) {
  const grad = g.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, mid);
  grad.addColorStop(0.32, light);
  grad.addColorStop(0.7, mid);
  grad.addColorStop(1, dark);
  g.fillStyle = grad;
  roundRect(g, x, y, w, h, r);
  g.fill();
}

/** Gold foil (multi-layer insulation): a warm gradient with a few crinkles. */
function foil(g, x, y, w, h) {
  const grad = g.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, "#8a5a12");
  grad.addColorStop(0.35, "#f4c35a");
  grad.addColorStop(0.6, "#c98a2b");
  grad.addColorStop(1, "#6b4515");
  g.fillStyle = grad;
  roundRect(g, x, y, w, h, 3);
  g.fill();
  g.strokeStyle = "rgba(255,236,179,.55)";
  g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 1; i < 4; i++) {
    const yy = y + (h * i) / 4;
    g.moveTo(x + 3, yy - 2);
    g.lineTo(x + w * 0.45, yy + 2);
    g.lineTo(x + w - 3, yy - 1);
  }
  g.stroke();
  g.strokeStyle = "rgba(255,244,214,.8)";
  g.lineWidth = 2;
  roundRect(g, x + 1, y + 1, w - 2, h - 2, 3);
  g.stroke();
}

// -- the kinds -------------------------------------------------------------------

/** The International Space Station: gold array wings on a long truss, modules along the direction of travel. */
export function drawStation(size = 256) {
  const c = canvas(size);
  const g = c.getContext("2d");
  const s = size / 256;
  g.scale(s, s);
  const wing = (x, y, h) => {
    const grad = g.createLinearGradient(x, 0, x + 24, 0);
    grad.addColorStop(0, "#5b3a12");
    grad.addColorStop(0.45, "#c98a2b");
    grad.addColorStop(0.55, "#e2a944");
    grad.addColorStop(1, "#6b4515");
    g.fillStyle = grad;
    g.fillRect(x, y, 24, h);
    g.strokeStyle = "rgba(30,20,8,.55)";
    g.lineWidth = 1;
    for (let k = 1; k < 6; k++) {
      g.beginPath();
      g.moveTo(x, y + (h * k) / 6);
      g.lineTo(x + 24, y + (h * k) / 6);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(x + 12, y);
    g.lineTo(x + 12, y + h);
    g.stroke();
    g.strokeStyle = "rgba(255,230,170,.7)";
    g.strokeRect(x + 0.5, y + 0.5, 23, h - 1);
  };
  // Solar array wings at both ends of the truss, above and below it.
  for (const x of [14, 44, 188, 218]) {
    wing(x, 34, 84);
    wing(x, 138, 84);
  }
  // Main truss.
  const truss = g.createLinearGradient(0, 122, 0, 134);
  truss.addColorStop(0, "#f1f5f9");
  truss.addColorStop(1, "#94a3b8");
  g.fillStyle = truss;
  g.fillRect(10, 123, 236, 10);
  g.strokeStyle = "rgba(51,65,85,.6)";
  for (let x = 16; x < 246; x += 10) {
    g.beginPath();
    g.moveTo(x, 123);
    g.lineTo(x + 5, 133);
    g.stroke();
  }
  // Radiators.
  g.fillStyle = "#f8fafc";
  g.fillRect(92, 100, 10, 22);
  g.fillRect(154, 134, 10, 22);
  // Pressurised modules along the direction of travel.
  const mod = g.createLinearGradient(116, 0, 140, 0);
  mod.addColorStop(0, "#94a3b8");
  mod.addColorStop(0.4, "#ffffff");
  mod.addColorStop(1, "#7c8aa0");
  g.fillStyle = mod;
  roundRect(g, 117, 44, 22, 168, 9);
  g.fill();
  g.fillRect(102, 76, 52, 14); // Columbus / Kibo
  g.fillRect(108, 176, 40, 12); // Zvezda's arrays mount
  g.fillStyle = "#cbd5e1";
  g.beginPath();
  g.arc(128, 44, 9, 0, 2 * Math.PI);
  g.fill();
  return c;
}

/**
 * China's Tiangong: a T, the Tianhe core along the direction of travel and the
 * Wentian and Mengtian labs across its front, with their long dark-blue arrays
 * at the ends of the T and Tianhe's smaller arrays behind.
 */
function drawTiangong(g) {
  // The labs' arrays, fore and aft of each end of the crossbar.
  for (const x of [16, 214]) {
    solarArray(g, x, 18, 26, 78, { cells: [2, 7] });
    solarArray(g, x, 116, 26, 78, { cells: [2, 7] });
    g.fillStyle = "#cbd5e1";
    g.fillRect(x + 10, 92, 6, 28); // the array's mast
  }
  // Tianhe's arrays, behind the crossbar.
  solarArray(g, 58, 166, 52, 18, { cells: [4, 2], tones: ["#1b2a63", "#3557c4", "#1b2a63"] });
  solarArray(g, 146, 166, 52, 18, { cells: [4, 2], tones: ["#1b2a63", "#3557c4", "#1b2a63"] });
  g.fillStyle = "#94a3b8";
  g.fillRect(106, 172, 44, 6);
  // Wentian and Mengtian, the crossbar.
  const lab = g.createLinearGradient(0, 94, 0, 118);
  lab.addColorStop(0, "#94a3b8");
  lab.addColorStop(0.35, "#ffffff");
  lab.addColorStop(1, "#7c8aa0");
  g.fillStyle = lab;
  roundRect(g, 40, 95, 176, 22, 9);
  g.fill();
  g.fillStyle = "rgba(201,138,43,.75)"; // gold foil bands
  for (const x of [66, 86, 170, 190]) g.fillRect(x, 95, 5, 22);
  // Tianhe, the core, with its wider service section at the back.
  cylinder(g, 116, 96, 24, 104, { r: 8 });
  cylinder(g, 111, 160, 34, 44, { r: 6, mid: "#d6dde6" });
  g.fillStyle = "rgba(201,138,43,.8)";
  g.fillRect(111, 186, 34, 5);
  // A Tianzhou cargo ship docked at the back, a Shenzhou crew ship at the front.
  cylinder(g, 118, 204, 20, 30, { r: 6, mid: "#e2e8f0" });
  cylinder(g, 120, 60, 16, 34, { r: 7, mid: "#e2e8f0" });
  // The node joining it all.
  const node = g.createRadialGradient(124, 102, 2, 128, 106, 15);
  node.addColorStop(0, "#ffffff");
  node.addColorStop(1, "#8b98ab");
  g.fillStyle = node;
  g.beginPath();
  g.arc(128, 106, 14, 0, 2 * Math.PI);
  g.fill();
}

/** Hubble: a silver tube with its aperture door open at the front, and two long arrays beside it. */
function drawHubble(g) {
  // The arrays on a boom across the tube.
  g.fillStyle = "#cbd5e1";
  g.fillRect(84, 125, 88, 6);
  solarArray(g, 52, 64, 32, 128, { cells: [2, 8], tones: ["#2a1a5e", "#4c3ab0", "#23185a"], frame: "rgba(234,179,8,.85)" });
  solarArray(g, 172, 64, 32, 128, { cells: [2, 8], tones: ["#2a1a5e", "#4c3ab0", "#23185a"], frame: "rgba(234,179,8,.85)" });
  // The aft shroud, a little wider, then the light shield in front of it.
  cylinder(g, 99, 142, 58, 82, { r: 10, mid: "#d1d9e3" });
  cylinder(g, 105, 46, 46, 104, { r: 6, mid: "#e5eaf0" });
  // Bands where the sections meet.
  g.fillStyle = "rgba(100,116,139,.75)";
  g.fillRect(105, 84, 46, 3);
  g.fillRect(99, 148, 58, 4);
  g.fillRect(99, 190, 58, 3);
  // The aperture, and its door hinged open beside it.
  g.fillStyle = "#0b1224";
  g.beginPath();
  g.ellipse(128, 47, 21, 5, 0, 0, 2 * Math.PI);
  g.fill();
  g.save();
  g.translate(150, 46);
  g.rotate(1.95);
  const door = g.createLinearGradient(0, -8, 0, 0);
  door.addColorStop(0, "#94a3b8");
  door.addColorStop(1, "#f8fafc");
  g.fillStyle = door;
  roundRect(g, -46, -7, 46, 7, 3);
  g.fill();
  g.restore();
}

/** A satellite in general: a box of gold foil with a dish, and a blue array on a boom either side. */
function drawSatellite(g) {
  g.fillStyle = "#cbd5e1";
  g.fillRect(84, 125, 88, 6); // booms
  solarArray(g, 18, 100, 66, 56, { cells: [4, 3] });
  solarArray(g, 172, 100, 66, 56, { cells: [4, 3] });
  foil(g, 102, 92, 52, 72);
  // A dish on the front face and a whip antenna at the back.
  g.strokeStyle = "#e2e8f0";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(128, 92);
  g.lineTo(128, 80);
  g.moveTo(140, 164);
  g.lineTo(150, 192);
  g.stroke();
  const dish = g.createLinearGradient(104, 0, 152, 0);
  dish.addColorStop(0, "#94a3b8");
  dish.addColorStop(0.4, "#ffffff");
  dish.addColorStop(1, "#8b98ab");
  g.fillStyle = dish;
  g.beginPath();
  g.ellipse(128, 70, 26, 13, 0, 0, 2 * Math.PI);
  g.fill();
  g.fillStyle = "#cbd5e1";
  g.beginPath();
  g.arc(128, 70, 4, 0, 2 * Math.PI);
  g.fill();
}

/** A Starlink: a flat slab of a body with its one long array, as they look on their way up. */
function drawStarlink(g) {
  solarArray(g, 94, 16, 68, 132, { cells: [3, 8], tones: ["#151d42", "#3a55b0", "#151d42"], frame: "rgba(203,213,225,.85)" });
  // The boom from the array to the body.
  g.fillStyle = "#cbd5e1";
  g.fillRect(124, 146, 8, 24);
  // The slab, seen at an angle: its light top face and dark edge.
  const top = g.createLinearGradient(66, 0, 190, 0);
  top.addColorStop(0, "#64748b");
  top.addColorStop(0.35, "#f1f5f9");
  top.addColorStop(1, "#475569");
  g.fillStyle = top;
  g.beginPath();
  g.moveTo(80, 168);
  g.lineTo(190, 168);
  g.lineTo(176, 204);
  g.lineTo(66, 204);
  g.closePath();
  g.fill();
  g.fillStyle = "#1e293b";
  g.fillRect(66, 204, 110, 10);
  g.strokeStyle = "rgba(248,250,252,.75)";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(80, 168);
  g.lineTo(190, 168);
  g.stroke();
  // Seams between the panels of its flat top.
  g.strokeStyle = "rgba(51,65,85,.45)";
  g.lineWidth = 1.5;
  g.beginPath();
  for (const x of [117, 153]) {
    g.moveTo(x, 168);
    g.lineTo(x - 14, 204);
  }
  g.stroke();
}

/** A Starlink train: a line of lights one behind the other, the leader brightest. */
function drawTrain(g) {
  const dots = 6;
  for (let i = dots - 1; i >= 0; i--) {
    const f = i / (dots - 1);
    const x = 52 + f * 152;
    const y = 204 - f * 152;
    const r = 9 + f * 9;
    const glow = g.createRadialGradient(x, y, 0, x, y, r * 2.2);
    glow.addColorStop(0, `rgba(224,231,255,${0.5 + 0.5 * f})`);
    glow.addColorStop(0.35, `rgba(165,180,252,${0.25 + 0.35 * f})`);
    glow.addColorStop(1, "rgba(165,180,252,0)");
    g.fillStyle = glow;
    g.beginPath();
    g.arc(x, y, r * 2.2, 0, 2 * Math.PI);
    g.fill();
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(x, y, r * 0.45, 0, 2 * Math.PI);
    g.fill();
  }
}

/**
 * A rocket body: a spent stage with its engine bell, tilted, with arcs that
 * show it tumbling (it does not fly nose first, so it is not turned with its
 * direction of travel).
 */
function drawRocket(g) {
  g.save();
  g.translate(128, 128);
  g.rotate(Math.PI / 6);
  // Tumbling arcs around it.
  g.strokeStyle = "rgba(254,215,170,.55)";
  g.lineWidth = 4;
  g.lineCap = "round";
  g.beginPath();
  g.arc(0, 0, 104, -2.5, -1.75);
  g.stroke();
  g.beginPath();
  g.arc(0, 0, 104, 0.64, 1.39);
  g.stroke();
  // The engine bell.
  const bell = g.createLinearGradient(-28, 0, 28, 0);
  bell.addColorStop(0, "#334155");
  bell.addColorStop(0.35, "#94a3b8");
  bell.addColorStop(1, "#1e293b");
  g.fillStyle = bell;
  g.beginPath();
  g.moveTo(-12, 62);
  g.lineTo(12, 62);
  g.lineTo(28, 102);
  g.lineTo(-28, 102);
  g.closePath();
  g.fill();
  // The stage: white, with an orange band of insulation and a dark interstage ring.
  cylinder(g, -26, -98, 52, 164, { r: 14 });
  const band = g.createLinearGradient(-26, 0, 26, 0);
  band.addColorStop(0, "#c2410c");
  band.addColorStop(0.32, "#fdba74");
  band.addColorStop(0.7, "#ea580c");
  band.addColorStop(1, "#7c2d12");
  g.fillStyle = band;
  g.fillRect(-26, -2, 52, 46);
  g.fillStyle = "#334155";
  g.fillRect(-26, -48, 52, 8);
  g.fillRect(-26, 56, 52, 8);
  g.restore();
}

/** Debris: a jagged shard of metal and two smaller pieces. */
function drawDebris(g) {
  const shard = (points, light) => {
    const xs = points.map((p) => p[0]);
    const grad = g.createLinearGradient(Math.min(...xs), 0, Math.max(...xs), 0);
    grad.addColorStop(0, "#475569");
    grad.addColorStop(0.4, light);
    grad.addColorStop(1, "#334155");
    g.fillStyle = grad;
    g.beginPath();
    points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
    g.strokeStyle = "rgba(241,245,249,.75)";
    g.lineWidth = 2.5;
    g.lineJoin = "round";
    g.stroke();
  };
  shard([[98, 58], [158, 74], [184, 128], [150, 176], [118, 198], [82, 150], [100, 112]], "#cbd5e1");
  shard([[60, 190], [84, 196], [74, 222], [50, 214]], "#94a3b8");
  shard([[186, 52], [208, 62], [200, 84], [180, 76]], "#94a3b8");
}

const DRAW = {
  tiangong: drawTiangong,
  hubble: drawHubble,
  satellite: drawSatellite,
  starlink: drawStarlink,
  train: drawTrain,
  rocket: drawRocket,
  debris: drawDebris,
};

/** A soft round glow from `inner` at the centre to `outer` at the edge. */
export function drawGlow(size, inner, outer) {
  const c = canvas(size);
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/**
 * A canvas of `size` px with the sprite of a kind (see SPRITES; anything else
 * is drawn as a satellite), nose up, its colours not premultiplied.
 */
export function drawSprite(kind, size = 256) {
  const k = spriteKind(kind);
  if (k === "iss") return drawStation(size);
  if (k === "glow") return drawGlow(size, "rgba(255,244,214,0.95)", "rgba(255,200,120,0)");
  if (k === "dot") return drawGlow(size, "rgba(255,255,255,1)", "rgba(255,255,255,0)");
  const c = canvas(size);
  const g = c.getContext("2d");
  g.scale(size / 256, size / 256);
  DRAW[k](g);
  return c;
}

const icons = new Map();
/**
 * The sprite of a kind as a PNG data URL, `px` CSS pixels across (drawn for
 * the screen's pixel ratio), for <img> icons in the UI. Made once per kind and
 * size.
 */
export function spriteIcon(kind, px = 24) {
  const ratio = Math.min(3, Math.max(1, Math.round(globalThis.devicePixelRatio || 1)));
  const key = `${spriteKind(kind)}:${px}:${ratio}`;
  let url = icons.get(key);
  if (!url) {
    url = drawSprite(kind, Math.max(1, Math.round(px * ratio))).toDataURL("image/png");
    icons.set(key, url);
  }
  return url;
}
