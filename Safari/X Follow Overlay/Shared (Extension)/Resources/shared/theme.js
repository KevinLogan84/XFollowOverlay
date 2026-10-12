/**
 * Shared theme preference helpers (classic script).
 * Loaded by the content script (rail panel) and Node tests.
 *
 * Stored value is themePreference: "light" | "dark" | "system".
 * Surfaces set data-theme to that same preference. CSS then forces light/dark
 * or follows prefers-color-scheme when the value is system (the default).
 */
(function (root) {
  var KEY = "themePreference";
  var DEFAULT = "system";

  function normalize(value) {
    if (value === "light" || value === "dark" || value === "system") return value;
    return DEFAULT;
  }

  function systemDark() {
    try {
      return !!(
        root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches
      );
    } catch (e) {
      return false;
    }
  }

  function resolve(preference, isDark) {
    var pref = normalize(preference);
    if (pref === "light" || pref === "dark") return pref;
    var dark = typeof isDark === "boolean" ? isDark : systemDark();
    return dark ? "dark" : "light";
  }

  function applyTo(el, preference, attr) {
    if (!el || typeof el.setAttribute !== "function") return;
    el.setAttribute(attr || "data-theme", normalize(preference));
  }

  function paintControl(rootEl, preference) {
    if (!rootEl || typeof rootEl.querySelectorAll !== "function") return;
    var pref = normalize(preference);
    var buttons = rootEl.querySelectorAll("[data-theme-option]");
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var on = btn.getAttribute("data-theme-option") === pref;
      btn.setAttribute("aria-checked", on ? "true" : "false");
    }
  }

  function controlHTML(className) {
    var cls = className || "theme";
    return (
      '<div class="' +
      cls +
      '" role="radiogroup" aria-label="Theme">' +
      '<button type="button" role="radio" data-theme-option="light" aria-checked="false">Light</button>' +
      '<button type="button" role="radio" data-theme-option="dark" aria-checked="false">Dark</button>' +
      '<button type="button" role="radio" data-theme-option="system" aria-checked="true">Follow system</button>' +
      "</div>"
    );
  }

  // Safari storage.local can hang; callers that await these on the init
  // path pass a timeout so the rail still paints with the default theme.
  function withTimeout(promise, ms, label) {
    if (!ms || ms <= 0) return Promise.resolve(promise);
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error((label || "Theme storage") + " timed out"));
      }, ms);
      Promise.resolve(promise).then(
        function (v) {
          clearTimeout(t);
          resolve(v);
        },
        function (e) {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  function read(api, timeoutMs) {
    if (!api || !api.storage || !api.storage.local) {
      return Promise.resolve(DEFAULT);
    }
    return withTimeout(api.storage.local.get(KEY), timeoutMs, "Read theme").then(
      function (data) {
        return normalize(data && data[KEY]);
      }
    );
  }

  function write(api, preference, timeoutMs) {
    var pref = normalize(preference);
    if (!api || !api.storage || !api.storage.local) {
      return Promise.resolve(pref);
    }
    var patch = {};
    patch[KEY] = pref;
    return withTimeout(api.storage.local.set(patch), timeoutMs, "Write theme").then(
      function () {
        return pref;
      }
    );
  }

  var XFOTheme = {
    KEY: KEY,
    DEFAULT: DEFAULT,
    normalize: normalize,
    resolve: resolve,
    systemDark: systemDark,
    applyTo: applyTo,
    paintControl: paintControl,
    controlHTML: controlHTML,
    read: read,
    write: write
  };

  root.XFOTheme = XFOTheme;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOTheme;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
