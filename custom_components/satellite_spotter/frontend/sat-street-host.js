/**
 * What it takes to put a street view on a page, for whichever view hosts one (the globe, or the
 * passes card): so that they hand it the same things, and hear it the same way.
 */

// The street view's options, kept per browser by the street view itself (sat-street.js).
const STREET_STORAGE = "satellite-spotter:street";

/** The street view's options as it keeps them (only it writes them), to hand back to it. */
export function savedStreetOptions(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(STREET_STORAGE) || "null");
    if (saved && typeof saved === "object") return saved;
  } catch {
    // A private window, or blocked storage: its defaults.
  }
  return {};
}

/**
 * Make a street view, not yet on the page or opened (its module must have loaded).
 *
 * @param {object} o
 * @param {object} o.hass
 * @param {object} o.formatter
 * @param {object} o.location where it looks from
 * @param {string} o.units
 * @param {object} o.clock
 * @param {object} o.pass
 * @param {object|null} o.detail the pass's track, if it is in
 * @param {boolean} [o.globeToggle] whether its time bar offers a way back to a globe
 * @param {() => void} o.onClose
 * @param {(passId: string|undefined) => void} o.onNeedDetail it asks for a pass's track
 */
export function makeStreetView({ hass, formatter, location, units, clock, pass, detail, globeToggle, onClose, onNeedDetail }) {
  const street = document.createElement("satellite-street-view");
  street.hass = hass;
  street.formatter = formatter;
  street.location = location;
  street.units = units ?? "auto";
  street.clock = clock;
  street.options = savedStreetOptions();
  if (globeToggle !== undefined) street.globeToggle = globeToggle;
  street.pass = pass;
  street.detail = detail;
  street.addEventListener("close", onClose);
  street.addEventListener("need-detail", (ev) => onNeedDetail(ev.detail?.passId));
  return street;
}
