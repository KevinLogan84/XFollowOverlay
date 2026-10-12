/**
 * Unit checks for the Days/Avg histogram and timeline parsing. These run the
 * same shared modules content.js loads, so a regression there fails here.
 * Run: node scripts/test-metrics-logic.js
 */
const fs = require("fs");
const path = require("path");
const Refill = require("../shared/metrics-refill.js");
const Days = require("../shared/metrics-days.js");
const Timeline = require("../shared/graphql-timeline.js");

const {
  dayKeyFromMs,
  dayStartFromKey,
  calendarDaysAgoStart,
  consWindowStart,
  ingestTweetPage,
  activeDaysInWindow,
  avgPerActiveDay,
  formatPace,
  currentStreak,
  dayMapTweetCount,
  hasCountedPosts,
  isUsableMetricsEntry,
  isEmptyMetricsEntry,
  maxSnowflake
} = Days;
const {
  extractScreenNameFromUser,
  unwrapTweetResult,
  snowflakeToMs,
  tweetCreatedAndId,
  tweetBagFromNode
} = Timeline;

const METRICS_DAY_MS = 24 * 60 * 60 * 1000;
const METRICS_CONS_DAYS = Days.CONS_DAYS;

function timelineSampleComplete(opts) {
  const full = !!(opts && opts.full);
  if (!full) return true;
  if (!opts.gotAny) return false;
  return !!(opts.reachedDepth || opts.timelineEnded);
}

const METRICS_SOFT_REFRESH_MS = 12 * 60 * 60 * 1000;
const METRICS_EMPTY_RETRY_MS = 15 * 60 * 1000;

function paintDaysNumber(entry, now) {
  const ts = now || Date.now();
  const face = Refill.paintMetricsFace(entry, {
    loading: false,
    isUsable: isUsableMetricsEntry,
    streak:
      entry && isUsableMetricsEntry(entry)
        ? currentStreak(entry.days || {}, ts)
        : 0,
    now: ts,
    softRefreshMs: METRICS_SOFT_REFRESH_MS
  });
  return face.num;
}

function refetchOpts(now) {
  return {
    now: now,
    softRefreshMs: METRICS_SOFT_REFRESH_MS,
    emptyRetryMs: METRICS_EMPTY_RETRY_MS,
    isUsable: isUsableMetricsEntry,
    isEmpty: isEmptyMetricsEntry
  };
}

/** Pre-1.1.17 policy: incomplete entries with posts never soft-refreshed. */
function legacyShouldRefetchMetrics(entry, now) {
  if (!entry) return true;
  if (entry.error && !isUsableMetricsEntry(entry)) return true;
  if (!isUsableMetricsEntry(entry) || isEmptyMetricsEntry(entry)) {
    return now - (entry.fetchedAt || 0) > METRICS_EMPTY_RETRY_MS;
  }
  if (
    entry.complete === true &&
    entry.newestId &&
    now - (entry.fetchedAt || 0) > METRICS_SOFT_REFRESH_MS
  ) {
    return true;
  }
  return false;
}

function isStuckDaysOnlyFace(face) {
  return (
    !!face &&
    face.label === "Days" &&
    !face.refill &&
    !face.loading &&
    (face.num === "—" || face.num === "" || face.num == null)
  );
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Fixed America/Chicago afternoon so tests do not flake near UTC midnight.
const now = Date.parse("2026-09-02T18:00:00-05:00");
const noon = (offsetDays) =>
  Date.parse("2026-09-02T12:00:00-05:00") + offsetDays * METRICS_DAY_MS;

// Calendar window includes day at the edge (today-29), unlike rolling ms cutoff.
{
  const days = {};
  days[dayKeyFromMs(noon(0))] = 1;
  days[dayKeyFromMs(noon(-29))] = 5;
  days[dayKeyFromMs(noon(-30))] = 9; // outside 30 calendar days
  const active = activeDaysInWindow(days, now, METRICS_CONS_DAYS);
  const avg = avgPerActiveDay(days, now, METRICS_CONS_DAYS);
  assert(active === 2, "expected 2 active days in 30d calendar window, got " + active);
  assert(Math.abs(avg - 3) < 0.01, "expected avg 3, got " + avg);
  assert(formatPace(avg) === "3", "formatPace 3 => " + formatPace(avg));
}

// Heavy poster: 10/day for 20 of last 30, gap yesterday
{
  const days = {};
  for (let i = 0; i < 30; i++) {
    if (i === 1) continue;
    if (i >= 20) continue;
    days[dayKeyFromMs(noon(-i))] = 10;
  }
  const active = activeDaysInWindow(days, now, METRICS_CONS_DAYS);
  const avg = avgPerActiveDay(days, now, METRICS_CONS_DAYS);
  const streak = currentStreak(days, now);
  assert(active === 19, "expected 19 active days, got " + active);
  assert(Math.abs(avg - 10) < 0.01, "expected avg 10, got " + avg);
  assert(formatPace(avg) === "10", "formatPace 10 => " + formatPace(avg));
  assert(streak === 1, "expected streak 1 after missing yesterday, got " + streak);
}

// formatPace rounding
{
  assert(formatPace(0) === "0", "zero");
  assert(formatPace(3.24) === "3.2", "one decimal");
  assert(formatPace(3.26) === "3.3", "one decimal round");
  assert(formatPace(12.6) === "13", ">=10 rounds to int");
}

// pinned old tweet must NOT stop ingest of recent tweets on same page
{
  const days = {};
  const depthBound = now - 45 * METRICS_DAY_MS;
  const page = [
    { created: noon(0), id: "100" },
    { created: noon(-2), id: "90" },
    { created: noon(-100), id: "1" },
    { created: noon(-3), id: "80" }
  ];
  const result = ingestTweetPage(page, days, { depthBound: depthBound, newestId: null });
  assert(result.added === 3, "expected 3 recent tweets added, got " + result.added);
  assert(result.reachedDepth === false, "page with recent tweets must not mark reachedDepth");
  assert(activeDaysInWindow(days, now, METRICS_CONS_DAYS) === 3, "expected 3 active days");
}

// page entirely past depth → reachedDepth
{
  const days = {};
  const depthBound = now - 45 * METRICS_DAY_MS;
  const page = [
    { created: noon(-60), id: "2" },
    { created: noon(-70), id: "1" }
  ];
  const result = ingestTweetPage(page, days, { depthBound: depthBound });
  assert(result.added === 0, "expected 0 added past depth");
  assert(result.reachedDepth === true, "expected reachedDepth for old-only page");
}

// Empty map
{
  assert(activeDaysInWindow({}, now, 30) === 0, "empty active");
  assert(avgPerActiveDay({}, now, 30) === 0, "empty avg");
  assert(currentStreak({}, now) === 0, "empty streak");
}

// Heavy poster every day for 40 days → streak 40 (not capped at 30)
{
  const days = {};
  for (let i = 0; i < 40; i++) {
    days[dayKeyFromMs(noon(-i))] = 8;
  }
  const streak = currentStreak(days, now);
  const active30 = activeDaysInWindow(days, now, METRICS_CONS_DAYS);
  const avg = avgPerActiveDay(days, now, METRICS_CONS_DAYS);
  assert(streak === 40, "expected streak 40, got " + streak);
  assert(active30 === 30, "expected 30 active in 30d window, got " + active30);
  assert(Math.abs(avg - 8) < 0.01, "expected avg 8, got " + avg);
}

// --- GraphQL user / tweet schema helpers (mirrors content.js) ---

{
  assert(
    extractScreenNameFromUser({
      legacy: { screen_name: "Alice" }
    }) === "alice",
    "legacy screen_name"
  );
  assert(
    extractScreenNameFromUser({
      legacy: null,
      core: { screen_name: "Bob" }
    }) === "bob",
    "core screen_name when legacy null"
  );
  assert(
    extractScreenNameFromUser({
      legacy: {},
      core: { screen_name: "Carol" }
    }) === "carol",
    "core screen_name when legacy empty"
  );
  assert(extractScreenNameFromUser({}) === null, "missing screen_name");
}

{
  const classic = tweetCreatedAndId({
    rest_id: "1",
    legacy: { created_at: "Wed Oct 10 20:19:24 +0000 2018", id_str: "1" }
  });
  assert(classic && classic.id === "1", "classic legacy tweet id");
  assert(classic && !Number.isNaN(classic.created), "classic legacy created");

  const flat = tweetCreatedAndId({
    rest_id: "2",
    legacy: null,
    created_at: "2026-05-01T12:00:00.000Z",
    full_text: "hi"
  });
  assert(flat && flat.id === "2", "flat schema tweet id");
  assert(flat && !Number.isNaN(flat.created), "flat schema created");

  const nested = tweetCreatedAndId({
    tweet: {
      rest_id: "3",
      legacy: { created_at: "Wed Oct 10 20:19:24 +0000 2018", id_str: "3" }
    }
  });
  assert(nested && nested.id === "3", "TweetWithVisibilityResults unwrap");
}

{
  const created = "Wed Oct 10 20:19:24 +0000 2018";
  const bag = { rest_id: "4", legacy: { created_at: created, id_str: "4" } };
  assert(tweetBagFromNode({ tweet_results: { result: bag } }), "snake tweet_results");
  assert(tweetBagFromNode({ tweetResults: { result: bag } }), "camel tweetResults");
  assert(tweetBagFromNode({ tweetResult: { result: bag } }), "singular tweetResult");
  const parsed = tweetCreatedAndId(tweetBagFromNode({ tweetResult: { result: bag } }));
  assert(parsed && parsed.id === "4", "tweetResult bag parses");
}

function nextTimelinePath(state) {
  if (!state.triedReplies) return "UserTweetsAndReplies";
  if (state.triedReplies && !state.gqlGotAny && !state.refreshedIds) {
    return "refreshQueryIds";
  }
  if (!state.triedTweets) return "UserTweets";
  if (!state.triedSearch && !state.throttled) return "Search";
  if (!state.triedDom) return "dom";
  return "incomplete";
}

{
  assert(
    nextTimelinePath({
      triedReplies: true,
      gqlGotAny: false,
      refreshedIds: true,
      triedTweets: true,
      triedSearch: false,
      throttled: false,
      triedDom: false
    }) === "Search",
    "empty GraphQL answered is not the final path — Search is next"
  );
  assert(
    nextTimelinePath({
      triedReplies: true,
      gqlGotAny: false,
      refreshedIds: true,
      triedTweets: true,
      triedSearch: true,
      throttled: false,
      triedDom: false
    }) === "dom",
    "Search miss still tries on-screen tweets before giving up"
  );
  assert(
    nextTimelinePath({
      triedReplies: true,
      gqlGotAny: false,
      refreshedIds: true,
      triedTweets: true,
      triedSearch: true,
      triedDom: true
    }) === "incomplete",
    "only then is the sample incomplete (—), never a success 0"
  );
}

// America/Chicago day boundary (CDT = UTC-5 on 2026-09-02)
{
  const late = Date.parse("2026-09-02T04:30:00.000Z"); // 11:30pm CDT Sept 1
  const after = Date.parse("2026-09-02T05:30:00.000Z"); // 12:30am CDT Sept 2
  assert(dayKeyFromMs(late) === "2026-09-01", "11:30pm Chicago is still Sept 1");
  assert(dayKeyFromMs(after) === "2026-09-02", "12:30am Chicago is Sept 2");
  const days = { "2026-09-01": 1, "2026-08-31": 1, "2026-08-30": 1 };
  const chicagoEve = Date.parse("2026-09-02T04:30:00.000Z");
  assert(
    currentStreak(days, chicagoEve) === 3,
    "streak walks Chicago today (Sept 1), not UTC Sept 2"
  );
}

// tweetCreatedAndId: snowflake fallback + camelCase-adjacent core.created_at
{
  const snow = tweetCreatedAndId({ rest_id: "2000000000000000000" });
  assert(snow && snow.id === "2000000000000000000", "snowflake id");
  assert(snow && !Number.isNaN(snow.created), "snowflake created_at fallback");

  const coreCreated = tweetCreatedAndId({
    rest_id: "9",
    core: { created_at: "2026-09-01T23:30:00.000-05:00" }
  });
  assert(coreCreated && coreCreated.id === "9", "core.created_at id");
  assert(dayKeyFromMs(coreCreated.created) === "2026-09-01", "core.created_at Chicago day");
}

// Completeness: empty sample is never complete
{
  assert(
    timelineSampleComplete({
      full: true,
      gotAny: false,
      timelineEnded: true,
      reachedDepth: false
    }) === false,
    "empty ended crawl is not complete"
  );
  assert(
    timelineSampleComplete({
      full: true,
      gotAny: true,
      timelineEnded: true,
      reachedDepth: false
    }) === true,
    "ended crawl with tweets is complete"
  );
}

// Paint: complete empty must not show 0 Days, and must not stick on Days-only
{
  const emptyComplete = {
    complete: true,
    days: {},
    newestId: null,
    error: false,
    fetchedAt: now,
    day: 0,
    week: 0,
    month: 0
  };
  assert(isUsableMetricsEntry(emptyComplete) === false, "complete empty is not usable");
  assert(isEmptyMetricsEntry(emptyComplete) === true, "complete empty is empty");
  assert(
    paintDaysNumber(emptyComplete, now) !== "0",
    "complete empty crawl paints 0 Days for an active poster"
  );
  const emptyFace = Refill.paintMetricsFace(emptyComplete, {
    loading: false,
    isUsable: isUsableMetricsEntry
  });
  assert(emptyFace.num === "…", "complete empty crawl shows ellipsis, not a fake 0");
  assert(emptyFace.refill === true, "complete empty crawl must refill");
  assert(isStuckDaysOnlyFace(emptyFace) === false, "empty complete is not a stuck Days-only face");

  const failed = { error: true, complete: false, days: {}, fetchedAt: now };
  const failedFace = Refill.paintMetricsFace(failed, {
    loading: false,
    isUsable: isUsableMetricsEntry
  });
  assert(paintDaysNumber(failed, now) !== "0", "failed fetch does not paint 0");
  assert(failedFace.refill === true, "failed fetch must refill");
  assert(isStuckDaysOnlyFace(failedFace) === false, "failed fetch is not a stuck Days-only face");

  const protectedEmpty = {
    complete: false,
    days: {},
    newestId: null,
    error: false,
    fetchedAt: now
  };
  const protFace = Refill.paintMetricsFace(protectedEmpty, {
    loading: false,
    isUsable: isUsableMetricsEntry
  });
  assert(paintDaysNumber(protectedEmpty, now) !== "0", "protected/empty sample does not paint 0");
  assert(protFace.refill === true, "protected/empty sample must refill");

  const missingFace = Refill.paintMetricsFace(null, {
    loading: false,
    isUsable: isUsableMetricsEntry
  });
  assert(missingFace.num !== "—", "empty cache is not dash-only");
  assert(missingFace.num !== "", "empty cache is not a blank number");
  assert(missingFace.refill === true, "empty cache must refill");
  assert(missingFace.loading === true, "empty cache paints loading");
  assert(
    isStuckDaysOnlyFace(missingFace) === false,
    "empty cache must not paint a stuck Days-only face with no refill"
  );

  // Valid 0: fresh crawl ingested tweets, last post before yesterday
  const stale = {};
  stale[dayKeyFromMs(noon(-3))] = 2;
  const staleEntry = {
    complete: true,
    days: stale,
    newestId: "99",
    error: false,
    fetchedAt: now
  };
  assert(isUsableMetricsEntry(staleEntry) === true, "old tweets are usable");
  assert(
    paintDaysNumber(staleEntry, now) === "0",
    "0 Days is valid when a fresh sample last posted before yesterday"
  );
  assert(
    Refill.shouldRefetchMetrics(staleEntry, refetchOpts(now)) === false,
    "fresh finished-zero does not refetch"
  );

  // Consistent poster
  const hot = {};
  for (let i = 0; i < 12; i++) hot[dayKeyFromMs(noon(-i))] = 3;
  assert(
    paintDaysNumber(
      { complete: true, days: hot, newestId: "1", error: false, fetchedAt: now },
      now
    ) === "12",
    "consistent poster paints the streak, not 0"
  );
}

// Stale 0 Days: incomplete/complete caches that stop before yesterday.
// Live proof (2026-09-06): mkbhd newest 2026-09-04, complete=false, ~48h old.
{
  const liveNow = Date.parse("2026-09-06T16:00:00-05:00");
  const opts = refetchOpts(liveNow);
  const mkbhdDays = { "2026-09-04": 85 };
  const mkbhd = {
    complete: false,
    days: mkbhdDays,
    newestId: "111",
    error: false,
    fetchedAt: liveNow - 48 * 60 * 60 * 1000
  };
  assert(isUsableMetricsEntry(mkbhd) === true, "mkbhd-style cache is usable");
  assert(currentStreak(mkbhdDays, liveNow) === 0, "stale day map computes streak 0");
  assert(
    legacyShouldRefetchMetrics(mkbhd, liveNow) === false,
    "legacy policy never refetched incomplete entries with posts"
  );
  assert(
    Refill.shouldRefetchMetrics(mkbhd, opts) === true,
    "incomplete with posts newest=day-before-yesterday must refetch"
  );
  assert(
    Refill.isStaleZeroStreak(mkbhd, liveNow, { softRefreshMs: METRICS_SOFT_REFRESH_MS }) ===
      true,
    "mkbhd-style cache is a stale 0"
  );
  assert(
    Refill.streakFromNewestDay(mkbhdDays) === 1,
    "mkbhd newest-day streak is 1"
  );
  assert(
    paintDaysNumber(mkbhd, liveNow) === "1",
    "stale incomplete 0 paints the newest-day streak, not …"
  );
  const mkbhdFace = Refill.paintMetricsFace(mkbhd, {
    loading: false,
    isUsable: isUsableMetricsEntry,
    streak: 0,
    now: liveNow,
    softRefreshMs: METRICS_SOFT_REFRESH_MS
  });
  assert(mkbhdFace.num === "1", "stale incomplete 0 paints 1 Day");
  assert(mkbhdFace.label === "Day", "a 1 newest-day streak reads Day");
  assert(mkbhdFace.refill === true, "stale incomplete 0 must refill");
  assert(mkbhdFace.loading === false, "stale incomplete 0 is not a loading face");
  const mkbhdLoading = Refill.paintMetricsFace(mkbhd, {
    loading: true,
    isUsable: isUsableMetricsEntry,
    streak: 0,
    now: liveNow,
    softRefreshMs: METRICS_SOFT_REFRESH_MS
  });
  assert(
    mkbhdLoading.num === "1" && mkbhdLoading.refill === true && mkbhdLoading.loading === false,
    "opts.loading must not hide a usable stale-zero number"
  );

  const noto = {
    complete: true,
    days: { "2026-09-04": 3 },
    newestId: "222",
    error: false,
    fetchedAt: liveNow - 42 * 60 * 60 * 1000
  };
  assert(
    Refill.shouldRefetchMetrics(noto, opts) === true,
    "stale complete 0 (newest before yesterday) refetches"
  );
  assert(
    paintDaysNumber(noto, liveNow) === "1",
    "stale complete 0 paints the newest-day streak, not …"
  );

  const freshZero = {
    complete: true,
    days: { "2026-09-04": 2 },
    newestId: "99",
    error: false,
    fetchedAt: liveNow
  };
  assert(
    Refill.shouldRefetchMetrics(freshZero, opts) === false,
    "fresh sample with last post before yesterday does not refetch"
  );
  assert(
    paintDaysNumber(freshZero, liveNow) === "0",
    "fresh finished-zero paints 0"
  );

  const incompleteFreshZero = {
    complete: false,
    days: { "2026-09-04": 4 },
    newestId: "555",
    error: false,
    fetchedAt: liveNow - 30 * 60 * 1000
  };
  assert(
    Refill.shouldRefetchMetrics(incompleteFreshZero, opts) === false,
    "fresh incomplete 0 (crawled today) is a real 0"
  );
  assert(
    paintDaysNumber(incompleteFreshZero, liveNow) === "0",
    "fresh incomplete 0 paints 0"
  );

  const hotDays = {
    "2026-09-06": 2,
    "2026-09-05": 2,
    "2026-09-04": 2
  };
  const staleHot = {
    complete: false,
    days: hotDays,
    newestId: "333",
    error: false,
    fetchedAt: liveNow - METRICS_SOFT_REFRESH_MS - 1000
  };
  assert(
    legacyShouldRefetchMetrics(staleHot, liveNow) === false,
    "legacy policy skipped incomplete soft-refresh"
  );
  assert(
    Refill.shouldRefetchMetrics(staleHot, opts) === true,
    "incomplete with posts soft-refreshes after 12h"
  );
  assert(
    paintDaysNumber(staleHot, liveNow) === "3",
    "soft-refresh of a live streak still paints the streak, not …"
  );

  const recentIncomplete = {
    complete: false,
    days: { "2026-09-05": 4 },
    newestId: "444",
    error: false,
    fetchedAt: liveNow - 2 * 60 * 60 * 1000
  };
  assert(
    Refill.shouldRefetchMetrics(recentIncomplete, opts) === false,
    "fresh incomplete with yesterday posts is not refetched"
  );
  assert(paintDaysNumber(recentIncomplete, liveNow) === "1", "skip-today streak paints 1");

  // Kick planner: stale incomplete 0 is enqueued; fresh 0 is not.
  const kickStale = Refill.planVisibleMetricsKick({
    syncInFlight: false,
    visible: ["mkbhd"],
    cache: { mkbhd: mkbhd },
    now: liveNow,
    softRefreshMs: METRICS_SOFT_REFRESH_MS,
    isUsable: isUsableMetricsEntry,
    shouldRefetch: (entry) => Refill.shouldRefetchMetrics(entry, opts)
  });
  assert(
    kickStale.enqueue.join(",") === "mkbhd",
    "visible stale 0 is enqueued for refill"
  );
  const kickFresh = Refill.planVisibleMetricsKick({
    syncInFlight: false,
    visible: ["quiet"],
    cache: { quiet: freshZero },
    now: liveNow,
    softRefreshMs: METRICS_SOFT_REFRESH_MS,
    isUsable: isUsableMetricsEntry,
    shouldRefetch: (entry) => Refill.shouldRefetchMetrics(entry, opts)
  });
  assert(kickFresh.enqueue.length === 0, "visible fresh 0 is not force-refetched");
}

// Live regression 2026-09-14: daily_mailus / lennysan sat on "… Days"
// with usable maps (newest before yesterday) and an idle pump.
{
  const liveNow = Date.parse("2026-09-14T15:49:00-05:00");
  const opts = refetchOpts(liveNow);
  const mailDays = {
    "2026-09-12": 40,
    "2026-09-11": 35,
    "2026-09-10": 30
  };
  const dailyMail = {
    complete: true,
    days: mailDays,
    newestId: "999",
    error: false,
    fetchedAt: Date.parse("2026-09-12T23:11:00-05:00"),
    week: 400,
    month: 1600
  };
  assert(isUsableMetricsEntry(dailyMail) === true, "daily_mailus cache is usable");
  assert(currentStreak(mailDays, liveNow) === 0, "gap of 2+ days is streak 0 from today");
  assert(
    Refill.isStaleZeroStreak(dailyMail, liveNow, { softRefreshMs: METRICS_SOFT_REFRESH_MS }) ===
      true,
    "daily_mailus is stale-zero"
  );
  assert(Refill.streakFromNewestDay(mailDays) === 3, "daily_mailus newest-day streak is 3");
  assert(
    paintDaysNumber(dailyMail, liveNow) === "3",
    "daily_mailus paints 3, not …"
  );
  const mailFace = Refill.paintMetricsFace(dailyMail, {
    loading: true,
    isUsable: isUsableMetricsEntry,
    streak: currentStreak(mailDays, liveNow),
    now: liveNow,
    softRefreshMs: METRICS_SOFT_REFRESH_MS
  });
  assert(mailFace.num === "3", "daily_mailus face number is 3");
  assert(mailFace.loading === false, "daily_mailus is not a loading ellipsis");
  assert(mailFace.refill === true, "daily_mailus stale-zero still refills");

  const lennyDays = {
    "2026-09-08": 2,
    "2026-09-07": 1,
    "2026-09-06": 1,
    "2026-09-05": 1
  };
  const lennysan = {
    complete: true,
    days: lennyDays,
    newestId: "888",
    error: false,
    fetchedAt: Date.parse("2026-09-08T18:00:00-05:00")
  };
  assert(currentStreak(lennyDays, liveNow) === 0, "lennysan streak from today is 0");
  assert(
    Refill.isStaleZeroStreak(lennysan, liveNow, { softRefreshMs: METRICS_SOFT_REFRESH_MS }) ===
      true,
    "lennysan is stale-zero"
  );
  assert(Refill.streakFromNewestDay(lennyDays) === 4, "lennysan newest-day streak is 4");
  assert(paintDaysNumber(lennysan, liveNow) === "4", "lennysan paints 4, not …");

  const kickMail = Refill.planVisibleMetricsKick({
    syncInFlight: false,
    visible: ["daily_mailus", "lennysan"],
    cache: { daily_mailus: dailyMail, lennysan: lennysan },
    now: liveNow,
    softRefreshMs: METRICS_SOFT_REFRESH_MS,
    isUsable: isUsableMetricsEntry,
    shouldRefetch: (entry) => Refill.shouldRefetchMetrics(entry, opts)
  });
  assert(
    kickMail.enqueue.join(",") === "daily_mailus,lennysan",
    "visible stale-zero handles are enqueued"
  );

  const kickEvenIfPolicyMisses = Refill.planVisibleMetricsKick({
    syncInFlight: false,
    visible: ["daily_mailus"],
    cache: { daily_mailus: dailyMail },
    now: liveNow,
    softRefreshMs: METRICS_SOFT_REFRESH_MS,
    isUsable: isUsableMetricsEntry,
    shouldRefetch: () => false
  });
  assert(
    kickEvenIfPolicyMisses.enqueue.join(",") === "daily_mailus",
    "planner enqueues stale-zero even if shouldRefetch misses"
  );
}

// v1.1.22 — a streak that runs off the fetched window paints "N+" rather than
// spending the rate limit on a deeper crawl.
{
  const now = Date.now();
  const days = {};
  for (let i = 0; i < 30; i++) days[dayKeyFromMs(now - i * 86400000)] = 1;
  const entry = { complete: true, days: days, newestId: "1", fetchedAt: now };
  const streak = currentStreak(days, now);
  assert(streak === 30, "30 consecutive days is a 30 streak (" + streak + ")");
  const capped = Refill.paintMetricsFace(entry, {
    loading: false,
    isUsable: isUsableMetricsEntry,
    streak: streak,
    capped: true,
    now: now
  });
  assert(capped.num === "30+", "capped streak paints 30+ (" + capped.num + ")");
  assert(capped.label === "Days" && capped.loading === false && capped.refill === false, "capped face is a settled Days face");
  assert(capped.capped === true, "face reports capped");
  const exact = Refill.paintMetricsFace(entry, {
    loading: false,
    isUsable: isUsableMetricsEntry,
    streak: streak,
    capped: false,
    now: now
  });
  assert(exact.num === "30" && exact.capped === false, "uncapped streak paints the plain number");
  const oneCapped = Refill.paintMetricsFace(entry, {
    loading: false,
    isUsable: isUsableMetricsEntry,
    streak: 1,
    capped: true,
    now: now
  });
  assert(oneCapped.num === "1+" && oneCapped.label === "Days", "1+ reads Days, not Day");
  const zeroCapped = Refill.paintMetricsFace(entry, {
    loading: false,
    isUsable: isUsableMetricsEntry,
    streak: 0,
    capped: true,
    now: now
  });
  assert(zeroCapped.num === "0" && !zeroCapped.capped, "a 0 streak is never capped");
}

// Production guards — the IIFE is not require()-able, so pin the live rules.
{
  const content = fs.readFileSync(
    path.join(__dirname, "../content/content.js"),
    "utf8"
  );
  assert(Days.TZ === "America/Chicago", "streak uses America/Chicago");
  assert(
    /const \{[\s\S]*?currentStreak[\s\S]*?\} = Days;/.test(content),
    "content.js takes the streak math from shared/metrics-days.js, not its own copy"
  );
  assert(
    /const \{[\s\S]*?walkGraphqlInstructions[\s\S]*?\} = Timeline;/.test(content),
    "content.js takes timeline parsing from shared/graphql-timeline.js"
  );
  assert(!/\n  function currentStreak\(/.test(content), "no second currentStreak in content.js");
  assert(!/\n  function ingestTweetPage\(/.test(content), "no second ingestTweetPage in content.js");
  assert(content.includes("capped: capped"), "activityFromEntry reports a capped streak");
  assert(!/titleAct\.capped \? "\+" : ""/.test(content), "Days badge title is not painted");
  assert(
    /activityDepthReached[\s\S]*?METRICS_CRAWL_DAYS/.test(content),
    "depth target is the 30-day crawl window, not 90 days"
  );
  assert(content.includes('const METRICS_CACHE_EPOCH = "40"'), "cache epoch 40 drops stuck dash caches");
  assert(content.includes("function kickVisibleMetrics"), "kickVisibleMetrics remains a no-paint hook");
  assert(!content.includes("planVisibleMetricsKick"), "visible kick does not plan a Days refill");
  assert(content.includes("XFOMetricsRefill"), "content loads metrics-refill");
  assert(!content.includes("paintMetricsFace"), "content does not paint the Days face");
  assert(content.includes("isStaleZeroStreak"), "stale 0 Days is a first-class check");
  assert(content.includes("streakFromNewestDay"), "stale-zero paints the newest-day streak");
  assert(
    content.includes("MetricsRefill.activityPendingCount"),
    "metricsPendingCount uses the shared first-face classifier"
  );
  assert(
    content.includes("MetricsRefill.activityStatusText"),
    "rail Activity copy uses the shared status helper"
  );
  assert(
    !/if \(pending > 0\) return "Loading " \+ pending/.test(content),
    "content Activity fallback never returns Loading N"
  );
  assert(
    !/return metricsQueue\.length \+ metricsInFlight\.size/.test(content),
    "Activity pending is not queue+inFlight"
  );
  assert(
    content.includes("MetricsRefill.shouldRefetchMetrics"),
    "refetch policy lives in metrics-refill"
  );
  assert(
    content.includes("MetricsRefill.isStaleZeroStreak"),
    "content uses the shared stale-zero helper"
  );
  assert(
    !/entry\.complete === true &&\s*\n\s*entry\.newestId &&/.test(content),
    "soft refresh is not gated on complete + newestId"
  );

  const ensureFn = content.slice(
    content.indexOf("function ensureMetrics"),
    content.indexOf("function collectBadgedUsers")
  );
  assert(
    /stripMetricsNodes\(host\)/.test(ensureFn),
    "ensureMetrics removes Days nodes instead of painting them"
  );
  assert(
    !/paintMetricsEl\(/.test(ensureFn),
    "ensureMetrics does not paint a Days face"
  );
  assert(
    !/enqueueMetrics\(/.test(ensureFn),
    "ensureMetrics does not enqueue a timeline crawl"
  );
  assert(
    !/createElement\([\s\S]*METRICS_CLASS/.test(ensureFn),
    "ensureMetrics does not create a Days badge"
  );

  const loadFn = content.slice(
    content.indexOf("async function loadCacheFromStorage"),
    content.indexOf("async function persistFailedList")
  );
  assert(
    /metricsCacheEpoch !== METRICS_CACHE_EPOCH[\s\S]*kickVisibleMetrics\s*\(\s*true\s*\)/.test(
      loadFn
    ),
    "epoch wipe enqueues and pumps instead of returning with an empty cache"
  );

  const startFn = content.slice(
    content.indexOf("function startSync("),
    content.indexOf("async function recoverStuckSync")
  );
  assert(
    /syncInFlight = null[\s\S]*kickVisibleMetrics\s*\(\s*true\s*\)/.test(startFn),
    "startSync finally enqueues visible handles and starts the pump"
  );

  const initFn = content.slice(content.indexOf("async function init()"));
  assert(/metricsHold = false/.test(initFn), "init releases metricsHold so hard-refresh can refill");
  assert(/kickVisibleMetrics/.test(initFn), "init kicks visible metrics after load");

  const idleFn = content.slice(
    content.indexOf("function startIdleScan"),
    content.indexOf("function startScrollGuard")
  );
  assert(/kickVisibleMetrics/.test(idleFn), "idle scan refills even when the queue is empty");
  assert(
    !/if \(metricsQueue\.length && !metricsPumpRunning\)/.test(idleFn),
    "idle scan is not queue-length-only"
  );
  assert(
    !/let daysN = "—"/.test(content),
    "paint no longer defaults empty cache to a dash-only Days face"
  );
  assert(
    !/Finished count with no posts/.test(content),
    "old complete-empty-is-usable comment is gone"
  );
  assert(
    !/if \(entry\.complete === true\) return true;/.test(content),
    "isUsableMetricsEntry no longer treats complete as sufficient"
  );
  assert(
    !/complete: posts\.complete !== false/.test(content),
    "empty UserTweets is not returned as complete"
  );
  assert(
    !/complete: replies\.complete !== false/.test(content),
    "empty UserTweetsAndReplies is not returned as complete"
  );
  const hist = content.slice(content.indexOf("async function fetchTimelineHistogram"));
  const repliesAt = hist.indexOf('gql("UserTweetsAndReplies")');
  const tweetsAt = hist.indexOf('gql("UserTweets")');
  assert(repliesAt > 0 && tweetsAt > repliesAt, "UserTweetsAndReplies is tried before UserTweets");
  assert(
    /complete:\s*false,\s*gotAny:\s*false/.test(hist),
    "empty histogram result is incomplete"
  );
  assert(
    !content.includes("if (isRetweetResult(core)) return;"),
    "GraphQL walker counts replies/reposts as posts"
  );
  assert(!/if \(gqlAnswered\)/.test(hist), "empty GraphQL is not treated as a finished answer");
  assert(
    !hist.includes('if (metricsFetchMode !== "search")'),
    "Search success does not sticky-skip GraphQL for later accounts"
  );
  assert(
    hist.includes("collectTimelineViaSearchGraphql"),
    "empty GraphQL falls through to SearchTimeline"
  );
  assert(
    hist.includes("collectTimelineViaSearch"),
    "empty GraphQL can still use adaptive Search"
  );
  assert(
    hist.includes("histogramFromVisibleTweets"),
    "last resort reads on-screen tweets so — is not the steady state"
  );
  assert(content.includes("METRICS_SEARCH_GAP_MS"), "Search is throttled");
  assert(content.includes("METRICS_SEARCH_MAX_PER_WINDOW"), "Search has a window budget");
  assert(
    Timeline.walkGraphqlInstructions({
      a: { tweetResult: { result: { rest_id: "5", legacy: { created_at: "Wed Oct 10 20:19:24 +0000 2018", id_str: "5" } } } }
    }).tweets.length === 1,
    "walker reads singular tweetResult"
  );
  const gqlCollect = content.slice(
    content.indexOf("async function collectTimelineViaGraphql")
  );
  assert(
    gqlCollect.includes("graphqlFollow"),
    "UserTweets GraphQL goes through the page-hook path"
  );
  assert(content.includes("USER_TWEETS_FIELD_TOGGLES"), "UserTweets sends fieldToggles");
  assert(
    content.includes('UserTweetsAndReplies: "FIFgycIi-CNJcV0R-135Uw"'),
    "baked-in UserTweetsAndReplies id is not the stale qUpkZU6eN8MbtQb7rC_pYg primary"
  );
  assert(
    !content.includes('UserTweetsAndReplies: "qUpkZU6eN8MbtQb7rC_pYg"'),
    "stale replies queryId is not the primary"
  );
}

// Post-sync / epoch-wipe must enqueue visible handles and start the pump.
{
  const shouldRefetch = (entry) => !entry || !isUsableMetricsEntry(entry);
  const afterSync = Refill.planVisibleMetricsKick({
    syncInFlight: false,
    metricsHold: true,
    visible: ["alice", "bob"],
    cache: {},
    forceUnusable: true,
    isUsable: isUsableMetricsEntry,
    shouldRefetch: shouldRefetch
  });
  assert(afterSync.pending === false, "post-sync is not pending");
  assert(afterSync.hold === false, "post-sync releases metricsHold");
  assert(
    afterSync.enqueue.join(",") === "alice,bob",
    "post-sync enqueues visible handles, got " + afterSync.enqueue.join(",")
  );
  assert(afterSync.pump === true, "post-sync starts the pump");

  const duringSync = Refill.planVisibleMetricsKick({
    syncInFlight: true,
    metricsHold: true,
    visible: ["alice"],
    cache: {},
    forceUnusable: true,
    isUsable: isUsableMetricsEntry,
    shouldRefetch: shouldRefetch
  });
  assert(duringSync.enqueue.length === 0, "no enqueue while syncInFlight");
  assert(duringSync.pump === false, "no pump while syncInFlight");
  assert(duringSync.pending === true, "kick is pending until sync finishes");

  const afterEpoch = Refill.planVisibleMetricsKick({
    syncInFlight: false,
    metricsHold: true,
    visible: ["carol"],
    cache: {},
    forceUnusable: true,
    isUsable: isUsableMetricsEntry,
    shouldRefetch: shouldRefetch
  });
  assert(afterEpoch.enqueue[0] === "carol", "epoch-wipe enqueues visible handles");
  assert(afterEpoch.pump === true, "epoch-wipe starts the pump");
  assert(afterEpoch.hold === false, "epoch-wipe releases hold");

  const usable = {
    complete: true,
    days: { "2026-09-02": 2 },
    newestId: "1",
    error: false,
    fetchedAt: now
  };
  const keepGood = Refill.planVisibleMetricsKick({
    syncInFlight: false,
    visible: ["dave"],
    cache: { dave: usable },
    forceUnusable: true,
    now: now,
    softRefreshMs: METRICS_SOFT_REFRESH_MS,
    isUsable: isUsableMetricsEntry,
    shouldRefetch: () => false
  });
  assert(
    keepGood.enqueue.length === 0 && keepGood.pump === true,
    "usable fresh cache is not force-refetched; pump still starts"
  );
}

// Activity row: Paused wins; otherwise Live (never Loading N).
{
  const liveNow = Date.parse("2026-09-09T14:04:10-05:00");
  const usableDeepen = {
    complete: false,
    days: { "2026-09-09": 2, "2026-09-08": 1 },
    newestId: "1",
    error: false,
    fetchedAt: liveNow - 30 * 60 * 1000,
    day: 2,
    week: 3,
    month: 3
  };
  const classifyOpts = {
    now: liveNow,
    isUsable: isUsableMetricsEntry,
    isEmpty: isEmptyMetricsEntry,
    softRefreshMs: METRICS_SOFT_REFRESH_MS
  };

  assert(
    Refill.needsFirstUsableDaysFace(usableDeepen, liveNow, classifyOpts) === false,
    "usable incomplete deepen is not a first-face job"
  );
  assert(
    Refill.needsFirstUsableDaysFace(null, liveNow, classifyOpts) === true,
    "missing cache needs a first usable face"
  );
  assert(
    Refill.needsFirstUsableDaysFace(
      { error: true, days: {}, fetchedAt: liveNow },
      liveNow,
      classifyOpts
    ) === true,
    "error cache needs a first usable face"
  );
  assert(
    Refill.needsFirstUsableDaysFace(
      { complete: false, days: {}, error: false, fetchedAt: liveNow },
      liveNow,
      classifyOpts
    ) === true,
    "empty cache needs a first usable face"
  );

  const fiveDeepen = ["a", "b", "c", "d", "e"];
  const deepenCache = {
    a: usableDeepen,
    b: usableDeepen,
    c: usableDeepen,
    d: usableDeepen,
    e: usableDeepen
  };
  assert(
    Refill.activityPendingCount(fiveDeepen, null, liveNow, {
      cache: deepenCache,
      isUsable: isUsableMetricsEntry,
      isEmpty: isEmptyMetricsEntry
    }) === 0,
    "5 usable deepen jobs are not Activity-pending"
  );
  assert(
    Refill.activityStatusText({
      now: liveNow,
      handles: fiveDeepen,
      cache: deepenCache,
      isUsable: isUsableMetricsEntry,
      isEmpty: isEmptyMetricsEntry
    }) === "Live",
    "5 usable deepen jobs → Live"
  );

  const firstFetch = ["x", "y", "z"];
  assert(
    Refill.activityPendingCount(firstFetch, null, liveNow, {
      cache: {},
      isUsable: isUsableMetricsEntry,
      isEmpty: isEmptyMetricsEntry
    }) === 3,
    "3 missing caches are first-face pending"
  );
  assert(
    Refill.activityStatusText({
      now: liveNow,
      handles: firstFetch,
      cache: {},
      isUsable: isUsableMetricsEntry,
      isEmpty: isEmptyMetricsEntry
    }) === "Live",
    "3 unusable first-fetches still Live on the rail"
  );

  const mixed = ["a", "b", "c", "d", "e", "x", "y", "z"];
  assert(
    Refill.activityPendingCount(mixed, null, liveNow, {
      cache: deepenCache,
      isUsable: isUsableMetricsEntry,
      isEmpty: isEmptyMetricsEntry
    }) === 3,
    "mixed queue counts only the 3 first-face jobs"
  );
  assert(
    Refill.activityPendingCount(["x", "x", "X"], null, liveNow, {
      cache: {},
      isUsable: isUsableMetricsEntry
    }) === 1,
    "queued+inFlight duplicate of one handle counts once"
  );

  const staleZero = {
    complete: false,
    days: { "2026-09-06": 4 },
    newestId: "9",
    error: false,
    fetchedAt: liveNow - 48 * 60 * 60 * 1000
  };
  assert(
    Refill.needsFirstUsableDaysFace(staleZero, liveNow, classifyOpts) === false,
    "stale-zero usable maps already have a number and are not first-face"
  );
  assert(
    Refill.activityStatusText({
      now: liveNow,
      handles: ["mkbhd"],
      cache: { mkbhd: staleZero },
      isUsable: isUsableMetricsEntry,
      isEmpty: isEmptyMetricsEntry,
      softRefreshMs: METRICS_SOFT_REFRESH_MS
    }) === "Live",
    "stale 0 still Live; badges may read …"
  );

  const softRefresh = {
    complete: true,
    days: { "2026-09-09": 1, "2026-09-08": 1 },
    newestId: "2",
    error: false,
    fetchedAt: liveNow - METRICS_SOFT_REFRESH_MS - 1000
  };
  assert(
    Refill.needsFirstUsableDaysFace(softRefresh, liveNow, classifyOpts) === false,
    "12h soft-refresh of a usable streak is not first-face"
  );
  assert(
    Refill.activityStatusText({
      now: liveNow,
      handles: ["hot"],
      cache: { hot: softRefresh },
      isUsable: isUsableMetricsEntry,
      isEmpty: isEmptyMetricsEntry
    }) === "Live",
    "usable 12h soft-refresh → Live"
  );

  assert(
    Refill.activityStatusText({
      now: liveNow,
      pausedUntil: liveNow + 60 * 1000,
      rateLimited: true,
      pending: 3,
      formatClock: function () {
        return "3:05 PM";
      }
    }) === "Paused · X limit resets 3:05 PM",
    "rate-limit pause wins over pending first-faces"
  );
  assert(
    Refill.activityStatusText({
      now: liveNow,
      pausedUntil: liveNow + 60 * 1000,
      rateLimited: false,
      pending: 5,
      formatClock: function () {
        return "3:05 PM";
      }
    }) === "Paused · retry at 3:05 PM",
    "retry pause wins even for deepen-only queues"
  );
  assert(
    Refill.activityStatusText({
      now: liveNow,
      pausedUntil: liveNow - 1,
      pending: 26
    }) === "Live",
    "expired pause with pending first-faces is Live, not Loading 26"
  );
  assert(
    Refill.activityStatusText({ pending: 26 }) === "Live",
    "pending first-faces never become Loading N"
  );
  assert(
    !String(Refill.activityStatusText({ pending: 26 })).includes("Loading"),
    "activityStatusText never returns Loading"
  );
}

console.log("All metrics logic tests passed.");
