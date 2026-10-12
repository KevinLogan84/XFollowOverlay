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
   * Otherwise a bearer token the user pasted. Null when neither is usable.
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
    clean: clean,
    keysFromStorage: keysFromStorage,
    hasOAuthKeys: hasOAuthKeys,
    hasBearer: hasBearer,
    hasUserApiKeys: hasUserApiKeys,
    credentialForRequest: credentialForRequest,
    percentEncode: percentEncode,
    authorizationHeader: authorizationHeader
  };

  root.XFOApiKeys = XFOApiKeys;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOApiKeys;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
