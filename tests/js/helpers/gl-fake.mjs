// A recording stand-in for WebGL2, MapLibre's custom-layer arguments and 2D canvases, for the layer tests.
// Not a test file itself (node --test only runs tests/js/*.test.mjs).

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// WebGL2's own values, so that calls can be compared with gl.FLOAT and the like.
export const GL = {
  VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, LINK_STATUS: 0x8b82, ACTIVE_UNIFORMS: 0x8b86,
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
  FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401, UNSIGNED_SHORT: 0x1403, TRIANGLES: 0x0004, TRIANGLE_STRIP: 0x0005,
  TEXTURE0: 0x84c0, TEXTURE_2D: 0x0de1, TEXTURE_2D_ARRAY: 0x8c1a, RGB: 0x1907, RGBA: 0x1908, RGBA8: 0x8058,
  UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
  LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703, CLAMP_TO_EDGE: 0x812f, REPEAT: 0x2901,
  BLEND: 0x0be2, DEPTH_TEST: 0x0b71, CULL_FACE: 0x0b44, ONE: 1, ONE_MINUS_SRC_ALPHA: 0x0303,
};
export const COMPLETION_STATUS_KHR = 0x91b1;

/**
 * Records every call as [name, ...args]. Programs link (or not: `linkOk` may be a
 * function of the program's shader sources), and their uniforms are the ones
 * their sources declare. Every other method is a stub that records the call
 * and returns a new {id}; objects made by create*() are kept in `created`.
 */
export function fakeGL({ linkOk = true, parallel = null, drawingBufferWidth = 1600, drawingBufferHeight = 900 } = {}) {
  const calls = [];
  const created = [];
  let next = 0;
  const base = {
    ...GL,
    drawingBufferWidth,
    drawingBufferHeight,
    isContextLost: () => false,
    getExtension: (name) => (name === "KHR_parallel_shader_compile" ? parallel : null),
    createShader: (type) => ({ id: ++next, type, source: "" }),
    shaderSource: (shader, source) => (shader.source = source),
    createProgram: () => {
      const program = { id: ++next, shaders: [] };
      created.push(["createProgram", program]);
      return program;
    },
    attachShader: (program, shader) => program.shaders.push(shader),
    linkProgram: (program) => calls.push(["linkProgram", program.id]),
    deleteProgram: (program) => calls.push(["deleteProgram", program]),
    getProgramParameter: (program, pname) => {
      calls.push(["getProgramParameter", pname]);
      const sources = program.shaders.map((s) => s.source).join("\n");
      const names = [...sources.matchAll(/uniform\s+(?:highp\s+)?\w+\s+(\w+)/g)].map((m) => m[1]);
      if (pname === COMPLETION_STATUS_KHR) return parallel.done;
      if (pname === GL.LINK_STATUS) return typeof linkOk === "function" ? linkOk(sources) : linkOk;
      if (pname === GL.ACTIVE_UNIFORMS) return (program.names = [...new Set(names)]).length;
      return null;
    },
    getActiveUniform: (program, i) => ({ name: program.names[i] }),
    getUniformLocation: (program, name) => ({ name }),
    getProgramInfoLog: () => "link failed",
    getShaderInfoLog: () => "",
  };
  const gl = new Proxy(base, {
    get: (target, key) =>
      key in target
        ? target[key]
        : (...a) => {
            calls.push([key, ...a]);
            const made = { id: ++next };
            if (typeof key === "string" && key.startsWith("create")) created.push([key, made]);
            return made;
          },
  });
  return { gl, calls, created };
}

/** Every draw call, instanced or not. */
export const draws = (calls) =>
  calls.filter(([name]) => ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"].includes(name));

/** The instanced draws only. */
export const instancedDraws = (calls) => calls.filter(([name]) => name === "drawArraysInstanced" || name === "drawElementsInstanced");

/** The values set on a uniform, in order (each an array of the arguments after the location). */
export const uniformValues = (calls, uniform) =>
  calls.filter(([name, loc]) => loc?.name === uniform && name.startsWith("uniform")).map(([, , ...v]) => v);

/** A MapLibre map as the layers see it. */
export function fakeMap({ lng = 0, west = -170, east = 170, cssWidth = 800, zoom } = {}) {
  const map = {
    repaints: 0,
    getCenter: () => ({ lng }),
    getBounds: () => ({ getWest: () => west, getEast: () => east }),
    getRenderWorldCopies: () => true,
    getCanvas: () => ({ clientWidth: cssWidth }),
    triggerRepaint: () => map.repaints++,
  };
  if (zoom !== undefined) map.getZoom = () => zoom;
  return map;
}

const GLOBE_PRELUDE =
  "uniform mat4 u_projection_matrix;\nuniform highp vec4 u_projection_tile_mercator_coords;\nuniform highp vec4 u_projection_clipping_plane;\nuniform highp float u_projection_transition;\nuniform mat4 u_projection_fallback_matrix;";

/** The arguments MapLibre gives a custom layer's prerender() and render(), with identity matrices. */
export const argsFor = (globe, transition = globe ? 1 : 0) => ({
  shaderData: globe
    ? { variantName: "globe", vertexShaderPrelude: GLOBE_PRELUDE, define: "#define GLOBE" }
    : { variantName: "mercator", vertexShaderPrelude: "uniform mat4 u_projection_matrix;", define: "#define PROJECTION_MERCATOR" },
  defaultProjectionData: {
    mainMatrix: IDENTITY,
    fallbackMatrix: IDENTITY,
    tileMercatorCoords: [0, 0, 1, 1],
    clippingPlane: [0, 0, 1, -0.25],
    projectionTransition: transition,
  },
});

/** A 2D context that accepts anything: every property and call returns another such object. */
export const anything = () => new Proxy(function () {}, { get: () => anything(), apply: () => anything() });

/**
 * A 2D canvas whose context records [method, ...args] and property assignments
 * (["set", name, value]) into `log`. Gradients are recorded as their stops.
 * `missing` lists methods the context lacks (as older browsers lack roundRect).
 */
export function recordingCanvas(log, { missing = [] } = {}) {
  const gradient = (kind, args) => {
    const g = { kind, args, stops: [], addColorStop: (o, c) => g.stops.push([o, c]) };
    log.push([kind, ...args]);
    return g;
  };
  const ctx = new Proxy(
    {},
    {
      get: (target, key) => {
        if (missing.includes(key)) return undefined;
        if (key === "createLinearGradient" || key === "createRadialGradient") return (...a) => gradient(key, a);
        if (key in target) return target[key];
        return (...a) => log.push([key, ...a]);
      },
      set: (target, key, value) => {
        log.push(["set", key, value]);
        target[key] = value;
        return true;
      },
    }
  );
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: (type) => `data:${type};base64,${log.length}`,
  };
}

/** Run fn with document.createElement("canvas") making the given canvases. */
export function withDocument(createCanvas, fn) {
  const saved = globalThis.document;
  globalThis.document = { createElement: () => createCanvas() };
  try {
    return fn();
  } finally {
    globalThis.document = saved;
  }
}
