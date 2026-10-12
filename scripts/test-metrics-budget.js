#!/usr/bin/env node
/**
 * Unit checks for shared/metrics-budget.js — the per-op GraphQL rate-limit
 * budget the activity pump spends from. The pump used to learn about X's
 * 50-per-15-min window only by hitting 429 and then guessing the wait;
 * these lock in: learn from headers, stop short of zero, pace the tail,
 * sleep until the real reset, forget rolled-over windows.
 */
const Budget = require("../shared/metrics-budget.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const NOW = Date.UTC(2026, 8, 9, 14, 0, 0); // fixed clock
const SEC = 1000;
const MIN = 60 * SEC;
const OP = "UserTweetsAndReplies";

function headersAt(remaining, resetInMs, limit) {
  return {
    "x-rate-limit-limit": String(limit == null ? 50 : limit),
    "x-rate-limit-remaining": String(remaining),
    "x-rate-limit-reset": String(Math.floor((NOW + resetInMs) / 1000))
  };
}

// --- empty state: spend normally -------------------------------------------
{
  const s = Budget.create(null, NOW);
  assert(Budget.remaining(s, OP, NOW) === null, "unknown op has null remaining");
  assert(Budget.canSpend(s, OP, NOW) === true, "unknown budget may spend");
  assert(Budget.waitMs(s, OP, NOW) === 0, "unknown budget has no wait");
  assert(Budget.pageGapMs(s, OP, NOW) === 450, "unknown budget uses the min gap");
  assert(Budget.healthy(s, OP, NOW, { pages: 12 }) === true, "unknown budget is healthy");
  assert(Budget.status(s, null, NOW).paused === false, "unknown budget is not paused");
  assert(Budget.limitOf(s, OP, NOW) === Budget.DEFAULT_LIMIT, "default limit is 50");
  assert(Budget.isOp("UserTweets") && !Budget.isOp("HomeTimeline"), "only pump ops are tracked");
}

// --- learn from headers -----------------------------------------------------
{
  const s = Budget.create(null, NOW);
  Budget.note(s, OP, headersAt(37, 9 * MIN), NOW);
  assert(Budget.remaining(s, OP, NOW) === 37, "remaining learned from header");
  assert(Budget.limitOf(s, OP, NOW) === 50, "limit learned from header");
  const at = Budget.resetAt(s, OP, NOW);
  assert(Math.abs(at - (NOW + 9 * MIN)) < SEC, "reset learned from header (seconds -> ms)");
  assert(Budget.canSpend(s, OP, NOW) === true, "37 left may spend");
  assert(Budget.pageGapMs(s, OP, NOW) === 450, "above half the window: normal gap");
  assert(Budget.healthy(s, OP, NOW, { pages: 12 }) === true, "37 left is healthy for 12 pages");

  // Headers-like object with get() also works.
  const s2 = Budget.create(null, NOW);
  const map = headersAt(12, 5 * MIN);
  Budget.note(s2, OP, { get: (k) => map[k] }, NOW);
  assert(Budget.remaining(s2, OP, NOW) === 12, "Headers.get() path learns remaining");

  // Unknown op is ignored.
  Budget.note(s, "HomeTimeline", headersAt(1, MIN), NOW);
  assert(!s.ops.HomeTimeline, "unknown ops are not tracked");

  // A response with no rate headers and no 429 teaches nothing.
  const s3 = Budget.create(null, NOW);
  Budget.note(s3, OP, {}, NOW);
  assert(Budget.remaining(s3, OP, NOW) === null, "header-less 200 leaves the budget unknown");
}

// --- reserve: stop short of zero so X's own client keeps working ------------
{
  const s = Budget.create(null, NOW);
  Budget.note(s, OP, headersAt(Budget.RESERVE + 1, 6 * MIN), NOW);
  assert(Budget.canSpend(s, OP, NOW) === true, "one above the reserve may spend");
  Budget.spend(s, OP, NOW);
  assert(Budget.remaining(s, OP, NOW) === Budget.RESERVE, "spend() counts the call");
  assert(Budget.canSpend(s, OP, NOW) === false, "at the reserve we stop");
  const wait = Budget.waitMs(s, OP, NOW);
  assert(wait > 5 * MIN && wait <= 6 * MIN + 2 * SEC, "wait runs to the reset (+ slack): " + wait);
  assert(Budget.healthy(s, OP, NOW, { pages: 12 }) === false, "reserve-level budget is not healthy");
  const st = Budget.status(s, [OP], NOW);
  assert(st.paused === true && st.op === OP, "status reports the paused op");
  assert(Math.abs(st.until - (NOW + 6 * MIN)) < SEC, "status until is the reset");
  // Another op with budget keeps the panel Live.
  assert(Budget.status(s, [OP, "UserTweets"], NOW).paused === false, "any spendable op means not paused");
  // Custom reserve.
  assert(Budget.canSpend(s, OP, NOW, { reserve: 2 }) === true, "reserve is configurable");
}

// --- pacing the tail of the window ------------------------------------------
{
  const s = Budget.create(null, NOW);
  // 16 left, 10 min left: affordable = 16 - 6 = 10 -> one page per minute.
  Budget.note(s, OP, headersAt(16, 10 * MIN), NOW);
  const gap = Budget.pageGapMs(s, OP, NOW);
  assert(Math.abs(gap - MIN) < 2 * SEC, "below half the window, pages spread over the time left: " + gap);
  assert(Budget.healthy(s, OP, NOW, { pages: 12 }) === false, "16 left cannot afford a 12-page deep pass");
  assert(Budget.healthy(s, OP, NOW, { pages: 4 }) === false, "bottom half of the window is never 'healthy' for deep passes");
  const top = Budget.create(null, NOW);
  Budget.note(top, OP, headersAt(30, 10 * MIN), NOW);
  assert(Budget.healthy(top, OP, NOW, { pages: 12 }) === true, "30 left (top half) affords a 12-page deep pass");
  assert(Budget.healthy(top, OP, NOW, { pages: 25 }) === false, "30 left cannot afford 25 pages over the reserve");
  // Exactly at the reserve: the gap is the wait to reset.
  Budget.note(s, OP, headersAt(Budget.RESERVE, 3 * MIN), NOW);
  assert(Budget.pageGapMs(s, OP, NOW) >= 3 * MIN, "no affordable calls: gap is the reset wait");
  // Min gap floor is respected and configurable.
  Budget.note(s, OP, headersAt(20, 5 * SEC), NOW); // 14 affordable over 5s = 357ms
  assert(Budget.pageGapMs(s, OP, NOW, { minGap: 700 }) === 700, "min gap floor wins over a tiny spread");
}

// --- 429 handling -------------------------------------------------------------
{
  const s = Budget.create(null, NOW);
  Budget.note(s, OP, { status: 429, reset: Math.floor((NOW + 4 * MIN) / 1000) }, NOW);
  assert(Budget.remaining(s, OP, NOW) === 0, "429 without remaining header marks 0 left");
  assert(Budget.canSpend(s, OP, NOW) === false, "429 blocks spending");
  const w = Budget.waitMs(s, OP, NOW);
  assert(w >= 4 * MIN && w <= 4 * MIN + 2 * SEC, "429 wait is the header reset: " + w);

  const s2 = Budget.create(null, NOW);
  Budget.noteExhausted(s2, OP, null, NOW);
  assert(Budget.waitMs(s2, OP, NOW) >= Budget.WINDOW_MS, "429 with no reset waits a full window");

  // Once the reset passes, the window is forgotten and spending resumes.
  const later = NOW + 4 * MIN + SEC;
  assert(Budget.remaining(s, OP, later) === null, "reset rolls the window over");
  assert(Budget.canSpend(s, OP, later) === true, "spending resumes after reset");
  assert(Budget.status(s, [OP], later).paused === false, "status clears after reset");
}

// --- reset header sanity ---------------------------------------------------------
{
  assert(Budget.resetToMs(null, NOW) === null, "missing reset is null");
  assert(Budget.resetToMs(0, NOW) === null, "zero reset is null");
  assert(Budget.resetToMs(Math.floor((NOW - MIN) / 1000), NOW) === NOW + Budget.WINDOW_MS, "past reset falls back to a window");
  assert(Budget.resetToMs(Math.floor((NOW + 3 * 60 * MIN) / 1000), NOW) === NOW + Budget.WINDOW_MS, "absurd reset falls back to a window");
  assert(Budget.resetToMs(NOW + 2 * MIN, NOW) === NOW + 2 * MIN, "ms reset is accepted as-is");
  assert(Budget.resetToMs("garbage", NOW) === null, "non-numeric reset is null");
}

// --- out-of-order responses: smaller remaining in the same window wins ------------
{
  const s = Budget.create(null, NOW);
  Budget.note(s, OP, headersAt(10, 8 * MIN), NOW);
  Budget.note(s, OP, headersAt(14, 8 * MIN), NOW + SEC);
  assert(Budget.remaining(s, OP, NOW + SEC) === 10, "a late, larger remaining does not raise the count");
  // A genuinely new window (different reset) does replace it.
  Budget.note(s, OP, headersAt(49, 15 * MIN - SEC), NOW + 2 * SEC);
  assert(Budget.remaining(s, OP, NOW + 2 * SEC) === 49, "a new window replaces the old count");
}

// --- persistence: serialize / create round-trip, stale windows dropped -------------
{
  const s = Budget.create(null, NOW);
  Budget.note(s, OP, headersAt(9, 7 * MIN), NOW);
  Budget.note(s, "UserTweets", headersAt(3, 30 * SEC), NOW);
  const raw = JSON.parse(JSON.stringify(Budget.serialize(s)));
  const back = Budget.create(raw, NOW + SEC);
  assert(Budget.remaining(back, OP, NOW + SEC) === 9, "round-trip keeps remaining");
  assert(Math.abs(Budget.resetAt(back, OP, NOW + SEC) - (NOW + 7 * MIN)) < SEC, "round-trip keeps reset");
  const muchLater = Budget.create(raw, NOW + MIN);
  assert(Budget.remaining(muchLater, "UserTweets", NOW + MIN) === null, "a window past its reset is not restored");
  assert(Budget.remaining(muchLater, OP, NOW + MIN) === 9, "live windows are restored");
  assert(Budget.create({ ops: { Bogus: { remaining: 0 } } }, NOW).ops.Bogus === undefined, "unknown ops are dropped on load");
  assert(Budget.create("nope", NOW).ops && Object.keys(Budget.create(42, NOW).ops).length === 0, "garbage input yields an empty budget");
}

console.log("All metrics-budget tests passed.");
