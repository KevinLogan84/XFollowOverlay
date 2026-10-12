/**
 * Runs in the page world so we see X's own fetch (with transaction ids).
 * Content scripts cannot attach this hook themselves.
 *
 * Also answers XFO_GQL and XFO_REST commands from the content script. Those
 * run through window.fetch so X's wrapper can attach
 * x-client-transaction-id — the header extension-made calls are missing.
 *
 * Reports three things from X's own traffic without adding requests: the
 * viewer's relationship to every user object it sees (XFO_RELATIONS), the
 * x-rate-limit-* window of each GraphQL op the pump spends from (XFO_RATE),
 * and the features / fieldToggles X itself just sent (XFO_GQL_FEATURES).
 * A new Grok build adds required switches; copying X's contract keeps our
 * calls from 400ing on a stale baked-in list.
 */
(function () {
  if (window.__xfoPageHook) return;
  window.__xfoPageHook = true;
  try {
    document.documentElement.setAttribute("data-xfo-hook", "1");
  } catch (e) {
    /* ignore */
  }

  // Public X web-client token (same value every browser session uses).
  var BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  // Replies go to the same document; never broadcast with "*".
  var MSG_ORIGIN =
    location && location.origin && location.origin !== "null"
      ? location.origin
      : "*";
  var ALLOWED = {
    Following: 1,
    Followers: 1,
    UserByScreenName: 1,
    UserTweets: 1,
    UserTweetsAndReplies: 1,
    SearchTimeline: 1
  };
  // Timeline reads match x.com (GET + page-world fetch so X can attach
  // x-client-transaction-id). Follow-list sync stays POST.
  var GQL_GET = {
    UserByScreenName: 1,
    UserTweets: 1,
    UserTweetsAndReplies: 1,
    SearchTimeline: 1
  };
  var REST_ALLOWED = {
    "/i/api/1.1/friends/ids.json": 1,
    "/i/api/1.1/followers/ids.json": 1,
    "/i/api/1.1/users/lookup.json": 1,
    "/i/api/1.1/friends/list.json": 1,
    "/i/api/1.1/followers/list.json": 1,
    "/i/api/1.1/account/verify_credentials.json": 1,
    "/i/api/1.1/account/settings.json": 1,
    "/i/api/1.1/users/show.json": 1,
    "/i/api/2/search/adaptive.json": 1
  };

  function restPathAllowed(path) {
    return !!(path && REST_ALLOWED[path]);
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch (e) {
      return match[1];
    }
  }

  function learnFromUrl(url) {
    var m = String(url || "").match(
      /\/i\/api\/graphql\/([^/?#]+)\/(UserTweetsAndReplies|UserTweets|SearchTimeline|UserByScreenName|Following|Followers)(?:\?|$)/
    );
    if (!m) return;
    try {
      window.postMessage(
        {
          source: "xfo-page-hook",
          type: "XFO_GQL_LEARN",
          queryId: m[1],
          operationName: m[2]
        },
        MSG_ORIGIN
      );
    } catch (e) {
      /* ignore */
    }
  }

  // Requests we make ourselves already carry our contract. Learning it back
  // would overwrite the newer one X just sent.
  var ownInits = typeof WeakSet === "function" ? new WeakSet() : null;
  var contractSig = {};

  function gqlOp(url) {
    var m = String(url || "").match(
      /\/i\/api\/graphql\/[^/?#]+\/(UserTweetsAndReplies|UserTweets|SearchTimeline|UserByScreenName|Following|Followers)(?:\?|$)/
    );
    return m ? m[1] : null;
  }

  function flagMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    for (var k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) return value;
    }
    return null;
  }

  function postContract(op, features, toggles) {
    if (!op || (!features && !toggles)) return;
    var sig;
    try {
      sig = JSON.stringify([features || null, toggles || null]);
    } catch (e) {
      return;
    }
    if (contractSig[op] === sig) return;
    contractSig[op] = sig;
    try {
      window.postMessage(
        {
          source: "xfo-page-hook",
          type: "XFO_GQL_FEATURES",
          operationName: op,
          features: features,
          fieldToggles: toggles
        },
        MSG_ORIGIN
      );
    } catch (e2) {
      /* ignore */
    }
  }

  /** features / fieldToggles from a GraphQL URL query or a JSON POST body. */
  function learnContract(url, init) {
    var op = gqlOp(url);
    if (!op) return;
    var features = null;
    var toggles = null;
    try {
      var parsed = new URL(String(url), (location && location.origin) || "https://x.com");
      var rawFeatures = parsed.searchParams.get("features");
      var rawToggles = parsed.searchParams.get("fieldToggles");
      if (rawFeatures) features = flagMap(JSON.parse(rawFeatures));
      if (rawToggles) toggles = flagMap(JSON.parse(rawToggles));
    } catch (e) {
      /* not a query-string contract */
    }
    var body = init && typeof init.body === "string" ? init.body : null;
    if (body && (!features || !toggles)) {
      try {
        var json = JSON.parse(body);
        if (!features && json) features = flagMap(json.features);
        if (!toggles && json) toggles = flagMap(json.fieldToggles);
      } catch (e2) {
        /* body is not the GraphQL envelope */
      }
    }
    if (features || toggles) postContract(op, features, toggles);
  }

  function gqlErrorText(text) {
    var raw = String(text || "");
    try {
      var json = JSON.parse(raw);
      if (json && json.errors && json.errors.length) {
        var parts = [];
        for (var i = 0; i < json.errors.length; i++) {
          if (json.errors[i] && json.errors[i].message) parts.push(json.errors[i].message);
        }
        if (parts.length) return parts.join("; ");
      }
    } catch (e) {
      /* plain text */
    }
    return raw;
  }

  function contractNames(text, label) {
    var re = new RegExp(label + " cannot be null:\\s*([A-Za-z0-9_,\\s]+)", "i");
    var m = String(text || "").match(re);
    if (!m) return null;
    var out = [];
    var seen = {};
    var bits = m[1].split(/[,\s]+/);
    for (var i = 0; i < bits.length; i++) {
      var key = bits[i];
      if (!key || seen[key]) continue;
      seen[key] = 1;
      out.push(key);
    }
    return out.length ? out : null;
  }

  function tap(url, json) {
    var m = String(url || "").match(
      /\/i\/api\/graphql\/[^/]+\/(Following|Followers)(?:\?|$)/
    );
    if (!m || !json) return;
    try {
      window.postMessage({ source: "xfo-page-hook", op: m[1], json: json }, MSG_ORIGIN);
    } catch (e) {
      /* ignore */
    }
  }

  // Passive relationship capture. Every user object in X's own responses
  // says whether the viewer follows that account and whether it follows
  // back (relationship_perspectives.* on 2025+ payloads, legacy.* before).
  // Harvest those from every GraphQL / notifications response so badges
  // update with zero requests of ours. friendships/create|destroy are the
  // user's own follow/unfollow clicks — the endpoint, not the eventually
  // consistent response body, says what the new state is.
  var RELATION_URL =
    /\/i\/api\/(?:graphql\/[^/?#]+\/[A-Za-z0-9_]+|2\/notifications\/[a-z_]+\.json|1\.1\/friendships\/(?:create|destroy)\.json)(?:\?|$)/;
  var ACTION_URL = /\/i\/api\/1\.1\/friendships\/(create|destroy)\.json(?:\?|$)/;
  var MAX_RELATION_NODES = 60000;
  var MAX_RELATION_DEPTH = 40;
  var MAX_RELATION_BYTES = 4 * 1024 * 1024;

  function boolOrNull(v) {
    return v === true || v === false ? v : null;
  }

  function relationFromNode(node) {
    var rp = node.relationship_perspectives;
    var legacy = node.legacy;
    var core = node.core;
    var f = null;
    var b = null;
    if (rp && typeof rp === "object") {
      f = boolOrNull(rp.following);
      b = boolOrNull(rp.followed_by);
    }
    if (legacy && typeof legacy === "object") {
      if (f == null) f = boolOrNull(legacy.following);
      if (b == null) b = boolOrNull(legacy.followed_by);
    }
    var id = node.rest_id || (legacy && legacy.id_str) || null;
    var handle =
      (core && core.screen_name) || (legacy && legacy.screen_name) || null;
    if (!id && node.id_str && node.screen_name) {
      // REST v1.1 user object (notifications globalObjects.users).
      id = node.id_str;
      handle = node.screen_name;
      if (f == null) f = boolOrNull(node.following);
      if (b == null) b = boolOrNull(node.followed_by);
    }
    if (!id || (f == null && b == null)) return null;
    id = String(id);
    if (!/^\d+$/.test(id)) return null;
    return {
      id: id,
      h: handle ? String(handle).toLowerCase() : null,
      f: f,
      b: b
    };
  }

  function harvestRelations(json) {
    var out = [];
    var seen = {};
    var budget = MAX_RELATION_NODES;
    function visit(node, depth) {
      if (!node || typeof node !== "object") return;
      if (depth > MAX_RELATION_DEPTH || budget-- <= 0) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) visit(node[i], depth + 1);
        return;
      }
      var rel = relationFromNode(node);
      if (rel && !seen[rel.id]) {
        seen[rel.id] = 1;
        out.push(rel);
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (key === "entities" || key === "extended_entities") continue;
        // A user's legacy block holds no nested users; a tweet's does
        // (retweeted_status_result), so only skip it for users.
        if (rel && (key === "legacy" || key === "core")) continue;
        visit(node[key], depth + 1);
      }
    }
    visit(json, 0);
    return out;
  }

  function paramFromBody(body, name) {
    if (!body || typeof body !== "string") return null;
    try {
      var v = new URLSearchParams(body).get(name);
      return v ? v : null;
    } catch (e) {
      return null;
    }
  }

  function relationFromAction(url, body, json) {
    var m = String(url || "").match(ACTION_URL);
    if (!m) return null;
    var id =
      (json && (json.id_str || (json.id != null ? String(json.id) : null))) ||
      paramFromBody(body, "user_id");
    var handle = (json && json.screen_name) || paramFromBody(body, "screen_name");
    if (!id || !/^\d+$/.test(String(id))) return null;
    return {
      id: String(id),
      h: handle ? String(handle).toLowerCase() : null,
      f: m[1] === "create",
      b: null
    };
  }

  function tapRelations(url, body, json) {
    if (!json || typeof json !== "object") return;
    var users;
    var action = false;
    if (ACTION_URL.test(String(url || ""))) {
      var rel = relationFromAction(url, body, json);
      if (!rel) return;
      users = [rel];
      action = true;
    } else {
      users = harvestRelations(json);
    }
    if (!users.length) return;
    try {
      window.postMessage(
        {
          source: "xfo-page-hook",
          type: "XFO_RELATIONS",
          users: users,
          action: action,
          at: Date.now()
        },
        MSG_ORIGIN
      );
    } catch (e) {
      /* ignore */
    }
  }

  function wantsRelations(url) {
    return RELATION_URL.test(String(url || ""));
  }

  // Rate-limit budget. X answers every GraphQL call with the window it
  // shares with our activity pump (x-rate-limit-*). Report those for the
  // ops the pump spends from — X's own profile loads included — so the
  // content script knows how much is left before it hits 429.
  var RATE_URL =
    /\/i\/api\/graphql\/[^/?#]+\/(UserTweets|UserTweetsAndReplies|UserByScreenName|SearchTimeline|Following|Followers)(?:\?|$)/;

  function postRate(url, status, getHeader) {
    var m = String(url || "").match(RATE_URL);
    if (!m) return;
    var limit = null;
    var remaining = null;
    var reset = null;
    try {
      limit = getHeader("x-rate-limit-limit");
      remaining = getHeader("x-rate-limit-remaining");
      reset = getHeader("x-rate-limit-reset");
    } catch (e) {
      /* opaque headers */
    }
    if (limit == null && remaining == null && reset == null && status !== 429) return;
    try {
      window.postMessage(
        {
          source: "xfo-page-hook",
          type: "XFO_RATE",
          op: m[1],
          status: status,
          limit: limit,
          remaining: remaining,
          reset: reset,
          at: Date.now()
        },
        MSG_ORIGIN
      );
    } catch (e) {
      /* ignore */
    }
  }

  function responseTooBig(res) {
    try {
      var len = res && res.headers && res.headers.get
        ? Number(res.headers.get("content-length"))
        : 0;
      return len > MAX_RELATION_BYTES;
    } catch (e) {
      return false;
    }
  }

  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function () {
      var req = arguments[0];
      var init = arguments[1];
      var url = typeof req === "string" ? req : (req && req.url) || "";
      var own = !!(ownInits && init && ownInits.has(init));
      learnFromUrl(url);
      if (!own) learnContract(url, init);
      var isFollowList = /\/i\/api\/graphql\/[^/]+\/(Following|Followers)/.test(url);
      var wantRel = wantsRelations(url);
      var body = init && typeof init.body === "string" ? init.body : null;
      return origFetch.apply(this, arguments).then(function (res) {
        if (res && RATE_URL.test(url)) {
          postRate(url, res.status, function (name) {
            return headerVal(res, name);
          });
        }
        if ((isFollowList || wantRel) && res && res.ok && !responseTooBig(res)) {
          try {
            res
              .clone()
              .json()
              .then(function (j) {
                if (isFollowList) tap(url, j);
                if (wantRel) tapRelations(url, body, j);
              })
              .catch(function () {});
          } catch (e) {
            /* ignore */
          }
        }
        return res;
      });
    };
  }

  var xo = XMLHttpRequest.prototype.open;
  var xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xfoUrl = url;
    learnFromUrl(url);
    return xo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.__xfoBody = typeof body === "string" ? body : null;
    learnContract(this.__xfoUrl || "", { body: this.__xfoBody });
    this.addEventListener("load", function () {
      var url = this.__xfoUrl || "";
      var xhr = this;
      if (RATE_URL.test(url)) {
        postRate(url, xhr.status, function (name) {
          return xhr.getResponseHeader(name);
        });
      }
      var isFollowList = /\/i\/api\/graphql\/[^/]+\/(Following|Followers)/.test(url);
      var wantRel = wantsRelations(url);
      if (!isFollowList && !wantRel) return;
      if (this.responseType && this.responseType !== "text") return;
      if (this.status && (this.status < 200 || this.status >= 300)) return;
      try {
        var json = JSON.parse(this.responseText);
        if (isFollowList) tap(url, json);
        if (wantRel) tapRelations(url, this.__xfoBody, json);
      } catch (e) {
        /* ignore */
      }
    });
    return xs.apply(this, arguments);
  };

  function pageFetchGraphql(queryId, operationName, variables, features, fieldToggles) {
    var csrf = getCookie("ct0");
    if (!csrf) return Promise.reject(new Error("Not logged in on x.com."));
    if (!queryId || !ALLOWED[operationName]) {
      return Promise.reject(new Error("Unsupported GraphQL op"));
    }
    var origin = (location && location.origin) || "https://x.com";
    var url =
      String(origin).replace(/\/$/, "") +
      "/i/api/graphql/" +
      encodeURIComponent(queryId) +
      "/" +
      encodeURIComponent(operationName);
    var useGet = !!GQL_GET[operationName];
    var headers = {
      authorization: "Bearer " + BEARER,
      "x-csrf-token": csrf,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      accept: "application/json"
    };
    var init = {
      method: useGet ? "GET" : "POST",
      credentials: "include",
      headers: headers
    };
    if (useGet) {
      url +=
        "?variables=" +
        encodeURIComponent(JSON.stringify(variables || {})) +
        "&features=" +
        encodeURIComponent(JSON.stringify(features || {}));
      if (fieldToggles) {
        url +=
          "&fieldToggles=" + encodeURIComponent(JSON.stringify(fieldToggles));
      }
    } else {
      headers["content-type"] = "application/json";
      var body = {
        variables: variables || {},
        features: features || {}
      };
      if (fieldToggles) body.fieldToggles = fieldToggles;
      init.body = JSON.stringify(body);
    }

    // Call the live window.fetch so a later X wrapper can add
    // x-client-transaction-id. Our wrapper still taps Following/Followers.
    // Mark this init so the wrapper does not learn our own contract back.
    if (ownInits) ownInits.add(init);
    var fetchFn = window.fetch;
    return fetchFn
      .call(window, url, init)
      .then(function (res) {
        return res.text().then(function (text) {
          var retryAfter = headerVal(res, "retry-after");
          var rateLimitReset = headerVal(res, "x-rate-limit-reset");
          var rateLimitRemaining = headerVal(res, "x-rate-limit-remaining");
          var rateLimitLimit = headerVal(res, "x-rate-limit-limit");
          if (!res.ok) {
            var detail = gqlErrorText(text);
            var err = new Error("X GQL " + res.status + ": " + detail.slice(0, 800));
            err.status = res.status;
            err.retryAfter = retryAfter;
            err.rateLimitReset = rateLimitReset;
            err.rateLimitRemaining = rateLimitRemaining;
            err.rateLimitLimit = rateLimitLimit;
            err.missingFeatures = contractNames(detail, "features");
            err.missingFieldToggles = contractNames(detail, "fieldToggles");
            throw err;
          }
          try {
            return {
              json: text ? JSON.parse(text) : null,
              retryAfter: retryAfter,
              rateLimitReset: rateLimitReset,
              rateLimitRemaining: rateLimitRemaining,
              rateLimitLimit: rateLimitLimit
            };
          } catch (e) {
            throw new Error("X GQL: invalid JSON");
          }
        });
      });
  }

  function headerVal(res, name) {
    try {
      return res && res.headers && res.headers.get
        ? res.headers.get(name)
        : null;
    } catch (e) {
      return null;
    }
  }

  function pageFetchRest(path, params) {
    var csrf = getCookie("ct0");
    if (!csrf) return Promise.reject(new Error("Not logged in on x.com."));
    if (!restPathAllowed(path)) {
      return Promise.reject(new Error("Unsupported REST path"));
    }
    var origin = (location && location.origin) || "https://x.com";
    var url = new URL(path, String(origin).replace(/\/$/, "") + "/");
    var keys = Object.keys(params || {});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (params[k] !== undefined && params[k] !== null) {
        url.searchParams.set(k, String(params[k]));
      }
    }
    var fetchFn = window.fetch;
    return fetchFn
      .call(window, url.toString(), {
        method: "GET",
        credentials: "include",
        headers: {
          authorization: "Bearer " + BEARER,
          "x-csrf-token": csrf,
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-active-user": "yes",
          "x-twitter-client-language": "en",
          accept: "application/json"
        }
      })
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          if (text) {
            try {
              json = JSON.parse(text);
            } catch (e) {
              json = null;
            }
          }
          return {
            ok: !!res.ok,
            status: res.status,
            json: json,
            text: String(text || "").slice(0, 240),
            retryAfter: headerVal(res, "retry-after"),
            rateLimitReset: headerVal(res, "x-rate-limit-reset")
          };
        });
      });
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== "xfo-content") return;
    if (d.type === "XFO_GQL") {
      pageFetchGraphql(
        d.queryId,
        d.operationName,
        d.variables,
        d.features,
        d.fieldToggles
      )
        .then(function (payload) {
          window.postMessage(
            {
              source: "xfo-page-hook",
              type: "XFO_GQL_RESULT",
              id: d.id,
              ok: true,
              json: payload && payload.json,
              retryAfter: payload && payload.retryAfter,
              rateLimitReset: payload && payload.rateLimitReset,
              rateLimitRemaining: payload && payload.rateLimitRemaining,
              rateLimitLimit: payload && payload.rateLimitLimit
            },
            MSG_ORIGIN
          );
        })
        .catch(function (err) {
          window.postMessage(
            {
              source: "xfo-page-hook",
              type: "XFO_GQL_RESULT",
              id: d.id,
              ok: false,
              status: err && err.status,
              retryAfter: err && err.retryAfter,
              rateLimitReset: err && err.rateLimitReset,
              rateLimitRemaining: err && err.rateLimitRemaining,
              rateLimitLimit: err && err.rateLimitLimit,
              missingFeatures: err && err.missingFeatures,
              missingFieldToggles: err && err.missingFieldToggles,
              error: err && err.message ? err.message : String(err)
            },
            MSG_ORIGIN
          );
        });
      return;
    }
    if (d.type === "XFO_REST") {
      pageFetchRest(d.path, d.params)
        .then(function (payload) {
          window.postMessage(
            {
              source: "xfo-page-hook",
              type: "XFO_REST_RESULT",
              id: d.id,
              ok: !!(payload && payload.ok),
              status: payload && payload.status,
              json: payload && payload.json,
              text: payload && payload.text,
              retryAfter: payload && payload.retryAfter,
              rateLimitReset: payload && payload.rateLimitReset
            },
            MSG_ORIGIN
          );
        })
        .catch(function (err) {
          window.postMessage(
            {
              source: "xfo-page-hook",
              type: "XFO_REST_RESULT",
              id: d.id,
              ok: false,
              error: err && err.message ? err.message : String(err)
            },
            MSG_ORIGIN
          );
        });
    }
  });
})();
