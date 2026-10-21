// A stand-in for sat-format.js's Formatter (not a test file itself), with the
// same methods and predictable output: times in UTC, English text from the
// real translation table. Tests that need the real Formatter import it.
import { english } from "../../../custom_components/satellite_spotter/frontend/sat-i18n.js";

const pad = (v) => String(v).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fakeFormatter(strings = english) {
  const calls = { time: 0 };
  const fmt = {
    calls,
    strings,
    update() {},
    setUnits() {},
    t: (key, vars) => strings.t(key, vars),
    html: (key, vars) => strings.html(key, vars),
    time(unixS, { seconds = false } = {}) {
      calls.time++;
      const d = new Date(unixS * 1000);
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ""}`;
    },
    date(unixS) {
      const d = new Date(unixS * 1000);
      return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    },
    dateTime(unixS) {
      return `${fmt.date(unixS)}, ${fmt.time(unixS)}`;
    },
    weekday: (unixS) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(unixS * 1000).getUTCDay()],
    relative(unixS, nowS) {
      const ms = (unixS - nowS) * 1000;
      if (Math.abs(ms) < 30000) return strings.t("time.now");
      return ms > 0 ? strings.t("time.in", { duration: strings.duration(ms) }) : strings.t("time.ago", { duration: strings.duration(-ms) });
    },
    countdown: (ms) => strings.countdown(ms),
    duration: (seconds) => strings.duration(seconds * 1000),
    num: (value, digits = 0) => Number(value).toFixed(digits),
    magnitude: (m) => `${m < 0 ? "−" : ""}${Math.abs(m).toFixed(1)}`,
    brightness(m) {
      const level = m < -2 ? 4 : m < 0 ? 3 : m < 1.5 ? 2 : m < 2.5 ? 1 : 0;
      return { word: ["faint", "easy to see", "bright", "very bright", "dazzling"][level], level };
    },
    direction: (abbrev) => strings.direction(abbrev),
    distance: (km) => `${Math.round(km)} km`,
    speed: (kmPerS) => `${Math.round(kmPerS * 3600)} km/h`,
    altitude: (km) => `${Math.round(km)} km`,
    cloud(pct) {
      if (pct === null || pct === undefined) return null;
      return { text: `${Math.round(pct)}%`, level: pct <= 20 ? "clear" : pct <= 60 ? "partly" : "cloudy" };
    },
    group(unixS) {
      const d = new Date(unixS * 1000);
      return { key: `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`, label: fmt.weekday(unixS), sub: fmt.date(unixS) };
    },
  };
  return fmt;
}
