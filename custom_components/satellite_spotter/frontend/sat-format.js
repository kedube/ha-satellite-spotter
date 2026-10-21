/**
 * Times, dates, numbers, units and the words around them, shown the way Home
 * Assistant shows them: in its language, with its 12 or 24-hour clock, its
 * number format and its time zone setting (the server's or the browser's).
 *
 * One Formatter is shared by the pass list, the cards, the globe and the
 * street view, so a pass reads the same everywhere. All text comes from the
 * translations (sat-i18n.js); apart from Intl it is pure, and unit tested in
 * node: node --test "tests/js/*.test.mjs"
 */

const VERSION = new URL(import.meta.url).search;
// Its English is read when a Formatter is made, not here: a page or test that
// imports this module and sat-i18n.js side by side can get sat-i18n.js's
// exports while its own top-level await is still loading them.
const i18n = await import(`./sat-i18n.js${VERSION}`);

const MINUS = "−";
const KM_PER_MILE = 1.609344;

/** Brightness words by level, faintest first (keys in the "brightness" group). */
const BRIGHTNESS = ["faint", "easy", "bright", "very_bright", "dazzling"];
/** Kinds of object the integration tells apart (keys in the "kinds" group). */
const KINDS = new Set(["iss", "tiangong", "hubble", "starlink", "rocket", "debris", "satellite"]);

/** Whether to show a 12-hour clock, decided the way Home Assistant decides it. */
export function uses12Hour(locale) {
  const format = locale?.time_format;
  if (format === "12") return true;
  if (format === "24") return false;
  const language = format === "system" ? undefined : locale?.language;
  try {
    return new Date("January 1, 2023 22:00:00").toLocaleString(language).includes("10");
  } catch {
    return false;
  }
}

/** Locales and options for Intl.NumberFormat that follow Home Assistant's number format setting. */
export function numberLocale(locale) {
  switch (locale?.number_format) {
    case "comma_decimal":
      return [["en-US", "en"], {}];
    case "decimal_comma":
      return [["de", "es", "it"], {}];
    case "space_comma":
      return [["fr", "sv", "cs"], {}];
    case "quote_decimal":
      return [["de-CH"], {}];
    case "system":
      return [undefined, {}];
    case "none":
      return [["en-US"], { useGrouping: false }];
    default:
      return [locale?.language, {}];
  }
}

/**
 * The time zone Home Assistant shows times in: the browser's when the user
 * chose local time, else the server's (as its frontend's resolveTimeZone).
 * Undefined means the browser's.
 */
export function timeZoneOf(hass) {
  return hass?.locale?.time_zone === "local" ? undefined : hass?.config?.time_zone || undefined;
}

// Intl throws for an unknown time zone or language; fall back to the browser's.
function dateFormat(language, options) {
  for (const [lang, opts] of [
    [language, options],
    [language, { ...options, timeZone: undefined }],
    [undefined, { ...options, timeZone: undefined }],
  ]) {
    try {
      return new Intl.DateTimeFormat(lang, opts);
    } catch {
      // Try the next, plainer one.
    }
  }
  return new Intl.DateTimeFormat();
}

function numberFormat(locales, options) {
  try {
    return new Intl.NumberFormat(locales, options);
  } catch {
    return new Intl.NumberFormat(undefined, options);
  }
}

const isTime = (unixS) => typeof unixS === "number" && Number.isFinite(unixS);
const pad = (n) => String(n).padStart(2, "0");

export class Formatter {
  /**
   * @param {object} hass Home Assistant's hass object (locale, language, config)
   * @param {import("./sat-i18n.js").Strings} [strings] the text; English until given
   */
  constructor(hass, strings) {
    this._dates = new Map();
    this._numbers = new Map();
    this._units = "auto";
    this.strings = i18n.english;
    this.update(hass, strings);
  }

  /**
   * Take a new hass and, when it changed, new text. Cheap enough to call on
   * every hass update: the cached Intl formats are rebuilt only when the
   * locale, language or time zone changed (Home Assistant replaces the locale
   * object only when a setting changes).
   */
  update(hass, strings) {
    const old = this._hass;
    if (
      !old ||
      hass?.locale !== old.locale ||
      hass?.language !== old.language ||
      hass?.config?.time_zone !== old.config?.time_zone
    ) {
      this._dates.clear();
      this._numbers.clear();
    }
    this._hass = hass;
    if (strings) this.strings = strings;
  }

  /** The location's Units option from the passes payload: "auto", "metric" or "imperial". */
  setUnits(units) {
    this._units = units || "auto";
  }

  /** Miles rather than kilometres: the Units option, or Home Assistant's unit system on "auto". */
  get imperial() {
    if (this._units === "metric" || this._units === "imperial") return this._units === "imperial";
    return this._hass?.config?.unit_system?.length === "mi";
  }

  /** The IANA time zone times are shown in; undefined for the browser's. */
  get timeZone() {
    return timeZoneOf(this._hass);
  }

  get language() {
    return this._hass?.locale?.language || this._hass?.language || undefined;
  }

  /**
   * The language a word that goes into the text is written in: the user's,
   * unless the text is in another (English standing in for a language
   * without a translation, or for one still downloading). Dates, times and
   * numbers on their own stay in the user's.
   */
  get _textLanguage() {
    const text = this.strings?.language;
    const base = (code) => String(code ?? "").split(/[-_]/)[0].toLowerCase();
    return text && base(text) !== base(this.language) ? text : this.language;
  }

  // ---- Text -----------------------------------------------------------------

  /** The text for a key, with its {placeholders} filled in. */
  t(key, vars) {
    return this.strings.t(key, vars);
  }

  /** The same as HTML: the template is escaped, the values are not (escape them first). */
  html(key, vars) {
    return this.strings.html(key, vars);
  }

  /** A list of names, such as the sky chart's cardinals. */
  list(key) {
    return this.strings.list(key);
  }

  // ---- Times and dates --------------------------------------------------------

  _date(options, unixS, language = this.language) {
    if (!isTime(unixS)) return "";
    const key = `${language ?? ""} ${JSON.stringify(options)}`;
    let f = this._dates.get(key);
    if (!f) {
      const opts = { ...options, timeZone: this.timeZone };
      if (opts.hour) opts.hourCycle = uses12Hour(this._hass?.locale) ? "h12" : "h23";
      f = dateFormat(language, opts);
      this._dates.set(key, f);
    }
    return f.format(new Date(unixS * 1000));
  }

  /** "8:41 PM" or "20:41"; with seconds "8:41:13 PM" or "20:41:13". */
  time(unixS, { seconds = false } = {}) {
    return this._date(seconds ? { hour: "numeric", minute: "2-digit", second: "2-digit" } : { hour: "numeric", minute: "2-digit" }, unixS);
  }

  /**
   * A time on the hour, as briefly as the clock allows: "6 AM" with a 12-hour
   * clock, "06:00" with a 24-hour one (a time zone half an hour off keeps its
   * minutes: "6:30 AM"). For the hour a cloud forecast is for.
   */
  hour(unixS) {
    if (!isTime(unixS)) return "";
    if (uses12Hour(this._hass?.locale) && this._parts(unixS).minute === 0) return this._date({ hour: "numeric" }, unixS);
    return this.time(unixS);
  }

  /** "Fri, Oct 16". */
  date(unixS) {
    return this._date({ weekday: "short", month: "short", day: "numeric" }, unixS);
  }

  /** "Fri, Oct 16, 8:41 PM". */
  dateTime(unixS) {
    return this._date({ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }, unixS);
  }

  /**
   * "Friday", for the headings ("Friday evening"): in the language of their
   * text, so a language without a translation does not read "pátek evening".
   */
  weekday(unixS) {
    return this._date({ weekday: "long" }, unixS, this._textLanguage);
  }

  /** Calendar date, hour and minute in the shown time zone, as numbers. */
  _parts(unixS) {
    let f = this._dates.get("parts");
    if (!f) {
      f = dateFormat("en-US", {
        timeZone: this.timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric",
        minute: "numeric",
      });
      this._dates.set("parts", f);
    }
    const parts = {};
    for (const { type, value } of f.formatToParts(new Date(unixS * 1000))) parts[type] = Number(value);
    // Some engines still say 24 for midnight.
    return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
  }

  /** "in 2 h 14 min", "now" or "5 min ago". */
  relative(unixS, nowS) {
    const diff = unixS - nowS;
    if (!Number.isFinite(diff)) return "";
    if (Math.abs(diff) < 30) return this.t("time.now");
    const duration = this.strings.duration(Math.abs(diff) * 1000);
    return this.t(diff > 0 ? "time.in" : "time.ago", { duration });
  }

  /** "1d 07:42:13", "07:42:13" or "42:13". */
  countdown(ms) {
    return this.strings.countdown(ms);
  }

  /** How long a pass lasts: "45 s", "6 min", "1 h 3 min". */
  duration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return this.t("time.seconds", { seconds: s });
    return this.strings.duration(s * 1000);
  }

  /**
   * Which part of which day a time falls in, for the pass list's headings:
   * morning [0, 12 h), afternoon [12, 17 h) and evening [17, 24 h) in the shown
   * time zone. Calendar days are compared, so a day with a clock change counts
   * as one day like any other.
   * @returns {{key: string, label: string, sub: string}} label "Tonight", "Tomorrow morning",
   *   "Monday evening"…; sub the date, "Sat, Oct 17"; key unique per period
   */
  group(unixS, nowS) {
    if (!isTime(unixS) || !isTime(nowS)) return { key: "", label: "", sub: "" };
    const at = this._parts(unixS);
    const today = this._parts(nowS);
    const days = Math.round((Date.UTC(at.year, at.month - 1, at.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86400000);
    const period = at.hour < 12 ? "morning" : at.hour < 17 ? "afternoon" : "evening";
    let label;
    if (days === 0) label = this.t(period === "evening" ? "time.tonight" : `time.this_${period}`);
    else if (days === 1) label = this.t(`time.tomorrow_${period}`);
    else if (days === -1) label = this.t(period === "evening" ? "time.last_night" : `time.yesterday_${period}`);
    else label = this.t(`time.weekday_${period}`, { weekday: this.weekday(unixS) });
    return { key: `${at.year}-${pad(at.month)}-${pad(at.day)}-${period}`, label, sub: this.date(unixS) };
  }

  // ---- Numbers and units ------------------------------------------------------------

  _number(key, options) {
    let f = this._numbers.get(key);
    if (!f) {
      const [locales, extra] = numberLocale(this._hass?.locale);
      f = numberFormat(locales, { ...options, ...extra });
      this._numbers.set(key, f);
    }
    return f;
  }

  /** A number in the user's number format, with a fixed number of decimals. */
  num(value, digits = 0) {
    if (!Number.isFinite(value)) return "";
    return this._number(`n${digits}`, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  }

  /** A magnitude with one decimal and a true minus sign: "−3.4", "0.0", "2.5". */
  magnitude(m) {
    if (!Number.isFinite(m)) return "";
    const rounded = Math.round(m * 10) / 10 + 0; // + 0: never "−0.0"
    return (rounded < 0 ? MINUS : "") + this.num(Math.abs(rounded), 1);
  }

  /**
   * How bright a magnitude looks, in words, with a level 0 (faint) to 4 for
   * the five-bar meter: below −2 dazzling, below 0 very bright, below 1.5
   * bright, below 2.5 easy to see, else faint.
   */
  brightness(m) {
    const level = !Number.isFinite(m) ? 0 : m < -2 ? 4 : m < 0 ? 3 : m < 1.5 ? 2 : m < 2.5 ? 1 : 0;
    return { level, word: this.t(`brightness.${BRIGHTNESS[level]}`) };
  }

  /** A compass point as the integration names it ("SSW"), in the user's language. */
  direction(abbrev) {
    return this.strings.direction(abbrev);
  }

  /** "67°". */
  degrees(value) {
    return Number.isFinite(value) ? `${this.num(Math.round(value))}°` : "";
  }

  _unit(value, unit) {
    const f = this._number(`u-${unit}`, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 0 });
    return f.format(Math.round(value));
  }

  /** A distance in km or miles: "1,234 km", "767 mi". */
  distance(km) {
    if (!Number.isFinite(km)) return "";
    return this.imperial ? this._unit(km / KM_PER_MILE, "mile") : this._unit(km, "kilometer");
  }

  /** An altitude above the ground, in km or miles. */
  altitude(km) {
    return this.distance(km);
  }

  /** A speed given in km/s, shown in km/h or mph: "27,563 km/h". */
  speed(kmPerS) {
    if (!Number.isFinite(kmPerS)) return "";
    const kmh = kmPerS * 3600;
    return this.imperial ? this._unit(kmh / KM_PER_MILE, "mile-per-hour") : this._unit(kmh, "kilometer-per-hour");
  }

  /** A fraction as a whole percentage in the user's number format: 0.78 → "78%". */
  percent(fraction) {
    if (!Number.isFinite(fraction)) return "";
    return this._number("pct", { style: "percent", maximumFractionDigits: 0 }).format(fraction);
  }

  /**
   * Forecast cloud cover: {text: "37%", level: "clear" | "partly" | "cloudy", word}
   * (up to 20 % clear, up to 60 % partly cloudy); null when there is no forecast.
   */
  cloud(pct) {
    if (pct == null || pct === "" || !Number.isFinite(Number(pct))) return null;
    const value = Math.min(100, Math.max(0, Math.round(Number(pct))));
    const level = value <= 20 ? "clear" : value <= 60 ? "partly" : "cloudy";
    return { text: this.percent(value / 100), level, word: this.t(`passes.cloud_${level}`) };
  }

  // ---- Satellites -------------------------------------------------------------

  /** What kind of object a satellite is, in words: "Space station", "Rocket body"… */
  kind(kind) {
    return this.t(`kinds.${KINDS.has(kind) ? kind : "satellite"}`);
  }

  /** A pass's name: its title ("ISS", "Hubble +1"), or "Starlink train · 22" for a train. */
  passTitle(pass) {
    if (!pass) return "";
    if (pass.train) return this.t("passes.train_title", { count: pass.satellite_count ?? pass.transits?.length ?? 0 });
    return pass.title ?? pass.transits?.[0]?.name ?? "";
  }
}
