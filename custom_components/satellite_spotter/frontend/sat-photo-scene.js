/**
 * The street view's photo scene: a 360° street photo near home
 * (sat-photo.js) drawn with WebGL 2 for the street view's camera, darkened
 * for the moment of the pass, with its sky transparent so that the
 * planetarium sky drawn behind it shows through, and hidden by what stands
 * in it. Along the sky's edge each pixel is decided by its colour, between
 * the sky's and that of what is not sky nearby (two-colour matting), so the
 * skyline stays sharp at any zoom and the sky between a tree's branches
 * shows.
 *
 * The scene loads the small picture first (2048 px), finds its sky at 1024
 * px, shows it, and then swaps in the large one when it has come: one image
 * each from Panoramax and Mapillary, Google's put together from its tiles
 * (sat-photo-sources.js). Its interface is the one the street view uses for
 * the 3D scene (sat-street-scene.js): setView, resize, setLook, remove;
 * occlusion comes from the sky it found (hiddenByPhoto) rather than a
 * read-back.
 */

const VERSION = new URL(import.meta.url).search;
const [{ SKY_WIDTH, findSky, multiply3, photoLook, photoRotation, skyTextures, sunHeading, transpose3 }, { fetchInit, fetchTiles, googleTiles }] = await Promise.all([
  import(`./sat-photo.js${VERSION}`),
  import(`./sat-photo-sources.js${VERSION}`),
]);

const DEG = Math.PI / 180;
/** A picture with less sky than this (a share of it) is under a roof or taken at night: not used. */
export const MIN_SKY = 0.03;
/** The large picture is drawn at most this wide (px): 4096 is 11 px a degree, about the screen's at 60°. */
const MAX_WIDTH_PHONE = 4096;
const MAX_WIDTH = 8192;
/** The small picture's width, at most (Google's is put together at about this size). */
const SMALL_WIDTH = 2048;

const VERTEX = `#version 300 es
void main() {
  // One triangle over the whole canvas.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uPhoto;
uniform sampler2D uMask;
uniform sampler2D uSkyColour;
uniform sampler2D uOtherColour;
// (x, y, 1) of a screen ray (from the centre, in focal lengths, y down) to
// the photo's own direction (x right, y forward, z up), and to the world's up.
uniform mat3 uRay;
uniform vec3 uUp;
// The centre and focal length in device pixels, and the canvas height.
uniform vec4 uScreen;
uniform float uExposure;
uniform float uDesaturate;
uniform vec3 uTint;
uniform vec3 uGround;
// sin of the elevations where the night ground starts and is complete.
uniform vec2 uGroundFade;
out vec4 outColour;

const float PI = 3.14159265358979;

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uScreen.w - gl_FragCoord.y);
  vec3 q = vec3((px - uScreen.xy) / uScreen.z, 1.0);
  vec3 d = normalize(uRay * q);
  vec2 uv = vec2(0.5 + atan(d.x, d.y) / (2.0 * PI), 0.5 - asin(clamp(d.z, -1.0, 1.0)) / PI);
  // Derivatives across the picture's seam (u jumps from 1 to 0) are taken the short way round.
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  dx.x -= round(dx.x);
  dy.x -= round(dy.x);
  vec3 c = textureGrad(uPhoto, uv, dx, dy).rgb;
  vec4 m = texture(uMask, uv);
  float sky = m.r;
  if (m.g > 0.0) {
    vec3 s = texture(uSkyColour, uv).rgb;
    vec3 o = texture(uOtherColour, uv).rgb;
    vec3 so = s - o;
    float l2 = dot(so, so);
    float share = clamp(dot(c - o, so) / max(l2, 1e-5), 0.0, 1.0);
    // Only where the sky and what stands against it differ enough to tell apart.
    sky = mix(sky, share, m.g * smoothstep(0.0004, 0.004, l2));
  }
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 graded = mix(c, vec3(lum), uDesaturate) * uTint * uExposure;
  float sinEl = dot(uUp, q) / length(q);
  graded = mix(graded, uGround, 1.0 - smoothstep(uGroundFade.y, uGroundFade.x, sinEl));
  float alpha = 1.0 - sky;
  outColour = vec4(toSrgb(graded) * alpha, alpha);
}`;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * The linear map from a screen ray (x, y, 1) — x right and y down from the
 * centre, in focal lengths — to its world direction [east, north, up], for
 * a view {bearing, pitch, roll}: sat-planetarium.js makeProjector's
 * unproject, column by column (row-major 3×3).
 */
export function rayToWorld({ bearing, pitch, roll = 0 }) {
  const [cb, sb] = [Math.cos(bearing * DEG), Math.sin(bearing * DEG)];
  const [cp, sp] = [Math.cos(pitch * DEG), Math.sin(pitch * DEG)];
  const [cr, sr] = [Math.cos(roll * DEG), Math.sin(roll * DEG)];
  // Columns: d/dx, d/dy and the constant (the centre of the view).
  const ex = [cb * cr - sb * cp * sr, -(sb * cr + cb * cp * sr), -sp * sr];
  const ey = [-cb * sr - sb * cp * cr, sb * sr - cb * cp * cr, -sp * cr];
  const e0 = [sb * sp, cb * sp, -cp];
  return [ex[0], ey[0], e0[0], ex[1], ey[1], e0[1], ex[2], ey[2], e0[2]];
}

/** WebGL wants a mat3 column by column. */
const columns = (m) => new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);

/** Whether this is a phone or tablet, which gets the smaller large picture (memory). */
function coarsePointer() {
  return !!globalThis.matchMedia?.("(pointer: coarse)").matches;
}

/**
 * A picture's bytes as an ImageBitmap (or an <img> where createImageBitmap
 * is missing), optionally scaled.
 */
async function decode(blob, size = null) {
  if (globalThis.createImageBitmap) {
    const options = { imageOrientation: "none", premultiplyAlpha: "none" };
    if (size) Object.assign(options, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
    return createImageBitmap(blob, options);
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A 2D canvas of a size (off-screen where the browser has them). */
function canvas2d(width, height) {
  return globalThis.OffscreenCanvas ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
}

/** A picture's pixels at a size, through a 2D canvas. */
function pixels(source, width, height) {
  const ctx = canvas2d(width, height).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** A picture no wider than `limit` (2:1): itself, or drawn smaller on a canvas. */
function fitted(source, limit) {
  if (source.width <= limit) return source;
  const canvas = canvas2d(limit, limit / 2);
  canvas.getContext("2d").drawImage(source, 0, 0, limit, limit / 2);
  source.close?.();
  return canvas;
}

/** A Google panorama put together from its tiles' bytes (googleTiles' plan), each at its place. */
async function stitch(plan, blobs) {
  const canvas = canvas2d(plan.width, plan.height);
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < blobs.length; i++) {
    const tile = await decode(blobs[i]);
    ctx.drawImage(tile, plan.tiles[i].x * plan.tileWidth, plan.tiles[i].y * plan.tileHeight);
    tile.close?.();
  }
  return canvas;
}

export class PhotoScene {
  /**
   * @param {HTMLElement} container
   * @param {object} o
   * @param {object} o.photo a candidate from photoCandidates()
   * @param {{bearing: number, pitch: number, fov: number, roll?: number}} o.view
   * @param {object} [o.look] photoLook()
   * @param {(url: string, init: object) => Promise<Response>} [o.fetch]
   * @param {(ms: number, place: {latitude: number, longitude: number}) => {azimuth: number, elevation: number}} [o.sunAt]
   *   where the Sun was when and where the photo was taken, to turn the photo to match it (sat-astro.js sunAzEl)
   * @param {() => void} [o.onContextLost]
   * @param {() => void} [o.onContextRestored]
   */
  constructor(container, { photo, view, look = null, fetch: fetchImpl = (url, init) => globalThis.fetch(url, init), sunAt = null, onContextLost = () => {}, onContextRestored = () => {} }) {
    this.kind = "photo";
    this.photo = photo;
    this.rotation = photoRotation(photo);
    this.view = { roll: 0, ...view };
    this.look = look ?? photoLook({ elevation: -30 });
    this.found = null;
    this.large = false;
    // How far the photo was turned to match the Sun in it (degrees; 0 when it does not show).
    this.turned = 0;
    this._sunAt = sunAt;
    this.degraded = new Set();
    this.buildings = false;
    this._fetch = fetchImpl;
    this._abort = globalThis.AbortController ? new AbortController() : null;
    this._onContextLost = onContextLost;
    this._onContextRestored = onContextRestored;
    const canvas = document.createElement("canvas");
    canvas.className = "photo";
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block" });
    container.append(canvas);
    this.canvas = canvas;
    this.container = container;
    canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      this._gl = null;
      this._onContextLost();
    });
    canvas.addEventListener("webglcontextrestored", () => {
      if (!this._setupGl()) return;
      this._upload();
      this.render();
      this._onContextRestored();
    });
    if (!this._setupGl()) {
      canvas.remove();
      throw new Error("WebGL 2 is not available");
    }
    this.resize();
  }

  /**
   * Fetch the small picture, find its sky and show it; then fetch the large
   * one. Rejects when the picture cannot be had or shows too little sky.
   */
  async load() {
    const signal = this._abort?.signal;
    const { image: small, restore, zoom } = await this._picture(SMALL_WIDTH, signal, false);
    if (this._removed) {
      small.close?.();
      throw new Error("removed");
    }
    const ratio = small.width / small.height;
    if (Math.abs(ratio - 2) > 0.02) {
      small.close?.();
      throw new Error(`not an equirectangular picture (${small.width} × ${small.height})`);
    }
    const width = Math.min(SKY_WIDTH, small.width);
    const image = pixels(small, width, width / 2);
    // Finding the sky takes a tenth of a second or so: let the page draw its loading veil first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const found = findSky(image, this.rotation);
    if (found.fraction < MIN_SKY) {
      small.close?.();
      throw new Error("the picture shows too little sky");
    }
    // The heading the photo came with is often 10° to 30° off: the Sun in it says by how much.
    // (Turning it changes no elevation, so the sky found stands.) Google's say only the month.
    const photo = this.photo;
    if (this._sunAt && !photo.approximate && Number.isFinite(photo.taken) && Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude)) {
      const predicted = this._sunAt(photo.taken * 1000, { latitude: photo.latitude, longitude: photo.longitude });
      const { heading, turned } = sunHeading(photo, image, found, predicted);
      if (turned) {
        this.turned = turned;
        this.rotation = photoRotation({ ...photo, heading });
        console.debug(`Satellite Spotter: street photo ${photo.id} turned ${turned.toFixed(1)}° to match the Sun in it`);
      }
    }
    this.found = found;
    this._textures = skyTextures(image, found);
    this._restore = restore;
    this._upload(small);
    small.close?.();
    this.render();
    // The large picture, when it comes; the small one stays if it does not.
    if (this._hasLarger(zoom)) {
      this._loadLarge(signal).catch((err) => {
        if (err?.name !== "AbortError") console.debug("Satellite Spotter: the large street photo did not load:", err?.message ?? err);
      });
    }
    return found;
  }

  /** The widest picture this browser draws (px): its GPU's limit, and less on a phone. */
  _limit() {
    const gl = this._gl;
    const max = (gl && Number(gl.getParameter(gl.MAX_TEXTURE_SIZE))) || 4096;
    return Math.min(max, coarsePointer() ? MAX_WIDTH_PHONE : MAX_WIDTH);
  }

  /** Whether there is a larger picture than the small one (`zoom`: the small one's, for Google's). */
  _hasLarger(zoom) {
    const photo = this.photo;
    if (photo.google) return googleTiles(photo, this._limit()).zoom > zoom;
    return !!photo.hd && photo.hd !== photo.sd;
  }

  async _loadLarge(signal) {
    if (!this._gl) return;
    const { image, restore } = await this._picture(this._limit(), signal, true);
    if (!this._gl || this._removed) {
      image.close?.();
      return;
    }
    this._restore = restore;
    this._uploadPhoto(image);
    image.close?.();
    this.large = true;
    this.render();
  }

  /**
   * A picture no wider than `limit`, and how to have it again (after a lost
   * context) from the bytes kept: Google's from its tiles, the others' the
   * small or large image. The large one is decoded at the size it is drawn
   * (the services say how large the picture is); a browser that ignores the
   * size asked for gets it scaled on a canvas: a texture wider than the
   * GPU's limit stays black.
   */
  async _picture(limit, signal, large) {
    const photo = this.photo;
    if (photo.google) {
      const plan = googleTiles(photo, limit);
      const blobs = await fetchTiles(plan, { fetch: this._fetch, signal });
      const draw = () => stitch(plan, blobs);
      return { image: await draw(), restore: draw, zoom: plan.zoom };
    }
    const blob = await this._get(large ? photo.hd : photo.sd, signal);
    const size = large && photo.width > limit ? { width: limit, height: limit / 2 } : null;
    const draw = async () => fitted(await decode(blob, size), large ? limit : Math.max(limit, MAX_WIDTH));
    return { image: await draw(), restore: draw, zoom: null };
  }

  async _get(url, signal) {
    const response = await this._fetch(url, fetchInit(this.photo.source, { signal, mode: "cors" }));
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.blob();
  }

  /** Look along bearing / pitch (90 the horizon) with a vertical field of view, as the street view's projector. */
  setView({ bearing = this.view.bearing, pitch = this.view.pitch, roll = this.view.roll ?? 0, fov = this.view.fov } = {}) {
    this.view = { bearing, pitch, roll, fov };
    this.render();
  }

  setEyeHeight() {}

  reseat() {
    return false;
  }

  resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round((this.container.clientWidth || 1) * dpr));
    const h = Math.max(1, Math.round((this.container.clientHeight || 1) * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.render();
  }

  /** The look for a Sun and Moon (the street view asks every scene for its own kind). */
  lookFor(sun, moon) {
    return photoLook(sun, moon);
  }

  setLook(look) {
    if (look?.key === this.look?.key) return;
    this.look = look;
    this.render();
  }

  /** The photo never takes long to draw: nothing to measure. */
  benchmark() {
    return Promise.resolve(0);
  }

  render() {
    const gl = this._gl;
    if (!gl || !this.found) return;
    const { width: W, height: H } = this.canvas;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const u = this._uniforms;
    gl.useProgram(this._program);
    const fov = this.view.fov;
    const f = H / 2 / Math.tan((fov * DEG) / 2);
    const world = rayToWorld(this.view);
    gl.uniformMatrix3fv(u.uRay, false, columns(multiply3(transpose3(this.rotation), world)));
    gl.uniform3f(u.uUp, world[6], world[7], world[8]);
    gl.uniform4f(u.uScreen, W / 2, H / 2, f, H);
    const look = this.look;
    gl.uniform1f(u.uExposure, look.exposure);
    gl.uniform1f(u.uDesaturate, look.desaturate);
    gl.uniform3f(u.uTint, ...look.tint);
    gl.uniform3f(u.uGround, ...look.ground);
    gl.uniform2f(u.uGroundFade, Math.sin(look.groundFrom * DEG), Math.sin(look.groundTo * DEG));
    const units = [this._tex.photo, this._tex.mask, this._tex.sky, this._tex.other];
    ["uPhoto", "uMask", "uSkyColour", "uOtherColour"].forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, units[i]);
      gl.uniform1i(u[name], i);
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  remove() {
    this._removed = true;
    this._abort?.abort();
    const gl = this._gl;
    this._gl = null;
    try {
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Already gone.
    }
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas.remove();
    this._restore = null;
    this._textures = null;
  }

  // -- WebGL --------------------------------------------------------------------

  _setupGl() {
    const gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return false;
    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`street photo shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`street photo program: ${gl.getProgramInfoLog(program)}`);
    this._gl = gl;
    this._program = program;
    this._uniforms = Object.fromEntries(
      ["uPhoto", "uMask", "uSkyColour", "uOtherColour", "uRay", "uUp", "uScreen", "uExposure", "uDesaturate", "uTint", "uGround", "uGroundFade"].map((n) => [n, gl.getUniformLocation(program, n)]),
    );
    this._anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
    // A vertex array is needed to draw, even with no attributes.
    gl.bindVertexArray(gl.createVertexArray());
    this._tex = { photo: gl.createTexture(), mask: gl.createTexture(), sky: gl.createTexture(), other: gl.createTexture() };
    return true;
  }

  /** Send everything to the GPU: after loading, and after a lost context comes back (the photo from its bytes). */
  _upload(bitmap = null) {
    const gl = this._gl;
    const t = this._textures;
    if (!gl || !t) return;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this._uploadData(this._tex.mask, gl.RGBA8, t.width, t.height, t.mask);
    this._uploadData(this._tex.sky, gl.SRGB8_ALPHA8, t.lowWidth, t.lowHeight, t.skyColour);
    this._uploadData(this._tex.other, gl.SRGB8_ALPHA8, t.lowWidth, t.lowHeight, t.otherColour);
    if (bitmap) {
      this._uploadPhoto(bitmap);
    } else if (this._restore) {
      // A context that came back: the picture again, from its bytes.
      this._restore()
        .then((b) => {
          if (this._gl === gl) {
            this._uploadPhoto(b);
            this.render();
          }
          b.close?.();
        })
        .catch(() => {});
    }
  }

  _uploadData(texture, format, width, height, data) {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _uploadPhoto(source) {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this._tex.photo);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ext = this._anisotropy;
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, clamp(gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT), 1, 8));
  }
}
