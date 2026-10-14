/**
 * Confirm-before-API-sync decisions.
 * Nothing here stores a secret or chooses a host other than api.x.com.
 *
 * Keys are typed only in the extension origin: the keys-frame.html
 * iframe, or that page opened in its own tab, or the toolbar popup.
 * beforeinput and input are composed events and carry event.data,
 * including on type=password fields, so an in-page form or a closed
 * shadow root on x.com would hand the secret to page scripts.
 *
 * x.com's frame-src omits extension schemes. The iframe still has to
 * be the extension page: an in-page form would leak the key. WebKit
 * does not treat safari-web-extension as a special URL scheme, so
 * new URL(runtime.getURL(...)).origin is "null" in the page while the
 * frame's postMessage origin is safari-web-extension://<id>. Safari
 * also lowercases that origin, and getURL keeps the UUID uppercase.
 * Compare extensionOrigin() in lowercase, or every frame message is
 * dropped and the panel stays at the default frame height.
 *
 * Safari also refuses that page when the iframe's current document is
 * about:blank. The first navigation has to be the extension URL.
 *
 * Safari kills the x.com WebContent process when that embedded frame
 * calls tabs.getCurrent or tabs.sendMessage into its host tab. The
 * frame only postMessages. The content script probes stored keys.
 */
(function (root) {
  var VERIFIED_AT = "keysVerifiedAt";
  var PRIVACY = "Stays on this Mac, only sent to X.";
  var OAUTH_FIELDS = [
    ["apiKey", "API key"],
    ["apiSecret", "API key secret"],
    ["accessToken", "Access token"],
    ["accessSecret", "Access token secret"]
  ];
  var MATERIAL = ["apiKey", "apiSecret", "accessToken", "accessSecret", "bearer"];

  function clean(value) {
    return value == null ? "" : String(value).trim();
  }

  /**
   * "frame" when the extension URL can be used as an iframe src.
   * "fallback" when it cannot. Never "shadow" — an in-page form leaks keys.
   */
  /**
   * postMessage target for the embedded key frame. An extension
   * ancestor (Safari sometimes reports the frame's own origin) is
   * not the page, so it must not be the target — the page would
   * never hear the saved-key check.
   */
  function frameParentOrigin(input) {
    input = input || {};
    var ancestor = pageOrigin(input.ancestor);
    if (ancestor) return ancestor;
    var referrer = pageOrigin(input.referrer);
    if (referrer) return referrer;
    return "https://x.com";
  }

  /**
   * scheme://host for an extension URL. new URL().origin is "null"
   * for safari-web-extension in the page, which is not the frame's
   * postMessage origin.
   */
  function extensionOrigin(url) {
    var match = String(url || "").match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i);
    return match ? match[1].toLowerCase() : "";
  }

  function pageOrigin(value) {
    var origin = clean(value);
    if (origin === "https://x.com" || origin === "https://twitter.com") return origin;
    return "";
  }

  function hostForKeyForm(input) {
    input = input || {};
    var url = String(input.extensionUrl || "");
    if (/^(chrome|moz)-extension:/i.test(url)) return "frame";
    if (/^safari(-web)?-extension:/i.test(url)) return "frame";
    return "fallback";
  }

  /** 401 and 403 mean the saved key was rejected. Timeouts and 429s do not. */
  function clearsKeyVerification(status) {
    var code = Number(status);
    return code === 401 || code === 403;
  }

  function authErrorText(text) {
    return /^X API (401|403)\b/.test(clean(text));
  }

  function probeRevokesVerification(result) {
    result = result || {};
    if (clearsKeyVerification(result.status)) return true;
    return authErrorText(result.message);
  }

  /**
   * The panel asks for a token only when none is saved, or when X
   * rejected the saved one. A later sync reuses local storage.
   */
  function showKeyForm(input) {
    input = input || {};
    if (!input.hasKeys) return true;
    if (clearsKeyVerification(input.status)) return true;
    if (authErrorText(input.apiSyncError) || authErrorText(input.message)) return true;
    return false;
  }

  /**
   * A 401/403 on the snapshot means the saved keys are not verified.
   * A timestamp still counts through rate limits and timeouts.
   */
  function keysAreVerified(state) {
    state = state || {};
    if (clearsKeyVerification(state.status)) return false;
    if (authErrorText(state.apiSyncError)) return false;
    var at = Number(state.keysVerifiedAt);
    return isFinite(at) && at > 0;
  }

  /** A saved key must be probed unless keysAreVerified is already true. */
  function savedKeyNeedsProbe(state) {
    return !keysAreVerified(state);
  }

  function sameKeyMaterial(a, b) {
    a = a || {};
    b = b || {};
    for (var i = 0; i < MATERIAL.length; i++) {
      var name = MATERIAL[i];
      if (clean(a[name]) !== clean(b[name])) return false;
    }
    return true;
  }

  /**
   * Half-filled means at least one OAuth field has text and at least
   * one is blank. Blank fields are named. Nothing is cleared.
   */
  function oauthGaps(keys) {
    keys = keys || {};
    var empty = [];
    var filled = 0;
    OAUTH_FIELDS.forEach(function (pair) {
      if (clean(keys[pair[0]])) filled += 1;
      else empty.push(pair[1]);
    });
    return { half: filled > 0 && empty.length > 0, empty: empty, filled: filled };
  }

  function oauthGapSentence(empty) {
    var names = empty || [];
    if (!names.length) return "";
    if (names.length === 1) return names[0] + " is empty.";
    if (names.length === 2) return names[0] + " and " + names[1] + " are empty.";
    return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1] + " are empty.";
  }

  var XFOKeyConfirm = {
    VERIFIED_AT: VERIFIED_AT,
    PRIVACY: PRIVACY,
    OAUTH_FIELDS: OAUTH_FIELDS,
    extensionOrigin: extensionOrigin,
    frameParentOrigin: frameParentOrigin,
    hostForKeyForm: hostForKeyForm,
    clearsKeyVerification: clearsKeyVerification,
    probeRevokesVerification: probeRevokesVerification,
    showKeyForm: showKeyForm,
    keysAreVerified: keysAreVerified,
    savedKeyNeedsProbe: savedKeyNeedsProbe,
    sameKeyMaterial: sameKeyMaterial,
    oauthGaps: oauthGaps,
    oauthGapSentence: oauthGapSentence
  };

  root.XFOKeyConfirm = XFOKeyConfirm;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOKeyConfirm;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
