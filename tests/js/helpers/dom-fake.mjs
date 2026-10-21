// Just enough of a browser DOM to run the frontend's elements in node: nodes
// and elements with attributes, classes, dataset and style; innerHTML with a
// small HTML parser (raw <style>, self-closing SVG, entities); querySelector
// with tag, #id, .class and [attr] selectors joined by " " and ">"; events that
// bubble (and leave shadow roots when composed); focus per document or shadow
// root; custom elements. Not a test file: tests import it.
//
//   import { installDom } from "./helpers/dom-fake.mjs";
//   const dom = installDom();          // sets document, window, HTMLElement… on globalThis
//   dom.document.body.appendChild(el);  // connects el (connectedCallback runs)

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["style", "script"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") return String.fromCodePoint(code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    return ENTITIES[code.toLowerCase()] ?? m;
  });
const escapeText = (text) => text.replace(/[&<>]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt" }[c]};`);
const escapeAttr = (text) => text.replace(/[&"]/g, (c) => `&${{ "&": "amp", '"': "quot" }[c]};`);
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.composed = !!init.composed;
    this.cancelable = init.cancelable !== false;
    this.detail = init.detail;
    Object.assign(this, Object.fromEntries(Object.entries(init).filter(([k]) => !["bubbles", "composed", "cancelable", "detail"].includes(k))));
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stop = false;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stop = true;
  }
  stopImmediatePropagation() {
    this._stop = true;
    this._stopNow = true;
  }
  composedPath() {
    return this._path ?? [];
  }
}

class EventTargetish {
  addEventListener(type, fn, options) {
    if (!fn) return;
    const list = ((this._listeners ??= {})[type] ??= []);
    if (!list.some((l) => l.fn === fn)) list.push({ fn, once: !!options?.once });
  }
  removeEventListener(type, fn) {
    const list = this._listeners?.[type];
    if (list) this._listeners[type] = list.filter((l) => l.fn !== fn);
  }
  _fire(ev) {
    for (const l of [...(this._listeners?.[ev.type] ?? [])]) {
      if (l.once) this.removeEventListener(ev.type, l.fn);
      ev.currentTarget = this;
      typeof l.fn === "function" ? l.fn.call(this, ev) : l.fn.handleEvent(ev);
      if (ev._stopNow) break;
    }
  }
  /** Events go to the target, then up its ancestors when they bubble; out of a shadow root only when composed. */
  dispatchEvent(ev) {
    ev.target = this;
    const path = [];
    let node = this;
    while (node) {
      path.push(node);
      if (node instanceof FakeShadowRoot) {
        if (!ev.composed) break;
        node = node.host;
      } else if (node instanceof FakeDocument) {
        node = node.defaultView;
      } else {
        node = node.parentNode;
      }
    }
    ev._path = path;
    for (const [i, current] of path.entries()) {
      if (i > 0 && !ev.bubbles) break;
      // Seen from outside a shadow root, the event comes from its host.
      let target = this;
      for (const n of path.slice(0, i)) if (n instanceof FakeShadowRoot) target = n.host;
      ev.target = target;
      current._fire(ev);
      if (ev._stop) break;
    }
    ev.target = this;
    return !ev.defaultPrevented;
  }
}

export class FakeNode extends EventTargetish {
  constructor(ownerDocument) {
    super();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }
  // Failed assertions print a node as its tag, not as the whole page it hangs in.
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.localName ? `<${this.localName}${this.id ? `#${this.id}` : ""}>` : `[${this.constructor.name}]`;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes;
    return siblings ? siblings[siblings.indexOf(this) + 1] ?? null : null;
  }
  get previousSibling() {
    const siblings = this.parentNode?.childNodes;
    return siblings ? siblings[siblings.indexOf(this) - 1] ?? null : null;
  }
  get children() {
    return this.childNodes.filter((n) => n instanceof FakeElement);
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  get nextElementSibling() {
    let n = this.nextSibling;
    while (n && !(n instanceof FakeElement)) n = n.nextSibling;
    return n;
  }
  get parentElement() {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(text) {
    this.replaceChildren();
    if (text !== "" && text != null) this.appendChild(this.ownerDocument.createTextNode(String(text)));
  }
  getRootNode() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node;
  }
  get isConnected() {
    let node = this;
    for (;;) {
      if (node instanceof FakeDocument) return true;
      if (node instanceof FakeShadowRoot) node = node.host;
      else if (node.parentNode) node = node.parentNode;
      else return false;
    }
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n);
  }
  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes) this.insertBefore(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n, first);
  }
  insertBefore(child, ref) {
    if (child instanceof FakeFragment) {
      for (const n of [...child.childNodes]) this.insertBefore(n, ref);
      return child;
    }
    // A move is a removal and an insertion, with both callbacks, as in a browser.
    if (child.parentNode) child.parentNode._detach(child);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && i < 0) throw new Error("insertBefore: the reference node is not a child");
    if (i < 0) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    if (this.isConnected) child._connected();
    return child;
  }
  removeChild(child) {
    this._detach(child);
    return child;
  }
  _detach(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) return;
    const wasConnected = child.isConnected;
    // A removed element loses keyboard focus, as in a browser.
    const root = child.getRootNode();
    const owner = root instanceof FakeShadowRoot || root instanceof FakeDocument ? root : null;
    if (owner?._active && child.contains(owner._active)) owner._blurActive();
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    if (wasConnected) child._disconnected();
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const next = this.nextSibling;
    parent.removeChild(this);
    for (const n of nodes) parent.insertBefore(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n, next);
  }
  before(...nodes) {
    for (const n of nodes) this.parentNode?.insertBefore(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n, this);
  }
  after(...nodes) {
    const next = this.nextSibling;
    for (const n of nodes) this.parentNode?.insertBefore(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n, next);
  }
  replaceChildren(...nodes) {
    for (const n of [...this.childNodes]) this.removeChild(n);
    this.append(...nodes);
  }
  _connected() {
    for (const n of this.childNodes) n._connected();
  }
  _disconnected() {
    for (const n of this.childNodes) n._disconnected();
  }
  querySelectorAll(selector) {
    const groups = parseSelector(selector);
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (!(child instanceof FakeElement)) continue;
        if (groups.some((g) => matchComplex(child, g, this))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  get innerHTML() {
    return this.childNodes.map((n) => n.outerHTML ?? escapeText(n.data)).join("");
  }
  set innerHTML(html) {
    this.replaceChildren();
    for (const node of parseHTML(String(html), this.ownerDocument)) this.appendChild(node);
  }
}

export class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc);
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
  set textContent(text) {
    this.data = String(text);
  }
  get nodeValue() {
    return this.data;
  }
}

class FakeFragment extends FakeNode {}

export class FakeShadowRoot extends FakeFragment {
  constructor(host, mode) {
    super(host.ownerDocument);
    this.host = host;
    this.mode = mode;
    this._active = null;
  }
  get activeElement() {
    return this._active?.getRootNode() === this ? this._active : null;
  }
  _blurActive() {
    this._active = null;
  }
  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

class ClassList {
  constructor(el) {
    this.el = el;
  }
  _get() {
    return (this.el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
  }
  _set(list) {
    this.el.setAttribute("class", list.join(" "));
  }
  contains(name) {
    return this._get().includes(name);
  }
  add(...names) {
    const list = this._get();
    for (const n of names) if (!list.includes(n)) list.push(n);
    this._set(list);
  }
  remove(...names) {
    this._set(this._get().filter((n) => !names.includes(n)));
  }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    on ? this.add(name) : this.remove(name);
    return on;
  }
  get length() {
    return this._get().length;
  }
  toString() {
    return this._get().join(" ");
  }
}

class Style {
  constructor() {
    this._props = new Map();
  }
  setProperty(name, value) {
    this._props.set(name, String(value));
  }
  removeProperty(name) {
    this._props.delete(name);
  }
  getPropertyValue(name) {
    return this._props.get(name) ?? "";
  }
  get cssText() {
    return [...this._props].map(([k, v]) => `${k}: ${v};`).join(" ");
  }
  set cssText(text) {
    this._props.clear();
    for (const part of String(text).split(";")) {
      const [k, ...v] = part.split(":");
      if (k?.trim()) this._props.set(k.trim(), v.join(":").trim());
    }
  }
}
// style.height = "10px" works as in a browser.
const styleProxy = (style) =>
  new Proxy(style, {
    get: (t, k) =>
      typeof k === "symbol" || k in t ? (typeof t[k] === "function" ? t[k].bind(t) : t[k]) : t._props.get(kebab(k)) ?? "",
    set: (t, k, v) => {
      if (typeof k === "symbol" || k in t) t[k] = v;
      else if (v === "" || v == null) t._props.delete(kebab(String(k)));
      else t._props.set(kebab(String(k)), String(v));
      return true;
    },
  });

export class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = new Map();
    this.classList = new ClassList(this);
    this.style = styleProxy(new Style());
    this.dataset = new Proxy(
      {},
      {
        get: (_, k) => (typeof k === "symbol" ? undefined : this.getAttribute(`data-${kebab(k)}`) ?? undefined),
        set: (_, k, v) => {
          this.setAttribute(`data-${kebab(String(k))}`, v);
          return true;
        },
        deleteProperty: (_, k) => {
          this.removeAttribute(`data-${kebab(String(k))}`);
          return true;
        },
        has: (_, k) => this.hasAttribute(`data-${kebab(String(k))}`),
        ownKeys: () => [...this.attributes.keys()].filter((n) => n.startsWith("data-")).map((n) => camel(n.slice(5))),
        getOwnPropertyDescriptor: (_, k) => ({ enumerable: true, configurable: true, value: this.getAttribute(`data-${kebab(String(k))}`) }),
      }
    );
    this.shadowRoot = null;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.rect = null;
  }
  get nodeName() {
    return this.tagName;
  }
  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const old = this.attributes.get(key) ?? null;
    this.attributes.set(key, String(value));
    if (old !== String(value)) notifyAttribute(this, key, old);
  }
  getAttribute(name) {
    return this.attributes.get(String(name).toLowerCase()) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }
  removeAttribute(name) {
    const key = String(name).toLowerCase();
    if (!this.attributes.has(key)) return;
    const old = this.attributes.get(key);
    this.attributes.delete(key);
    notifyAttribute(this, key, old);
  }
  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : !!force;
    if (on) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return on;
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  set id(v) {
    this.setAttribute("id", v);
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  set className(v) {
    this.setAttribute("class", v);
  }
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(v) {
    this.toggleAttribute("hidden", !!v);
  }
  get title() {
    return this.getAttribute("title") ?? "";
  }
  set title(v) {
    this.setAttribute("title", v);
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(v) {
    this.toggleAttribute("disabled", !!v);
  }
  get tabIndex() {
    const v = this.getAttribute("tabindex");
    return v == null ? (["button", "a", "input", "select"].includes(this.localName) ? 0 : -1) : Number(v);
  }
  set tabIndex(v) {
    this.setAttribute("tabindex", v);
  }
  get value() {
    if (this.localName === "select") {
      return this._value ?? this.querySelector("option")?.value ?? "";
    }
    if (this.localName === "option") return this.getAttribute("value") ?? this.textContent;
    return this._value ?? this.getAttribute("value") ?? "";
  }
  set value(v) {
    if (this.localName === "select") {
      // As a browser: only one of its options can be chosen, else nothing is.
      this._value = this.querySelectorAll("option").some((o) => o.value === String(v)) ? String(v) : "";
    } else if (this.localName === "option") {
      this.setAttribute("value", v);
    } else {
      this._value = String(v);
    }
  }
  get outerHTML() {
    const attrs = [...this.attributes].map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`)).join("");
    if (VOID.has(this.localName)) return `<${this.localName}${attrs}>`;
    const inner = RAW.has(this.localName) ? this.textContent : this.innerHTML;
    return `<${this.localName}${attrs}>${inner}</${this.localName}>`;
  }
  attachShadow({ mode = "open" } = {}) {
    if (this.shadowRoot) throw new Error("attachShadow: already has a shadow root");
    this.shadowRoot = new FakeShadowRoot(this, mode);
    return this.shadowRoot;
  }
  matches(selector) {
    return parseSelector(selector).some((g) => matchComplex(this, g, null));
  }
  closest(selector) {
    const groups = parseSelector(selector);
    for (let n = this; n instanceof FakeElement; n = n.parentNode) if (groups.some((g) => matchComplex(n, g, null))) return n;
    return null;
  }
  focus() {
    const root = this.getRootNode();
    if (root instanceof FakeShadowRoot || root instanceof FakeDocument) {
      root._active = this;
      // The page's active element is the outermost host.
      let host = root;
      while (host instanceof FakeShadowRoot) {
        const outer = host.host.getRootNode();
        if (outer instanceof FakeShadowRoot || outer instanceof FakeDocument) outer._active = host.host;
        host = outer;
      }
    }
    this.ownerDocument.focusLog?.push(this);
  }
  blur() {
    const root = this.getRootNode();
    if (root?._active === this) root._active = null;
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent("click", { bubbles: true, composed: true }));
  }
  getBoundingClientRect() {
    const r = this.rect ?? { top: 0, left: 0, width: 0, height: 0 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }
  scrollIntoView(options) {
    (this.scrolledIntoView ??= []).push(options);
  }
  _connected() {
    if (typeof this.connectedCallback === "function") this.connectedCallback();
    // Shadow trees connect with their host.
    for (const n of [...this.childNodes, ...(this.shadowRoot?.childNodes ?? [])]) n._connected();
  }
  _disconnected() {
    if (typeof this.disconnectedCallback === "function") this.disconnectedCallback();
    for (const n of [...this.childNodes, ...(this.shadowRoot?.childNodes ?? [])]) n._disconnected();
  }
}

export class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.registry = new Map();
    this.documentElement = new FakeElement(this, "html");
    this.head = new FakeElement(this, "head");
    this.body = new FakeElement(this, "body");
    this.documentElement.append(this.head, this.body);
    this.childNodes.push(this.documentElement);
    this.documentElement.parentNode = this;
    this._active = null;
    this.dir = "ltr";
    this.hidden = false;
    this.visibilityState = "visible";
    this.defaultView = null;
  }
  get activeElement() {
    return this._active ?? this.body;
  }
  _blurActive() {
    this._active = null;
  }
  createElement(tag) {
    const Ctor = this.registry.get(String(tag).toLowerCase());
    if (Ctor) {
      FakeDocument._creating = { doc: this, tag };
      try {
        return new Ctor();
      } finally {
        FakeDocument._creating = null;
      }
    }
    return new FakeElement(this, tag);
  }
  createTextNode(text) {
    return new FakeText(this, String(text));
  }
  createDocumentFragment() {
    return new FakeFragment(this);
  }
  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

// ---- Mutation observers (attributes only) ----

const observers = new Set();

function notifyAttribute(el, name, oldValue) {
  for (const observer of observers) {
    const watch = observer._targets.get(el);
    if (!watch?.attributes || (watch.attributeFilter && !watch.attributeFilter.includes(name))) continue;
    observer._records.push({ type: "attributes", target: el, attributeName: name, oldValue });
    if (!observer._queued) {
      observer._queued = true;
      queueMicrotask(() => {
        observer._queued = false;
        const records = observer._records.splice(0);
        if (records.length) observer._callback(records, observer);
      });
    }
  }
}

export class FakeMutationObserver {
  constructor(callback) {
    this._callback = callback;
    this._targets = new Map();
    this._records = [];
  }
  observe(target, options = {}) {
    this._targets.set(target, options);
    observers.add(this);
  }
  disconnect() {
    this._targets.clear();
    observers.delete(this);
  }
  takeRecords() {
    return this._records.splice(0);
  }
}

// ---- Selectors ----

function parseSelector(selector) {
  return String(selector)
    .split(",")
    .map((part) => {
      const tokens = part.trim().match(/(?:\[[^\]]*\]|[^\s>])+|>/g) ?? [];
      const out = [];
      let combinator = " ";
      for (const token of tokens) {
        if (token === ">") {
          combinator = ">";
          continue;
        }
        out.push({ combinator, compound: parseCompound(token) });
        combinator = " ";
      }
      return out;
    });
}

function parseCompound(token) {
  const c = { tag: null, id: null, classes: [], attrs: [], scope: false };
  const re = /(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]|:scope/g;
  let m;
  while ((m = re.exec(token))) {
    if (m[0] === ":scope") c.scope = true;
    else if (m[1]) c.tag = m[1] === "*" ? null : m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4].toLowerCase(), op: m[5], value: m[6] ?? m[7] ?? m[8] });
  }
  return c;
}

function matchCompound(el, c, scope) {
  if (c.scope) return el === scope;
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v == null) return false;
    if (!a.op) continue;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
  }
  return true;
}

function matchComplex(el, parts, scope) {
  const match = (node, i) => {
    if (!matchCompound(node, parts[i].compound, scope)) return false;
    if (i === 0) return true;
    if (parts[i].combinator === ">") {
      const parent = node.parentNode;
      return parent instanceof FakeElement && match(parent, i - 1);
    }
    for (let p = node.parentNode; p instanceof FakeElement; p = p.parentNode) if (match(p, i - 1)) return true;
    return false;
  };
  return parts.length > 0 && match(el, parts.length - 1);
}

// ---- HTML ----

function parseHTML(html, doc) {
  const top = [];
  const stack = [];
  const add = (node) => (stack.length ? stack.at(-1).appendChild(node) : top.push(node));
  const re = /<!--[\s\S]*?-->|<\/\s*([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > last) add(doc.createTextNode(decode(html.slice(last, m.index))));
    last = re.lastIndex;
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const i = stack.map((n) => n.localName).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const tag = m[2].toLowerCase();
    const el = doc.createElement(tag);
    for (const a of m[3].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ""));
    }
    add(el);
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, last);
      const stop = end < 0 ? html.length : end;
      if (stop > last) el.appendChild(doc.createTextNode(html.slice(last, stop)));
      const close = html.indexOf(">", stop);
      last = close < 0 ? html.length : close + 1;
      re.lastIndex = last;
      continue;
    }
    if (!m[4] && !VOID.has(tag)) stack.push(el);
  }
  if (last < html.length) add(doc.createTextNode(decode(html.slice(last))));
  return top;
}

// ---- Install ----

/**
 * Put a fresh fake DOM on globalThis: document, window (= globalThis),
 * HTMLElement, customElements, Event, CustomEvent, KeyboardEvent, Node.
 * @returns {{document: FakeDocument, flush: () => Promise<void>}}
 */
export function installDom({ lang = "en" } = {}) {
  const doc = new FakeDocument();
  doc.documentElement.setAttribute("lang", lang);
  Object.defineProperty(doc.documentElement, "lang", {
    get: () => doc.documentElement.getAttribute("lang") ?? "",
    set: (v) => doc.documentElement.setAttribute("lang", v),
  });
  const pending = new Map();
  class HTMLElement extends FakeElement {
    constructor() {
      const creating = FakeDocument._creating;
      super(creating?.doc ?? doc, creating?.tag ?? (doc.registry.tagOf?.get(new.target) || "x-element"));
    }
  }
  const registry = doc.registry;
  registry.tagOf = new Map();
  const customElements = {
    define(name, Ctor) {
      if (registry.has(name)) throw new Error(`${name} is already defined`);
      registry.set(name, Ctor);
      registry.tagOf.set(Ctor, name);
      pending.get(name)?.forEach((resolve) => resolve(Ctor));
      pending.delete(name);
    },
    get: (name) => registry.get(name),
    whenDefined: (name) =>
      registry.has(name) ? Promise.resolve(registry.get(name)) : new Promise((resolve) => pending.set(name, [...(pending.get(name) ?? []), resolve])),
  };
  globalThis.window = globalThis;
  globalThis.document = doc;
  doc.defaultView = globalThis;
  globalThis.HTMLElement = HTMLElement;
  globalThis.Node = FakeNode;
  globalThis.customElements = customElements;
  globalThis.Event = FakeEvent;
  globalThis.CustomEvent = FakeEvent;
  globalThis.KeyboardEvent = FakeEvent;
  if (!globalThis.addEventListener) {
    const target = new EventTargetish();
    globalThis.addEventListener = target.addEventListener.bind(target);
    globalThis.removeEventListener = target.removeEventListener.bind(target);
    globalThis.dispatchEvent = (ev) => {
      ev.target ??= globalThis;
      target._fire(ev);
      return !ev.defaultPrevented;
    };
    globalThis._fire = (ev) => target._fire(ev);
  }
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
  globalThis.MutationObserver = FakeMutationObserver;
  return {
    document: doc,
    /** Let promises and zero timers run. */
    async flush(times = 20) {
      for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** A keydown on an element, bubbling and composed like a real one. */
export function keydown(el, key, extra = {}) {
  const ev = new FakeEvent("keydown", { bubbles: true, composed: true, key, ...extra });
  el.dispatchEvent(ev);
  return ev;
}

/**
 * A browser address bar and history: location.href/search/pathname and
 * history.pushState/replaceState, starting at `href`.
 */
export function installLocation(href = "http://ha.local/satellite-spotter") {
  const nav = { url: new URL(href), pushed: [], replaced: [] };
  globalThis.location = {
    get href() {
      return nav.url.href;
    },
    get search() {
      return nav.url.search;
    },
    get pathname() {
      return nav.url.pathname;
    },
    get origin() {
      return nav.url.origin;
    },
  };
  globalThis.history = {
    state: null,
    pushState(state, _title, url) {
      nav.url = new URL(url, nav.url);
      this.state = state;
      nav.pushed.push(nav.url.href);
    },
    replaceState(state, _title, url) {
      nav.url = new URL(url, nav.url);
      this.state = state;
      nav.replaced.push(nav.url.href);
    },
  };
  /** Go somewhere as Home Assistant does: a new address, then "location-changed" on window. */
  nav.go = (url) => {
    globalThis.history.pushState(null, "", url);
    globalThis.dispatchEvent(new FakeEvent("location-changed", { detail: { replace: false } }));
  };
  return nav;
}
