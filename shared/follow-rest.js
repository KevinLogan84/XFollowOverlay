/**
 * Follow-graph REST helpers (classic script).
 * Loaded by the content script and Node tests.
 *
 * Website REST helpers (ID lists, lookup, official counts) and the optional
 * API v2 fast path. With no keys, the caller syncs through the signed-in
 * tab's web GraphQL instead.
 */
(function (root) {
  var IDS_COUNT = 5000;
  var LOOKUP_CHUNK = 100;
  var LIST_COUNT = 200;
  var V2_MAX_RESULTS = 1000;
  var MAX_ID_PAGES = 40;
  var MAX_LIST_PAGES = 50;
  var MAX_V2_PAGES = 20;
  var MAX_429_WAITS = 12;
  var MAX_429_WAIT_MS = 16 * 60 * 1000;
  var DEFAULT_429_WAIT_MS = 60 * 1000;
  // GraphQL is the second opinion, not the only path. Two full rate-limit
  // windows is all a fallback crawl gets before the exhausted REST lists
  // are saved instead; its checkpoint lets the next sync pick up the crawl.
  var MAX_GRAPHQL_429_WAITS = 2;
  var CHECKPOINT_MAX_AGE_MS = 30 * 60 * 1000;
  // How long a GraphQL-confirmed list hole excuses a short REST list.
  var CONFIRMED_GAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  // Fallback mirror of Identity.EXHAUSTED_TRUST_PCT.
  var EXHAUSTED_TRUST_PCT = 0.25;
  /** Leftover lookup misses only — not a second full crawl. */
  var MAX_SHOW_MISSES = 80;

  var IDS_FOLLOWING = "/i/api/1.1/friends/ids.json";
  var IDS_FOLLOWERS = "/i/api/1.1/followers/ids.json";
  var LOOKUP = "/i/api/1.1/users/lookup.json";
  var SHOW = "/i/api/1.1/users/show.json";
  var VERIFY_CREDENTIALS = "/i/api/1.1/account/verify_credentials.json";
  var LIST_FOLLOWING = "/i/api/1.1/friends/list.json";
  var LIST_FOLLOWERS = "/i/api/1.1/followers/list.json";

  function httpError(status, text) {
    var err = new Error(
      "X API " + status + ": " + String(text || "").slice(0, 160)
    );
    err.status = status;
    if (isRestUnavailableStatus(status)) err.restUnavailable = true;
    return err;
  }

  function isRestUnavailableStatus(status) {
    return status === 403 || status === 404 || status === 410;
  }

  function statusFromError(err) {
    if (!err) return 0;
    if (err.status) return Number(err.status) || 0;
    var m = String(err.message || err).match(
      /\b(?:X API|X GQL|HTTP)\s+(\d{3})\b/i
    );
    return m ? Number(m[1]) : 0;
  }

  function isRestUnavailable(err) {
    if (!err) return false;
    if (err.restUnavailable) return true;
    return isRestUnavailableStatus(statusFromError(err));
  }

  function canTryNextRestPath(err) {
    if (isRestUnavailable(err)) return true;
    var status = statusFromError(err);
    return status === 500 || status === 502 || status === 503;
  }

  function clampWait(ms) {
    var n = Number(ms) || 0;
    if (n < 0) n = 0;
    if (n > MAX_429_WAIT_MS) n = MAX_429_WAIT_MS;
    if (n < 1000 && n > 0) n = 1000;
    return n;
  }

  function headerLookup(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === "function") {
      return (
        headers.get(name) ||
        headers.get(name.toLowerCase()) ||
        headers.get(name.toUpperCase())
      );
    }
    var keys = Object.keys(headers);
    var want = String(name).toLowerCase();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i]).toLowerCase() === want) return headers[keys[i]];
    }
    return null;
  }

  function waitMsFromRateLimitHeaders(headers, now) {
    now = typeof now === "number" ? now : Date.now();
    headers = headers || {};
    var retryAfter =
      headers.retryAfter != null
        ? headers.retryAfter
        : headerLookup(headers, "retry-after");
    var reset =
      headers.rateLimitReset != null
        ? headers.rateLimitReset
        : headerLookup(headers, "x-rate-limit-reset");

    if (retryAfter != null && retryAfter !== "") {
      var secs = Number(retryAfter);
      if (!isNaN(secs) && secs >= 0) return clampWait(Math.ceil(secs * 1000));
      var when = Date.parse(String(retryAfter));
      if (!isNaN(when)) return clampWait(Math.max(0, when - now));
    }
    if (reset != null && reset !== "") {
      var resetNum = Number(reset);
      if (!isNaN(resetNum)) {
        var resetMs = resetNum < 1e12 ? resetNum * 1000 : resetNum;
        if (resetMs > now) return clampWait(resetMs - now + 250);
      }
    }
    return DEFAULT_429_WAIT_MS;
  }

  function estimateRestSyncRequests(followingCount, followersCount, opts) {
    opts = opts || {};
    var following = Math.max(0, Number(followingCount) || 0);
    var followers = Math.max(0, Number(followersCount) || 0);
    var unique =
      opts.uniqueCount != null
        ? Math.max(0, Number(opts.uniqueCount) || 0)
        : following + followers;
    var cached = Math.max(0, Number(opts.cachedCount) || 0);
    var followingPages = Math.max(1, Math.ceil(following / IDS_COUNT) || 1);
    var followerPages = Math.max(1, Math.ceil(followers / IDS_COUNT) || 1);
    var needLookup = Math.max(0, unique - cached);
    var lookups = needLookup ? Math.ceil(needLookup / LOOKUP_CHUNK) : 0;
    var gql50 =
      (following ? Math.ceil(following / 50) : 0) +
      (followers ? Math.ceil(followers / 50) : 0);
    return {
      idPages: followingPages + followerPages,
      lookups: lookups,
      total: followingPages + followerPages + lookups,
      graphqlPagesAt50: gql50
    };
  }

  function asList(value) {
    return Array.isArray(value) ? value : [];
  }

  function numberOrNull(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n : null;
  }

  function uniqueIds(ids) {
    var out = [];
    var seen = {};
    var list = asList(ids);
    for (var i = 0; i < list.length; i++) {
      var id = String(list[i] || "");
      if (!id || seen[id]) continue;
      seen[id] = 1;
      out.push(id);
    }
    return out;
  }

  function idsNeedingLookup(ids, idToHandle) {
    var map = idToHandle || {};
    var need = [];
    var seen = {};
    for (var i = 0; i < (ids || []).length; i++) {
      var id = String(ids[i] || "");
      if (!id || seen[id]) continue;
      seen[id] = 1;
      if (!map[id]) need.push(id);
    }
    return need;
  }

  function handlesFromIds(ids, idToHandle) {
    var out = [];
    var seen = {};
    var map = idToHandle || {};
    for (var i = 0; i < (ids || []).length; i++) {
      var handle = map[String(ids[i])];
      if (!handle) continue;
      handle = String(handle).toLowerCase().replace(/^@/, "");
      if (!handle || seen[handle]) continue;
      seen[handle] = 1;
      out.push(handle);
    }
    return out;
  }

  function countsFromRestUser(user) {
    if (!user || typeof user !== "object") {
      return { following: null, followers: null };
    }
    return {
      following: numberOrNull(user.friends_count),
      followers: numberOrNull(user.followers_count)
    };
  }

  function mergeOfficialCounts(a, b) {
    var left = a && typeof a === "object" ? a : {};
    var right = b && typeof b === "object" ? b : {};
    var following = numberOrNull(left.following);
    var followers = numberOrNull(left.followers);
    if (following == null) following = numberOrNull(right.following);
    if (followers == null) followers = numberOrNull(right.followers);
    return { following: following, followers: followers };
  }

  function extractGraphqlUserNode(data) {
    if (!data || typeof data !== "object") return null;
    if (data.data && data.data.user && data.data.user.result) {
      return data.data.user.result;
    }
    if (data.user && data.user.result) return data.user.result;
    if (data.result && typeof data.result === "object") return data.result;
    return data;
  }

  function countsFromUserNode(node) {
    if (!node || typeof node !== "object") {
      return { following: null, followers: null };
    }
    if (node.__typename && node.__typename !== "User") {
      if (node.result) return countsFromUserNode(node.result);
      return { following: null, followers: null };
    }
    var following = numberOrNull(node.friends_count);
    var followers = numberOrNull(node.followers_count);
    var bags = [
      node.legacy,
      node.core,
      node.relationship_counts,
      node.legacy && node.legacy.counts
    ];
    for (var i = 0; i < bags.length; i++) {
      var bag = bags[i];
      if (!bag || typeof bag !== "object") continue;
      if (following == null) following = numberOrNull(bag.friends_count);
      if (followers == null) followers = numberOrNull(bag.followers_count);
    }
    if ((following == null || followers == null) && node.result) {
      var inner = countsFromUserNode(node.result);
      if (following == null) following = inner.following;
      if (followers == null) followers = inner.followers;
    }
    return { following: following, followers: followers };
  }

  function countsFromGraphqlUser(data) {
    return countsFromUserNode(extractGraphqlUserNode(data));
  }

  function parseCountText(text) {
    var raw = String(text || "").replace(/,/g, "");
    var m = raw.match(/([\d.]+)\s*(k|m)?/i);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n) || n < 0) return null;
    var suffix = (m[2] || "").toLowerCase();
    if (suffix === "k") n *= 1000;
    if (suffix === "m") n *= 1000000;
    return Math.round(n);
  }

  function profileCountHref(href, handle, side) {
    var path = String(href || "").split("?")[0].split("#")[0].toLowerCase();
    if (/^https?:\/\//i.test(path)) {
      try {
        path = new URL(path).pathname.toLowerCase();
      } catch (e) {
        return false;
      }
    }
    path = path.replace(/\/$/, "");
    return path === "/" + handle + "/" + side;
  }

  function countsFromProfileDom(doc, screenName) {
    var handle = String(screenName || "")
      .toLowerCase()
      .replace(/^@/, "");
    if (!handle || !doc || typeof doc.querySelectorAll !== "function") {
      return { following: null, followers: null };
    }
    var following = null;
    var followers = null;
    var links = doc.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href") || "";
      var text = links[i].textContent || "";
      var n = parseCountText(text);
      if (n == null) continue;
      if (profileCountHref(href, handle, "following") && /following/i.test(text)) {
        following = n;
      }
      if (profileCountHref(href, handle, "followers") && /follower/i.test(text)) {
        followers = n;
      }
    }
    return { following: following, followers: followers };
  }

  function preferredListTotal(official, ids, handles, stored) {
    var n = numberOrNull(official);
    if (n != null) return n;
    var listedIds = asList(ids).length;
    var listedHandles = asList(handles).length;
    var listed = listedIds > 0 ? listedIds : listedHandles;
    var prev = numberOrNull(stored);
    // Membership length is not a license to replace a higher stored
    // profile count (suspended/protected IDs are often missing).
    if (prev != null && prev >= listed) return prev;
    if (listedIds > 0) return listedIds;
    return listedHandles;
  }

  function mergeIdMap(idToHandle, pairs) {
    var next = {};
    var src = idToHandle || {};
    Object.keys(src).forEach(function (id) {
      if (src[id]) next[String(id)] = String(src[id]).toLowerCase();
    });
    for (var i = 0; i < (pairs || []).length; i++) {
      var p = pairs[i];
      if (!p || !p.id || !p.handle) continue;
      next[String(p.id)] = String(p.handle).toLowerCase().replace(/^@/, "");
    }
    return next;
  }

  function pruneIdMap(idToHandle, liveIds) {
    var keep = {};
    var live = {};
    (liveIds || []).forEach(function (id) {
      live[String(id)] = 1;
    });
    Object.keys(idToHandle || {}).forEach(function (id) {
      if (live[id] && idToHandle[id]) keep[id] = String(idToHandle[id]).toLowerCase();
    });
    return keep;
  }

  function restMembershipSize(result) {
    if (!result) return 0;
    return (
      Math.max(uniqueIds(result.followingIds).length, asList(result.following).length) +
      Math.max(uniqueIds(result.followerIds).length, asList(result.followers).length)
    );
  }

  function restIdSize(result) {
    if (!result) return 0;
    return uniqueIds(result.followingIds).length + uniqueIds(result.followerIds).length;
  }

  function pickRicherRestResult(a, b) {
    if (!a) return b;
    if (!b) return a;
    var sa = restMembershipSize(a);
    var sb = restMembershipSize(b);
    if (sb !== sa) return sb > sa ? b : a;
    var ia = restIdSize(a);
    var ib = restIdSize(b);
    if (ib !== ia) return ib > ia ? b : a;
    if (a.path === "rest-ids") return a;
    if (b.path === "rest-ids") return b;
    return a;
  }

  function membershipSlack(target) {
    var Identity = root.XFOSyncIdentity;
    if (Identity && typeof Identity.restMembershipSlack === "function") {
      return Identity.restMembershipSlack(target);
    }
    // Keep in lockstep with Identity.restMembershipSlack (15 IDs / 2%).
    return Math.max(15, 0.02 * (Number(target) || 0));
  }

  function restSideLooksComplete(ids, handles, expected, previous, exhausted, confirmedGap) {
    var Identity = root.XFOSyncIdentity;
    if (Identity && typeof Identity.listLooksComplete === "function") {
      return Identity.listLooksComplete(handles, expected, previous, {
        exhausted: !!exhausted,
        restMembership: true,
        ids: ids,
        confirmedGap: confirmedGap
      });
    }
    var membership = Math.max(uniqueIds(ids).length, asList(handles).length);
    var target = Math.max(Number(expected) || 0, asList(previous).length);
    if (membership <= 0) return false;
    if (target < 20) return true;
    if (membership >= target) return true;
    if (!exhausted) return false;
    // Keep in lockstep with Identity.exhaustedListShortfall (25% trust).
    return (
      target - membership <=
      Math.max(
        membershipSlack(target) + Math.max(0, Number(confirmedGap) || 0),
        EXHAUSTED_TRUST_PCT * target
      )
    );
  }

  function sideExhausted(result, side) {
    if (!result) return false;
    var flag =
      side === "followers" ? result.followersExhausted : result.followingExhausted;
    if (flag != null) return !!flag;
    return !!result.exhausted;
  }

  function sideMembership(result, side) {
    if (!result) return 0;
    var ids = side === "followers" ? result.followerIds : result.followingIds;
    var handles = side === "followers" ? result.followers : result.following;
    return Math.max(uniqueIds(ids).length, asList(handles).length);
  }

  function freshConfirmedGap(gap, now) {
    if (!gap || typeof gap !== "object") return null;
    var ts = Number(gap.at) || 0;
    var t = typeof now === "number" ? now : Date.now();
    if (!ts || t - ts < 0 || t - ts >= CONFIRMED_GAP_MAX_AGE_MS) return null;
    return {
      following: Math.max(0, Number(gap.following) || 0),
      followers: Math.max(0, Number(gap.followers) || 0),
      at: ts
    };
  }

  function confirmedGapFor(gap, side) {
    if (!gap || typeof gap !== "object") return 0;
    return Math.max(0, Number(gap[side]) || 0);
  }

  function restResultLooksComplete(result, input) {
    if (!result) return false;
    var gap = input && input.confirmedGap;
    return (
      restSideLooksComplete(
        result.followingIds,
        result.following,
        input && input.expectedFollowing,
        input && input.previousFollowing,
        sideExhausted(result, "following"),
        confirmedGapFor(gap, "following")
      ) &&
      restSideLooksComplete(
        result.followerIds,
        result.followers,
        input && input.expectedFollowers,
        input && input.previousFollowers,
        sideExhausted(result, "followers"),
        confirmedGapFor(gap, "followers")
      )
    );
  }

  function uniqueHandles(handles) {
    var out = [];
    var seen = {};
    var list = asList(handles);
    for (var i = 0; i < list.length; i++) {
      var h = String(list[i] || "").toLowerCase().replace(/^@/, "");
      if (!h || seen[h]) continue;
      seen[h] = 1;
      out.push(h);
    }
    return out;
  }

  function idMapPairs(map) {
    return Object.keys(map || {}).map(function (id) {
      return { id: id, handle: map[id] };
    });
  }

  // Two list APIs fetched at the same time describe the same graph; the
  // union is at least as complete as either. Exhausted means at least one
  // of them walked its cursor to the end.
  function unionFollowResults(a, b) {
    if (!a) return b;
    if (!b) return a;
    var followingEx = sideExhausted(a, "following") || sideExhausted(b, "following");
    var followersEx = sideExhausted(a, "followers") || sideExhausted(b, "followers");
    return {
      following: uniqueHandles(asList(a.following).concat(asList(b.following))),
      followers: uniqueHandles(asList(a.followers).concat(asList(b.followers))),
      followingIds: uniqueIds(asList(a.followingIds).concat(asList(b.followingIds))),
      followerIds: uniqueIds(asList(a.followerIds).concat(asList(b.followerIds))),
      idMap: mergeIdMap(a.idMap, idMapPairs(b.idMap)),
      path: (a.path || "rest") + "+" + (b.path || "graphql"),
      followingExhausted: followingEx,
      followersExhausted: followersEx,
      exhausted: followingEx && followersEx
    };
  }

  // REST and GraphQL both ran their cursors to the end and still stop short
  // of the profile count: the hole is accounts X counts but never lists.
  // Accept the side and remember the hole so the next sync can trust the
  // two-call REST path without another GraphQL crawl.
  function confirmGapAfterGraphql(packaged, rest, gql, expected, now) {
    var t = typeof now === "number" ? now : Date.now();
    var out = Object.assign({}, packaged);
    var gap = { following: 0, followers: 0, at: t };
    ["following", "followers"].forEach(function (side) {
      var okKey = side === "followers" ? "followersOk" : "followingOk";
      var membership = sideMembership(packaged, side);
      var want = Number(expected && expected[side]) || 0;
      if (sideExhausted(rest, side) && sideExhausted(gql, side) && membership > 0) {
        out[okKey] = true;
        gap[side] = Math.max(0, want - membership);
      }
    });
    if (out.followingOk && out.followersOk) out.confirmedGap = gap;
    return out;
  }

  // GraphQL could not give a second opinion (rate limit, dead query id).
  // An exhausted REST list is still the best follow graph X will serve;
  // save it instead of failing forever, but leave the hole unconfirmed so
  // GraphQL gets another try next sync (resuming its checkpoint).
  function acceptExhaustedSides(packaged) {
    var out = Object.assign({}, packaged);
    ["following", "followers"].forEach(function (side) {
      var okKey = side === "followers" ? "followersOk" : "followingOk";
      if (out[okKey]) return;
      if (sideExhausted(packaged, side) && sideMembership(packaged, side) > 0) {
        out[okKey] = true;
        out.unconfirmed = true;
      }
    });
    return out;
  }

  // Rail copy for a material hole, so missing "Follows you" badges on
  // accounts X will not list are not mistaken for a broken sync.
  function listGapNote(official, result) {
    var parts = [];
    [
      { key: "following", label: "following" },
      { key: "followers", label: "followers" }
    ].forEach(function (s) {
      var want = numberOrNull(official && official[s.key]);
      var have = sideMembership(result, s.key);
      if (want == null || !have) return;
      if (want - have <= membershipSlack(want)) return;
      parts.push(have + " of " + want + " " + s.label);
    });
    if (!parts.length) return "";
    return (
      "X lists " +
      parts.join(" and ") +
      " — the rest are accounts X counts but no longer shows."
    );
  }

  function nextCursor(data) {
    if (!data) return 0;
    var raw =
      data.next_cursor_str != null && data.next_cursor_str !== ""
        ? data.next_cursor_str
        : data.next_cursor;
    if (raw === undefined || raw === null || raw === "" || raw === 0 || raw === "0") {
      return 0;
    }
    return raw;
  }

  function identityParams(input) {
    var params = {};
    if (input && input.userId) params.user_id = String(input.userId);
    if (input && input.screenName) params.screen_name = String(input.screenName);
    return params;
  }

  function note(client, label) {
    if (client && typeof client.noteProgress === "function") {
      client.noteProgress(label);
    }
  }

  function throwIfAborted(client) {
    if (client && typeof client.throwIfAborted === "function") {
      client.throwIfAborted();
    }
  }

  async function waitFor(client, ms) {
    var wait = clampWait(ms);
    if (wait <= 0) return;
    if (client && typeof client.wait === "function") {
      await client.wait(wait);
      return;
    }
    await new Promise(function (resolve) {
      setTimeout(resolve, wait);
    });
  }

  async function requestWithRetry(client, path, params, opts) {
    opts = opts || {};
    var waits = 0;
    var serverTries = 0;
    while (true) {
      throwIfAborted(client);
      if (!client || typeof client.request !== "function") {
        throw new Error("REST client missing request()");
      }
      var res = await client.request(path, params, opts);
      if (res && res.ok) return res.json;
      var status = res && res.status ? res.status : 0;
      var text = (res && (res.text || (res.json && JSON.stringify(res.json)))) || "";
      if (status === 429 || /rate.?limit/i.test(text)) {
        waits += 1;
        if (waits > MAX_429_WAITS) throw httpError(429, text || "rate limited");
        var waitMs = waitMsFromRateLimitHeaders(res && res.headers);
        note(client, "Waiting for X rate limit…");
        await waitFor(client, waitMs);
        continue;
      }
      if (status === 500 || status === 502 || status === 503) {
        serverTries += 1;
        if (serverTries < 3) {
          note(client, "Retrying…");
          await waitFor(client, 2000 * serverTries);
          continue;
        }
      }
      throw httpError(status || 0, text);
    }
  }

  async function paginateIds(client, endpoint, input) {
    var ids = [];
    var cursor = -1;
    var pages = 0;
    var ident = identityParams(input);
    var side = /followers/i.test(endpoint) ? "followers" : "following";
    var expected =
      side === "followers"
        ? Number(input && input.expectedFollowers) || 0
        : Number(input && input.expectedFollowing) || 0;
    while (cursor !== 0 && pages < MAX_ID_PAGES) {
      throwIfAborted(client);
      var label = "Reading " + side + " ids… " + ids.length;
      if (expected) label += "/" + expected;
      note(client, label);
      var params = Object.assign({}, ident, {
        count: IDS_COUNT,
        cursor: cursor,
        stringify_ids: true
      });
      var data = await requestWithRetry(client, endpoint, params);
      var batch = data && data.ids ? data.ids : [];
      for (var i = 0; i < batch.length; i++) ids.push(String(batch[i]));
      cursor = nextCursor(data);
      pages += 1;
      // Empty page + next_cursor still set: keep paging (filtered/protected
      // IDs). Only stop when the cursor is done.
      if (!batch.length && cursor === 0) break;
    }
    return {
      ids: uniqueIds(ids),
      exhausted: cursor === 0,
      pages: pages
    };
  }

  function usersFromLookupPayload(data) {
    var batch = [];
    if (Array.isArray(data)) batch = data;
    else if (data && Array.isArray(data.users)) batch = data.users;
    return batch;
  }

  async function lookupUsersByIds(client, ids, idMap) {
    var map = mergeIdMap(idMap, []);
    var need = idsNeedingLookup(ids, map);
    for (var i = 0; i < need.length; i += LOOKUP_CHUNK) {
      throwIfAborted(client);
      var chunk = need.slice(i, i + LOOKUP_CHUNK);
      if (!chunk.length) break;
      note(
        client,
        "Looking up handles… " + Math.min(i + chunk.length, need.length) + "/" + need.length
      );
      var data = await requestWithRetry(client, LOOKUP, {
        user_id: chunk.join(","),
        include_entities: false
      });
      var batch = usersFromLookupPayload(data);
      var pairs = [];
      for (var j = 0; j < batch.length; j++) {
        var u = batch[j];
        if (!u || !u.screen_name) continue;
        var id = u.id_str || (u.id != null ? String(u.id) : null);
        if (!id) continue;
        pairs.push({ id: String(id), handle: String(u.screen_name).toLowerCase() });
      }
      map = mergeIdMap(map, pairs);
      if (client && typeof client.saveIdMap === "function") {
        try {
          await client.saveIdMap(map);
        } catch (e) {
          /* keep going with the in-memory map */
        }
      }
    }
    var leftover = idsNeedingLookup(ids, map);
    if (leftover.length) {
      map = await showUsersByIds(client, leftover, map);
    }
    return map;
  }

  async function showUsersByIds(client, ids, idMap) {
    var map = mergeIdMap(idMap, []);
    var need = idsNeedingLookup(ids, map);
    if (need.length > MAX_SHOW_MISSES) need = need.slice(0, MAX_SHOW_MISSES);
    for (var i = 0; i < need.length; i++) {
      throwIfAborted(client);
      note(client, "Looking up leftover ids… " + (i + 1) + "/" + need.length);
      try {
        var data = await requestWithRetry(client, SHOW, {
          user_id: need[i],
          include_entities: false
        });
        if (data && data.screen_name) {
          var id = data.id_str || (data.id != null ? String(data.id) : need[i]);
          map = mergeIdMap(map, [
            { id: String(id), handle: String(data.screen_name).toLowerCase() }
          ]);
          if (client && typeof client.saveIdMap === "function") {
            try {
              await client.saveIdMap(map);
            } catch (e) {
              /* keep going */
            }
          }
        }
      } catch (err) {
        var status = statusFromError(err);
        if (status === 404 || status === 403) continue;
        if (status === 429) throw err;
      }
    }
    return map;
  }

  async function fetchRestOfficialCounts(client, input) {
    var merged = { following: null, followers: null };
    try {
      var creds = await requestWithRetry(client, VERIFY_CREDENTIALS, {
        skip_status: true
      });
      merged = mergeOfficialCounts(merged, countsFromRestUser(creds));
      if (merged.following != null && merged.followers != null) return merged;
    } catch (eCreds) {
      /* users/show next — verify_credentials is the signed-in profile */
    }
    var params = identityParams(input);
    if (!params.user_id && !params.screen_name) return merged;
    try {
      var data = await requestWithRetry(client, SHOW, params);
      merged = mergeOfficialCounts(merged, countsFromRestUser(data));
    } catch (eShow) {
      /* caller may still have GraphQL / DOM */
    }
    return merged;
  }

  async function collectViaIds(client, input) {
    var followingPage = await paginateIds(client, IDS_FOLLOWING, input);
    var followerPage = await paginateIds(client, IDS_FOLLOWERS, input);
    var followingIds = followingPage.ids;
    var followerIds = followerPage.ids;
    var live = uniqueIds(followingIds.concat(followerIds));
    var map = pruneIdMap(input && input.idMap, live);
    map = await lookupUsersByIds(client, live, map);
    map = pruneIdMap(map, live);
    return {
      following: handlesFromIds(followingIds, map),
      followers: handlesFromIds(followerIds, map),
      followingIds: followingIds,
      followerIds: followerIds,
      idMap: map,
      path: "rest-ids",
      exhausted: !!(followingPage.exhausted && followerPage.exhausted),
      followingExhausted: !!followingPage.exhausted,
      followersExhausted: !!followerPage.exhausted
    };
  }

  async function paginateUserList(client, endpoint, input) {
    var users = [];
    var ids = [];
    var pairs = [];
    var cursor = -1;
    var pages = 0;
    var ident = identityParams(input);
    var side = /followers/i.test(endpoint) ? "followers" : "following";
    while (cursor !== 0 && pages < MAX_LIST_PAGES) {
      throwIfAborted(client);
      note(client, "Reading " + side + " list… " + users.length);
      var params = Object.assign({}, ident, {
        count: LIST_COUNT,
        cursor: cursor,
        skip_status: true,
        include_user_entities: false
      });
      var data = await requestWithRetry(client, endpoint, params);
      var batch = data && data.users ? data.users : [];
      for (var i = 0; i < batch.length; i++) {
        var u = batch[i];
        if (!u) continue;
        var id = u.id_str || (u.id != null ? String(u.id) : null);
        if (id) ids.push(String(id));
        if (!u.screen_name) continue;
        var handle = String(u.screen_name).toLowerCase();
        users.push(handle);
        if (id) pairs.push({ id: String(id), handle: handle });
      }
      cursor = nextCursor(data);
      pages += 1;
      if (!batch.length && cursor === 0) break;
    }
    var seen = {};
    var unique = [];
    for (var j = 0; j < users.length; j++) {
      if (seen[users[j]]) continue;
      seen[users[j]] = 1;
      unique.push(users[j]);
    }
    return {
      users: unique,
      ids: uniqueIds(ids),
      idMap: mergeIdMap({}, pairs),
      exhausted: cursor === 0
    };
  }

  async function collectViaList(client, input) {
    var following = await paginateUserList(client, LIST_FOLLOWING, input);
    var followers = await paginateUserList(client, LIST_FOLLOWERS, input);
    var live = uniqueIds(following.ids.concat(followers.ids));
    var map = pruneIdMap(input && input.idMap, live);
    map = mergeIdMap(
      map,
      Object.keys(following.idMap).map(function (id) {
        return { id: id, handle: following.idMap[id] };
      })
    );
    map = mergeIdMap(
      map,
      Object.keys(followers.idMap).map(function (id) {
        return { id: id, handle: followers.idMap[id] };
      })
    );
    map = pruneIdMap(map, live);
    return {
      following: following.users,
      followers: followers.users,
      followingIds: following.ids,
      followerIds: followers.ids,
      idMap: map,
      path: "rest-list",
      exhausted: !!(following.exhausted && followers.exhausted),
      followingExhausted: !!following.exhausted,
      followersExhausted: !!followers.exhausted
    };
  }

  function v2Handles(data) {
    var users = data && Array.isArray(data.data) ? data.data : [];
    var out = [];
    var ids = [];
    var pairs = [];
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      if (!u) continue;
      if (u.id) ids.push(String(u.id));
      var handle = u.username || u.screen_name;
      if (!handle) continue;
      handle = String(handle).toLowerCase();
      out.push(handle);
      if (u.id) pairs.push({ id: String(u.id), handle: handle });
    }
    return { users: out, ids: ids, pairs: pairs };
  }

  async function paginateV2(client, userId, side, token) {
    if (!client || typeof client.requestV2 !== "function") {
      throw httpError(404, "v2 client missing");
    }
    var users = [];
    var ids = [];
    var pairs = [];
    var tokenPage = null;
    var pages = 0;
    var path = "/2/users/" + encodeURIComponent(String(userId)) + "/" + side;
    while (pages < MAX_V2_PAGES) {
      throwIfAborted(client);
      note(client, "Reading " + side + " (v2)… " + users.length);
      var params = { max_results: V2_MAX_RESULTS, "user.fields": "username" };
      if (tokenPage) params.pagination_token = tokenPage;
      var res = await client.requestV2(path, params, token);
      if (!res || !res.ok) {
        throw httpError((res && res.status) || 0, (res && res.text) || "v2 failed");
      }
      var parsed = v2Handles(res.json);
      for (var i = 0; i < parsed.users.length; i++) users.push(parsed.users[i]);
      for (var j = 0; j < parsed.pairs.length; j++) pairs.push(parsed.pairs[j]);
      for (var n = 0; n < (parsed.ids || []).length; n++) ids.push(parsed.ids[n]);
      var next =
        res.json &&
        res.json.meta &&
        res.json.meta.next_token
          ? res.json.meta.next_token
          : null;
      pages += 1;
      if (!next || !parsed.users.length) break;
      tokenPage = next;
    }
    var seen = {};
    var unique = [];
    for (var k = 0; k < users.length; k++) {
      if (seen[users[k]]) continue;
      seen[users[k]] = 1;
      unique.push(users[k]);
    }
    return { users: unique, ids: uniqueIds(ids), idMap: mergeIdMap({}, pairs) };
  }

  async function collectViaV2(client, input) {
    if (!input || !input.userToken || !input.userId) {
      throw httpError(404, "no user token");
    }
    var following = await paginateV2(
      client,
      input.userId,
      "following",
      input.userToken
    );
    var followers = await paginateV2(
      client,
      input.userId,
      "followers",
      input.userToken
    );
    var live = uniqueIds(following.ids.concat(followers.ids));
    var map = pruneIdMap(input && input.idMap, live);
    map = mergeIdMap(
      map,
      Object.keys(following.idMap).map(function (id) {
        return { id: id, handle: following.idMap[id] };
      })
    );
    map = mergeIdMap(
      map,
      Object.keys(followers.idMap).map(function (id) {
        return { id: id, handle: followers.idMap[id] };
      })
    );
    map = pruneIdMap(map, live);
    return {
      following: following.users,
      followers: followers.users,
      followingIds: following.ids,
      followerIds: followers.ids,
      idMap: map,
      path: "rest-v2",
      exhausted: true,
      followingExhausted: true,
      followersExhausted: true
    };
  }

  async function tryRestFollowLists(client, input) {
    var best = null;
    var lastErr = null;
    try {
      best = await collectViaIds(client, input);
      if (restResultLooksComplete(best, input)) return best;
    } catch (e) {
      if (!canTryNextRestPath(e)) throw e;
      lastErr = e;
    }
    try {
      best = pickRicherRestResult(best, await collectViaList(client, input));
      if (restResultLooksComplete(best, input)) return best;
    } catch (e2) {
      if (!canTryNextRestPath(e2)) throw e2;
      lastErr = e2;
    }
    if (input && input.userToken && input.userId) {
      try {
        best = pickRicherRestResult(best, await collectViaV2(client, input));
        if (restResultLooksComplete(best, input)) return best;
      } catch (e3) {
        if (!canTryNextRestPath(e3)) throw e3;
        lastErr = e3;
      }
    }
    if (best) return best;
    var err = httpError(
      (lastErr && lastErr.status) || 404,
      (lastErr && lastErr.message) || "REST follow lists unavailable"
    );
    err.restUnavailable = true;
    throw err;
  }

  function checkpointFresh(cp, now, maxAgeMs) {
    if (!cp || typeof cp !== "object") return false;
    var ts = Number(cp.updatedAt || cp.startedAt) || 0;
    if (!ts) return false;
    var age = (typeof now === "number" ? now : Date.now()) - ts;
    return age >= 0 && age < (maxAgeMs || CHECKPOINT_MAX_AGE_MS);
  }

  function resumeGraphqlCheckpoint(cp, side, userId, now) {
    if (!checkpointFresh(cp, now)) return null;
    if (!cp || cp.path !== "graphql") return null;
    if (String(cp.side || "") !== String(side || "")) return null;
    if (userId && cp.userId && String(cp.userId) !== String(userId)) return null;
    return {
      users: Array.isArray(cp.users) ? cp.users.slice() : [],
      ids: Array.isArray(cp.ids) ? cp.ids.slice() : [],
      cursor: cp.cursor || null
    };
  }

  var XFOFollowRest = {
    IDS_COUNT: IDS_COUNT,
    LOOKUP_CHUNK: LOOKUP_CHUNK,
    LIST_COUNT: LIST_COUNT,
    V2_MAX_RESULTS: V2_MAX_RESULTS,
    IDS_FOLLOWING: IDS_FOLLOWING,
    IDS_FOLLOWERS: IDS_FOLLOWERS,
    LOOKUP: LOOKUP,
    SHOW: SHOW,
    VERIFY_CREDENTIALS: VERIFY_CREDENTIALS,
    LIST_FOLLOWING: LIST_FOLLOWING,
    LIST_FOLLOWERS: LIST_FOLLOWERS,
    MAX_SHOW_MISSES: MAX_SHOW_MISSES,
    MAX_429_WAIT_MS: MAX_429_WAIT_MS,
    MAX_GRAPHQL_429_WAITS: MAX_GRAPHQL_429_WAITS,
    DEFAULT_429_WAIT_MS: DEFAULT_429_WAIT_MS,
    CHECKPOINT_MAX_AGE_MS: CHECKPOINT_MAX_AGE_MS,
    CONFIRMED_GAP_MAX_AGE_MS: CONFIRMED_GAP_MAX_AGE_MS,
    EXHAUSTED_TRUST_PCT: EXHAUSTED_TRUST_PCT,
    httpError: httpError,
    isRestUnavailableStatus: isRestUnavailableStatus,
    isRestUnavailable: isRestUnavailable,
    canTryNextRestPath: canTryNextRestPath,
    waitMsFromRateLimitHeaders: waitMsFromRateLimitHeaders,
    estimateRestSyncRequests: estimateRestSyncRequests,
    asList: asList,
    numberOrNull: numberOrNull,
    uniqueIds: uniqueIds,
    idsNeedingLookup: idsNeedingLookup,
    handlesFromIds: handlesFromIds,
    countsFromRestUser: countsFromRestUser,
    mergeOfficialCounts: mergeOfficialCounts,
    extractGraphqlUserNode: extractGraphqlUserNode,
    countsFromUserNode: countsFromUserNode,
    countsFromGraphqlUser: countsFromGraphqlUser,
    parseCountText: parseCountText,
    countsFromProfileDom: countsFromProfileDom,
    preferredListTotal: preferredListTotal,
    mergeIdMap: mergeIdMap,
    pruneIdMap: pruneIdMap,
    restMembershipSize: restMembershipSize,
    restIdSize: restIdSize,
    pickRicherRestResult: pickRicherRestResult,
    restResultLooksComplete: restResultLooksComplete,
    sideExhausted: sideExhausted,
    sideMembership: sideMembership,
    freshConfirmedGap: freshConfirmedGap,
    confirmedGapFor: confirmedGapFor,
    uniqueHandles: uniqueHandles,
    unionFollowResults: unionFollowResults,
    confirmGapAfterGraphql: confirmGapAfterGraphql,
    acceptExhaustedSides: acceptExhaustedSides,
    listGapNote: listGapNote,
    nextCursor: nextCursor,
    requestWithRetry: requestWithRetry,
    paginateIds: paginateIds,
    lookupUsersByIds: lookupUsersByIds,
    showUsersByIds: showUsersByIds,
    fetchRestOfficialCounts: fetchRestOfficialCounts,
    collectViaIds: collectViaIds,
    collectViaList: collectViaList,
    collectViaV2: collectViaV2,
    tryRestFollowLists: tryRestFollowLists,
    checkpointFresh: checkpointFresh,
    resumeGraphqlCheckpoint: resumeGraphqlCheckpoint
  };

  root.XFOFollowRest = XFOFollowRest;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOFollowRest;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
