/**
 * The street view's 3D scene: MapLibre with its camera at the observer's
 * eye, among OpenFreeMap's buildings on AWS terrain, with trees and street
 * lights (sat-street-props.js), lit for the time of the pass: facades with
 * windows by day, lit windows at night, street lights glowing over pools of
 * light. The map is transparent above the skyline, so the planetarium sky
 * drawn on a canvas behind it shows through and is hidden by whatever stands
 * in the way (sat-planetarium.js).
 *
 * The recipe (verified in a spike against MapLibre 6.11.2, which is vendored):
 *  - The camera stays at the eye; the map's "centre" goes some metres along
 *    the line of sight so the scale is 25 px per metre at it. That keeps the
 *    near plane at about half a metre and the zoom fixed for a place.
 *    MapLibre's own eye-level helper puts the centre 10 km away and with it
 *    the near plane 186 m out, clipping every nearby building.
 *  - The far plane follows from the camera's height above sea level, about
 *    18 km for a low observer, cutting off distant hills: it is overridden to
 *    150 km through a private transform method (feature-detected).
 *  - centerClampedToGround must be off: looking up, the centre is above the eye.
 *  - The eye stands on the z15 terrain tile under the observer, and is
 *    re-seated on the rendered terrain whenever the map settles.
 * The maths and the style are pure and unit tested in node.
 */

const VERSION = new URL(import.meta.url).search;
const [horizon, planetarium, propsModule] = await Promise.all([
  import(`./sat-horizon.js${VERSION}`),
  import(`./sat-planetarium.js${VERSION}`),
  import(`./sat-street-props.js${VERSION}`),
]);
const { TERRARIUM, TERRAIN_ATTRIBUTION } = horizon;
const { bandFor, occlusionFromBand } = planetarium;
const { MAX_TREES, MAX_TREES_PHONE, PROPS_RADIUS_M, PropsLayer, glows, instances, localFrame, placeLamps, plantTrees, poolMesh, readMap } = propsModule;

export const OFM_TILEJSON = "https://tiles.openfreemap.org/planet";
export const ESRI_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const ESRI_ATTRIBUTION = "Imagery: Powered by Esri. Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community";
export { TERRAIN_ATTRIBUTION };

/** Scale at the camera's centre point, px per metre (sets the near plane: height / 50 px). */
export const PX_PER_M = 25;
/** How far the scene reaches (km): distant ranges stay on the horizon. */
export const FAR_KM = 150;
/** Near plane (m): nothing closer than this is drawn. */
export const NEAR_M = 0.5;
/** The eye heights on offer (m): standing, a first-floor balcony, a rooftop. */
export const EYE_HEIGHTS = [1.7, 6, 15];
/** Pitch range: 80 looks 10° down (lower, the far plane collapses to 1 km), 178 almost straight up. */
export const PITCH_MIN = 80;
export const PITCH_MAX = 178;
/** MapLibre's Earth: a sphere of radius 6371008.8 m. */
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6371008.8;

const DEG = Math.PI / 180;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixRGB = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const cssHex = (c) => `#${c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
const mixHex = (a, b, t) => cssHex(mixRGB(hex(a), hex(b), t));

// ---------------------------------------------------------------------------
// Web Mercator (MapLibre's MercatorCoordinate)

/** Mercator coordinates (0..1 across the world, y down, z in the same units) of a place. */
export function mercatorFromLngLat(lng, lat, altitude = 0) {
  const x = (180 + lng) / 360;
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  return { x, y, z: altitude / (EARTH_CIRCUMFERENCE * Math.cos(lat * DEG)) };
}

/** [lng, lat] of mercator x, y. */
export function lngLatFromMercator(x, y) {
  const y2 = 180 - y * 360;
  return [x * 360 - 180, (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90];
}

/** Mercator units per metre at a latitude. */
export function meterInMercatorUnits(lat) {
  return 1 / (EARTH_CIRCUMFERENCE * Math.cos(lat * DEG));
}

/**
 * The jumpTo() options that put MapLibre's camera at an eye: the centre goes
 * D = focal / ppm metres along the line of sight (focal = height / 2 /
 * tan(fov / 2), MapLibre's cameraToCenterDistance), so the scale there is ppm
 * pixels per metre; with pitch > 90 it is above the eye.
 * @returns {{center: [number, number], elevation: number, zoom: number, bearing: number, pitch: number, roll: number, ppm: number, distance: number}}
 */
export function eyeCamera({ longitude, latitude, eyeAltitude, bearing, pitch, roll = 0, fov, height, ppm = PX_PER_M }) {
  const focal = height / 2 / Math.tan((fov * DEG) / 2);
  const distance = focal / ppm;
  const eye = mercatorFromLngLat(longitude, latitude, eyeAltitude);
  const units = distance * meterInMercatorUnits(latitude);
  const p = pitch * DEG;
  const b = bearing * DEG;
  const center = lngLatFromMercator(eye.x + Math.sin(p) * Math.sin(b) * units, eye.y - Math.sin(p) * Math.cos(b) * units);
  const elevation = eyeAltitude - Math.cos(p) * distance;
  const zoom = Math.log2(focal / units / 512);
  return { center, elevation, zoom, bearing, pitch, roll, ppm, distance };
}

/**
 * Override MapLibre's near and far planes (px at the centre: metres × ppm)
 * through the transform's overrideNearFarZ, a private method of 6.11.2. It
 * survives jumpTo but its values depend on ppm, so it is applied after each
 * camera change. Returns whether it could be (else the default stays, and
 * distant hills beyond about 18 km are cut off).
 */
export function overrideFarPlane(map, ppm = PX_PER_M, { nearM = NEAR_M, farKm = FAR_KM } = {}) {
  const camera = map?._camera;
  const transforms = [camera?.transform ?? map?.transform, camera?._requestedCameraState].filter((t) => typeof t?.overrideNearFarZ === "function");
  for (const t of transforms) t.overrideNearFarZ(nearM * ppm, farKm * 1000 * ppm);
  return transforms.length > 0;
}

// ---------------------------------------------------------------------------
// The look of the scene by the light of the Sun and Moon

/**
 * How many windows are lit at a local solar hour (0..24): few in the small
 * hours, most in the evening; by day a few (the patterns show them only once
 * the light goes).
 */
export function litShare(hour) {
  const h = ((hour % 24) + 24) % 24;
  // Hour: share lit, joined by straight lines.
  const table = [[0, 0.22], [1.5, 0.13], [3, 0.08], [5, 0.09], [6.5, 0.2], [8, 0.14], [16, 0.12], [18, 0.3], [20, 0.4], [22, 0.34], [24, 0.22]];
  for (let i = 1; i < table.length; i++) {
    const [h0, v0] = table[i - 1];
    const [h1, v1] = table[i];
    if (h <= h1) return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
  }
  return table[0][1];
}

/**
 * Colours and light for a Sun ({azimuth, elevation}) and Moon ({azimuth,
 * elevation, fraction}), and the local solar hour if known (it says how many
 * windows are lit). Found in the spike: darken the material, not the light.
 * A dark light colour pushes the buildings towards 30 % grey (the
 * fill-extrusion shader's lower clamp), so the light stays white and the
 * walls get dark colours; lit windows take over from twilight on. The trees
 * and street lights (props) are lit by the same Sun or Moon.
 */
export function sceneLook(sun, moon = null, { solarHour = null } = {}) {
  const day = smooth(-9, 3, sun.elevation); // 0 night .. 1 day
  const twilight = smooth(-16, -2, sun.elevation); // 0 dark night .. 1 bright twilight
  const moonLight = moon && moon.elevation > 0 ? (moon.fraction ?? 0) * smooth(0, 20, moon.elevation) : 0;
  const dim = Math.min(1, 0.07 + 0.25 * twilight + 0.07 * moonLight);
  const wall = mixRGB(hex("#131824"), hex("#252d40"), twilight);
  const building = mixRGB(wall, hex("#cfc6b8"), day ** 1.4);
  // The light comes from the Sun once it is near the horizon, else from the Moon if it is up.
  const source =
    sun.elevation > -3
      ? { azimuth: sun.azimuth, elevation: Math.max(sun.elevation, 5) }
      : moon && moon.elevation > 0
        ? { azimuth: moon.azimuth, elevation: moon.elevation }
        : { azimuth: sun.azimuth, elevation: 25 };
  const q = (v, step) => Math.round(v / step) * step;
  // More windows lit as the night deepens, and as the evening goes on.
  const lit = Number.isFinite(solarHour) ? litShare(solarHour) * (0.75 + 0.25 * (1 - twilight)) : 0.12 + 0.25 * (1 - twilight);
  const lampsOn = day < 0.5;
  const glow = lampsOn ? +(1 - 2 * day).toFixed(2) : 0;
  const az = q(((source.azimuth % 360) + 360) % 360, 1) * DEG;
  const el = clamp(source.elevation, 5, 85) * DEG;
  const sunLit = smooth(-3, 10, sun.elevation);
  const look = {
    day: q(day, 0.02),
    twilight: q(twilight, 0.02),
    moonLight: q(moonLight, 0.05),
    dim: +dim.toFixed(3),
    wall: cssHex(wall),
    building: cssHex(building),
    ground: mixHex("#0b0e14", "#5d6450", day),
    // Lit windows from twilight on: more of them as the night deepens.
    windows: day < 0.5,
    lit: +q(lit, 0.02).toFixed(2),
    // Street lights: a faint amber wash along the streets beyond the lamps' pools, never brighter than the lit windows.
    roadGlow: lampsOn ? +(0.09 * (1 - 2 * day)).toFixed(3) : 0,
    raster: {
      "raster-brightness-max": +(dim + (1 - dim) * day).toFixed(3),
      "raster-saturation": +(-0.6 * (1 - day)).toFixed(3),
      "raster-contrast": +(-0.1 * (1 - day)).toFixed(3),
    },
    vector: {
      landcover: mixHex("#0d1410", "#7d9a6a", day),
      park: mixHex("#0e1611", "#86a874", day),
      water: mixHex("#0a1220", "#7aa7d6", day),
      road: mixHex("#20232b", "#9a9a9a", day),
    },
    light: {
      anchor: "map",
      color: "#ffffff",
      intensity: +(0.4 + 0.1 * day).toFixed(3),
      position: [1.5, q(((source.azimuth % 360) + 360) % 360, 1), q(90 - clamp(source.elevation, 5, 85), 1)],
    },
    // The trees and street lights: towards the light, its colour and the sky's, the lamps and their glow.
    props: {
      light: [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)].map((v) => +v.toFixed(3)),
      lightColour: mixRGB([0.16, 0.18, 0.24].map((v) => v * moonLight), [0.62, 0.58, 0.52], sunLit).map((v) => +v.toFixed(3)),
      ambient: mixRGB([0.13, 0.14, 0.19].map((v) => v * (0.7 + 0.6 * twilight)), [0.62, 0.64, 0.68], day).map((v) => +v.toFixed(3)),
      lampsOn,
      glow,
      // The pools of light under the street lights (added light, at their brightest under the lamp).
      pool: +(0.3 * glow).toFixed(3),
    },
  };
  // The facades are drawn again when their colours or the lit windows change (coarser steps: it costs a few milliseconds).
  look.facadeKey = `${q(day, 0.05).toFixed(2)}|${q(twilight, 0.05).toFixed(2)}|${look.lit}`;
  look.key = JSON.stringify(look);
  return look;
}

/**
 * Facades: houses (to 9 m), blocks of flats (to 32 m) and towers, each in two
 * finishes (a building's id picks one), as RGBA images for map.addImage
 * under these names. A floor is one row of the image, as tall as the kind's
 * floors; columns are windows. The fill-extrusion pattern starts each wall at
 * its height above sea level, so a row never lines up with the ground: every
 * row is a whole floor.
 */
export const FACADE_KINDS = Object.freeze({
  // Width of a window's bay and of a floor (m), the bays and floors in the image (big ones repeat less
  // visibly), image pixels per metre (plain windows need fewer), the window in its bay ([left, top, right,
  // bottom], fractions), the frame (a fraction of the bay), how many more or fewer are lit.
  house: { bayM: 3.4, floorM: 2.9, cols: 10, rows: 4, pxPerM: 16, window: [0.3, 0.2, 0.7, 0.72], frame: 0.06, lit: 0.75, cool: 0.08, curtains: 0.55 },
  flats: { bayM: 3, floorM: 3, cols: 16, rows: 10, pxPerM: 14, window: [0.22, 0.24, 0.78, 0.78], frame: 0.05, lit: 1, cool: 0.15, curtains: 0.35 },
  tower: { bayM: 1.8, floorM: 3.6, cols: 32, rows: 16, pxPerM: 10, window: [0.05, 0.12, 0.95, 0.88], frame: 0.03, lit: 1.2, cool: 0.45, curtains: 0 },
});
/** Day walls, two finishes each; night walls darken them; frames and glass by day. */
const FACADE_WALLS = { house: ["#d6cdbd", "#a8705a"], flats: ["#cdc5b6", "#9c9488"], tower: ["#8a99a8", "#6f7f8f"] };
const FACADE_FRAMES = { house: "#ece8e0", flats: "#d9d4ca", tower: "#3d4652" };
export const FACADES = Object.keys(FACADE_KINDS).flatMap((kind) => [0, 1].map((tint) => ({ name: `facade-${kind}-${tint}`, kind, tint })));

/**
 * A facade image for a look (sceneLook). fill-extrusion-pattern scales a
 * wall's pattern differently in the two directions (calibrated in the spike
 * on a 32 m test block at four latitudes):
 *  - along the wall by the map's px per metre, up it by 2^zoom / 65536 px
 *    per metre, which is ppm / k with k = 512 × 65536 / (C × cos lat): the
 *    rows' height is divided by k (1.13 at 42° N, 1.36 at 52° N);
 *  - patterns are laid out at the tile's whole zoom, so they come out
 *    2^frac(zoom) too big: the image's pixelRatio is multiplied by that.
 * With both, bays and floors are their size in metres at any latitude.
 */
export function facadePattern({ kind = "flats", tint = 0, look, latitude = 45, ppm = PX_PER_M, seed = 11 + 7 * tint + 13 * Object.keys(FACADE_KINDS).indexOf(kind) } = {}) {
  const f = FACADE_KINDS[kind];
  const k = (512 * 65536) / (EARTH_CIRCUMFERENCE * Math.cos(latitude * DEG));
  const bw = Math.round(f.bayM * f.pxPerM);
  const fh = Math.max(8, Math.round((f.floorM * (bw / f.bayM)) / k));
  const width = f.cols * bw;
  const height = f.rows * fh;
  const data = new Uint8ClampedArray(width * height * 4);
  const day = look?.day ?? 0;
  const twilight = look?.twilight ?? 0;
  const litShare = clamp((look?.lit ?? 0.3) * f.lit, 0, 0.95);
  // Walls and frames darken with the light; glass reflects the sky by day; lit windows glow from dusk on.
  // At night a wall is barely its colour: darker than a town's sky, so the buildings stand out against it.
  const night = mixRGB(hex(look?.wall ?? "#131824"), hex(FACADE_WALLS[kind][tint]), 0.05);
  const wallRGB = mixRGB(night, hex(FACADE_WALLS[kind][tint]), day ** 1.4);
  const frameRGB = mixRGB(mixRGB(night, [0, 0, 0], 0.3), hex(FACADE_FRAMES[kind]), day ** 1.4);
  const glassTop = mixRGB([6 + 14 * twilight, 9 + 18 * twilight, 16 + 26 * twilight], kind === "tower" ? [120, 142, 166] : [98, 114, 132], day);
  const glassBottom = mixRGB([4, 6, 10], kind === "tower" ? [64, 78, 96] : [40, 46, 56], day);
  const glow = 1 - smooth(0.25, 0.6, day);
  const warm = [hex("#ffd28a"), hex("#ffe2a6"), hex("#f7c873"), hex("#ffca7a"), hex("#ffe6b8")];
  const cool = [hex("#dde8ff"), hex("#cfe0ff"), hex("#e8eefc")];
  const [wx0, wy0, wx1, wy1] = f.window;
  for (let j = 0; j < f.rows; j++) {
    for (let i = 0; i < f.cols; i++) {
      const r = (salt) => hash2(i, j, seed * 31 + salt);
      const on = r(1) < litShare;
      const light = r(2) < f.cool ? cool[Math.floor(r(3) * cool.length)] : warm[Math.floor(r(3) * warm.length)];
      const strength = on ? (0.55 + 0.45 * r(4)) * glow : 0;
      const curtain = on && r(5) < f.curtains ? 0.45 + 0.3 * r(6) : 1;
      // A block's panels a shade lighter or darker than the next; a house's walls are of a piece.
      const shade = kind === "house" ? 1 : 0.985 + 0.03 * r(7);
      const x0 = Math.round(i * bw + wx0 * bw);
      const x1 = Math.round(i * bw + wx1 * bw);
      const y0 = Math.round(j * fh + wy0 * fh);
      const y1 = Math.round(j * fh + wy1 * fh);
      const fx = Math.max(1, Math.round(f.frame * bw));
      for (let y = j * fh; y < (j + 1) * fh; y++) {
        for (let x = i * bw; x < (i + 1) * bw; x++) {
          let c;
          const inWindow = x >= x0 && x < x1 && y >= y0 && y < y1;
          if (!inWindow) {
            c = wallRGB.map((v) => v * shade);
            // A sill's shadow under the window, and a floor's edge for the bigger buildings.
            if (y >= y1 && y < y1 + 2 && x >= x0 && x < x1) c = c.map((v) => v * 0.72);
            if (kind !== "house" && y === (j + 1) * fh - 1) c = c.map((v) => v * 0.85);
          } else if (x < x0 + fx || x >= x1 - fx || y < y0 + fx || y >= y1 - fx || (kind !== "tower" && Math.abs(x - (x0 + x1) / 2) < fx / 2)) {
            c = frameRGB;
          } else {
            // Glass: the sky's reflection by day, darker below; a lit room's light at night, brightest at the ceiling.
            const t = (y - y0) / Math.max(1, y1 - y0);
            c = mixRGB(glassTop, glassBottom, t);
            if (strength > 0) {
              const room = (1 - 0.35 * t) * (t > 0.78 ? 0.6 : 1) * curtain;
              c = c.map((v, n) => v + (light[n] - v) * strength * room);
            }
          }
          const p = (y * width + x) * 4;
          data[p] = c[0];
          data[p + 1] = c[1];
          data[p + 2] = c[2];
          data[p + 3] = 255;
        }
      }
    }
  }
  const zoom = Math.log2((ppm * EARTH_CIRCUMFERENCE * Math.cos(latitude * DEG)) / 512);
  return { width, height, data, pixelRatio: (bw / (f.bayM * ppm)) * 2 ** (zoom - Math.floor(zoom)), k, zoom, bayPx: bw, floorPx: fh };
}

/** A repeatable number in [0, 1) for a window and a purpose. */
function hash2(i, j, salt) {
  let h = Math.imul(i + 1, 0x27d4eb2d) ^ Math.imul(j + 1, 0x165667b1) ^ Math.imul(salt, 0x61c88647);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Style

const ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"];

/** px per metre at a map zoom and latitude (512 px tiles). */
const ppmAt = (zoom, latitude) => (512 * 2 ** zoom) / (EARTH_CIRCUMFERENCE * Math.cos(latitude * DEG));

/** A width in metres as a line-width over every zoom (exponential base 2, so exact). */
const metres = (m, latitude) => ["interpolate", ["exponential", 2], ["zoom"], 10, ["*", m, ppmAt(10, latitude)], 24, ["*", m, ppmAt(24, latitude)]];

/**
 * The MapLibre style of the scene. Ground: OpenStreetMap landcover, parks,
 * water and roads ("map", fully open), or Esri World Imagery ("aerial");
 * OpenFreeMap's buildings extruded (without the one the observer stands in:
 * Home Assistant's home is usually on the house), their facades by kind;
 * at night a wash of street light along the streets; AWS Terrarium terrain;
 * lit by the Sun or Moon. No sky and no fog: above the skyline the map
 * stays transparent. The trees and street lights, with their pools of light,
 * are a custom layer the scene adds (sat-street-props.js).
 * @param {{look: object, latitude: number, longitude: number, imagery?: "map"|"aerial", buildings?: boolean, terrain?: boolean, ofm?: boolean}} options
 */
export function buildStyle({ look, latitude, longitude, imagery = "map", buildings = true, terrain = true, ofm = true }) {
  const sources = {};
  if (ofm) sources.ofm = { type: "vector", url: OFM_TILEJSON };
  if (terrain) {
    sources.dem = { type: "raster-dem", tiles: [TERRARIUM], tileSize: 256, maxzoom: 15, encoding: "terrarium", attribution: TERRAIN_ATTRIBUTION };
  }
  // With terrain the background is draped on the ground (render to texture), so it never paints the sky.
  const layers = [{ id: "ground", type: "background", paint: { "background-color": look.ground } }];
  if (imagery === "aerial") {
    sources.imagery = { type: "raster", tiles: [ESRI_TILES], tileSize: 256, maxzoom: 19, attribution: ESRI_ATTRIBUTION };
    layers.push({ id: "imagery", type: "raster", source: "imagery", paint: { "raster-fade-duration": 0, ...look.raster } });
  } else if (ofm) {
    layers.push(...groundLayers(look, latitude));
  }
  if (ofm) {
    layers.push({
      id: "street-light", type: "line", source: "ofm", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ROAD_CLASSES]],
      layout: { "line-cap": "round", "line-join": "round", visibility: look.roadGlow > 0 ? "visible" : "none" },
      paint: { "line-color": "#ff9d47", "line-opacity": look.roadGlow, "line-width": metres(15, latitude), "line-blur": metres(12, latitude) },
    });
    if (buildings) layers.push(...buildingLayers(look, latitude, longitude));
  }
  const style = { version: 8, sources, layers, light: look.light };
  if (terrain) style.terrain = { source: "dem", exaggeration: 1 };
  return style;
}

/** The open ground: landcover, parks, water and roads from OpenStreetMap. */
function groundLayers(look, latitude) {
  const width = ["match", ["get", "class"], "motorway", 22, ["trunk", "primary"], 16, ["secondary", "tertiary"], 12, "minor", 9, "service", 5, 3];
  return [
    { id: "landcover", type: "fill", source: "ofm", "source-layer": "landcover", paint: { "fill-color": look.vector.landcover, "fill-antialias": false } },
    { id: "park", type: "fill", source: "ofm", "source-layer": "park", paint: { "fill-color": look.vector.park, "fill-antialias": false } },
    { id: "water", type: "fill", source: "ofm", "source-layer": "water", paint: { "fill-color": look.vector.water, "fill-antialias": false } },
    {
      id: "roads", type: "line", source: "ofm", "source-layer": "transportation",
      filter: ["!", ["in", ["get", "class"], ["literal", ["rail", "transit", "ferry", "path", "bridge"]]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": look.vector.road,
        "line-width": ["interpolate", ["exponential", 2], ["zoom"], 10, ["*", width, ppmAt(10, latitude)], 24, ["*", width, ppmAt(24, latitude)]],
      },
    },
  ];
}

/** The buildings' layers, one for each facade (a pattern worked out per building does not show on the first tiles: MapLibre 6.11). */
export const BUILDING_LAYERS = FACADES.map((f) => `buildings-${f.kind}-${f.tint}`);
const FACADE_HEIGHTS = { house: [-Infinity, 9], flats: [9, 32], tower: [32, Infinity] };

/** The buildings of one facade: by height (a house, flats, a tower), one of two finishes by the building's id. */
function buildingLayers(look, latitude, longitude) {
  const height = ["coalesce", ["get", "render_height"], 6];
  return FACADES.map(({ name, kind, tint }, i) => {
    const [low, high] = FACADE_HEIGHTS[kind];
    const tall = [low > -Infinity ? [">", height, low] : true, high < Infinity ? ["<=", height, high] : true].filter((c) => c !== true);
    return {
      id: BUILDING_LAYERS[i], type: "fill-extrusion", source: "ofm", "source-layer": "building",
      // Without the building the observer stands in (all of its parts).
      filter: ["all", ["!=", ["get", "hide_3d"], true], [">", ["distance", { type: "Point", coordinates: [longitude, latitude] }], 1], ...tall, ["==", ["%", ["to-number", ["id"], 0], 2], tint]],
      paint: {
        "fill-extrusion-pattern": name,
        "fill-extrusion-height": height,
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-vertical-gradient": true,
        "fill-extrusion-opacity": 1,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// The scene

// A source that fails this many tiles without loading half as many is given up on.
const TILE_ERRORS = 6;
// Trees and street lights are placed again this long after the last tile came (ms).
const PROPS_SETTLE_MS = 500;
// The map's layers the trees and street lights are worked out from, and which of their features
// (turning features into GeoJSON is most of the work: fewer, and only the near ones, see _placeProps).
const PROPS_LAYERS = {
  building: null,
  landcover: ["any", ["==", ["get", "class"], "wood"], ["in", ["get", "subclass"], ["literal", ["park", "garden", "village_green"]]]],
  landuse: ["==", ["get", "class"], "cemetery"],
  water: null,
  transportation: ["!", ["in", ["get", "class"], ["literal", ["rail", "transit", "ferry", "aerialway", "pier", "motorway"]]]],
};

/** Whether this is a phone or tablet, which gets fewer trees. */
function coarsePointer() {
  return !!globalThis.matchMedia?.("(pointer: coarse)").matches;
}

/**
 * One MapLibre map at the observer's eye. Throws if WebGL 2 cannot be had
 * (no GPU, or only a software one: failIfMajorPerformanceCaveat), which sends
 * the street view to its 2D fallback.
 */
export class StreetScene {
  /**
   * @param {HTMLElement} container
   * @param {object} o
   * @param {object} o.ml MapLibre (sat-maplibre.js loadMapLibre())
   * @param {number} o.latitude
   * @param {number} o.longitude
   * @param {number} [o.ground] ground height under the eye (m above sea level)
   * @param {number} [o.eyeHeight] eye above the ground (m)
   * @param {object} o.look sceneLook()
   * @param {"map"|"aerial"} [o.imagery]
   * @param {boolean} [o.buildings]
   * @param {boolean} [o.props] trees and street lights
   * @param {{bearing: number, pitch: number, fov: number, roll?: number}} o.view
   * @param {(event: {source: string, reason: string}) => void} [o.onDegrade] a source was given up on
   * @param {(counts: {trees: number, lamps: number}) => void} [o.onProps] the trees and street lights were placed
   * @param {object} [o.locale] MapLibre's own texts in the user's language (sat-maplibre.js mapLibreLocale)
   */
  constructor(container, { ml, latitude, longitude, ground = 0, eyeHeight = 1.7, look, imagery = "map", buildings = true, props = true, view, locale, onDegrade = () => {}, onProps = () => {} }) {
    this.ml = ml;
    this.latitude = latitude;
    this.longitude = longitude;
    this.ground = ground;
    this.eyeHeight = eyeHeight;
    this.look = look;
    this.imagery = imagery;
    this.buildings = buildings;
    this.props = props;
    this.view = { roll: 0, ...view };
    this.degraded = new Set();
    this.farPlane = false;
    // Trees and street lights placed so far, and what they were placed from (tiles of the map and terrain).
    this.treeCount = 0;
    this.lampCount = 0;
    this._propsLayer = new PropsLayer(this);
    this._propsFrom = null;
    this._tiles = 0;
    this._onDegrade = onDegrade;
    this._onProps = onProps;
    this._errors = new Map();
    this._loaded = new Map();
    const dpr = globalThis.devicePixelRatio || 1;
    this.map = new ml.Map({
      container,
      style: buildStyle({ look, latitude, longitude, imagery, buildings }),
      // A placeholder: setView below replaces it in the same task, before any tile is asked for.
      center: [longitude, latitude],
      zoom: 18,
      pitch: 85,
      bearing: this.view.bearing,
      maxPitch: 180,
      maxZoom: 24,
      centerClampedToGround: false,
      interactive: false,
      fadeDuration: 0,
      trackResize: false,
      refreshExpiredTiles: false,
      pixelRatio: Math.min(dpr, 2),
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: dpr < 1.5, failIfMajorPerformanceCaveat: true },
      ...(locale ? { locale } : {}),
    });
    // The scene is a picture: the stage around it is what takes the focus and
    // describes the view to screen readers.
    const canvas = this.map.getCanvas?.();
    canvas?.setAttribute?.("aria-hidden", "true");
    canvas?.setAttribute?.("tabindex", "-1");
    this._addFacades();
    this.setView(this.view);
    // MapLibre throws from setLight until the style itself has loaded, and a
    // fast replay can move the Sun enough for a new look within the first
    // second: such a look waits here and is applied when the style lands.
    this._styleLoaded = false;
    this._pendingLook = null;
    this.map.on("style.load", () => {
      this._styleLoaded = true;
      this._addProps();
      if (this._pendingLook) this.setLook(this._pendingLook);
    });
    this.map.on("error", (e) => this._error(e));
    // A style that had to be reloaded in full (not diffed) comes back without the images.
    this.map.on("styleimagemissing", (e) => {
      if (String(e.id).startsWith("facade-")) this._addFacades(true);
    });
    this.map.on("sourcedata", (e) => {
      if (!e.tile || !e.sourceId) return;
      this._loaded.set(e.sourceId, (this._loaded.get(e.sourceId) ?? 0) + 1);
      // New tiles of the map or the terrain: the trees and lights may stand elsewhere, or higher.
      if (e.sourceId === "ofm" || e.sourceId === "dem") {
        this._tiles++;
        this._placePropsSoon();
      }
    });
    this.map.on("idle", () => this._placePropsSoon());
  }

  get eyeAltitude() {
    return (this.degraded.has("terrain") ? 0 : this.ground) + this.eyeHeight;
  }

  /** Look along bearing / pitch (90 the horizon, 180 straight up) with a vertical field of view. */
  setView({ bearing = this.view.bearing, pitch = this.view.pitch, roll = this.view.roll ?? 0, fov = this.view.fov } = {}) {
    const map = this.map;
    pitch = clamp(pitch, PITCH_MIN, PITCH_MAX);
    bearing = ((bearing % 360) + 360) % 360;
    this.view = { bearing, pitch, roll, fov };
    if (map.getVerticalFieldOfView?.() !== fov) map.setVerticalFieldOfView(fov);
    const height = map.getCanvas().clientHeight || 1;
    const cam = eyeCamera({ longitude: this.longitude, latitude: this.latitude, eyeAltitude: this.eyeAltitude, bearing, pitch, roll, fov, height });
    map.jumpTo({ center: cam.center, elevation: cam.elevation, zoom: cam.zoom, bearing, pitch, roll });
    this.farPlane = overrideFarPlane(map, cam.ppm);
    if (this.farPlane) map.triggerRepaint();
    return cam;
  }

  setEyeHeight(m) {
    this.eyeHeight = m;
    this.setView();
  }

  /**
   * Re-seat the eye on the terrain as rendered (it depends on which tiles
   * are loaded, by up to half a metre in a flat place): true if it moved.
   */
  reseat() {
    if (this.degraded.has("terrain")) return false;
    const rendered = this.map.queryTerrainElevation?.([this.longitude, this.latitude]);
    if (rendered == null || !Number.isFinite(rendered) || Math.abs(rendered - this.ground) <= 0.05) return false;
    this.ground = rendered;
    this.setView();
    return true;
  }

  resize() {
    this.map.resize();
    this.setView();
  }

  /** New light, colours and windows for another moment (call when sceneLook().key changed). */
  setLook(look) {
    const old = this.look;
    if (old?.key === look.key && !this._pendingLook) return;
    if (!this._styleLoaded) {
      this._pendingLook = look;
      return;
    }
    this._pendingLook = null;
    try {
      this._applyLook(old, look);
    } catch (err) {
      // The style is being reloaded in full (a source was given up on): the
      // reload brings back the old look, so apply this one when it lands.
      this.look = old;
      this._pendingLook = look;
      this._styleLoaded = false;
      console.debug("Satellite Spotter: street view look deferred:", err?.message ?? err);
    }
  }

  _applyLook(old, look) {
    this.look = look;
    const map = this.map;
    const paint = (layer, name, value) => {
      if (map.getLayer(layer)) map.setPaintProperty(layer, name, value);
    };
    const layout = (layer, name, value) => {
      if (map.getLayer(layer)) map.setLayoutProperty(layer, name, value);
    };
    if (JSON.stringify(old.light) !== JSON.stringify(look.light)) map.setLight(look.light);
    paint("ground", "background-color", look.ground);
    for (const [name, value] of Object.entries(look.raster)) paint("imagery", name, value);
    paint("landcover", "fill-color", look.vector.landcover);
    paint("park", "fill-color", look.vector.park);
    paint("water", "fill-color", look.vector.water);
    paint("roads", "line-color", look.vector.road);
    layout("street-light", "visibility", look.roadGlow > 0 ? "visible" : "none");
    paint("street-light", "line-opacity", look.roadGlow);
    // The facades: walls and windows by day, lit windows at night.
    if (look.facadeKey !== old.facadeKey) this._addFacades();
    // The trees and lights read the look as they draw.
    map.triggerRepaint();
  }

  /** Ground of OpenStreetMap ("map") or aerial imagery ("aerial"). */
  setImagery(imagery) {
    if (imagery === this.imagery) return;
    this.imagery = imagery;
    this._restyle();
  }

  setBuildings(visible) {
    this.buildings = visible;
    if (this.map.getLayer(BUILDING_LAYERS[0])) {
      for (const id of BUILDING_LAYERS) this.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    } else if (visible) {
      this._restyle();
    }
  }

  /** Trees and street lights on or off. */
  setProps(visible) {
    this.props = visible;
    this._propsLayer.visible = visible;
    if (visible) {
      // Placed again, even from the same tiles (they were not while switched off).
      this._propsFrom = null;
      this._placePropsSoon();
    }
    this.map.triggerRepaint();
  }

  /**
   * Which on-screen samples ({t, x, y} in CSS px) the map hides: read the
   * alpha of its canvas along them inside a render event (outside one the
   * buffer is already cleared). One band read: every read waits for the GPU.
   * @returns {Promise<Map<number, boolean> | null>}
   */
  probe(samples) {
    return new Promise((resolve) => {
      if (!samples.length || !this.map) {
        resolve(new Map());
        return;
      }
      // The street lights are thin: drawn without them, so that a pole does not hide the satellite.
      this._propsLayer.probing = true;
      this.map.once("render", () => {
        try {
          resolve(this._readBand(samples));
        } catch (err) {
          console.debug("Satellite Spotter: occlusion probe failed:", err);
          resolve(null);
        } finally {
          this._propsLayer.probing = false;
          this.map?.triggerRepaint();
        }
      });
      this.map.triggerRepaint();
    });
  }

  _readBand(samples) {
    const canvas = this.map.getCanvas();
    const gl = canvas.getContext("webgl2");
    if (!gl) return null;
    const ratio = this.map.getPixelRatio();
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    const device = samples.map((s) => ({ t: s.t, x: s.x * ratio, y: s.y * ratio }));
    const band = bandFor(device, W, H);
    if (!band) return new Map();
    const buffer = new Uint8Array(W * band.rows * 4);
    gl.readPixels(0, band.y0, W, band.rows, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
    return occlusionFromBand(buffer, W, H, band.y0, band.rows, device);
  }

  /**
   * The median time between frames while the map redraws every frame (ms),
   * to tell a GPU that keeps up from a software one (about 250 ms a frame).
   * Gives up early when the first frames are already far too slow.
   */
  benchmark(frames = 24) {
    return new Promise((resolve) => {
      const times = [];
      let last = null;
      const step = (now) => {
        if (!this.map) {
          resolve(null);
          return;
        }
        if (last !== null) times.push(now - last);
        last = now;
        const sorted = [...times].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        if (times.length >= frames || (times.length >= 8 && median > 160)) {
          resolve(median);
          return;
        }
        this.map.triggerRepaint();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  remove() {
    clearTimeout(this._propsTimer);
    try {
      // Also loses the WebGL context (MapLibre's remove() does), so browsers can reuse it at once.
      this.map?.remove();
    } catch {
      // Already gone.
    }
    this.map = null;
  }

  // -- internals ---------------------------------------------------------------

  /** The facade images for the look (all of them again with `force`, as after a full reload of the style). */
  _addFacades(force = false) {
    const map = this.map;
    const look = this.look;
    if (!force && this._facadesFor === look.facadeKey && FACADES.every((f) => map.hasImage?.(f.name))) return;
    this._facadesFor = look.facadeKey;
    for (const { name, kind, tint } of FACADES) {
      const pattern = facadePattern({ kind, tint, look, latitude: this.latitude });
      const image = { width: pattern.width, height: pattern.height, data: pattern.data };
      if (map.hasImage?.(name)) map.updateImage(name, image);
      else map.addImage(name, image, { pixelRatio: pattern.pixelRatio });
    }
  }

  /** The trees and street lights' layer, over the buildings (again after the style was rebuilt, which drops it). */
  _addProps() {
    const map = this.map;
    if (!map?.addLayer || this.degraded.has("ofm")) return;
    try {
      if (!map.getLayer("props")) map.addLayer(this._propsLayer);
    } catch (err) {
      console.debug("Satellite Spotter: no trees or street lights:", err?.message ?? err);
    }
  }

  /** Place the trees and street lights once the tiles stop coming. */
  _placePropsSoon() {
    if (!this.props || !this.map || this.degraded.has("ofm")) return;
    clearTimeout(this._propsTimer);
    this._propsTimer = setTimeout(() => this._placeProps(), PROPS_SETTLE_MS);
  }

  /** Where the trees and street lights stand, from the map's tiles loaded around the eye (only when new tiles came). */
  _placeProps() {
    const map = this.map;
    if (!map?.querySourceFeatures || !this.props || this._propsFrom === this._tiles) return;
    this._propsFrom = this._tiles;
    let features;
    try {
      const near = ["<", ["distance", { type: "Point", coordinates: [this.longitude, this.latitude] }], PROPS_RADIUS_M + 60];
      features = Object.fromEntries(
        Object.entries(PROPS_LAYERS).map(([layer, filter]) => [layer, map.querySourceFeatures("ofm", { sourceLayer: layer, filter: filter ? ["all", near, filter] : near })]),
      );
    } catch (err) {
      console.debug("Satellite Spotter: could not read the map for trees and street lights:", err?.message ?? err);
      return;
    }
    const frame = localFrame(this.latitude, this.longitude);
    const found = readMap(features, frame);
    const trees = plantTrees(found, { max: coarsePointer() ? MAX_TREES_PHONE : MAX_TREES });
    const lamps = placeLamps(found);
    // On the terrain as rendered (the ground under the eye where it has not loaded).
    const flat = this.degraded.has("terrain");
    const elevation = (x, y) => (flat ? 0 : map.queryTerrainElevation?.(frame.toLngLat([x, y])) ?? this.ground);
    this._propsLayer.setData({ instances: instances(trees, lamps, elevation), glows: glows(lamps, elevation), pools: poolMesh(lamps, elevation) });
    this.treeCount = trees.length;
    this.lampCount = lamps.length;
    map.triggerRepaint();
    this._onProps({ trees: trees.length, lamps: lamps.length });
  }

  _restyle() {
    const ofm = !this.degraded.has("ofm");
    const imagery = this.degraded.has("imagery") ? "map" : this.imagery;
    this.map.setStyle(
      buildStyle({
        look: this.look,
        latitude: this.latitude,
        longitude: this.longitude,
        imagery,
        buildings: this.buildings,
        terrain: !this.degraded.has("terrain"),
        ofm,
      }),
      { diff: true },
    );
    if (!FACADES.every((f) => this.map.hasImage?.(f.name))) this._addFacades(true);
    // The rebuilt style drops the custom layer.
    this._addProps();
  }

  /** Errors from a source: give it up when it clearly does not work, so the rest still shows. */
  _error(e) {
    const source = e?.sourceId;
    const message = String(e?.error?.message ?? e?.error ?? "");
    if (!source || !["dem", "ofm", "imagery"].includes(source)) {
      console.debug("Satellite Spotter: street view map error:", message);
      return;
    }
    const kind = source === "dem" ? "terrain" : source;
    if (this.degraded.has(kind)) return;
    const errors = (this._errors.get(source) ?? 0) + 1;
    this._errors.set(source, errors);
    // No tile: the source itself failed (OpenFreeMap's TileJSON, say).
    const fatal = !e.tile;
    if (!fatal && (errors < TILE_ERRORS || (this._loaded.get(source) ?? 0) >= errors / 2)) return;
    this.degraded.add(kind);
    if (kind === "terrain") {
      this.map.setTerrain(null);
      this.setView();
    } else {
      this._restyle();
    }
    this._onDegrade({ source: kind, reason: message });
  }
}
