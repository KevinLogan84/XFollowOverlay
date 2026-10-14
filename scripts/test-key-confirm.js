#!/usr/bin/env node
/**
 * API sync asks for the key every time, then syncs only after confirm.
 * Keys are typed in the extension frame, never in the x.com page.
 * Run: node scripts/test-key-confirm.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Key = require("../shared/key-confirm.js");
const Api = require("../shared/x-api.js");
const { bootPage, createDocument } = require("./test-dot-inert.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function inputAttr(tag, name) {
  const match = tag.match(new RegExp("(?:^|\\s)" + name + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
  return match ? match[2] : "";
}

function assertKeyFieldsAreNotLogins(html, label) {
  const tags = html.match(/<input\b[^>]*>/gi) || [];
  assert(tags.length > 0, label + " has key inputs");
  assert(!/type\s*=\s*["']password["']/i.test(html), label + " has no type=password input");
  const markupTags = html.match(/<[^>]*>/g) || [];
  assert(
    !markupTags.some((tag) => /[\s"'/]on[a-z]+\s*=/i.test(tag)),
    label + " has no inline event handlers"
  );
  tags.forEach((tag) => {
    const type = inputAttr(tag, "type");
    const id = inputAttr(tag, "id");
    const name = inputAttr(tag, "name");
    assert(type !== "password", label + " key input is not type=password");
    assert(/(?:^|\s)xfo-mask(?:\s|$)/.test(inputAttr(tag, "class")), label + " key input is masked");
    assert(inputAttr(tag, "autocomplete") === "off", label + " key input has autocomplete=off");
    assert(id && name, label + " key input has an id and a name");
    assert(!/password|user|login/i.test(id + " " + name), label + " key field name and id are not credentials");
  });
}

const root = path.join(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content/content.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "background/service-worker.js"), "utf8");
const frameJs = fs.readFileSync(path.join(root, "popup/keys-frame.js"), "utf8");
const frameHtml = fs.readFileSync(path.join(root, "popup/keys-frame.html"), "utf8");
const popupHtml = fs.readFileSync(path.join(root, "popup/popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");
const keyConfirmSrc = fs.readFileSync(path.join(root, "shared/key-confirm.js"), "utf8");
const xApiSrc = fs.readFileSync(path.join(root, "shared/x-api.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const BEARER = "bearer-token-the-user-pasted-0123456789";
const API_ERROR = "X API 403: your plan doesn't include follower lists";
const RATE_LIMIT = "X API 429: rate limit";

assert(Key.PRIVACY === "Stays on this Mac, only sent to X.", "privacy copy is the short line");
assert(
  Key.extensionOrigin("safari-web-extension://abc/popup/keys-frame.html") === "safari-web-extension://abc",
  "Safari's extension origin is the scheme and host, not URL.origin"
);
assert(
  Key.extensionOrigin("safari-web-extension://E6A1B2C3-D4E5-4789-ABCD-0123456789AB/popup/keys-frame.html") ===
    "safari-web-extension://e6a1b2c3-d4e5-4789-abcd-0123456789ab",
  "Safari's extension UUID is compared in lowercase"
);
assert(
  new URL("safari-web-extension://abc/popup/keys-frame.html").origin === "null",
  "new URL().origin hides the Safari extension origin"
);
assert(
  Key.extensionOrigin("chrome-extension://test/popup/keys-frame.html") === "chrome-extension://test",
  "a chrome-extension origin is the scheme and host"
);
assert(Key.VERIFIED_AT === "keysVerifiedAt", "verification is stored as keysVerifiedAt");

assert(Key.keysAreVerified({ keysVerifiedAt: 10, apiSyncError: "" }) === true, "a timestamp with no API error is verified");
assert(
  Key.keysAreVerified({ keysVerifiedAt: 10, apiSyncError: API_ERROR }) === false,
  "a 403 makes keys unverified"
);
assert(
  Key.keysAreVerified({ keysVerifiedAt: 10, apiSyncError: RATE_LIMIT }) === true,
  "a 429 keeps a verified key"
);
assert(
  Key.keysAreVerified({ keysVerifiedAt: 10, apiSyncError: "Sync timed out. Keep x.com open and tap Retry sync." }) ===
    true,
  "a timeout keeps a verified key"
);
assert(Key.keysAreVerified({ keysVerifiedAt: 0 }) === false, "a missing timestamp is unverified");
assert(Key.keysAreVerified({}) === false, "empty state is unverified");
assert(
  Key.frameParentOrigin({ ancestor: "safari-web-extension://abc" }) === "https://x.com",
  "an extension ancestor is not the postMessage target"
);
assert(
  Key.frameParentOrigin({
    ancestor: "safari-web-extension://abc",
    referrer: "https://twitter.com"
  }) === "https://twitter.com",
  "a page referrer wins when the ancestor is the extension"
);
assert(
  Key.frameParentOrigin({ ancestor: "https://x.com" }) === "https://x.com",
  "an x.com ancestor stays the postMessage target"
);
assert(
  Key.frameParentOrigin({ ancestor: "https://twitter.com", referrer: "https://x.com" }) === "https://twitter.com",
  "a page ancestor wins over the referrer"
);
assert(Key.savedKeyNeedsProbe({ keysVerifiedAt: 10 }) === false, "a verified key does not need another probe");
assert(Key.savedKeyNeedsProbe({ keysVerifiedAt: 0 }) === true, "an unverified key must be probed");
assert(
  Key.savedKeyNeedsProbe({ keysVerifiedAt: 10, apiSyncError: API_ERROR }) === true,
  "a 403 means Use saved key must probe"
);
assert(Key.clearsKeyVerification(401) === true, "401 clears verification");
assert(Key.clearsKeyVerification(403) === true, "403 clears verification");
assert(Key.clearsKeyVerification(429) === false, "429 does not clear verification");
assert(Key.clearsKeyVerification(0) === false, "a missing status does not clear verification");
assert(
  Key.probeRevokesVerification({ ok: false, status: 401, message: "X API 401: Unauthorized" }) === true,
  "a 401 probe revokes verification"
);
assert(
  Key.probeRevokesVerification({ ok: false, status: 429, message: RATE_LIMIT }) === false,
  "a 429 probe does not revoke verification"
);

assert(
  Key.sameKeyMaterial(
    { bearer: " abc ", apiKey: "", apiSecret: "", accessToken: "", accessSecret: "" },
    { bearer: "abc", apiKey: "", apiSecret: "", accessToken: "", accessSecret: "" }
  ),
  "whitespace does not count as a key change"
);
assert(
  Key.sameKeyMaterial({ bearer: "one" }, { bearer: "two" }) === false,
  "a new bearer is a key change"
);

const half = Key.oauthGaps({
  apiKey: "api-key-value-0123456789",
  apiSecret: "",
  accessToken: "access-token-value-0123456789",
  accessSecret: "  "
});
assert(half.half === true, "two filled OAuth fields and two blanks is half-filled");
assert(
  Key.oauthGapSentence(half.empty) === "API key secret and Access token secret are empty.",
  "half-filled OAuth names the empty fields"
);
assert(Key.oauthGaps({}).half === false, "no OAuth text is not half-filled");
assert(
  Key.oauthGaps({
    apiKey: "a",
    apiSecret: "b",
    accessToken: "c",
    accessSecret: "d"
  }).half === false,
  "a complete OAuth set is not half-filled"
);

assert(Api.savedKeyLabel(BEARER) === "Saved, ends in …6789", "a long key shows the last four characters");
assert(Api.savedKeyLabel("short") === "Saved", "a short key is masked fully");
assert(Api.savedKeyLabel("12345678") === "Saved", "an 8 character key is masked fully");
assert(Api.savedKeyLabel("123456789") === "Saved, ends in …6789", "nine characters show only the last four");
assert(Api.savedKeyLabel("   ") === "", "a blank key has no saved label");

assert(
  Key.hostForKeyForm({
    extensionUrl: "safari-web-extension://abc/popup/keys-frame.html",
    pageOrigin: "https://x.com"
  }) === "frame",
  "Safari on x.com still tries the extension iframe first"
);
assert(
  Key.hostForKeyForm({
    extensionUrl: "chrome-extension://abc/popup/keys-frame.html",
    pageOrigin: "https://x.com"
  }) === "frame",
  "Chrome on x.com tries the extension iframe first"
);
assert(
  Key.hostForKeyForm({
    extensionUrl: "chrome-extension://abc/popup/keys-frame.html",
    pageOrigin: "https://example.com"
  }) === "frame",
  "a chrome-extension frame is tried off x.com too"
);
assert(
  Key.hostForKeyForm({ extensionUrl: "", pageOrigin: "https://x.com" }) === "fallback",
  "without an extension URL there is no in-page form"
);
assert(!keyConfirmSrc.includes('type="password"'), "the content-script module has no key input markup");
assert(!keyConfirmSrc.includes("confirmFormHtml"), "there is no in-page key form template");
assert(!content.includes("Change keys"), "the rail has no Change keys button");
assert(!content.includes('type="password"'), "x.com's page source has no key inputs");
assert(!content.includes("attachShadow"), "the rail does not mount an in-page shadow form");
assert(!content.includes("frameTimedOut"), "the timeout helper is not called with a faked elapsed time");
assert(content.includes('if (choice === "api")'), "Sync with API keys is its own rail action");
assert(content.includes("showKeyForm"), "a saved token skips the key form");
assert(Key.showKeyForm({ hasKeys: false }) === true, "no saved token opens the form");
assert(Key.showKeyForm({ hasKeys: true }) === false, "a saved token syncs without the form");
assert(
  Key.showKeyForm({ hasKeys: true, apiSyncError: API_ERROR }) === true,
  "a rejected token opens the form again"
);
assert(
  Key.showKeyForm({ hasKeys: true, apiSyncError: RATE_LIMIT }) === false,
  "a rate limit reuses the saved token"
);
assert(Key.showKeyForm({ hasKeys: true, status: 401 }) === true, "a 401 opens the form again");
assert(Key.showKeyForm({ hasKeys: true, status: 429 }) === false, "a 429 does not open the form");
assert(content.includes("keysVerifiedAt"), "verification is stored");
assert(!content.includes("keyFrameBlocked"), "a missed ready message does not disable the in-panel form");
assert(!content.includes("XFO_OPEN_KEY_FRAME"), "the panel does not give up and open a key tab");
assert(!content.includes("Couldn't open the key form here"), "the panel does not fall back to the toolbar message");
assert(!content.includes('src = "about:blank"') && !content.includes('setAttribute("src", "about:blank")'), "the key iframe is never navigated to about:blank");
assert(
  /clearsKeyVerification\(err && err\.status\)/.test(content),
  "a failed API sync clears keysVerifiedAt only for an auth status"
);
assert(
  !/if \(syncPrefer === "api"\) patch\.keysVerifiedAt = null/.test(content),
  "a failed API sync does not clear verification for every error"
);
assert(content.includes('new URL(path, "https://api.x.com")'), "user API calls are built on api.x.com");
assert(/https:\\\/\\\/api\\.x\\.com\\\/2\\\//.test(worker), "the service worker only calls api.x.com/2/");
assert(worker.includes("refused"), "the service worker refuses other hosts");
const openFrame = worker.slice(worker.indexOf('msg.type === "XFO_OPEN_KEY_FRAME"'));
assert(openFrame.indexOf("popup/keys-frame.html") !== -1, "the worker opens keys-frame.html");
assert(openFrame.indexOf("tabs.create") !== -1 && openFrame.indexOf("tabs.create") < 400, "the worker opens that page in a tab");
assert(worker.includes("XFO_RELAY_TEST_KEYS"), "draft key tests are relayed by the worker");
assert(worker.includes("keyRelayBusy"), "a relayed key test cannot overlap itself");
assert(worker.includes("keyTabOpening"), "opening the key tab cannot overlap itself");
assert(worker.includes("wipeSavedApiKeys"), "the worker wipes saved keys once");
assert(popupJs.includes("wipeSavedApiKeys"), "the toolbar popup wipes saved keys once");
assert(content.includes("keyProbeDepth"), "a stored-key probe cannot re-enter");
assert(content.includes('message: "Key check already running."'), "a nested key check does not fetch");
assert(content.includes("wipeSavedApiKeys"), "content wipes saved keys once on first run");
assert(content.includes("extensionOrigin"), "the panel compares the real extension origin");
assert(/var API_KEY_WIPE = "1\.2\.11"/.test(xApiSrc), "the key wipe id is 1.2.11");
const keptStorage = [
  "following",
  "followers",
  "followingIds",
  "followerIds",
  "metricsCache",
  "syncCheckpoint",
  "passiveRelations",
  "exMutuals",
  "followIdMap",
  "lastSyncAt",
  "syncStatus",
  "syncPrefer",
  "syncError"
];
const wipePlan = Api.apiKeyWipePlan({ xApiBearer: BEARER, following: ["ada"], syncPrefer: "api" });
assert(wipePlan && wipePlan.set[Api.API_KEY_WIPE_MARKER] === "1.2.11", "the first run plans the 1.2.11 key wipe");
assert(
  Api.apiKeyWipePlan({ [Api.API_KEY_WIPE_MARKER]: "1.2.9", xApiBearer: BEARER }) !== null,
  "a 1.2.9 marker still wipes once for 1.2.11"
);
assert(
  wipePlan.remove.slice().sort().join() === Api.savedApiKeyFields().slice().sort().join(),
  "the wipe removes only saved key fields"
);
keptStorage.forEach((name) => {
  assert(wipePlan.remove.indexOf(name) === -1, "the wipe does not remove " + name);
});
["xApiBearer", "xApiKey", "xApiSecret", "xAccessToken", "xAccessSecret", "xUserToken", "xBearerToken", "xApiUserToken", "keysVerifiedAt", "apiSyncError"].forEach(
  (name) => {
    assert(wipePlan.remove.indexOf(name) !== -1, "the wipe removes " + name);
  }
);
assert(Api.apiKeyWipePlan({ [Api.API_KEY_WIPE_MARKER]: Api.API_KEY_WIPE }) === null, "a later run does not plan another wipe");
assert(!/payload\.(bearer|apiKey|apiSecret|accessToken|accessSecret)/.test(frameJs), "the frame does not post key material to the page");
assert(frameHtml.includes('name="bearer"'), "key inputs live in the extension frame");
assertKeyFieldsAreNotLogins(frameHtml, "keys frame");
assertKeyFieldsAreNotLogins(popupHtml, "toolbar popup");
assert(/-webkit-text-security:\s*disc/.test(frameHtml), "keys frame masks key text");
assert(
  /-webkit-text-security:\s*disc/.test(fs.readFileSync(path.join(root, "popup/popup.css"), "utf8")),
  "toolbar popup masks key text"
);
assert(frameHtml.includes(Key.PRIVACY), "the extension frame shows the privacy line");
assert(!frameHtml.includes("X API keys cost money"), "the frame does not say API keys cost money");
assert(!frameHtml.includes("Bearer token first"), "the frame does not lead with the bearer note");
assert(!frameHtml.includes("Use saved key"), "the frame has no Use saved key button");
assert(!frameHtml.includes(">Test<"), "the frame has no Test button");
assert(frameHtml.includes("Use free sync instead"), "the frame can switch to free sync");
assert(frameHtml.includes(">Cancel<"), "the frame can cancel");
assert(popupHtml.includes(Key.PRIVACY), "the toolbar popup shows the privacy line");
assert(popupHtml.includes("Use free sync instead"), "the toolbar offers free sync from the key form");
assert(!popupHtml.includes("Change keys"), "the toolbar has no Change keys button");
assert(!popupHtml.includes("Use saved key"), "the toolbar has no Use saved key button");
assert(!popupHtml.includes(">Test keys<"), "the toolbar has no Test keys button");
assert(!popupHtml.includes("X API keys cost money"), "the toolbar does not say API keys cost money");
assert(!frameHtml.includes("<details"), "the frame has no tucked OAuth block");
assert(!frameHtml.includes('name="apiKey"'), "the frame has no OAuth key fields");
assert(!popupHtml.includes("<details"), "the toolbar popup has no tucked OAuth block");
assert(!popupHtml.includes('name="apiKey"'), "the toolbar popup has no OAuth key fields");
assert(frameHtml.includes("X Bearer Token"), "the frame labels the bearer field");
assert(popupHtml.includes("X Bearer Token"), "the toolbar labels the bearer field");

const frameSave = frameJs.slice(
  frameJs.indexOf("async function saveAndSync"),
  frameJs.indexOf('form.addEventListener("submit"')
);
assert(frameSave.indexOf("await probe(keys)") !== -1, "Save and Sync probes the draft");
assert(
  frameSave.indexOf("await probe(keys)") < frameSave.indexOf("await persistKeys"),
  "Save and Sync tests a new key before saving it"
);
assert(
  frameSave.indexOf("if (!result || !result.ok) return") < frameSave.indexOf("await persistKeys"),
  "a bad key never overwrites a saved key in the frame"
);
assert(/if \(verified\) \{\s*runSyncOnX\("api"\);\s*return;\s*\}/.test(frameSave), "a verified saved key syncs without another probe");
const frameAfterProbe = frameSave.slice(frameSave.indexOf("probe(stored)"));
assert(frameAfterProbe.indexOf("probe(stored)") === 0, "the fallback tab probes an unverified saved key");
assert(
  frameAfterProbe.indexOf("if (!savedResult || !savedResult.ok)") < frameAfterProbe.indexOf('runSyncOnX("api")'),
  "the frame does not sync an unverified key until the probe is ok"
);
const frameEmbedded = frameSave.slice(frameSave.indexOf("if (inPageFrame())"), frameSave.indexOf("var verified"));
assert(frameEmbedded.indexOf('tellParent("use-saved"') !== -1, "the embedded frame tells the page to use the saved key");
assert(frameEmbedded.indexOf("probe(stored)") === -1, "the embedded frame does not probe a saved key itself");
assert(!/tabs\.(sendMessage|getCurrent|query)/.test(frameEmbedded), "the embedded frame does not message its host tab");
assert(frameEmbedded.indexOf("return;") !== -1, "the embedded frame returns before the tab probe");
assert(!frameJs.includes("tabs.getCurrent"), "the key frame never calls tabs.getCurrent");
const probeFn = frameJs.slice(frameJs.indexOf("async function probe"), frameJs.indexOf("function rejectIncomplete"));
const probeEmbedded = probeFn.slice(probeFn.indexOf("if (inPageFrame())"), probeFn.indexOf("} else {"));
assert(probeEmbedded.includes("XFO_RELAY_TEST_KEYS"), "an embedded draft test is relayed by the worker");
assert(!/tabs\.(sendMessage|getCurrent|query)/.test(probeEmbedded), "an embedded draft test does not touch tabs");
const loadStoredSrc = frameJs.slice(frameJs.indexOf("async function loadStored"), frameJs.indexOf("async function xTabId"));
assert(
  loadStoredSrc.indexOf("wipeSavedApiKeys") !== -1 &&
    loadStoredSrc.indexOf("wipeSavedApiKeys") < loadStoredSrc.indexOf("storage.local.get"),
  "the frame wipes saved keys once before reading them"
);

const popupSave = popupJs.slice(popupJs.indexOf("async function saveKeys"), popupJs.indexOf("async function noteVerified"));
assert(
  popupSave.indexOf("probeKeysOnTab") < popupSave.indexOf("storage.local.set"),
  "the popup tests a new key before saving it"
);
assert(
  popupSave.indexOf("if (!result || !result.ok)") < popupSave.indexOf("storage.local.set") &&
    popupSave.indexOf("return noteVerified(keys, result)") < popupSave.indexOf("storage.local.set"),
  "a bad key never overwrites a saved key in the popup"
);
assert(
  /if \(verified\) \{[\s\S]*?startSyncOnTab\("api"\);\s*return;\s*\}/.test(popupSave),
  "the popup syncs a verified saved key without another probe"
);
const popupAfterProbe = popupSave.slice(popupSave.indexOf("probeKeysOnTab(keys)"));
assert(
  popupAfterProbe.indexOf("if (!result || !result.ok)") < popupAfterProbe.indexOf('startSyncOnTab("api")'),
  "the popup does not sync an unverified key until the probe is ok"
);

const resources = (manifest.web_accessible_resources || [])[0].resources;
assert(resources.indexOf("popup/keys-frame.html") !== -1, "keys-frame.html stays web accessible");
assert(
  !resources.some((item) => String(item).indexOf("shared/") === 0),
  "the key-confirm module is not web accessible"
);
const scripts = manifest.content_scripts.find((entry) => (entry.js || []).includes("content/content.js")).js;
assert(
  scripts.indexOf("shared/key-confirm.js") !== -1 &&
    scripts.indexOf("shared/key-confirm.js") < scripts.indexOf("content/content.js"),
  "key-confirm.js loads before the content script"
);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackedPage(options) {
  const writes = [];
  const messages = [];
  let live = null;
  const store = Object.assign(
    { metricsCacheEpoch: "40", metricsCache: {} },
    options.store || {}
  );
  if (
    options.keepSavedKeys !== false &&
    !Object.prototype.hasOwnProperty.call(store, Api.API_KEY_WIPE_MARKER)
  ) {
    store[Api.API_KEY_WIPE_MARKER] = Api.API_KEY_WIPE;
  }
  const page = bootPage({
    store: store,
    titledDot: false,
    populateFeed: false,
    origin: options.origin,
    getURL: options.getURL,
    runtimeSendMessage(msg, listeners) {
      messages.push(msg);
      if (options.onRuntimeMessage) return options.onRuntimeMessage(msg, listeners);
      return Promise.resolve();
    },
    storageGet(keys, pageStore) {
      live = pageStore;
      const out = {};
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : [];
      list.forEach((key) => {
        if (key in pageStore) out[key] = pageStore[key];
      });
      return Promise.resolve(out);
    },
    storageSet(obj, pageStore) {
      live = pageStore;
      writes.push(Object.assign({}, obj));
      Object.assign(pageStore, obj);
      return Promise.resolve();
    }
  });
  return { page: page, writes: writes, messages: messages, live: () => live };
}

function keyInputs(node, found) {
  found = found || [];
  if (!node || !node.querySelectorAll) return found;
  node.querySelectorAll("input, textarea").forEach((el) => found.push(el));
  node.querySelectorAll("*").forEach((el) => {
    if (el._shadow) keyInputs(el._shadow, found);
    if (el.shadowRoot) keyInputs(el.shadowRoot, found);
  });
  return found;
}

function anyShadow(node) {
  if (!node || !node.querySelectorAll) return false;
  const all = node.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    if (all[i]._shadow || all[i].shadowRoot) return true;
  }
  return false;
}

async function openApi(tracked) {
  await wait(700);
  if (tracked.page.errors.length) throw tracked.page.errors[0];
  const btn = tracked.page.doc.querySelector(".xfo-rail-btn");
  assert(btn, "people icon is in the rail");
  btn.dispatch("click");
  await wait(40);
  const panel = tracked.page.doc.getElementById("xfo-rail-panel");
  assert(panel && panel.classList.contains("xfo-open"), "people icon opens the panel");
  const before = tracked.writes.length;
  const apiBtn = panel.querySelector('[data-xfo-sync="api"]');
  assert(apiBtn && apiBtn.textContent === "Sync with API keys", "the paid sync button is labeled");
  apiBtn.dispatch("click");
  await wait(80);
  return { panel: panel, before: before, apiBtn: apiBtn };
}

function wroteKeys(writes, start) {
  return writes.slice(start).some((obj) =>
    ["xApiKey", "xApiSecret", "xAccessToken", "xAccessSecret", "xApiBearer", "xUserToken"].some(
      (name) => Object.prototype.hasOwnProperty.call(obj, name)
    )
  );
}

function prefer(writes, start) {
  const hit = writes.slice(start).filter((obj) => obj.syncPrefer);
  return hit.length ? hit[hit.length - 1].syncPrefer : "";
}

function assertNoKeyInputs(doc, label) {
  const inputs = keyInputs(doc);
  assert(inputs.length === 0, label + " has no key input in the page DOM");
  assert(!anyShadow(doc), label + " has no shadow root");
  assert(!doc.querySelector("[data-xfo-key-pop]"), label + " has no in-page key popup");
  assert(!doc.querySelector('input[type="password"]'), label + " has no password field");
}

function frameOrigin() {
  return "chrome-extension://test";
}

function postFrame(tracked, panel, action) {
  const frame = panel.querySelector("[data-xfo-key-frame]");
  assert(frame, "the extension frame is in the panel");
  const win = {};
  frame.contentWindow = win;
  const handler = tracked.page.ctx.__xfoKeysFrameMessage;
  assert(typeof handler === "function", "the frame message handler is installed");
  handler({
    origin: frameOrigin(),
    source: win,
    data: { source: "xfo-keys-frame", action: action }
  });
}

function signIn(page) {
  page.doc.cookie = "ct0=csrf-token; twid=" + encodeURIComponent('"u=123456789"');
}

const unverified = trackedPage({ origin: "https://x.com", store: { xApiBearer: BEARER } });
const verified = trackedPage({
  origin: "https://x.com",
  store: { xApiBearer: BEARER, keysVerifiedAt: 1700000000000 }
});
const failed = trackedPage({
  origin: "https://x.com",
  store: {
    xApiBearer: BEARER,
    keysVerifiedAt: 1700000000000,
    apiSyncError: API_ERROR,
    lastSyncAt: 1700000000000
  }
});
const halfPage = trackedPage({
  origin: "https://x.com",
  store: {
    xApiKey: "api-key-value-0123456789",
    xAccessToken: "access-token-value-0123456789"
  }
});
const framePage = trackedPage({ origin: "https://x.com", store: {} });
const safariPage = trackedPage({
  origin: "https://x.com",
  store: {},
  getURL: (p) => "safari-web-extension://E6A1B2C3-D4E5-4789-ABCD-0123456789AB/" + p
});
const probeOk = trackedPage({
  origin: "https://x.com",
  store: { xApiBearer: BEARER, apiSyncError: API_ERROR }
});
const migrated = trackedPage({
  origin: "https://x.com",
  keepSavedKeys: false,
  store: {
    xApiBearer: BEARER,
    xApiKey: "api-key-value-0123456789",
    xApiSecret: "api-secret-value-0123456789",
    xAccessToken: "access-token-value-0123456789",
    xAccessSecret: "access-secret-value-0123456789",
    xUserToken: "user-token-value-0123456789xx",
    xBearerToken: "bearer-token-alt-0123456789",
    xApiUserToken: "api-user-token-0123456789xx",
    keysVerifiedAt: 1700000000000,
    apiSyncError: API_ERROR,
    following: ["ada"],
    followers: ["ben"],
    followingIds: ["1"],
    followerIds: ["2"],
    metricsCache: { ada: 1 },
    syncCheckpoint: { side: "following" },
    passiveRelations: { v: 1 },
    exMutuals: { v: 1 },
    followIdMap: { ada: "1" },
    lastSyncAt: 1700000000000,
    syncStatus: "ok",
    syncPrefer: "api",
    syncError: "leave-me"
  }
});
const ping = { apiFetches: 0, maxStack: 0, stack: 0 };
const pingPage = trackedPage({
  origin: "https://x.com",
  store: { xApiBearer: BEARER, apiSyncError: API_ERROR },
  onRuntimeMessage(msg, listeners) {
    if (!msg || msg.type !== "XFO_API_FETCH") {
      return Promise.resolve({ ok: false, status: 0, json: null, text: "", headers: {} });
    }
    ping.stack += 1;
    ping.apiFetches += 1;
    if (ping.stack > ping.maxStack) ping.maxStack = ping.stack;
    if (ping.stack > 6) {
      ping.stack -= 1;
      return Promise.resolve({
        ok: false,
        status: 0,
        json: null,
        text: "API fetch ping-pong",
        headers: {}
      });
    }
    (listeners || []).forEach((fn) => {
      fn({ type: "XFO_TEST_KEYS", keys: { bearer: BEARER } }, { id: "xfo-test" }, function () {});
    });
    ping.stack -= 1;
    return Promise.resolve({
      ok: false,
      status: 401,
      json: { title: "Unauthorized" },
      text: "Unauthorized",
      headers: {}
    });
  }
});

function bootSavedKeyFrame() {
  const doc = createDocument();
  const bodyHtml = frameHtml.slice(frameHtml.indexOf("<body>") + 6, frameHtml.indexOf("<script"));
  doc.body.innerHTML = bodyHtml;
  const form = doc.getElementById("keys-form");
  const named = {};
  form.querySelectorAll("input, textarea, button, select").forEach((el) => {
    const name = el.getAttribute("name");
    if (name) named[name] = el;
  });
  form.elements = named;
  doc.referrer = "";
  const posts = [];
  const errors = [];
  const listeners = [];
  const parent = {
    postMessage(payload, origin) {
      posts.push({ payload: payload, origin: origin });
      if (payload && payload.action === "use-saved") {
        if (posts.filter((item) => item.payload && item.payload.action === "use-saved").length > 4) {
          throw new Error("Save and Sync re-entered");
        }
        const formEl = doc.getElementById("keys-form");
        if (formEl) formEl.dispatch("submit");
      }
    }
  };
  const calls = { tab: 0, runtime: 0 };
  function tabBomb() {
    calls.tab += 1;
    if (calls.tab > 4) throw new Error("tabs ping-pong");
    const formEl = doc.getElementById("keys-form");
    if (formEl) formEl.dispatch("submit");
    return Promise.resolve([{ id: 1 }]);
  }
  const store = {};
  store[Api.API_KEY_WIPE_MARKER] = Api.API_KEY_WIPE;
  store.xApiBearer = BEARER;
  const ctx = {
    console: console,
    setTimeout(fn, ms) {
      const id = setTimeout(fn, ms);
      if (ms >= 1000 && id.unref) id.unref();
      return id;
    },
    clearTimeout: clearTimeout,
    Promise: Promise,
    Date: Date,
    Math: Math,
    JSON: JSON,
    URL: URL,
    document: doc,
    location: {
      ancestorOrigins: ["safari-web-extension://abc"],
      href: "safari-web-extension://abc/popup/keys-frame.html",
      origin: "safari-web-extension://abc"
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const out = {};
            const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : [];
            list.forEach((key) => {
              if (key in store) out[key] = store[key];
            });
            return out;
          },
          async set(obj) {
            Object.assign(store, obj);
          },
          async remove(keys) {
            (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete store[key]);
          }
        }
      },
      tabs: {
        getCurrent: tabBomb,
        query: tabBomb,
        sendMessage() {
          return tabBomb();
        }
      },
      runtime: {
        id: "xfo-test",
        sendMessage() {
          calls.runtime += 1;
          if (calls.runtime > 4) throw new Error("runtime ping-pong");
          const formEl = doc.getElementById("keys-form");
          if (formEl) formEl.dispatch("submit");
          return Promise.resolve({ ok: false, message: "runtime ping-pong" });
        }
      }
    },
    addEventListener(type, fn) {
      if (type === "message") listeners.push(fn);
    },
    removeEventListener() {},
    parent: parent
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  ["shared/x-api.js", "shared/key-confirm.js", "popup/keys-frame.js"].forEach((file) => {
    try {
      vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx, { filename: file });
    } catch (err) {
      errors.push(err);
    }
  });
  return {
    doc: doc,
    posts: posts,
    errors: errors,
    listeners: listeners,
    parent: parent,
    get tabCalls() {
      return calls.tab;
    },
    get runtimeCalls() {
      return calls.runtime;
    }
  };
}

Promise.all([
  (async () => {
    const opened = await openApi(unverified);
    const frame = opened.panel.querySelector("[data-xfo-key-frame]");
    assert(frame && frame.hidden === true, "a saved token does not open the key form");
    assert(!String(frame.getAttribute("src") || "").includes("keys-frame.html"), "a saved token does not load the key frame");
    assertNoKeyInputs(unverified.page.doc, "x.com");
    assert(!unverified.page.doc.body.textContent.includes(BEARER), "the full bearer is not written into the page");
    assert(prefer(unverified.writes, opened.before) === "api", "a saved token starts an API sync");
    assert(!wroteKeys(unverified.writes, opened.before), "reusing a saved token does not rewrite it");
    assert(unverified.live().xApiBearer === BEARER, "the stored bearer stays in extension storage");
    opened.apiBtn.dispatch("click");
    await wait(40);
    const again = opened.panel.querySelector("[data-xfo-key-frame]");
    assert(again && again.hidden === true, "a later sync still skips the form");
  })(),
  (async () => {
    const opened = await openApi(verified);
    const frame = opened.panel.querySelector("[data-xfo-key-frame]");
    assert(frame && frame.hidden === true, "a verified token does not open the key form");
    assertNoKeyInputs(verified.page.doc, "x.com with a verified key");
    assert(prefer(verified.writes, opened.before) === "api", "a verified token syncs without the form");
    assert(!wroteKeys(verified.writes, opened.before), "Use saved key does not rewrite the stored bearer");
  })(),
  (async () => {
    const opened = await openApi(failed);
    await wait(40);
    const err = opened.panel.querySelector("[data-xfo-err]");
    assert(err && err.textContent === API_ERROR, "a stored 403 is shown on the rail");
    assert(prefer(failed.writes, opened.before) !== "api", "an API error does not sync before confirmation");
    signIn(failed.page);
    failed.page.ctx.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"title":"Unauthorized"}',
      json: async () => ({ title: "Unauthorized" }),
      headers: { get: () => null }
    });
    postFrame(failed, opened.panel, "use-saved");
    await wait(80);
    assert(prefer(failed.writes, opened.before) !== "api", "a 401 probe does not start an API sync");
    assert(
      failed.writes.slice(opened.before).some((obj) => obj.keysVerifiedAt === null),
      "a 401 probe clears keysVerifiedAt"
    );
    assert(failed.live().xApiBearer === BEARER, "a rejected probe does not overwrite the saved bearer");
    assertNoKeyInputs(failed.page.doc, "x.com after a rejected probe");
  })(),
  (async () => {
    const opened = await openApi(halfPage);
    assertNoKeyInputs(halfPage.page.doc, "x.com with half-filled OAuth");
    const live = halfPage.live();
    assert(live.xApiKey === "api-key-value-0123456789", "opening the form keeps the stored API key");
    assert(!live.xApiSecret, "opening the form does not invent an API secret");
    assert(live.xAccessToken === "access-token-value-0123456789", "opening the form keeps the stored access token");
    assert(!wroteKeys(halfPage.writes, opened.before), "half-filled OAuth is not cleared automatically");
  })(),
  (async () => {
    const opened = await openApi(framePage);
    const frame = opened.panel.querySelector("[data-xfo-key-frame]");
    const note = opened.panel.querySelector("[data-xfo-key-fallback]");
    assert(frame && frame.hidden === false, "on x.com the extension frame is shown");
    assert(note.hidden === true, "the fallback stays hidden while the frame can still load");
    assertNoKeyInputs(framePage.page.doc, "x.com while the frame loads");
    await wait(50);
    assert(frame.hidden !== true, "the key form stays in the panel");
    assert(note.hidden === true, "the toolbar fallback stays hidden");
    assert(!note.textContent, "the panel does not tell the user to use the toolbar");
    assert(
      !framePage.messages.some((msg) => msg && msg.type === "XFO_OPEN_KEY_FRAME"),
      "the panel does not open a key tab"
    );
    assert(String(frame.getAttribute("src") || "").indexOf("popup/keys-frame.html") !== -1, "the iframe keeps the key form");
    assert(prefer(framePage.writes, opened.before) !== "api", "opening the form does not start an API sync");
    const handler = framePage.page.ctx.__xfoKeysFrameMessage;
    handler({
      origin: "safari-web-extension://abc",
      source: { notTheContentWindow: true },
      data: { source: "xfo-keys-frame", action: "ready" }
    });
    assert(frame.getAttribute("data-xfo-ready") !== "1", "a foreign extension origin is ignored");
    opened.apiBtn.dispatch("click");
    await wait(40);
    const again = opened.panel.querySelector("[data-xfo-key-frame]");
    assert(again && again.hidden !== true, "a later click opens the form again");
    assert(String(again.getAttribute("src") || "").indexOf("popup/keys-frame.html") !== -1, "a later click reloads the key form");
    assertNoKeyInputs(framePage.page.doc, "x.com after opening the form again");
  })(),
  (async () => {
    const opened = await openApi(safariPage);
    const frame = opened.panel.querySelector("[data-xfo-key-frame]");
    const note = opened.panel.querySelector("[data-xfo-key-fallback]");
    assert(
      String(frame.getAttribute("src") || "").indexOf(
        "safari-web-extension://E6A1B2C3-D4E5-4789-ABCD-0123456789AB/popup/keys-frame.html"
      ) === 0,
      "Safari loads the extension key page"
    );
    const handler = safariPage.page.ctx.__xfoKeysFrameMessage;
    handler({
      origin: "safari-web-extension://e6a1b2c3-d4e5-4789-abcd-0123456789ab",
      source: { safariWrapsContentWindow: true },
      data: { source: "xfo-keys-frame", action: "ready" }
    });
    assert(frame.getAttribute("data-xfo-ready") === "1", "a lowercase Safari origin matches an uppercase getURL");
    assert(note.hidden === true, "a loaded Safari frame does not show the toolbar fallback");
    assert(!safariPage.messages.some((msg) => msg && msg.type === "XFO_OPEN_KEY_FRAME"), "Safari does not open a key tab");
  })(),
  (async () => {
    const opened = await openApi(probeOk);
    signIn(probeOk.page);
    probeOk.page.ctx.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"data":[]}',
      json: async () => ({ data: [] }),
      headers: { get: () => null }
    });
    postFrame(probeOk, opened.panel, "use-saved");
    await wait(80);
    assert(prefer(probeOk.writes, opened.before) === "api", "Use saved key syncs after the probe returns ok");
    assert(
      probeOk.writes.slice(opened.before).some((obj) => Number(obj.keysVerifiedAt) > 0),
      "a successful probe records keysVerifiedAt"
    );
    assert(probeOk.live().xApiBearer === BEARER, "a successful probe of the saved key does not replace it");
    assertNoKeyInputs(probeOk.page.doc, "x.com after a successful probe");
  })(),
  (async () => {
    const mem = {
      xApiBearer: BEARER,
      xApiKey: "api-key-value-0123456789",
      xApiSecret: "api-secret-value-0123456789",
      following: ["ada"],
      syncPrefer: "api",
      metricsCache: { ada: 1 }
    };
    const storage = {
      async get(keys) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
          if (key in mem) out[key] = mem[key];
        });
        return out;
      },
      async remove(keys) {
        (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete mem[key]);
      },
      async set(obj) {
        Object.assign(mem, obj);
      }
    };
    assert(await Api.wipeSavedApiKeys(storage) === true, "the first wipe runs");
    assert(!mem.xApiBearer, "the first wipe drops the bearer");
    assert(!mem.xApiKey && !mem.xApiSecret, "the first wipe drops the consumer keys");
    assert(mem.following[0] === "ada", "the first wipe keeps follows");
    assert(mem.syncPrefer === "api", "the first wipe keeps the sync choice");
    assert(mem.metricsCache.ada === 1, "the first wipe keeps the metrics cache");
    assert(mem[Api.API_KEY_WIPE_MARKER] === "1.2.11", "the first wipe records 1.2.11");
    mem.xApiBearer = "new-bearer-after-wipe-0123456789";
    assert(await Api.wipeSavedApiKeys(storage) === false, "the second wipe does not run");
    assert(mem.xApiBearer === "new-bearer-after-wipe-0123456789", "a key saved after the wipe stays");
  })(),
  (async () => {
    const opened = await openApi(migrated);
    const live = migrated.live();
    assert(live, "the migration read storage");
    [
      "xApiBearer",
      "xApiKey",
      "xApiSecret",
      "xAccessToken",
      "xAccessSecret",
      "xUserToken",
      "xBearerToken",
      "xApiUserToken",
      "keysVerifiedAt",
      "apiSyncError"
    ].forEach((name) => {
      assert(live[name] == null, "1.2.11 clears " + name);
    });
    assert(live.following[0] === "ada" && live.followers[0] === "ben", "1.2.11 keeps follow lists");
    assert(live.followingIds[0] === "1" && live.followerIds[0] === "2", "1.2.11 keeps follow ids");
    assert(live.metricsCache.ada === 1, "1.2.11 keeps the metrics cache");
    assert(live.syncCheckpoint.side === "following", "1.2.11 keeps the sync checkpoint");
    assert(live.passiveRelations.v === 1, "1.2.11 keeps passive relations");
    assert(live.exMutuals.v === 1, "1.2.11 keeps ex-mutuals");
    assert(live.followIdMap.ada === "1", "1.2.11 keeps the follow id map");
    assert(live.lastSyncAt === 1700000000000, "1.2.11 keeps the last sync time");
    assert(live.syncStatus === "ok", "1.2.11 keeps sync status");
    assert(live.syncPrefer === "api", "1.2.11 keeps the sync choice");
    assert(live.syncError === "leave-me", "1.2.11 keeps a sync error that is not an API-key error");
    assert(live[Api.API_KEY_WIPE_MARKER] === "1.2.11", "1.2.11 records the key wipe");
    assert(!opened.panel.textContent.includes(BEARER), "the cleared bearer is not written into the page");
    assertNoKeyInputs(migrated.page.doc, "x.com after the key wipe");
  })(),
  (async () => {
    const opened = await openApi(pingPage);
    signIn(pingPage.page);
    const beforeFetches = ping.apiFetches;
    postFrame(pingPage, opened.panel, "use-saved");
    await wait(120);
    assert(pingPage.page.errors.length === 0, "the echoed key check does not throw");
    assert(ping.apiFetches - beforeFetches === 1, "an echoed XFO_TEST_KEYS during the probe does not fetch again");
    assert(ping.maxStack === 1, "the echoed key check does not nest another API fetch");
    assert(prefer(pingPage.writes, opened.before) !== "api", "a ping-pong probe does not start an API sync");
    assert(pingPage.live().xApiBearer === BEARER, "the ping-pong probe leaves the saved bearer in place");
  })(),
  (async () => {
    const frame = bootSavedKeyFrame();
    await wait(80);
    if (frame.errors.length) throw frame.errors[0];
    const button = frame.doc.getElementById("save-sync");
    const bearerInput = frame.doc.getElementById("xfo-bearer");
    assert(bearerInput && bearerInput.value === BEARER, "a saved key is shown masked in the field");
    assert(bearerInput.getAttribute("type") === "text", "the saved key field stays type=text");
    assert(!frame.doc.getElementById("use-saved"), "there is no Use saved key button");
    assert(button && button.textContent === "Sync", "a saved key keeps one Sync button");
    frame.doc.getElementById("keys-form").dispatch("submit");
    const savedPosts = frame.posts.filter((item) => item.payload && item.payload.action === "use-saved");
    assert(savedPosts.length === 1, "Save and Sync posts once when the parent delivers the submit again");
    assert(savedPosts[0].origin === "https://x.com", "Save and Sync posts to x.com, not the extension origin");
    assert(!JSON.stringify(savedPosts[0].payload).includes(BEARER), "Save and Sync does not post the bearer");
    assert(frame.tabCalls === 0, "Save and Sync in the iframe does not call tabs");
    assert(frame.runtimeCalls === 0, "Save and Sync in the iframe does not message the background");
    frame.listeners.forEach((fn) => {
      fn({
        source: frame.parent,
        origin: "https://x.com",
        data: { source: "xfo-content", action: "probe-status", message: "X API 401: Unauthorized" }
      });
    });
    const status = frame.doc.getElementById("keys-status");
    assert(status && status.textContent === "X API 401: Unauthorized", "the frame shows a rejection from X");
    assert(
      frame.posts.filter((item) => item.payload && item.payload.action === "use-saved").length === 1,
      "a probe status does not submit Save and Sync again"
    );
  })()
])
  .then(() => {
    unverified.page.finish();
    verified.page.finish();
    failed.page.finish();
    halfPage.page.finish();
    framePage.page.finish();
    safariPage.page.finish();
    probeOk.page.finish();
    migrated.page.finish();
    pingPage.page.finish();
    console.log("All key-confirm tests passed.");
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    try {
      unverified.page.finish();
      verified.page.finish();
      failed.page.finish();
      halfPage.page.finish();
      framePage.page.finish();
      safariPage.page.finish();
      probeOk.page.finish();
      migrated.page.finish();
      pingPage.page.finish();
    } catch (e) {
      /* already torn down */
    }
    process.exit(1);
  });
