/* Classic script for Chrome + Safari MV3 — sync + counts live on the x.com rail. */

try {
  importScripts("../shared/sync-state.js");
} catch (e1) {
  try {
    importScripts("shared/sync-state.js");
  } catch (e2) {
    /* rail / content-script path still works if the SW cannot import */
  }
}

try {
  importScripts("../shared/x-api.js");
} catch (e3) {
  try {
    importScripts("shared/x-api.js");
  } catch (e4) {
    /* key wipe still runs from the content script */
  }
}

const api = typeof browser !== "undefined" ? browser : chrome;
const Sync = self.XFOSyncState;

function wipeSavedApiKeysOnce() {
  const XApi = self.XFOApiKeys;
  if (!XApi || typeof XApi.wipeSavedApiKeys !== "function") return;
  try {
    const pending = XApi.wipeSavedApiKeys(api.storage.local);
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch (e) {
    /* the content script wipes on the next x.com load */
  }
}

wipeSavedApiKeysOnce();

const SYNC_HARD_MS = (Sync && Sync.HARD_MS) || 420000;
const RATE_LIMIT_STUCK_MS =
  (Sync && (typeof Sync.rateLimitStuckMs === "function"
    ? Sync.rateLimitStuckMs()
    : Sync.RATE_LIMIT_STUCK_MS)) ||
  16 * 60 * 1000 + 30000;
const STORAGE_MS = 2000;
const TIMEOUT_ERROR =
  (Sync && Sync.TIMEOUT_ERROR) ||
  "Sync timed out. Keep x.com open and tap Retry sync.";

let expireTimer = null;

function syncAgeMs(startedAt, now) {
  const started = Number(startedAt) || 0;
  return started ? now - started : Infinity;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + " timed out")), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function scheduleExpireCheck(ms) {
  if (expireTimer) clearTimeout(expireTimer);
  expireTimer = setTimeout(() => {
    expireTimer = null;
    expireOrphanSync();
  }, Math.max(1000, ms));
}

async function expireOrphanSync() {
  try {
    const state = await withTimeout(
      api.storage.local.get([
        "syncStatus",
        "syncStartedAt",
        "lastSyncProgressAt",
        "syncProgressLabel",
        "syncBackoffUntil"
      ]),
      STORAGE_MS,
      "Read sync state"
    );
    if (state.syncStatus !== "syncing") return;
    const now = Date.now();
    const backoffUntil = Number(state.syncBackoffUntil) || 0;
    if (backoffUntil > now) {
      scheduleExpireCheck(backoffUntil - now + 1000);
      return;
    }
    const beat = Number(state.lastSyncProgressAt) || Number(state.syncStartedAt) || 0;
    const rateWait = /waiting for x(?:\.com)? rate limit/i;
    const expired = Sync
      ? Sync.shouldHardExpire(
          state.syncStatus,
          state.syncStartedAt,
          now,
          state.lastSyncProgressAt,
          state.syncProgressLabel
        )
      : !beat ||
        syncAgeMs(beat, now) >
          (rateWait.test(String(state.syncProgressLabel || ""))
            ? RATE_LIMIT_STUCK_MS
            : SYNC_HARD_MS);
    if (expired) {
      await withTimeout(
        api.storage.local.set({
          syncStatus: "error",
          syncError: TIMEOUT_ERROR,
          syncStartedAt: null,
          syncBackoffUntil: null,
          syncProgressLabel: ""
        }),
        STORAGE_MS,
        "Expire sync"
      );
      return;
    }
    const limit = Sync && typeof Sync.hardMsFor === "function"
      ? Sync.hardMsFor({ progressLabel: state.syncProgressLabel })
      : /waiting for x(?:\.com)? rate limit/i.test(String(state.syncProgressLabel || ""))
        ? RATE_LIMIT_STUCK_MS
        : SYNC_HARD_MS;
    const age = syncAgeMs(beat, now);
    if (beat && age < limit) {
      scheduleExpireCheck(limit - age + 1000);
    }
  } catch (e) {
    /* ignore */
  }
}

api.runtime.onInstalled.addListener(() => {
  expireOrphanSync();
});

if (api.runtime.onStartup) {
  api.runtime.onStartup.addListener(() => {
    expireOrphanSync();
  });
}

expireOrphanSync();

function apiFetchAllowed(url) {
  return /^https:\/\/api\.x\.com\/2\//.test(String(url || ""));
}

/**
 * Safari content scripts do not get the host-permission CORS exemption.
 * A fetch of api.x.com from x.com fails with status 0. This worker does
 * have api.x.com permission, so the content script hands the signed
 * request here when that happens.
 */
function fetchApiFromWorker(url, authorization) {
  return fetch(url, {
    method: "GET",
    credentials: "omit",
    headers: {
      authorization: String(authorization || ""),
      accept: "application/json"
    }
  }).then(async (res) => {
    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      json = null;
    }
    return {
      ok: !!res.ok,
      status: res.status,
      json: json,
      text: String(text || "").slice(0, 240),
      headers: {
        "retry-after": res.headers && res.headers.get ? res.headers.get("retry-after") : null,
        "x-rate-limit-reset":
          res.headers && res.headers.get ? res.headers.get("x-rate-limit-reset") : null
      }
    };
  });
}

let keyTabOpening = false;
let keyRelayBusy = false;

function relayTestKeys(msg) {
  if (!api.tabs || !api.tabs.query || !api.tabs.sendMessage) {
    return Promise.resolve({ ok: false, message: "Open x.com and sign in first." });
  }
  return api.tabs
    .query({ url: ["https://x.com/*", "https://twitter.com/*"] })
    .then((tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || tab.id == null) {
        return { ok: false, message: "Open x.com and sign in first." };
      }
      return api.tabs.sendMessage(tab.id, {
        type: "XFO_TEST_KEYS",
        keys: msg && msg.keys && typeof msg.keys === "object" ? msg.keys : null,
        userId: msg && msg.userId ? msg.userId : ""
      });
    })
    .then((res) => res || { ok: false, message: "X API error" });
}

if (api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !sender || sender.id !== api.runtime.id) return;
    if (msg.type === "XFO_OPEN_KEYS") {
      const hash = (Sync && Sync.KEYS_HINT_SETTINGS_HASH) || "#optional-keys";
      const url = api.runtime.getURL("popup/popup.html") + hash;
      api.tabs.create({ url: url });
      if (sendResponse) sendResponse({ ok: true });
      return;
    }
    if (msg.type === "XFO_OPEN_KEY_FRAME") {
      if (keyTabOpening) {
        if (sendResponse) sendResponse({ ok: true, duplicate: true });
        return;
      }
      keyTabOpening = true;
      try {
        const url = api.runtime.getURL("popup/keys-frame.html");
        api.tabs.create({ url: url });
        if (sendResponse) sendResponse({ ok: true });
      } finally {
        keyTabOpening = false;
      }
      return;
    }
    if (msg.type === "XFO_RELAY_TEST_KEYS") {
      if (keyRelayBusy) {
        if (sendResponse) sendResponse({ ok: false, message: "Key check already running." });
        return;
      }
      keyRelayBusy = true;
      relayTestKeys(msg).then(
        (res) => {
          keyRelayBusy = false;
          if (sendResponse) sendResponse(res);
        },
        (err) => {
          keyRelayBusy = false;
          if (sendResponse) {
            sendResponse({
              ok: false,
              message: err && err.message ? err.message : "Couldn’t reach x.com. Reload that tab and try again."
            });
          }
        }
      );
      return true;
    }
    if (msg.type !== "XFO_API_FETCH") return;
    const url = String(msg.url || "");
    if (!apiFetchAllowed(url)) {
      if (sendResponse) {
        sendResponse({
          ok: false,
          status: 0,
          json: null,
          text: "refused",
          headers: {}
        });
      }
      return;
    }
    fetchApiFromWorker(url, msg.authorization).then(
      (res) => {
        if (sendResponse) sendResponse(res);
      },
      (err) => {
        if (sendResponse) {
          sendResponse({
            ok: false,
            status: 0,
            json: null,
            text: err && err.message ? err.message : String(err),
            headers: {}
          });
        }
      }
    );
    return true;
  });
}

if (api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.syncStatus && changes.syncStatus.newValue === "syncing") {
      scheduleExpireCheck(SYNC_HARD_MS + 1000);
    }
    if (changes.syncProgressLabel) {
      expireOrphanSync();
    }
  });
}
