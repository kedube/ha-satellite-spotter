// The module behind every stubbed frontend file (see dom-stubs.mjs). It
// defines the element that file would define, as a recorder: the properties
// it is given, the methods called on it, and fire(type, detail) to send an
// event as the real element would. Not a test file.
const url = new URL(import.meta.url);
const name = url.searchParams.get("stub");
if (globalThis.__stubFail?.[name] > 0) {
  globalThis.__stubFail[name]--;
  throw new Error(`${name} could not be downloaded`);
}
(globalThis.__stubLoads ??= []).push(`${name}${url.search}`);

const TAGS = {
  "sat-globe.js": "satellite-globe-view",
  "sat-passes-card.js": "satellite-passes-view",
  "sat-street.js": "satellite-street-view",
};

class Recorder extends HTMLElement {
  constructor() {
    super();
    this.calls = [];
    this.configs = [];
  }
  set config(config) {
    this.configs.push(config);
  }
  get config() {
    return this.configs.at(-1);
  }
  fire(type, detail, { bubbles = false, composed = false } = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles, composed }));
  }
  selectPass(...args) {
    this.calls.push(["selectPass", ...args]);
  }
  open(...args) {
    this.calls.push(["open", ...args]);
  }
  dispose(...args) {
    this.calls.push(["dispose", ...args]);
  }
  setPass(...args) {
    this.calls.push(["setPass", ...args]);
  }
}

const tag = TAGS[name];
if (tag && !customElements.get(tag)) customElements.define(tag, class extends Recorder {});
export default tag;
