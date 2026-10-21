// Passes shaped like the satellite_spotter/passes payload, and a Boston hass,
// for the pass list, panel and card tests. Not a test file: tests import it.

// Saturday 17 October 2026, 17:00 EDT (21:00 UTC).
export const BOSTON_NOW = Date.UTC(2026, 9, 17, 21) / 1000;

const AZIMUTH = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };

/** A hass as Home Assistant gives it to cards and panels, in Boston. */
export function bostonHass({ language = "en", timeFormat = "12", timeZone = "server", length = "mi", callWS } = {}) {
  return {
    language,
    locale: { language, time_format: timeFormat, number_format: "language", time_zone: timeZone },
    config: { time_zone: "America/New_York", unit_system: { length } },
    callWS,
  };
}

/** One pass; the members after the first satellite are optional. */
export function makePass({
  id, title, kind = "satellite", start, duration = 120, magnitude = 1.5, bright = false, before_sunset = false,
  elevation = 45, from = "SW", to = "NE", cloud = 20, train = false, count, members = [],
}) {
  const end = start + duration;
  const norad = Number(String(id).split("-")[0]);
  const name = title.replace(/ \+\d+$/, "");
  const look = (direction, el) => ({ azimuth: AZIMUTH[direction] ?? 0, elevation: el, direction });
  const peak = { time: start + Math.round(duration / 2), azimuth: 180, elevation, direction: "S" };
  const primary = {
    norad_id: norad, name, kind, start, end, magnitude, brightest_time: peak.time,
    rise: look(from, 10.5), brightest: look("S", elevation), set: look(to, 10.2), peak,
    start_reason: "rise", end_reason: "set", intrinsic_magnitude: magnitude, model: null, prediction: false,
    period_s: 5574, info_url: null, confidence: "high",
  };
  const transits = [primary, ...members.map((m, i) => ({ ...primary, ...m, start: start + 20 * (i + 1), end: end + 20 * (i + 1) }))];
  return {
    id, title, kind, start, end, duration, magnitude, bright, before_sunset, limiting_magnitude: 4, cloud_cover: cloud,
    satellite_count: count ?? transits.length, train, peak, transits,
  };
}
