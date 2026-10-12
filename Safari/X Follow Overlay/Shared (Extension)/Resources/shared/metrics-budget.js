/**
 * X GraphQL rate-limit budget (classic script).
 * Loaded by the content script and Node tests.
 *
 * X gives each GraphQL operation its own 15-minute window and reports it on
 * every response: x-rate-limit-limit / -remaining / -reset. Observed live:
 * UserTweetsAndReplies 500, UserTweets 50, UserByScreenName 150. The limit
 * is learned from the headers; DEFAULT_LIMIT only stands in until the first
 * response has been seen. The web client itself spends
 * from the same windows when the user opens a profile. The activity pump
 * used to learn about the window only by hitting 429 and then guessing how
 * long to wait; this module tracks what X actually said so the pump can
 * stop short of the limit, pace itself across what is left, and sleep until
 * the real reset instead of retrying blind.
 *
 * Remaining is null when nothing has been observed for that operation
 * (or the window has rolled over), which means "spend normally".
 */
(function (root) {
  var WINDOW_MS = 15 * 60 * 1000;
  var DEFAULT_LIMIT = 50;
  // Calls left for X's own client (a profile open is 2-3 timeline pages).
  var RESERVE = 6;
  // Below this share of the window we spread the rest over the time left.
  var PACE_BELOW = 0.5;
  var OPS = {
    UserTweets: 1,
    UserTweetsAndReplies: 1,
    UserByScreenName: 1,
    SearchTimeline: 1,
    Following: 1,
    Followers: 1
  };

  function num(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function nowOf(now) {
    return typeof now === "number" && isFinite(now) ? now : Date.now();
  }

  /** x-rate-limit-reset is epoch seconds; accept ms too. */
  function resetToMs(reset, now) {
    var n = num(reset);
    if (n == null || n <= 0) return null;
    if (n < 1e11) n = n * 1000;
    var ts = nowOf(now);
    // A reset in the past or absurdly far out is a bad header; use the window.
    if (n <= ts || n - ts > WINDOW_MS * 2) return ts + WINDOW_MS;
    return n;
  }

  function isOp(op) {
    return !!(op && OPS[op]);
  }

  function create(raw, now) {
    var state = { ops: {} };
    if (raw && typeof raw === "object" && raw.ops && typeof raw.ops === "object") {
      var ts = nowOf(now);
      Object.keys(raw.ops).forEach(function (op) {
        if (!isOp(op)) return;
        var e = raw.ops[op];
        if (!e || typeof e !== "object") return;
        var resetAt = num(e.resetAt);
        // Windows from a past reset are gone; do not carry stale zeros over.
        if (resetAt != null && resetAt <= ts) return;
        state.ops[op] = {
          limit: num(e.limit),
          remaining: num(e.remaining),
          resetAt: resetAt,
          updatedAt: num(e.updatedAt) || ts
        };
      });
    }
    return state;
  }

  function serialize(state) {
    var out = { ops: {} };
    var ops = (state && state.ops) || {};
    Object.keys(ops).forEach(function (op) {
      var e = ops[op];
      if (!e) return;
      out.ops[op] = {
        limit: e.limit,
        remaining: e.remaining,
        resetAt: e.resetAt,
        updatedAt: e.updatedAt
      };
    });
    return out;
  }

  function entry(state, op, now) {
    var e = state && state.ops && state.ops[op];
    if (!e) return null;
    if (e.resetAt != null && nowOf(now) >= e.resetAt) {
      // Window rolled over: X refilled it. Forget the old count.
      delete state.ops[op];
      return null;
    }
    return e;
  }

  /**
   * Learn from a response. headers: { limit, remaining, reset } as X sent
   * them (strings or numbers), or a Headers-like object with get().
   * status 429 with no remaining header still marks the window exhausted.
   */
  function note(state, op, headers, now) {
    if (!state || !isOp(op)) return state;
    var ts = nowOf(now);
    var h = headers || {};
    var get =
      typeof h.get === "function"
        ? function (k) {
            try {
              return h.get(k);
            } catch (e) {
              return null;
            }
          }
        : function (k) {
            return h[k];
          };
    var limit = num(get("x-rate-limit-limit"));
    if (limit == null) limit = num(h.limit);
    var remaining = num(get("x-rate-limit-remaining"));
    if (remaining == null) remaining = num(h.remaining);
    var reset = get("x-rate-limit-reset");
    if (reset == null) reset = h.reset;
    var status = num(h.status);
    var resetAt = resetToMs(reset, ts);

    if (status === 429 && remaining == null) remaining = 0;
    if (remaining == null && limit == null && status !== 429) return state;

    var prev = entry(state, op, ts);
    var next = {
      limit: limit != null ? limit : prev ? prev.limit : null,
      remaining: remaining,
      resetAt: resetAt || (prev ? prev.resetAt : null) || ts + WINDOW_MS,
      updatedAt: ts
    };
    if (next.remaining == null) next.remaining = prev ? prev.remaining : null;
    // Responses can land out of order; the smaller remaining is the truth
    // unless it belongs to an older window.
    if (
      prev &&
      prev.remaining != null &&
      next.remaining != null &&
      prev.resetAt != null &&
      next.resetAt != null &&
      Math.abs(prev.resetAt - next.resetAt) < 5000 &&
      prev.remaining < next.remaining
    ) {
      next.remaining = prev.remaining;
    }
    state.ops[op] = next;
    return state;
  }

  /** A 429 without headers: the window is spent until reset (or 15 min). */
  function noteExhausted(state, op, reset, now) {
    return note(state, op, { status: 429, remaining: 0, reset: reset }, now);
  }

  /** Count one call we are about to make so pacing does not lag a page. */
  function spend(state, op, now) {
    var e = entry(state, op, now);
    if (!e || e.remaining == null) return state;
    e.remaining = Math.max(0, e.remaining - 1);
    e.updatedAt = nowOf(now);
    return state;
  }

  /** Calls left in the current window, or null when unknown. */
  function remaining(state, op, now) {
    var e = entry(state, op, now);
    return e ? e.remaining : null;
  }

  function limitOf(state, op, now) {
    var e = entry(state, op, now);
    return e && e.limit != null ? e.limit : DEFAULT_LIMIT;
  }

  function resetAt(state, op, now) {
    var e = entry(state, op, now);
    return e ? e.resetAt : null;
  }

  function reserveOf(opts) {
    return opts && typeof opts.reserve === "number" ? opts.reserve : RESERVE;
  }

  /** Whether one more call to op may go out right now. */
  function canSpend(state, op, now, opts) {
    var r = remaining(state, op, now);
    if (r == null) return true;
    return r > reserveOf(opts);
  }

  /** Milliseconds until op may be called again; 0 when it may go now. */
  function waitMs(state, op, now, opts) {
    if (canSpend(state, op, now, opts)) return 0;
    var ts = nowOf(now);
    var at = resetAt(state, op, ts);
    if (at == null) return WINDOW_MS;
    return Math.max(1000, at - ts + 1500);
  }

  /**
   * Gap to leave before the next page of op. Normal gap while the window is
   * healthy; once below PACE_BELOW of the limit, spread the affordable calls
   * over the time left so the window is never emptied by one account.
   */
  function pageGapMs(state, op, now, opts) {
    var minGap = opts && typeof opts.minGap === "number" ? opts.minGap : 450;
    var ts = nowOf(now);
    var r = remaining(state, op, ts);
    if (r == null) return minGap;
    var lim = limitOf(state, op, ts);
    if (r > lim * PACE_BELOW) return minGap;
    var affordable = r - reserveOf(opts);
    if (affordable <= 0) return waitMs(state, op, ts, opts);
    var at = resetAt(state, op, ts);
    var left = at != null ? Math.max(0, at - ts) : WINDOW_MS;
    return Math.max(minGap, Math.floor(left / affordable));
  }

  /** True when a deep (many-page) pass is affordable without starving refreshes. */
  function healthy(state, op, now, opts) {
    var r = remaining(state, op, now);
    if (r == null) return true;
    var need = opts && typeof opts.pages === "number" ? opts.pages : 12;
    return r - reserveOf(opts) >= need && r > limitOf(state, op, now) * PACE_BELOW;
  }

  /**
   * Panel summary across the timeline ops: which op is out and when it
   * comes back. { paused, until, op } — paused false when all can spend.
   */
  function status(state, ops, now, opts) {
    var list = ops && ops.length ? ops : ["UserTweetsAndReplies", "UserTweets"];
    var ts = nowOf(now);
    var worst = null;
    for (var i = 0; i < list.length; i++) {
      var op = list[i];
      if (canSpend(state, op, ts, opts)) return { paused: false, until: null, op: null };
      var at = resetAt(state, op, ts) || ts + WINDOW_MS;
      if (!worst || at < worst.until) worst = { paused: true, until: at, op: op };
    }
    return worst || { paused: false, until: null, op: null };
  }

  var XFOMetricsBudget = {
    WINDOW_MS: WINDOW_MS,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    RESERVE: RESERVE,
    OPS: Object.keys(OPS),
    isOp: isOp,
    resetToMs: resetToMs,
    create: create,
    serialize: serialize,
    note: note,
    noteExhausted: noteExhausted,
    spend: spend,
    remaining: remaining,
    limitOf: limitOf,
    resetAt: resetAt,
    canSpend: canSpend,
    waitMs: waitMs,
    pageGapMs: pageGapMs,
    healthy: healthy,
    status: status
  };

  root.XFOMetricsBudget = XFOMetricsBudget;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOMetricsBudget;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
