/**
 * Unit checks for username detection and follow-list completeness.
 * Run: node scripts/test-sync-identity.js
 */
const Identity = require("../shared/sync-identity.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function el(attrs) {
  return {
    getAttribute(name) {
      return attrs[name] == null ? "" : String(attrs[name]);
    }
  };
}

function docFrom(map) {
  return {
    querySelector(sel) {
      const node = map[sel];
      if (!node) return null;
      return Array.isArray(node) ? node[0] : node;
    },
    querySelectorAll(sel) {
      const node = map[sel];
      if (!node) return [];
      return Array.isArray(node) ? node : [node];
    }
  };
}

{
  assert(Identity.extractUsernameFromHref("/viewer") === "viewer", "relative /user");
  assert(Identity.extractUsernameFromHref("/Viewer/") === "viewer", "trailing slash + case");
  assert(
    Identity.extractUsernameFromHref("https://x.com/viewer") === "viewer",
    "absolute https href"
  );
  assert(
    Identity.extractUsernameFromHref("https://x.com/viewer?s=20") === "viewer",
    "absolute href with query"
  );
  assert(
    Identity.extractUsernameFromHref("/viewer?s=20") === "viewer",
    "relative href with query — the live X profile link shape"
  );
  assert(Identity.extractUsernameFromHref("/home") === null, "reserved home");
  assert(Identity.extractUsernameFromHref("/i/user/12") === null, "reserved /i/");
  assert(Identity.extractUsernameFromHref("") === null, "empty href");
}

{
  const profile = el({
    href: "https://x.com/railcard?s=20",
    "aria-label": "Profile"
  });
  const found = Identity.detectSelfUsernameFromDom(
    docFrom({
      'a[data-testid="AppTabBar_Profile_Link"]': profile
    })
  );
  assert(found === "railcard", "profile link with absolute URL + query");
}

{
  const profile = el({ href: "/OldHandle?src=nav", "aria-label": "Profile" });
  const found = Identity.detectSelfUsernameFromDom(
    docFrom({
      'a[href^="/"][aria-label*="Profile"]': profile
    })
  );
  assert(found === "oldhandle", "aria-label Profile fallback");
}

{
  const switcher = el({
    href: "",
    "aria-label": "Account menu @RailCard"
  });
  const found = Identity.detectSelfUsernameFromDom(
    docFrom({
      '[data-testid="SideNav_AccountSwitcher_Button"]': switcher
    })
  );
  assert(found === "railcard", "account switcher aria-label @handle");
}

{
  const found = Identity.detectSelfUsernameFromDom(
    docFrom({
      '[data-testid="editProfileButton"]': el({})
    }),
    { location: { pathname: "/OnMyPage" } }
  );
  assert(found === "onmypage", "own profile path + Edit profile");
}

{
  const found = Identity.detectSelfUsernameFromDom(docFrom({}), {
    hint: "@CachedUser"
  });
  assert(found === "cacheduser", "stored hint when DOM has no profile link");
}

{
  const found = Identity.detectSelfUsernameFromDom(docFrom({}));
  assert(found === null, "no DOM and no hint");
}

{
  assert(Identity.parseSelfUserIdFromTwid('u=123456789') === "123456789", "plain twid");
  assert(Identity.parseSelfUserIdFromTwid("u%3D987") === null, "needs decoded cookie value");
  assert(Identity.parseSelfUserIdFromTwid('u=42') === null, "id too short");
  assert(Identity.parseSelfUserIdFromTwid(null) === null, "missing twid");
}

{
  assert(
    Identity.listLooksComplete(["a"], 0, []) === true,
    "first sync with no target needs at least one user"
  );
  assert(
    Identity.listLooksComplete([], 0, []) === false,
    "empty first sync is incomplete"
  );
  assert(
    Identity.listLooksComplete(new Array(90).fill("x"), 100, []) === false,
    "90% of a handle list is no longer treated as complete"
  );
  assert(
    Identity.listLooksComplete(new Array(100).fill("x"), 100, []) === true,
    "a full handle list still matches the official count"
  );
  assert(
    Identity.listLooksComplete(["a", "b"], 200, [], { exhausted: true }) === false,
    "exhausted handle list of 2/200 is not complete (old scrape shortcut)"
  );
  assert(
    Identity.listLooksComplete([], 200, [], { exhausted: true }) === false,
    "exhausted empty is still a failure"
  );
  assert(
    Identity.listLooksComplete(new Array(520).fill("h"), 542, [], {
      exhausted: true,
      restIds: true,
      ids: new Array(542).fill("id")
    }) === true,
    "REST: 520 handles of 542 IDs is complete when the ID cursor is done"
  );
  assert(
    Identity.listLooksComplete(new Array(520).fill("h"), 542, [], {
      exhausted: false,
      restIds: true,
      ids: new Array(520).fill("id")
    }) === false,
    "REST: short ID list without an exhausted cursor is incomplete"
  );
  assert(
    Identity.listLooksComplete([], 542, [], {
      exhausted: true,
      restIds: true,
      ids: []
    }) === false,
    "REST: exhausted empty ID list is a failure"
  );
  // v1.1.21: a cursor that ran to 0 is X's own end of list. The shortfall
  // against the profile count is accounts X counts but will not list, so
  // the two-call REST path is final — no friends/list or GraphQL crawl.
  assert(
    Identity.listLooksComplete(new Array(521).fill("h"), 542, [], {
      exhausted: true,
      restMembership: true,
      ids: new Array(521).fill("id")
    }) === true,
    "REST list: exhausted 521 of 542 (21 short) is trusted"
  );
  assert(
    Identity.listLooksComplete(new Array(586).fill("h"), 620, [], {
      exhausted: true,
      restMembership: true,
      ids: new Array(586).fill("id")
    }) === true,
    "exhausted list a few percent short of the official count is complete without another crawl"
  );
  assert(
    Identity.listLooksComplete(new Array(586).fill("h"), 620, [], {
      exhausted: true,
      restIds: true,
      ids: new Array(586).fill("id")
    }) === true,
    "rest-ids: 586 of 620 exhausted is complete"
  );
  assert(
    Identity.listLooksComplete(new Array(466).fill("h"), 620, [], {
      exhausted: true,
      restIds: true,
      ids: new Array(466).fill("id")
    }) === true,
    "exhausted 466/620 (154 short, 24.8%) is still inside the 25% trust bound"
  );
  assert(
    Identity.listLooksComplete(new Array(400).fill("h"), 620, [], {
      exhausted: true,
      restIds: true,
      ids: new Array(400).fill("id")
    }) === false,
    "exhausted 400/620 (35% short) is a broken response, not a phantom hole"
  );
  assert(
    Identity.listLooksComplete(new Array(586).fill("h"), 620, new Array(600).fill("p"), {
      exhausted: true,
      restIds: true,
      ids: new Array(586).fill("id")
    }) === true,
    "a longer previous list does not force a second opinion on an exhausted cursor"
  );
  assert(
    Identity.listLooksComplete(new Array(586).fill("h"), 620, [], {
      exhausted: false,
      restIds: true,
      ids: new Array(586).fill("id")
    }) === false,
    "586/620 without an exhausted cursor is still incomplete"
  );
  assert(Identity.EXHAUSTED_TRUST_PCT === 0.25, "documented trust bound is 25%");
  assert(
    Identity.exhaustedListShortfall(620, {}) === 620 * 0.25,
    "exhausted shortfall is the larger of slack and 25%"
  );
  assert(
    Identity.exhaustedListShortfall(40, {}) === 15,
    "small lists keep the 15-id slack when 25% would be smaller"
  );
  assert(Identity.unlistedCount(620, new Array(586), new Array(580)) === 34, "620 counted, 586 listed → 34 unlisted");
  assert(Identity.unlistedCount(620, new Array(620), []) === null, "full list has no unlisted count");
  assert(Identity.unlistedCount(620, [], []) === null, "no list yet, no unlisted count");
  assert(Identity.unlistedCount(null, new Array(586), []) === null, "no total, no unlisted count");
  assert(Identity.unlistedCount(600, new Array(620), []) === null, "list longer than the count is not unlisted");
  assert(
    Identity.listLooksComplete(new Array(607).fill("h"), 620, [], {
      exhausted: true,
      restMembership: true,
      ids: new Array(607).fill("id")
    }) === true,
    "REST: exhausted 607/620 (8 short) is within max(15, 2%) slack"
  );
  assert(
    Identity.listLooksComplete(new Array(600).fill("h"), 620, [], {
      exhausted: true,
      restMembership: true,
      ids: new Array(600).fill("id")
    }) === true,
    "REST: exhausted 600/620 (15 short) is exactly at the 15-id slack"
  );
  assert(
    Identity.listLooksComplete(new Array(599).fill("h"), 620, [], {
      exhausted: true,
      restMembership: true,
      ids: new Array(599).fill("id")
    }) === true,
    "REST: exhausted 599/620 (16 short) is past the 15-id slack but inside the trust bound"
  );
  assert(
    Identity.listLooksComplete(new Array(599).fill("h"), 620, [], {
      exhausted: false,
      restMembership: true,
      ids: new Array(599).fill("id")
    }) === false,
    "REST: cut-off 599/620 (cursor never reached 0) is not complete"
  );
  assert(
    Identity.listLooksComplete(new Array(1960).fill("h"), 2000, [], {
      exhausted: true,
      restMembership: true,
      ids: new Array(1960).fill("id")
    }) === true,
    "REST: 40/2000 (2%) is allowed because slack is max(15, 40)"
  );
  assert(
    Identity.restMembershipSlack(620) === 15,
    "620-follower slack is 15 (2% is only 12.3)"
  );

  // v1.1.20: once GraphQL has walked to the end and found the same hole,
  // the confirmed gap rides on top of the slack.
  assert(
    Identity.listLooksComplete(new Array(586).fill("h"), 620, [], {
      exhausted: true,
      restIds: true,
      ids: new Array(586).fill("id"),
      confirmedGap: 34
    }) === true,
    "confirmed 34-account hole makes exhausted 586/620 REST complete"
  );
  assert(
    Identity.listLooksComplete(new Array(582).fill("h"), 616, [], {
      exhausted: true,
      restIds: true,
      ids: new Array(582).fill("id"),
      confirmedGap: 34
    }) === true,
    "one new follower on both sides keeps the confirmed hole valid"
  );
  assert(
    Identity.listLooksComplete(new Array(560).fill("h"), 620, [], {
      exhausted: true,
      restIds: true,
      ids: new Array(560).fill("id"),
      confirmedGap: 34
    }) === true,
    "hole grown past confirmed + slack (55 > 49) is still inside the exhausted trust bound"
  );
  assert(
    Identity.listLooksComplete(new Array(300).fill("h"), 620, [], {
      exhausted: true,
      restIds: true,
      ids: new Array(300).fill("id"),
      confirmedGap: 34
    }) === false,
    "a confirmed hole does not excuse a list missing half the accounts"
  );
  assert(
    Identity.listLooksComplete(new Array(586).fill("h"), 620, [], {
      exhausted: false,
      restIds: true,
      ids: new Array(586).fill("id"),
      confirmedGap: 34
    }) === false,
    "a confirmed hole never excuses a cursor that did not finish"
  );
  assert(Identity.allowedListShortfall(620, { confirmedGap: 34 }) === 49, "shortfall = slack + gap");
  assert(Identity.allowedListShortfall(620, {}) === 15, "no confirmed gap is plain slack");

  // GraphQL is judged like any other exhausted list: an end-of-list cursor
  // is trusted inside the same bound.
  assert(
    Identity.listLooksComplete(new Array(607).fill("h"), 620, [], {
      exhausted: true,
      ids: new Array(607).fill("id")
    }) === true,
    "exhausted GraphQL 607/620 is within slack"
  );
  assert(
    Identity.listLooksComplete(new Array(586).fill("h"), 620, [], { exhausted: true }) === true,
    "exhausted GraphQL 586/620 alone is complete"
  );
  assert(
    Identity.listLooksComplete(new Array(200).fill("h"), 620, [], { exhausted: true }) === false,
    "exhausted GraphQL 200/620 is a broken crawl"
  );
  assert(
    Identity.listLooksComplete(new Array(586).fill("h"), 620, [], {
      exhausted: true,
      confirmedGap: 34
    }) === true,
    "exhausted GraphQL 586/620 passes once the hole is confirmed"
  );
  assert(
    Identity.listLooksComplete(new Array(600).fill("h"), 620, [], {
      exhausted: false,
      ids: new Array(607).fill("id")
    }) === false,
    "unfinished GraphQL crawl gets no slack"
  );
  assert(
    Identity.REST_MEMBERSHIP_ABS_SLACK === 15 &&
      Identity.REST_MEMBERSHIP_PCT_SLACK === 0.02,
    "documented slack is 15 IDs or 2%"
  );
}

{
  assert(
    Identity.extractRestIdFromHref("/i/user/123456789") === "123456789",
    "rest_id from /i/user path"
  );
  assert(
    Identity.extractRestIdFromHref("https://x.com/i/user/123456789?s=20") === "123456789",
    "rest_id from absolute /i/user href"
  );
  assert(Identity.extractRestIdFromHref("/sample_user") === null, "handle href is not a rest_id");
}

{
  assert(
    Identity.classifyFollow("ada", null, {
      following: ["ada"],
      followers: ["ada"]
    }) === "mutual",
    "handle match still classifies mutuals"
  );
  assert(
    Identity.classifyFollow(null, "22", {
      following: [],
      followers: [],
      followerIds: ["22"]
    }) === "follower",
    "unhydrated follower is still a follower by rest_id"
  );
  assert(
    Identity.classifyFollow("ghost", "22", {
      following: [],
      followers: [],
      followerIds: ["22"]
    }) === "follower",
    "rest_id match wins when lookup omitted the handle"
  );
}

{
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(__dirname, "../content/content.js"), "utf8");
  const hook = fs.readFileSync(path.join(__dirname, "../content/page-hook.js"), "utf8");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8")
  );
  assert(content.includes('const XFO_VERSION = "1.2.1"'), "content version is 1.2.1");
  assert(content.includes("collectFollowGraph"), "runSync uses collectFollowGraph");
  assert(content.includes("currentSyncRoute"), "runSync refuses to start without a session route");
  assert(content.includes("pageGraphql"), "content talks to the page hook");
  assert(content.includes("pageRest"), "content talks to the REST hook");
  assert(content.includes("Finding your account"), "sync reports account detection");
  assert(!/scrapeFollowSide|function spaGo|scrollFollowList/.test(content), "content has no follow-list scrape");
  assert(content.includes("pauseScanObserver"), "sync disconnects the mutation observer");
  assert(/finally \{[\s\S]*metricsHold = false/.test(content), "metricsHold clears in runSync finally");
  assert(hook.includes('d.type === "XFO_GQL"'), "page-hook accepts XFO_GQL commands");
  assert(hook.includes('d.type === "XFO_REST"'), "page-hook accepts XFO_REST commands");
  assert(hook.includes("x-client-transaction-id"), "page-hook documents the TID path");
  assert(manifest.version === "1.2.1", "manifest version is 1.2.1");
  assert(
    !/if \(opts\.exhausted\) return membership > 0/.test(content),
    "content fallback keeps a sanity bound on exhausted REST lists"
  );
  assert(content.includes("0.25 * target"), "content fallback mirrors the 25% exhausted trust bound");
  // v1.1.21: passive relationship capture from X's own responses.
  assert(hook.includes("XFO_RELATIONS"), "page-hook posts harvested relations");
  assert(hook.includes("relationship_perspectives"), "page-hook reads the 2025+ user shape");
  assert(hook.includes("followed_by"), "page-hook reads followed_by");
  assert(
    hook.includes("friendships") && hook.includes("relationFromAction"),
    "page-hook sees follow/unfollow clicks"
  );
  assert(content.includes('d.type === "XFO_RELATIONS"'), "content ingests harvested relations");
  assert(content.includes("Passive.relationFor"), "classify layers passive relations over the sync");
  assert(content.includes("Passive.mergeIdMap") || content.includes("Passive.idPairs"), "sync seeds followIdMap from passive handles");
  assert(content.includes("passiveRelations"), "passive relations are persisted");
  assert(
    manifest.content_scripts.some((s) => (s.js || []).includes("shared/passive-relations.js")),
    "content script loads passive-relations"
  );
  assert(
    manifest.content_scripts.some((s) => {
      const js = s.js || [];
      return js.indexOf("shared/passive-relations.js") !== -1 &&
        js.indexOf("shared/passive-relations.js") < js.indexOf("content/content.js");
    }),
    "passive-relations loads before content.js"
  );
  // v1.1.22: the metrics pump spends from a per-op rate-limit budget
  // learned from x-rate-limit-* headers instead of retrying blind.
  assert(hook.includes("XFO_RATE"), "page-hook reports rate-limit windows");
  assert(hook.includes("x-rate-limit-remaining"), "page-hook reads x-rate-limit-remaining");
  assert(hook.includes("rateLimitRemaining"), "XFO_GQL results carry the remaining budget");
  assert(content.includes('d.type === "XFO_RATE"'), "content ingests rate-limit windows");
  assert(content.includes("Budget.note("), "content feeds GraphQL responses into the budget");
  assert(content.includes("throwIfBudgetSpent("), "crawls stop before the budget hits zero");
  assert(content.includes("throwIfCrawlAborted("), "crawls honour the abort signal");
  assert(
    /function withTimeout\(promise, ms, label, abortCtrl\)[\s\S]*?abortCtrl\.abort\(\)/.test(content) &&
      /withTimeout\(\s*computePostMetrics\([^)]*ctl: ctl \}\),[\s\S]*?ctl\s*\)/.test(content),
    "pump aborts a timed-out crawl instead of orphaning it"
  );
  assert(content.includes("rateLimitWaitFromError"), "429 pauses use X's reset time");
  assert(content.includes("budgetPageGapMs("), "page gaps pace to the remaining budget");
  assert(content.includes("metricsBudget"), "budget state is persisted");
  // v1.1.23: windows are per op (UserTweets 50, UserTweetsAndReplies 500), so a
  // spent fallback is skipped instead of pausing the pump until its reset.
  assert(
    /if \(!budgetSpent\("UserTweets"\)\) \{[\s\S]*?gql\("UserTweets"\)/.test(content),
    "spent UserTweets fallback is skipped, not waited for"
  );
  assert(
    /if \(!budgetSpent\("SearchTimeline"\)\) \{[\s\S]*?collectTimelineViaSearchGraphql/.test(content),
    "spent SearchTimeline fallback is skipped, not waited for"
  );
  assert(
    /if \(searchBudgetRemaining\(\) > 0\) \{[\s\S]*?collectTimelineViaSearch\(screenName/.test(content),
    "REST adaptive search still runs when only the GraphQL search window is spent"
  );
  assert(
    (content.match(/!\(Number\(\w+ && \w+\.budgetWaitMs\) > 0\)/g) || []).length >= 2,
    "budget-spent errors from fallbacks do not pause the pump"
  );
  assert(hook.includes("XFO_GQL_FEATURES"), "page-hook posts X's live GraphQL contract");
  assert(hook.includes("missingFeatures"), "page-hook names switches a 400 says are required");
  assert(content.includes('d.type === "XFO_GQL_FEATURES"'), "content adopts X's live contract");
  assert(content.includes("adjustContractFromError"), "a 400 on the page-hook path patches the contract and retries");
  assert(
    /err\.status === 400[\s\S]{0,240}adjustContractFromError/.test(content),
    "graphqlFollow retries a contract 400 before giving up"
  );
  const panelHtml = content.slice(
    content.indexOf("panel.innerHTML"),
    content.indexOf("const legend = panel.querySelector")
  );
  assert(!panelHtml.includes("data-xfo-activity"), "rail panel does not render an Activity row");
  assert(!/>\s*Days\s*</.test(panelHtml), "rail panel does not label Days");
  assert(!/posts per day|per active day/i.test(panelHtml), "rail panel has no posts-per-day copy");
  assert(
    content.includes("MetricsRefill.activityPendingCount") &&
      content.includes("MetricsRefill.activityStatusText"),
    "first-face pending is classified but Activity copy is Live / Paused"
  );
  assert(
    !/if \(pending > 0\) return "Loading " \+ pending/.test(content),
    "rail Activity never returns Loading N"
  );
  assert(!content.includes("xfo-rail-listed"), "rail does not paint a listed subtitle");
  assert(
    !content.includes("publishMetricsProgress") && !/metricsSyncPending:/.test(content),
    "the pump no longer mirrors its queue into storage (nothing reads it)"
  );
  assert(
    content.includes("storageRemove(RETIRED_STORAGE_KEYS)") &&
      /RETIRED_STORAGE_KEYS = \[[\s\S]*?"settings"/.test(content),
    "keys from the removed popup are cleared on load"
  );
  assert(!content.includes("runMetricsProbe"), "the uncalled metrics probe is gone");
  assert(
    !/return metricsQueue\.length \+ metricsInFlight\.size/.test(content),
    "metricsPendingCount is not the raw queue+inFlight size"
  );
  assert(
    !/metricsSyncStatus: "ok",\s*metricsLastError: null/.test(content),
    "progress updates do not clobber metricsLastError"
  );
  assert(
    manifest.content_scripts.some((s) => {
      const js = s.js || [];
      return js.indexOf("shared/metrics-budget.js") !== -1 &&
        js.indexOf("shared/metrics-budget.js") < js.indexOf("content/content.js");
    }),
    "metrics-budget loads before content.js"
  );
  assert(content.includes("clearSyncProgress"), "ok sync clears persisted progress");
  assert(content.includes("syncProgressLabel: \"\""), "ok save writes an empty progress label");
  assert(
    content.includes("API list incomplete — using your x.com session"),
    "an incomplete API list falls through to the signed-in session"
  );
  assert(
    content.includes("Syncing from your x.com session"),
    "the no-key path syncs from the signed-in tab"
  );
  assert(content.includes("pruneLiveIdMap"), "runSync prunes followIdMap to live ids");
  assert(content.includes("followerIds"), "content persists follower rest_ids");
  assert(content.includes("authorInfoFromScope"), "overlay reads rest_id from tweets");
  assert(content.includes("fetchRestOfficialCounts"), "official counts use REST show");
  assert(
    manifest.content_scripts.some((s) => s.world === "MAIN" && s.js.includes("content/page-hook.js")),
    "page-hook is a MAIN-world content script"
  );
  assert(
    manifest.content_scripts.some((s) => (s.js || []).includes("shared/sync-identity.js")),
    "content script loads sync-identity"
  );
  assert(
    manifest.content_scripts.some((s) => (s.js || []).includes("shared/metrics-refill.js")),
    "content script loads metrics-refill"
  );
}

console.log("All sync-identity tests passed.");
