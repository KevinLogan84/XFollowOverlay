/**
 * Picks how Sync runs.
 * No signed-in tab → refuse.
 * Signed-in tab, no keys the user entered → web GraphQL on that tab.
 * Signed-in tab plus keys → the user's own X API.
 * Stored handles, ids, caches, and snapshots are not a session.
 */
(function (root) {
  var NO_SESSION_REASON = "Sign in on x.com in this tab, then run Sync.";
  /** Pause between session GraphQL pages so a free sync stays polite. */
  var SESSION_PAGE_GAP_MS = 1200;

  function clean(value) {
    return value == null ? "" : String(value).trim();
  }

  function userIdFromTwid(twid) {
    if (
      root.XFOSyncIdentity &&
      typeof root.XFOSyncIdentity.parseSelfUserIdFromTwid === "function"
    ) {
      return root.XFOSyncIdentity.parseSelfUserIdFromTwid(twid);
    }
    if (!twid) return null;
    var match = String(twid).match(/u\s*=\s*(\d{3,})/);
    return match ? match[1] : null;
  }

  /**
   * A session is the ct0 CSRF cookie plus the twid user id from this tab.
   * A saved username, user id, or follow snapshot does not count.
   */
  function sessionFromCookies(ct0, twid) {
    var csrf = clean(ct0);
    var userId = userIdFromTwid(twid);
    if (!csrf || !userId) return null;
    return { csrf: csrf, userId: String(userId) };
  }

  function normalizePrefer(value) {
    var prefer = clean(value).toLowerCase();
    if (prefer === "free" || prefer === "session") return "session";
    if (prefer === "api") return "api";
    return "";
  }

  function chooseSyncRoute(input) {
    input = input || {};
    var session = sessionFromCookies(input.ct0, input.twid);
    if (!session) {
      return {
        ok: false,
        path: null,
        userId: null,
        reason: NO_SESSION_REASON
      };
    }
    var keys = input.keys;
    var api =
      root.XFOApiKeys && typeof root.XFOApiKeys.hasUserApiKeys === "function"
        ? root.XFOApiKeys.hasUserApiKeys(keys)
        : false;
    var prefer = normalizePrefer(input.prefer);
    if (prefer === "session") {
      return { ok: true, path: "session", userId: session.userId, reason: "" };
    }
    if (prefer === "api") {
      if (!api) {
        return {
          ok: false,
          path: null,
          userId: session.userId,
          reason:
            "Add X API keys to sync with the API. The free sync still works."
        };
      }
      return { ok: true, path: "api", userId: session.userId, reason: "" };
    }
    if (api) {
      return { ok: true, path: "api", userId: session.userId, reason: "" };
    }
    return { ok: true, path: "session", userId: session.userId, reason: "" };
  }

  var XFOSyncRoute = {
    NO_SESSION_REASON: NO_SESSION_REASON,
    SESSION_PAGE_GAP_MS: SESSION_PAGE_GAP_MS,
    sessionFromCookies: sessionFromCookies,
    normalizePrefer: normalizePrefer,
    chooseSyncRoute: chooseSyncRoute
  };

  root.XFOSyncRoute = XFOSyncRoute;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOSyncRoute;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
