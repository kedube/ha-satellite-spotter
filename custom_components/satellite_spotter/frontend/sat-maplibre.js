/**
 * Loads the bundled MapLibre GL JS once per page, for the globe and the
 * street view alike. Importing this module starts the download: 1.1 MB, which
 * browsers are sent as 240 KB, and a map then asks for its worker, half that.
 */

// docs/updating-maplibre.md has the steps for a new version.
export const MAPLIBRE_DIR = new URL("./vendor/maplibre-gl-6.16.0/", import.meta.url);

let maplibrePromise;
let maplibreAttempt = 0;
export function loadMapLibre(load = (url) => import(url)) {
  // A failed import is not kept: the next start tries again under a new URL,
  // since browsers remember a failed module fetch for the rest of the page.
  maplibrePromise ??= load(new URL(`maplibre-gl.mjs${maplibreAttempt ? `?retry=${maplibreAttempt}` : ""}`, MAPLIBRE_DIR).href).catch((err) => {
    maplibrePromise = null;
    maplibreAttempt++;
    throw err;
  });
  return maplibrePromise;
}

/** Whether MapLibre keeps failing, so that reloading the page is worth offering. */
export function mapLibreNeedsReload() {
  return maplibreAttempt >= 3;
}

/** MapLibre's own button titles and labels, by their keys in our translations. */
export const MAPLIBRE_TEXT = {
  "AttributionControl.ToggleAttribution": "maplibre.attribution",
  "CooperativeGesturesHandler.MacHelpText": "maplibre.cmd_scroll",
  "CooperativeGesturesHandler.MobileHelpText": "maplibre.two_fingers",
  "CooperativeGesturesHandler.WindowsHelpText": "maplibre.ctrl_scroll",
  "FullscreenControl.Enter": "maplibre.fullscreen_enter",
  "FullscreenControl.Exit": "maplibre.fullscreen_exit",
  "Map.Title": "maplibre.map",
  "Marker.Title": "maplibre.marker",
  "NavigationControl.ResetBearing": "maplibre.reset_bearing",
  "NavigationControl.ZoomIn": "maplibre.zoom_in",
  "NavigationControl.ZoomOut": "maplibre.zoom_out",
};

/** The `locale` option for a new map, worded by t(key). */
export function mapLibreLocale(t) {
  return Object.fromEntries(Object.entries(MAPLIBRE_TEXT).map(([id, key]) => [id, t(key)]));
}

/** How many downloads have failed so far, for spacing out the retries. */
export function mapLibreAttempts() {
  return maplibreAttempt;
}

// Start the download now, alongside the modules that import this one, rather
// than after them. Errors surface when a globe or a street view starts.
if (globalThis.window && globalThis.document) {
  loadMapLibre().catch(() => {});
}
