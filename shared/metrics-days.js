/**
 * Posting-day math for the Days / Avg badge (classic script).
 * Loaded by the content script and Node tests.
 *
 * A day map is { "YYYY-MM-DD": postCount } on the America/Chicago calendar.
 * Keys compare as civil dates (UTC midnight of that date), so results do
 * not depend on the host time zone.
 */
(function (root) {
  var TZ = "America/Chicago";
  /** Consistency window for Avg pace (posts per active day). */
  var CONS_DAYS = 30;
  /** Day-map retention and the streak ceiling. */
  var DEPTH_DAYS = 90;
  var STREAK_CEILING = 400;

  // Constructing a DateTimeFormat costs ~15x a formatToParts call, and this
  // runs once per tweet while folding histograms.
  var formatter = null;
  function getFormatter() {
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
    }
    return formatter;
  }

  function chicagoDateParts(ms) {
    var d = new Date(typeof ms === "number" ? ms : Date.parse(ms));
    if (isNaN(d.getTime())) return null;
    try {
      var parts = getFormatter().formatToParts(d);
      var map = {};
      for (var i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value;
      var y = Number(map.year);
      var m = Number(map.month);
      var day = Number(map.day);
      if (!y || !m || !day) return null;
      return { y: y, m: m, d: day };
    } catch (e) {
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    }
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function dayKeyFromParts(p) {
    if (!p) return "";
    return p.y + "-" + pad2(p.m) + "-" + pad2(p.d);
  }

  function shiftCivilDate(y, m, d, days) {
    var dt = new Date(Date.UTC(y, m - 1, d + days));
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  function dayKeyFromMs(ms) {
    return dayKeyFromParts(chicagoDateParts(ms));
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

  function chicagoDaysAgoKey(now, daysAgo) {
    var p = chicagoDateParts(now);
    if (!p) return "";
    return dayKeyFromParts(shiftCivilDate(p.y, p.m, p.d, -daysAgo));
  }

  function calendarDaysAgoStart(now, daysAgo) {
    return dayStartFromKey(chicagoDaysAgoKey(now, daysAgo));
  }

  /** Inclusive calendar window: today + previous (dayCount-1) days. */
  function consWindowStart(now, dayCount) {
    var n = Math.max(1, dayCount || CONS_DAYS);
    return calendarDaysAgoStart(now, n - 1);
  }

  function periodBounds(now, depthDays) {
    return {
      day: calendarDaysAgoStart(now, 0),
      week: consWindowStart(now, 7),
      month: consWindowStart(now, CONS_DAYS),
      depth: calendarDaysAgoStart(now, depthDays || DEPTH_DAYS)
    };
  }

  function eachDay(days, fn) {
    var keys = Object.keys(days || {});
    for (var i = 0; i < keys.length; i++) {
      var start = dayStartFromKey(keys[i]);
      if (isNaN(start)) continue;
      fn(start, Number(days[keys[i]]) || 0, keys[i]);
    }
  }

  function oldestDayMs(days) {
    var oldest = null;
    eachDay(days, function (start) {
      if (oldest == null || start < oldest) oldest = start;
    });
    return oldest;
  }

  function newestDayMs(days) {
    var newest = null;
    eachDay(days, function (start, n) {
      if (n > 0 && (newest == null || start > newest)) newest = start;
    });
    return newest;
  }

  function activeDaysInWindow(days, now, dayCount) {
    var cutoff = consWindowStart(now, dayCount);
    var active = 0;
    eachDay(days, function (start, n) {
      if (start >= cutoff && n > 0) active += 1;
    });
    return active;
  }

  function postsInWindow(days, now, dayCount) {
    var cutoff = consWindowStart(now, dayCount);
    var posts = 0;
    eachDay(days, function (start, n) {
      if (start >= cutoff) posts += n;
    });
    return posts;
  }

  function avgPerActiveDay(days, now, dayCount) {
    var cutoff = consWindowStart(now, dayCount);
    var posts = 0;
    var active = 0;
    eachDay(days, function (start, n) {
      if (start < cutoff || n <= 0) return;
      posts += n;
      active += 1;
    });
    return active ? posts / active : 0;
  }

  /** Consecutive posting days ending today, or yesterday if today is empty. */
  function currentStreak(days, now) {
    var start = chicagoDateParts(now);
    if (!start) return 0;
    var map = days || {};
    var cursor = start;
    if (!((Number(map[dayKeyFromParts(cursor)]) || 0) > 0)) {
      cursor = shiftCivilDate(start.y, start.m, start.d, -1);
    }
    var streak = 0;
    while (streak < STREAK_CEILING && (Number(map[dayKeyFromParts(cursor)]) || 0) > 0) {
      streak += 1;
      cursor = shiftCivilDate(cursor.y, cursor.m, cursor.d, -1);
    }
    return streak;
  }

  function daysSinceLastPost(days, now) {
    var newest = newestDayMs(days);
    if (newest == null) return null;
    var today = calendarDaysAgoStart(now, 0);
    if (isNaN(today) || newest >= today) return newest >= today ? 0 : null;
    var gap = 0;
    var cursor = today;
    while (cursor > newest && gap < STREAK_CEILING) {
      gap += 1;
      var d = new Date(cursor);
      cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1);
    }
    return gap;
  }

  function formatPace(avg) {
    if (!avg || avg <= 0) return "0";
    return String(avg >= 10 ? Math.round(avg) : Math.round(avg * 10) / 10);
  }

  function pruneDays(days, now, depthDays) {
    var cutoff = calendarDaysAgoStart(now, depthDays || DEPTH_DAYS);
    var out = {};
    eachDay(days, function (start, n, key) {
      if (start >= cutoff && n > 0) out[key] = n;
    });
    return out;
  }

  function mergeDayMaps(base, extra) {
    var out = {};
    var k;
    for (k in base || {}) {
      if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    }
    for (k in extra || {}) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) {
        out[k] = (out[k] || 0) + (Number(extra[k]) || 0);
      }
    }
    return out;
  }

  function countsFromDays(days, now, depthDays) {
    var bounds = periodBounds(now, depthDays);
    var buckets = { day: 0, week: 0, month: 0 };
    eachDay(days, function (start, n) {
      if (n <= 0) return;
      if (start >= bounds.month) buckets.month += n;
      if (start >= bounds.week) buckets.week += n;
      if (start >= bounds.day) buckets.day += n;
    });
    return buckets;
  }

  function dayMapTweetCount(days) {
    var n = 0;
    eachDay(days, function (start, count) {
      n += count;
    });
    return n;
  }

  function idLessOrEqual(a, b) {
    if (!a || !b) return false;
    try {
      return BigInt(a) <= BigInt(b);
    } catch (e) {
      return String(a) <= String(b);
    }
  }

  function maxSnowflake(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    try {
      return BigInt(a) >= BigInt(b) ? a : b;
    } catch (e) {
      return String(a) >= String(b) ? a : b;
    }
  }

  function addTweetToDays(days, createdMs) {
    if (isNaN(createdMs)) return;
    var key = dayKeyFromMs(createdMs);
    days[key] = (days[key] || 0) + 1;
  }

  /**
   * Fold one timeline page into the day histogram.
   * Skips tweets older than the depth bound / at-or-before sinceId without
   * aborting the page — pinned or old tweets used to stop the crawl early and
   * leave recent days missing. depthKey (a day key) wins over depthBound (ms).
   */
  function ingestTweetPage(tweets, days, options) {
    var opts = options || {};
    var sinceId = opts.sinceId;
    var depthKey = opts.depthKey ? String(opts.depthKey) : "";
    var depthBound = typeof opts.depthBound === "number" ? opts.depthBound : null;
    var newestId = opts.newestId || null;
    var reachedSince = false;
    var newestOnPage = null;
    var added = 0;
    var list = Array.isArray(tweets) ? tweets : [];

    for (var i = 0; i < list.length; i++) {
      var tw = list[i];
      if (!tw || typeof tw.created !== "number") continue;
      if (newestOnPage == null || tw.created > newestOnPage) newestOnPage = tw.created;
      if (sinceId && tw.id && idLessOrEqual(tw.id, sinceId)) {
        reachedSince = true;
        continue;
      }
      var tooOld = depthKey
        ? dayKeyFromMs(tw.created) < depthKey
        : depthBound != null && tw.created < depthBound;
      newestId = maxSnowflake(newestId, tw.id);
      if (tooOld) continue;
      addTweetToDays(days, tw.created);
      added += 1;
    }

    var reachedDepth =
      list.length > 0 &&
      newestOnPage != null &&
      (depthKey
        ? dayKeyFromMs(newestOnPage) < depthKey
        : depthBound != null && newestOnPage < depthBound);

    return {
      newestId: newestId,
      reachedSince: reachedSince,
      reachedDepth: reachedDepth,
      added: added
    };
  }

  function hasCountedPosts(entry) {
    if (!entry || entry.error) return false;
    if (entry.newestId) return true;
    if (entry.days && typeof entry.days === "object") return dayMapTweetCount(entry.days) > 0;
    return (entry.day || 0) + (entry.week || 0) + (entry.month || 0) > 0;
  }

  /**
   * Complete-and-empty is not usable: that painted a fake 0 Days for active
   * posters when a crawl finished with no ingested tweets.
   */
  function isUsableMetricsEntry(entry) {
    return !!entry && !entry.error && hasCountedPosts(entry);
  }

  /** True when the day map has no counted posts (failed / empty / protected). */
  function isEmptyMetricsEntry(entry) {
    return !!entry && !entry.error && !hasCountedPosts(entry);
  }

  var XFOMetricsDays = {
    TZ: TZ,
    CONS_DAYS: CONS_DAYS,
    DEPTH_DAYS: DEPTH_DAYS,
    chicagoDateParts: chicagoDateParts,
    dayKeyFromParts: dayKeyFromParts,
    shiftCivilDate: shiftCivilDate,
    dayKeyFromMs: dayKeyFromMs,
    dayStartFromKey: dayStartFromKey,
    chicagoDaysAgoKey: chicagoDaysAgoKey,
    calendarDaysAgoStart: calendarDaysAgoStart,
    consWindowStart: consWindowStart,
    periodBounds: periodBounds,
    oldestDayMs: oldestDayMs,
    newestDayMs: newestDayMs,
    activeDaysInWindow: activeDaysInWindow,
    postsInWindow: postsInWindow,
    avgPerActiveDay: avgPerActiveDay,
    currentStreak: currentStreak,
    daysSinceLastPost: daysSinceLastPost,
    formatPace: formatPace,
    pruneDays: pruneDays,
    mergeDayMaps: mergeDayMaps,
    countsFromDays: countsFromDays,
    dayMapTweetCount: dayMapTweetCount,
    idLessOrEqual: idLessOrEqual,
    maxSnowflake: maxSnowflake,
    addTweetToDays: addTweetToDays,
    ingestTweetPage: ingestTweetPage,
    hasCountedPosts: hasCountedPosts,
    isUsableMetricsEntry: isUsableMetricsEntry,
    isEmptyMetricsEntry: isEmptyMetricsEntry
  };

  root.XFOMetricsDays = XFOMetricsDays;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOMetricsDays;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
