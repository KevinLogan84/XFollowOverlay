(function () {
  var api = typeof browser !== "undefined" ? browser : chrome;
  var Sync = globalThis.XFOSyncState;
  var XApi = globalThis.XFOApiKeys;
  var keyWipeReady =
    XApi && XApi.wipeSavedApiKeys
      ? XApi.wipeSavedApiKeys(api.storage.local).catch(function () {})
      : Promise.resolve();
  var KEY_FIELDS = ["apiKey", "apiSecret", "accessToken", "accessSecret", "bearer"];

  var stepSignIn = document.getElementById("step-sign-in");
  var stepSync = document.getElementById("step-sync");
  var stepKeys = document.getElementById("step-keys");
  var syncStatus = document.getElementById("sync-status");
  var syncAge = document.getElementById("sync-age");
  var keysHint = document.getElementById("keys-hint");
  var keysStatus = document.getElementById("keys-status");
  var runSyncBtn = document.getElementById("run-sync");
  var runSyncApiBtn = document.getElementById("run-sync-api");
  var form = document.getElementById("keys-form");
  var signedIn = false;
  var hasStoredSync = false;
  var syncSnap = {};
  var keyed = false;
  var syncKick = false;
  var syncKickPrefer = null;
  var storedKeys = {};
  var keyProbeMessage = "";

  function keysFromForm() {
    var data = {};
    KEY_FIELDS.forEach(function (name) {
      var input = form.elements[name];
      if (input) data[name] = (input.value || "").trim();
      else data[name] = storedKeys && storedKeys[name] ? String(storedKeys[name]) : "";
    });
    return {
      apiKey: data.apiKey || "",
      apiSecret: data.apiSecret || "",
      accessToken: data.accessToken || "",
      accessSecret: data.accessSecret || "",
      bearer: data.bearer || ""
    };
  }

  function paintSavedKeys(keys) {
    KEY_FIELDS.forEach(function (name) {
      var input = form.elements[name];
      if (!input) return;
      input.hidden = false;
      if (!input.value && keys && keys[name]) input.value = keys[name];
    });
    labelSaveButton();
  }

  function labelSaveButton() {
    var saveButton = document.getElementById("save-sync");
    if (!saveButton) return;
    var Key = globalThis.XFOKeyConfirm;
    var keys = keysFromForm();
    var same = !!(
      hasKeys(storedKeys) &&
      (!Key || !Key.sameKeyMaterial || Key.sameKeyMaterial(keys, storedKeys))
    );
    saveButton.textContent = same ? "Sync" : "Save and Sync";
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
      "syncPrefer",
      "hideRateLimitKeysHint",
      "keysVerifiedAt",
      "apiSyncError"
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
      var prefer = syncKickPrefer
        ? syncKickPrefer
        : syncSnap.syncPrefer === "api"
          ? "api"
          : "session";
      var freeOpts = { pulsing: true, apiChoice: false, prefer: prefer };
      var apiOpts = { pulsing: true, apiChoice: true, prefer: prefer };
      runSyncBtn.textContent =
        Sync && Sync.pathButtonText ? Sync.pathButtonText(freeOpts) : "Syncing…";
      runSyncBtn.disabled = true;
      runSyncBtn.classList.toggle(
        "is-syncing",
        !Sync || !Sync.pathButtonSyncing || Sync.pathButtonSyncing(freeOpts)
      );
      if (runSyncApiBtn) {
        runSyncApiBtn.textContent =
          Sync && Sync.pathButtonText ? Sync.pathButtonText(apiOpts) : "Syncing…";
        runSyncApiBtn.disabled = true;
        runSyncApiBtn.classList.toggle(
          "is-syncing",
          !Sync || !Sync.pathButtonSyncing || Sync.pathButtonSyncing(apiOpts)
        );
      }
    } else {
      var stuck = !!(Sync && Sync.isStuck && Sync.isStuck(ui));
      runSyncBtn.classList.remove("is-syncing");
      if (runSyncApiBtn) runSyncApiBtn.classList.remove("is-syncing");
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
      runSyncBtn.textContent = stuck ? "Retry sync" : "Sync free";
      runSyncBtn.disabled = !signedIn;
      if (runSyncApiBtn) {
        runSyncApiBtn.textContent = stuck ? "Retry sync" : "Sync with API keys";
        runSyncApiBtn.disabled = !signedIn;
      }
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
    await keyWipeReady;
    var session = await findSession();
    var stored = await storedState();
    signedIn = session.signedIn;
    hasStoredSync = !!stored.lastSyncAt;
    storedKeys = stored.keys;
    keyed = hasKeys(stored.keys);
    syncSnap = stored.sync || {};
    mark(stepSignIn, signedIn);
    mark(stepSync, hasStoredSync);
    mark(stepKeys, keyed);
    paintSavedKeys(stored.keys);
    if (keyProbeMessage) keysStatus.textContent = keyProbeMessage;
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

  async function startSyncOnTab(prefer) {
    var tabId = Number(runSyncBtn.dataset.tabId);
    if (!tabId) {
      syncStatus.textContent = "Open x.com and sign in first.";
      return;
    }
    var alreadyRunning = syncSnap.syncStatus === "syncing";
    if (!alreadyRunning) {
      syncKick = true;
      syncKickPrefer = prefer === "api" ? "api" : "session";
      renderSyncFace();
      syncStatus.textContent = "Starting Sync on your x.com tab…";
    }
    try {
      await api.tabs.sendMessage(tabId, { type: "XFO_RUN_SYNC", prefer: prefer });
    } catch (e) {
      syncKick = false;
      syncKickPrefer = null;
      syncStatus.textContent = "Couldn’t reach x.com. Reload that tab and try again.";
      renderSyncFace();
      return;
    }
    syncKick = false;
    syncKickPrefer = null;
    refresh();
  }

  runSyncBtn.addEventListener("click", function () {
    startSyncOnTab("session");
  });

  if (runSyncApiBtn) {
    runSyncApiBtn.addEventListener("click", function () {
      var anchor = document.getElementById("optional-keys");
      if (anchor && anchor.scrollIntoView) anchor.scrollIntoView();
      var bearer = form.elements.bearer;
      if (!keyed) {
        if (bearer && bearer.focus) bearer.focus();
        return;
      }
      var saveButton = document.getElementById("save-sync");
      if (saveButton && saveButton.focus) saveButton.focus();
    });
  }

  var useFreeBtn = document.getElementById("use-free");
  if (useFreeBtn) {
    useFreeBtn.addEventListener("click", function () {
      startSyncOnTab("session");
    });
  }

  async function probeKeysOnTab(keys) {
    var tabId = Number(runSyncBtn.dataset.tabId);
    if (!tabId) {
      return { ok: false, message: "Open x.com and sign in first." };
    }
    try {
      return await api.tabs.sendMessage(tabId, { type: "XFO_TEST_KEYS", keys: keys || null });
    } catch (e) {
      return { ok: false, message: "Couldn’t reach x.com. Reload that tab and try again." };
    }
  }

  function draftKeys() {
    var keys = keysFromForm();
    if (
      !hasKeys(keys) &&
      (keys.apiKey || keys.apiSecret || keys.accessToken || keys.accessSecret || keys.bearer)
    ) {
      keysStatus.textContent = "Paste an API key.";
      return null;
    }
    if (!hasKeys(keys)) {
      keysStatus.textContent = "Paste an API key.";
      return null;
    }
    return keys;
  }

  async function saveKeys() {
    await keyWipeReady;
    var keys = draftKeys();
    if (!keys) return;
    var Key = globalThis.XFOKeyConfirm;
    var same = !Key || !Key.sameKeyMaterial || Key.sameKeyMaterial(keys, storedKeys);
    var verified = !!(
      same &&
      hasKeys(storedKeys) &&
      Key &&
      Key.keysAreVerified &&
      Key.keysAreVerified({
        keysVerifiedAt: syncSnap.keysVerifiedAt,
        apiSyncError: syncSnap.apiSyncError
      })
    );
    if (verified) {
      keyProbeMessage = "";
      if (keysStatus) keysStatus.textContent = "";
      await startSyncOnTab("api");
      return;
    }
    var result = await probeKeysOnTab(keys);
    if (!result || !result.ok) {
      var message = (result && result.message) || "X rejected that key.";
      if (/^key check already running\b/i.test(message)) message = "";
      keyProbeMessage = message;
      if (keysStatus) keysStatus.textContent = keyProbeMessage;
      return noteVerified(keys, result);
    }
    keyProbeMessage = "";
    if (keysStatus) keysStatus.textContent = "";
    var at = Date.now();
    await api.storage.local.set({
      xApiKey: keys.apiKey,
      xApiSecret: keys.apiSecret,
      xAccessToken: keys.accessToken,
      xAccessSecret: keys.accessSecret,
      xApiBearer: keys.bearer,
      keysVerifiedAt: at,
      apiSyncError: null
    });
    storedKeys = keys;
    keyed = true;
    syncSnap.keysVerifiedAt = at;
    syncSnap.apiSyncError = null;
    paintSavedKeys(keys);
    await startSyncOnTab("api");
    refresh();
  }

  async function noteVerified(keys, result) {
    var Key = globalThis.XFOKeyConfirm;
    var same = !Key || !Key.sameKeyMaterial || Key.sameKeyMaterial(keys, storedKeys);
    if (!same) return;
    if (result && result.ok) {
      var at = Date.now();
      syncSnap.keysVerifiedAt = at;
      syncSnap.apiSyncError = null;
      await api.storage.local.set({ keysVerifiedAt: at, apiSyncError: null });
      return;
    }
    if (Key && Key.probeRevokesVerification && Key.probeRevokesVerification(result)) {
      syncSnap.keysVerifiedAt = null;
      await api.storage.local.set({ keysVerifiedAt: null });
    }
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    saveKeys();
  });
  form.addEventListener("input", function () {
    labelSaveButton();
  });

  var cancelKeys = document.getElementById("cancel-keys");
  if (cancelKeys) {
    cancelKeys.addEventListener("click", function () {
      window.close();
    });
  }

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
        changes.syncPrefer ||
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
