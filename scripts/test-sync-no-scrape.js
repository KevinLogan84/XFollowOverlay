/**
 * Guardrail: Sync now must not SPA-navigate or scroll follow lists.
 * Run: node scripts/test-sync-no-scrape.js
 */
const fs = require("fs");
const path = require("path");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

const content = read("content/content.js");
const followRest = read("shared/follow-rest.js");
const railCss = read("content/styles.css");
const manifest = JSON.parse(read("manifest.json"));
const install = read("scripts/install-macos.sh");

const scrapeNames = [
  "scrapeFollowSide",
  "function spaGo",
  "scrollFollowList",
  "readUserCells"
];

scrapeNames.forEach((name) => {
  assert(!content.includes(name), "content.js must not contain " + name);
});

assert(!content.includes("180000"), "content.js has no 180s scrape deadline");
assert(!/scrollIntoView|scrollBy\(0/.test(content), "content.js does not scroll follow lists");

assert(followRest.includes("friends/ids.json"), "REST helper uses v1.1 friends/ids");
assert(followRest.includes("followers/ids.json"), "REST helper uses v1.1 followers/ids");
assert(followRest.includes("users/lookup.json"), "REST helper hydrates via users/lookup");
assert(content.includes("paginateFollowGraph"), "session sync walks web GraphQL");
assert(content.includes("politeSessionPause"), "session GraphQL pages pause between requests");
assert(content.includes('route.path === "api"'), "API fast path is gated on the route");
assert(content.includes("collectViaV2"), "API fast path uses v2 follow lists");
assert(!content.includes("tryRestFollowLists"), "default sync does not crawl session REST lists");
assert(content.includes("pageRest"), "sync uses the page-world REST hook");
assert(content.includes("pageGraphql"), "sync still has the page-world GraphQL hook");
assert(content.includes("pauseScanObserver()"), "runSync pauses the mutation observer");
assert(content.includes("resumeScanObserver()"), "runSync resumes the mutation observer");
assert(
  /finally \{[\s\S]*metricsHold = false[\s\S]*resumeScanObserver/.test(content),
  "runSync finally clears metricsHold and reconnects the observer"
);

const initSlice = content.slice(content.indexOf("async function init()"));
assert(!/startSync\(/.test(initSlice), "init does not auto-sync");

assert(fs.existsSync(path.join(__dirname, "..", "popup", "popup.html")), "onboarding popup exists");
assert(
  !fs.existsSync(path.join(__dirname, "..", "shared", "page-sync.js")),
  "no injected page-sync.js"
);
assert(manifest.action && manifest.action.default_popup === "popup/popup.html", "toolbar popup is the onboarding page");
assert(
  JSON.stringify(manifest.permissions) === JSON.stringify(["storage", "tabs"]),
  "storage plus tabs (to reach the signed-in x.com tab)"
);
assert(content.includes("XFO_RUN_SYNC"), "popup can start Sync on the x.com tab");
assert(content.includes("XFO_SESSION"), "popup can ask whether this tab is signed in");
assert(!content.includes("syncRequestId"), "content no longer starts sync from syncRequestId");
assert(/runtime\.onMessage/.test(content), "content answers the onboarding popup");
assert(
  JSON.stringify((manifest.web_accessible_resources || [])[0].resources) ===
    JSON.stringify(["content/page-hook.js", "popup/keys-frame.html"]),
  "web-accessible files are the page hook and the extension key form"
);
assert(
  !(manifest.web_accessible_resources || [])[0].resources.some((item) =>
    String(item).indexOf("shared/") === 0
  ),
  "shared/* stays a content script, not a web-accessible file"
);
assert(!/postMessage\([^;]*?,\s*"\*"\s*\)/.test(content), "content has no '*' postMessage target");

assert(/--primary:\s*#1d9bf0/.test(railCss), "rail --primary stays Twitter blue");
assert(
  /\.xfo-rail-sync\s*\{[\s\S]*background:\s*var\(--primary\)/.test(railCss),
  "rail Sync now uses --primary"
);

assert(manifest.version === "1.2.12", "manifest is 1.2.12");
assert(/MARKETING_VERSION=1\.2\.12/.test(install), "install marketing version is 1.2.12");
assert(/CURRENT_PROJECT_VERSION=157/.test(install), "install project version is 157");
const releaseSh = read("scripts/release-macos.sh");
assert(/VERSION="1\.2\.12"/.test(releaseSh), "release marketing version is 1.2.12");
assert(/BUILD="157"/.test(releaseSh), "release build is 157");
const pbx = read("Safari/X Follow Overlay/X Follow Overlay.xcodeproj/project.pbxproj");
assert(/MARKETING_VERSION = 1\.2\.12;/.test(pbx), "Xcode marketing version is 1.2.12");
assert(!/MARKETING_VERSION = 1\.2\.11;/.test(pbx), "Xcode marketing version is not 1.2.11");
assert(/CURRENT_PROJECT_VERSION = 157;/.test(pbx), "Xcode project version is 157");
assert(!/CURRENT_PROJECT_VERSION = 155;/.test(pbx), "Xcode project version is not 155");
// v1.1.28: pure logic lives in tested shared modules that load before content.js.
["shared/metrics-days.js", "shared/graphql-timeline.js"].forEach((file) => {
  assert(
    (manifest.content_scripts || []).some((s) => {
      const js = s.js || [];
      return js.indexOf(file) !== -1 && js.indexOf(file) < js.indexOf("content/content.js");
    }),
    file + " loads before content.js"
  );
});
assert(content.includes('localStorage.getItem("xfoDebug") === "1"'), "debug output is opt-in");
assert(!/console\.(log|warn|error)\(/.test(content), "content.js prints nothing unless debug is on");
const handler = read("Safari/X Follow Overlay/Shared (Extension)/SafariWebExtensionHandler.swift");
assert(!handler.includes("os_log"), "native handler does not log every message");
assert(handler.includes("completeRequest"), "native handler still answers Safari");
// v1.1.22: the rate-limit budget is learned from headers X already sends —
// no new host permissions. The toolbar popup is the onboarding page.
assert(
  (manifest.content_scripts || []).some((s) =>
    (s.js || []).includes("shared/metrics-budget.js")
  ),
  "content script loads metrics-budget"
);
assert(
  /METRICS_DEEP_PAGES = 12\b/.test(content) && /METRICS_MAX_PAGES = 8\b/.test(content),
  "metrics crawls are capped at 8 pages (12 deep) — 60-page crawls burned the 15-minute window"
);
assert(/METRICS_CRAWL_DAYS = METRICS_CONS_DAYS/.test(content), "crawl target is the 30-day window");
assert(content.includes("streakReachesOldest"), "long streaks paint as N+ instead of crawling deeper");
// v1.1.21: passive capture adds no requests of its own.
assert(
  (manifest.content_scripts || []).some((s) =>
    (s.js || []).includes("shared/passive-relations.js")
  ),
  "content script loads passive-relations"
);
const hook = read("content/page-hook.js");
assert(hook.includes("XFO_RELATIONS"), "page-hook harvests relations from X's own responses");
assert(!/fetch\([^)]*relationship/i.test(hook), "harvest never issues its own requests");
assert(content.includes("ingestPassiveRelations"), "content ingests page-hook relations");
assert(
  /passiveRelations: Passive\.serialize/.test(content),
  "passive relations persist through storageSet"
);
assert(
  (manifest.content_scripts || []).some((s) =>
    (s.js || []).includes("shared/metrics-refill.js")
  ),
  "content script loads metrics-refill"
);
assert(followRest.includes("users/show.json"), "leftover IDs retry via users/show");
assert(followRest.includes("account/verify_credentials.json"), "official counts use verify_credentials");
assert(followRest.includes("preferredListTotal"), "display total prefers official then IDs");
assert(
  /async function collectViaList[\s\S]*pruneIdMap/.test(followRest),
  "rest-list path prunes followIdMap to live ids"
);
assert(followRest.includes("pickRicherRestResult"), "REST keeps the fuller membership path");
assert(content.includes("preferredListTotal"), "runSync stores official/ID totals");
// v1.1.20: a hole both list APIs agree on must not fail the sync forever.
assert(content.includes("collectGraphqlGraph"), "no-key sync uses the session GraphQL walk");
assert(followRest.includes("unionFollowResults"), "REST helper can still union two lists");
assert(followRest.includes("confirmGapAfterGraphql"), "REST helper can remember an agreed hole");
assert(followRest.includes("acceptExhaustedSides"), "REST helper can keep an exhausted list");
assert(content.includes("syncConfirmedGap"), "runSync persists the confirmed hole");
assert(content.includes("MAX_GRAPHQL_429_WAITS"), "GraphQL fallback has a bounded 429 budget");
assert(!/rateWaits > 12/.test(content), "GraphQL no longer waits out twelve rate-limit windows");
assert(content.includes("storedFollowersTotal"), "runSync keeps a stored profile total");
assert(content.includes("progressLabel"), "rail passes progressLabel into the stuck helper");
assert(content.includes("lastFollowSnapshot"), "rail keeps a last follow snapshot");
assert(content.includes("showEmptyFollowBanner"), "rail empty banner uses the snapshot helper");
assert(
  (manifest.content_scripts || []).some((s) =>
    (s.js || []).includes("shared/follow-rest.js")
  ),
  "content script loads follow-rest"
);

console.log("All no-scrape sync tests passed.");
