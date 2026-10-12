#!/usr/bin/env node
/**
 * Status dots are paint only. Hover, tooltips, and wheel/scroll stay on x.com.
 * The people icon under Post is still the click that opens the rail.
 * Run: node scripts/test-dot-inert.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = path.join(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content/content.js"), "utf8");
const css = fs.readFileSync(path.join(root, "content/styles.css"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const dotRule = css.match(/\.xfo-dot\s*\{[^}]*\}/);
assert(dotRule, "styles.css has an .xfo-dot rule");
assert(/pointer-events:\s*none !important/.test(dotRule[0]), "dot rule sets pointer-events: none");
assert(!/cursor:\s*pointer/.test(dotRule[0]), "dot rule does not set cursor: pointer");
assert(
  /\.xfo-dot:hover[\s\S]*?pointer-events:\s*none !important/.test(css),
  "hover does not turn pointer events back on"
);
assert(
  /\.xfo-dot-wrap[\s\S]*?pointer-events:\s*none !important/.test(css),
  "a dot wrapper does not catch the pointer"
);

const inertStart = content.indexOf("function inertStatusMark");
const ensureEnd = content.indexOf("function focalRightOffset");
assert(inertStart !== -1 && ensureEnd > inertStart, "status dots have an inert helper");
const dotSrc = content.slice(inertStart, ensureEnd);
assert(/removeAttribute\(\s*"title"\s*\)/.test(dotSrc), "dots clear any title attribute");
assert(!/setAttribute\(\s*"title"/.test(dotSrc), "dots do not set a title");
assert(!/addEventListener\(/.test(dotSrc), "dot painting adds no listeners");
assert(/pointerEvents\s*=\s*"none"/.test(dotSrc), "dot painting sets pointer-events none");
assert(!/\.title\s*=\s*title/.test(dotSrc), "dots do not copy a tooltip onto .title");

const wireStart = content.indexOf("function wireRailControls");
const wireEnd = content.indexOf("function railThemeControlHTML");
const wireSrc = content.slice(wireStart, wireEnd);
assert(/btn\.addEventListener\(\s*"click"/.test(wireSrc), "people icon still has a click listener");
assert(wireSrc.includes("openRailPanel()"), "people icon click still opens the rail");
assert(wireSrc.includes("closeRailPanel()"), "people icon click still closes the rail");

function decode(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function kebab(prop) {
  return String(prop).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

function splitTop(selector, sep) {
  const parts = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function matchAttr(el, body) {
  const m = String(body)
    .trim()
    .match(/^([^\s~|^$*!=]+)(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?$/);
  if (!m) return false;
  const name = m[1];
  const op = m[2];
  const value = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : "";
  const actual = el.getAttribute(name);
  if (!op) return actual != null;
  if (actual == null) return false;
  if (op === "=") return actual === value;
  if (op === "^=") return actual.startsWith(value);
  if (op === "*=") return actual.includes(value);
  if (op === "$=") return actual.endsWith(value);
  if (op === "~=") return actual.split(/\s+/).includes(value);
  return false;
}

function matchCompound(el, compound) {
  if (!el || el.nodeType !== 1) return false;
  const s = String(compound).trim();
  if (!s) return false;
  let i = 0;
  let saw = false;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "*") {
      saw = true;
      i++;
      continue;
    }
    if (ch === "#") {
      const m = s.slice(i + 1).match(/^[\w-]+/);
      if (!m || el.id !== m[0]) return false;
      saw = true;
      i += 1 + m[0].length;
      continue;
    }
    if (ch === ".") {
      const m = s.slice(i + 1).match(/^[\w-]+/);
      if (!m || !el.classList.contains(m[0])) return false;
      saw = true;
      i += 1 + m[0].length;
      continue;
    }
    if (ch === "[") {
      const end = s.indexOf("]", i);
      if (end < 0 || !matchAttr(el, s.slice(i + 1, end))) return false;
      saw = true;
      i = end + 1;
      continue;
    }
    const m = s.slice(i).match(/^[a-zA-Z][\w-]*/);
    if (!m || el.tagName.toLowerCase() !== m[0].toLowerCase()) return false;
    saw = true;
    i += m[0].length;
  }
  return saw;
}

function matchesSelector(el, selector) {
  const compounds = String(selector || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!compounds.length) return false;
  if (!matchCompound(el, compounds[compounds.length - 1])) return false;
  let ancestor = el.parentElement;
  for (let i = compounds.length - 2; i >= 0; i--) {
    while (ancestor && !matchCompound(ancestor, compounds[i])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

function matchesAny(el, selector) {
  return splitTop(selector, ",").some((group) => matchesSelector(el, group));
}

function createStyle() {
  const props = {};
  function cssName(prop) {
    if (typeof prop !== "string") return prop;
    if (prop.startsWith("--")) return prop;
    return kebab(prop);
  }
  return new Proxy(props, {
    get(target, prop) {
      if (prop === "setProperty") {
        return (name, value) => {
          target[String(name).trim()] = value == null ? "" : String(value);
        };
      }
      if (prop === "getPropertyValue") return (name) => target[name] || "";
      if (prop === "removeProperty") {
        return (name) => {
          delete target[name];
        };
      }
      if (prop === "cssText") {
        return Object.keys(target)
          .map((key) => key + ":" + target[key])
          .join(";");
      }
      if (typeof prop !== "string") return target[prop];
      return target[cssName(prop)] || "";
    },
    set(target, prop, value) {
      if (prop === "cssText") {
        Object.keys(target).forEach((key) => delete target[key]);
        String(value || "")
          .split(";")
          .forEach((part) => {
            const idx = part.indexOf(":");
            if (idx < 0) return;
            const name = part.slice(0, idx).trim();
            if (!name) return;
            target[name] = part.slice(idx + 1).trim();
          });
        return true;
      }
      target[cssName(prop)] = value == null ? "" : String(value);
      return true;
    }
  });
}

function createDocument() {
  const listenersOf = new WeakMap();

  function listenerMap(el) {
    let map = listenersOf.get(el);
    if (!map) {
      map = {};
      listenersOf.set(el, map);
    }
    return map;
  }

  function elementChildren(node) {
    return (node.childNodes || []).filter((child) => child.nodeType === 1);
  }

  function walkElements(node, visit) {
    elementChildren(node).forEach((child) => {
      visit(child);
      walkElements(child, visit);
    });
  }

  function queryAll(root, selector) {
    const out = [];
    const includeRoot = root.nodeType === 9 || root === doc;
    const start = root.nodeType === 9 ? doc.documentElement : root;
    if (!start) return out;
    if (includeRoot && start.nodeType === 1 && matchesAny(start, selector)) out.push(start);
    walkElements(start, (el) => {
      if (matchesAny(el, selector)) out.push(el);
    });
    return out;
  }

  function makeClassList(el) {
    function classes() {
      return (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    }
    function write(list) {
      if (list.length) el._attrs.class = list.join(" ");
      else delete el._attrs.class;
    }
    return {
      add(...names) {
        const list = classes();
        names.flat().forEach((name) => {
          if (name && !list.includes(name)) list.push(name);
        });
        write(list);
      },
      remove(...names) {
        const drop = new Set(names.flat());
        write(classes().filter((name) => !drop.has(name)));
      },
      toggle(name, force) {
        const has = classes().includes(name);
        const on = force === undefined ? !has : !!force;
        if (on) this.add(name);
        else this.remove(name);
        return on;
      },
      contains(name) {
        return classes().includes(name);
      }
    };
  }

  function makeDataset(el) {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== "string") return undefined;
          const value = el.getAttribute("data-" + kebab(prop));
          return value == null ? undefined : value;
        },
        set(_target, prop, value) {
          el.setAttribute("data-" + kebab(prop), value);
          return true;
        },
        deleteProperty(_target, prop) {
          el.removeAttribute("data-" + kebab(prop));
          return true;
        }
      }
    );
  }

  function createText(data) {
    return {
      nodeType: 3,
      data: String(data),
      parentNode: null,
      get textContent() {
        return this.data;
      },
      set textContent(value) {
        this.data = String(value);
      },
      get parentElement() {
        return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
      }
    };
  }

  function createElement(tag) {
    const el = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      childNodes: [],
      parentNode: null,
      _attrs: {},
      style: createStyle(),
      ownerDocument: null
    };
    el.classList = makeClassList(el);
    el.dataset = makeDataset(el);
    el.ownerDocument = doc;

    Object.defineProperty(el, "id", {
      get() {
        return this.getAttribute("id") || "";
      },
      set(value) {
        this.setAttribute("id", value == null ? "" : String(value));
      }
    });
    Object.defineProperty(el, "className", {
      get() {
        return this.getAttribute("class") || "";
      },
      set(value) {
        this.setAttribute("class", value == null ? "" : String(value));
      }
    });
    Object.defineProperty(el, "title", {
      get() {
        return this.getAttribute("title") || "";
      },
      set(value) {
        if (value == null || value === "") this.removeAttribute("title");
        else this.setAttribute("title", String(value));
      }
    });
    Object.defineProperty(el, "hidden", {
      get() {
        return this.hasAttribute("hidden");
      },
      set(value) {
        if (value) this.setAttribute("hidden", "");
        else this.removeAttribute("hidden");
      }
    });
    Object.defineProperty(el, "textContent", {
      get() {
        return this.childNodes.map((node) => node.textContent || "").join("");
      },
      set(value) {
        this.childNodes.splice(0, this.childNodes.length);
        const text = String(value ?? "");
        if (text) this.appendChild(createText(text));
      }
    });
    Object.defineProperty(el, "innerHTML", {
      get() {
        return "";
      },
      set(html) {
        this.childNodes.splice(0, this.childNodes.length);
        parseNodes(String(html ?? ""), 0).nodes.forEach((node) => this.appendChild(node));
      }
    });
    Object.defineProperty(el, "parentElement", {
      get() {
        return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
      }
    });
    Object.defineProperty(el, "nextSibling", {
      get() {
        if (!this.parentNode) return null;
        const kids = this.parentNode.childNodes;
        const index = kids.indexOf(this);
        return index >= 0 ? kids[index + 1] || null : null;
      }
    });
    Object.defineProperty(el, "previousElementSibling", {
      get() {
        if (!this.parentNode) return null;
        const kids = this.parentNode.childNodes;
        const index = kids.indexOf(this);
        for (let i = index - 1; i >= 0; i--) {
          if (kids[i].nodeType === 1) return kids[i];
        }
        return null;
      }
    });
    Object.defineProperty(el, "children", {
      get() {
        return elementChildren(this);
      }
    });
    Object.defineProperty(el, "childElementCount", {
      get() {
        return elementChildren(this).length;
      }
    });
    Object.defineProperty(el, "firstElementChild", {
      get() {
        return elementChildren(this)[0] || null;
      }
    });
    Object.defineProperty(el, "isConnected", {
      get() {
        let node = this;
        while (node) {
          if (node.nodeType === 9) return true;
          node = node.parentNode;
        }
        return false;
      }
    });
    el.offsetWidth = 292;
    el.offsetHeight = 320;

    el.getAttribute = (name) => {
      const key = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(el._attrs, key) ? el._attrs[key] : null;
    };
    el.setAttribute = (name, value) => {
      el._attrs[String(name).toLowerCase()] = value == null ? "" : String(value);
    };
    el.removeAttribute = (name) => {
      delete el._attrs[String(name).toLowerCase()];
    };
    el.hasAttribute = (name) => Object.prototype.hasOwnProperty.call(el._attrs, String(name).toLowerCase());
    el.appendChild = (node) => {
      if (!node) return node;
      if (node.parentNode && node.parentNode.removeChild) node.parentNode.removeChild(node);
      node.parentNode = el;
      el.childNodes.push(node);
      return node;
    };
    el.removeChild = (node) => {
      const index = el.childNodes.indexOf(node);
      if (index >= 0) el.childNodes.splice(index, 1);
      if (node) node.parentNode = null;
      return node;
    };
    el.insertBefore = (node, ref) => {
      if (!node) return node;
      if (node.parentNode && node.parentNode.removeChild) node.parentNode.removeChild(node);
      node.parentNode = el;
      const index = ref ? el.childNodes.indexOf(ref) : -1;
      if (index < 0) el.childNodes.push(node);
      else el.childNodes.splice(index, 0, node);
      return node;
    };
    el.remove = () => {
      if (el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el);
    };
    el.closest = (selector) => {
      let node = el;
      while (node && node.nodeType === 1) {
        if (matchesAny(node, selector)) return node;
        node = node.parentElement;
      }
      return null;
    };
    el.matches = (selector) => matchesAny(el, selector);
    el.contains = (node) => {
      let current = node;
      while (current) {
        if (current === el) return true;
        current = current.parentNode;
      }
      return false;
    };
    el.querySelector = (selector) => queryAll(el, selector)[0] || null;
    el.querySelectorAll = (selector) => queryAll(el, selector);
    el.getBoundingClientRect = () => ({
      x: 10,
      y: 80,
      top: 80,
      left: 10,
      right: 60,
      bottom: 130,
      width: 50,
      height: 50
    });
    el.addEventListener = (type, fn) => {
      const map = listenerMap(el);
      if (!map[type]) map[type] = [];
      map[type].push(fn);
    };
    el.removeEventListener = (type, fn) => {
      const map = listenerMap(el);
      if (!map[type]) return;
      map[type] = map[type].filter((item) => item !== fn);
    };
    el._listenerTypes = () => Object.keys(listenerMap(el)).filter((type) => listenerMap(el)[type].length);
    el.dispatch = (type) => {
      const ev = {
        type: type,
        target: el,
        currentTarget: el,
        bubbles: true,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
        stopImmediatePropagation() {},
        composedPath() {
          const path = [];
          let node = el;
          while (node) {
            path.push(node);
            node = node.parentNode;
          }
          return path;
        }
      };
      (listenerMap(el)[type] || []).forEach((fn) => fn.call(el, ev));
      return ev;
    };
    return el;
  }

  const VOID_TAGS = {
    area: 1,
    base: 1,
    br: 1,
    col: 1,
    embed: 1,
    hr: 1,
    img: 1,
    input: 1,
    link: 1,
    meta: 1,
    source: 1,
    track: 1,
    wbr: 1
  };

  function parseAttrs(raw, el) {
    const re = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match;
    while ((match = re.exec(raw))) {
      const name = match[1];
      const value =
        match[2] != null ? match[2] : match[3] != null ? match[3] : match[4] != null ? match[4] : "";
      el.setAttribute(name, decode(value));
    }
  }

  function parseNodes(html, index) {
    const nodes = [];
    let i = index;
    while (i < html.length) {
      if (html[i] === "<") {
        if (html.startsWith("<!--", i)) {
          const end = html.indexOf("-->", i);
          i = end < 0 ? html.length : end + 3;
          continue;
        }
        if (html[i + 1] === "/") return { nodes: nodes, i: i };
        const gt = html.indexOf(">", i);
        if (gt < 0) break;
        let raw = html.slice(i + 1, gt).trim();
        const selfClosing = /\/$/.test(raw);
        if (selfClosing) raw = raw.replace(/\/$/, "").trim();
        const tagMatch = raw.match(/^([a-zA-Z][\w:-]*)/);
        const tag = tagMatch ? tagMatch[1] : "span";
        const el = createElement(tag);
        parseAttrs(raw.slice(tag.length), el);
        i = gt + 1;
        if (!selfClosing && !VOID_TAGS[tag.toLowerCase()]) {
          const inner = parseNodes(html, i);
          inner.nodes.forEach((node) => el.appendChild(node));
          i = inner.i;
          const close = html.indexOf(">", i);
          i = close < 0 ? html.length : close + 1;
        }
        nodes.push(el);
      } else {
        const next = html.indexOf("<", i);
        const text = html.slice(i, next < 0 ? html.length : next);
        if (text) nodes.push(createText(decode(text)));
        i = next < 0 ? html.length : next;
      }
    }
    return { nodes: nodes, i: i };
  }

  const doc = {
    nodeType: 9,
    childNodes: [],
    cookie: "",
    hidden: false,
    visibilityState: "visible",
    readyState: "complete",
    URL: "https://x.com/home"
  };
  const documentElement = createElement("html");
  const head = createElement("head");
  const body = createElement("body");
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  documentElement.parentNode = doc;
  doc.documentElement = documentElement;
  doc.head = head;
  doc.body = body;
  doc.childNodes = [documentElement];
  doc.createElement = createElement;
  doc.createTextNode = createText;
  doc.getElementById = (id) => {
    if (documentElement.id === id) return documentElement;
    let found = null;
    walkElements(documentElement, (el) => {
      if (!found && el.id === id) found = el;
    });
    return found;
  };
  doc.querySelector = (selector) => queryAll(doc, selector)[0] || null;
  doc.querySelectorAll = (selector) => queryAll(doc, selector);
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 });
  return doc;
}

function articleFor(doc, user, opts) {
  const art = doc.createElement("article");
  const cell = doc.createElement("div");
  cell.setAttribute("data-testid", "Tweet-User-Avatar");
  const link = doc.createElement("a");
  link.setAttribute("href", "/" + user);
  link.setAttribute("data-testid", "UserAvatar-Container-" + user);
  const img = doc.createElement("img");
  img.setAttribute("src", "https://pbs.twimg.com/profile_images/" + user + ".jpg");
  link.appendChild(img);
  cell.appendChild(link);
  const name = doc.createElement("div");
  name.setAttribute("data-testid", "User-Name");
  const nameLink = doc.createElement("a");
  nameLink.setAttribute("href", "/" + user);
  nameLink.textContent = user;
  name.appendChild(nameLink);
  art.appendChild(cell);
  art.appendChild(name);
  if (opts && opts.titledDot) {
    const wrap = doc.createElement("span");
    wrap.className = "xfo-dot-wrap";
    wrap.setAttribute("title", "wrapper tip");
    wrap.setAttribute("aria-label", "wrapper tip");
    const dot = doc.createElement("span");
    dot.className = "xfo-dot";
    dot.dataset.rel = "mutual";
    dot.dataset.user = user;
    dot.dataset.xfoRound = "1";
    dot.setAttribute("title", "@" + user + ": Mutual");
    dot.setAttribute("aria-label", "@" + user + ": Mutual");
    wrap.appendChild(dot);
    link.appendChild(wrap);
  }
  doc.body.appendChild(art);
  return link;
}

const store = {
  following: ["ada", "ben", "dee"],
  followers: ["ada", "cy"],
  followingIds: ["1", "2", "4"],
  followerIds: ["1", "3"],
  selfUsername: "me",
  lastSyncAt: 1700000000000,
  metricsCacheEpoch: "40",
  metricsCache: {},
  exMutuals: { v: 1, ids: { "4": "dee" }, handles: { dee: "4" } }
};

function storageGet(keys) {
  const out = {};
  const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
  list.forEach((key) => {
    if (key in store) out[key] = store[key];
  });
  return Promise.resolve(out);
}

const doc = createDocument();
const post = doc.createElement("a");
post.setAttribute("data-testid", "SideNav_NewTweet_Button");
post.setAttribute("href", "/compose/post");
post.textContent = "Post";
doc.body.appendChild(post);
const adaHost = articleFor(doc, "ada", { titledDot: true });
articleFor(doc, "ben");
articleFor(doc, "cy");
articleFor(doc, "dee");
articleFor(doc, "eve");

const fetches = [];
const errors = [];
const intervals = [];
const timeouts = new Set();
const ctx = {
  console: console,
  setTimeout(fn, ms, ...args) {
    const id = setTimeout(() => {
      timeouts.delete(id);
      try {
        fn(...args);
      } catch (err) {
        errors.push(err);
      }
    }, ms);
    timeouts.add(id);
    return id;
  },
  clearTimeout(id) {
    timeouts.delete(id);
    clearTimeout(id);
  },
  setInterval(fn, ms, ...args) {
    const id = setInterval(() => {
      try {
        fn(...args);
      } catch (err) {
        errors.push(err);
      }
    }, ms);
    intervals.push(id);
    return id;
  },
  clearInterval(id) {
    clearInterval(id);
  },
  requestAnimationFrame(fn) {
    return setTimeout(fn, 0);
  },
  cancelAnimationFrame(id) {
    clearTimeout(id);
  },
  Promise: Promise,
  Date: Date,
  Math: Math,
  JSON: JSON,
  Intl: Intl,
  URL: URL,
  URLSearchParams: URLSearchParams,
  Map: Map,
  Set: Set,
  WeakMap: WeakMap,
  WeakSet: WeakSet,
  Array: Array,
  Object: Object,
  String: String,
  Number: Number,
  Boolean: Boolean,
  RegExp: RegExp,
  Error: Error,
  BigInt: BigInt,
  Symbol: Symbol,
  isNaN: isNaN,
  parseInt: parseInt,
  encodeURIComponent: encodeURIComponent,
  decodeURIComponent: decodeURIComponent,
  AbortController: AbortController,
  document: doc,
  location: {
    origin: "https://x.com",
    protocol: "https:",
    host: "x.com",
    hostname: "x.com",
    pathname: "/home",
    href: "https://x.com/home",
    search: "",
    hash: ""
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  performance: { now: () => Date.now(), getEntriesByType: () => [] },
  MutationObserver: function MutationObserver() {
    return { observe() {}, disconnect() {}, takeRecords: () => [] };
  },
  IntersectionObserver: function IntersectionObserver() {
    return { observe() {}, disconnect() {}, unobserve() {} };
  },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ position: "static", getPropertyValue: () => "" }),
  fetch: async (url) => {
    fetches.push(String(url));
    return { ok: false, status: 0, text: async () => "", json: async () => ({}), headers: { get: () => null } };
  },
  chrome: {
    storage: {
      local: {
        get: storageGet,
        set: async (obj) => Object.assign(store, obj),
        remove: async (keys) => (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete store[key])
      },
      onChanged: { addListener() {}, removeListener() {} }
    },
    runtime: {
      id: "xfo-test",
      getURL: (p) => "chrome-extension://test/" + p,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener() {}, removeListener() {} }
    }
  },
  addEventListener() {},
  removeEventListener() {},
  postMessage() {},
  innerWidth: 1280,
  innerHeight: 800,
  scrollY: 0
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);

const scripts = manifest.content_scripts.find((entry) => !(entry.world)).js;
scripts.forEach((file) => {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx, { filename: file });
});

const HOVER_TYPES = ["mouseenter", "mouseover", "mouseleave", "mousemove", "wheel", "scroll", "pointerenter", "pointerover"];

function finish() {
  intervals.forEach((id) => clearInterval(id));
  timeouts.forEach((id) => clearTimeout(id));
}

setTimeout(() => {
  try {
    if (errors.length) throw errors[0];
    const dots = doc.querySelectorAll(".xfo-dot");
    assert(dots.length === 4, "four relationship dots are painted, got " + dots.length);
    const byRel = {};
    dots.forEach((dot) => {
      byRel[dot.dataset.rel] = dot;
      assert(!dot.hasAttribute("title"), "dot has no title attribute (" + dot.dataset.user + ")");
      assert(!dot.title, "dot title property is empty (" + dot.dataset.user + ")");
      assert(!dot.hasAttribute("aria-label"), "dot has no aria-label tooltip (" + dot.dataset.user + ")");
      assert(dot.style.pointerEvents === "none", "dot inline pointer-events is none (" + dot.dataset.user + ")");
      assert(dot.style.cursor !== "pointer", "dot does not set cursor pointer (" + dot.dataset.user + ")");
      const types = dot._listenerTypes();
      assert(types.length === 0, "dot has no listeners (" + dot.dataset.user + ": " + types.join(",") + ")");
      HOVER_TYPES.forEach((type) => {
        assert(!types.includes(type), "dot has no " + type + " listener");
      });
      let parent = dot.parentElement;
      while (parent && (parent.classList.contains("xfo-dot-wrap") || parent.classList.contains("xfo-dot-host"))) {
        assert(!parent.hasAttribute("title"), "dot wrapper has no title");
        assert(!parent.title, "dot wrapper title property is empty");
        assert(parent.style.pointerEvents === "none", "dot wrapper pointer-events is none");
        const wrapTypes = parent._listenerTypes();
        assert(wrapTypes.length === 0, "dot wrapper has no listeners (" + wrapTypes.join(",") + ")");
        parent = parent.parentElement;
      }
    });
    assert(byRel.mutual && byRel.mutual.dataset.user === "ada", "mutual dot stays green-class mutual");
    assert(byRel.following && byRel.following.dataset.user === "ben", "you-follow dot is painted");
    assert(byRel.follower && byRel.follower.dataset.user === "cy", "follows-you dot is painted");
    assert(byRel.ex_mutual && byRel.ex_mutual.dataset.user === "dee", "was-mutual dot is painted");
    assert(!doc.querySelector('article a[href="/eve"] .xfo-dot'), "unknown accounts get no dot");

    const adaWrap = adaHost.querySelector(".xfo-dot-wrap");
    assert(adaWrap, "existing dot wrapper is still in the avatar");
    assert(adaHost.style.pointerEvents !== "none", "avatar link still receives x.com hover");
    assert(adaHost._listenerTypes().length === 0, "painting a dot does not listen on the avatar");

    const fetchesBefore = fetches.length;
    dots.forEach((dot) => {
      dot.dispatch("mouseenter");
      dot.dispatch("mouseover");
      dot.dispatch("wheel");
      dot.dispatch("scroll");
    });
    const panelBefore = doc.getElementById("xfo-rail-panel");
    assert(!panelBefore || !panelBefore.classList.contains("xfo-open"), "hovering a dot does not open the rail");
    assert(fetches.length === fetchesBefore, "hovering or scrolling a dot does not fetch");

    const btn = doc.querySelector(".xfo-rail-btn");
    assert(btn, "people icon is in the rail");
    assert(btn._listenerTypes().includes("click"), "people icon keeps its click listener");
    assert(btn.getAttribute("title") === "X Follow Overlay", "people icon click target is unchanged");
    btn.dispatch("click");
    const panel = doc.getElementById("xfo-rail-panel");
    assert(panel && panel.classList.contains("xfo-open"), "people icon click opens the rail");
    assert(btn.getAttribute("aria-expanded") === "true", "people icon marks the rail expanded");
    btn.dispatch("click");
    assert(!panel.classList.contains("xfo-open"), "people icon click closes the rail again");
    assert(btn.getAttribute("aria-expanded") === "false", "people icon marks the rail collapsed");

    console.log("All inert-dot tests passed.");
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    finish();
  }
}, 800);
