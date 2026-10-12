#!/usr/bin/env node
/**
 * Loads the Mac companion setup page the way its WKWebView does:
 * every local script, stylesheet, and image referenced from Main.html
 * must exist under Shared (App)/Resources, and the scripts must run
 * against that HTML without throwing or closing the window.
 *
 * Run: node scripts/test-companion-page.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = path.join(__dirname, "..");
const resourcesDir = path.join(root, "Safari/X Follow Overlay/Shared (App)/Resources");
const htmlPath = path.join(resourcesDir, "Base.lproj/Main.html");
const htmlDir = path.dirname(htmlPath);
const html = fs.readFileSync(htmlPath, "utf8");

function resolveLocal(url, label) {
  assert(url, label + " is missing a path");
  assert(!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url), label + " must be a bundle file, got " + url);
  const abs = path.resolve(htmlDir, url.split("#")[0].split("?")[0]);
  const rel = path.relative(resourcesDir, abs);
  assert(rel && !rel.startsWith("..") && !path.isAbsolute(rel), url + " escapes Shared (App)/Resources");
  assert(fs.existsSync(abs) && fs.statSync(abs).isFile(), url + " is not a file in Shared (App)/Resources");
  assert(fs.statSync(abs).size > 0, url + " is empty");
  return abs;
}

function attr(raw, name) {
  const match = raw.match(new RegExp("\\b" + name + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
  return match ? match[2] : "";
}

function makeElement(tag, className) {
  const classes = String(className || "").split(/\s+/).filter(Boolean);
  const listeners = {};
  const el = { tag: tag.toLowerCase(), classes: classes, textContent: "" };
  el.classList = {
    add(...names) {
      names.forEach((name) => {
        if (name && !el.classes.includes(name)) el.classes.push(name);
      });
    },
    remove(...names) {
      el.classes = el.classes.filter((name) => !names.includes(name));
    },
    toggle(name, force) {
      const has = el.classes.includes(name);
      const on = force === undefined ? !has : !!force;
      if (on) el.classList.add(name);
      else el.classList.remove(name);
      return on;
    },
    contains(name) {
      return el.classes.includes(name);
    }
  };
  el.addEventListener = (type, fn) => {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(fn);
  };
  el.click = () => {
    let prevented = false;
    (listeners.click || []).forEach((fn) => {
      fn({
        preventDefault() {
          prevented = true;
        }
      });
    });
    return prevented;
  };
  return el;
}

function matches(el, selector) {
  const parts = String(selector).trim().split(".");
  const tag = parts[0].toLowerCase();
  const classes = parts.slice(1);
  if (tag && el.tag !== tag) return false;
  return classes.every((name) => el.classes.includes(name));
}

const elements = [];
const scriptPaths = [];
let body = null;
const tagRe = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
let tagMatch;
while ((tagMatch = tagRe.exec(html))) {
  const tag = tagMatch[1].toLowerCase();
  const raw = tagMatch[2] || "";
  if (tag === "script" && attr(raw, "src")) {
    scriptPaths.push(resolveLocal(attr(raw, "src"), "script"));
  } else if (tag === "link" && attr(raw, "href")) {
    resolveLocal(attr(raw, "href"), "stylesheet");
  } else if (tag === "img" && attr(raw, "src")) {
    resolveLocal(attr(raw, "src"), "image");
  }
  if (tag === "script" || tag === "link" || tag === "meta") continue;
  const el = makeElement(tag, attr(raw, "class"));
  elements.push(el);
  if (tag === "body") body = el;
}

assert(scriptPaths.length > 0, "Main.html loads at least one script");
assert(
  scriptPaths.some((file) => file.endsWith(path.sep + "Script.js")),
  "Main.html loads Script.js from Shared (App)/Resources"
);
if (!body) {
  body = makeElement("body", "");
  elements.unshift(body);
}

const messages = [];
let closed = false;
const documentStub = {
  get body() {
    return body;
  },
  querySelector(selector) {
    return elements.find((el) => matches(el, selector)) || null;
  }
};
const ctx = {
  console: console,
  document: documentStub,
  webkit: {
    messageHandlers: {
      controller: {
        postMessage(msg) {
          messages.push(String(msg));
        }
      }
    }
  },
  close() {
    closed = true;
  }
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

scriptPaths.forEach((file) => {
  const source = fs.readFileSync(file, "utf8");
  assert(!/\bwindow\.close\s*\(/.test(source), path.basename(file) + " must not call window.close");
  try {
    vm.runInContext(source, ctx, { filename: path.relative(root, file) });
  } catch (err) {
    throw new Error(path.relative(root, file) + " threw while loading: " + err.message);
  }
});

assert(typeof ctx.show === "function", "setup page defines show()");
assert(closed === false, "loading the setup page does not close the window");

ctx.show("mac", true, true);
assert(body.classes.includes("platform-mac"), "show('mac') marks the page as Mac");
assert(body.classes.includes("state-on") && !body.classes.includes("state-off"), "enabled state is on");
const prefs = documentStub.querySelector("button.open-preferences");
const openX = documentStub.querySelector("button.open-x");
const feedback = documentStub.querySelector("a.feedback");
assert(prefs && openX && feedback, "setup page has the Mac actions");
assert(String(prefs.textContent).includes("Open Safari Settings"), "settings button is renamed on modern macOS");
prefs.click();
openX.click();
const prevented = feedback.click();
assert(messages.join(",") === "open-preferences,open-x,open-feedback", "actions post to the native controller");
assert(prevented === true, "the support link does not navigate the web view");
assert(closed === false, "clicking the setup actions does not close the window");

ctx.show("mac");
assert(!body.classes.includes("state-on") && !body.classes.includes("state-off"), "unknown extension state clears on/off");
ctx.show("ios");
assert(body.classes.includes("platform-ios"), "show('ios') marks the iOS page");

console.log("All companion-page tests passed.");
