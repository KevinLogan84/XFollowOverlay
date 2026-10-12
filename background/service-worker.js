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

const api = typeof browser !== "undefined" ? browser : chrome;
const Sync = self.XFOSyncState;

const SYNC_HARD_MS = (Sync && Sync.HARD_MS) || 420000;
const RATE_LIMIT_STUCK_MS =
  (Sync && (typeof Sync.rateLimitStuckMs === "function"
    ? Sync.rateLimitStuckMs()
    : Sync.RATE_LIMIT_STUCK_MS)) ||
  16 * 60 * 1000 + 30000;
const STORAGE_MS = 2000;
const TIMEOUT_ERROR =
  "Sync timed out. Keep x.com open and tap Sync now to retry.";

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

if (api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !sender || sender.id !== api.runtime.id) return;
    if (msg.type !== "XFO_OPEN_KEYS") return;
    const hash = (Sync && Sync.KEYS_HINT_SETTINGS_HASH) || "#optional-keys";
    const url = api.runtime.getURL("popup/popup.html") + hash;
    api.tabs.create({ url: url });
    if (sendResponse) sendResponse({ ok: true });
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
