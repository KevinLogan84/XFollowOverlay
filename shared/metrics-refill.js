/**
 * Shared Days-refill planner (classic script).
 * After Sync now or an epoch wipe the metrics cache can be {} — visible
 * handles must be enqueued and the pump started, never left on a
 * dash-only "Days" face.
 *
 * Also owns the stale-0 policy: a day map whose newest post is before
 * yesterday (America/Chicago) is not a finished zero streak. Soft-refresh
 * those entries (and any with posts after 12h). Usable maps always paint a
 * real number — never perpetual "… Days". Stale-zero uses the consecutive
 * run ending at the newest posted day; a fresh-enough gap paints 0. The
 * pump must still be enqueued (face.refill) so visible badges are not idle.
 */
(function (root) {
  var METRICS_TZ = "America/Chicago";
  var DEFAULT_SOFT_REFRESH_MS = 12 * 60 * 60 * 1000;
  var DEFAULT_EMPTY_RETRY_MS = 15 * 60 * 1000;
  var chicagoFormatter = null;

  function isNumericRestId(user) {
    return /^\d{6,}$/.test(String(user || ""));
  }

  function normalizeHandle(user) {
    return String(user || "")
      .toLowerCase()
      .replace(/^@/, "");
  }

  function getChicagoFormatter() {
    if (!chicagoFormatter) {
      chicagoFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: METRICS_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
    }
    return chicagoFormatter;
  }

  function chicagoDateParts(ms) {
    var d = new Date(typeof ms === "number" ? ms : Date.parse(ms));
    if (Number.isNaN(d.getTime())) return null;
    try {
      var parts = getChicagoFormatter().formatToParts(d);
      var map = {};
      for (var i = 0; i < parts.length; i++) {
        map[parts[i].type] = parts[i].value;
      }
      var y = Number(map.year);
      var m = Number(map.month);
      var day = Number(map.day);
      if (!y || !m || !day) return null;
      return { y: y, m: m, d: day };
    } catch (e) {
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    }
  }

  function shiftCivilDate(y, m, d, days) {
    var dt = new Date(Date.UTC(y, m - 1, d + days));
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  function dayStartFromKey(key) {
    var parts = String(key || "").split("-");
    if (parts.length !== 3) return NaN;
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    var d = Number(parts[2]);
    if (!y || !m || !d) return NaN;
    return Date.UTC(y, m - 1, d);
  }

  function calendarDaysAgoStart(now, daysAgo) {
    var p = chicagoDateParts(now);
    if (!p) return NaN;
    var shifted = shiftCivilDate(p.y, p.m, p.d, -daysAgo);
    return Date.UTC(shifted.y, shifted.m - 1, shifted.d);
  }

  function newestPostedDayMs(days) {
    var newest = null;
    Object.keys(days || {}).forEach(function (key) {
      if ((Number(days[key]) || 0) <= 0) return;
      var start = dayStartFromKey(key);
      if (!Number.isNaN(start) && (newest == null || start > newest)) newest = start;
    });
    return newest;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function dayKeyFromYmd(p) {
    return p.y + "-" + pad2(p.m) + "-" + pad2(p.d);
  }

  /**
   * Consecutive posted Chicago days ending at the newest day in the map.
   * Used when the streak from today is 0 but the cache still has posts —
   * an honest last-known run, not a hidden 0 behind "…".
   */
  function streakFromNewestDay(days) {
    var newest = newestPostedDayMs(days);
    if (newest == null) return 0;
    var dt = new Date(newest);
    var cursor = {
      y: dt.getUTCFullYear(),
      m: dt.getUTCMonth() + 1,
      d: dt.getUTCDate()
    };
    var streak = 0;
    while (streak < 400) {
      var key = dayKeyFromYmd(cursor);
      if ((Number(days[key]) || 0) > 0) {
        streak += 1;
        cursor = shiftCivilDate(cursor.y, cursor.m, cursor.d, -1);
      } else {
        break;
      }
    }
    return streak;
  }

  function hasCountedPosts(entry) {
    if (!entry || entry.error) return false;
    if (entry.newestId) return true;
    if (entry.days && typeof entry.days === "object") {
      var n = 0;
      Object.keys(entry.days).forEach(function (k) {
        n += Number(entry.days[k]) || 0;
      });
      return n > 0;
    }
    return (entry.day || 0) + (entry.week || 0) + (entry.month || 0) > 0;
  }

  /**
   * True when the entry has posts but would paint streak 0 because the
   * newest Chicago day is before yesterday, and the sample is not fresh
   * enough to trust that gap (fetched before yesterday started, or older
   * than the soft-refresh window).
   */
  function isStaleZeroStreak(entry, now, opts) {
    opts = opts || {};
    if (!entry || entry.error) return false;
    if (!hasCountedPosts(entry)) return false;
    var days = entry.days && typeof entry.days === "object" ? entry.days : {};
    var newest = newestPostedDayMs(days);
    if (newest == null) return false;
    var ts = typeof now === "number" ? now : Date.now();
    var yesterdayStart = calendarDaysAgoStart(ts, 1);
    if (Number.isNaN(yesterdayStart) || newest >= yesterdayStart) return false;
    var fetchedAt = Number(entry.fetchedAt) || 0;
    var softMs =
      typeof opts.softRefreshMs === "number" ? opts.softRefreshMs : DEFAULT_SOFT_REFRESH_MS;
    var age = ts - fetchedAt;
    if (fetchedAt >= yesterdayStart && age <= softMs) return false;
    return true;
  }

  /**
   * Whether the metrics pump should refetch this cache entry.
   * Empty / error samples retry on a cooldown. Entries with posts
   * soft-refresh after 12h whether complete or not. A stale 0 Days
   * (newest before yesterday) refetches even sooner.
   */
  function shouldRefetchMetrics(entry, opts) {
    opts = opts || {};
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var softMs =
      typeof opts.softRefreshMs === "number" ? opts.softRefreshMs : DEFAULT_SOFT_REFRESH_MS;
    var emptyMs =
      typeof opts.emptyRetryMs === "number" ? opts.emptyRetryMs : DEFAULT_EMPTY_RETRY_MS;
    var isUsable = typeof opts.isUsable === "function" ? opts.isUsable : hasCountedPosts;
    var isEmpty =
      typeof opts.isEmpty === "function"
        ? opts.isEmpty
        : function (e) {
            return !!(e && !e.error && !hasCountedPosts(e));
          };

    if (!entry) return true;
    if (entry.error && !isUsable(entry)) return true;
    if (!isUsable(entry) || isEmpty(entry)) {
      return now - (entry.fetchedAt || 0) > emptyMs;
    }
    if (now - (entry.fetchedAt || 0) > softMs) return true;
    if (isStaleZeroStreak(entry, now, { softRefreshMs: softMs })) return true;
    return false;
  }

  /**
   * Decide which on-screen handles to enqueue after sync / epoch wipe /
   * idle catch-up. During an in-flight follow sync, only mark pending.
   */
  function planVisibleMetricsKick(opts) {
    opts = opts || {};
    if (opts.syncInFlight) {
      return {
        pending: true,
        hold: !!opts.metricsHold,
        enqueue: [],
        pump: false
      };
    }
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var visible = opts.visible || [];
    var enqueue = [];
    var seen = {};
    for (var i = 0; i < visible.length; i++) {
      var handle = normalizeHandle(visible[i]);
      if (!handle || isNumericRestId(handle) || seen[handle]) continue;
      seen[handle] = true;
      var entry =
        typeof opts.getCached === "function"
          ? opts.getCached(handle)
          : (opts.cache && opts.cache[handle]) || null;
      var usable =
        typeof opts.isUsable === "function" ? !!opts.isUsable(entry) : !!entry;
      if (opts.forceUnusable && !usable) {
        enqueue.push(handle);
        continue;
      }
      var refetch =
        typeof opts.shouldRefetch === "function"
          ? !!opts.shouldRefetch(entry)
          : !usable;
      // Stale-zero must always hit the pump, even if shouldRefetch missed.
      if (
        !refetch &&
        isStaleZeroStreak(entry, now, { softRefreshMs: opts.softRefreshMs })
      ) {
        refetch = true;
      }
      if (refetch) enqueue.push(handle);
    }
    return {
      pending: false,
      hold: false,
      enqueue: enqueue,
      pump: true
    };
  }

  /**
   * Face for the Days/Avg badge.
   *
   * Rule: a usable day map always paints a real number — never perpetual
   * "… Days". currentStreak (today, or yesterday if today is empty) wins
   * when it is > 0. A fresh-enough sample whose streak from today is 0
   * paints 0. Stale-zero (newest Chicago day before yesterday, sample not
   * fresh) paints the consecutive run ending at that newest day and sets
   * refill so the pump still runs. Empty / error / missing stays "…" +
   * refill. opts.loading must not hide a usable number. A streak that
   * runs past the fetched window (opts.capped) paints as "N+".
   */
  function paintMetricsFace(entry, opts) {
    opts = opts || {};
    var usable = false;
    if (typeof opts.isUsable === "function") {
      usable = !!opts.isUsable(entry);
    } else if (entry && !entry.error) {
      usable = !!(
        entry.newestId ||
        (entry.days && typeof entry.days === "object" && Object.keys(entry.days).length)
      );
    }
    if (usable) {
      var now = typeof opts.now === "number" ? opts.now : Date.now();
      var staleZero = isStaleZeroStreak(entry, now, {
        softRefreshMs: opts.softRefreshMs
      });
      var streak = Math.max(0, Number(opts.streak) || 0);
      if (staleZero && streak === 0) {
        streak = streakFromNewestDay(entry && entry.days);
      }
      var capped = !!opts.capped && streak > 0;
      return {
        num: capped ? String(streak) + "+" : String(streak),
        label: streak === 1 && !capped ? "Day" : "Days",
        loading: false,
        refill: staleZero,
        capped: capped
      };
    }
    return {
      num: "…",
      label: "Days",
      loading: true,
      refill: true
    };
  }

  function defaultIsEmpty(entry) {
    return !!(entry && !entry.error && !hasCountedPosts(entry));
  }

  /**
   * True when this cache still needs a first usable Days face — missing,
   * error, or empty/unusable. Stale-zero usable maps already paint a
   * number (and enqueue separately); they are not first-face jobs.
   */
  function needsFirstUsableDaysFace(entry, now, opts) {
    opts = opts || {};
    var isUsable =
      typeof opts.isUsable === "function" ? opts.isUsable : hasCountedPosts;
    var isEmpty =
      typeof opts.isEmpty === "function" ? opts.isEmpty : defaultIsEmpty;
    if (!entry) return true;
    if (entry.error) return true;
    if (!isUsable(entry) || isEmpty(entry)) return true;
    return false;
  }

  /**
   * First-face pending: unique queued/in-flight handles that still need a
   * usable Days face. Background deepen / soft-refresh of already-usable
   * entries is omitted. The rail no longer shows this count (Live / Paused
   * only); badges still paint "…" while the pump works.
   */
  function activityPendingCount(handles, getCached, now, opts) {
    opts = opts || {};
    var ts = typeof now === "number" ? now : Date.now();
    var lookup =
      typeof getCached === "function"
        ? getCached
        : function (handle) {
            return (opts.cache && opts.cache[handle]) || null;
          };
    var seen = {};
    var n = 0;
    var list = handles || [];
    for (var i = 0; i < list.length; i++) {
      var handle = normalizeHandle(list[i]);
      if (!handle || seen[handle]) continue;
      seen[handle] = true;
      if (needsFirstUsableDaysFace(lookup(handle), ts, opts)) n += 1;
    }
    return n;
  }

  function formatActivityClock(ts) {
    try {
      return new Date(ts).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit"
      });
    } catch (e) {
      return "";
    }
  }

  /**
   * Rail Activity copy. A rate-limit / budget / retry pause always wins.
   * Otherwise Live — first-face Days work no longer nags as "Loading N".
   */
  function activityStatusText(opts) {
    opts = opts || {};
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var until = Number(opts.pausedUntil) || 0;
    if (until > now) {
      var clock =
        typeof opts.formatClock === "function"
          ? opts.formatClock(until)
          : formatActivityClock(until);
      return (opts.rateLimited ? "Paused · X limit resets " : "Paused · retry at ") + clock;
    }
    return "Live";
  }

  var XFOMetricsRefill = {
    isNumericRestId: isNumericRestId,
    normalizeHandle: normalizeHandle,
    planVisibleMetricsKick: planVisibleMetricsKick,
    paintMetricsFace: paintMetricsFace,
    isStaleZeroStreak: isStaleZeroStreak,
    streakFromNewestDay: streakFromNewestDay,
    shouldRefetchMetrics: shouldRefetchMetrics,
    newestPostedDayMs: newestPostedDayMs,
    needsFirstUsableDaysFace: needsFirstUsableDaysFace,
    activityPendingCount: activityPendingCount,
    activityStatusText: activityStatusText,
    SOFT_REFRESH_MS: DEFAULT_SOFT_REFRESH_MS
  };

  root.XFOMetricsRefill = XFOMetricsRefill;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOMetricsRefill;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
