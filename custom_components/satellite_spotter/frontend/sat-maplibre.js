/**
 * Loads the bundled MapLibre GL JS once per page, for the globe and the
 * street view alike. Importing this module starts the 1 MB download.
 */

export const MAPLIBRE_DIR = new URL("./vendor/maplibre-gl-6.11.2/", import.meta.url);

let maplibrePromise;
let maplibreAttempt = 0;
// MapLibre's entry module imports its shared chunk from a fixed URL. A retry
// can ask for the entry under a new URL but not the chunk, so once the chunk
// has failed, only reloading the page brings it back.
let maplibreChunkFailed = false;
export function loadMapLibre(load = (url) => import(url)) {
  // A failed import is not kept: the next start tries again under a new URL,
  // since browsers remember a failed module fetch for the rest of the page.
  // The chunk is asked for alongside the entry module rather than after it.
  maplibrePromise ??= Promise.allSettled([
    load(new URL(`maplibre-gl.mjs${maplibreAttempt ? `?retry=${maplibreAttempt}` : ""}`, MAPLIBRE_DIR).href),
    load(new URL("maplibre-gl-shared.mjs", MAPLIBRE_DIR).href),
  ])
    .then(([entry, chunk]) => {
      if (chunk.status === "rejected") maplibreChunkFailed = true;
      if (entry.status === "rejected") throw entry.reason;
      return entry.value;
    })
    .catch((err) => {
      maplibrePromise = null;
      maplibreAttempt++;
      throw err;
    });
  return maplibrePromise;
}

/** Whether MapLibre has failed in a way that only reloading the page can fix. */
export function mapLibreNeedsReload() {
  return maplibreChunkFailed || maplibreAttempt >= 3;
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
