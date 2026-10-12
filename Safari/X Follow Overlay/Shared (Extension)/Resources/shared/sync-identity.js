/**
 * Shared follow-sync helpers (classic script).
 * Loaded by the content script and Node tests.
 *
 * Username detection must accept absolute x.com URLs and query strings —
 * X's profile link is often https://x.com/name?s=20, not /name.
 */
(function (root) {
  var RESERVED = {
    home: 1,
    explore: 1,
    search: 1,
    notifications: 1,
    messages: 1,
    i: 1,
    settings: 1,
    compose: 1,
    login: 1,
    signup: 1,
    intent: 1,
    hashtag: 1,
    following: 1,
    followers: 1,
    verified_followers: 1,
    lists: 1,
    communities: 1,
    jobs: 1,
    premium: 1,
    tos: 1,
    privacy: 1
  };

  var PROFILE_SELECTORS = [
    'a[data-testid="AppTabBar_Profile_Link"]',
    'a[data-testid="AppTabBar_Profile_Nav"]',
    'nav[role="navigation"] a[aria-label="Profile"]',
    'a[aria-label="Profile"]',
    'a[href^="/"][aria-label*="Profile"]',
    'a[href^="/"][aria-label*="profile"]'
  ];

  function extractUsernameFromHref(href) {
    if (!href) return null;
    try {
      var path = String(href);
      if (/^https?:\/\//i.test(path)) {
        path = new URL(path).pathname;
      } else {
        path = path.split("?")[0].split("#")[0];
      }
      var parts = path.split("/").filter(Boolean);
      if (!parts.length) return null;
      var candidate = parts[0];
      if (RESERVED[candidate.toLowerCase()]) return null;
      if (!/^[A-Za-z0-9_]{1,15}$/.test(candidate)) return null;
      return candidate.toLowerCase();
    } catch (e) {
      return null;
    }
  }

  function firstHandleFromNodes(nodes) {
    if (!nodes) return null;
    var list = typeof nodes.length === "number" ? nodes : [nodes];
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      if (!node || typeof node.getAttribute !== "function") continue;
      var handle = extractUsernameFromHref(node.getAttribute("href") || "");
      if (handle) return handle;
    }
    return null;
  }

  function detectSelfUsernameFromDom(doc, opts) {
    opts = opts || {};
    var root = doc || (typeof document !== "undefined" ? document : null);
    if (!root || typeof root.querySelector !== "function") {
      return opts.hint ? String(opts.hint).toLowerCase().replace(/^@/, "") : null;
    }

    for (var i = 0; i < PROFILE_SELECTORS.length; i++) {
      var handle = firstHandleFromNodes(root.querySelectorAll(PROFILE_SELECTORS[i]));
      if (handle) return handle;
    }

    var switcher = root.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (switcher) {
      var fromHref = extractUsernameFromHref(switcher.getAttribute("href") || "");
      if (fromHref) return fromHref;
      var label = switcher.getAttribute("aria-label") || "";
      var mentioned = label.match(/@([A-Za-z0-9_]{1,15})/);
      if (mentioned) return mentioned[1].toLowerCase();
    }

    var loc = opts.location || (typeof location !== "undefined" ? location : null);
    if (loc && loc.pathname) {
      var pathUser = extractUsernameFromHref(loc.pathname);
      if (
        pathUser &&
        (root.querySelector('[data-testid="editProfileButton"]') ||
          root.querySelector('a[href="/settings/profile"]'))
      ) {
        return pathUser;
      }
    }

    var hint = opts.hint ? String(opts.hint).toLowerCase().replace(/^@/, "") : "";
    return hint || null;
  }

  function parseSelfUserIdFromTwid(twid) {
    if (!twid) return null;
    var m = String(twid).match(/u\s*=\s*(\d{3,})/);
    return m ? m[1] : null;
  }

  function extractRestIdFromHref(href) {
    if (!href) return null;
    var m = String(href).match(/\/i\/user\/(\d{2,})(?:\/|$|\?|#)/i);
    return m ? m[1] : null;
  }

  function setHas(list, value) {
    if (!value || !list) return false;
    if (typeof list.has === "function") return list.has(value);
    if (Array.isArray(list)) return list.indexOf(value) !== -1;
    return !!list[value];
  }

  function classifyFollow(handle, restId, sets) {
    sets = sets || {};
    var h = handle ? String(handle).toLowerCase().replace(/^@/, "") : "";
    var id = restId ? String(restId) : "";
    var self = sets.selfUsername
      ? String(sets.selfUsername).toLowerCase().replace(/^@/, "")
      : "";
    if (self && h && h === self) return "self";
    var youFollow = setHas(sets.following, h) || setHas(sets.followingIds, id);
    var theyFollow = setHas(sets.followers, h) || setHas(sets.followerIds, id);
    if (youFollow && theyFollow) return "mutual";
    if (youFollow) return "following";
    if (theyFollow) return "follower";
    return "neither";
  }

  function asList(value) {
    return Array.isArray(value) ? value : [];
  }

  // Protected/suspended accounts stay on the official profile count but
  // drop from friends/followers list APIs. A cut-off crawl (cursor never
  // reached 0) may only be short by max(15 IDs, 2%) plus a hole GraphQL
  // already confirmed (opts.confirmedGap).
  var REST_MEMBERSHIP_ABS_SLACK = 15;
  var REST_MEMBERSHIP_PCT_SLACK = 0.02;
  // A cursor that ran to next_cursor 0 is X's own end of list; whatever the
  // profile count says beyond it is accounts X counts but will not list
  // (suspended, deactivated, hidden). Trust that cursor, up to a quarter of
  // the target. A bigger hole is a broken response.
  var EXHAUSTED_TRUST_PCT = 0.25;

  function restMembershipSlack(target) {
    var n = Math.max(0, Number(target) || 0);
    return Math.max(REST_MEMBERSHIP_ABS_SLACK, REST_MEMBERSHIP_PCT_SLACK * n);
  }

  function allowedListShortfall(target, opts) {
    var gap = Number(opts && opts.confirmedGap) || 0;
    return restMembershipSlack(target) + Math.max(0, gap);
  }

  function exhaustedListShortfall(target, opts) {
    var n = Math.max(0, Number(target) || 0);
    return Math.max(allowedListShortfall(n, opts), EXHAUSTED_TRUST_PCT * n);
  }

  function listLooksComplete(got, expected, previous, opts) {
    opts = opts || {};
    var handles = asList(got).length;
    var ids = opts.ids != null ? asList(opts.ids).length : 0;
    var membership = Math.max(ids, handles);
    var target = Math.max(Number(expected) || 0, asList(previous).length);

    if (membership <= 0) return false;
    if (target < 20) return true;
    if (membership >= target) return true;
    // Only a list whose cursor ran to the end may come up short: the hole
    // is accounts X counts but will not list. A cut-off crawl is not that.
    // Rail totals still use preferredListTotal (the profile count).
    if (!opts.exhausted) return false;
    return target - membership <= exhaustedListShortfall(target, opts);
  }

  // How many accounts X counts but did not list: shown in the rail next to
  // the profile count. Null when the list is at least as long as the count.
  function unlistedCount(total, ids, handles) {
    var n = Number(total);
    if (!isFinite(n) || n < 0) return null;
    var listed = Math.max(asList(ids).length, asList(handles).length);
    if (listed <= 0 || listed >= n) return null;
    return n - listed;
  }

  var XFOSyncIdentity = {
    extractUsernameFromHref: extractUsernameFromHref,
    extractRestIdFromHref: extractRestIdFromHref,
    detectSelfUsernameFromDom: detectSelfUsernameFromDom,
    parseSelfUserIdFromTwid: parseSelfUserIdFromTwid,
    classifyFollow: classifyFollow,
    listLooksComplete: listLooksComplete,
    restMembershipSlack: restMembershipSlack,
    allowedListShortfall: allowedListShortfall,
    exhaustedListShortfall: exhaustedListShortfall,
    unlistedCount: unlistedCount,
    REST_MEMBERSHIP_ABS_SLACK: REST_MEMBERSHIP_ABS_SLACK,
    REST_MEMBERSHIP_PCT_SLACK: REST_MEMBERSHIP_PCT_SLACK,
    EXHAUSTED_TRUST_PCT: EXHAUSTED_TRUST_PCT,
    PROFILE_SELECTORS: PROFILE_SELECTORS
  };

  root.XFOSyncIdentity = XFOSyncIdentity;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOSyncIdentity;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
