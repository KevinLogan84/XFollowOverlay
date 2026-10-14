/* Extension-origin key form. x.com cannot read these inputs. */
(function () {
  var api = typeof browser !== "undefined" ? browser : chrome;
  var XApi = globalThis.XFOApiKeys;
  var KeyConfirm = globalThis.XFOKeyConfirm;
  var form = document.getElementById("keys-form");
  var status = document.getElementById("keys-status");
  var stored = {};
  var verifiedAt = 0;
  var apiSyncError = "";
  var userId = "";
  var savedKeyBusy = false;
  var NAMES = ["bearer", "apiKey", "apiSecret", "accessToken", "accessSecret"];

  function stopPageKeys(event) {
    event.stopPropagation();
  }
  ["keydown", "keypress", "keyup"].forEach(function (type) {
    window.addEventListener(type, stopPageKeys, true);
  });

  function inPageFrame() {
    try {
      return window.parent && window.parent !== window;
    } catch (e) {
      return true;
    }
  }

  function parentOrigin() {
    var ancestor = "";
    try {
      if (location.ancestorOrigins && location.ancestorOrigins.length) {
        ancestor = location.ancestorOrigins[0];
      }
    } catch (e) {
      /* fall through */
    }
    var referrer = "";
    try {
      if (document.referrer) referrer = new URL(document.referrer).origin;
    } catch (e2) {
      /* fall through */
    }
    if (KeyConfirm && KeyConfirm.frameParentOrigin) {
      return KeyConfirm.frameParentOrigin({ ancestor: ancestor, referrer: referrer });
    }
    return "https://x.com";
  }

  function tellParent(action, extra) {
    var payload = { source: "xfo-keys-frame", action: action };
    if (extra) {
      if (extra.label) payload.label = extra.label;
      if (extra.hasKeys != null) payload.hasKeys = !!extra.hasKeys;
      if (extra.height) payload.height = extra.height;
    }
    if (!inPageFrame()) return;
    window.parent.postMessage(payload, parentOrigin());
  }

  function reportHeight() {
    // Measure the form, not the document. An iframe's scrollHeight
    // cannot shrink below the frame's current height.
    var formEl = document.getElementById("keys-form");
    var height = 0;
    if (formEl && typeof formEl.getBoundingClientRect === "function") {
      var rect = formEl.getBoundingClientRect();
      height = rect && rect.height ? rect.height : 0;
    }
    if (document.body && window.getComputedStyle) {
      var style = window.getComputedStyle(document.body);
      height += (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    }
    height = Math.ceil(height);
    if (height) tellParent("height", { height: height });
  }

  function field(name) {
    return form && form.elements ? form.elements[name] : null;
  }

  function paintSaved(keys) {
    NAMES.forEach(function (name) {
      var input = field(name);
      if (!input) return;
      input.hidden = false;
      if (!input.value && keys && keys[name]) input.value = keys[name];
    });
    labelSaveButton();
    reportHeight();
  }

  function typed() {
    var out = {};
    NAMES.forEach(function (name) {
      var input = field(name);
      if (input) out[name] = String(input.value || "").trim();
      else out[name] = stored && stored[name] ? String(stored[name]) : "";
    });
    return out;
  }

  function labelSaveButton() {
    var saveButton = document.getElementById("save-sync");
    if (!saveButton) return;
    var keys = typed();
    var same = !!(
      XApi &&
      XApi.hasUserApiKeys &&
      XApi.hasUserApiKeys(stored) &&
      sameStored(keys)
    );
    saveButton.textContent = same ? "Sync" : "Save and Sync";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme || "system");
  }

  function verifyState() {
    return { keysVerifiedAt: verifiedAt, apiSyncError: apiSyncError };
  }

  async function loadStored() {
    if (XApi && XApi.wipeSavedApiKeys) {
      try {
        await XApi.wipeSavedApiKeys(api.storage.local);
      } catch (e) {
        /* paint whatever is still stored */
      }
    }
    var names = (XApi && XApi.STORAGE_KEYS) || [
      "xApiKey",
      "xApiSecret",
      "xAccessToken",
      "xAccessSecret",
      "xApiBearer",
      "xUserToken",
      "xBearerToken",
      "xApiUserToken"
    ];
    var data = await api.storage.local.get(names.concat(["keysVerifiedAt", "apiSyncError"]));
    stored = XApi && XApi.keysFromStorage ? XApi.keysFromStorage(data) : {};
    verifiedAt = Number(data.keysVerifiedAt) || 0;
    apiSyncError = data.apiSyncError ? String(data.apiSyncError) : "";
    paintSaved(stored);
  }

  async function xTabId() {
    try {
      var tabs =
        api.tabs && api.tabs.query
          ? await api.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] })
          : [];
      return tabs && tabs.length ? tabs[0].id : null;
    } catch (e) {
      return null;
    }
  }

  function showStatus(message) {
    if (!status) return;
    var text = message ? String(message).slice(0, 240) : "";
    if (
      !text ||
      text === "Keys work" ||
      /^syncing\b/i.test(text) ||
      /^starting free\b/i.test(text) ||
      /^key check already running\b/i.test(text)
    ) {
      status.textContent = "";
    } else {
      status.textContent = text;
    }
    reportHeight();
  }

  async function probe(keys) {
    var message = { type: "XFO_TEST_KEYS", keys: keys, userId: userId };
    var result;
    try {
      if (inPageFrame()) {
        // Messaging the host tab from this iframe kills the x.com
        // WebContent process. The worker relays a draft-key test.
        // A saved key does not call probe() here.
        result = await api.runtime.sendMessage({
          type: "XFO_RELAY_TEST_KEYS",
          keys: keys,
          userId: userId
        });
      } else {
        var tabId = await xTabId();
        result = tabId
          ? await api.tabs.sendMessage(tabId, message)
          : { ok: false, message: "Open x.com and sign in first." };
      }
    } catch (err) {
      result = { ok: false, message: err && err.message ? err.message : String(err) };
    }
    if (!result || !result.ok) showStatus((result && result.message) || "X rejected that key.");
    else showStatus("");
    return result;
  }

  function rejectIncomplete() {
    showStatus("Paste an API key.");
  }

  function sameStored(keys) {
    if (!KeyConfirm || !KeyConfirm.sameKeyMaterial) return true;
    return KeyConfirm.sameKeyMaterial(keys, stored);
  }

  async function persistKeys(keys, at) {
    await api.storage.local.set({
      xApiKey: keys.apiKey,
      xApiSecret: keys.apiSecret,
      xAccessToken: keys.accessToken,
      xAccessSecret: keys.accessSecret,
      xApiBearer: keys.bearer,
      keysVerifiedAt: at || null,
      apiSyncError: at ? null : apiSyncError || null
    });
  }

  async function noteVerified(keys, result) {
    if (!sameStored(keys)) return;
    if (result && result.ok) {
      verifiedAt = Date.now();
      apiSyncError = "";
      await api.storage.local.set({ keysVerifiedAt: verifiedAt, apiSyncError: null });
      return;
    }
    if (KeyConfirm && KeyConfirm.probeRevokesVerification && KeyConfirm.probeRevokesVerification(result)) {
      verifiedAt = 0;
      await api.storage.local.set({ keysVerifiedAt: null });
    }
  }

  async function runSyncOnX(prefer) {
    var tabId = await xTabId();
    if (!tabId) {
      status.textContent = "Open x.com and sign in first.";
      reportHeight();
      return;
    }
    try {
      await api.tabs.sendMessage(tabId, { type: "XFO_RUN_SYNC", prefer: prefer });
      status.textContent = prefer === "api" ? "Syncing with your API keys…" : "Starting free sync…";
    } catch (e) {
      status.textContent = "Couldn’t reach x.com. Reload that tab and try again.";
    }
    reportHeight();
  }

  function deliver(action) {
    if (inPageFrame()) tellParent(action, { hasKeys: true });
    else runSyncOnX(action === "use-free" ? "session" : "api");
  }

  async function saveAndSync(event) {
    if (event) event.preventDefault();
    var keys = typed();
    if (!XApi || !XApi.hasUserApiKeys(keys)) {
      rejectIncomplete();
      return;
    }
    if (sameStored(keys) && XApi.hasUserApiKeys(stored)) {
      if (inPageFrame()) {
        if (savedKeyBusy) return;
        savedKeyBusy = true;
        try {
          tellParent("use-saved", { hasKeys: true });
        } catch (e) {
          savedKeyBusy = false;
        }
        setTimeout(function () {
          savedKeyBusy = false;
        }, 20000);
        return;
      }
      var verified = !!(KeyConfirm && KeyConfirm.keysAreVerified && KeyConfirm.keysAreVerified(verifyState()));
      if (verified) {
        runSyncOnX("api");
        return;
      }
      var savedResult = await probe(stored);
      if (!savedResult || !savedResult.ok) {
        if (KeyConfirm && KeyConfirm.probeRevokesVerification && KeyConfirm.probeRevokesVerification(savedResult)) {
          verifiedAt = 0;
          api.storage.local.set({ keysVerifiedAt: null });
        }
        return;
      }
      verifiedAt = Date.now();
      apiSyncError = "";
      await api.storage.local.set({ keysVerifiedAt: verifiedAt, apiSyncError: null });
      runSyncOnX("api");
      return;
    }
    var result = await probe(keys);
    if (!result || !result.ok) return noteVerified(keys, result);
    var at = Date.now();
    await persistKeys(keys, at);
    stored = keys;
    verifiedAt = at;
    apiSyncError = "";
    paintSaved(keys);
    deliver("save-sync");
  }

  form.addEventListener("submit", function (event) {
    saveAndSync(event);
  });
  form.addEventListener("input", function () {
    labelSaveButton();
    reportHeight();
  });
  var useFree = document.getElementById("use-free");
  if (useFree) {
    useFree.addEventListener("click", function () {
      if (inPageFrame()) tellParent("use-free");
      else runSyncOnX("session");
    });
  }
  var cancelButton = document.getElementById("cancel-keys");
  if (cancelButton) {
    cancelButton.addEventListener("click", function () {
      if (inPageFrame()) tellParent("cancel");
      else window.close();
    });
  }
  window.addEventListener("message", function (event) {
    if (!inPageFrame()) return;
    if (event.source !== window.parent) return;
    if (event.origin !== "https://x.com" && event.origin !== "https://twitter.com") return;
    var data = event.data || {};
    if (data.source !== "xfo-content") return;
    if (data.action === "probe-status") {
      savedKeyBusy = false;
      showStatus(data.message || "");
      return;
    }
    if (data.userId) userId = String(data.userId);
    if (data.theme) applyTheme(data.theme);
  });

  loadStored()
    .catch(function () {})
    .then(function () {
      tellParent("ready");
      var bearer = field("bearer");
      if (bearer && !bearer.hidden && bearer.focus) bearer.focus();
      reportHeight();
    });
})();
