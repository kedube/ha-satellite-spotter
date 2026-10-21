/**
 * WebGL layers drawn inside MapLibre, on the globe and on the flat map alike:
 *
 *  - NightLayer: the night side of the Earth from the real Sun position, with
 *    NASA's Black Marble city lights and a warm band along the terminator.
 *  - SpaceLayer: satellites at their altitude. The focus satellite as a sprite
 *    of its kind with a glow, its shadow and a line down to the ground; the
 *    other satellites of the selected pass as smaller sprites; every satellite
 *    in the catalogue as a cloud of dots (one instanced draw); and lines in
 *    space from a table of styles: the orbit as a glowing ribbon fading out
 *    about one period ahead, the pass in gold, the visibility cone above the
 *    observer and its ring.
 *
 * Both use MapLibre's projection prelude, so they follow the globe-to-map
 * transition. Everything is in MapLibre "mercator units" (0..1) plus an
 * altitude in metres. Callers give true altitudes; the layer draws them at
 * displayAltitudeKm() so that high orbits stay in front of the camera
 * (setCloudPositions() alone takes display altitudes, see cloudPositions()).
 * Shaders are compiled in prerender(); other GL resources are created lazily
 * inside render(), where MapLibre restores its own GL state afterwards.
 */

const VERSION = new URL(import.meta.url).search;

const [geo, sprites] = await Promise.all([import(`./sat-geo.js${VERSION}`), import(`./sat-sprites.js${VERSION}`)]);
// Mercator units of a point (sat-geo.js): latitudes are clamped to the flat
// map's limit unless a shape that reaches past it towards a pole passes
// POLE_LAT, so the globe draws it where it is (the flat map still sets it on
// its edge, see PROJECT_GLSL).
const { displayAltitudeKm, mercator } = geo;
const { KIND_CODES, KIND_COLORS, KINDS, drawSprite, spriteKind } = sprites;
export { KIND_CODES };

const DEG = Math.PI / 180;
const GLOBE_RADIUS_M = 6371008.8;

// Just short of the pole, where mercator y is infinite.
const POLE_LAT = 89.9999;

/** The altitude in metres to draw something at that is altitudeM above the ground. */
function displayAltitudeM(altitudeM) {
  return displayAltitudeKm(altitudeM / 1000) * 1000;
}

// Shared by every shader: project a mercator point at an altitude. On the
// globe the altitude is real; as the globe flattens into a map everything
// settles onto the ground. Points beyond the mercator limit (towards a pole)
// sit on the edge of the flat map.
const PROJECT_GLSL = `
uniform vec2 u_viewport;
vec4 projectAlt(vec2 p, float elevation) {
  vec2 onMap = vec2(p.x, clamp(p.y, 0.0, 1.0));
#ifdef GLOBE
  vec3 sphere = projectToSphere(p);
  float k = 1.0 + elevation / GLOBE_RADIUS;
  vec3 lifted = sphere * k;
  vec4 globePos = u_projection_matrix * vec4(lifted, 1.0);
  // MapLibre's clipping plane is the horizon of the surface (k = 1). Higher up a
  // point stays in view past the limb, up to acos(d) + acos(1 / k) from the
  // direction of the camera, d being 1 / its distance in globe radii.
  float d = -u_projection_clipping_plane.w;
  float limit = d - sqrt(max(1.0 - d * d, 0.0)) * sqrt(max(k * k - 1.0, 0.0));
  // The depth only decides what is clipped (these layers draw without depth
  // testing): past the far plane once hidden; while in view, never in front of
  // the near plane, where a high orbit on the camera's side would otherwise go.
  globePos.z = max(1.0 - (dot(lifted, u_projection_clipping_plane.xyz) - limit), -0.9999) * globePos.w;
  if (u_projection_transition > 0.999) return globePos;
  vec4 flatPos = u_projection_fallback_matrix * vec4(onMap, 0.0, 1.0);
  vec4 result = globePos;
  result.xyw = mix(flatPos.xyw, globePos.xyw, u_projection_transition);
  result.z = mix(0.0, globePos.z, clamp((u_projection_transition - 0.2) / 0.8, 0.0, 1.0));
  return result;
#else
  return u_projection_matrix * vec4(onMap, 0.0, 1.0);
#endif
}`;

/**
 * Programs for each projection variant. prepare() only starts compiling and
 * linking, so the driver can work on every program at once; get() finishes a
 * program on first use. With KHR_parallel_shader_compile it does not wait for
 * the driver: get() returns null until the program is ready. A program that
 * fails to build is reported once, and get() keeps returning null for it.
 */
class ProgramCache {
  constructor(vertexBody, fragmentSource, attributes) {
    this._vertexBody = vertexBody;
    this._fragmentSource = fragmentSource;
    this._attributes = attributes;
    this._byVariant = new Map();
  }

  prepare(gl, shaderData) {
    if (this._byVariant.has(shaderData.variantName)) return;
    if (this._parallel === undefined) this._parallel = gl.getExtension("KHR_parallel_shader_compile");
    const program = gl.createProgram();
    const shaders = [
      [
        gl.VERTEX_SHADER,
        `#version 300 es\n${shaderData.vertexShaderPrelude}\n${shaderData.define}\n${PROJECT_GLSL}\n${this._vertexBody}`,
      ],
      [gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;\n${this._fragmentSource}`],
    ].map(([type, source]) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      return shader;
    });
    this._attributes.forEach((name, i) => gl.bindAttribLocation(program, i, name));
    gl.linkProgram(program);
    this._byVariant.set(shaderData.variantName, { program, shaders, uniforms: null, failed: false });
  }

  /** The program for this variant and its uniform locations; null while it is being built or if it failed. */
  get(gl, shaderData) {
    this.prepare(gl, shaderData);
    const prog = this._byVariant.get(shaderData.variantName);
    if (prog.uniforms) return prog;
    if (prog.failed || gl.isContextLost()) return null;
    if (this._parallel && !gl.getProgramParameter(prog.program, this._parallel.COMPLETION_STATUS_KHR)) return null;
    const logs = gl.getProgramParameter(prog.program, gl.LINK_STATUS)
      ? null
      : [gl.getProgramInfoLog(prog.program), ...prog.shaders.map((s) => gl.getShaderInfoLog(s))];
    prog.shaders.forEach((s) => gl.deleteShader(s));
    prog.shaders = [];
    if (logs) {
      prog.failed = true;
      console.error(
        `Satellite Spotter: a shader failed to build, so part of the globe is not drawn.\n${logs.filter(Boolean).join("\n")}`
      );
      return null;
    }
    prog.uniforms = {};
    const count = gl.getProgramParameter(prog.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(prog.program, i).name;
      prog.uniforms[name] = gl.getUniformLocation(prog.program, name);
    }
    return prog;
  }

  /** Whether the program for this variant is still being built, so a later frame should look again. */
  pending(shaderData) {
    const prog = this._byVariant.get(shaderData.variantName);
    return !!prog && !prog.uniforms && !prog.failed;
  }

  destroy(gl) {
    for (const prog of this._byVariant.values()) {
      prog.shaders.forEach((s) => gl.deleteShader(s));
      gl.deleteProgram(prog.program);
    }
    this._byVariant.clear();
  }
}

/**
 * The programs a layer draws with, or null to skip the layer this frame: while
 * one is still being built (another frame is requested), or for good once one
 * has failed to build.
 */
function programsFor(layer, gl, shaderData, caches) {
  const progs = caches.map((cache) => cache.get(gl, shaderData));
  if (progs.every(Boolean)) return progs;
  if (caches.some((cache) => cache.pending(shaderData))) layer._map?.triggerRepaint();
  return null;
}

// How far beyond its own extent a shape can be seen, in worlds: line widths and sprites.
const COPY_MARGIN = 0.1;

/**
 * How this frame puts the world on screen. The flat map repeats the world
 * sideways and MapLibre draws every copy in view (wraps -3..3), so there a
 * shape is drawn once for each copy it is in view on. While the globe flattens
 * into the map, each shape is instead placed on the copy nearest the centre of
 * the view, as MapLibre does with its tiles.
 */
function viewOf(map, args) {
  const data = args.defaultProjectionData;
  const globe = args.shaderData.define.includes("GLOBE");
  const center = map ? (map.getCenter().lng + 180) / 360 : 0.5;
  let west = 0;
  let east = 1;
  let repeats = false;
  if (!globe && map && map.getRenderWorldCopies() !== false) {
    const bounds = map.getBounds();
    west = (bounds.getWest() + 180) / 360;
    east = (bounds.getEast() + 180) / 360;
    repeats = Number.isFinite(west) && Number.isFinite(east);
  }
  // The whole-world shifts at which a shape within `reach` of mercator x is in view.
  const copies = (x, reach) => {
    if (!repeats) return [0];
    const lo = Math.max(-3, Math.ceil(west - x - reach));
    const hi = Math.min(3, Math.floor(east - x + reach));
    return Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);
  };
  // m x translate(dx, 0, 0): the same matrix for the copy of the world dx worlds to the side.
  const shifted = new Map();
  const matrix = (m, which, dx) => {
    const key = `${which}${dx}`;
    let out = shifted.get(key);
    if (!out) {
      out = new Float32Array(m);
      for (let i = 0; i < 4; i++) out[12 + i] = m[12 + i] + dx * m[i];
      shifted.set(key, out);
    }
    return out;
  };
  return {
    data,
    globe,
    center,
    copies,
    main: (dx = 0) => matrix(data.mainMatrix, "m", dx),
    fallback: (dx = 0) => matrix(data.fallbackMatrix, "f", dx),
  };
}

/** Set MapLibre's projection uniforms (the ones a variant does not declare are skipped). */
function setProjectionUniforms(gl, prog, view) {
  const p = view.data;
  const u = prog.uniforms;
  gl.uniformMatrix4fv(u.u_projection_matrix, false, view.main());
  if (u.u_projection_fallback_matrix) gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, view.fallback());
  if (u.u_projection_tile_mercator_coords) gl.uniform4f(u.u_projection_tile_mercator_coords, ...p.tileMercatorCoords);
  if (u.u_projection_clipping_plane) gl.uniform4f(u.u_projection_clipping_plane, ...p.clippingPlane);
  if (u.u_projection_transition) gl.uniform1f(u.u_projection_transition, p.projectionTransition);
  if (u.u_viewport) gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
}

/**
 * Run draw() for a shape within `reach` of mercator x: on the flat map once for
 * each copy of the world it is in view on; on the globe once, with the flat
 * half of the transition on the copy nearest the centre.
 */
function drawCopies(gl, prog, view, x, reach, draw) {
  const u = prog.uniforms;
  if (!view.globe) {
    for (const w of view.copies(x, reach)) {
      gl.uniformMatrix4fv(u.u_projection_matrix, false, view.main(w));
      draw();
    }
    return;
  }
  if (u.u_projection_fallback_matrix && view.data.projectionTransition <= 0.999) {
    gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, view.fallback(Math.round(view.center - x)));
  }
  draw();
}

// ---------------------------------------------------------------------------
// Night side and city lights
// ---------------------------------------------------------------------------

const NIGHT_GRID = 96; // cells across and down the night mesh

const NIGHT_VERTEX = `
in vec2 a_merc;
in float a_pole;
uniform float u_offset;
out vec2 v_merc;
void main() {
  // The mesh is one world wide and starts at u_offset, which keeps its seam on
  // the far side while the globe flattens into the map.
  vec2 p = vec2(a_merc.x + u_offset, a_merc.y);
  // Rows beyond the mercator limit are pinned to the poles, as MapLibre does for tiles.
  if (a_pole < -0.5) {
    gl_Position = projectTile(vec2(p.x, 0.0), vec2(0.0, -32768.0));
    v_merc = vec2(p.x, -0.5);
  } else if (a_pole > 0.5) {
    gl_Position = projectTile(vec2(p.x, 1.0), vec2(0.0, 32768.0));
    v_merc = vec2(p.x, 1.5);
  } else {
    gl_Position = projectTile(p);
    v_merc = p;
  }
}`;

const NIGHT_FRAGMENT = `
in vec2 v_merc;
uniform vec3 u_sun;
uniform sampler2D u_lights;
uniform float u_has_lights;
uniform float u_strength;
uniform float u_lights_mix;
out vec4 fragColor;
const float PI = 3.141592653589793;
void main() {
  float lon = v_merc.x * 2.0 * PI - PI;
  float lat = 2.0 * atan(exp(PI - 2.0 * PI * v_merc.y)) - 0.5 * PI;
  vec3 n = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
  float el = degrees(asin(clamp(dot(n, u_sun), -1.0, 1.0)));
  // Daylight above +0.8 deg, full night once the Sun is 12 deg down.
  float t = clamp((el - 0.8) / -12.8, 0.0, 1.0);
  float night = t * t * (3.0 - 2.0 * t);
  vec3 dark = vec3(0.01, 0.018, 0.045);
  vec3 col = dark;
  if (u_has_lights > 0.5) {
    vec3 lights = texture(u_lights, vec2(v_merc.x, 0.5 - lat / PI)).rgb;
    col = mix(dark, lights * 1.15, u_lights_mix);
  }
  float a = night * u_strength;
  // Warm glow where the Sun is just below the horizon (x * x, as pow() is undefined for x < 0).
  float x = (el + 2.0) / 3.2;
  float twilight = exp(-x * x) * (1.0 - 0.6 * night) * u_strength;
  vec3 glow = vec3(0.95, 0.45, 0.18) * twilight * 0.22;
  fragColor = vec4(col * a + glow, a);
}`;

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const lightsByWidth = new Map();
/**
 * NASA Black Marble 2016 as one equirectangular image, 4096 or 2048 pixels
 * wide, shared by every globe on the page. The copy that comes with the
 * integration is tried first (the browser caches it), then NASA's map server.
 * Resolves null if neither loads; a later call then tries again.
 */
export function loadCityLights(width) {
  let promise = lightsByWidth.get(width);
  if (!promise) {
    promise = loadImage(new URL(`img/black-marble-2016-${width}.jpg`, import.meta.url).href)
      .then(
        (img) =>
          img ||
          loadImage(
            "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0" +
              `&LAYERS=VIIRS_Black_Marble&TIME=2016-01-01&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=${width}&HEIGHT=${width / 2}&FORMAT=image/jpeg`
          )
      )
      .then((img) => {
        if (!img && lightsByWidth.get(width) === promise) lightsByWidth.delete(width);
        return img;
      });
    lightsByWidth.set(width, promise);
  }
  return promise;
}

export class NightLayer {
  constructor({ id = "sat-night", getState }) {
    this.id = id;
    this.type = "custom";
    this.renderingMode = "2d";
    this._getState = getState;
    this._programs = new ProgramCache(NIGHT_VERTEX, NIGHT_FRAGMENT, ["a_merc", "a_pole"]);
  }

  onAdd(map) {
    this._map = map;
  }

  onRemove(map, gl) {
    this._programs.destroy(gl);
    if (this._vao) gl.deleteVertexArray(this._vao);
    if (this._buffers) this._buffers.forEach((b) => gl.deleteBuffer(b));
    if (this._texture) gl.deleteTexture(this._texture);
    this._vao = this._buffers = this._texture = null;
    this.releaseLights();
  }

  /**
   * Drop city lights still waiting for a frame and any decode still running.
   * MapLibre's map.remove() does not call onRemove, so the view calls this
   * when it tears the map down.
   */
  releaseLights() {
    this._lightsRequest = null;
    if (this._pendingLights?.owned) this._pendingLights.image.close();
    this._pendingLights = null;
  }

  /**
   * The city lights: an image or an ImageBitmap. An image is decoded off the
   * main thread first; the texture is made once, on the next frame, replacing
   * any earlier one.
   */
  setLights(image) {
    if (!image) return;
    const request = (this._lightsRequest = {});
    const decoded =
      typeof createImageBitmap === "function" && !(typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap)
        ? createImageBitmap(image, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" }).then(
            (bitmap) => ({ image: bitmap, owned: true }),
            () => ({ image, owned: false })
          )
        : Promise.resolve({ image, owned: false });
    decoded.then((lights) => {
      if (request !== this._lightsRequest) {
        // Replaced by a later call, or the lights were released.
        if (lights.owned) lights.image.close();
        return;
      }
      if (this._pendingLights?.owned) this._pendingLights.image.close();
      this._pendingLights = lights;
      this._map?.triggerRepaint();
    });
  }

  prerender(gl, args) {
    this._programs.prepare(gl, args.shaderData);
  }

  _mesh(gl) {
    // A grid over the mercator world plus a row pinned to each pole.
    const n = NIGHT_GRID;
    const rows = n + 3;
    const verts = new Float32Array(rows * (n + 1) * 3);
    let k = 0;
    for (let j = -1; j <= n + 1; j++) {
      for (let i = 0; i <= n; i++) {
        verts[k++] = i / n;
        verts[k++] = Math.max(0, Math.min(1, j / n));
        verts[k++] = j < 0 ? -1 : j > n ? 1 : 0;
      }
    }
    const idx = new Uint16Array((rows - 1) * n * 6);
    k = 0;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        idx.set([a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1], k);
        k += 6;
      }
    }
    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this._buffers = [vb, ib];
    this._count = idx.length;
  }

  _uploadLights(gl, image) {
    if (this._texture) gl.deleteTexture(this._texture);
    this._texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
  }

  render(gl, args) {
    const state = this._getState();
    if (!state || !state.visible) return;
    const progs = programsFor(this, gl, args.shaderData, [this._programs]);
    if (!progs) return;
    const [prog] = progs;
    if (!this._vao) this._mesh(gl);
    if (this._pendingLights) {
      this._uploadLights(gl, this._pendingLights.image);
      if (this._pendingLights.owned) this._pendingLights.image.close();
      this._pendingLights = null;
    }
    const view = viewOf(this._map, args);
    gl.useProgram(prog.program);
    setProjectionUniforms(gl, prog, view);
    const u = prog.uniforms;
    gl.uniform3f(u.u_sun, ...state.sun);
    gl.uniform1f(u.u_strength, state.strength);
    gl.uniform1f(u.u_lights_mix, state.lightsMix);
    gl.uniform1f(u.u_has_lights, this._texture ? 1 : 0);
    // On the globe the mesh starts half a world before the centre of the view (on a cell boundary).
    const offset = view.globe ? Math.floor((view.center - 0.5) * NIGHT_GRID) / NIGHT_GRID : 0;
    gl.uniform1f(u.u_offset, offset);
    if (this._texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.uniform1i(u.u_lights, 0);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this._vao);
    drawCopies(gl, prog, view, offset + 0.5, 0.5, () => gl.drawElements(gl.TRIANGLES, this._count, gl.UNSIGNED_SHORT, 0));
    gl.bindVertexArray(null);
  }
}

// ---------------------------------------------------------------------------
// Satellites, orbits, visibility cone
// ---------------------------------------------------------------------------

const RIBBON_VERTEX = `
in vec2 a_pos;
in float a_elev;
in vec3 a_prev;
in vec3 a_next;
in float a_side;
in float a_t;
in float a_lit;
uniform float u_width;
uniform float u_elev_scale;
out float v_side;
out float v_t;
out float v_lit;
void main() {
  vec4 c = projectAlt(a_pos, a_elev * u_elev_scale);
  vec4 p = projectAlt(a_prev.xy, a_prev.z * u_elev_scale);
  vec4 n = projectAlt(a_next.xy, a_next.z * u_elev_scale);
  vec2 halfVp = u_viewport * 0.5;
  vec2 d = (n.xy / n.w - p.xy / p.w) * halfVp;
  if (dot(d, d) < 1e-10) d = vec2(1.0, 0.0);
  vec2 normal = normalize(vec2(-d.y, d.x));
  vec2 offset = normal * a_side * u_width * 0.5 / halfVp;
  gl_Position = vec4(c.xy + offset * c.w, c.z, c.w);
  v_side = a_side;
  v_t = a_t;
  v_lit = a_lit;
}`;

const RIBBON_FRAGMENT = `
in float v_side;
in float v_t;
in float v_lit;
uniform int u_mode;
uniform vec4 u_color;
uniform vec4 u_color2;
uniform vec4 u_color_past;
uniform float u_now;
uniform float u_past_span;
uniform float u_future_span;
uniform float u_dash;
uniform float u_soft;
out vec4 fragColor;
void main() {
  float x = abs(v_side);
  float edge = mix(1.0 - smoothstep(0.55, 1.0, x), (1.0 - x) * (1.0 - x), u_soft);
  vec4 col = u_color;
  if (u_mode == 0) {
    float dt = v_t - u_now;
    if (dt < 0.0) {
      float f = clamp(1.0 + dt / u_past_span, 0.0, 1.0);
      col = u_color_past;
      col.a *= f * f;
    } else {
      col = mix(u_color2, u_color, v_lit);
      // Bright just ahead, fading out about one orbit on.
      col.a *= mix(1.0, 0.35, clamp(dt / u_future_span, 0.0, 1.0)) * (1.0 - smoothstep(0.75, 1.0, dt / u_future_span));
    }
  } else if (u_mode == 2) {
    col.a *= step(0.42, fract(v_t / u_dash));
  }
  float a = col.a * edge;
  fragColor = vec4(col.rgb * a, a);
}`;

const SPRITE_VERTEX = `
in vec2 a_corner;
uniform vec3 u_center;
uniform vec3 u_ahead;
uniform float u_size;
uniform float u_orient;
out vec2 v_uv;
void main() {
  vec4 c = projectAlt(u_center.xy, u_center.z);
  vec2 halfVp = u_viewport * 0.5;
  vec2 up = vec2(0.0, 1.0);
  if (u_orient > 0.5) {
    vec4 a = projectAlt(u_ahead.xy, u_ahead.z);
    vec2 d = (a.xy / a.w - c.xy / c.w) * halfVp;
    if (dot(d, d) > 1e-8) up = normalize(d);
  }
  vec2 right = vec2(up.y, -up.x);
  vec2 off = (right * a_corner.x + up * a_corner.y) * u_size / halfVp;
  gl_Position = vec4(c.xy + off * c.w, c.z, c.w);
  v_uv = vec2(a_corner.x * 0.5 + 0.5, 0.5 - a_corner.y * 0.5);
}`;

const SPRITE_FRAGMENT = `
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform vec3 u_tint;
out vec4 fragColor;
void main() {
  vec4 t = texture(u_tex, v_uv);
  fragColor = vec4(t.rgb * u_tint, t.a) * u_opacity;
}`;

const FILL_VERTEX = `
in vec2 a_pos;
in float a_elev;
in float a_alpha;
out float v_alpha;
void main() {
  gl_Position = projectAlt(a_pos, a_elev);
  v_alpha = a_alpha;
}`;

const FILL_FRAGMENT = `
in float v_alpha;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  float a = u_color.a * v_alpha;
  fragColor = vec4(u_color.rgb * a, a);
}`;

// How much bigger the cloud draws a member of the selected pass, and the
// least radius (CSS px) of the one under the pointer: shared by the shader and pick().
const MEMBER_SCALE = 1.35;
const HOVER_MIN_RADIUS = 15;

// The cloud: one quad per satellite, all in one instanced draw. Positions
// change every frame; size, glyph, colour and flags only with the catalogue,
// the selection or the pointer.
const CLOUD_VERTEX = `
in vec2 a_corner;
in vec4 a_pos;
in vec4 a_style;
in vec4 a_color;
in float a_flags;
uniform float u_center_x;
uniform float u_px;
uniform float u_scale;
uniform float u_time;
uniform float u_pulse;
out vec2 v_uv;
out float v_inner;
out vec4 v_core;
out vec4 v_halo;
out vec4 v_glyph;
out float v_layer;
out float v_lod;
out vec4 v_ring;
out float v_ring_r;
// Whether a bit of the flags is set (flags arrive as a float 0..255).
bool flag(float bit) {
  return mod(floor(a_flags / bit), 2.0) > 0.5;
}
void main() {
  v_uv = a_corner;
  // Selected (drawn as a sprite instead), hidden, or without a position: nothing to draw.
  if (flag(1.0) || a_pos.z < -0.5) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  bool hover = flag(2.0);
  bool now = flag(4.0);
  bool member = flag(8.0);
  vec2 p = a_pos.xy;
#ifdef GLOBE
  // The sphere repeats every world, so this only moves the flat half of the
  // transition onto the copy of the world nearest the centre.
  p.x += floor(u_center_x - p.x + 0.5);
#endif
  vec4 c = projectAlt(p, a_pos.z);
  // Radius in CSS px: brighter satellites are bigger, and they grow as the map
  // zooms in. The many in high orbits, far out in space, are kept a little quieter.
  float high = smoothstep(2.5e6, 6.5e6, a_pos.z);
  float radius = a_style.x * u_scale * (member ? ${MEMBER_SCALE.toFixed(2)} : 1.0) * mix(1.0, 0.82, high);
  if (hover) radius = max(radius * 2.2, ${HOVER_MIN_RADIUS.toFixed(1)});
  // A glyph of the satellite's kind takes over from the dot once there is room for it.
  v_lod = smoothstep(7.0, 11.0, radius);
  // The quad grows to hold a ring around the dot (close around a hovered glyph).
  float quad = hover ? radius * 1.75 : now ? max(radius * 2.4, radius + 9.0) : radius;
  v_inner = radius / quad;
  vec2 halfVp = u_viewport * 0.5;
  gl_Position = vec4(c.xy + a_corner * quad * u_px / halfVp * c.w, c.z, c.w);
  // In sunlight a white-hot core in a glow of the kind's colour; in Earth's
  // shadow, where nobody could see it, a dim dot of a cooler tone.
  float lit = clamp(a_pos.w, 0.0, 1.0);
  vec3 kind = member ? vec3(1.0, 0.8, 0.32) : a_color.rgb;
  vec3 halo = mix(kind * vec3(0.5, 0.56, 0.82), kind, lit);
  vec3 core = mix(halo, mix(kind, vec3(1.0), 0.5), lit);
  float alpha = hover ? 1.0 : a_style.z * mix(member ? 0.6 : 0.36, 1.0, lit) * mix(1.0, 0.7, high);
  v_core = vec4(core * alpha, alpha);
  v_halo = vec4(halo * alpha, alpha);
  // The hovered one is shown clearly even in the shadow.
  float glyphLit = hover ? max(lit, 0.7) : lit;
  float glyphAlpha = mix(0.5, 1.0, glyphLit);
  v_glyph = vec4(mix(vec3(0.5, 0.56, 0.78), vec3(1.0), glyphLit) * glyphAlpha, glyphAlpha);
  v_layer = a_style.y;
  // Visible now: a gold ring, breathing unless motion is reduced; the hovered one: a white ring.
  float pulse = u_pulse > 0.5 ? 0.5 + 0.5 * sin(u_time * 3.2 + a_style.w) : 1.0;
  v_ring = vec4(0.0);
  v_ring_r = 0.0;
  if (now) {
    v_ring = vec4(1.0, 0.84, 0.4, 1.0) * mix(0.45, 0.95, pulse);
    v_ring_r = mix(0.62, 0.86, pulse);
  } else if (hover) {
    v_ring = vec4(0.9, 0.95, 1.0, 1.0) * 0.8;
    v_ring_r = 0.86;
  }
}`;

const CLOUD_FRAGMENT = `
in vec2 v_uv;
in float v_inner;
in vec4 v_core;
in vec4 v_halo;
in vec4 v_glyph;
in float v_layer;
in float v_lod;
in vec4 v_ring;
in float v_ring_r;
uniform highp sampler2DArray u_atlas;
out vec4 fragColor;
void main() {
  // q spans the dot (or glyph) from -1 to 1, wherever it sits in the quad.
  vec2 q = v_uv / v_inner;
  float d2 = dot(q, q);
  float core = 1.0 - smoothstep(0.03, 0.12, d2);
  float halo = exp(-d2 * 3.4) * 0.8;
  vec4 col = v_core * core + v_halo * halo * (1.0 - core);
  // Sampled outside any branch: mipmapping needs the derivatives of every pixel
  // around it, and the glyph's box ends inside the quad.
  float inside = step(max(abs(q.x), abs(q.y)), 1.0);
  vec4 glyph = texture(u_atlas, vec3(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5, v_layer)) * v_glyph * inside;
  col = mix(col, glyph + v_halo * halo * 0.5 * (1.0 - glyph.a), v_lod);
  if (v_ring.a > 0.0) {
    float r = (length(v_uv) - v_ring_r) / 0.075;
    col += v_ring * exp(-r * r) * (1.0 - col.a);
  }
  fragColor = col;
}`;

const RIBBON_STRIDE = 12; // floats per vertex

/**
 * Turn a polyline of [mercX, mercY, elevation, t, lit] into ribbon vertices.
 * It is split where it crosses the antimeridian, so the flat map never draws a
 * line across the world, and where it crosses the prime meridian, so each
 * piece spans at most half a world and can be put on the copy of the world
 * nearest the centre of the view. Returns {data, segments: [first, count, midX, halfWidth]}.
 */
export function buildRibbon(points) {
  const runs = [];
  let run = [];
  for (const p of points) {
    const prev = run[run.length - 1];
    if (prev && Math.abs(p[0] - prev[0]) > 0.5) {
      const unwrapped = p[0] + (prev[0] > 0.5 ? 1 : -1);
      const edge = prev[0] > 0.5 ? 1 : 0;
      const f = (edge - prev[0]) / (unwrapped - prev[0]);
      const mid = (i) => prev[i] + f * (p[i] - prev[i]);
      run.push([edge, mid(1), mid(2), mid(3), prev[4]]);
      runs.push(run);
      run = [[1 - edge, mid(1), mid(2), mid(3), p[4]]];
    } else if (prev && (prev[0] < 0.5) !== (p[0] < 0.5)) {
      const f = (0.5 - prev[0]) / (p[0] - prev[0]);
      const mid = (i) => prev[i] + f * (p[i] - prev[i]);
      run.push([0.5, mid(1), mid(2), mid(3), prev[4]]);
      runs.push(run);
      run = [[0.5, mid(1), mid(2), mid(3), p[4]]];
    }
    run.push(p);
  }
  if (run.length > 1) runs.push(run);

  const total = runs.reduce((n, r) => n + (r.length > 1 ? r.length * 2 : 0), 0);
  const data = new Float32Array(total * RIBBON_STRIDE);
  const segments = [];
  let v = 0;
  for (const r of runs) {
    if (r.length < 2) continue;
    const xs = r.map((q) => q[0]);
    const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
    segments.push([v, r.length * 2, (lo + hi) / 2, (hi - lo) / 2]);
    for (let i = 0; i < r.length; i++) {
      const cur = r[i];
      const prev = r[Math.max(0, i - 1)];
      const next = r[Math.min(r.length - 1, i + 1)];
      // Written in place: some ribbons are rebuilt every frame, and an array
      // per vertex adds up.
      for (let side = -1; side <= 1; side += 2) {
        const o = v * RIBBON_STRIDE;
        data[o] = cur[0];
        data[o + 1] = cur[1];
        data[o + 2] = cur[2];
        data[o + 3] = prev[0];
        data[o + 4] = prev[1];
        data[o + 5] = prev[2];
        data[o + 6] = next[0];
        data[o + 7] = next[1];
        data[o + 8] = next[2];
        data[o + 9] = side;
        data[o + 10] = cur[3];
        data[o + 11] = cur[4];
        v++;
      }
    }
  }
  return { data, segments };
}

/**
 * Track rows as ribbon points: true latitudes on the globe (a polar orbit goes
 * over the top; the flat map sets it on its edge) and display altitudes.
 */
function rowsToPoints(rows, baseT, elevationM = null) {
  return rows.map((r) => {
    const [x, y] = mercator(r[1], r[2], POLE_LAT);
    return [x, y, displayAltitudeM(elevationM ?? r[3] * 1000), r[0] - baseT, r[4] ?? 1];
  });
}

/** Angular distance between two places, in degrees. */
function arcDeg(lat1, lon1, lat2, lon2) {
  const c =
    Math.sin(lat1 * DEG) * Math.sin(lat2 * DEG) + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/** Whether a ring of [lon, lat] goes around a pole: its longitude turns a full circle. */
function aroundPole(ring) {
  let turn = 0;
  for (let i = 1; i < ring.length; i++) {
    const d = ring[i][0] - ring[i - 1][0];
    turn += d - 360 * Math.round(d / 360);
  }
  return Math.abs(turn) > 180;
}

/**
 * The cone's footprint for the flat map when the circle around home contains a
 * pole. On the map that circle is a curve from one side of the world to the
 * other, and the area it encloses lies between it and the map's edge at the
 * pole. That area is filled in strips from the edge down to home's latitude and
 * on to the ring, plus a fan from the pole itself (flat on the map; it covers
 * the polar cap while the globe flattens into the map). Alpha and height grow
 * with the distance from home, as on the funnel. Triangles of
 * [x, y, elevation, alpha]; `split` is the first vertex east of home's meridian.
 */
function poleCapFill(home, ring, elevationM, radiusDeg) {
  const north = home.latitude > 0;
  const edge = north ? 0 : 1;
  const apex = mercator(home.latitude, home.longitude);
  // The ring from west to east within half a world of home, as [x, y] ...
  const curve = ring
    .map(([lon, lat]) => {
      const q = mercator(lat, lon);
      q[0] -= Math.floor(q[0] - apex[0] + 0.5);
      return q;
    })
    .sort((a, b) => a[0] - b[0]);
  // ... closed where it crosses the meridian opposite home, and with a point on
  // home's meridian, so that home is a corner of the strips.
  const at = (x, a, b) => [x, a[1] + ((x - a[0]) / (b[0] - a[0] || 1)) * (b[1] - a[1])];
  const seam = at(apex[0] + 0.5, curve[curve.length - 1], [curve[0][0] + 1, curve[0][1]]);
  curve.unshift([apex[0] - 0.5, seam[1]]);
  curve.push(seam);
  const k = curve.findIndex(([x]) => x >= apex[0]);
  if (curve[k][0] > apex[0]) curve.splice(k, 0, at(apex[0], curve[k - 1], curve[k]));
  const vertex = (x, y) => {
    const lat = (2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * y))) / DEG - 90;
    const out = Math.min(1, arcDeg(home.latitude, home.longitude, lat, x * 360 - 180) / radiusDeg);
    return [x, y, out * elevationM, out];
  };
  const rows = curve.map(([x, y]) => [
    vertex(x, edge),
    vertex(x, north ? Math.min(apex[1], y) : Math.max(apex[1], y)),
    [x, y, elevationM, 1],
  ]);
  const out = Math.min(1, (90 - Math.abs(home.latitude)) / radiusDeg);
  const tris = [];
  for (let i = 0; i < rows.length - 1; i++) {
    if (i === k) tris.split = tris.length / 4;
    const [e1, m1, r1] = rows[i];
    const [e2, m2, r2] = rows[i + 1];
    tris.push(...e1, ...e2, ...m2, ...e1, ...m2, ...m1, ...m1, ...m2, ...r2, ...m1, ...r2, ...r1);
    // Beyond the edge, towards the pole (a mercator y far past the edge projects onto it).
    tris.push(...e1, ...e2, (e1[0] + e2[0]) / 2, north ? -2 : 3, out * elevationM, out);
  }
  return tris;
}

/**
 * How each kind of line is drawn, from the bottom up (`z`). `when` names the
 * setFrame flag that shows it (none: always drawn). Each pass draws the whole
 * line once: `width` in CSS px; `soft` for a glow profile; `mode` 0 for the
 * orbit's time fade (the `colorPast` behind the satellite, `color` in sunlight
 * and `color2` in Earth's shadow ahead, over setFrame's `spans`), 1 solid, 2
 * dashed every `dash` units of t (seconds along a track, points along a ring);
 * `elevScale` 0 lays the line on the ground. A line whose style is not in the
 * table is drawn as a "skyline".
 */
export const RIBBON_STYLES = Object.freeze({
  // The focus satellite's orbit: its shadow on the ground, a glow, and a core that fades with time.
  orbit: {
    z: 10,
    when: "showTrack",
    passes: [
      { mode: 0, width: 1.5, elevScale: 0, color: [0.6, 0.85, 1, 0.22], color2: [0.6, 0.6, 1, 0.16], colorPast: [1, 1, 1, 0.12] },
      { mode: 0, width: 10, soft: true, color: [0.3, 0.75, 1, 0.38], color2: [0.55, 0.4, 1, 0.22], colorPast: [1, 1, 1, 0.1] },
      { mode: 0, width: 2.4, color: [0.49, 0.83, 0.99, 1], color2: [0.66, 0.55, 0.98, 0.85], colorPast: [0.9, 0.93, 1, 0.55] },
    ],
  },
  // A track on the ground (a pass's ground track, for one).
  ground: { z: 12, passes: [{ width: 1.6, elevScale: 0, color: [0.88, 0.92, 1, 0.45] }] },
  // The rim of the visibility cone above home.
  coneRing: {
    z: 20,
    when: "showCone",
    passes: [
      { width: 6, soft: true, color: [1, 0.8, 0.3, 0.35] },
      { width: 1.6, color: [1, 0.84, 0.4, 0.9] },
    ],
  },
  // The ground the focus satellite can be seen from, dashed.
  footprint: { z: 30, when: "showFootprint", passes: [{ mode: 2, dash: 1, width: 1, color: [0.49, 0.83, 0.99, 0.35] }] },
  // A faint line for anything else.
  skyline: { z: 35, passes: [{ width: 1.2, color: [0.88, 0.92, 1, 0.5] }] },
  // The orbit leading into the selected pass, dashed gold.
  approach: { z: 40, passes: [{ mode: 2, width: 2, dash: 90, color: [1, 0.85, 0.45, 0.7] }] },
  // A path across the sky that is not visible (silver).
  overhead: {
    z: 50,
    passes: [
      { width: 9, soft: true, color: [0.8, 0.86, 1, 0.3] },
      { width: 2.4, color: [0.88, 0.92, 1, 0.8] },
    ],
  },
  // The other satellites of the selected pass: thin gold.
  member: {
    z: 55,
    passes: [
      { width: 6, soft: true, color: [1, 0.75, 0.2, 0.28] },
      { width: 1.4, color: [1, 0.86, 0.38, 0.85] },
    ],
  },
  // The selected pass, where it can be seen: gold.
  pass: {
    z: 60,
    passes: [
      { width: 12, soft: true, color: [1, 0.75, 0.2, 0.45] },
      { width: 3.4, color: [1, 0.86, 0.38, 1] },
    ],
  },
  // From the focus satellite straight down to the ground.
  drop: { z: 70, passes: [{ width: 1.2, color: [1, 1, 1, 0.4] }] },
});

// The ISS's orbit (5,580 s), for which the fade spans were first made.
const DEFAULT_SPANS = { past: 2400, future: 5700 };

/**
 * How far behind and ahead of the satellite its orbit is drawn, in seconds:
 * about 0.43 and 1.02 of its period, as for the ISS. For setFrame's `spans`.
 */
export function orbitSpans(periodS) {
  return periodS > 0 ? { past: 0.43 * periodS, future: 1.02 * periodS } : { ...DEFAULT_SPANS };
}

/**
 * The cloud's per-satellite data from the `satellite_spotter/catalog` payload,
 * in the order of `ids` (a positions payload's ids), for setCloud(). A
 * satellite missing from the catalogue is drawn as a faint satellite.
 */
export function cloudFromCatalog(catalog, ids) {
  const byId = new Map((catalog?.satellites || []).map((s) => [s.norad_id, s]));
  const n = ids.length;
  const out = { ids: new Int32Array(n), kinds: new Uint8Array(n), mags: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const sat = byId.get(ids[i]);
    out.ids[i] = ids[i];
    out.kinds[i] = KIND_CODES[sat?.kind] ?? KIND_CODES.satellite;
    out.mags[i] = Number.isFinite(sat?.magnitude) ? sat.magnitude : 5;
  }
  return out;
}

/**
 * Turn interpolatePositions() output ([lat, lon, km, lit] per satellite) into
 * setCloudPositions() input ([x, y, display altitude m, lit] per satellite).
 * Pass `out` to reuse an array every frame.
 */
export function cloudPositions(positions, out) {
  const n = positions.length >> 2;
  const res = out && out.length >= n * 4 ? out : new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lat = positions[o];
    const lon = positions[o + 1];
    const alt = positions[o + 2];
    if (!(Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(alt))) {
      res[o] = res[o + 1] = 0;
      res[o + 2] = NaN;
      res[o + 3] = 0;
      continue;
    }
    const [x, y] = mercator(lat, lon, POLE_LAT);
    res[o] = x;
    res[o + 1] = y;
    res[o + 2] = displayAltitudeKm(alt) * 1000;
    res[o + 3] = positions[o + 3];
  }
  return res;
}

// Base radius of a cloud dot in CSS px, by intrinsic magnitude (the catalogue's
// MAG: brightness at 1,000 km, half lit) and kind.
function cloudRadius(mag, kind) {
  const m = Number.isFinite(mag) ? mag : 5;
  const r = Math.min(6, Math.max(2.2, 3.9 - 0.55 * (m - 3)));
  if (kind === "iss" || kind === "tiangong") return r * 1.3;
  return kind === "debris" ? r * 0.85 : r;
}

/** The cloud shader's smoothstep(2500 km, 6500 km) shrink of satellites far out in space. */
function highOrbitScale(displayAltM) {
  const t = Math.min(1, Math.max(0, (displayAltM - 2.5e6) / 4e6));
  return 1 - 0.18 * t * t * (3 - 2 * t);
}

// Cloud flags (setCloudFlags).
const FLAG_HIDDEN = 1;
const FLAG_HOVER = 2;
const FLAG_NOW = 4;
const FLAG_MEMBER = 8;
const CLOUD_ATLAS_SIZE = 128;

/** Matrix (column-major, as WebGL's) times vector. */
function mul(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

const reducedMotionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;

export class SpaceLayer {
  constructor({ id = "sat-space" } = {}) {
    this.id = id;
    this.type = "custom";
    this.renderingMode = "2d";
    this._ribbons = new Map(); // name -> {data, segments, buffer, vao, dirty, style}
    this._fills = new Map(); // name -> {data, buffer, vao, dirty}
    this._garbage = []; // GL objects of removed lines, freed on the next frame
    this._state = null;
    this._ribbonPrograms = new ProgramCache(RIBBON_VERTEX, RIBBON_FRAGMENT, [
      "a_pos", "a_elev", "a_prev", "a_next", "a_side", "a_t", "a_lit",
    ]);
    this._spritePrograms = new ProgramCache(SPRITE_VERTEX, SPRITE_FRAGMENT, ["a_corner"]);
    this._fillPrograms = new ProgramCache(FILL_VERTEX, FILL_FRAGMENT, ["a_pos", "a_elev", "a_alpha"]);
    this._cloudPrograms = new ProgramCache(CLOUD_VERTEX, CLOUD_FRAGMENT, ["a_corner", "a_pos", "a_style", "a_color", "a_flags"]);
    this._cloud = null;
    this._last = null;
  }

  onAdd(map) {
    this._map = map;
  }

  onRemove(map, gl) {
    for (const cache of [this._ribbonPrograms, this._spritePrograms, this._fillPrograms, this._cloudPrograms]) cache.destroy(gl);
    for (const r of [...this._ribbons.values(), ...this._fills.values(), this._drop].filter(Boolean)) {
      if (r.vao) gl.deleteVertexArray(r.vao);
      if (r.buffer) gl.deleteBuffer(r.buffer);
      r.vao = r.buffer = null;
      r.dirty = true;
    }
    this._freeGarbage(gl);
    if (this._spriteVao) gl.deleteVertexArray(this._spriteVao);
    if (this._spriteBuffer) gl.deleteBuffer(this._spriteBuffer);
    for (const t of Object.values(this._textures || {})) gl.deleteTexture(t);
    this._spriteVao = this._spriteBuffer = this._textures = null;
    const c = this._cloud?.gl;
    if (c) {
      gl.deleteVertexArray(c.vao);
      [c.quad, c.pos, c.style, c.color, c.flags].forEach((b) => gl.deleteBuffer(b));
      if (c.atlas) gl.deleteTexture(c.atlas);
      this._cloud.gl = null;
      this._cloud.dirty = { pos: true, style: true, flags: true };
    }
  }

  // -- data -----------------------------------------------------------------

  /**
   * Replace a polyline from track rows ([t, lat, lon, alt km, lit, ...]).
   * `baseT` is subtracted from the times (float32 keeps a few days of
   * seconds); `elevationM` overrides the altitude (0 = on the ground); `style`
   * is one of RIBBON_STYLES (default: the name, so "orbit" and "pass" draw as
   * such, and `member:<norad id>` lines pass style "member"). The fourth
   * argument may also be the elevation alone, as in earlier versions.
   */
  setLine(name, rows, baseT, options = {}) {
    const { elevationM = null, style = name } =
      options !== null && typeof options === "object" ? options : { elevationM: options };
    const built = rows && rows.length > 1 ? buildRibbon(rowsToPoints(rows, baseT, elevationM)) : null;
    const old = this._ribbons.get(name) || {};
    this._ribbons.set(name, { ...old, ...(built || { data: new Float32Array(0), segments: [] }), style, dirty: true });
  }

  /** Remove a line (its GL buffers are freed on the next frame). */
  removeLine(name) {
    const r = this._ribbons.get(name);
    if (!r) return;
    if (r.vao || r.buffer) this._garbage.push(r);
    this._ribbons.delete(name);
  }

  /** Remove every line whose name starts with `prefix`, such as "member:". */
  clearLines(prefix = "") {
    for (const name of [...this._ribbons.keys()]) if (name.startsWith(prefix)) this.removeLine(name);
  }

  /** Replace a ring of [lon, lat] at a fixed altitude; t counts the points, for dashes. */
  setRing(name, ring, elevationM, { style = name } = {}) {
    const elev = displayAltitudeM(elevationM);
    const pts = ring.map(([lon, lat], i) => {
      const [x, y] = mercator(lat, lon, POLE_LAT);
      return [x, y, elev, i, 1];
    });
    const old = this._ribbons.get(name) || {};
    this._ribbons.set(name, { ...old, ...buildRibbon(pts), style, dirty: true });
  }

  /**
   * The cone of sky in which the satellite can be seen from home: a funnel
   * from home up to the ring at the satellite's altitude. radiusDeg is the
   * angular radius the ring was made with (needed for a ring around a pole).
   */
  setCone(home, ring, elevationM, radiusDeg) {
    const elev = displayAltitudeM(elevationM);
    const apex = mercator(home.latitude, home.longitude, POLE_LAT);
    // Unwrap around the apex so a cone near the antimeridian stays in one piece.
    const near = (pt) => {
      const q = mercator(pt[1], pt[0], POLE_LAT);
      if (q[0] - apex[0] > 0.5) q[0] -= 1;
      else if (q[0] - apex[0] < -0.5) q[0] += 1;
      return q;
    };
    const data = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = near(ring[i]);
      const b = near(ring[i + 1]);
      data.push(apex[0], apex[1], 0, 0.0, a[0], a[1], elev, 1, b[0], b[1], elev, 1);
    }
    this._setFill("cone", data, apex[0]);
    // Around a pole that fan has a face across the whole flat map, so the flat
    // map gets a shape of its own (the fan is right on the globe).
    const pole = radiusDeg > 0 && ring.length > 2 && aroundPole(ring);
    const cap = pole ? poleCapFill(home, ring, elev, radiusDeg) : [];
    this._setFill("coneFlat", cap, apex[0], cap.split);
  }

  /**
   * Replace a filled shape around mercator x, given as triangles of [x, y, elevation, alpha].
   * A shape split at a vertex is drawn as two parts, [first, count, midX, halfWidth],
   * each on its own copy of the world, as the pieces of a ribbon are.
   */
  _setFill(name, data, x, split) {
    let reach = 0;
    for (let i = 0; i < data.length; i += 4) reach = Math.max(reach, Math.abs(data[i] - x));
    const part = (first, count) => {
      const xs = data.slice(first * 4, (first + count) * 4).filter((_, i) => i % 4 === 0);
      const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
      return [first, count, (lo + hi) / 2, (hi - lo) / 2];
    };
    const parts = split === undefined ? null : [part(0, split), part(split, data.length / 4 - split)];
    const old = this._fills.get(name) || {};
    this._fills.set(name, { ...old, data: new Float32Array(data), x, reach, parts, dirty: true });
  }

  /**
   * Per-frame state; cheap, no buffers change.
   *
   *  - now: seconds since the lines' baseT (past and future of the orbit);
   *  - pixelRatio (used only when the canvas size is unknown);
   *  - showTrack, showCone, showFootprint, coneAlpha;
   *  - ticks: [[x, y, altitude m], ...] dots along the orbit;
   *  - objects: [{id, kind, center: [x, y, altitude m], ahead, ground, sunlit, size, primary}]:
   *    satellites drawn as sprites of their kind (`size` = half the width in CSS
   *    px); `ahead` (a point a little later on the track) turns the nose along
   *    the direction of travel. The primary also gets a glow in sunlight, its
   *    shadow on the ground and a line down to it.
   *  - spans: {past, future} of the orbit's fade, in seconds (orbitSpans(period));
   *  - reducedMotion: no breathing rings in the cloud (default: the browser's setting).
   * `iss: {center, ahead, ground, sunlit, size}` is still read as the primary object.
   */
  setFrame(state) {
    this._state = state;
  }

  /** The objects to draw this frame. */
  _objects() {
    const st = this._state;
    if (Array.isArray(st?.objects)) return st.objects.filter((o) => o?.center?.length >= 2);
    return st?.iss ? [{ ...st.iss, kind: "iss", primary: true }] : [];
  }

  /**
   * The satellite cloud: every satellite of the catalogue, in a fixed order
   * (setCloudPositions and setCloudFlags use the same one). `kinds` are
   * KIND_CODES, `mags` intrinsic magnitudes (size and brightness). Call it
   * when the catalogue changes; see cloudFromCatalog().
   */
  setCloud({ ids = [], kinds = [], mags = [] } = {}) {
    const n = ids.length;
    const style = new Float32Array(n * 4);
    const color = new Uint8Array(n * 4);
    const radii = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const kind = KINDS[kinds[i]] ?? "satellite";
      const mag = mags[i];
      radii[i] = cloudRadius(mag, kind);
      style[i * 4] = radii[i];
      style[i * 4 + 1] = KIND_CODES[kind];
      // Faint satellites are a little more see-through as well as smaller.
      style[i * 4 + 2] = Math.min(1, Math.max(0.55, 1.1 - 0.12 * ((Number.isFinite(mag) ? mag : 5) - 2)));
      // A phase per satellite, so the rings of several visible at once do not breathe in step.
      style[i * 4 + 3] = ((ids[i] * 2.399963) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const rgb = KIND_COLORS[kind];
      color.set([Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255), 255], i * 4);
    }
    const old = this._cloud;
    // Positions and flags carry over only while they are for the same satellites.
    const same = old?.n === n && old.ids.every((id, i) => id === Number(ids[i]));
    this._cloud = {
      n,
      ids: Int32Array.from(ids),
      style,
      color,
      radii,
      pos: same ? old.pos : new Float32Array(n * 4),
      count: same ? old.count : 0,
      flags: same ? old.flags : new Uint8Array(n),
      visible: old?.visible ?? true,
      gl: old?.gl ?? null,
      dirty: { pos: true, style: true, flags: true },
    };
  }

  /**
   * Where every satellite of the cloud is this frame: [x, y, display altitude
   * m, lit 0..1] each (see cloudPositions()); a NaN altitude hides one.
   * `visible: false` hides the whole cloud and keeps the data.
   */
  setCloudPositions(positions, { visible = true } = {}) {
    const c = this._cloud;
    if (!c) return;
    c.visible = visible;
    if (!positions) return;
    const count = Math.min(c.n, positions.length >> 2);
    for (let i = 0; i < count * 4; i += 4) {
      const ok = Number.isFinite(positions[i]) && Number.isFinite(positions[i + 1]) && Number.isFinite(positions[i + 2]);
      c.pos[i] = ok ? positions[i] : 0;
      c.pos[i + 1] = ok ? positions[i + 1] : 0;
      // -1 m marks "no position" for the shader (NaN is not reliable in GLSL).
      c.pos[i + 2] = ok ? positions[i + 2] : -1;
      c.pos[i + 3] = ok ? positions[i + 3] : 0;
    }
    c.count = count;
    c.dirty.pos = true;
  }

  /**
   * Per-satellite flags, in the cloud's order: 1 selected or hidden (not drawn
   * in the cloud: the focus satellite is a sprite), 2 under the pointer, 4
   * visible from home right now (a breathing gold ring), 8 a member of the
   * selected pass (gold).
   */
  setCloudFlags(flags) {
    const c = this._cloud;
    if (!c) return;
    const n = Math.min(c.n, flags?.length ?? 0);
    for (let i = 0; i < c.n; i++) c.flags[i] = i < n ? flags[i] : 0;
    c.dirty.flags = true;
  }

  /** Whether the cloud has something that moves on its own (a visible satellite's ring): redraw every frame then. */
  get animating() {
    const c = this._cloud;
    return !!c && c.visible && c.count > 0 && !this._reducedMotion() && c.flags.some((f) => f & FLAG_NOW && !(f & FLAG_HIDDEN));
  }

  _reducedMotion() {
    return this._state?.reducedMotion ?? reducedMotionQuery?.matches ?? false;
  }

  // -- rendering ------------------------------------------------------------

  prerender(gl, args) {
    const caches = [this._fillPrograms, this._ribbonPrograms, this._spritePrograms];
    if (this._cloud?.n) caches.push(this._cloudPrograms);
    for (const cache of caches) cache.prepare(gl, args.shaderData);
  }

  /** The sprite texture of a kind (or glow, dot), made on first use. */
  _texture(gl, kind) {
    this._textures ??= {};
    const key = spriteKind(kind);
    let tex = this._textures[key];
    if (!tex) {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      const size = key === "glow" ? 128 : key === "dot" ? 64 : 256;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawSprite(key, size));
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._textures[key] = tex;
    }
    return tex;
  }

  _ensureRibbon(gl, r) {
    if (!r.dirty && r.vao) return;
    if (!r.vao) {
      r.vao = gl.createVertexArray();
      r.buffer = gl.createBuffer();
      gl.bindVertexArray(r.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.buffer);
      const f = 4;
      const s = RIBBON_STRIDE * f;
      const attrs = [
        [0, 2, 0], [1, 1, 2], [2, 3, 3], [3, 3, 6], [4, 1, 9], [5, 1, 10], [6, 1, 11],
      ];
      for (const [loc, size, offset] of attrs) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, s, offset * f);
      }
    } else {
      gl.bindVertexArray(r.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.buffer);
    }
    gl.bufferData(gl.ARRAY_BUFFER, r.data, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    r.dirty = false;
  }

  _ensureSprite(gl) {
    if (this._spriteVao) return;
    this._spriteVao = gl.createVertexArray();
    this._spriteBuffer = gl.createBuffer();
    gl.bindVertexArray(this._spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._spriteBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _ensureFill(gl, f) {
    if (!f.vao) {
      f.vao = gl.createVertexArray();
      f.buffer = gl.createBuffer();
      gl.bindVertexArray(f.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, f.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 12);
      gl.bindVertexArray(null);
      f.dirty = true;
    }
    if (f.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, f.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, f.data, gl.STATIC_DRAW);
      f.dirty = false;
    }
  }

  _freeGarbage(gl) {
    for (const r of this._garbage) {
      if (r.vao) gl.deleteVertexArray(r.vao);
      if (r.buffer) gl.deleteBuffer(r.buffer);
    }
    this._garbage = [];
  }

  /** One pass of a ribbon style over a line. */
  _drawRibbon(gl, prog, view, r, pass, spans) {
    if (!r || !r.segments.length) return;
    this._ensureRibbon(gl, r);
    const u = prog.uniforms;
    gl.uniform1f(u.u_width, pass.width * (this._pixelRatio || 1));
    gl.uniform1f(u.u_elev_scale, pass.elevScale ?? 1);
    gl.uniform1i(u.u_mode, pass.mode ?? 1);
    gl.uniform4f(u.u_color, ...pass.color);
    gl.uniform4f(u.u_color2, ...(pass.color2 || pass.color));
    gl.uniform4f(u.u_color_past, ...(pass.colorPast || pass.color));
    gl.uniform1f(u.u_now, this._state?.now ?? 0);
    gl.uniform1f(u.u_past_span, spans.past);
    gl.uniform1f(u.u_future_span, spans.future);
    gl.uniform1f(u.u_dash, pass.dash ?? 60);
    gl.uniform1f(u.u_soft, pass.soft ? 1 : 0);
    gl.bindVertexArray(r.vao);
    for (const [first, count, x, half] of r.segments) {
      drawCopies(gl, prog, view, x, half + COPY_MARGIN, () => gl.drawArrays(gl.TRIANGLE_STRIP, first, count));
    }
  }

  _drawSprite(gl, prog, view, texture, center, size, opts = {}) {
    const u = prog.uniforms;
    // The point ahead on the sprite's copy of the world: across the antimeridian it
    // is a world away, which on the flat map would turn the nose to the west.
    const ahead = opts.ahead || center;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform3f(u.u_center, center[0], center[1], center[2]);
    gl.uniform3f(u.u_ahead, ahead[0] + Math.round(center[0] - ahead[0]), ahead[1], ahead[2]);
    gl.uniform1f(u.u_size, size * (this._pixelRatio || 1));
    gl.uniform1f(u.u_orient, opts.ahead ? 1 : 0);
    gl.uniform1f(u.u_opacity, opts.opacity ?? 1);
    gl.uniform3f(u.u_tint, ...(opts.tint || [1, 1, 1]));
    drawCopies(gl, prog, view, center[0], COPY_MARGIN, () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4));
  }

  /** The line from the primary satellite down to the ground, unless the view gave one as "drop". */
  _dropLine(primary) {
    const c = primary?.center;
    const g = primary?.ground;
    if (!c || !g || this._ribbons.has("drop")) return null;
    const key = `${c[0]},${c[1]},${c[2]},${g[0]},${g[1]}`;
    if (this._drop?.key !== key) {
      const top = displayAltitudeM(c[2]);
      const built = buildRibbon([
        [g[0], g[1], 0, 0, 1],
        [c[0], c[1], top, 0, 1],
      ]);
      this._drop = { ...(this._drop || {}), ...built, style: "drop", key, dirty: true };
    }
    return this._drop;
  }

  render(gl, args) {
    const st = this._state;
    const view = viewOf(this._map, args);
    const p = args.defaultProjectionData;
    this._last = {
      main: Float64Array.from(p.mainMatrix),
      fallback: Float64Array.from(p.fallbackMatrix),
      plane: p.clippingPlane.slice(),
      transition: p.projectionTransition,
      globe: view.globe,
      center: view.center,
      // The copies of the world the cloud is drawn on (the flat map's; [0] on the globe), for pick().
      copies: view.copies(0.5, 0.5 + COPY_MARGIN),
    };
    if (this._garbage.length) this._freeGarbage(gl);
    if (!st) return;
    const progs = programsFor(this, gl, args.shaderData, [this._fillPrograms, this._ribbonPrograms, this._spritePrograms]);
    if (!progs) return;
    const [fill, ribbon, sprite] = progs;
    // Widths and sizes are in CSS pixels, and the canvas can be drawn at a lower
    // pixel ratio than MapLibre was asked for (it keeps within maxCanvasSize).
    const cssWidth = this._map?.getCanvas().clientWidth;
    this._pixelRatio = cssWidth > 0 ? gl.drawingBufferWidth / cssWidth : st.pixelRatio || 1;
    this._ensureSprite(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);

    // Visibility cone above home; on the flat map one around a pole has its own shape.
    const flat = !view.globe || p.projectionTransition <= 0.999;
    const coneFlat = this._fills.get("coneFlat");
    const cone = flat && coneFlat?.data.length ? coneFlat : this._fills.get("cone");
    if (st.showCone && cone?.data.length) {
      this._ensureFill(gl, cone);
      gl.useProgram(fill.program);
      setProjectionUniforms(gl, fill, view);
      gl.uniform4f(fill.uniforms.u_color, 0.99, 0.78, 0.25, st.coneAlpha ?? 0.16);
      gl.bindVertexArray(cone.vao);
      for (const [first, count, x, reach] of cone.parts || [[0, cone.data.length / 4, cone.x, cone.reach]]) {
        drawCopies(gl, fill, view, x, reach, () => gl.drawArrays(gl.TRIANGLES, first, count));
      }
    }

    // Every satellite, under the focus satellite's lines and sprites.
    this._drawCloud(gl, args, view);

    // Lines, bottom to top.
    const objects = this._objects();
    const primary = objects.find((o) => o.primary);
    const lines = [...this._ribbons.values()];
    const drop = this._dropLine(primary);
    if (drop) lines.push(drop);
    const styleOf = (r) => RIBBON_STYLES[r.style] || RIBBON_STYLES.skyline;
    const order = lines
      .filter((r) => r.segments.length && (!styleOf(r).when || st[styleOf(r).when]))
      .map((r, i) => [styleOf(r).z, i, r])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (order.length) {
      gl.useProgram(ribbon.program);
      setProjectionUniforms(gl, ribbon, view);
      const spans = {
        past: st.spans?.past > 0 ? st.spans.past : DEFAULT_SPANS.past,
        future: st.spans?.future > 0 ? st.spans.future : DEFAULT_SPANS.future,
      };
      for (const [, , r] of order) {
        for (const pass of styleOf(r).passes) this._drawRibbon(gl, ribbon, view, r, pass, spans);
      }
    }

    // Sprites: tick marks, the other satellites of the pass, then the focus satellite.
    gl.useProgram(sprite.program);
    setProjectionUniforms(gl, sprite, view);
    gl.bindVertexArray(this._spriteVao);
    gl.uniform1i(sprite.uniforms.u_tex, 0);
    const at = (q) => [q[0], q[1], displayAltitudeM(q[2] ?? 0)];
    for (const t of st.ticks || []) {
      this._drawSprite(gl, sprite, view, this._texture(gl, "dot"), at(t), 4.5, { opacity: 0.95, tint: [0.88, 0.95, 1] });
    }
    for (const o of objects) if (!o.primary) this._drawObject(gl, sprite, view, o, at);
    for (const o of objects) if (o.primary) this._drawObject(gl, sprite, view, o, at);
    gl.bindVertexArray(null);
  }

  /**
   * A satellite as a sprite of its kind. The primary gets its shadow on the
   * ground and a glow in sunlight; the others a small gold glow, and only a
   * bright dot when they are drawn too small (under 10 px) for their shape to show.
   */
  _drawObject(gl, prog, view, o, at) {
    const kind = spriteKind(o.kind);
    const center = at(o.center);
    const sunlit = o.sunlit !== false;
    // Rocket bodies tumble and debris has no front: drawn upright, not turned with the motion.
    const ahead = o.ahead && kind !== "rocket" && kind !== "debris" ? at(o.ahead) : null;
    const shade = [0.42, 0.45, 0.62];
    if (o.primary) {
      const size = o.size ?? 20;
      if (o.ground) {
        this._drawSprite(gl, prog, view, this._texture(gl, "dot"), at(o.ground), 6, { opacity: 0.55, tint: [0.1, 0.1, 0.12] });
      }
      if (sunlit) this._drawSprite(gl, prog, view, this._texture(gl, "glow"), center, size * 1.9, { opacity: 0.75 });
      this._drawSprite(gl, prog, view, this._texture(gl, kind), center, size, {
        ahead,
        opacity: sunlit ? 1 : 0.85,
        tint: sunlit ? [1, 1, 1] : shade,
      });
      return;
    }
    const size = o.size ?? 9;
    this._drawSprite(gl, prog, view, this._texture(gl, "glow"), center, size * 1.7, {
      opacity: sunlit ? 0.55 : 0.2,
      tint: [1, 0.82, 0.42],
    });
    if (size < 10) {
      this._drawSprite(gl, prog, view, this._texture(gl, "dot"), center, Math.max(size, 2.5), {
        opacity: sunlit ? 1 : 0.6,
        tint: sunlit ? [1, 0.93, 0.7] : shade,
      });
      return;
    }
    this._drawSprite(gl, prog, view, this._texture(gl, kind), center, size, {
      ahead,
      opacity: sunlit ? 1 : 0.8,
      tint: sunlit ? [1, 1, 1] : shade,
    });
  }

  /** Make (or update) the cloud's buffers and texture array. */
  _ensureCloud(gl, c) {
    let g = c.gl;
    if (!g) {
      g = c.gl = { vao: gl.createVertexArray(), quad: gl.createBuffer(), pos: gl.createBuffer(), style: gl.createBuffer(), color: gl.createBuffer(), flags: gl.createBuffer(), size: 0, atlas: null };
      gl.bindVertexArray(g.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      // One of each per satellite (divisor 1).
      const attribs = [
        [1, g.pos, 4, gl.FLOAT, false],
        [2, g.style, 4, gl.FLOAT, false],
        [3, g.color, 4, gl.UNSIGNED_BYTE, true],
        [4, g.flags, 1, gl.UNSIGNED_BYTE, false],
      ];
      for (const [loc, buffer, size, type, normalized] of attribs) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
        gl.vertexAttribDivisor(loc, 1);
      }
      gl.bindVertexArray(null);
      c.dirty = { pos: true, style: true, flags: true };
    }
    if (g.size !== c.n) {
      // Room for this many satellites; the contents follow.
      gl.bindBuffer(gl.ARRAY_BUFFER, g.pos);
      gl.bufferData(gl.ARRAY_BUFFER, c.n * 16, gl.DYNAMIC_DRAW);
      g.size = c.n;
      c.dirty = { pos: true, style: true, flags: true };
    }
    if (c.dirty.pos) {
      gl.bindBuffer(gl.ARRAY_BUFFER, g.pos);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, c.pos);
    }
    if (c.dirty.style) {
      gl.bindBuffer(gl.ARRAY_BUFFER, g.style);
      gl.bufferData(gl.ARRAY_BUFFER, c.style, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.color);
      gl.bufferData(gl.ARRAY_BUFFER, c.color, gl.STATIC_DRAW);
    }
    if (c.dirty.flags) {
      gl.bindBuffer(gl.ARRAY_BUFFER, g.flags);
      gl.bufferData(gl.ARRAY_BUFFER, c.flags, gl.DYNAMIC_DRAW);
    }
    c.dirty = { pos: false, style: false, flags: false };
    if (!g.atlas) {
      // One 128 px layer per kind, in KIND_CODES order, mipmapped per layer
      // (a 2D atlas would bleed between neighbours as it shrinks).
      g.atlas = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, g.atlas);
      const levels = Math.log2(CLOUD_ATLAS_SIZE) + 1;
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, CLOUD_ATLAS_SIZE, CLOUD_ATLAS_SIZE, KINDS.length);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      KINDS.forEach((kind, layer) => {
        const glyph = drawSprite(kind, CLOUD_ATLAS_SIZE);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, CLOUD_ATLAS_SIZE, CLOUD_ATLAS_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, glyph);
      });
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
  }

  /** How much bigger the cloud's dots are at this zoom than at the globe's usual one. */
  _cloudScale() {
    const zoom = this._map?.getZoom?.();
    return Number.isFinite(zoom) ? Math.min(2.6, Math.max(0.85, 1 + (zoom - 2) * 0.28)) : 1;
  }

  /** The cloud of every satellite: one instanced draw per copy of the world in view. */
  _drawCloud(gl, args, view) {
    const c = this._cloud;
    if (!c || !c.visible || !c.count) return;
    const progs = programsFor(this, gl, args.shaderData, [this._cloudPrograms]);
    if (!progs) return;
    const [prog] = progs;
    this._ensureCloud(gl, c);
    const u = prog.uniforms;
    gl.useProgram(prog.program);
    setProjectionUniforms(gl, prog, view);
    this._cloudScaleNow = this._cloudScale();
    gl.uniform1f(u.u_center_x, view.center);
    gl.uniform1f(u.u_px, this._pixelRatio || 1);
    gl.uniform1f(u.u_scale, this._cloudScaleNow);
    gl.uniform1f(u.u_time, (globalThis.performance?.now() ?? Date.now()) / 1000);
    gl.uniform1f(u.u_pulse, this._reducedMotion() ? 0 : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, c.gl.atlas);
    gl.uniform1i(u.u_atlas, 0);
    gl.bindVertexArray(c.gl.vao);
    const draw = () => gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.count);
    if (view.globe) {
      // Each satellite finds the copy nearest the centre in the shader (u_center_x).
      draw();
    } else {
      for (const w of this._last.copies) {
        gl.uniformMatrix4fv(u.u_projection_matrix, false, view.main(w));
        draw();
      }
    }
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  /**
   * The satellite of the cloud under a point of the map (CSS px in a
   * width x height canvas), using the last frame: the index of the nearest one
   * within maxPx (or its drawn radius, when larger), or -1. Satellites the
   * cloud does not draw (flag 1, behind the globe, no position) are skipped.
   */
  pick(px, py, width, height, maxPx = 12) {
    const c = this._cloud;
    const L = this._last;
    if (!c || !L || !c.visible || !c.count) return -1;
    const scale = this._cloudScaleNow ?? this._cloudScale();
    // On a flat map zoomed out far enough to show the world more than once, any copy the cloud is drawn on
    // can be the one under the pointer: whole-world shifts, which projectMercator() counts from the nearest copy.
    const shifts = L.globe ? [0] : L.copies;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < c.count; i++) {
      const f = c.flags[i];
      const o = i * 4;
      if (f & FLAG_HIDDEN || c.pos[o + 2] < -0.5) continue;
      let r = c.radii[i] * scale * (f & FLAG_MEMBER ? MEMBER_SCALE : 1) * highOrbitScale(c.pos[o + 2]);
      if (f & FLAG_HOVER) r = Math.max(r * 2.2, HOVER_MIN_RADIUS);
      const reach = Math.max(maxPx, r);
      const nearest = L.globe ? 0 : Math.round(L.center - c.pos[o]);
      for (const w of shifts) {
        const s = this.projectMercator(c.pos[o], c.pos[o + 1], c.pos[o + 2], width, height, w - nearest);
        if (!s) continue;
        const d = Math.hypot(s.x - px, s.y - py);
        if (d <= reach && d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best;
  }

  /**
   * Where a point at an altitude appears on screen, in CSS pixels, using the
   * matrices of the last frame; null if hidden behind the globe or off screen.
   * On the flat map it is the copy of the world nearest the centre of the view,
   * which is where MapLibre puts its markers too. The altitude is the true one,
   * drawn (as everything) at its display altitude; a latitude past the flat
   * map's limit is where it is on the globe and on the map's edge when flat.
   */
  project(lat, lon, altitudeM, width, height) {
    const [x, y] = mercator(lat, lon, POLE_LAT);
    return this.projectMercator(x, y, displayAltitudeM(altitudeM), width, height);
  }

  /**
   * project() for a point already in mercator units at its display altitude
   * (as the cloud's positions are). `copy` shifts it by whole worlds from the
   * copy nearest the centre of the view (the flat map repeats the world).
   */
  projectMercator(x, y, displayAltM, width, height, copy = 0) {
    const L = this._last;
    if (!L) return null;
    const near = x + Math.round((L.center ?? x) - x) + copy;
    const onMap = Math.max(0, Math.min(1, y));
    let clip;
    if (L.globe) {
      const sx = x * 2 * Math.PI + Math.PI;
      const t = Math.exp(Math.PI - y * 2 * Math.PI);
      const sinSy = (t * t - 1) / (t * t + 1);
      const cosSy = (2 * t) / (t * t + 1);
      const k = 1 + displayAltM / GLOBE_RADIUS_M;
      const s = [Math.sin(sx) * cosSy * k, sinSy * k, Math.cos(sx) * cosSy * k, 1];
      // Behind the planet (see projectAlt).
      const d = -L.plane[3];
      const limit = d - Math.sqrt(Math.max(1 - d * d, 0)) * Math.sqrt(Math.max(k * k - 1, 0));
      if (s[0] * L.plane[0] + s[1] * L.plane[1] + s[2] * L.plane[2] < limit) return null;
      clip = mul(L.main, s);
      if (L.transition <= 0.999) {
        const f = mul(L.fallback, [near, onMap, 0, 1]);
        clip = [0, 1, 3].reduce((c, i) => {
          c[i] = f[i] + (clip[i] - f[i]) * L.transition;
          return c;
        }, clip.slice());
      }
    } else {
      clip = mul(L.main, [near, onMap, 0, 1]);
    }
    if (clip[3] <= 0) return null;
    const px = ((clip[0] / clip[3]) * 0.5 + 0.5) * width;
    const py = (0.5 - (clip[1] / clip[3]) * 0.5) * height;
    if (px < -50 || py < -50 || px > width + 50 || py > height + 50) return null;
    return { x: px, y: py };
  }
}

/**
 * Mercator units of a point to draw with this layer (setFrame's objects and
 * ticks): its true latitude up to just short of the pole, as the lines are,
 * so a satellite over the pole sits on its orbit on the globe; the flat map
 * puts what is beyond its limit on its edge. Pass `limit` to clamp sooner.
 */
export function toMercator(lat, lon, limit = POLE_LAT) {
  return mercator(lat, lon, limit);
}
