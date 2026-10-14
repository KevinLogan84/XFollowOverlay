/**
 * Unit checks for hung-sync recovery (mirrors shared/sync-state.js).
 * Run: node scripts/test-sync-state.js
 */
const fs = require("fs");
const path = require("path");
const Sync = require("../shared/sync-state.js");
const Rest = require("../shared/follow-rest.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const t0 = 1_000_000;

{
  const fresh = {
    busy: true,
    busySince: t0,
    syncStatus: "syncing",
    syncStartedAt: t0,
    now: t0 + 1000
  };
  assert(Sync.buttonText(fresh) === "Syncing…", "fresh click shows Syncing");
  assert(Sync.buttonDisabled(fresh) === true, "fresh click disables button");
  assert(Sync.isStuck(fresh) === false, "fresh click is not stuck");
}

{
  // A storage hang: rail busy stays true, content init() wiped storage to idle.
  const hungBusy = {
    busy: true,
    busySince: t0,
    syncStatus: "idle",
    syncStartedAt: null,
    now: t0 + Sync.STUCK_MS + 1
  };
  assert(Sync.isStuck(hungBusy) === true, "old busy + idle storage is stuck");
  assert(Sync.buttonText(hungBusy) === "Retry sync", "old busy must not stay Syncing");
  assert(Sync.buttonDisabled(hungBusy) === false, "stuck busy re-enables the button");
  assert(Sync.showSyncing(hungBusy) === false, "never show Syncing after wall-clock cap");
}

{
  const hungStorage = {
    busy: false,
    busySince: 0,
    syncStatus: "syncing",
    syncStartedAt: t0,
    now: t0 + Sync.STUCK_MS + 1
  };
  assert(Sync.buttonText(hungStorage) === "Retry sync", "old syncing storage shows Retry");
  assert(Sync.buttonDisabled(hungStorage) === false, "old syncing storage is clickable");
}

{
  const missingStart = {
    busy: false,
    syncStatus: "syncing",
    syncStartedAt: null,
    now: t0
  };
  assert(Sync.isStuck(missingStart) === true, "syncing with no startedAt is stuck");
  assert(Sync.buttonText(missingStart) === "Retry sync", "missing startedAt shows Retry");
}

{
  const idle = {
    busy: false,
    syncStatus: "ok",
    syncStartedAt: null,
    now: t0
  };
  assert(Sync.buttonText(idle) === "Sync now", "idle shows Sync now");
  assert(Sync.buttonDisabled(idle) === false, "idle is clickable");
}

{
  assert(
    Sync.shouldHardExpire("syncing", t0, t0 + Sync.HARD_MS - 1) === false,
    "do not hard-expire a live crawl"
  );
  assert(
    Sync.shouldHardExpire("syncing", t0, t0 + Sync.HARD_MS + 1) === true,
    "hard-expire after HARD_MS"
  );
  assert(
    Sync.shouldHardExpire("syncing", null, t0) === true,
    "hard-expire syncing with no startedAt"
  );
  assert(
    Sync.shouldHardExpire("ok", t0, t0 + Sync.HARD_MS * 2) === false,
    "do not expire a finished sync"
  );
  assert(
    Sync.shouldHardExpire("syncing", t0, t0 + Sync.HARD_MS + 1, t0 + Sync.HARD_MS) ===
      false,
    "recent progress keeps a 429 wait alive"
  );
}

{
  const patch = Sync.expirePatch();
  assert(patch.syncStatus === "error", "expire writes error, not leftover syncing");
  assert(patch.syncStartedAt === null, "expire clears startedAt");
  assert(typeof patch.syncError === "string" && patch.syncError.length > 0, "expire has a message");
}

{
  assert(typeof Sync.RATE_LIMIT_ERROR === "string" && /rate/i.test(Sync.RATE_LIMIT_ERROR), "rate-limit copy exists");
  assert(Sync.HARD_MS >= 180000, "hard timeout covers a short rate-limit wait");
  assert(
    Sync.RATE_LIMIT_WAIT_MS === Rest.MAX_429_WAIT_MS,
    "sync-state rate-limit wait matches FollowRest.MAX_429_WAIT_MS"
  );
  assert(
    Sync.rateLimitStuckMs() === Rest.MAX_429_WAIT_MS + Sync.RATE_LIMIT_STUCK_BUFFER_MS,
    "rate-limit stuck window is MAX_429_WAIT_MS plus a small buffer"
  );
  assert(
    Sync.stuckMsFor({ progressLabel: "Waiting for X rate limit…" }) >=
      Rest.MAX_429_WAIT_MS,
    "recognized 429 wait uses at least the max 429 wait as stuck threshold"
  );
  assert(
    Sync.stuckMsFor({ progressLabel: "Syncing…" }) === Sync.STUCK_MS,
    "plain Syncing… still uses the short stuck window"
  );
}

{
  const live = {
    busy: true,
    busySince: t0,
    lastProgressAt: t0 + 120000,
    syncStatus: "syncing",
    syncStartedAt: t0,
    now: t0 + 121000
  };
  assert(Sync.isStuck(live) === false, "a long crawl with recent pages is not stuck");
  assert(Sync.buttonText(live) === "Syncing…", "live crawl keeps Syncing");
  assert(Sync.buttonDisabled(live) === true, "live crawl stays disabled");
}

{
  const stalled = {
    busy: true,
    busySince: t0,
    lastProgressAt: t0,
    syncStatus: "syncing",
    syncStartedAt: t0,
    now: t0 + Sync.STUCK_MS + 1
  };
  assert(Sync.isStuck(stalled) === true, "no page progress past STUCK_MS is stuck");
}

{
  const waitLabel = "Waiting for X rate limit…";
  const waiting30s = {
    busy: true,
    busySince: t0,
    lastProgressAt: t0,
    syncStatus: "syncing",
    syncStartedAt: t0,
    progressLabel: waitLabel,
    now: t0 + 30000
  };
  assert(
    Sync.isRateLimitWait(waiting30s) === true,
    "Waiting for X rate limit… is a recognized 429 wait"
  );
  assert(
    Sync.isStuck({
      busy: true,
      lastProgressAt: t0,
      syncStatus: "syncing",
      syncStartedAt: t0,
      waitingForRateLimit: true,
      now: t0 + 30000
    }) === false,
    "waitingForRateLimit flag is an equivalent 429-wait signal"
  );
  assert(
    Sync.isStuck(waiting30s) === false,
    "rate-limit wait label is not stuck at 30s"
  );
  assert(Sync.buttonText(waiting30s) === "Syncing…", "rate-limit wait keeps Syncing…");
  assert(Sync.buttonDisabled(waiting30s) === true, "rate-limit wait keeps the button disabled");
  assert(Sync.showSyncing(waiting30s) === true, "rate-limit wait still shows syncing copy");

  const waitingOtherTab = {
    busy: false,
    lastProgressAt: 0,
    storedProgressAt: t0,
    syncStatus: "syncing",
    syncStartedAt: t0,
    progressLabel: waitLabel,
    now: t0 + 174000
  };
  assert(
    Sync.isStuck(waitingOtherTab) === false,
    "stale heartbeat during a labeled 429 wait is not stuck (live 149–174s case)"
  );
  assert(
    Sync.buttonText(waitingOtherTab) === "Syncing…",
    "other-tab 429 wait prefers Syncing… over Retry sync"
  );

  const waitingTooLong = {
    busy: true,
    busySince: t0,
    lastProgressAt: t0,
    syncStatus: "syncing",
    syncStartedAt: t0,
    progressLabel: waitLabel,
    now: t0 + Sync.rateLimitStuckMs() + 1
  };
  assert(
    Sync.isStuck(waitingTooLong) === true,
    "same 429 wait is stuck after the long threshold"
  );
  assert(
    Sync.buttonText(waitingTooLong) === "Retry sync",
    "dead 429 wait offers Retry sync after the long threshold"
  );

  const normalNoLabel = {
    busy: true,
    busySince: t0,
    lastProgressAt: t0,
    syncStatus: "syncing",
    syncStartedAt: t0,
    progressLabel: "Syncing following… 586",
    now: t0 + Sync.STUCK_MS + 1
  };
  assert(
    Sync.isStuck(normalNoLabel) === true,
    "normal syncing without a rate-limit label is stuck at >25s"
  );
  assert(
    Sync.buttonText(normalNoLabel) === "Retry sync",
    "silent crawl without a 429 label shows Retry sync"
  );

  assert(
    Sync.shouldHardExpire(
      "syncing",
      t0,
      t0 + Sync.HARD_MS + 1,
      t0,
      waitLabel
    ) === false,
    "hard-expire does not kill a labeled 429 wait at HARD_MS"
  );
  assert(
    Sync.shouldHardExpire(
      "syncing",
      t0,
      t0 + Sync.rateLimitStuckMs() + 1,
      t0,
      waitLabel
    ) === true,
    "hard-expire still reaps a dead 429 wait after the long threshold"
  );
  assert(
    Sync.shouldHardExpire("syncing", t0, t0 + Sync.HARD_MS + 1, t0) === true,
    "unlabeled sync still hard-expires at HARD_MS"
  );
}

{
  // Another tab just started a sync. This tab's in-memory heartbeat is left
  // over from its own run minutes ago and must not flag the new run as stuck.
  const otherTabFresh = {
    busy: false,
    busySince: 0,
    lastProgressAt: t0 - 600000,
    syncStatus: "syncing",
    syncStartedAt: t0,
    now: t0 + 1000
  };
  assert(Sync.isStuck(otherTabFresh) === false, "stale local heartbeat does not judge another tab's run");
  assert(Sync.buttonText(otherTabFresh) === "Syncing…", "another tab's fresh run shows Syncing");
  assert(Sync.buttonDisabled(otherTabFresh) === true, "another tab's fresh run disables the button");

  // The other tab keeps writing lastSyncProgressAt while paging a long crawl.
  const otherTabLive = {
    busy: false,
    lastProgressAt: 0,
    storedProgressAt: t0 + 120000,
    syncStatus: "syncing",
    syncStartedAt: t0,
    now: t0 + 121000
  };
  assert(Sync.isStuck(otherTabLive) === false, "stored heartbeat keeps another tab's long crawl alive");

  // A stored heartbeat older than the run start belongs to a previous run.
  const otherTabOldBeat = {
    busy: false,
    storedProgressAt: t0 - 5000,
    syncStatus: "syncing",
    syncStartedAt: t0,
    now: t0 + 1000
  };
  assert(Sync.lastProgressAt(otherTabOldBeat) === t0, "run start wins over an older stored heartbeat");
  assert(Sync.isStuck(otherTabOldBeat) === false, "old stored heartbeat does not flag a fresh run");

  // The other tab died mid-crawl: no heartbeat past STUCK_MS is still stuck.
  const otherTabDead = {
    busy: false,
    storedProgressAt: t0 + 2000,
    syncStatus: "syncing",
    syncStartedAt: t0,
    now: t0 + 2000 + Sync.STUCK_MS + 1
  };
  assert(Sync.isStuck(otherTabDead) === true, "silent cross-tab run past STUCK_MS is stuck");
  assert(Sync.buttonText(otherTabDead) === "Retry sync", "dead cross-tab run offers Retry");

  assert(
    Sync.FOLLOW_STORAGE_KEYS.indexOf("lastSyncProgressAt") !== -1,
    "rail reads the stored heartbeat"
  );
  assert(
    Sync.FOLLOW_STORAGE_KEYS.indexOf("syncProgressLabel") !== -1,
    "rail reads the stored progress label"
  );
  assert(
    Sync.FOLLOW_STORAGE_KEYS.indexOf("syncNote") !== -1,
    "rail reads the list-hole note"
  );
  assert(
    Sync.followSnapshot({ syncNote: "X lists 586 of 620 followers." }).syncNote ===
      "X lists 586 of 620 followers.",
    "snapshot carries the list-hole note"
  );
  assert(
    Sync.followSnapshot({ lastSyncProgressAt: 7 }).lastSyncProgressAt === 7,
    "snapshot carries the stored heartbeat"
  );
  assert(
    Sync.followSnapshot({ syncProgressLabel: "Waiting for X rate limit…" })
      .syncProgressLabel === "Waiting for X rate limit…",
    "snapshot carries the stored progress label"
  );
}

{
  const content = fs.readFileSync(
    path.join(__dirname, "../content/content.js"),
    "utf8"
  );
  assert(
    /progressLabel:\s*[\s\S]*syncProgressLabel/.test(content),
    "rail passes the progress label into the stuck helper"
  );
  assert(
    content.includes("hardMsFor"),
    "in-flight watchdog uses hardMsFor so a 429 wait survives HARD_MS"
  );
  assert(
    /age > Sync\.STUCK_MS/.test(content),
    "on-load orphan cleanup still uses the short STUCK_MS window"
  );
  assert(
    content.includes("Sync looks stuck — tap Retry sync."),
    "stuck rail copy is still present for dead syncs"
  );
  const sw = fs.readFileSync(
    path.join(__dirname, "../background/service-worker.js"),
    "utf8"
  );
  assert(
    sw.includes("syncProgressLabel"),
    "service worker reads the progress label before hard-expire"
  );
  assert(
    sw.includes("shouldHardExpire") || /waiting for x rate limit/i.test(sw),
    "service worker uses the shared 429-wait expire path"
  );
}

{
  const disk = {
    lastSyncAt: 1,
    followingTotal: 962,
    followersTotal: 542,
    following: ["a"],
    followers: ["b"],
    followingIds: ["1"],
    followerIds: ["2"]
  };
  assert(Sync.hasFollowSnapshot(disk) === true, "full snapshot is present");
  assert(Sync.keepStorageSnapshot({}, disk).followersTotal === 542, "empty get keeps disk");
  assert(Sync.showEmptyFollowBanner(disk) === false, "populated snapshot is not empty");
  assert(Sync.displayFollowCount(542, new Array(521)) === 542, "display prefers the profile total");
}

{
  const now = t0;
  const fourTwelveMs = (4 * 60 + 12) * 1000;
  const resumeAt = now + fourTwelveMs;
  const countdown = Sync.backoffStatusText({
    resumeAt: resumeAt,
    now: now,
    count: 1432,
    side: "following"
  });
  assert(
    countdown === "Waiting for x.com rate limit, resuming in 4:12 · 1432 following",
    "countdown names x.com, the remaining clock, and the count so far"
  );
  assert(
    Sync.isRateLimitWait({ progressLabel: countdown }) === true,
    "countdown copy is a recognized rate-limit wait"
  );
  assert(
    Sync.isRateLimitWait({ backoffUntil: resumeAt, now: now, progressLabel: "" }) === true,
    "a future backoffUntil is a rate-limit wait without a label"
  );
  assert(Sync.isBackoffPending(resumeAt, now) === true, "future backoff is pending");
  assert(Sync.isBackoffPending(now, now) === false, "a backoff that has arrived is not pending");
  assert(
    Sync.lastUpdateText(now - 12000, now) === "last update 12s ago",
    "last-update hint counts whole seconds"
  );
  assert(Sync.lastUpdateText(now, now) === "last update 0s ago", "a fresh beat still shows 0s");
  assert(Sync.lastUpdateText(0, now) === "", "no heartbeat has no last-update line");

  const cursor = "cursor-1432";
  const quiet = Sync.pageWatchdog({
    now: now + 1000,
    lastProgressAt: now,
    cursor: cursor
  });
  assert(quiet.action === "ok" && quiet.cursor === cursor, "recent progress stays on the same cursor");

  const backing = Sync.pageWatchdog({
    now: now + Sync.WATCHDOG_SILENCE_MS + 1,
    lastProgressAt: now,
    backoffUntil: now + Sync.WATCHDOG_SILENCE_MS + 5000,
    cursor: cursor
  });
  assert(
    backing.action === "backoff" && backing.cursor === cursor,
    "a pending rate-limit wait is not treated as silence"
  );

  const retry = Sync.pageWatchdog({
    now: now + Sync.WATCHDOG_SILENCE_MS + 1,
    lastProgressAt: now,
    silentRetries: 0,
    cursor: cursor
  });
  assert(
    retry.action === "retry-page" && retry.cursor === cursor,
    "the first silent page retries that same cursor"
  );

  const fail = Sync.pageWatchdog({
    now: now + Sync.WATCHDOG_SILENCE_MS + 1,
    lastProgressAt: now,
    silentRetries: Sync.WATCHDOG_PAGE_RETRIES,
    cursor: cursor
  });
  assert(fail.action === "fail" && fail.cursor === cursor, "a second silence fails without dropping the cursor");
  assert(fail.message === Sync.STALL_ERROR, "the stall message tells the user the place is saved");

  const forced = Sync.pageWatchdog({
    forceSilent: true,
    silentRetries: 0,
    lastProgressAt: now,
    now: now + 1000,
    backoffUntil: resumeAt,
    cursor: cursor
  });
  assert(
    forced.action === "retry-page" && forced.cursor === cursor,
    "a finished page timeout retries once even inside the silence window"
  );
  const forcedFail = Sync.pageWatchdog({
    forceSilent: true,
    silentRetries: 1,
    cursor: cursor
  });
  assert(forcedFail.action === "fail" && forcedFail.cursor === cursor, "a second page timeout fails");

  assert(
    Sync.showRateLimitKeysHint({ backingOff: true, hasKeys: false, dismissed: false }) === true,
    "keys hint shows while backing off without keys"
  );
  assert(
    Sync.showRateLimitKeysHint({ backingOff: false, hasKeys: false, dismissed: false }) === false,
    "keys hint stays hidden when sync is not backing off"
  );
  assert(
    Sync.showRateLimitKeysHint({ backingOff: true, hasKeys: true, dismissed: false }) === false,
    "keys hint stays hidden when API keys are already saved"
  );
  assert(
    Sync.showRateLimitKeysHint({ backingOff: true, hasKeys: false, dismissed: true }) === false,
    "Don't show again hides the keys hint"
  );
  assert(
    Sync.KEYS_HINT_TEXT === "Want faster syncs? Add your own X API keys (paid, optional).",
    "keys hint lead copy"
  );
  assert(Sync.KEYS_HINT_FREE_TEXT === "The free sync keeps working.", "keys hint says the free sync keeps working");
  assert(Sync.KEYS_HINT_DISMISS_KEY === "hideRateLimitKeysHint", "dismiss flag is stored locally");
  assert(Sync.KEYS_HINT_SETTINGS_HASH === "#optional-keys", "keys hint links to the optional keys section");
  assert(
    Sync.followSnapshot({ hideRateLimitKeysHint: true }).hideRateLimitKeysHint === true,
    "snapshot keeps a local dismiss"
  );
  assert(
    Sync.followSnapshot({ hideRateLimitKeysHint: "yes" }).hideRateLimitKeysHint === false,
    "only an explicit true dismisses the hint"
  );
  assert(
    Sync.FOLLOW_STORAGE_KEYS.indexOf("hideRateLimitKeysHint") !== -1,
    "rail reads the dismiss flag"
  );
  assert(
    Sync.FOLLOW_STORAGE_KEYS.indexOf("syncBackoffUntil") !== -1,
    "rail reads the backoff deadline"
  );
}

{
  const content = fs.readFileSync(path.join(__dirname, "../content/content.js"), "utf8");
  const popupJs = fs.readFileSync(path.join(__dirname, "../popup/popup.js"), "utf8");
  const popupHtml = fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8");
  const popupCss = fs.readFileSync(path.join(__dirname, "../popup/popup.css"), "utf8");
  const railCss = fs.readFileSync(path.join(__dirname, "../content/styles.css"), "utf8");
  const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");
  const sw = fs.readFileSync(path.join(__dirname, "../background/service-worker.js"), "utf8");
  const hintBits = [Sync.KEYS_HINT_TEXT, Sync.KEYS_HINT_FREE_TEXT, "hideRateLimitKeysHint"];
  hintBits.forEach((bit) => {
    assert(content.includes(bit), "rail includes " + bit);
    assert(popupHtml.includes(bit) || popupJs.includes(bit), "popup includes " + bit);
  });
  assert(
    content.includes("Don't show again") || content.includes("Don\\'t show again"),
    "rail includes Don't show again"
  );
  assert(popupHtml.includes("Don't show again"), "popup includes Don't show again");
  assert(content.includes("showRateLimitKeysHint"), "rail uses showRateLimitKeysHint");
  assert(content.includes("hasUserApiKeys"), "rail hides the hint when keys are present");
  assert(popupJs.includes("showRateLimitKeysHint"), "popup uses showRateLimitKeysHint");
  assert(popupJs.includes("hasUserApiKeys"), "popup hides the hint when keys are present");
  assert(popupHtml.includes('id="optional-keys"'), "settings has an optional-keys anchor");
  assert(popupHtml.includes('href="#optional-keys"'), "popup hint links to the optional keys section");
  assert(popupHtml.includes(">README<"), "popup hint links to the README");
  assert(readme.includes('<a id="optional-keys"></a>'), "README has an optional-keys anchor");
  assert(readme.includes("last update 12s ago"), "troubleshooting explains the count-up timer");
  assert(
    readme.includes("Waiting for x.com rate limit, resuming in 4:10"),
    "troubleshooting explains the rate-limit countdown"
  );
  assert(readme.includes(Sync.KEYS_HINT_TEXT), "troubleshooting includes the keys tip");
  assert(readme.includes(Sync.KEYS_HINT_FREE_TEXT), "troubleshooting says the free sync keeps working");
  assert(
    readme.includes("2 minutes") && readme.includes("20 seconds"),
    "troubleshooting names the silence retry and the page-timeout retry"
  );
  assert(readme.includes("Sync stalled on this page"), "troubleshooting names the stall error");
  assert(sw.includes("XFO_OPEN_KEYS"), "service worker opens the optional keys section");
  assert(content.includes("pageWatchdog"), "content asks the page watchdog before hanging");
  assert(content.includes("resumeGraphqlCheckpoint"), "content resumes a saved GraphQL cursor");
  assert(/@keyframes xfo-sync-pulse/.test(popupCss), "popup pulse keyframes exist");
  assert(/animation:\s*xfo-sync-pulse 1\.2s/.test(popupCss), "popup pulse is about 1.2s");
  assert(/prefers-reduced-motion:\s*reduce/.test(popupCss), "popup pulse respects reduced motion");
  assert(/button\.is-syncing/.test(popupCss), "popup Syncing button takes the pulse class");
  assert(/@keyframes xfo-sync-pulse/.test(railCss), "rail pulse keyframes exist");
  assert(/\.xfo-rail-sync\.is-syncing/.test(railCss), "rail Sync button takes the pulse class");
  assert(/prefers-reduced-motion:\s*reduce/.test(railCss), "rail pulse respects reduced motion");
}

console.log("All sync-state tests passed.");
