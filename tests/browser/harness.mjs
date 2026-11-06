// A page for run.mjs: the real views, on a stand-in for Home Assistant with made-up passes.
const q = new URLSearchParams(location.search);
const V = "?v=browser-test";
const frontend = "/custom_components/satellite_spotter/frontend";
const mode = q.get("mode");

const HOME = { entry_id: "test", title: "Test City", latitude: 48.0, longitude: 11.0, elevation: 500 };
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
function pass(start, title, rating) {
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
    satellite_count: 1,
    starlink_count: 0,
    train: false,
    peak: { time: start + 150, ...point(180, 60, "S") },
    transits: [
      {
        norad_id: 25544,
        name: title,
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
      },
    ],
  };
}
const passes = [pass(now + 1200, "ISS", "great"), pass(now + 7200, "Tiangong", "good"), pass(now + 90000, "Hubble", "fair")];
const detail = (p) => ({
  pass_id: p.id,
  step: 2,
  sun: [],
  transits: [{ norad_id: 25544, name: p.title, kind: "iss", horizon_rise: p.start - 120, horizon_set: p.end + 120, visible_start: p.start, visible_end: p.end, rows: passRows(p.start, p.end) }],
});
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
        return {
          generated_at: now,
          server_time: Date.now() / 1000,
          searched_at: now,
          paused: null,
          paused_days: null,
          paused_error: null,
          location: HOME,
          settings: { units: "auto", days: 5, min_elevation: 10, pass_id_tolerance: 120 },
          catalog: { updated: now, version: 1, satellites: 3 },
          passes,
        };
      case "satellite_spotter/pass_track":
        return detail(passes.find((p) => p.id === msg.pass_id) ?? passes[0]);
      case "satellite_spotter/track":
        return { norad_id: msg.norad_id, step: msg.step, track: ground(Date.parse(msg.start) / 1000, Date.parse(msg.end) / 1000, msg.step) };
      case "satellite_spotter/positions":
        return positions();
      case "satellite_spotter/catalog":
        return catalog;
      case "satellite_spotter/street":
        return { source: "auto", mapillary_token: null, google_api_key: null };
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

await views[mode]();
window.__ready = true;
