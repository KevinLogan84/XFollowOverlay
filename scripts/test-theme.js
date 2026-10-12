/**
 * Unit checks for theme preference + CSS token pairing.
 * Run: node scripts/test-theme.js
 */
const fs = require("fs");
const path = require("path");
const Theme = require("../shared/theme.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(Theme.KEY === "themePreference", "storage key is themePreference");
assert(Theme.DEFAULT === "system", "default is Follow system");
assert(Theme.normalize("light") === "light", "keep light");
assert(Theme.normalize("dark") === "dark", "keep dark");
assert(Theme.normalize("system") === "system", "keep system");
assert(Theme.normalize(undefined) === "system", "missing becomes system");
assert(Theme.normalize("auto") === "system", "unknown becomes system");
assert(Theme.normalize("") === "system", "empty becomes system");

assert(Theme.resolve("light", true) === "light", "forced light ignores OS dark");
assert(Theme.resolve("dark", false) === "dark", "forced dark ignores OS light");
assert(Theme.resolve("system", false) === "light", "system + OS light");
assert(Theme.resolve("system", true) === "dark", "system + OS dark");
assert(Theme.resolve("nope", false) === "light", "bad value follows system");

{
  const el = {
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k];
    }
  };
  Theme.applyTo(el, "dark");
  assert(el.getAttribute("data-theme") === "dark", "applyTo writes data-theme");
  Theme.applyTo(el, "weird");
  assert(el.getAttribute("data-theme") === "system", "applyTo normalizes");
  Theme.applyTo(el, "light", "data-xfo-theme");
  assert(el.getAttribute("data-xfo-theme") === "light", "applyTo can write data-xfo-theme");
}

{
  const buttons = ["light", "dark", "system"].map((opt) => {
    const attrs = { "data-theme-option": opt, "aria-checked": "false" };
    return {
      getAttribute(k) {
        return attrs[k];
      },
      setAttribute(k, v) {
        attrs[k] = v;
      }
    };
  });
  const root = {
    querySelectorAll(sel) {
      return sel === "[data-theme-option]" ? buttons : [];
    }
  };
  Theme.paintControl(root, "light");
  assert(buttons[0].getAttribute("aria-checked") === "true", "light selected");
  assert(buttons[1].getAttribute("aria-checked") === "false", "dark not selected");
  assert(buttons[2].getAttribute("aria-checked") === "false", "system not selected");
  Theme.paintControl(root, "system");
  assert(buttons[2].getAttribute("aria-checked") === "true", "system selected");
}

{
  const html = Theme.controlHTML("xfo-theme");
  assert(html.indexOf('class="xfo-theme"') !== -1, "control uses given class");
  assert(html.indexOf("Light") !== -1, "control has Light");
  assert(html.indexOf("Dark") !== -1, "control has Dark");
  assert(html.indexOf("Follow system") !== -1, "control has Follow system");
  assert(html.indexOf('data-theme-option="system"') !== -1, "system option exists");
}

const store = {};
const api = {
  storage: {
    local: {
      get(key) {
        const k = typeof key === "string" ? key : Theme.KEY;
        const out = {};
        out[k] = store[k];
        return Promise.resolve(out);
      },
      set(patch) {
        Object.assign(store, patch);
        return Promise.resolve();
      }
    }
  }
};

const hungApi = {
  storage: {
    local: {
      get() {
        return new Promise(() => {});
      },
      set() {
        return new Promise(() => {});
      }
    }
  }
};

Theme.read(hungApi, 30)
  .then(
    () => {
      throw new Error("hung read must reject when a timeout is given");
    },
    (err) => {
      assert(/timed out/.test(err.message), "hung read rejects with a timeout error");
      return Theme.write(hungApi, "dark", 30);
    }
  )
  .then(
    () => {
      throw new Error("hung write must reject when a timeout is given");
    },
    (err) => {
      assert(/timed out/.test(err.message), "hung write rejects with a timeout error");
    }
  )
  .then(() => Theme.write(api, "dark"))
  .then((pref) => {
    assert(pref === "dark", "write returns dark");
    assert(store.themePreference === "dark", "write persists themePreference");
    return Theme.read(api);
  })
  .then((pref) => {
    assert(pref === "dark", "read returns stored dark");
    return Theme.write(api, "nope");
  })
  .then(() => Theme.read(api))
  .then((pref) => {
    assert(pref === "system", "invalid write stores system");
    const railCss = fs.readFileSync(
      path.join(__dirname, "../content/styles.css"),
      "utf8"
    );
    const railPrimary = railCss.match(/--primary:\s*(#[0-9a-fA-F]{6})/);
    assert(railPrimary && railPrimary[1] === "#1d9bf0", "rail --primary is Twitter blue");
    assert(
      /\.xfo-rail-sync[\s\S]*?background:\s*var\(--primary\)/.test(railCss),
      "rail Sync now uses var(--primary)"
    );
    assert(
      railCss.indexOf('.xfo-rail-panel[data-theme="dark"]') !== -1,
      "rail can force dark"
    );
    assert(
      railCss.indexOf(':not([data-theme="light"])') !== -1,
      "rail can force light / follow system"
    );
    assert(
      /prefers-color-scheme:\s*dark/.test(railCss),
      "rail follows prefers-color-scheme"
    );
    const railTextLight = railCss.match(/\.xfo-rail-panel\[data-theme="light"\]\s*\{[\s\S]*?--text:\s*(#[0-9a-fA-F]{6})/);
    const railTextDark = railCss.match(/\.xfo-rail-panel\[data-theme="dark"\]\s*\{[\s\S]*?--text:\s*(#[0-9a-fA-F]{6})/);
    assert(railTextLight && railTextLight[1] === "#1c1c1e", "rail light --text is near-black");
    assert(railTextDark && railTextDark[1] === "#f5f5f7", "rail dark --text is near-white");
    assert(
      /\.xfo-metrics\s*\{[^}]*display:\s*none/.test(railCss),
      "retired Days badges stay hidden"
    );
    assert(
      !/\.xfo-metrics[\s\S]*?color:\s*var\(--xfo-metrics\)/.test(railCss),
      "Days badge text color is not painted"
    );
    assert(
      !/mask:\s*url\(/.test(railCss),
      "legend marks do not use SVG masks"
    );
    assert(
      /\.xfo-rail-leg i[\s\S]*?border-radius:\s*6px/.test(railCss),
      "rail legend marks are 12px circles (radius 6px)"
    );
    assert(
      /\.xfo-rail-leg i[\s\S]*?width:\s*12px[\s\S]*?height:\s*12px/.test(railCss),
      "rail legend marks are 12x12"
    );
    assert(
      /\.xfo-theme button[\s\S]*?justify-content:\s*center/.test(railCss) &&
        /\.xfo-theme button[\s\S]*?align-items:\s*center/.test(railCss) &&
        /\.xfo-theme button[\s\S]*?flex:\s*1 1 0/.test(railCss),
      "rail theme segments are equal and centered"
    );
    assert(
      /\.xfo-theme[\s\S]*?align-items:\s*center/.test(railCss),
      "theme track vertically centers the selected pill"
    );
    console.log("All theme tests passed.");
  })
  .catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
