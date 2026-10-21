// A reference for the street view's projector: MapLibre 6.11.2's mercator
// camera matrix built the way MercatorTransform._calcMatrices builds it, with
// gl-matrix's (column-major) operations re-implemented here.

export const mat4 = {
  create: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = s;
      }
    }
    return out;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  },
  scale: (a, [x, y, z]) => mat4.multiply(a, [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]),
  translate: (a, [x, y, z]) => mat4.multiply(a, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]),
  rotateX(a, rad) {
    const [c, s] = [Math.cos(rad), Math.sin(rad)];
    return mat4.multiply(a, [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  },
  rotateZ(a, rad) {
    const [c, s] = [Math.cos(rad), Math.sin(rad)];
    return mat4.multiply(a, [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  },
  transform(m, [x, y, z, w]) {
    return [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w);
  },
};

const DEG = Math.PI / 180;

/**
 * MapLibre's view and pixel matrices for a camera (centre at the origin of
 * the world, which is x east, y south, z up, in pixels): {view, pixel, camera}
 * where camera is the eye's world position.
 */
export function maplibreCamera({ bearing, pitch, roll = 0, fov, width, height }) {
  const d = height / 2 / Math.tan((fov * DEG) / 2); // cameraToCenterDistance
  let view = mat4.create();
  view = mat4.scale(view, [1, -1, 1]);
  view = mat4.translate(view, [0, 0, -d]);
  view = mat4.rotateZ(view, -roll * DEG);
  view = mat4.rotateX(view, pitch * DEG);
  view = mat4.rotateZ(view, -bearing * DEG);
  const projection = mat4.perspective(fov * DEG, width / height, height / 50, d * 1000);
  let toPixels = mat4.create();
  toPixels = mat4.scale(toPixels, [width / 2, -height / 2, 1]);
  toPixels = mat4.translate(toPixels, [1, -1, 0]);
  const pixel = mat4.multiply(toPixels, mat4.multiply(projection, view));
  // The eye: the view matrix's inverse applied to the origin. The view is a
  // rotation R then a shift along z by -d (then a y flip), so eye = R^-1 (0, 0, d).
  let rotation = mat4.create();
  rotation = mat4.rotateZ(rotation, -roll * DEG);
  rotation = mat4.rotateX(rotation, pitch * DEG);
  rotation = mat4.rotateZ(rotation, -bearing * DEG);
  const r = rotation;
  // Rotations are orthonormal: the inverse is the transpose.
  const camera = [0, 1, 2].map((i) => r[i * 4] * 0 + r[i * 4 + 1] * 0 + r[i * 4 + 2] * d);
  return { view, pixel, camera, d };
}

/** Where MapLibre draws the world point camera + k·dir (pixels), or null behind the eye. */
export function maplibrePixel(cam, dir, k = 1000) {
  const p = [0, 1, 2].map((i) => cam.camera[i] + dir[i] * k);
  const [x, y, , w] = mat4.transform(cam.pixel, [...p, 1]);
  if (w <= 0) return null;
  return [x / w, y / w];
}
