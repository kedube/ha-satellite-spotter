// A page for run.mjs: the real views, on a stand-in for Home Assistant with made-up passes.
const q = new URLSearchParams(location.search);
const V = "?v=browser-test";
const frontend = "/custom_components/satellite_spotter/frontend";
const mode = q.get("mode");

const HOME = { entry_id: "test", title: "Test City", latitude: 48.0, longitude: 11.0, elevation: 500 };
const OTHER = { entry_id: "other", title: "Other Town", latitude: -33.0, longitude: 151.0, elevation: 20 };
const now = Math.floor(Date.now() / 1000);

/** An orbit around the ISS's height, as ground rows [t, lat, lon, alt, lit]: smooth, and made up. */
function ground(from, to, step = 30) {
  const rows = [];
  for (let t = from; t <= to; t += step) {
    const phase = ((t - now) / 5574) * 2 * Math.PI;
    rows.push([t, 51.6 * Math.sin(phase), ((((t - now) / 5574) * 360 - 71 + 540) % 360) - 180, 420, 1]);
  }
  return rows;
}

/** A pass's rows, [t, lat, lon, alt, lit, az, el, range, mag, vis], rising in the west and setting in the east. */
function passRows(start, end) {
  const rows = [];
  for (let t = start - 120; t <= end + 120; t += 2) {
    const f = (t - start) / (end - start);
    const elevation = 60 * Math.sin(Math.PI * Math.min(1, Math.max(0, f)));
    rows.push([t, HOME.latitude - 8 + 16 * f, HOME.longitude - 10 + 20 * f, 420, 1, (250 + 140 * f) % 360, elevation, 800, 1, t >= start && t <= end ? 1 : 0]);
  }
  return rows;
}

const point = (azimuth, elevation, direction) => ({ azimuth, elevation, direction });
function pass(start, title, rating, ids = [25544]) {
  const end = start + 300;
  return {
    id: String(start),
    title,
    kind: "iss",
    start,
    end,
    duration: 300,
    magnitude: -1.5,
    bright: true,
    rating,
    sun_up: false,
    cloud_cover: 12,
    satellite_count: ids.length,
    train: null,
    peak: { time: start + 150, ...point(180, 60, "S") },
    transits: ids.map((norad_id, i) => ({
      norad_id,
      name: i ? `${title} ${i}` : title,
      kind: "iss",
      start,
      end,
      magnitude: -1.5,
      brightest_time: start + 150,
      rise: point(250, 12, "WSW"),
      brightest: point(180, 60, "S"),
      set: point(30, 11, "NNE"),
      peak: { time: start + 150, ...point(180, 60, "S") },
      start_reason: "rise",
      end_reason: "set",
      period_s: 5574,
      about_url: "https://en.wikipedia.org/wiki/International_Space_Station",
      confidence: "high",
    })),
  };
}
const passes = [pass(now + 1200, "ISS", "great"), pass(now + 7200, "Tiangong", "good"), pass(now + 90000, "Hubble", "fair")];
const detail = (p, id = p.id) => ({
  pass_id: id,
  step: 2,
  sun: [],
  transits: p.transits.map((t) => ({ norad_id: t.norad_id, name: t.name, kind: t.kind, horizon_rise: p.start - 120, horizon_set: p.end + 120, visible_start: p.start, visible_end: p.end, rows: passRows(p.start, p.end) })),
});
// What a new search changes, for a test to set: the passes, and how the integration answers for a path.
const search = { passes, at: now, failing: false, path: (msg) => detail(search.passes.find((p) => p.id === msg.pass_id) ?? passes[0]) };
const honestPath = search.path;
const ids = [25544, 48274, 20580];
const positions = () => {
  const start = Math.floor(Date.now() / 60000) * 60;
  return {
    start,
    step: 60,
    count: 11,
    catalog_version: 1,
    ids,
    pos: ids.map((_, i) => Array.from({ length: 11 }, (__, k) => [10 * i + k, 20 * i + k, 420]).flat()),
    lit: ids.map(() => "1".repeat(11)),
  };
};
const catalog = {
  updated: now,
  version: 1,
  satellites: ids.map((norad_id, i) => ({ norad_id, name: ["ISS", "Tiangong", "Hubble"][i], kind: ["iss", "tiangong", "hubble"][i], magnitude: 1, epoch: now, period_s: 5574, inclination: 51, about_url: "" })),
};

window.__asked = {};
const hass = {
  language: q.get("lang") || "en",
  locale: { language: q.get("lang") || "en", number_format: "language", time_format: "language", time_zone: "server" },
  config: { time_zone: "UTC", unit_system: { length: "km" }, country: "US", components: [], latitude: 1, longitude: 2 },
  themes: { darkMode: true },
  panels: {},
  connection: new EventTarget(),
  auth: {},
  hassUrl: (path = "") => location.origin + path,
  callService: async () => {},
  async callWS(msg) {
    window.__asked[msg.type] = (window.__asked[msg.type] ?? 0) + 1;
    switch (msg.type) {
      case "satellite_spotter/locations":
        return [{ entry_id: HOME.entry_id, title: HOME.title, show_in_sidebar: true }];
      case "satellite_spotter/passes":
        if (search.failing) throw { code: 3, message: "Connection lost" };
        await search.hold;
        return {
          generated_at: now,
          server_time: Date.now() / 1000,
          searched_at: search.at,
          paused: null,
          paused_days: null,
          paused_error: null,
          location: msg.entry_id === OTHER.entry_id ? OTHER : HOME,
          settings: { units: "auto", days: 5, min_elevation: 10 },
          catalog: { updated: now, version: 1, satellites: 3 },
          passes: search.passes,
        };
      case "satellite_spotter/pass_track":
        return search.path(msg);
      case "satellite_spotter/track":
        return { norad_id: msg.norad_id, step: msg.step, track: ground(Date.parse(msg.start) / 1000, Date.parse(msg.end) / 1000, msg.step) };
      case "satellite_spotter/positions":
        return positions();
      case "satellite_spotter/catalog":
        return catalog;
      case "satellite_spotter/street":
        return { source: q.get("source") || "auto", mapillary_token: null, google_api_key: null };
      default:
        throw { code: "unknown_command", message: msg.type };
    }
  },
};

const host = document.getElementById("host");

const views = {
  async globe() {
    await import(`${frontend}/sat-globe.js${V}`);
    const view = document.createElement("satellite-globe-view");
    view.config = { entry_id: HOME.entry_id, panel: true, imagery: "satellite", view: "home", show_passes: "list", show_satellites: true, street_view: true };
    view.hass = hass;
    host.append(view);
    window.__view = view;
  },
  async card() {
    await import(`${frontend}/sat-passes-card.js${V}`);
    const view = document.createElement("satellite-passes-view");
    view.config = { count: 5, show_chart: true };
    view.hass = hass;
    host.append(view);
    window.__view = view;
  },
  async panel() {
    await import(`${frontend}/sat-panel.js${V}`);
    const view = document.createElement("satellite-spotter-panel");
    view.hass = hass;
    view.narrow = false;
    view.panel = { config: {} };
    view.route = { prefix: location.pathname, path: "" };
    host.append(view);
    window.__view = view;
  },
  async street() {
    const [, clockModule, format, i18n] = await Promise.all([
      import(`${frontend}/sat-street.js${V}`),
      import(`${frontend}/sat-clock.js${V}`),
      import(`${frontend}/sat-format.js${V}`),
      import(`${frontend}/sat-i18n.js${V}`),
    ]);
    if (q.get("source") === "model") {
      // Drawn in software here, which is slow and says so: neither may take the 3D scene away.
      const { StreetScene } = await import(`${frontend}/sat-street-scene.js${V}`);
      StreetScene.prototype.benchmark = async () => 0;
      const { getContext } = HTMLCanvasElement.prototype;
      HTMLCanvasElement.prototype.getContext = function (kind, options) {
        return getContext.call(this, kind, options && { ...options, failIfMajorPerformanceCaveat: false });
      };
    }
    const shown = passes[0];
    const clock = new clockModule.PassClock();
    clock.simulate({ fromS: shown.start - 60, toS: shown.end + 60, visibleStartS: shown.start, visibleEndS: shown.end });
    const street = document.createElement("satellite-street-view");
    street.hass = hass;
    street.formatter = new format.Formatter(hass, i18n.english);
    street.location = HOME;
    street.units = "auto";
    street.clock = clock;
    street.globeToggle = false;
    street.pass = shown;
    street.detail = detail(shown);
    street.style.cssText = "position:absolute;inset:0;display:block";
    host.append(street);
    window.__view = street;
    street.open();
  },
  /** The atmosphere alone, on a bare globe: which limb the light makes glow. */
  async light() {
    const [{ loadMapLibre }, { sunLight }, { subsolarPoint }] = await Promise.all([
      import(`${frontend}/sat-maplibre.js${V}`),
      import(`${frontend}/sat-globe.js${V}`),
      import(`${frontend}/sat-geo.js${V}`),
    ]);
    const ml = await loadMapLibre();
    window.__limbs = (iso) =>
      new Promise((resolve) => {
        const date = new Date(iso);
        host.innerHTML = "";
        const map = new ml.Map({
          container: host,
          center: [subsolarPoint(date).lon, 0],
          zoom: 0.55,
          interactive: false,
          attributionControl: false,
          canvasContextAttributes: { preserveDrawingBuffer: true, antialias: false },
          style: {
            version: 8,
            projection: { type: "globe" },
            light: sunLight(date),
            sky: { "sky-color": "#000000", "horizon-color": "#000000", "fog-color": "#000000", "sky-horizon-blend": 0, "horizon-fog-blend": 0, "atmosphere-blend": 1 },
            sources: {},
            layers: [{ id: "bg", type: "background", paint: { "background-color": "#000000" } }],
          },
        });
        map.once("idle", () => {
          const canvas = map.getCanvas();
          const copy = document.createElement("canvas");
          copy.width = canvas.width;
          copy.height = canvas.height;
          const context = copy.getContext("2d");
          context.drawImage(canvas, 0, 0);
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          const middle = canvas.width >> 1;
          const peak = (from, to) => {
            let most = 0;
            for (let y = from; y < to; y++) {
              const i = (y * canvas.width + middle) * 4;
              most = Math.max(most, data[i] + data[i + 1] + data[i + 2]);
            }
            return most;
          };
          const limbs = { north: peak(0, canvas.height >> 1), south: peak(canvas.height >> 1, canvas.height) };
          map.remove();
          resolve(limbs);
        });
      });
  },
};

/**
 * What the 3D street view's camera comes to on the real MapLibre. Its code rests on what is measured
 * here, a private method among it, and a fake map can say nothing about that when MapLibre is updated.
 */
window.__streetCamera = async () => {
  const [{ makeProjector }, { EARTH_CIRCUMFERENCE, FAR_KM, NEAR_M, PX_PER_M, mercatorFromLngLat }] = await Promise.all([
    import(`${frontend}/sat-planetarium.js${V}`),
    import(`${frontend}/sat-street-scene.js${V}`),
  ]);
  const scene = window.__view._scene;
  if (window.__view._mode !== "3d") return { mode: window.__view._mode, degraded: [] };
  const { map } = scene;
  const transform = map._camera.transform;
  const place = transform.getCameraLngLat();
  const metersAcross = EARTH_CIRCUMFERENCE * Math.cos(scene.latitude * (Math.PI / 180));

  // A direction, a kilometer away, through MapLibre's own matrix and through the sky's projector.
  const canvas = map.getCanvas();
  const [width, height] = [canvas.clientWidth, canvas.clientHeight];
  const sky = makeProjector({ bearing: map.getBearing(), pitch: map.getPitch(), roll: map.getRoll(), fov: map.getVerticalFieldOfView(), width, height });
  const { worldSize } = transform;
  const eye = mercatorFromLngLat(scene.longitude, scene.latitude);
  const onScreen = (azimuth, elevation) => {
    const [a, e] = [azimuth * (Math.PI / 180), elevation * (Math.PI / 180)];
    const [east, north, up] = [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)].map((v) => v * 1000);
    const world = [(eye.x + east / metersAcross) * worldSize, (eye.y - north / metersAcross) * worldSize, scene.eyeAltitude + up, 1];
    const clip = [0, 1, 2, 3].map((row) => [0, 1, 2, 3].reduce((sum, column) => sum + transform.modelViewProjectionMatrix[column * 4 + row] * world[column], 0));
    return [((clip[0] / clip[3] + 1) / 2) * width, ((1 - clip[1] / clip[3]) / 2) * height];
  };
  const skyOffPx = Math.max(
    ...[[0, 5], [15, 20], [-20, 35]].map(([turn, elevation]) => {
      const azimuth = map.getBearing() + turn;
      const [x, y] = onScreen(azimuth, elevation);
      const [skyX, skyY] = sky.project(azimuth, elevation);
      return Math.hypot(x - skyX, y - skyY);
    }),
  );

  // The planes are set in pixels at the center, and have to outlast a move of the camera.
  const planes = () => [transform.nearZ / (NEAR_M * PX_PER_M), transform.farZ / (FAR_KM * 1000 * PX_PER_M)];
  const [near, far] = planes();
  map.jumpTo({ bearing: map.getBearing() + 1 });
  const [nearAfter, farAfter] = planes();
  scene.setView();

  return {
    mode: window.__view._mode,
    degraded: [...scene.degraded],
    tiles: scene._loaded.get("ofm") ?? 0,
    ground: scene.ground,
    terrain: map.queryTerrainElevation([scene.longitude, scene.latitude]),
    eyeOffM: Math.hypot((place.lng - scene.longitude) * (metersAcross / 360), (place.lat - scene.latitude) * (EARTH_CIRCUMFERENCE / 360)),
    altitudeOffM: transform.getCameraAltitude() - scene.eyeAltitude,
    worldSize,
    farPlane: scene.farPlane,
    near,
    far,
    nearAfter,
    farAfter,
    skyOffPx,
  };
};

/**
 * How big the real globe is near a pole, measured on screen in pixels per radian at the center of the view,
 * against the zoom limit of a camera riding with a satellite there, which has to agree with it.
 */
window.__globeNearThePole = async () => {
  const view = window.__view;
  const map = view._map;
  const zoom = 1.7;
  const measure = (latitude) =>
    new Promise((resolve) => {
      map.jumpTo({ center: [10, latitude], zoom, pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
      const center = map.getCenter();
      const [a, b] = [map.project([center.lng, center.lat]), map.project([center.lng, center.lat - 0.2])];
      resolve({
        latitude: center.lat,
        radiusPx: Math.hypot(a.x - b.x, a.y - b.y) / (0.2 * (Math.PI / 180)),
        limit: view._trackZoomLimit({ lat: latitude, alt: 420 }, 0),
      });
    });
  return { edge: await measure(85.051129), over: await measure(89), zoom };
};

/**
 * New predictions reaching the real globe and street view. They change a pass's id, and another pass can
 * start close by, so what these say is which pass is which then. Fake timers show the logic; this is the
 * page's real refresh, on a real map, with the real street view opening over it.
 */
/** The view with the passes in it: the panel keeps its globe in `_view`. */
const shownView = () => window.__view._view ?? window.__view;
const newSearch = async (list) => {
  search.passes = list;
  search.at += 1;
  await shownView()._refresh(true);
};
const wait = (ms) => new Promise((later) => setTimeout(later, ms));
const until = async (done) => {
  for (let i = 0; i < 400 && !done(); i++) await wait(50);
  return done();
};
const SOON = now + 7200;
const neighbor = pass(SOON - 100, "Neighbor", "good", [48274]);
window.__search = {
  /** Where the user's pick is after each search, in seconds from where it began. */
  async picks() {
    const view = window.__view;
    const pick = () => ({ off: Number(view._selectedId) - SOON, user: view._userSelected });
    const group = pass(SOON, "Group", "good", [25544, 20580]);
    await newSearch([neighbor, group]);
    await view._select(group.id);
    await newSearch([neighbor, pass(SOON + 5, "Group", "good", [25544, 20580])]);
    const movedALittle = pick();
    await newSearch([neighbor, pass(SOON + 305, "Group", "good", [20580, 25544])]);
    const movedFar = pick();
    const train = pass(SOON + 20000, "STARLINK-1 +2", "good", [1111, 2222, 3333]);
    await newSearch([neighbor, train]);
    await view._select(train.id);
    await newSearch([neighbor, pass(SOON + 20096, "CZ-3C R/B", "good", [2222]), pass(SOON + 20220, "STARLINK-1 +1", "good", [1111, 3333])]);
    const split = pick();
    await newSearch([neighbor, group]);
    await view._select(group.id);
    await newSearch([neighbor]);
    return { movedALittle, movedFar, split, gone: pick() };
  },
  /** The integration has moved on, and answers for a pass the page still shows with its neighbor's path. */
  async globePath() {
    const view = window.__view;
    const shown = pass(SOON, "Shown", "good");
    await newSearch([neighbor, shown]);
    await view._select(shown.id);
    await view._loadDetail(shown);
    view._details.clear();
    view._client.clear();
    search.path = () => detail(neighbor);
    const refused = (await view._loadDetail(shown)) === null && !view._details.has(shown.id);
    view._client.clear();
    search.path = () => detail(shown, String(shown.start + 5));
    const taken = !!(await view._loadDetail(shown)) && view._details.has(shown.id);
    search.path = honestPath;
    return { refused, taken };
  },
  /** The same, for a street view opened while it lasts: how many answers for a path it has had by then. */
  async openStreet() {
    const view = window.__view;
    const shown = pass(SOON, "Shown", "good");
    await newSearch([neighbor, shown]);
    await view._select(shown.id);
    await view._loadDetail(shown);
    view._details.clear();
    view._client.clear();
    search.path = () => detail(neighbor);
    const asked = window.__asked["satellite_spotter/pass_track"];
    await view._openStreet(shown, { user: true });
    return asked;
  },
  street() {
    const street = window.__view._street;
    return { tag: street?.tagName, pass: street?.pass?.id, satellites: street?.detail?.transits?.map((t) => t.norad_id) ?? null, drawn: !!street?._planetarium?.primary };
  },
  ownPath() {
    const shown = pass(SOON, "Shown", "good");
    window.__view._client.clear();
    search.path = () => detail(shown, String(shown.start + 5));
  },
  /** A path on its way when the street view moves on to another pass, and what its coming does then. */
  async latePath() {
    const view = window.__view;
    view._closeStreet({ silent: true });
    const first = pass(SOON, "First", "good");
    const second = pass(SOON + 3600, "Second", "good", [48274]);
    await newSearch([first, second]);
    let release = null;
    search.path = (msg) => (msg.pass_id === first.id ? new Promise((go) => (release = () => go(detail(first)))) : honestPath(msg));
    view._details.clear();
    view._client.clear();
    await view._select(first.id);
    await view._openStreet(first, { user: true });
    const asking = await until(() => release && view._street?._asking?.passId === first.id);
    await view._select(second.id, { view: "street" });
    const movedOn = view._street.pass.id === second.id;
    release?.();
    const arrived = await until(() => view._details.has(first.id));
    await wait(200);
    search.path = honestPath;
    return { asking: !!asking, movedOn, arrived, stayed: view._street.pass.id === second.id && view._selectedId === second.id };
  },
};

/** What is there to Tab to on the page but under the street view: nothing, while it covers the page. */
const tabStopsUnder = (view) =>
  [...view.shadowRoot.querySelectorAll("button, a[href], input, select, [tabindex='0']")].filter(
    (e) => !view._street?.contains(e) && !e.disabled && !e.closest("[inert]") && e.offsetParent !== null,
  ).length;
const loseContext = (canvas, restoreAfterMs) => {
  const lost = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")).getExtension("WEBGL_lose_context");
  lost.loseContext();
  if (restoreAfterMs !== undefined) setTimeout(() => lost.restoreContext(), restoreAfterMs);
};
const veilUp = (street) => !street._els.veil.hidden && !street._els.veil.classList.contains("gone");

/**
 * Situations staged over time, on the real page: a tap, a lost context, a new search, a page that
 * cannot use its storage. Each says what came of it, and run.mjs judges.
 */
window.__stage = {
  /** How often the map draws while `act` runs, and whether it is the globe that went on drawing. */
  async rendersDuring(act, ms) {
    const map = shownView()._map;
    let renders = 0;
    const counted = () => renders++;
    map.on("render", counted);
    act();
    for (let i = 0; i < 3; i++) map.triggerRepaint();
    await wait(ms);
    map.triggerRepaint();
    await wait(200);
    map.off("render", counted);
    return renders;
  },
  failedTiles: () => Object.values(shownView()._failedTiles).reduce((sum, tiles) => sum + tiles.size, 0),
  /** The globe's imagery as MapLibre holds it. */
  imageryTiles() {
    const held = shownView()._map.style.tileManagers.bluemarble._inViewTiles;
    const tiles = held.getAllIds().map((id) => held.getTileById(id));
    return { drawn: tiles.filter((t) => t.state === "loaded" && t.texture).length, failed: tiles.filter((t) => t.state === "errored").length, waiting: tiles.filter((t) => t.state === "loading").length };
  },

  // -- the street view on its own ------------------------------------------------------------
  /** A context lost and back within the wait. */
  async photoContext() {
    const street = window.__view;
    let restarts = 0;
    const restart = street._restartScene;
    street._restartScene = function () {
      restarts++;
      return restart.call(this);
    };
    const scene = street._scene;
    loseContext(scene._gl.canvas, 800);
    await wait(300);
    const veilWhileLost = veilUp(street);
    await wait(1900);
    street._restartScene = restart;
    return { veilWhileLost, veilAfter: veilUp(street), restarts, sameScene: street._scene === scene, mode: street._mode };
  },
  /** Closed in that wait: nothing throws, and it frees the scene. */
  async closeWhileWaiting() {
    const street = window.__view;
    loseContext(street._scene._gl.canvas, 300);
    await wait(500);
    let thrown = null;
    try {
      street.dispose();
    } catch (err) {
      thrown = String(err);
    }
    return { thrown, scene: !!street._scene };
  },
  /** The 3D scene: a new map comes, as MapLibre's own restored textures are stale. */
  async sceneContext() {
    const street = window.__view;
    const scene = street._scene;
    loseContext(scene.map.getCanvas(), 500);
    await until(() => street._scene && street._scene !== scene && street._mode === "3d" && street._scene._loaded.get("ofm") > 0);
    return { newScene: street._scene !== scene, mode: street._mode, tiles: street._scene?._loaded.get("ofm") ?? 0, veil: veilUp(street) };
  },

  // -- the globe, with a street view over it -------------------------------------------------
  /** Opened with its button in the keyboard's hand, from a page that may not use its storage. */
  async openStreetBlockedStorage() {
    const view = shownView();
    const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The document is sandboxed", "SecurityError");
      },
    });
    const shown = search.passes[1];
    await view._select(shown.id);
    view._els.streetBtn.focus();
    const outcome = await view._openStreet(shown, { user: true }).then(
      () => "opened",
      (err) => `refused: ${err?.message}`,
    );
    Object.defineProperty(globalThis, "localStorage", storage);
    return { outcome, street: !!view._street };
  },
  keyboard() {
    const view = shownView();
    const street = view._street;
    return {
      inStreet: view.shadowRoot.activeElement === street,
      focused: street?.shadowRoot.activeElement?.className ?? null,
      under: tabStopsUnder(view),
      bearing: street?._view.bearing,
    };
  },
  clockAndStreet() {
    const view = shownView();
    return { street: !!view._street, clock: view._clock.mode, map: !!view._map, loaded: !!view._loaded, message: view._els.loaderMsg.textContent, id: view._map?._mapId ?? null };
  },
  loseGlobe: (restoreAfterMs) => loseContext(shownView()._map.getCanvas(), restoreAfterMs),
  afterClosing() {
    const view = shownView();
    return { street: !!view._street, focused: view.shadowRoot.activeElement?.className ?? null, inert: view.shadowRoot.querySelectorAll("[inert]").length };
  },
  fullscreen() {
    const view = shownView();
    return {
      real: view.shadowRoot.fullscreenElement === view._wrap,
      pseudo: view._wrap.classList.contains("maplibregl-pseudo-fullscreen"),
      attribute: view.hasAttribute("fullscreen"),
      shrink: !!view._els.map.querySelector(".maplibregl-ctrl-shrink"),
      map: view._map,
    };
  },
  /** Where the browser has no fullscreen for it: MapLibre's fixed overlay instead. */
  pseudoFullscreen() {
    const view = shownView();
    view._wrap.requestFullscreen = undefined;
    view._wrap.webkitRequestFullscreen = undefined;
    view._els.map.querySelector(".maplibregl-ctrl-fullscreen").click();
  },
  /** Home Assistant's language changes with the street view open, and changes back. */
  async globeLanguage() {
    const view = shownView();
    const street = view._street;
    const words = () => ({ layers: street._els.layersBtn.getAttribute("aria-label"), backToLive: street._timebar?._els.liveLong.textContent, simulate: view._els.simBtn.textContent });
    view.hass = { ...hass, language: "fr", locale: { ...hass.locale, language: "fr" } };
    await until(() => words().layers !== "Layers");
    await wait(100);
    const french = words();
    view.hass = hass;
    await until(() => words().layers === "Layers");
    return { french, back: words() };
  },
  mapLoaded: () => !!shownView()._loaded,
  markMap() {
    window.__oldMap = shownView()._map;
  },
  mapIsNew: () => !!shownView()._loaded && shownView()._map !== window.__oldMap,

  // -- new predictions, and time -------------------------------------------------------------
  /** A live pass ends in the street view: the next is offered, and the offer taken. */
  async nextPass() {
    const view = shownView();
    const nowS = Math.floor(Date.now() / 1000);
    const ending = pass(nowS - 293, "Ending", "good");
    const coming = pass(nowS + 3600, "Coming", "good", [48274]);
    await newSearch([ending, coming]);
    await view._select(ending.id);
    await view._openStreet(ending, { user: true });
    const street = view._street;
    const live = street.clock.mode === "live";
    const offeredAt = await until(() => !street._els.next.hidden) && Date.now() / 1000 - ending.end;
    const offered = street._els.next.textContent;
    street._els.next.click();
    await until(() => street.pass?.id === coming.id);
    await wait(100);
    return { live, offered, offeredAt, now: street.pass?.id === coming.id, selected: view._selectedId === coming.id, hiddenAgain: street._els.next.hidden, mode: street.clock.mode };
  },
  /** The street view open on a pass that a new search moves: page and street view go on together. */
  async movedInStreet() {
    const view = shownView();
    view._closeStreet({ silent: true });
    view._stopSimulation({ silent: true });
    const first = pass(SOON, "First", "good");
    await newSearch([first]);
    await view._select(first.id);
    await view._openStreet(first, { user: true });
    await until(() => view._street?.detail);
    const moved = pass(SOON + 40, "First", "good");
    await newSearch([moved]);
    await until(() => view._street?.detail?.pass_id === moved.id);
    const street = view._street;
    return { wanted: moved.id, selected: view._selectedId, street: street?.pass?.id, path: street?.detail?.pass_id, visibleStart: view._clock.window?.visibleStartS === moved.start };
  },
  /** A replay whose pass goes from new predictions, then back to live. */
  async droppedInReplay() {
    const view = shownView();
    view._closeStreet({ silent: true });
    view._stopSimulation({ silent: true });
    const first = pass(SOON, "First", "good");
    const second = pass(SOON + 3600, "Second", "good", [48274]);
    await newSearch([first, second]);
    await view._select(first.id, { view: "simulate" });
    await until(() => view._clock.mode === "sim");
    await newSearch([second]);
    view._stopSimulation({ user: true });
    await wait(1300);
    return { label: view._els.label.textContent, clock: view._els.clock.textContent, selected: view._selectedId === second.id, user: view._userSelected };
  },
  /** A pick stays for a minute past its pass, and not until the next refresh. */
  async pickPastItsPass() {
    const view = shownView();
    const nowS = Math.floor(Date.now() / 1000);
    const over = pass(nowS - 300 - 59, "Over", "good");
    const next = pass(nowS + 3600, "Next", "good", [48274]);
    await newSearch([over, next]);
    await view._select(over.id);
    const stayed = view._selectedId === over.id && view._userSelected;
    await until(() => !view._userSelected);
    return { stayed, tookS: Date.now() / 1000 - nowS, selected: view._selectedId === next.id };
  },
  /** How many frames the globe asks for in two seconds, with a ring where it can be seen and where not. */
  async ringFrames() {
    const view = shownView();
    const nowS = Math.floor(Date.now() / 1000);
    // Two up at once: the one on show is drawn as a sprite, and the other has the ring.
    await newSearch([pass(nowS - 60, "Up now", "good"), pass(nowS - 50, "Also up", "good", [48274])]);
    await until(() => view._rings?.length > 0 && view._space?.animating);
    // Only the rings count here: not a satellite in sight that moves.
    view._screenSpeed = () => 0;
    const count = async () => {
      let frames = 0;
      const frame = view._frame;
      view._frame = function () {
        frames++;
        return frame.call(this);
      };
      await wait(2000);
      view._frame = frame;
      return frames;
    };
    const whereIs = view._cloud.whereIs;
    await wait(1100);
    const inSight = await count();
    const center = view._map.getCenter();
    view._cloud.whereIs = () => ({ lat: -center.lat, lon: center.lng > 0 ? center.lng - 180 : center.lng + 180 });
    await wait(1100);
    const behind = await count();
    view._cloud.whereIs = () => ({ lat: center.lat, lon: center.lng });
    const backInSight = view._ringsBreathing();
    view._cloud.whereIs = whereIs;
    delete view._screenSpeed;
    return { inSight, behind, backInSight };
  },
  /** Another location chosen, and its answer slow: nothing of the last one goes under its name meanwhile. */
  async switching() {
    const view = shownView();
    let release;
    search.hold = new Promise((go) => (release = go));
    const was = view._payload.location.entry_id;
    view.config = { ...view.config, entry_id: OTHER.entry_id };
    await wait(600);
    const state = () => ({ message: view._els.loader.hidden ? "" : view._els.loaderMsg.textContent, mission: view._els.mission.hidden, chart: view._els.skySide.hidden, listed: view._passes().length });
    const during = { data: was === view._payload.location.entry_id, ...state() };
    search.hold = null;
    release();
    await until(() => view._payload.location.entry_id === OTHER.entry_id);
    await wait(100);
    return { during, after: state() };
  },
  /** Refreshes failing for over ten minutes: what is said of the times shown, until one works. */
  async staleHint() {
    const view = shownView();
    const said = () => view.shadowRoot.textContent.includes("Not connected") || Boolean(view.shadowRoot.querySelector(".facts.stale:not([hidden])")) || [...view.shadowRoot.querySelectorAll(".conds .warn")].some((c) => c.textContent.includes("Not connected"));
    const render = () => (view._renderMission ? view._renderMission() : view._render());
    search.failing = true;
    await view._refresh(true);
    render();
    const atFirst = said();
    view._freshAtS -= 700;
    render();
    const later = said();
    search.failing = false;
    await view._refresh(true);
    render();
    return { atFirst, later, afterwards: said() };
  },
  /** The clock of the whole page moved, as if it were that late: a little before midnight, Home Assistant's. */
  async midnight() {
    const view = shownView();
    const real = Date.now;
    const day = 86400;
    const midnightS = (Math.floor(real() / 1000 / day) + 2) * day;
    const shift = (midnightS - 6) * 1000 - real();
    Date.now = () => real() + shift;
    const soon = pass(midnightS + 1800, "ISS", "great");
    await newSearch([soon, pass(midnightS + 90000, "Tiangong", "good", [48274])]);
    await view._select(soon.id);
    await wait(100);
    const heading = () => view._els.skySide.querySelector(".sub").textContent;
    const before = heading();
    await until(() => Date.now() / 1000 > midnightS + 1.5);
    await wait(100);
    const after = heading();
    Date.now = real;
    return { before, after };
  },

  // -- the panel and its address -------------------------------------------------------------
  address: () => location.search,
  panelState() {
    const view = shownView();
    return { search: location.search, selected: view._selectedId, street: view._street?.pass?.id ?? null, clock: view._clock.mode, entries: history.length, on: window.__view.isConnected };
  },
  ids: () => search.passes.map((p) => p.id),
  async openStreetHere(index) {
    const view = shownView();
    const shown = search.passes[index];
    await view._select(shown.id);
    await view._openStreet(shown, { user: true });
    await wait(200);
  },
  closeStreetHere() {
    shownView()._street._els.closeBtn.click();
  },
  /** Somewhere else, as Home Assistant goes: a new address, then "location-changed". */
  goTo(query) {
    history.pushState(null, "", `${location.pathname}?mode=panel&${query}`);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  },
  async movedPick() {
    const view = shownView();
    const picked = pass(SOON, "Picked", "good");
    await newSearch([picked]);
    await view._select(picked.id);
    await wait(50);
    const moved = pass(SOON + 300, "Picked", "good");
    await newSearch([moved]);
    await wait(50);
    return { wanted: moved.id, search: location.search };
  },
  async failedLink() {
    search.path = () => {
      throw { code: "unknown_pass", message: "No such pass" };
    };
    window.__stage.goTo("pass=123");
    await wait(300);
    search.path = honestPath;
    return location.search;
  },

  // -- the card ------------------------------------------------------------------------------
  async cardStreet() {
    const view = window.__view;
    view._open(view._hero.pass.id, "street");
    await until(() => view._street?.pass);
    await until(() => view._street.detail);
    const was = view._street.pass;
    const moved = pass(was.start + 40, was.title, "great");
    await newSearch([moved, ...search.passes.slice(1)]);
    await until(() => view._street.pass.id === moved.id && view._street.detail?.pass_id === moved.id);
    return { wanted: moved.id, street: view._street.pass.id, path: view._street.detail?.pass_id };
  },
  /** Home Assistant's language changes under the card, with its street view open. */
  async cardLanguage() {
    const view = window.__view;
    const street = view._street;
    const chart = () => [...view.shadowRoot.querySelectorAll(".chart text")].map((t) => t.textContent).join(" ");
    const was = chart();
    const german = { ...hass, language: "de", locale: { ...hass.locale, language: "de" } };
    view.hass = german;
    await until(() => street._els.layersBtn.getAttribute("aria-label") !== "Layers");
    await wait(100);
    return {
      forwarded: street.hass === german,
      chartWas: was,
      chart: chart(),
      layers: street._els.layersBtn.getAttribute("aria-label"),
      backToLive: street._timebar?._els.liveLong.textContent,
    };
  },
  /** A path on its way as new predictions arrive: the card asks again, and does not keep the old one. */
  async cardPathInFlight() {
    const view = window.__view;
    const [first] = search.passes;
    let release;
    const held = new Promise((go) => (release = go));
    view._client._passTracks.clear();
    view._detail = view._detailFor = null;
    search.path = () => held;
    view._render();
    await wait(100);
    // The same pass, on another way across the sky.
    const wanted = 123;
    search.path = () => {
      const fresh = detail(first);
      fresh.transits[0].rows[0][5] = wanted;
      return fresh;
    };
    await newSearch([...search.passes]);
    await wait(100);
    release(detail(first));
    await wait(300);
    search.path = honestPath;
    return { wanted, rows: view._detail?.transits[0].rows[0][5] };
  },

  // -- without WebGL -------------------------------------------------------------------------
  async withoutMap() {
    const view = shownView();
    const [, second, third] = search.passes;
    await view._select(second.id, { view: "simulate" });
    await until(() => view._clock.mode === "sim");
    const from = view._clock.simMs;
    await wait(1100);
    const moved = view._clock.simMs - from;
    view._stopSimulation({ user: true });
    await wait(100);
    view.selectPass(third.id);
    await until(() => view._selectedId === third.id);
    return { attribute: view.hasAttribute("no-map"), moved, selected: view._selectedId === third.id };
  },
  /** What the message over a page without its map runs into. */
  messageCovers() {
    const view = shownView();
    const message = view._els.loaderMsg.getBoundingClientRect();
    const hit = [...view.shadowRoot.querySelectorAll(".mission, .strip, .side, .plist, satellite-pass-list")].filter((e) => {
      if (e.offsetParent === null || !e.checkVisibility?.()) return false;
      const r = e.getBoundingClientRect();
      return r.width && r.height && r.left < message.right && r.right > message.left && r.top < message.bottom && r.bottom > message.top;
    });
    return { shown: message.width > 0, covers: hit.map((e) => e.className || e.tagName), text: view._els.loaderMsg.textContent, width: innerWidth };
  },
  /** Back on the page, with WebGL by then: the map comes, and the page is as it would be. */
  async webglBack() {
    window.__webglBack = true;
    const view = shownView();
    view.remove();
    host.append(view);
    await until(() => view._loaded);
    await wait(200);
    return { loaded: !!view._loaded, attribute: view.hasAttribute("no-map"), reload: !view._els.reloadBtn.hidden, frames: view._running };
  },
};

await views[mode]();
window.__ready = true;
