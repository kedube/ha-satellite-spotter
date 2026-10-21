// Tests for the shared Formatter (times, dates, numbers, units and the words
// around them): node --test "tests/js/*.test.mjs"
// The browser's time zone is Tokyo, so "local time" differs from every server
// time zone used here.
process.env.TZ = "Asia/Tokyo";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  Formatter,
  numberLocale,
  timeZoneOf,
  uses12Hour,
} from "../../custom_components/satellite_spotter/frontend/sat-format.js";
import { Strings, english } from "../../custom_components/satellite_spotter/frontend/sat-i18n.js";

const TRANSLATIONS = new URL("../../custom_components/satellite_spotter/frontend/translations/", import.meta.url);
const translation = (lang) => JSON.parse(readFileSync(new URL(`${lang}.json`, TRANSLATIONS), "utf8"));

// Intl puts no-break spaces in some formats ("5:00 PM", "37 %"); compare with plain ones.
const plain = (text) => text.replace(/[  ]/g, " ");

/** A hass as Home Assistant hands it to cards and panels. */
function hass({
  language = "en", timeFormat = "language", numberFormat = "language", timeZone = "server",
  serverZone = "America/New_York", length = "km",
} = {}) {
  return {
    language,
    locale: { language, time_format: timeFormat, number_format: numberFormat, time_zone: timeZone },
    config: { time_zone: serverZone, unit_system: { length } },
  };
}

// 2026-10-17T21:00:00Z: Saturday 17:00 in Boston, 23:00 in Veenendaal.
const NOW = Date.UTC(2026, 9, 17, 21) / 1000;
const H = 3600;

test("times follow Home Assistant's 12 or 24-hour setting", () => {
  assert.equal(plain(new Formatter(hass({ timeFormat: "12" }), english).time(NOW)), "5:00 PM");
  assert.equal(new Formatter(hass({ timeFormat: "24" }), english).time(NOW), "17:00");
  assert.equal(plain(new Formatter(hass({ timeFormat: "12" }), english).time(NOW + 13, { seconds: true })), "5:00:13 PM");
  assert.equal(new Formatter(hass({ timeFormat: "24" }), english).time(NOW + 13, { seconds: true }), "17:00:13");
  // "Use the language's format": American English has a 12-hour clock, British a 24-hour one.
  assert.equal(plain(new Formatter(hass({ language: "en" }), english).time(NOW)), "5:00 PM");
  assert.equal(new Formatter(hass({ language: "en-GB" }), english).time(NOW), "17:00");
  assert.equal(new Formatter(hass({ language: "de" }), english).time(NOW), "17:00");
  assert.equal(uses12Hour({ time_format: "12" }), true);
  assert.equal(uses12Hour({ time_format: "24", language: "en" }), false);
  assert.equal(uses12Hour({ time_format: "language", language: "nl" }), false);
});

test("times are shown in the server's time zone or the browser's, as the user chose", () => {
  const server = new Formatter(hass({ timeFormat: "24", serverZone: "Europe/Amsterdam" }), english);
  assert.equal(server.time(NOW), "23:00");
  assert.equal(server.timeZone, "Europe/Amsterdam");
  const local = new Formatter(hass({ timeFormat: "24", timeZone: "local", serverZone: "Europe/Amsterdam" }), english);
  assert.equal(local.timeZone, undefined, "the browser's (Tokyo)");
  assert.match(local.time(NOW), /^0?6:00$/);
  // Home Assistant uses the server's zone unless the user chose local time.
  assert.equal(timeZoneOf({ config: { time_zone: "Europe/Oslo" } }), "Europe/Oslo");
  assert.equal(timeZoneOf({ locale: { time_zone: "local" }, config: { time_zone: "Europe/Oslo" } }), undefined);
  assert.equal(timeZoneOf(undefined), undefined);
  // A time zone the browser does not know shows the browser's own, rather than nothing.
  const odd = new Formatter(hass({ timeFormat: "24", serverZone: "Mars/Olympus_Mons" }), english);
  assert.match(odd.time(NOW), /^0?6:00$/);
});

test("dates read as Home Assistant's language writes them", () => {
  const fmt = new Formatter(hass({ timeFormat: "12" }), english);
  assert.equal(fmt.date(NOW), "Sat, Oct 17");
  assert.equal(plain(fmt.dateTime(NOW)), "Sat, Oct 17, 5:00 PM");
  assert.equal(fmt.weekday(NOW), "Saturday");
  const de = new Formatter(hass({ language: "de" }), new Strings("de", translation("de")));
  assert.equal(de.date(NOW), "Sa., 17. Okt.");
  assert.equal(de.weekday(NOW + 2 * 86400), "Montag");
  assert.equal(de.dateTime(NOW), "Sa., 17. Okt., 17:00");
  // Nothing to show is shown as nothing, never as "Invalid Date" or an exception.
  assert.equal(fmt.time(undefined), "");
  assert.equal(fmt.date(Number.NaN), "");
  assert.equal(fmt.weekday(null), "");
});

test("relative times, countdowns and durations", () => {
  const fmt = new Formatter(hass(), english);
  assert.equal(fmt.relative(NOW + 2 * H + 14 * 60, NOW), "in 2 h 14 min");
  assert.equal(fmt.relative(NOW + 20, NOW), "now");
  assert.equal(fmt.relative(NOW - 5 * 60, NOW), "5 min ago");
  assert.equal(fmt.relative(NOW + 26 * H, NOW), "in 1 d 2 h");
  assert.equal(fmt.relative(NOW, undefined), "");
  assert.equal(fmt.countdown(93_784_000), "1d 02:03:04");
  assert.equal(fmt.countdown(3_723_000), "01:02:03");
  assert.equal(fmt.countdown(83_000), "01:23");
  assert.equal(fmt.countdown(-5000), "00:00");
  assert.equal(fmt.duration(45), "45 s");
  assert.equal(fmt.duration(59.6), "1 min");
  assert.equal(fmt.duration(360), "6 min");
  assert.equal(fmt.duration(3780), "1 h 3 min");
  assert.equal(fmt.duration(7200), "2 h");
  assert.equal(fmt.duration(0), "0 s");
  assert.equal(fmt.duration(undefined), "0 s");
});

test("numbers follow Home Assistant's number format", () => {
  const num = (numberFormat, value, digits) => plain(new Formatter(hass({ numberFormat }), english).num(value, digits));
  assert.equal(num("comma_decimal", 1234.5, 1), "1,234.5");
  assert.equal(num("decimal_comma", 1234.5, 1), "1.234,5");
  assert.equal(num("space_comma", 1234.5, 1), "1 234,5");
  assert.equal(num("none", 1234.5, 1), "1234.5");
  assert.equal(num("language", 1234.5, 0), "1,235");
  assert.equal(plain(new Formatter(hass({ language: "de" }), english).num(1234.5, 1)), "1.234,5");
  assert.equal(new Formatter(hass(), english).num(Number.NaN), "");
  assert.deepEqual(numberLocale({ number_format: "none" }), [["en-US"], { useGrouping: false }]);
  assert.deepEqual(numberLocale({ number_format: "language", language: "sv" }), ["sv", {}]);
});

test("magnitudes have one decimal and a true minus sign", () => {
  const fmt = new Formatter(hass(), english);
  assert.equal(fmt.magnitude(-3.44), "−3.4");
  assert.equal(fmt.magnitude(-2), "−2.0");
  assert.equal(fmt.magnitude(2.5), "2.5");
  assert.equal(fmt.magnitude(-0.04), "0.0", "never minus zero");
  assert.equal(fmt.magnitude(0), "0.0");
  assert.equal(fmt.magnitude(null), "");
  assert.equal(new Formatter(hass({ numberFormat: "decimal_comma" }), english).magnitude(-3.4), "−3,4");
  // Swedish writes its own minus sign; there is still exactly one.
  assert.equal(new Formatter(hass({ language: "sv" }), english).magnitude(-1.2), "−1,2");
});

test("brightness words and levels for the meter", () => {
  const fmt = new Formatter(hass(), english);
  const level = (m) => fmt.brightness(m).level;
  assert.deepEqual(fmt.brightness(-3.4), { level: 4, word: "dazzling" });
  assert.deepEqual(fmt.brightness(-1), { level: 3, word: "very bright" });
  assert.deepEqual(fmt.brightness(1), { level: 2, word: "bright" });
  assert.deepEqual(fmt.brightness(2), { level: 1, word: "easy to see" });
  assert.deepEqual(fmt.brightness(2.8), { level: 0, word: "faint" });
  assert.deepEqual([-2.01, -2, -0.01, 0, 1.49, 1.5, 2.49, 2.5, 3].map(level), [4, 3, 3, 2, 2, 1, 1, 0, 0]);
  assert.equal(level(undefined), 0);
  assert.equal(level(Number.NaN), 0);
});

test("compass points are translated", () => {
  assert.equal(new Formatter(hass(), english).direction("SE"), "SE");
  const DE = translation("de");
  const de = new Formatter(hass({ language: "de" }), new Strings("de", DE));
  // The translation's own names, in the integration's order from north.
  assert.equal(de.direction("SE"), DE.compass[6]);
  assert.equal(de.direction("ENE"), DE.compass[3]);
  assert.notEqual(DE.compass[6], "SE", "German says it its own way");
  assert.equal(de.degrees(67.4), "67°");
  assert.equal(de.degrees(undefined), "");
});

test("distances, altitudes and speeds in the units the location asks for", () => {
  const metric = new Formatter(hass(), english);
  assert.equal(plain(metric.distance(1234.4)), "1,234 km");
  assert.equal(plain(metric.altitude(421.3)), "421 km");
  assert.equal(plain(metric.speed(7.66)), "27,576 km/h");
  assert.equal(metric.imperial, false);
  const us = new Formatter(hass({ length: "mi" }), english);
  assert.equal(us.imperial, true);
  assert.equal(plain(us.distance(1234.4)), "767 mi");
  assert.equal(plain(us.speed(7.66)), "17,135 mph");
  // The location's Units option wins over Home Assistant's unit system; "auto" goes back to it.
  us.setUnits("metric");
  assert.equal(plain(us.altitude(421.3)), "421 km");
  us.setUnits("auto");
  assert.equal(plain(us.altitude(421.3)), "262 mi");
  metric.setUnits("imperial");
  assert.equal(plain(metric.altitude(421.3)), "262 mi");
  metric.setUnits(undefined);
  assert.equal(metric.imperial, false);
  // Units are written in the user's number format.
  assert.equal(plain(new Formatter(hass({ numberFormat: "decimal_comma" }), english).speed(7.66)), "27.576 km/h");
  assert.equal(metric.distance(undefined), "");
  assert.equal(metric.speed(Number.NaN), "");
});

test("cloud cover in three levels", () => {
  const fmt = new Formatter(hass(), english);
  assert.deepEqual(fmt.cloud(37), { text: "37%", level: "partly", word: "Partly cloudy" });
  assert.deepEqual(
    [0, 20, 21, 60, 61, 100].map((p) => fmt.cloud(p).level),
    ["clear", "clear", "partly", "partly", "cloudy", "cloudy"]
  );
  assert.equal(fmt.cloud(12.6).text, "13%");
  assert.equal(fmt.cloud(null), null, "no forecast");
  assert.equal(fmt.cloud(undefined), null);
  assert.equal(fmt.cloud(""), null);
  assert.equal(fmt.cloud(140).text, "100%");
  assert.equal(plain(new Formatter(hass({ language: "fr" }), english).cloud(37).text), "37 %");
});

test("an hour, as briefly as the clock allows, and percentages", () => {
  const sixAm = Date.parse("2026-10-19T06:00:00-04:00") / 1000;
  assert.equal(plain(new Formatter(hass({ timeFormat: "12" }), english).hour(sixAm)), "6 AM");
  assert.equal(plain(new Formatter(hass({ timeFormat: "12" }), english).hour(sixAm + 3 * H)), "9 AM");
  assert.equal(new Formatter(hass({ timeFormat: "24" }), english).hour(sixAm), "06:00");
  assert.equal(new Formatter(hass({ language: "de" }), english).hour(sixAm), "6:00", "German's own 24-hour clock");
  // Not on the hour there (India is UTC+5:30): the minutes stay.
  assert.equal(plain(new Formatter(hass({ timeFormat: "12", serverZone: "Asia/Kolkata" }), english).hour(sixAm)), "3:30 PM");
  // The browser's zone when the user chose local time (Tokyo here, on the hour).
  assert.equal(plain(new Formatter(hass({ timeFormat: "12", timeZone: "local" }), english).hour(sixAm)), "7 PM");
  assert.equal(new Formatter(hass(), english).hour(undefined), "");
  const fmt = new Formatter(hass(), english);
  assert.equal(fmt.percent(0.784), "78%");
  assert.equal(fmt.percent(1), "100%");
  assert.equal(fmt.percent(Number.NaN), "");
  assert.equal(plain(new Formatter(hass({ language: "fr" }), english).percent(0.43)), "43 %");
  assert.equal(plain(new Formatter(hass({ language: "de" }), english).percent(0.43)), "43 %");
});

test("passes are grouped by the morning, afternoon or evening they fall in", () => {
  // Boston: Saturday 17 October 2026, 17:00 EDT.
  const fmt = new Formatter(hass(), english);
  const at = (iso) => Date.parse(iso) / 1000;
  const label = (iso, now = NOW) => fmt.group(at(iso), now).label;
  assert.deepEqual(fmt.group(at("2026-10-17T18:35:13-04:00"), NOW), {
    key: "2026-10-17-evening", label: "Tonight", sub: "Sat, Oct 17",
  });
  assert.equal(label("2026-10-18T05:54:33-04:00"), "Tomorrow morning");
  assert.equal(label("2026-10-18T13:00:00-04:00"), "Tomorrow afternoon");
  assert.equal(label("2026-10-18T19:33:48-04:00"), "Tomorrow evening");
  assert.equal(label("2026-10-19T05:09:40-04:00"), "Monday morning");
  assert.equal(label("2026-10-21T18:00:00-04:00"), "Wednesday evening");
  assert.equal(fmt.group(at("2026-10-21T18:00:00-04:00"), NOW).sub, "Wed, Oct 21");
  const morning = at("2026-10-17T09:00:00-04:00");
  assert.equal(label("2026-10-17T10:00:00-04:00", morning), "This morning");
  assert.equal(label("2026-10-17T13:00:00-04:00", morning), "This afternoon");
  assert.equal(label("2026-10-17T20:00:00-04:00", morning), "Tonight");
  // The edges of the periods.
  const period = (iso) => fmt.group(at(iso), morning).key.split("-").at(-1);
  assert.equal(period("2026-10-17T00:00:00-04:00"), "morning");
  assert.equal(period("2026-10-17T11:59:59-04:00"), "morning");
  assert.equal(period("2026-10-17T12:00:00-04:00"), "afternoon");
  assert.equal(period("2026-10-17T16:59:59-04:00"), "afternoon");
  assert.equal(period("2026-10-17T17:00:00-04:00"), "evening");
  assert.equal(period("2026-10-17T23:59:59-04:00"), "evening");
});

test("groups follow calendar days across midnight", () => {
  const fmt = new Formatter(hass(), english);
  const at = (iso) => Date.parse(iso) / 1000;
  const lateSaturday = at("2026-10-17T23:50:00-04:00");
  assert.deepEqual(fmt.group(at("2026-10-18T00:10:00-04:00"), lateSaturday), {
    key: "2026-10-18-morning", label: "Tomorrow morning", sub: "Sun, Oct 18",
  });
  // A pass still going on just after midnight began "last night".
  const earlySunday = at("2026-10-18T00:02:00-04:00");
  assert.equal(fmt.group(at("2026-10-17T23:58:00-04:00"), earlySunday).label, "Last night");
  assert.equal(fmt.group(at("2026-10-17T07:00:00-04:00"), earlySunday).label, "Yesterday morning");
  assert.equal(fmt.group(at("2026-10-17T14:00:00-04:00"), earlySunday).label, "Yesterday afternoon");
  assert.equal(fmt.group(at("2026-10-15T07:00:00-04:00"), earlySunday).label, "Thursday morning");
  assert.deepEqual(fmt.group(undefined, NOW), { key: "", label: "", sub: "" });
});

test("groups count calendar days, not 24-hour spans, across a clock change", () => {
  // Summer time ends in the Netherlands on Sunday 25 October 2026 at 03:00.
  const fmt = new Formatter(hass({ serverZone: "Europe/Amsterdam" }), english);
  const at = (iso) => Date.parse(iso) / 1000;
  const saturdayNight = at("2026-10-24T23:30:00+02:00");
  // 26 hours later, but two calendar days.
  assert.equal(fmt.group(at("2026-10-26T00:30:00+01:00"), saturdayNight).label, "Monday morning");
  assert.equal(fmt.group(at("2026-10-25T06:00:00+01:00"), saturdayNight).label, "Tomorrow morning");
  assert.equal(fmt.group(at("2026-10-25T02:30:00+01:00"), saturdayNight).key, "2026-10-25-morning");
  // The 25-hour day itself: its last hour is still that day's evening.
  assert.equal(fmt.group(at("2026-10-25T23:30:00+01:00"), saturdayNight).label, "Tomorrow evening");
  // Spring: 23-hour day.
  const spring = new Formatter(hass({ serverZone: "America/New_York" }), english);
  const beforeSpring = at("2026-03-07T22:00:00-05:00");
  assert.equal(spring.group(at("2026-03-08T21:30:00-04:00"), beforeSpring).label, "Tomorrow evening");
  assert.equal(spring.group(at("2026-03-09T00:30:00-04:00"), beforeSpring).label, "Monday morning");
});

test("groups use the time zone times are shown in", () => {
  const at = (iso) => Date.parse(iso) / 1000;
  const instant = at("2026-10-17T23:30:00Z");
  const boston = new Formatter(hass({ serverZone: "America/New_York" }), english);
  const veenendaal = new Formatter(hass({ serverZone: "Europe/Amsterdam" }), english);
  const tokyo = new Formatter(hass({ timeZone: "local", serverZone: "Europe/Amsterdam" }), english);
  assert.equal(boston.group(instant, NOW).label, "Tonight");
  assert.equal(veenendaal.group(instant, NOW).label, "Tomorrow morning");
  assert.equal(tokyo.group(instant, NOW).label, "This morning", "08:30 on Sunday in Tokyo, where it is already Sunday 06:00");
});

test("group names come from the translation", () => {
  const de = new Formatter(
    hass({ language: "de" }),
    new Strings("de", { time: { tomorrow_morning: "Morgen früh", weekday_evening: "{weekday}abend" } })
  );
  const at = (iso) => Date.parse(iso) / 1000;
  assert.equal(de.group(at("2026-10-18T05:54:33-04:00"), NOW).label, "Morgen früh");
  assert.equal(de.group(at("2026-10-19T19:00:00-04:00"), NOW).label, "Montagabend");
  assert.equal(de.group(at("2026-10-19T19:00:00-04:00"), NOW).sub, "Mo., 19. Okt.");
  // A key the translation lacks shows in English.
  assert.equal(de.group(at("2026-10-17T19:00:00-04:00"), NOW).label, "Tonight");
});

test("a heading's weekday is in the heading's language; dates and times stay in the user's", () => {
  const monday = Date.parse("2026-10-19T19:00:00-04:00") / 1000;
  // Czech has no translation: English headings, Czech dates and times.
  const cs = new Formatter(hass({ language: "cs" }), english);
  const group = cs.group(monday, NOW);
  assert.equal(group.label, "Monday evening");
  assert.match(group.sub, /^po\b/, "pondělí, the date's own weekday");
  assert.equal(cs.t("card.when", { day: group.label, time: cs.time(monday) }), "Monday evening · 19:00");
  // German, with English standing in until its text arrives.
  const german = new Strings("de", translation("de"));
  const de = new Formatter(hass({ language: "de" }), english);
  assert.equal(de.group(monday, NOW).label, "Monday evening");
  assert.equal(de.group(monday, NOW).sub, "Mo., 19. Okt.");
  de.update(de._hass, german);
  assert.equal(de.group(monday, NOW).label, "Montagabend");
  // A regional variant of a translated language keeps its own words.
  assert.equal(new Formatter(hass({ language: "de-CH" }), german).group(monday, NOW).label, "Montagabend");
  const brazilian = new Strings("pt-BR", translation("pt-BR"));
  assert.equal(new Formatter(hass({ language: "pt" }), brazilian).weekday(monday), "segunda-feira");
  assert.equal(new Formatter(hass({ language: "en-GB" }), english).group(monday, NOW).label, "Monday evening");
});

test("a new locale is picked up, the same one costs nothing", () => {
  const h = hass({ timeFormat: "12" });
  const fmt = new Formatter(h, english);
  assert.equal(plain(fmt.time(NOW)), "5:00 PM");
  const cached = fmt._dates.size;
  fmt.update({ ...h }, undefined);
  assert.equal(fmt._dates.size, cached, "same locale object: the formats are kept");
  assert.equal(fmt.strings, english, "no new text: the old text stays");
  fmt.update({ ...h, locale: { ...h.locale, time_format: "24" } });
  assert.equal(fmt.time(NOW), "17:00");
  fmt.update({ ...h, locale: { ...h.locale, time_format: "24" }, config: { time_zone: "Europe/Amsterdam" } });
  assert.equal(fmt.time(NOW), "23:00");
  const DE = translation("de");
  const de = new Strings("de", DE);
  fmt.update(fmt._hass, de);
  assert.equal(fmt.strings, de);
  assert.equal(fmt.t("panel.location"), DE.panel.location);
  assert.notEqual(DE.panel.location, "Location");
  assert.equal(fmt.html("panel.location"), DE.panel.location.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
});

test("a formatter works before Home Assistant and the text are there", () => {
  const fmt = new Formatter(undefined);
  assert.equal(fmt.strings, english);
  assert.equal(fmt.t("time.tonight"), "Tonight");
  assert.equal(fmt.imperial, false);
  assert.ok(fmt.time(NOW));
  assert.ok(fmt.num(3));
  assert.equal(fmt.duration(45), "45 s");
});

test("kinds of object and pass names", () => {
  const fmt = new Formatter(hass(), english);
  assert.equal(fmt.kind("iss"), "Space station");
  assert.equal(fmt.kind("rocket"), "Rocket body");
  assert.equal(fmt.kind("something new"), "Satellite");
  assert.equal(fmt.passTitle({ title: "Hubble +1", satellite_count: 2, train: false }), "Hubble +1");
  assert.equal(fmt.passTitle({ title: "Starlink Group 15-25 D +21", satellite_count: 22, train: true }), "Starlink train · 22");
  assert.equal(fmt.passTitle({ transits: [{ name: "ISS" }] }), "ISS");
  assert.equal(fmt.passTitle(null), "");
});
