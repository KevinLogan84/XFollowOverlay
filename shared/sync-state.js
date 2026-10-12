/**
 * Shared sync UI / timeout helpers (classic script).
 * Loaded by the content script (rail panel) and Node tests.
 *
 * PR #4 only treated storage syncStatus=syncing + old syncStartedAt as stuck.
 * That misses the hang we actually hit: the rail's in-memory busy flag keeps
 * painting "Syncing…" after a fetch hangs, or after content init() wipes
 * syncStatus back to idle. Wall-clock age of the click (busySince) must also
 * unlock the button, independent of storage.
 */
(function (root) {
  var STUCK_MS = 25000;
  var HARD_MS = 420000;
  // Keep in sync with FollowRest.MAX_429_WAIT_MS (looked up at call time
  // when that module is loaded). Safari can throttle background-tab
  // timers so lastSyncProgressAt goes stale while a 429 wait is still live.
  var RATE_LIMIT_WAIT_MS = 16 * 60 * 1000;
  var RATE_LIMIT_STUCK_BUFFER_MS = 30000;
  var RATE_LIMIT_STUCK_MS = RATE_LIMIT_WAIT_MS + RATE_LIMIT_STUCK_BUFFER_MS;
  var RATE_LIMIT_WAIT_RE = /waiting for x(?:\.com)? rate limit/i;
  var PING_MS = 4000;
  var FETCH_MS = 20000;
  var STORAGE_MS = 2000;
  var GQL_ID_REFRESH_MS = 12000;
  // A page request with no accounts and no rate-limit wait. Retry once, then fail.
  var WATCHDOG_SILENCE_MS = 2 * 60 * 1000;
  var WATCHDOG_PAGE_RETRIES = 1;
  var TIMEOUT_ERROR = "Sync timed out. Keep x.com open and tap Sync now to retry.";
  var RATE_LIMIT_ERROR = "X is rate-limiting. Wait a minute and tap Sync now.";
  var STALL_ERROR =
    "Sync stalled on this page. Your place in the list is saved. Leave x.com open and tap Sync now to resume.";
  var KEYS_HINT_DISMISS_KEY = "hideRateLimitKeysHint";
  var KEYS_HINT_TEXT =
    "Want faster syncs? Add your own X API keys (paid, optional).";
  var KEYS_HINT_FREE_TEXT = "The free sync keeps working.";
  var KEYS_HINT_SETTINGS_HASH = "#optional-keys";
  var KEYS_HINT_README_URL =
    "https://github.com/KevinLogan84/XFollowOverlay/blob/main/README.md#optional-keys";

  function ageMs(startedAt, now) {
    var started = Number(startedAt) || 0;
    var ts = typeof now === "number" ? now : Date.now();
    return started ? ts - started : Infinity;
  }

  function isSyncing(status) {
    return status === "syncing";
  }

  function lastProgressAt(opts) {
    opts = opts || {};
    if (opts.busy) {
      var last = Number(opts.lastProgressAt) || 0;
      if (last) return last;
      return Number(opts.busySince) || 0;
    }
    if (isSyncing(opts.syncStatus)) {
      // Another tab owns this run. Its heartbeat lives in storage
      // (storedProgressAt); this tab's in-memory lastProgressAt is left
      // over from an older run and would flag a healthy sync as stuck.
      // A stored beat older than the run start belongs to a previous run.
      var started = Number(opts.syncStartedAt) || 0;
      var stored = Number(opts.storedProgressAt) || 0;
      return Math.max(started, stored);
    }
    return 0;
  }

  function progressLabelOf(opts) {
    opts = opts || {};
    if (opts.progressLabel != null && opts.progressLabel !== "") {
      return String(opts.progressLabel);
    }
    if (opts.syncProgressLabel != null && opts.syncProgressLabel !== "") {
      return String(opts.syncProgressLabel);
    }
    return "";
  }

  function isBackoffPending(backoffUntil, now) {
    var until = Number(backoffUntil) || 0;
    if (!until) return false;
    var ts = typeof now === "number" ? now : Date.now();
    return until > ts;
  }

  function isRateLimitWait(opts) {
    opts = opts || {};
    if (opts.waitingForRateLimit === true) return true;
    if (isBackoffPending(opts.backoffUntil, opts.now)) return true;
    return RATE_LIMIT_WAIT_RE.test(progressLabelOf(opts));
  }

  function formatRemainClock(ms) {
    var total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    var min = Math.floor(total / 60);
    var sec = total % 60;
    return min + ":" + (sec < 10 ? "0" : "") + sec;
  }

  /**
   * Live 429 copy. resumeAt is absolute ms; leftMs wins when passed.
   * Counts already read stay on the line so a wait does not look like a freeze.
   */
  function backoffStatusText(opts) {
    opts = opts || {};
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var left =
      opts.leftMs != null
        ? Number(opts.leftMs)
        : Math.max(0, (Number(opts.resumeAt) || 0) - now);
    var text =
      "Waiting for x.com rate limit, resuming in " + formatRemainClock(left);
    if (opts.count != null && opts.count !== "") {
      text += " · " + opts.count;
      if (opts.side) text += " " + opts.side;
    }
    return text;
  }

  function lastUpdateText(lastAt, now) {
    var ts = Number(lastAt) || 0;
    if (!ts) return "";
    var at = typeof now === "number" ? now : Date.now();
    var sec = Math.max(0, Math.floor((at - ts) / 1000));
    return "last update " + sec + "s ago";
  }

  /**
   * Silence with no backoff: retry the same cursor once, then fail.
   * A pending x-rate-limit-reset is not silence.
   * forceSilent treats a finished timeout as silence even inside the window.
   * cursor is returned unchanged so a retry does not start over.
   */
  function pageWatchdog(opts) {
    opts = opts || {};
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var cursor = opts.cursor || null;
    if (!opts.forceSilent && isBackoffPending(opts.backoffUntil, now)) {
      return { action: "backoff", cursor: cursor };
    }
    var last = Number(opts.lastProgressAt) || 0;
    var silent = opts.forceSilent ? Infinity : last ? now - last : Infinity;
    if (silent < WATCHDOG_SILENCE_MS) return { action: "ok", cursor: cursor };
    var used = Number(opts.silentRetries) || 0;
    var max =
      opts.maxSilentRetries != null
        ? Number(opts.maxSilentRetries)
        : WATCHDOG_PAGE_RETRIES;
    if (used < max) return { action: "retry-page", cursor: cursor };
    return { action: "fail", cursor: cursor, message: STALL_ERROR };
  }

  /** Keys upsell under the countdown. Hidden once dismissed, and whenever keys exist. */
  function showRateLimitKeysHint(opts) {
    opts = opts || {};
    if (!opts.backingOff) return false;
    if (opts.dismissed) return false;
    if (opts.hasKeys) return false;
    return true;
  }

  function rateLimitWaitMs() {
    var rest = root.XFOFollowRest;
    if (rest && typeof rest.MAX_429_WAIT_MS === "number") {
      return rest.MAX_429_WAIT_MS;
    }
    return RATE_LIMIT_WAIT_MS;
  }

  function rateLimitStuckMs() {
    return rateLimitWaitMs() + RATE_LIMIT_STUCK_BUFFER_MS;
  }

  function stuckMsFor(opts) {
    return isRateLimitWait(opts) ? rateLimitStuckMs() : STUCK_MS;
  }

  function hardMsFor(opts) {
    return isRateLimitWait(opts) ? rateLimitStuckMs() : HARD_MS;
  }

  function isStuck(opts) {
    opts = opts || {};
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var live = !!(opts.busy || isSyncing(opts.syncStatus));
    if (!live) return false;
    var beat = lastProgressAt(opts);
    if (!beat) return true;
    return now - beat > stuckMsFor(opts);
  }

  function showSyncing(opts) {
    opts = opts || {};
    if (isStuck(opts)) return false;
    if (opts.busy) return true;
    return isSyncing(opts.syncStatus);
  }

  function buttonText(opts) {
    if (showSyncing(opts)) return "Syncing…";
    if (isStuck(opts)) return "Retry sync";
    return "Sync now";
  }

  function buttonDisabled(opts) {
    return showSyncing(opts);
  }

  function shouldHardExpire(status, startedAt, now, lastProgressAt, progressLabel) {
    if (!isSyncing(status)) return false;
    var beat = Number(lastProgressAt) || Number(startedAt) || 0;
    if (!beat) return true;
    var ts = typeof now === "number" ? now : Date.now();
    var limit = hardMsFor({ progressLabel: progressLabel });
    return ts - beat > limit;
  }

  function expirePatch(message) {
    return {
      syncStatus: "error",
      syncError: message || TIMEOUT_ERROR,
      syncStartedAt: null
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

  var FOLLOW_STORAGE_KEYS = [
    "following",
    "followers",
    "followingIds",
    "followerIds",
    "followingTotal",
    "followersTotal",
    "selfUsername",
    "lastSyncAt",
    "syncStatus",
    "syncError",
    "syncStartedAt",
    "lastSyncProgressAt",
    "syncProgressLabel",
    "syncNote",
    "syncBackoffUntil",
    "syncProgressCount",
    "syncProgressSide",
    "hideRateLimitKeysHint"
  ];

  function followSnapshot(data, fallback) {
    var src = data && typeof data === "object" ? data : {};
    var prev = fallback && typeof fallback === "object" ? fallback : {};
    function pick(key) {
      return src[key] !== undefined ? src[key] : prev[key];
    }
    return {
      following: asList(pick("following")),
      followers: asList(pick("followers")),
      followingIds: asList(pick("followingIds")),
      followerIds: asList(pick("followerIds")),
      followingTotal: numberOrNull(pick("followingTotal")),
      followersTotal: numberOrNull(pick("followersTotal")),
      selfUsername: pick("selfUsername") || null,
      lastSyncAt: pick("lastSyncAt") || null,
      syncStatus: pick("syncStatus") || null,
      syncError: pick("syncError") || null,
      syncStartedAt: pick("syncStartedAt") || null,
      lastSyncProgressAt: pick("lastSyncProgressAt") || null,
      syncProgressLabel: pick("syncProgressLabel") || "",
      syncNote: pick("syncNote") || "",
      syncBackoffUntil: numberOrNull(pick("syncBackoffUntil")),
      syncProgressCount: numberOrNull(pick("syncProgressCount")),
      syncProgressSide: pick("syncProgressSide") || "",
      hideRateLimitKeysHint: pick("hideRateLimitKeysHint") === true
    };
  }

  function displayFollowCount(total, list) {
    var n = numberOrNull(total);
    if (n != null) return n;
    return asList(list).length;
  }

  function hasFollowSnapshot(data) {
    var snap = followSnapshot(data);
    if (snap.lastSyncAt) return true;
    if (snap.followingTotal != null) return true;
    if (snap.followersTotal != null) return true;
    if (snap.following.length) return true;
    if (snap.followers.length) return true;
    if (snap.followingIds.length) return true;
    if (snap.followerIds.length) return true;
    return false;
  }

  function showEmptyFollowBanner(data, opts) {
    opts = opts || {};
    if (opts.syncing || opts.busy) return false;
    return !hasFollowSnapshot(data);
  }

  function keepStorageSnapshot(fresh, previous) {
    if (fresh && typeof fresh === "object" && hasFollowSnapshot(fresh)) {
      return fresh;
    }
    return previous && typeof previous === "object" ? previous : {};
  }

  var XFOSyncState = {
    STUCK_MS: STUCK_MS,
    HARD_MS: HARD_MS,
    RATE_LIMIT_WAIT_MS: RATE_LIMIT_WAIT_MS,
    RATE_LIMIT_STUCK_BUFFER_MS: RATE_LIMIT_STUCK_BUFFER_MS,
    RATE_LIMIT_STUCK_MS: RATE_LIMIT_STUCK_MS,
    PING_MS: PING_MS,
    FETCH_MS: FETCH_MS,
    STORAGE_MS: STORAGE_MS,
    GQL_ID_REFRESH_MS: GQL_ID_REFRESH_MS,
    TIMEOUT_ERROR: TIMEOUT_ERROR,
    RATE_LIMIT_ERROR: RATE_LIMIT_ERROR,
    STALL_ERROR: STALL_ERROR,
    WATCHDOG_SILENCE_MS: WATCHDOG_SILENCE_MS,
    WATCHDOG_PAGE_RETRIES: WATCHDOG_PAGE_RETRIES,
    KEYS_HINT_DISMISS_KEY: KEYS_HINT_DISMISS_KEY,
    KEYS_HINT_TEXT: KEYS_HINT_TEXT,
    KEYS_HINT_FREE_TEXT: KEYS_HINT_FREE_TEXT,
    KEYS_HINT_SETTINGS_HASH: KEYS_HINT_SETTINGS_HASH,
    KEYS_HINT_README_URL: KEYS_HINT_README_URL,
    ageMs: ageMs,
    isSyncing: isSyncing,
    lastProgressAt: lastProgressAt,
    progressLabelOf: progressLabelOf,
    isBackoffPending: isBackoffPending,
    isRateLimitWait: isRateLimitWait,
    formatRemainClock: formatRemainClock,
    backoffStatusText: backoffStatusText,
    lastUpdateText: lastUpdateText,
    pageWatchdog: pageWatchdog,
    showRateLimitKeysHint: showRateLimitKeysHint,
    rateLimitWaitMs: rateLimitWaitMs,
    rateLimitStuckMs: rateLimitStuckMs,
    stuckMsFor: stuckMsFor,
    hardMsFor: hardMsFor,
    isStuck: isStuck,
    showSyncing: showSyncing,
    buttonText: buttonText,
    buttonDisabled: buttonDisabled,
    shouldHardExpire: shouldHardExpire,
    expirePatch: expirePatch,
    asList: asList,
    numberOrNull: numberOrNull,
    FOLLOW_STORAGE_KEYS: FOLLOW_STORAGE_KEYS,
    followSnapshot: followSnapshot,
    displayFollowCount: displayFollowCount,
    hasFollowSnapshot: hasFollowSnapshot,
    showEmptyFollowBanner: showEmptyFollowBanner,
    keepStorageSnapshot: keepStorageSnapshot
  };

  root.XFOSyncState = XFOSyncState;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOSyncState;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
