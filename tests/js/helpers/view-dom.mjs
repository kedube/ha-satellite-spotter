// A tiny fake DOM for the frontend tests (not a test file itself): enough of
// createElement, attributes, classes, styles, events and simple selectors for
// components that build their DOM with createElement (the time bar) and for
// the globe view's own elements. No layout, no HTML parsing: innerHTML is
// kept as a string.

class FakeStyle {
  constructor() {
    this._props = new Map();
  }

  setProperty(name, value) {
    this._props.set(name, String(value));
  }

  getPropertyValue(name) {
    return this._props.get(name) ?? "";
  }

  removeProperty(name) {
    this._props.delete(name);
  }
}

class FakeClassList {
  constructor(el) {
    this._el = el;
  }

  _list() {
    return this._el.className.split(/\s+/).filter(Boolean);
  }

  contains(cls) {
    return this._list().includes(cls);
  }

  add(...classes) {
    const list = this._list();
    for (const c of classes) if (!list.includes(c)) list.push(c);
    this._el.className = list.join(" ");
  }

  remove(...classes) {
    this._el.className = this._list().filter((c) => !classes.includes(c)).join(" ");
  }

  toggle(cls, force) {
    const on = force === undefined ? !this.contains(cls) : !!force;
    if (on) this.add(cls);
    else this.remove(cls);
    return on;
  }
}

/** Does a simple compound selector ("tag.a.b[attr]#id") match? */
function matchesCompound(el, compound) {
  const re = /([#.]?)([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  let any = false;
  while ((m = re.exec(compound))) {
    any = true;
    if (m[3]) {
      if (!el.hasAttribute(m[3])) return false;
      if (m[4] !== undefined && el.getAttribute(m[3]) !== m[4]) return false;
    } else if (m[1] === ".") {
      if (!el.classList.contains(m[2])) return false;
    } else if (m[1] === "#") {
      if (el.id !== m[2]) return false;
    } else if (el.tagName !== m[2].toUpperCase()) {
      return false;
    }
  }
  return any;
}

function matches(el, selector) {
  return selector.split(",").some((alt) => {
    const parts = alt.trim().split(/\s+/);
    if (!matchesCompound(el, parts[parts.length - 1])) return false;
    let node = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (node && !(node instanceof FakeElement && matchesCompound(node, parts[i]))) node = node.parentNode;
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  });
}

export class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.id = "";
    this.dataset = {};
    this.style = new FakeStyle();
    this.hidden = false;
    this.disabled = false;
    this.title = "";
    this._attrs = new Map();
    this._listeners = new Map();
    this._text = "";
    this._html = "";
    this._value = "";
    this.classList = new FakeClassList(this);
  }

  get value() {
    if (this.tagName === "SELECT" && this._value === "" && this.children.length) return this.children[0].value;
    return this._value;
  }

  set value(v) {
    this._value = String(v);
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  hasAttribute(name) {
    if (name === "hidden") return this.hidden;
    return this._attrs.has(name);
  }

  removeAttribute(name) {
    this._attrs.delete(name);
  }

  toggleAttribute(name, force) {
    const on = force === undefined ? !this._attrs.has(name) : !!force;
    if (on) this._attrs.set(name, "");
    else this._attrs.delete(name);
    return on;
  }

  appendChild(child) {
    child.remove?.();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }

  insertBefore(child, ref) {
    child.remove?.();
    child.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(child);
    else this.children.splice(i, 0, child);
    return child;
  }

  replaceChildren(...nodes) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const i = siblings.indexOf(this);
    if (i >= 0) siblings.splice(i, 1);
    this.parentNode = null;
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }

  set textContent(text) {
    this.replaceChildren();
    this._html = "";
    this._text = String(text);
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(html) {
    this.replaceChildren();
    this._text = "";
    this._html = String(html);
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  dispatchEvent(ev) {
    ev.target ??= this;
    for (let node = this; node; node = node.parentNode) {
      ev.currentTarget = node;
      for (const fn of [...(node._listeners?.get(ev.type) ?? [])]) fn(ev);
      if (!ev.bubbles || ev._stopped) break;
    }
    return !ev.defaultPrevented;
  }

  /** Fire an event of this type here (bubbling), with extra fields. */
  fire(type, fields = {}) {
    const ev = {
      type,
      bubbles: true,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this._stopped = true;
      },
      ...fields,
    };
    this.dispatchEvent(ev);
    return ev;
  }

  click() {
    if (!this.disabled) this.fire("click");
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null;
  }

  matches(selector) {
    return matches(this, selector);
  }

  closest(selector) {
    for (let n = this; n instanceof FakeElement; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/**
 * Give `doc` (default: globalThis.document, created if missing) a
 * createElement that makes FakeElements. Returns the document.
 */
export function installDom(doc = (globalThis.document ??= {})) {
  doc.createElement = (tag) => new FakeElement(tag, doc);
  doc.activeElement ??= null;
  return doc;
}
