#!/usr/bin/env node
/**
 * Executes the manifest's isolated-world content scripts, in manifest order,
 * against stubbed browser globals. Catches what the text-reading guardrails
 * cannot: a missing shared module, a bad destructure, a TDZ or
 * ReferenceError at load, or a rejection in the first init ticks.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const isolated = manifest.content_scripts.find((s) => !s.world);

const errors = [];
const store = {};
const storage = {
  local: {
    get: async (keys) => {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
        if (k in store) out[k] = store[k];
      });
      return out;
    },
    set: async (obj) => Object.assign(store, obj),
    remove: async (keys) => (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k])
  },
  onChanged: { addListener() {} }
};
const el = () => ({
  setAttribute() {},
  getAttribute: () => null,
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
  style: {},
  dataset: {},
  closest: () => null,
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
});
const documentStub = Object.assign(el(), {
  documentElement: el(),
  head: el(),
  body: el(),
  cookie: "",
  hidden: false,
  readyState: "complete",
  createElement: () => el(),
  getElementById: () => null
});
const ctx = {
  console,
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  requestIdleCallback: (fn) => setTimeout(fn, 1),
  requestAnimationFrame: (fn) => setTimeout(fn, 1),
  Promise, Date, Math, JSON, Intl, URL, URLSearchParams, Map, Set, WeakMap, WeakSet,
  Array, Object, String, Number, Boolean, RegExp, Error, BigInt, Symbol, isNaN, parseInt,
  encodeURIComponent, decodeURIComponent, AbortController,
  document: documentStub,
  location: { origin: "https://x.com", pathname: "/home", href: "https://x.com/home" },
  localStorage: { getItem: () => null },
  performance: { getEntriesByType: () => [] },
  MutationObserver: function () {
    return { observe() {}, disconnect() {} };
  },
  IntersectionObserver: function () {
    return { observe() {}, disconnect() {}, unobserve() {} };
  },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  fetch: async () => ({ ok: false, status: 0, text: async () => "", json: async () => ({}), headers: { get: () => null } }),
  chrome: { storage, runtime: { getURL: (p) => p, id: "x" } },
  addEventListener() {},
  removeEventListener() {},
  postMessage() {},
  innerHeight: 800,
  scrollY: 0
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);
process.on("unhandledRejection", (e) => errors.push("unhandled: " + (e && e.name ? e.name + ": " + e.message : e)));

for (const file of isolated.js) {
  try {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx, { filename: file });
  } catch (e) {
    errors.push(file + ": " + e.name + ": " + e.message);
  }
}
store.settings = { showBadges: true };
store.metricsSyncPending = 3;

setTimeout(() => {
  if (errors.length) {
    console.error("content scripts failed to load cleanly:\n  " + errors.join("\n  "));
    process.exit(1);
  }
  if (ctx.__xfoVersion !== require(path.join(root, "manifest.json")).version) {
    console.error("content.js did not start (version " + ctx.__xfoVersion + ")");
    process.exit(1);
  }
  if ("settings" in store || "metricsSyncPending" in store) {
    console.error("retired popup keys were not cleared on load");
    process.exit(1);
  }
  const seeded = [
    "selfUsername",
    "following",
    "followers",
    "followingIds",
    "followerIds",
    "xApiKey",
    "xApiSecret",
    "xAccessToken",
    "xAccessSecret",
    "xApiBearer",
    "xUserToken",
    "xBearerToken"
  ];
  seeded.forEach((key) => {
    if (store[key]) {
      console.error("fresh load wrote " + key);
      process.exit(1);
    }
  });
  if (/kevin/i.test(JSON.stringify(store))) {
    console.error("fresh load stored personal fixture data");
    process.exit(1);
  }
  console.log("All content-load tests passed.");
}, 1500);
