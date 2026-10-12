(function () {
  var api = typeof browser !== "undefined" ? browser : chrome;
  var Sync = globalThis.XFOSyncState;
  var KEY_FIELDS = ["apiKey", "apiSecret", "accessToken", "accessSecret", "bearer"];

  var stepSignIn = document.getElementById("step-sign-in");
  var stepSync = document.getElementById("step-sync");
  var stepKeys = document.getElementById("step-keys");
  var syncStatus = document.getElementById("sync-status");
  var syncAge = document.getElementById("sync-age");
  var keysHint = document.getElementById("keys-hint");
  var keysStatus = document.getElementById("keys-status");
  var runSyncBtn = document.getElementById("run-sync");
  var form = document.getElementById("keys-form");
  var signedIn = false;
  var hasStoredSync = false;
  var syncSnap = {};
  var keyed = false;
  var syncKick = false;

  function keysFromForm() {
    var data = {};
    KEY_FIELDS.forEach(function (name) {
      data[name] = (form.elements[name].value || "").trim();
    });
    return {
      apiKey: data.apiKey,
      apiSecret: data.apiSecret,
      accessToken: data.accessToken,
      accessSecret: data.accessSecret,
      bearer: data.bearer
    };
  }

  function hasKeys(keys) {
    if (globalThis.XFOApiKeys) return globalThis.XFOApiKeys.hasUserApiKeys(keys);
    var oauth =
      keys.apiKey && keys.apiSecret && keys.accessToken && keys.accessSecret;
    return !!(oauth || (keys.bearer && keys.bearer.length >= 20));
  }

  async function xTabs() {
    try {
      return await api.tabs.query({
        url: ["https://x.com/*", "https://twitter.com/*"]
      });
    } catch (e) {
      return [];
    }
  }

  async function findSession() {
    var tabs = await xTabs();
    for (var i = 0; i < tabs.length; i++) {
      try {
        var res = await api.tabs.sendMessage(tabs[i].id, { type: "XFO_SESSION" });
        if (res && res.signedIn) return { signedIn: true, tabId: tabs[i].id };
      } catch (e) {
        /* tab has no content script yet */
      }
    }
    return { signedIn: false, tabId: tabs.length ? tabs[0].id : null };
  }

  async function storedState() {
    var data = await api.storage.local.get([
      "xApiKey",
      "xApiSecret",
      "xAccessToken",
      "xAccessSecret",
      "xApiBearer",
      "xUserToken",
      "xBearerToken",
      "xApiUserToken",
      "lastSyncAt",
      "syncStatus",
      "syncError",
      "syncStartedAt",
      "lastSyncProgressAt",
      "syncProgressLabel",
      "syncBackoffUntil",
      "syncProgressCount",
      "syncProgressSide",
      "hideRateLimitKeysHint"
    ]);
    return {
      keys: {
        apiKey: data.xApiKey || "",
        apiSecret: data.xApiSecret || "",
        accessToken: data.xAccessToken || "",
        accessSecret: data.xAccessSecret || "",
        bearer: data.xApiBearer || data.xUserToken || data.xBearerToken || data.xApiUserToken || ""
      },
      lastSyncAt: data.lastSyncAt || null,
      sync: data
    };
  }

  function mark(el, done) {
    el.classList.toggle("done", !!done);
  }

  function renderSyncFace() {
    var now = Date.now();
    var ui = {
      busy: false,
      syncStatus: syncSnap.syncStatus,
      syncStartedAt: syncSnap.syncStartedAt,
      storedProgressAt: syncSnap.lastSyncProgressAt,
      lastProgressAt: 0,
      progressLabel: syncSnap.syncProgressLabel || "",
      backoffUntil: syncSnap.syncBackoffUntil,
      now: now
    };
    var syncing = syncKick || (Sync && Sync.showSyncing(ui));
    var backingOff = !!(Sync && Sync.isBackoffPending && Sync.isBackoffPending(syncSnap.syncBackoffUntil, now));
    if (syncing) {
      var label = syncSnap.syncProgressLabel || "Syncing…";
      if (backingOff && Sync && Sync.backoffStatusText) {
        label = Sync.backoffStatusText({
          resumeAt: Number(syncSnap.syncBackoffUntil),
          now: now,
          count: syncSnap.syncProgressCount,
          side: syncSnap.syncProgressSide
        });
      }
      syncStatus.textContent = label;
      if (syncAge && Sync && Sync.lastUpdateText) {
        syncAge.textContent = Sync.lastUpdateText(syncSnap.lastSyncProgressAt, now);
      }
      runSyncBtn.textContent = "Syncing…";
      runSyncBtn.disabled = true;
      runSyncBtn.classList.add("is-syncing");
    } else {
      runSyncBtn.classList.remove("is-syncing");
      if (syncAge) syncAge.textContent = "";
      if (!signedIn) {
        syncStatus.textContent = "Sign in on x.com in this browser, then come back.";
      } else if (!hasStoredSync) {
        syncStatus.textContent = "Signed in. Run Sync on that tab.";
      } else if (syncSnap.syncStatus === "error" && syncSnap.syncError) {
        syncStatus.textContent = syncSnap.syncError;
      } else {
        syncStatus.textContent = "Last sync is saved on this device.";
      }
      var retry = Sync && Sync.isStuck(ui);
      runSyncBtn.textContent = retry ? "Retry sync" : "Sync now";
      runSyncBtn.disabled = !signedIn;
    }
    var showHint =
      Sync &&
      Sync.showRateLimitKeysHint &&
      Sync.showRateLimitKeysHint({
        backingOff: backingOff,
        hasKeys: keyed,
        dismissed: syncSnap.hideRateLimitKeysHint === true
      });
    if (keysHint) keysHint.hidden = !showHint;
  }

  async function refresh() {
    var session = await findSession();
    var stored = await storedState();
    signedIn = session.signedIn;
    hasStoredSync = !!stored.lastSyncAt;
    keyed = hasKeys(stored.keys);
    syncSnap = stored.sync || {};
    mark(stepSignIn, signedIn);
    mark(stepSync, hasStoredSync);
    mark(stepKeys, keyed);
    if (keyed) keysStatus.textContent = "Keys are saved on this device only.";
    runSyncBtn.dataset.tabId = session.tabId ? String(session.tabId) : "";
    renderSyncFace();
  }

  document.getElementById("open-x").addEventListener("click", function () {
    api.tabs.create({ url: "https://x.com" });
  });

  var readme = document.getElementById("keys-hint-readme");
  if (readme && Sync && Sync.KEYS_HINT_README_URL) {
    readme.href = Sync.KEYS_HINT_README_URL;
  }

  document.getElementById("keys-hint-hide").addEventListener("click", async function () {
    syncSnap.hideRateLimitKeysHint = true;
    if (keysHint) keysHint.hidden = true;
    await api.storage.local.set({ hideRateLimitKeysHint: true });
  });

  runSyncBtn.addEventListener("click", async function () {
    var tabId = Number(runSyncBtn.dataset.tabId);
    if (!tabId) {
      syncStatus.textContent = "Open x.com and sign in first.";
      return;
    }
    syncKick = true;
    renderSyncFace();
    syncStatus.textContent = "Starting Sync on your x.com tab…";
    try {
      await api.tabs.sendMessage(tabId, { type: "XFO_RUN_SYNC" });
    } catch (e) {
      syncKick = false;
      syncStatus.textContent = "Couldn’t reach x.com. Reload that tab and try again.";
      runSyncBtn.classList.remove("is-syncing");
      runSyncBtn.disabled = !signedIn;
      runSyncBtn.textContent = "Sync now";
      return;
    }
    syncKick = false;
    refresh();
  });

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    var keys = keysFromForm();
    if (!hasKeys(keys) && (keys.apiKey || keys.apiSecret || keys.accessToken || keys.accessSecret || keys.bearer)) {
      keysStatus.textContent = "Those keys look incomplete. Paste all four, or only a bearer token.";
      return;
    }
    await api.storage.local.set({
      xApiKey: keys.apiKey,
      xApiSecret: keys.apiSecret,
      xAccessToken: keys.accessToken,
      xAccessSecret: keys.accessSecret,
      xApiBearer: keys.bearer
    });
    KEY_FIELDS.forEach(function (name) {
      form.elements[name].value = "";
    });
    keysStatus.textContent = keys.apiKey || keys.bearer
      ? "Saved on this device. They are not in the download."
      : "Nothing new to save.";
    refresh();
  });

  document.getElementById("clear-keys").addEventListener("click", async function () {
    await api.storage.local.remove([
      "xApiKey",
      "xApiSecret",
      "xAccessToken",
      "xAccessSecret",
      "xApiBearer",
      "xUserToken",
      "xBearerToken",
      "xApiUserToken"
    ]);
    KEY_FIELDS.forEach(function (name) {
      form.elements[name].value = "";
    });
    keysStatus.textContent = "Keys removed from this device. Sync will use your x.com tab.";
    refresh();
  });

  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      if (
        changes.syncStatus ||
        changes.syncProgressLabel ||
        changes.lastSyncProgressAt ||
        changes.syncBackoffUntil ||
        changes.syncProgressCount ||
        changes.syncProgressSide ||
        changes.hideRateLimitKeysHint ||
        changes.syncError ||
        changes.lastSyncAt ||
        changes.xApiKey ||
        changes.xApiSecret ||
        changes.xAccessToken ||
        changes.xAccessSecret ||
        changes.xApiBearer
      ) {
        refresh();
      }
    });
  }

  setInterval(function () {
    if (syncKick || syncSnap.syncStatus === "syncing") renderSyncFace();
  }, 1000);
  refresh();
})();
