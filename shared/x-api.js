/**
 * Optional X API credentials the user types into settings.
 * Nothing in this file is a default key. Empty storage means the free
 * signed-in x.com session path.
 */
(function (root) {
  var STORAGE_KEYS = [
    "xApiKey",
    "xApiSecret",
    "xAccessToken",
    "xAccessSecret",
    "xApiBearer",
    "xUserToken",
    "xBearerToken",
    "xApiUserToken"
  ];
  /**
   * First launch of this build drops saved API keys and their
   * verify/error flags once. The marker stays "1.2.11" so a later
   * run does not wipe keys the user saves after this. Follow lists
   * and sync caches are not in this list.
   */
  var API_KEY_WIPE = "1.2.11";
  var API_KEY_WIPE_MARKER = "xfoApiKeyWipe";

  var PLACEHOLDERS = {
    "your-api-key": 1,
    "your_api_key": 1,
    "your-api-secret": 1,
    "your_api_secret": 1,
    "your-access-token": 1,
    "your_access_token": 1,
    "your-access-secret": 1,
    "your_access_secret": 1,
    "your-bearer-token": 1,
    "your_bearer_token": 1,
    changeme: 1,
    "paste-here": 1,
    "paste_here": 1,
    todo: 1,
    xxx: 1,
    test: 1,
    example: 1
  };

  function clean(value) {
    return value == null ? "" : String(value).trim();
  }

  function usable(value, minLen) {
    var v = clean(value);
    if (v.length < (minLen || 16)) return false;
    var lower = v.toLowerCase();
    if (PLACEHOLDERS[lower]) return false;
    if (/^(your[_-]|paste[_-]|changeme|example[_-])/.test(lower)) return false;
    return true;
  }

  function savedApiKeyFields() {
    return STORAGE_KEYS.concat(["keysVerifiedAt", "apiSyncError"]);
  }

  /** Null when this install already ran the 1.2.11 key wipe. */
  function apiKeyWipePlan(stored) {
    stored = stored || {};
    if (stored[API_KEY_WIPE_MARKER] === API_KEY_WIPE) return null;
    var set = {};
    set[API_KEY_WIPE_MARKER] = API_KEY_WIPE;
    return { remove: savedApiKeyFields(), set: set };
  }

  async function wipeSavedApiKeys(storage) {
    if (
      !storage ||
      typeof storage.get !== "function" ||
      typeof storage.remove !== "function" ||
      typeof storage.set !== "function"
    ) {
      return false;
    }
    var data = await storage.get([API_KEY_WIPE_MARKER]);
    var plan = apiKeyWipePlan(data);
    if (!plan) return false;
    await storage.remove(plan.remove);
    await storage.set(plan.set);
    return true;
  }

  function keysFromStorage(data) {
    data = data || {};
    return {
      apiKey: clean(data.xApiKey),
      apiSecret: clean(data.xApiSecret),
      accessToken: clean(data.xAccessToken),
      accessSecret: clean(data.xAccessSecret),
      bearer: clean(
        data.xApiBearer || data.xUserToken || data.xBearerToken || data.xApiUserToken
      )
    };
  }

  function hasOAuthKeys(keys) {
    if (!keys || typeof keys !== "object") return false;
    return (
      usable(keys.apiKey, 16) &&
      usable(keys.apiSecret, 16) &&
      usable(keys.accessToken, 16) &&
      usable(keys.accessSecret, 16)
    );
  }

  function hasBearer(keys) {
    return !!(keys && usable(keys.bearer, 20));
  }

  function hasUserApiKeys(keys) {
    return hasOAuthKeys(keys) || hasBearer(keys);
  }

  /**
   * OAuth 1.0a user context when all four keys are present.
   * Half-filled OAuth falls through to a bearer token the user pasted.
   * Null when neither is usable.
   */
  function credentialForRequest(keys) {
    if (hasOAuthKeys(keys)) {
      return {
        apiKey: clean(keys.apiKey),
        apiSecret: clean(keys.apiSecret),
        accessToken: clean(keys.accessToken),
        accessSecret: clean(keys.accessSecret)
      };
    }
    if (hasBearer(keys)) return clean(keys.bearer);
    return null;
  }

  /** Blank typed fields keep the saved value. Clear keys is a separate action. */
  function mergeKeyFields(typed, stored) {
    var names = ["apiKey", "apiSecret", "accessToken", "accessSecret", "bearer"];
    var out = {};
    typed = typed || {};
    stored = stored || {};
    names.forEach(function (name) {
      var next = clean(typed[name]);
      out[name] = next || clean(stored[name]);
    });
    return out;
  }

  /**
   * "Saved, ends in …abcd" once the value is longer than 8 characters.
   * Shorter values are masked completely so the label is not the secret.
   */
  function savedKeyLabel(value) {
    var v = clean(value);
    if (!v) return "";
    if (v.length <= 8) return "Saved";
    return "Saved, ends in …" + v.slice(-4);
  }

  function messageFromApiBody(body) {
    if (body == null) return "";
    if (typeof body === "string") {
      var trimmed = body.trim();
      if (!trimmed) return "";
      if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") {
        try {
          return messageFromApiBody(JSON.parse(trimmed));
        } catch (e) {
          return trimmed;
        }
      }
      return trimmed;
    }
    if (typeof body !== "object") return String(body);
    if (body.detail) return String(body.detail);
    var errors = body.errors;
    if (Array.isArray(errors) && errors[0]) {
      if (errors[0].message) return String(errors[0].message);
      if (errors[0].detail) return String(errors[0].detail);
    }
    if (body.message) return String(body.message);
    if (body.error_description) return String(body.error_description);
    if (body.error && typeof body.error !== "object") return String(body.error);
    if (body.title) return String(body.title);
    return "";
  }

  function formatApiSyncError(status, body) {
    var code = Number(status);
    if (!isFinite(code)) code = 0;
    if (typeof body === "string") {
      var trimmed = body.trim();
      var already = trimmed.match(/^X API (\d+):\s*([\s\S]*)$/);
      if (already && trimmed.charAt(0) !== "{") {
        var rest = already[2].trim();
        if (rest.charAt(0) === "{" || rest.charAt(0) === "[") {
          return formatApiSyncError(Number(already[1]), rest);
        }
        return ("X API " + already[1] + ": " + rest).slice(0, 220);
      }
    }
    var detail = messageFromApiBody(body).replace(/\s+/g, " ").trim();
    if (!detail) detail = "request failed";
    return ("X API " + code + ": " + detail).slice(0, 220);
  }

  /**
   * The rail shows the stored API failure. A later session error is used
   * only when no API error is stored.
   */
  function railErrorText(snap) {
    snap = snap || {};
    if (snap.apiSyncError) return String(snap.apiSyncError);
    if (snap.syncError) return String(snap.syncError);
    return "";
  }

  /**
   * Content-script fetch to api.x.com from x.com is a cross-site request.
   * Safari does not give content scripts the host-permission CORS exemption,
   * so the call fails with status 0. A real HTTP status is not that failure.
   */
  function isCrossSiteApiFailure(res) {
    if (!res || res.ok) return !res;
    if (res.crossSite) return true;
    var status = Number(res.status);
    if (!isFinite(status) || status === 0) return true;
    var text = String(res.text || res.message || "");
    return /cors|cross-site|cross site|access control|failed to fetch|load failed|networkerror/i.test(
      text
    );
  }

  function keyProbeRequest(userId) {
    return {
      path: "/2/users/" + encodeURIComponent(String(userId)) + "/following",
      params: { max_results: 1 }
    };
  }

  function keyProbeVerdict(res) {
    if (res && res.ok) {
      return { ok: true, status: Number(res.status) || 200, message: "Keys work", crossSite: false };
    }
    var status = res && res.status != null ? Number(res.status) : 0;
    if (!isFinite(status)) status = 0;
    var body = res && res.json != null ? res.json : res && res.text;
    return {
      ok: false,
      status: status,
      message: formatApiSyncError(status, body),
      crossSite: isCrossSiteApiFailure(res)
    };
  }

  /**
   * Try the caller first. Status 0 / CORS goes to the background worker,
   * which holds the api.x.com host permission.
   */
  async function fetchApiV2WithFallback(direct, background) {
    var res = null;
    try {
      res = await direct();
    } catch (e) {
      res = {
        ok: false,
        status: 0,
        json: null,
        text: e && e.message ? e.message : String(e),
        headers: {}
      };
    }
    if (!isCrossSiteApiFailure(res)) return res;
    if (typeof background !== "function") return res;
    try {
      var proxied = await background();
      return proxied || res;
    } catch (e2) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: e2 && e2.message ? e2.message : String(e2),
        headers: {}
      };
    }
  }

  function percentEncode(value) {
    return encodeURIComponent(String(value))
      .replace(/[!'()*]/g, function (ch) {
        return "%" + ch.charCodeAt(0).toString(16).toUpperCase();
      });
  }

  function normalizeParams(params) {
    var pairs = [];
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null) return;
      pairs.push([percentEncode(key), percentEncode(value)]);
    });
    pairs.sort(function (a, b) {
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      if (a[1] < b[1]) return -1;
      if (a[1] > b[1]) return 1;
      return 0;
    });
    return pairs
      .map(function (pair) {
        return pair[0] + "=" + pair[1];
      })
      .join("&");
  }

  function bytesToBase64(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    if (typeof btoa === "function") return btoa(bin);
    return Buffer.from(bin, "binary").toString("base64");
  }

  async function hmacSha1Base64(key, data) {
    var subtle =
      typeof crypto !== "undefined" && crypto.subtle ? crypto.subtle : null;
    if (subtle && typeof TextEncoder === "function") {
      var enc = new TextEncoder();
      var cryptoKey = await subtle.importKey(
        "raw",
        enc.encode(key),
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"]
      );
      var sig = await subtle.sign("HMAC", cryptoKey, enc.encode(data));
      return bytesToBase64(new Uint8Array(sig));
    }
    var nodeCrypto = require("crypto");
    return nodeCrypto.createHmac("sha1", key).update(data).digest("base64");
  }

  function randomNonce() {
    var bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var out = "";
    for (var j = 0; j < bytes.length; j++) {
      out += ("0" + bytes[j].toString(16)).slice(-2);
    }
    return out;
  }

  async function authorizationHeader(opts) {
    opts = opts || {};
    var keys = opts.keys || {};
    var method = String(opts.method || "GET").toUpperCase();
    var baseUrl = String(opts.url || "").split("?")[0];
    var nonce = opts.nonce || randomNonce();
    var timestamp = String(
      opts.timestamp != null ? opts.timestamp : Math.floor(Date.now() / 1000)
    );
    var oauth = {
      oauth_consumer_key: clean(keys.apiKey),
      oauth_nonce: nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: timestamp,
      oauth_token: clean(keys.accessToken),
      oauth_version: "1.0"
    };
    var all = {};
    Object.keys(opts.params || {}).forEach(function (key) {
      if (opts.params[key] === undefined || opts.params[key] === null) return;
      all[key] = String(opts.params[key]);
    });
    Object.keys(oauth).forEach(function (key) {
      all[key] = oauth[key];
    });
    var base =
      method +
      "&" +
      percentEncode(baseUrl) +
      "&" +
      percentEncode(normalizeParams(all));
    var signingKey =
      percentEncode(clean(keys.apiSecret)) + "&" + percentEncode(clean(keys.accessSecret));
    oauth.oauth_signature = await hmacSha1Base64(signingKey, base);
    var header = Object.keys(oauth)
      .sort()
      .map(function (key) {
        return percentEncode(key) + '="' + percentEncode(oauth[key]) + '"';
      })
      .join(", ");
    return "OAuth " + header;
  }

  var XFOApiKeys = {
    STORAGE_KEYS: STORAGE_KEYS,
    API_KEY_WIPE: API_KEY_WIPE,
    API_KEY_WIPE_MARKER: API_KEY_WIPE_MARKER,
    savedApiKeyFields: savedApiKeyFields,
    apiKeyWipePlan: apiKeyWipePlan,
    wipeSavedApiKeys: wipeSavedApiKeys,
    clean: clean,
    keysFromStorage: keysFromStorage,
    hasOAuthKeys: hasOAuthKeys,
    hasBearer: hasBearer,
    hasUserApiKeys: hasUserApiKeys,
    credentialForRequest: credentialForRequest,
    mergeKeyFields: mergeKeyFields,
    savedKeyLabel: savedKeyLabel,
    messageFromApiBody: messageFromApiBody,
    formatApiSyncError: formatApiSyncError,
    railErrorText: railErrorText,
    isCrossSiteApiFailure: isCrossSiteApiFailure,
    keyProbeRequest: keyProbeRequest,
    keyProbeVerdict: keyProbeVerdict,
    fetchApiV2WithFallback: fetchApiV2WithFallback,
    percentEncode: percentEncode,
    authorizationHeader: authorizationHeader
  };

  root.XFOApiKeys = XFOApiKeys;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOApiKeys;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
