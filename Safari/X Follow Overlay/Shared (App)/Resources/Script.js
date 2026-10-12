function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    if (useSettingsInsteadOfPreferences) {
        const on = document.querySelector(".platform-mac.state-on");
        const off = document.querySelector(".platform-mac.state-off");
        const unknown = document.querySelector(".platform-mac.state-unknown");
        const btn = document.querySelector(".platform-mac.open-preferences");
        if (on) on.textContent = "Extension is on. Open x.com, sign in, and tap the people icon under Post to sync.";
        if (off) off.textContent = "Extension is off. Enable it in Safari Settings → Extensions to continue.";
        if (unknown) unknown.textContent = "Enable the extension in Safari Settings → Extensions, then open x.com and sync.";
        if (btn) btn.textContent = "Open Safari Settings…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle("state-on", enabled);
        document.body.classList.toggle("state-off", !enabled);
    } else {
        document.body.classList.remove("state-on");
        document.body.classList.remove("state-off");
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);

var openX = document.querySelector("button.open-x");
if (openX) {
    openX.addEventListener("click", function () {
        webkit.messageHandlers.controller.postMessage("open-x");
    });
}

var feedback = document.querySelector("a.feedback");
if (feedback) {
    feedback.addEventListener("click", function (event) {
        event.preventDefault();
        webkit.messageHandlers.controller.postMessage("open-feedback");
    });
}
