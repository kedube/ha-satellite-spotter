/**
 * Trees and street lights for the street view's 3D model
 * (sat-street-scene.js): where they stand, worked out from the map's own
 * data, and a MapLibre custom layer that draws them among the buildings.
 *
 *  - Trees stand where OpenStreetMap has woods (close together), and parks,
 *    gardens and cemeteries (scattered); never in a building, on a road or
 *    in water. They sit on a jittered grid fixed to the ground, so they stay
 *    put as tiles load and from one visit to the next. Leafy trees, with
 *    some conifers in the woods.
 *  - Street lights stand along the streets where there are buildings, every
 *    30 to 40 m on one side. At night their lamps glow, with a pool of light
 *    on the street under each (a circle layer, draped on the terrain).
 *
 * Positions are metres east and north of the observer on MapLibre's own
 * Mercator scale there (so they line up with the buildings exactly); heights
 * are metres above sea level, from the terrain as rendered. The custom layer
 * draws in those metres: its matrix is MapLibre's float64 view-projection
 * with the observer's place taken out, so nothing jitters at street level.
 * The trees hide the sky as the buildings do (the street view's occlusion
 * probe sees them); the street lights are left out of the probe, being thin,
 * and their glow adds light without hiding anything.
 *
 * The placement and the meshes are pure and unit tested in node.
 */

const DEG = Math.PI / 180;
/** MapLibre's Earth: a sphere of radius 6371008.8 m. */
const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6371008.8;
/** How far from the observer trees and street lights are put (m). */
export const PROPS_RADIUS_M = 400;
/** No tree closer to the eye than this (m): a crown on the camera hides everything. */
const CLEAR_M = 5;
/** The most trees and street lights drawn (the nearest), on a computer and on a phone. */
export const MAX_TREES = 4000;
export const MAX_TREES_PHONE = 2000;
export const MAX_LAMPS = 700;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------------------
// Places

/**
 * Metres east and north of a place on Web Mercator's scale there, and back.
 * Within a few kilometres this is the map's own geometry to a millimetre.
 */
export function localFrame(latitude, longitude) {
  const scale = EARTH_CIRCUMFERENCE * Math.cos(latitude * DEG);
  const mercY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2))) / 360;
  const y0 = mercY(latitude);
  return {
    toLocal: ([lng, lat]) => [((lng - longitude) / 360) * scale, (y0 - mercY(lat)) * scale],
    toLngLat: ([e, n]) => {
      const y = y0 - n / scale;
      return [longitude + (e / scale) * 360, (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90];
    },
    /** Whether GeoJSON coordinates (any depth) come within r metres of the place, in degrees: cheaper than projecting them. */
    reaches(coordinates, r) {
      const dLat = r / 111000 + 1e-4;
      const dLon = r / (111000 * Math.cos(latitude * DEG)) + 1e-4;
      let [x0, y0b, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      const walk = (c) => {
        if (typeof c[0] === "number") {
          if (c[0] < x0) x0 = c[0];
          if (c[0] > x1) x1 = c[0];
          if (c[1] < y0b) y0b = c[1];
          if (c[1] > y1) y1 = c[1];
        } else {
          for (const d of c) walk(d);
        }
      };
      walk(coordinates);
      return x1 >= longitude - dLon && x0 <= longitude + dLon && y1 >= latitude - dLat && y0b <= latitude + dLat;
    },
    scale,
  };
}

/** A repeatable number in [0, 1) for a grid cell and a purpose (a small integer hash). */
export function hash3(i, j, salt = 0) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x61c88647);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Whether a point is inside a polygon (rings: outer and holes, even-odd). */
export function pointInPolygon([x, y], rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Distance from a point to a polyline (m). */
export function distanceToLine([x, y], points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

const bboxOf = (points) => {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
};

/** Things with a bounding box, found again by place (bins of `size` metres). */
export class Bins {
  constructor(size = 40) {
    this.size = size;
    this.bins = new Map();
  }

  add(item, [x0, y0, x1, y1]) {
    const s = this.size;
    for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) {
      for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++) {
        const key = `${i},${j}`;
        if (!this.bins.has(key)) this.bins.set(key, []);
        this.bins.get(key).push(item);
      }
    }
  }

  /** What may be within r of (x, y). */
  near(x, y, r = 0) {
    const s = this.size;
    const out = new Set();
    for (let i = Math.floor((x - r) / s); i <= Math.floor((x + r) / s); i++) {
      for (let j = Math.floor((y - r) / s); j <= Math.floor((y + r) / s); j++) for (const item of this.bins.get(`${i},${j}`) ?? []) out.add(item);
    }
    return out;
  }
}

/** A polygon's rings in local metres, from GeoJSON (Polygon or MultiPolygon): one entry per polygon within r. */
function polygonsOf(geometry, frame, r) {
  if (!geometry) return [];
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polys
    .filter((rings) => frame.reaches(rings[0] ?? [], r))
    .map((rings) => {
      const local = rings.map((ring) => ring.map(frame.toLocal));
      return { rings: local, bbox: bboxOf(local[0] ?? []) };
    });
}

/** A line's points in local metres, from GeoJSON (LineString or MultiLineString): one entry per line within r. */
function linesOf(geometry, frame, r) {
  if (!geometry) return [];
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
  return lines.filter((l) => l.length > 1 && frame.reaches(l, r)).map((l) => l.map(frame.toLocal));
}

/** What trees grow in an area of the map (OpenMapTiles' landcover and landuse), or null for none. */
export function treeArea(layer, properties = {}) {
  const { class: cls, subclass } = properties;
  if (layer === "landcover" && cls === "wood") return subclass === "forest" ? "forest" : "wood";
  if (layer === "landcover" && ["park", "garden", "village_green"].includes(subclass)) return "park";
  if (layer === "landuse" && cls === "cemetery") return "cemetery";
  return null;
}

// Spacing (m) by how far the spot is from the eye, how many of the spots get a tree, and how many are conifers.
const PLANTING = {
  wood: { spacing: [6, 8.5, 12], keep: 0.9, conifer: 0.2 },
  forest: { spacing: [6, 8.5, 12], keep: 0.9, conifer: 0.45 },
  park: { spacing: [15, 15, 18], keep: 0.45, conifer: 0.1 },
  cemetery: { spacing: [12, 12, 15], keep: 0.5, conifer: 0.3 },
};
const BANDS = [0, 120, 250];

/**
 * Where trees stand: in the areas (from treeArea), on a jittered grid of
 * each area's spacing, nearer ones closer together; not in buildings,
 * water or on roads, nor within CLEAR_M of the eye. The nearest `max`.
 * @param {{areas: {kind: string, rings: number[][][], bbox: number[]}[], buildings?: Bins, water?: Bins, roads?: Bins}} map
 * @returns {{x: number, y: number, kind: "leafy"|"conifer", height: number, radius: number, tint: number}[]}
 */
export function plantTrees({ areas = [], buildings = null, water = null, roads = null }, { radius = PROPS_RADIUS_M, max = MAX_TREES } = {}) {
  const seen = new Set();
  const out = [];
  for (const area of areas) {
    const plan = PLANTING[area.kind];
    if (!plan) continue;
    const [ax0, ay0, ax1, ay1] = area.bbox;
    for (let band = 0; band < 3; band++) {
      const d0 = BANDS[band];
      const d1 = band < 2 ? BANDS[band + 1] : radius;
      if (d0 >= radius) break;
      const s = plan.spacing[band];
      const x0 = Math.max(ax0, -d1);
      const x1 = Math.min(ax1, d1);
      const y0 = Math.max(ay0, -d1);
      const y1 = Math.min(ay1, d1);
      if (x0 > x1 || y0 > y1) continue;
      for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) {
        for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++) {
          const key = `${s}:${i}:${j}`;
          if (seen.has(key)) continue;
          if (hash3(i, j, 1) > plan.keep) continue;
          const x = (i + 0.15 + 0.7 * hash3(i, j, 2)) * s;
          const y = (j + 0.15 + 0.7 * hash3(i, j, 3)) * s;
          const d = Math.hypot(x, y);
          if (d < Math.max(d0, CLEAR_M) || d >= d1) continue;
          if (!pointInPolygon([x, y], area.rings)) continue;
          seen.add(key);
          if (blocked([x, y], buildings, water, roads, 1.5)) continue;
          const conifer = hash3(i, j, 4) < plan.conifer;
          const big = area.kind === "park" ? 1.25 : 1;
          const height = conifer ? (9 + 11 * hash3(i, j, 5)) * big : (7 + 8 * hash3(i, j, 5)) * big;
          const r = conifer ? height * (0.17 + 0.07 * hash3(i, j, 6)) : height * (0.27 + 0.11 * hash3(i, j, 6));
          out.push({ x, y, d, kind: conifer ? "conifer" : "leafy", height, radius: r, tint: hash3(i, j, 7) });
        }
      }
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, max);
}

/** Whether a spot is taken: in a building or water, or within `margin` of a road's edge. */
function blocked(p, buildings, water, roads, margin) {
  for (const b of buildings?.near(p[0], p[1], margin) ?? []) if (pointInPolygon(p, b.rings) || nearRing(p, b.rings[0], margin)) return true;
  for (const w of water?.near(p[0], p[1]) ?? []) if (pointInPolygon(p, w.rings)) return true;
  for (const r of roads?.near(p[0], p[1], 12) ?? []) if (distanceToLine(p, r.points) < r.halfWidth + margin) return true;
  return false;
}

function nearRing(p, ring, margin) {
  return !!ring && distanceToLine(p, ring) < margin;
}

// Streets with lights: their half width (m), the lights' spacing (m) and height (m).
const LIT = {
  trunk: { halfWidth: 8, spacing: 38, height: 9 },
  primary: { halfWidth: 7, spacing: 32, height: 9 },
  secondary: { halfWidth: 6, spacing: 32, height: 8 },
  tertiary: { halfWidth: 5, spacing: 32, height: 7 },
  minor: { halfWidth: 4, spacing: 34, height: 6.5 },
  service: { halfWidth: 3, spacing: 40, height: 6 },
};

/** A street of the map (OpenMapTiles' transportation) that has street lights, or null: not tunnels, bridges, driveways or car parks. */
export function litStreet(properties = {}) {
  const { class: cls, brunnel, service } = properties;
  if (!LIT[cls] || brunnel === "tunnel" || brunnel === "bridge") return null;
  if (cls === "service" && ["driveway", "parking_aisle", "drive-through"].includes(service)) return null;
  return LIT[cls];
}

/** Half the width of any road (m), lit or not, to keep trees off it. */
export function roadHalfWidth(cls) {
  return LIT[cls]?.halfWidth ?? (["motorway"].includes(cls) ? 10 : cls === "path" || cls === "track" ? 1.2 : 2.5);
}

/**
 * Where street lights stand: along the lit streets, `spacing` apart on the
 * right-hand side, where there are buildings within 45 m (towns, not
 * country lanes); none in a building, and none within 10 m of another.
 * Each comes with the direction its arm reaches over the street.
 * @param {{streets: {points: number[][], lit: object, seed: number}[], buildings?: Bins}} map
 * @returns {{x: number, y: number, ax: number, ay: number, height: number, kind: "led"|"sodium"}[]}
 */
export function placeLamps({ streets = [], buildings = null }, { radius = PROPS_RADIUS_M, max = MAX_LAMPS } = {}) {
  const out = [];
  const taken = new Bins(20);
  for (const street of streets) {
    const { spacing, halfWidth, height } = street.lit;
    // Where along the street the first light is, and the kind of lamp, fixed by where the street starts.
    let next = spacing * hash3(Math.round(street.points[0][0]), Math.round(street.points[0][1]), 11);
    const kind = hash3(Math.round(street.points[0][0] / 50), Math.round(street.points[0][1] / 50), 12) < 0.3 ? "sodium" : "led";
    let along = 0;
    for (let k = 1; k < street.points.length; k++) {
      const [ax, ay] = street.points[k - 1];
      const [bx, by] = street.points[k];
      const len = Math.hypot(bx - ax, by - ay);
      if (!len) continue;
      const [ux, uy] = [(bx - ax) / len, (by - ay) / len];
      while (next <= along + len) {
        const t = next - along;
        next += spacing;
        // On the right of the way the street is drawn, just off its edge, the arm reaching back over it.
        const x = ax + ux * t + uy * (halfWidth + 1);
        const y = ay + uy * t - ux * (halfWidth + 1);
        const d = Math.hypot(x, y);
        if (d > radius || d < 3) continue;
        if ([...taken.near(x, y, 10)].some((q) => Math.hypot(q.x - x, q.y - y) < 10)) continue;
        const near = [...(buildings?.near(x, y, 45) ?? [])];
        if (!near.length || near.some((b) => pointInPolygon([x, y], b.rings))) continue;
        const lamp = { x, y, d, ax: -uy, ay: ux, height, kind };
        taken.add(lamp, [x, y, x, y]);
        out.push(lamp);
      }
      along += len;
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, max);
}

/**
 * The map's features near the observer (map.querySourceFeatures of the
 * OpenFreeMap source, by layer) as the planting and lighting want them:
 * tree areas, buildings, water and roads, in local metres, within the radius.
 */
export function readMap(features, frame, { radius = PROPS_RADIUS_M } = {}) {
  const areas = [];
  const buildings = new Bins(40);
  const water = new Bins(80);
  const roads = new Bins(40);
  const streets = [];
  const near = ([x0, y0, x1, y1], r = radius) => x1 >= -r && x0 <= r && y1 >= -r && y0 <= r;
  for (const f of features.building ?? []) {
    if (f.properties?.hide_3d === true) continue;
    for (const p of polygonsOf(f.geometry, frame, radius + 50)) if (near(p.bbox, radius + 50)) buildings.add(p, p.bbox);
  }
  for (const f of features.water ?? []) for (const p of polygonsOf(f.geometry, frame, radius)) if (near(p.bbox)) water.add(p, p.bbox);
  for (const [layer, list] of [["landcover", features.landcover], ["landuse", features.landuse]]) {
    for (const f of list ?? []) {
      const kind = treeArea(layer, f.properties);
      if (!kind) continue;
      for (const p of polygonsOf(f.geometry, frame, radius)) if (near(p.bbox)) areas.push({ kind, ...p });
    }
  }
  for (const f of features.transportation ?? []) {
    const props = f.properties ?? {};
    const lit = litStreet(props);
    const halfWidth = roadHalfWidth(props.class);
    for (const points of linesOf(f.geometry, frame, radius)) {
      const bbox = bboxOf(points);
      if (!near(bbox)) continue;
      if (props.brunnel !== "tunnel") roads.add({ points, halfWidth }, bbox);
      if (lit) streets.push({ points, lit });
    }
  }
  return { areas, buildings, water, roads, streets };
}

// ---------------------------------------------------------------------------
// Meshes: positions and normals (x, y, z), triangles; unit sizes, z from 0 up

/** A sphere of radius 1 about (0, 0, 0), subdivided from an icosahedron, made lumpy (a crown of leaves). */
export function crownMesh(subdivisions = 2, lumps = 0.12) {
  const t = (1 + Math.sqrt(5)) / 2;
  let vertices = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(
    ([x, y, z]) => {
      const l = Math.hypot(x, y, z);
      return [x / l, y / l, z / l];
    },
  );
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdivisions; s++) {
    const mids = new Map();
    const mid = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!mids.has(key)) {
        const [p, q] = [vertices[a], vertices[b]];
        const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        const l = Math.hypot(...m);
        vertices.push([m[0] / l, m[1] / l, m[2] / l]);
        mids.set(key, vertices.length - 1);
      }
      return mids.get(key);
    };
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  // Lumps: a few waves over the sphere, never denting it much.
  vertices = vertices.map(([x, y, z]) => {
    const r = 1 + lumps * (Math.sin(5.1 * x + 1.3) * Math.sin(4.3 * y + 0.7) + 0.6 * Math.sin(6.7 * z + 2.1) * Math.sin(3.9 * x - 0.4));
    return [x * r, y * r, z * r];
  });
  return indexedMesh(vertices, faces);
}

/** Normals averaged over the faces at each vertex, and the mesh as flat arrays. */
function indexedMesh(vertices, faces) {
  const normals = vertices.map(() => [0, 0, 0]);
  for (const [a, b, c] of faces) {
    const [p, q, r] = [vertices[a], vertices[b], vertices[c]];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) normals[i][k] += n[k];
  }
  const positions = new Float32Array(vertices.flat());
  const flatNormals = new Float32Array(normals.flatMap((n) => {
    const l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  }));
  const indices = new Uint16Array(faces.flat());
  return { positions, normals: flatNormals, indices };
}

/** Upright cones (a conifer's layers of branches): [base, top, radius] each, of a tree of height 1 and radius 1. */
export function coniferMesh(segments = 10, layers = [[0, 0.62, 1], [0.32, 0.86, 0.74], [0.6, 1, 0.48]]) {
  const vertices = [];
  const faces = [];
  for (const [z0, z1, r] of layers) {
    const apex = vertices.length;
    vertices.push([0, 0, z1]);
    const ring = vertices.length;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * 2 * Math.PI;
      vertices.push([r * Math.cos(a), r * Math.sin(a), z0]);
    }
    const centre = vertices.length;
    vertices.push([0, 0, z0]);
    for (let s = 0; s < segments; s++) {
      const [i, j] = [ring + s, ring + ((s + 1) % segments)];
      faces.push([apex, i, j], [centre, j, i]);
    }
  }
  return indexedMesh(vertices, faces);
}

/** An upright cylinder of radius 1 from z = 0 to 1, with a lid. */
export function cylinderMesh(segments = 8) {
  const vertices = [];
  const faces = [];
  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * 2 * Math.PI;
    vertices.push([Math.cos(a), Math.sin(a), 0], [Math.cos(a), Math.sin(a), 1]);
  }
  const lid = vertices.length;
  vertices.push([0, 0, 1]);
  for (let s = 0; s < segments; s++) {
    const [a0, a1, b0, b1] = [2 * s, 2 * s + 1, (2 * s + 2) % (2 * segments), (2 * s + 3) % (2 * segments)];
    faces.push([a0, b0, b1], [a0, b1, a1], [lid, a1, b1]);
  }
  return indexedMesh(vertices, faces);
}

/** A box from (-1, -1, 0) to (1, 1, 1), with a face's own normals (no smoothing over its edges). */
export function boxMesh() {
  const vertices = [];
  const faces = [];
  const quads = [
    [[-1, -1, 0], [1, -1, 0], [1, -1, 1], [-1, -1, 1]],
    [[1, -1, 0], [1, 1, 0], [1, 1, 1], [1, -1, 1]],
    [[1, 1, 0], [-1, 1, 0], [-1, 1, 1], [1, 1, 1]],
    [[-1, 1, 0], [-1, -1, 0], [-1, -1, 1], [-1, 1, 1]],
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    [[-1, 1, 0], [1, 1, 0], [1, -1, 0], [-1, -1, 0]],
  ];
  for (const q of quads) {
    const i = vertices.length;
    vertices.push(...q);
    faces.push([i, i + 1, i + 2], [i, i + 2, i + 3]);
  }
  return indexedMesh(vertices, faces);
}

// ---------------------------------------------------------------------------
// Instances: per tree or light, where and how big (x, y, z, sx, sy, sz, r, g, b, emission, yaw)

export const INSTANCE_FLOATS = 11;

const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);

/**
 * The instances of each mesh for these trees and lights, standing on the
 * ground at `elevation(x, y)` (m above sea level). Colours are the day's
 * (the shader dims them for the night).
 */
export function instances(trees, lamps, elevation) {
  const out = { trunk: [], leafy: [], leafyFar: [], conifer: [], pole: [], arm: [], head: [] };
  const put = (list, x, y, z, sx, sy, sz, colour, emission, yaw) => list.push(x, y, z, sx, sy, sz, colour[0], colour[1], colour[2], emission, yaw);
  for (const t of trees) {
    const z = elevation(t.x, t.y);
    const yaw = t.tint * 2 * Math.PI;
    if (t.kind === "conifer") {
      put(out.trunk, t.x, t.y, z, t.radius * 0.1, t.radius * 0.1, t.height * 0.25, [0.27, 0.21, 0.16], 0, yaw);
      put(out.conifer, t.x, t.y, z + t.height * 0.12, t.radius, t.radius, t.height * 0.88, mix([0.1, 0.2, 0.12], [0.16, 0.25, 0.14], t.tint), 0, yaw);
    } else {
      const rz = t.radius * 0.95;
      put(out.trunk, t.x, t.y, z, t.radius * 0.09, t.radius * 0.09, t.height - rz, [0.3, 0.24, 0.18], 0, yaw);
      const leaves = mix([0.16, 0.28, 0.1], [0.26, 0.34, 0.13], t.tint);
      // The near crowns get the finer mesh.
      put(t.d < 90 ? out.leafy : out.leafyFar, t.x, t.y, z + t.height - rz, t.radius, t.radius, rz, leaves, 0, yaw);
    }
  }
  for (const l of lamps) {
    const z = elevation(l.x, l.y);
    const yaw = Math.atan2(l.ay, l.ax);
    put(out.pole, l.x, l.y, z, 0.09, 0.09, l.height, [0.32, 0.33, 0.34], 0, 0);
    // The arm reaches 1.4 m over the street, the lamp at its end.
    const [hx, hy] = [l.x + l.ax * 1.4, l.y + l.ay * 1.4];
    put(out.arm, (l.x + hx) / 2, (l.y + hy) / 2, z + l.height - 0.08, 0.75, 0.05, 0.08, [0.32, 0.33, 0.34], 0, yaw);
    put(out.head, hx, hy, z + l.height - 0.2, 0.32, 0.14, 0.14, l.kind === "sodium" ? [1, 0.62, 0.28] : [1, 0.86, 0.68], 1, yaw);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, new Float32Array(v)]));
}

/** Where each light's glow is (its lamp) and its colour: x, y, z, r, g, b. */
export function glows(lamps, elevation) {
  const out = [];
  for (const l of lamps) {
    const colour = l.kind === "sodium" ? [1, 0.6, 0.26] : [1, 0.85, 0.66];
    out.push(l.x + l.ax * 1.4, l.y + l.ay * 1.4, elevation(l.x, l.y) + l.height - 0.3, ...colour);
  }
  return new Float32Array(out);
}

/**
 * The pools of light under the lamps: a disc of `grid` × `grid` points each,
 * every point on the terrain (elevation(x, y)), so the pool lies on a
 * sloping street as well as a flat one; u, v run from -1 to 1 across it for
 * the shader's fall-off. Vertices x, y, z, u, v, r, g, b; triangles.
 */
export function poolMesh(lamps, elevation, { grid = 5 } = {}) {
  const vertices = [];
  const indices = [];
  for (const l of lamps) {
    const [cx, cy] = [l.x + l.ax * 1.4, l.y + l.ay * 1.4];
    const radius = l.height * 1.3;
    const colour = l.kind === "sodium" ? [1, 0.62, 0.3] : [1, 0.86, 0.68];
    const first = vertices.length / 8;
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        const [u, v] = [(2 * i) / (grid - 1) - 1, (2 * j) / (grid - 1) - 1];
        const [x, y] = [cx + u * radius, cy + v * radius];
        vertices.push(x, y, elevation(x, y), u, v, ...colour);
      }
    }
    for (let j = 0; j < grid - 1; j++) {
      for (let i = 0; i < grid - 1; i++) {
        const a = first + j * grid + i;
        indices.push(a, a + 1, a + grid + 1, a, a + grid + 1, a + grid);
      }
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

// ---------------------------------------------------------------------------
// The matrix

/**
 * Column-major float32 matrix from local metres (east, north, metres above
 * sea level) to clip space: MapLibre's float64 view-projection (world
 * pixels, metres up) times the place's offset and Mercator scale, multiplied
 * in float64 so nothing is lost at street level.
 */
export function localMatrix(viewProj, worldSize, latitude, longitude) {
  const x0 = ((180 + longitude) / 360) * worldSize;
  const y0 = ((180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (latitude * DEG) / 2))) / 360) * worldSize;
  const ppm = worldSize / (EARTH_CIRCUMFERENCE * Math.cos(latitude * DEG));
  const L = [ppm, 0, 0, 0, 0, -ppm, 0, 0, 0, 0, 1, 0, x0, y0, 0, 1];
  const M = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += viewProj[k * 4 + r] * L[c * 4 + k];
      M[c * 4 + r] = s;
    }
  }
  return M;
}

// ---------------------------------------------------------------------------
// The custom layer

const MESH_VS = `#version 300 es
uniform mat4 u_matrix;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec3 i_pos;
layout(location = 3) in vec3 i_scale;
layout(location = 4) in vec4 i_colour;
layout(location = 5) in float i_yaw;
out vec3 v_normal;
out vec3 v_colour;
out float v_emit;
out float v_up;
out vec3 v_model;
void main() {
  float c = cos(i_yaw);
  float s = sin(i_yaw);
  mat2 turn = mat2(c, s, -s, c);
  vec3 p = a_pos * i_scale;
  p.xy = turn * p.xy;
  vec3 n = a_normal / i_scale;
  n.xy = turn * n.xy;
  v_normal = normalize(n);
  v_colour = i_colour.rgb;
  v_emit = i_colour.a;
  v_up = a_pos.z;
  v_model = a_pos;
  gl_Position = u_matrix * vec4(i_pos + p, 1.0);
}`;

const MESH_FS = `#version 300 es
precision highp float;
// Towards the light (the Sun or the Moon), its colour, the sky's light, how dark the night makes things, lamps on.
uniform vec3 u_light;
uniform vec3 u_lightColour;
uniform vec3 u_ambient;
uniform float u_lampsOn;
// 0: wood and metal; 1: a leafy crown (a sphere, -1 to 1 up); 2: a conifer (0 to 1 up).
uniform float u_crown;
in vec3 v_normal;
in vec3 v_colour;
in float v_emit;
in float v_up;
in vec3 v_model;
out vec4 fragColor;
void main() {
  vec3 n = normalize(v_normal);
  float diffuse = max(dot(n, u_light), 0.0);
  // Darker underneath and inside (a crown shades itself), and leaves break the light up.
  float up = u_crown > 1.5 ? v_up : 0.5 + 0.5 * v_up;
  float under = u_crown > 0.5 ? 0.5 + 0.5 * clamp(up, 0.0, 1.0) : 1.0;
  float speckle = u_crown > 0.5 ? 0.8 + 0.2 * fract(sin(dot(floor(v_model * 7.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453) : 1.0;
  vec3 colour = v_colour * (u_ambient + u_lightColour * diffuse) * under * speckle;
  // A lamp that is on is its own light.
  colour = mix(colour, v_colour * 1.15, v_emit * u_lampsOn);
  fragColor = vec4(colour, 1.0);
}`;

const GLOW_VS = `#version 300 es
uniform mat4 u_matrix;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_size;
layout(location = 0) in vec2 a_corner;
layout(location = 2) in vec3 i_pos;
layout(location = 3) in vec3 i_colour;
out vec2 v_uv;
out vec3 v_colour;
void main() {
  v_uv = a_corner;
  v_colour = i_colour;
  gl_Position = u_matrix * vec4(i_pos + (a_corner.x * u_right + a_corner.y * u_up) * u_size, 1.0);
}`;

const GLOW_FS = `#version 300 es
precision highp float;
uniform float u_strength;
in vec2 v_uv;
in vec3 v_colour;
out vec4 fragColor;
void main() {
  float r2 = dot(v_uv, v_uv);
  if (r2 > 1.0) discard;
  // A soft halo and a bright core; light is added, the alpha (what hides the sky) left alone.
  float g = 0.55 * exp(-r2 * 6.0) + 1.4 * exp(-r2 * 90.0);
  fragColor = vec4(v_colour * g * u_strength, 0.0);
}`;

const POOL_VS = `#version 300 es
uniform mat4 u_matrix;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec3 a_colour;
out vec2 v_uv;
out vec3 v_colour;
void main() {
  v_uv = a_uv;
  v_colour = a_colour;
  // A few centimetres up, and pulled towards the eye, so the terrain does not cover it.
  gl_Position = u_matrix * vec4(a_pos + vec3(0.0, 0.0, 0.05), 1.0);
}`;

const POOL_FS = `#version 300 es
precision highp float;
uniform float u_strength;
in vec2 v_uv;
in vec3 v_colour;
out vec4 fragColor;
void main() {
  float r2 = dot(v_uv, v_uv);
  if (r2 >= 1.0) discard;
  // Brightest under the lamp, gone at the edge; light added, the alpha left alone.
  float f = (1.0 - r2) * (1.0 - r2) * exp(-r2 * 1.5);
  fragColor = vec4(v_colour * f * u_strength, 0.0);
}`;

/**
 * The MapLibre custom layer ("3d": it shares the depth buffer with the
 * buildings and terrain) that draws the trees and street lights.
 * `scene` gives the observer's place and view, and the look.
 */
export class PropsLayer {
  constructor(scene) {
    this.id = "props";
    this.type = "custom";
    this.renderingMode = "3d";
    this.scene = scene;
    this.visible = true;
    // While the street view reads what hides the sky, the street lights are left out.
    this.probing = false;
    this._data = null;
    this._gl = null;
  }

  /** New trees and lights: per-mesh instances and the glows (instances(), glows()). */
  setData(data) {
    this._data = data;
    this._dirty = true;
    this.map?.triggerRepaint();
  }

  onAdd(map, gl) {
    this.map = map;
    this._setup(gl);
  }

  onRemove(map, gl) {
    if (this._gl === gl && !gl.isContextLost?.()) {
      for (const p of Object.values(this._programs ?? {})) gl.deleteProgram(p.program);
      for (const m of [...Object.values(this._meshes ?? {}), ...(this._pool ? [this._pool] : [])]) {
        gl.deleteBuffer(m.vertices);
        gl.deleteBuffer(m.indices);
        if (m.instances) gl.deleteBuffer(m.instances);
        gl.deleteVertexArray(m.vao);
      }
    }
    this._gl = null;
    this.map = null;
  }

  _setup(gl) {
    this._gl = gl;
    const compile = (vs, fs) => {
      const shader = (type, source) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`street props shader: ${gl.getShaderInfoLog(s)}`);
        return s;
      };
      const program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`street props program: ${gl.getProgramInfoLog(program)}`);
      const names = ["u_matrix", "u_light", "u_lightColour", "u_ambient", "u_lampsOn", "u_crown", "u_right", "u_up", "u_size", "u_strength"];
      return { program, u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)])) };
    };
    this._programs = { mesh: compile(MESH_VS, MESH_FS), glow: compile(GLOW_VS, GLOW_FS), pool: compile(POOL_VS, POOL_FS) };
    const meshes = { crown: crownMesh(2), crownFar: crownMesh(1), conifer: coniferMesh(), cylinder: cylinderMesh(8), box: boxMesh() };
    this._meshes = {};
    for (const [name, list, mesh] of [
      ["trunk", "trunk", meshes.cylinder],
      ["leafy", "leafy", meshes.crown],
      ["leafyFar", "leafyFar", meshes.crownFar],
      ["conifer", "conifer", meshes.conifer],
      ["pole", "pole", meshes.cylinder],
      ["arm", "arm", meshes.box],
      ["head", "head", meshes.box],
    ]) {
      this._meshes[name] = this._meshVao(gl, mesh, list);
    }
    // The glows: one quad, drawn once per lamp.
    const quad = { positions: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
    this._meshes.glow = this._glowVao(gl, quad);
    this._pool = this._poolVao(gl);
    this._dirty = true;
  }

  _poolVao(gl) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    for (const [loc, size, offset] of [[0, 3, 0], [1, 2, 12], [2, 3, 20]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 32, offset);
    }
    const indices = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bindVertexArray(null);
    return { vao, vertices, indices, count: 0 };
  }

  _meshVao(gl, mesh, list) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const interleaved = new Float32Array((mesh.positions.length / 3) * 6);
    for (let i = 0; i < mesh.positions.length / 3; i++) interleaved.set([...mesh.positions.subarray(3 * i, 3 * i + 3), ...mesh.normals.subarray(3 * i, 3 * i + 3)], 6 * i);
    const vertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const indices = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    const instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    const stride = INSTANCE_FLOATS * 4;
    for (const [loc, size, offset] of [[2, 3, 0], [3, 3, 12], [4, 4, 24], [5, 1, 40]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return { vao, vertices, indices, instances, count: mesh.indices.length, list, n: 0 };
  }

  _glowVao(gl, quad) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, quad.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    const indices = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quad.indices, gl.STATIC_DRAW);
    const instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 24, 12);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    return { vao, vertices, indices, instances, count: 6, n: 0 };
  }

  _upload(gl) {
    const data = this._data;
    for (const [name, mesh] of Object.entries(this._meshes)) {
      const array = name === "glow" ? data?.glows : data?.instances?.[mesh.list];
      mesh.n = array ? array.length / (name === "glow" ? 6 : INSTANCE_FLOATS) : 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instances);
      gl.bufferData(gl.ARRAY_BUFFER, array ?? new Float32Array(0), gl.STATIC_DRAW);
    }
    const pools = data?.pools;
    gl.bindVertexArray(this._pool.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._pool.vertices);
    gl.bufferData(gl.ARRAY_BUFFER, pools?.vertices ?? new Float32Array(0), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._pool.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, pools?.indices ?? new Uint32Array(0), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this._pool.count = pools?.indices.length ?? 0;
    this._dirty = false;
  }

  render(gl, args) {
    const scene = this.scene;
    if (!this.visible || !this._data || !scene?.map) return;
    // A context that was lost and came back (or another one) needs everything again.
    if (this._gl !== gl) this._setup(gl);
    if (this._dirty) this._upload(gl);
    const transform = scene.map.transform ?? scene.map._camera?.transform;
    const worldSize = transform?.worldSize;
    if (!worldSize || !args?.modelViewProjectionMatrix) return;
    const matrix = localMatrix(args.modelViewProjectionMatrix, worldSize, scene.latitude, scene.longitude);
    const look = scene.look?.props ?? DEFAULT_PROPS_LOOK;
    const { mesh: m, glow: g } = this._programs;
    gl.useProgram(m.program);
    gl.uniformMatrix4fv(m.u.u_matrix, false, matrix);
    gl.uniform3fv(m.u.u_light, look.light);
    gl.uniform3fv(m.u.u_lightColour, look.lightColour);
    gl.uniform3fv(m.u.u_ambient, look.ambient);
    gl.uniform1f(m.u.u_lampsOn, look.lampsOn ? 1 : 0);
    // Closed meshes, drawn without culling (MapLibre's projection flips the winding).
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    const draw = (name, crown) => {
      const mesh = this._meshes[name];
      if (!mesh.n) return;
      gl.uniform1f(m.u.u_crown, crown);
      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, mesh.n);
    };
    draw("trunk", 0);
    draw("leafy", 1);
    draw("leafyFar", 1);
    draw("conifer", 2);
    if (!this.probing) {
      draw("pole", 0);
      draw("arm", 0);
      draw("head", 0);
    }
    // The pools of light on the street, then the lamps' glow, at night: light added over whatever is there.
    if (!this.probing && look.lampsOn && this._pool.count && look.pool > 0) {
      const p = this._programs.pool;
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(p.u.u_matrix, false, matrix);
      gl.uniform1f(p.u.u_strength, look.pool);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-4, -4);
      gl.bindVertexArray(this._pool.vao);
      gl.drawElements(gl.TRIANGLES, this._pool.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.depthMask(true);
    }
    const glow = this._meshes.glow;
    if (!this.probing && look.lampsOn && glow.n && look.glow > 0) {
      const v = scene.view;
      const [b, p] = [v.bearing * DEG, v.pitch * DEG];
      gl.useProgram(g.program);
      gl.uniformMatrix4fv(g.u.u_matrix, false, matrix);
      gl.uniform3f(g.u.u_right, Math.cos(b), -Math.sin(b), 0);
      gl.uniform3f(g.u.u_up, Math.sin(b) * Math.cos(p), Math.cos(b) * Math.cos(p), Math.sin(p));
      gl.uniform1f(g.u.u_size, 1.6);
      gl.uniform1f(g.u.u_strength, look.glow);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      gl.bindVertexArray(glow.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, glow.count, gl.UNSIGNED_SHORT, 0, glow.n);
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
  }
}

/** The look of the trees and lights before the scene has one (a dark night). */
export const DEFAULT_PROPS_LOOK = Object.freeze({ light: [0, 0, 1], lightColour: [0.05, 0.05, 0.06], ambient: [0.12, 0.13, 0.16], lampsOn: true, glow: 1, pool: 0.3 });
