// Tests for the frontend's translations (every module's text, in every
// language): node --test "tests/js/*.test.mjs"
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LANGUAGES,
  Strings,
  english,
  loadStrings,
  peekStrings,
  resolveLanguage,
} from "../../custom_components/satellite_spotter/frontend/sat-i18n.js";
import EN from "../../custom_components/satellite_spotter/frontend/translations/en.js";

const FRONTEND = new URL("../../custom_components/satellite_spotter/frontend/", import.meta.url);
const TRANSLATIONS = new URL("translations/", FRONTEND);
const translation = (lang) => JSON.parse(readFileSync(new URL(`${lang}.json`, TRANSLATIONS), "utf8"));
const OTHERS = LANGUAGES.filter((l) => l !== "en");

const placeholders = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const isPlural = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Every leaf of a table: [key, value], plural forms and lists kept whole. */
function* leaves(table, prefix = "") {
  for (const [key, value] of Object.entries(table)) {
    const path = `${prefix}${key}`;
    if (isPlural(value) && !("other" in value)) yield* leaves(value, `${path}.`);
    else yield [path, value];
  }
}

/** The plural forms a language uses for whole numbers. */
function pluralForms(lang) {
  const rules = new Intl.PluralRules(lang);
  return new Set([...Array(1000).keys()].map((n) => rules.select(n)));
}

test("there is a translation file for every language, and no other", () => {
  const files = readdirSync(TRANSLATIONS).sort();
  assert.deepEqual(files, ["en.js", ...OTHERS.map((l) => `${l}.json`)].sort());
});

for (const lang of OTHERS) {
  test(`the ${lang} translation has every English key, with the same placeholders`, () => {
    const table = translation(lang);
    const ours = new Map(leaves(table));
    const theirs = new Map(leaves(EN));
    assert.deepEqual([...ours.keys()].sort(), [...theirs.keys()].sort());
    for (const [key, en] of theirs) {
      const value = ours.get(key);
      if (Array.isArray(en)) {
        assert.ok(Array.isArray(value) && value.length === en.length, `${key}: ${en.length} names`);
        assert.ok(value.every((v) => typeof v === "string" && v.trim()), key);
        assert.equal(new Set(value).size, value.length, `${key}: names repeat`);
      } else if (isPlural(en)) {
        assert.ok(isPlural(value), `${key} has plural forms`);
        const known = new Set(Object.values(en).flatMap((t) => [...placeholders(t)]));
        for (const form of pluralForms(lang)) assert.ok(typeof value[form] === "string", `${key}.${form}`);
        for (const [form, text] of Object.entries(value)) {
          for (const name of placeholders(text)) assert.ok(known.has(name), `${key}.${form}: {${name}}`);
        }
        assert.deepEqual(placeholders(value.other), placeholders(en.other), `${key}.other`);
      } else {
        assert.equal(typeof value, "string", key);
        assert.ok(value.trim(), `${key} is empty`);
        assert.deepEqual(placeholders(value), placeholders(en), key);
      }
    }
  });
}

test("a compass point that ends in a full stop never makes two", () => {
  // Polish abbreviates them ("wsch."), and does not double the stop at the end of a sentence.
  const points = ["direction", "start", "peak", "end"];
  for (const lang of OTHERS) {
    const strings = new Strings(lang, translation(lang));
    for (const [key, value] of leaves(translation(lang))) {
      if (typeof value !== "string" && !isPlural(value)) continue;
      for (const point of strings.list("compass")) {
        const vars = { count: 2 };
        for (const name of points) vars[name] = point;
        assert.doesNotMatch(strings.t(key, vars), /\.\./, `${lang} ${key} with ${point}`);
      }
    }
  }
});

// Every frontend module (they are all flat in frontend/), read once.
const MODULES = readdirSync(FRONTEND)
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((file) => ({ file, source: readFileSync(new URL(file, FRONTEND), "utf8") }));
const defined = (key) => key.split(".").reduce((v, part) => v?.[part], EN) !== undefined;
const GROUPS = Object.keys(EN).join("|");

// Keys the code puts together from a prefix and a value (`kinds.${kind}`), by
// the track that owns the module. A new built key must be listed here: the
// test below finds every prefix in the code and wants a key for it.
const BUILT = [
  // sat-card.js (D2): the editors' labels, helpers and choices, the picker.
  ...["entry_id", "imagery", "view", "labels", "show_track", "show_night", "show_footprint", "show_home_zone",
    "show_countdown", "show_stats", "show_satellites", "show_passes", "street_view", "cooperative_gestures", "height",
    "count", "bright_only", "hide_starlink", "show_chart"].map((n) => `editor.${n}`),
  ...["entry_id_helper", "show_satellites_helper", "show_passes_helper", "count_helper"].map((n) => `editor.${n}`),
  ...["satellite", "esri", "streets"].map((i) => `editor.imagery_${i}`),
  ...["home", "follow", "chase"].map((v) => `editor.view_${v}`),
  ...["name", "description", "load_failed", "passes_name", "passes_description", "passes_load_failed"].map((k) => `card.${k}`),
  // sat-format.js (D2): parts of the day, brightness, cloud, kinds.
  ...["morning", "afternoon"].flatMap((p) => [`time.this_${p}`, `time.yesterday_${p}`]),
  ...["morning", "afternoon", "evening"].flatMap((p) => [`time.tomorrow_${p}`, `time.weekday_${p}`]),
  ...["faint", "easy", "bright", "very_bright", "dazzling"].map((b) => `brightness.${b}`),
  ...["clear", "partly", "cloudy"].map((c) => `passes.cloud_${c}`),
  ...["iss", "tiangong", "hubble", "starlink", "rocket", "debris", "satellite"].map((k) => `kinds.${k}`),
  // sat-passes.js (D2): the buttons on each pass.
  ...["simulate", "street"].flatMap((a) => [`passes.${a}`, `passes.${a}_short`, `passes.${a}_hint`]),
  // sat-globe.js (D1).
  ...["satellite", "esri", "streets"].map((i) => `controls.imagery_${i}`),
  ...["high", "medium", "low"].map((c) => `mission.confidence_${c}`),
  ...["shadow", "rise", "sky"].map((r) => `sky.start_${r}`),
  ...["shadow", "set", "sky"].map((r) => `sky.end_${r}`),
  // sat-timebar.js (D1): what the bar says about the pass.
  ...["starts_in", "visible_left", "appears_in", "after"].map((k) => `timebar.${k}`),
  // sat-planetarium.js (B): planet names.
  ...["mercury", "venus", "mars", "jupiter", "saturn"].map((p) => `planetarium.${p}`),
  // sat-street.js (B): credits, why the 3D view is off, what failed, what hides the satellite (in the photo too).
  ...["map", "terrain", "imagery", "stars", "engine", "photo"].map((k) => `street.credit_${k}`),
  ...["map", "terrain", "stars"].map((k) => `street.credit_${k}_text`),
  ...["webgl", "slow", "failed"].map((r) => `street.reason_${r}`),
  ...["terrain", "ofm", "imagery"].map((s) => `street.degraded_${s}`),
  ...["until", "from"].flatMap((w) => ["buildings", "terrain", "buildings_or_terrain", "photo", "model"].map((k) => `street.hidden_${w}_${k}`)),
  ...["rural", "suburban", "city"].map((s) => `street.sky_${s}`),
  // sat-street.js (B): why a photo service sent no photos.
  ...["failed", "refused"].map((w) => `street.photo_source_${w}`),
];

test("every key the frontend uses has English text", () => {
  assert.ok(MODULES.length >= 10, "the scan sees every module");
  const keyPattern = new RegExp(`["'\`]((?:${GROUPS})\\.[a-z_]+)["'\`]`, "g");
  const missing = [];
  for (const { file, source } of MODULES) {
    for (const [, key] of source.matchAll(keyPattern)) {
      if (!defined(key)) missing.push(`${file}: ${key}`);
    }
  }
  for (const key of BUILT) if (!defined(key)) missing.push(`built: ${key}`);
  assert.deepEqual(missing, []);
});

test("every key the code puts together is listed, so its texts are checked", () => {
  const prefixPattern = new RegExp(`[\`"']((?:${GROUPS})\\.[a-z_]*)\\$\\{`, "g");
  const unlisted = [];
  for (const { file, source } of MODULES) {
    for (const [, prefix] of source.matchAll(prefixPattern)) {
      if (!BUILT.some((key) => key.startsWith(prefix))) unlisted.push(`${file}: ${prefix}…`);
    }
  }
  assert.deepEqual(unlisted, []);
});

test("every text is used", () => {
  // A text nobody shows only costs the translators time.
  const used = (key) =>
    BUILT.includes(key) || MODULES.some(({ source }) => source.includes(`"${key}"`) || source.includes(`'${key}'`) || source.includes(`\`${key}\``));
  const unused = [];
  for (const [key] of leaves(EN)) if (!used(key)) unused.push(key);
  assert.deepEqual(unused, []);
  // And BUILT lists only keys there are.
  assert.deepEqual(BUILT.filter((key) => !defined(key)), []);
});

test("Home Assistant's language picks the translation", () => {
  assert.equal(resolveLanguage("de"), "de");
  assert.equal(resolveLanguage("de-CH"), "de");
  assert.equal(resolveLanguage("pt-BR"), "pt-BR");
  assert.equal(resolveLanguage("pt"), "pt-BR");
  assert.equal(resolveLanguage("es-419"), "es");
  assert.equal(resolveLanguage("en-GB"), "en");
  assert.equal(resolveLanguage("nb"), "en");
  assert.equal(resolveLanguage("zh-Hans"), "en");
  assert.equal(resolveLanguage(undefined), "en");
});

/** A template filled in the way Strings does it. */
const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));

test("text is filled in, counted and escaped", () => {
  const de = new Strings("de", {
    mission: { look_up: "Schau nach {direction}, {elevation}° hoch" },
    pass: { orbits_away: { one: "{count} Umlauf entfernt", other: "{count} Umläufe entfernt" } },
  });
  assert.equal(de.t("mission.look_up", { direction: "SSW", elevation: 45 }), "Schau nach SSW, 45° hoch");
  assert.equal(de.t("pass.orbits_away", { count: 1 }), "1 Umlauf entfernt");
  assert.equal(de.t("pass.orbits_away", { count: 3 }), "3 Umläufe entfernt");
  assert.equal(english.t("pass.orbits_away", { count: 1 }), "1 orbit away");
  assert.equal(english.t("passes.footer", { count: 10 }), "That's all for the next 10 days.");
  // Polish has more plural forms than English: each count finds its own.
  const pl = new Strings("pl", {
    pass: { orbits_away: { one: "za {count} okrążenie", few: "za {count} okrążenia", many: "za {count} okrążeń", other: "za {count} okrążenia" } },
  });
  assert.deepEqual(
    [1, 2, 5, 22].map((count) => pl.t("pass.orbits_away", { count })),
    ["za 1 okrążenie", "za 2 okrążenia", "za 5 okrążeń", "za 22 okrążenia"]
  );
  // Each language's own file: its text, filled in, in its plural forms.
  for (const lang of OTHERS) {
    const table = translation(lang);
    const strings = new Strings(lang, table);
    const look = table.mission?.look_up;
    if (typeof look === "string") {
      assert.equal(strings.t("mission.look_up", { direction: "SSW", elevation: 45 }), fill(look, { direction: "SSW", elevation: 45 }), lang);
    }
    const orbits = table.pass?.orbits_away;
    if (isPlural(orbits)) {
      const rules = new Intl.PluralRules(lang);
      for (const count of [1, 2, 5, 22]) {
        assert.equal(strings.t("pass.orbits_away", { count }), fill(orbits[rules.select(count)] ?? orbits.other, { count }), `${lang} ${count}`);
      }
    }
  }
  // A key a translation lacks shows in English, an unknown one as itself.
  const partial = new Strings("de", { mission: { visible_now: "Jetzt sichtbar" } });
  assert.equal(partial.t("mission.visible_now"), "Jetzt sichtbar");
  assert.equal(partial.t("mission.none_soon"), "None soon");
  assert.equal(partial.t("pass.orbits_away", { count: 2 }), "2 orbits away");
  assert.equal(partial.t("no.such_key"), "no.such_key");
  // HTML: the text is escaped, the values are not.
  const fr = new Strings("fr", { telemetry: { distance: "À {distance} de {place}" } });
  assert.equal(fr.html("telemetry.distance", { distance: "<b>1 234 km</b>", place: "Maison & co" }), "À <b>1 234 km</b> de Maison & co");
  assert.equal(new Strings("en", { telemetry: { sunlit: "<i>&</i>" } }).html("telemetry.sunlit"), "&#60;i&#62;&#38;&#60;/i&#62;");
});

test("English countdowns and durations", () => {
  assert.equal(english.countdown(65_000), "01:05");
  assert.equal(english.countdown(3_725_000), "01:02:05");
  assert.equal(english.countdown(93_784_000), "1d 02:03:04");
  assert.equal(english.countdown(-5), "00:00");
  assert.equal(english.duration(20_000), "under a minute");
  assert.equal(english.duration(14 * 60_000), "14 min");
  assert.equal(english.duration(134 * 60_000), "2 h 14 min");
  assert.equal(english.duration(120 * 60_000), "2 h");
  assert.equal(english.duration(26 * 3600_000), "1 d 2 h");
});

test("compass points, countdowns and durations are translated", () => {
  const DE = translation("de");
  const de = new Strings("de", DE);
  // The 16 points in order, from north: SE is the seventh.
  assert.equal(de.direction("SE"), DE.compass[6]);
  assert.equal(de.direction("WSW"), DE.compass[11]);
  assert.notDeepEqual(DE.compass, EN.compass, "German names its points its own way (O for east)");
  const SV = translation("sv");
  assert.equal(new Strings("sv", SV).direction("E"), SV.compass[4]);
  assert.equal(de.direction("XYZ"), "XYZ");
  assert.deepEqual(de.list("sky.cardinals"), DE.sky?.cardinals?.length === 4 ? DE.sky.cardinals : EN.sky.cardinals);
  // An incomplete list falls back to English.
  assert.equal(new Strings("de", { compass: ["N", "O"] }).direction("E"), "E");
  // Countdowns and durations are made from each language's own templates.
  const time = (table, key) => table.time?.[key] ?? EN.time[key];
  assert.equal(de.countdown(93_784_000), fill(time(DE, "countdown_days"), { days: 1, time: "02:03:04" }));
  assert.equal(de.duration(134 * 60_000), fill(time(DE, "hours_minutes"), { hours: 2, minutes: 14 }));
  const FR = translation("fr");
  assert.equal(new Strings("fr", FR).duration(26 * 3600_000), fill(time(FR, "days_hours"), { days: 1, hours: 2 }));
  const NL = translation("nl");
  assert.equal(new Strings("nl", NL).duration(20_000), time(NL, "under_minute"));
  const custom = new Strings("de", { time: { countdown_days: "{days} T {time}", hours_minutes: "{hours} Std. {minutes} Min." } });
  assert.equal(custom.countdown(93_784_000), "1 T 02:03:04");
  assert.equal(custom.duration(134 * 60_000), "2 Std. 14 Min.");
  assert.equal(custom.countdown(3_723_000), "01:02:03", "under a day: no template");
});

test("a translation is downloaded once, and English stands in while it cannot be", async () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const asked = [];
  let fail = true;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (fail) throw new TypeError("Failed to fetch");
    return { ok: true, json: async () => translation("it") };
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    let now = realNow();
    Date.now = () => now;
    assert.equal(peekStrings("it"), null);
    assert.equal(await loadStrings("it"), english);
    assert.equal(await loadStrings("it-CH"), english, "no second attempt straight away");
    assert.equal(asked.length, 1);
    assert.match(asked[0], /translations\/it\.json$/);
    fail = false;
    now += 61_000;
    const [a, b] = await Promise.all([loadStrings("it"), loadStrings("it")]);
    assert.equal(a, b, "one download for both");
    assert.equal(asked.length, 2);
    assert.equal(a.language, "it");
    // The Italian text, for a key it has.
    const [key, italian] = [...leaves(translation("it"))].find(([k, v]) => typeof v === "string" && defined(k));
    assert.equal(a.t(key), italian);
    assert.equal(peekStrings("it"), a);
    assert.equal(await loadStrings("it"), a);
    assert.equal(await loadStrings("en"), english);
    assert.equal(asked.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    console.warn = warn;
  }
});
