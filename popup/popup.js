(function () {
  var api = typeof browser !== "undefined" ? browser : chrome;
  var KEY_FIELDS = ["apiKey", "apiSecret", "accessToken", "accessSecret", "bearer"];

  var stepSignIn = document.getElementById("step-sign-in");
  var stepSync = document.getElementById("step-sync");
  var stepKeys = document.getElementById("step-keys");
  var syncStatus = document.getElementById("sync-status");
  var keysStatus = document.getElementById("keys-status");
  var runSyncBtn = document.getElementById("run-sync");
  var form = document.getElementById("keys-form");

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

  async function storedKeys() {
    var data = await api.storage.local.get([
      "xApiKey",
      "xApiSecret",
      "xAccessToken",
      "xAccessSecret",
      "xApiBearer",
      "xUserToken",
      "xBearerToken",
      "xApiUserToken",
      "lastSyncAt"
    ]);
    return {
      keys: {
        apiKey: data.xApiKey || "",
        apiSecret: data.xApiSecret || "",
        accessToken: data.xAccessToken || "",
        accessSecret: data.xAccessSecret || "",
        bearer: data.xApiBearer || data.xUserToken || data.xBearerToken || data.xApiUserToken || ""
      },
      lastSyncAt: data.lastSyncAt || null
    };
  }

  function mark(el, done) {
    el.classList.toggle("done", !!done);
  }

  async function refresh() {
    var session = await findSession();
    var stored = await storedKeys();
    var keyed = hasKeys(stored.keys);
    mark(stepSignIn, session.signedIn);
    mark(stepSync, !!stored.lastSyncAt);
    mark(stepKeys, keyed);
    runSyncBtn.disabled = !session.signedIn;
    if (!session.signedIn) {
      syncStatus.textContent = "Sign in on x.com in this browser, then come back.";
    } else if (!stored.lastSyncAt) {
      syncStatus.textContent = "Signed in. Run Sync on that tab.";
    } else {
      syncStatus.textContent = "Last sync is saved on this device.";
    }
    if (keyed) keysStatus.textContent = "Keys are saved on this device only.";
    runSyncBtn.dataset.tabId = session.tabId ? String(session.tabId) : "";
  }

  document.getElementById("open-x").addEventListener("click", function () {
    api.tabs.create({ url: "https://x.com" });
  });

  runSyncBtn.addEventListener("click", async function () {
    var tabId = Number(runSyncBtn.dataset.tabId);
    if (!tabId) {
      syncStatus.textContent = "Open x.com and sign in first.";
      return;
    }
    runSyncBtn.disabled = true;
    syncStatus.textContent = "Starting Sync on your x.com tab…";
    try {
      await api.tabs.sendMessage(tabId, { type: "XFO_RUN_SYNC" });
      syncStatus.textContent = "Sync started. Leave the x.com tab open.";
    } catch (e) {
      syncStatus.textContent = "Couldn’t reach x.com. Reload that tab and try again.";
    }
    runSyncBtn.disabled = false;
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

  refresh();
})();
