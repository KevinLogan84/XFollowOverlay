/**
 * Parsing for X's GraphQL / REST timeline payloads and the GraphQL request
 * contract (classic script). Loaded by the content script and Node tests.
 *
 * X reshapes these payloads often (2026-05 moved tweet fields off `legacy`),
 * so every reader here accepts both the old and the flat shape.
 */
(function (root) {
  var MAX_DEPTH = 30;
  // Nested statuses that are someone else's post: never count them.
  var SKIP_KEYS = {
    legacy: 1,
    entities: 1,
    extended_entities: 1,
    retweeted_status_result: 1,
    quoted_status_result: 1,
    quoted_status: 1,
    retweeted_status: 1
  };

  /** GraphQL ISO or REST "Wed Oct 10 20:19:24 +0000 2018". */
  function parseTweetCreatedAt(raw) {
    if (!raw) return NaN;
    var ms = Date.parse(raw);
    return isNaN(ms) ? NaN : ms;
  }

  function snowflakeToMs(id) {
    if (!id) return NaN;
    try {
      return Number((BigInt(id) >> BigInt(22)) + BigInt("1288834974657"));
    } catch (e) {
      return NaN;
    }
  }

  function extractScreenNameFromUser(user) {
    if (!user || typeof user !== "object") return null;
    var legacy = user.legacy && typeof user.legacy === "object" ? user.legacy : {};
    var core = user.core && typeof user.core === "object" ? user.core : {};
    var raw = legacy.screen_name || core.screen_name || user.screen_name || null;
    return raw ? String(raw).toLowerCase() : null;
  }

  function unwrapTweetResult(result) {
    if (!result || typeof result !== "object") return null;
    if (result.tweet) return unwrapTweetResult(result.tweet);
    if (result.legacy) return result;
    // 2026-05+ schema: legacy may be null; fields live top-level.
    if (result.rest_id || result.id_str || result.created_at || result.full_text) return result;
    if (result.__typename === "Tweet" || result.__typename === "TweetWithVisibilityResults") {
      return result;
    }
    return null;
  }

  function tweetCreatedAndId(result) {
    var core = unwrapTweetResult(result);
    if (!core) return null;
    var legacy = core.legacy && typeof core.legacy === "object" ? core.legacy : {};
    var nested = core.core && typeof core.core === "object" ? core.core : {};
    var created = parseTweetCreatedAt(legacy.created_at || core.created_at || nested.created_at);
    var id = legacy.id_str || core.rest_id || core.id_str || core.id || "";
    if (isNaN(created) && id) created = snowflakeToMs(id);
    if (isNaN(created)) return null;
    return { created: created, id: id };
  }

  function extractRestTimelineTweets(data) {
    var list = Array.isArray(data) ? data : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var tw = list[i];
      if (!tw) continue;
      var id = tw.id_str || String(tw.id || "");
      var created = parseTweetCreatedAt(tw.created_at);
      var ms = isNaN(created) && id ? snowflakeToMs(id) : created;
      if (isNaN(ms)) continue;
      out.push({ created: ms, id: id });
    }
    return out;
  }

  function tweetBagFromNode(node) {
    if (!node || typeof node !== "object") return null;
    return (
      (node.tweet_results && node.tweet_results.result) ||
      (node.tweetResults && node.tweetResults.result) ||
      (node.tweetResult && node.tweetResult.result) ||
      (node.tweet_result && node.tweet_result.result) ||
      null
    );
  }

  /** Every tweet on a GraphQL timeline page, plus its bottom cursor. */
  function walkGraphqlInstructions(data) {
    var tweets = [];
    var seen = {};
    var bottomCursor = null;

    function consider(result) {
      var parsed = tweetCreatedAndId(result);
      if (!parsed) return;
      if (parsed.id) {
        if (seen[parsed.id]) return;
        seen[parsed.id] = 1;
      }
      tweets.push({ created: parsed.created, id: parsed.id });
    }

    function visit(node, depth) {
      if (!node || depth > MAX_DEPTH) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) visit(node[i], depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      if (node.cursorType === "Bottom" && node.value) bottomCursor = node.value;
      if (
        node.entryId &&
        String(node.entryId).indexOf("cursor-bottom") === 0 &&
        node.content &&
        node.content.value
      ) {
        bottomCursor = node.content.value;
      }
      var bag = tweetBagFromNode(node);
      if (bag) {
        consider(bag);
      } else if (
        node.__typename === "Tweet" ||
        ((node.legacy || node.created_at || node.full_text) && (node.rest_id || node.id_str))
      ) {
        consider(node);
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        if (SKIP_KEYS[keys[k]]) continue;
        visit(node[keys[k]], depth + 1);
      }
    }

    visit(data, 0);
    return { tweets: tweets, cursor: bottomCursor };
  }

  function namesAfter(text, label) {
    var m = String(text || "").match(
      new RegExp(label + "\\s*:\\s*([A-Za-z0-9_,\\s]+)", "i")
    );
    return m ? m[1].split(/[,\s]+/).filter(Boolean) : null;
  }

  /** Set each named flag to false when it is missing. Returns whether any was added. */
  function addMissingFlags(obj, keys) {
    if (!obj || !keys) return false;
    var changed = false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!k || typeof k !== "string" || !/^[A-Za-z0-9_]+$/.test(k)) continue;
      if (!Object.prototype.hasOwnProperty.call(obj, k) || obj[k] == null) {
        obj[k] = false;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * When X rotates its GraphQL contract it 400s with the offending switch
   * names. Add missing switches / drop unknown ones so the retry succeeds.
   */
  function adjustFeaturesFromError(features, text) {
    if (!features || !text) return false;
    var changed = addMissingFlags(features, namesAfter(text, "features cannot be null"));
    var unknown = namesAfter(text, "features? (?:are|is) (?:unknown|invalid|not [a-z ]*)");
    if (unknown) {
      for (var i = 0; i < unknown.length; i++) {
        if (Object.prototype.hasOwnProperty.call(features, unknown[i])) {
          delete features[unknown[i]];
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * Page-hook 400s name the switches X added (a Grok release does this).
   * false satisfies "cannot be null" without opting into a new response shape.
   */
  function adjustContractFromError(features, fieldToggles, err) {
    var text = err && err.message ? String(err.message) : "";
    var changed = adjustFeaturesFromError(features, text);
    if (err && Array.isArray(err.missingFeatures)) {
      changed = addMissingFlags(features, err.missingFeatures) || changed;
    }
    if (fieldToggles && typeof fieldToggles === "object") {
      changed =
        addMissingFlags(fieldToggles, namesAfter(text, "fieldToggles cannot be null")) || changed;
      if (err && Array.isArray(err.missingFieldToggles)) {
        changed = addMissingFlags(fieldToggles, err.missingFieldToggles) || changed;
      }
    }
    return changed;
  }

  var XFOGraphqlTimeline = {
    parseTweetCreatedAt: parseTweetCreatedAt,
    snowflakeToMs: snowflakeToMs,
    extractScreenNameFromUser: extractScreenNameFromUser,
    unwrapTweetResult: unwrapTweetResult,
    tweetCreatedAndId: tweetCreatedAndId,
    extractRestTimelineTweets: extractRestTimelineTweets,
    tweetBagFromNode: tweetBagFromNode,
    walkGraphqlInstructions: walkGraphqlInstructions,
    addMissingFlags: addMissingFlags,
    adjustFeaturesFromError: adjustFeaturesFromError,
    adjustContractFromError: adjustContractFromError
  };

  root.XFOGraphqlTimeline = XFOGraphqlTimeline;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOGraphqlTimeline;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
