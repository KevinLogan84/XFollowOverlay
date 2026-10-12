/**
 * Official profile totals vs membership lists, and rail timeout paint.
 * Run: node scripts/test-follow-totals.js
 */
const Rest = require("../shared/follow-rest.js");
const Sync = require("../shared/sync-state.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

{
  assert(
    Rest.preferredListTotal(542, new Array(521), new Array(521), 520) === 542,
    "official count wins over a shorter list and a stale stored total"
  );
  assert(
    Rest.preferredListTotal(620, new Array(586), new Array(586), 620) === 620,
    "rail total stays the official count, not the shorter membership list"
  );
  assert(
    Rest.preferredListTotal(null, new Array(521), new Array(521), 542) === 542,
    "if UserByScreenName misses this run, keep stored 542 not ID length 521"
  );
  assert(
    Rest.preferredListTotal(965, new Array(965), new Array(965), 962) === 965,
    "following uses the fresh signed-in profile count"
  );
  assert(
    Rest.preferredListTotal(null, [], []) === 0,
    "no official, no lists, no stored → 0"
  );
}

{
  const creds = Rest.countsFromRestUser({
    screen_name: "viewer",
    friends_count: 962,
    followers_count: 542
  });
  assert(creds.following === 962 && creds.followers === 542, "verify_credentials user object");
  const gql = Rest.countsFromGraphqlUser({
    data: {
      user: {
        result: {
          __typename: "User",
          core: { screen_name: "viewer" },
          legacy: { friends_count: 962, followers_count: 542 }
        }
      }
    }
  });
  assert(gql.followers === 542, "GQL walker finds legacy.followers_count");
  const wrapped = Rest.countsFromGraphqlUser({
    data: {
      user: {
        result: {
          __typename: "UserUnavailable",
          result: {
            __typename: "User",
            friends_count: 962,
            followers_count: 542
          }
        }
      }
    }
  });
  assert(wrapped.followers === 542, "GQL walker follows UserUnavailable.result");
}

{
  const dom = Rest.countsFromProfileDom(
    {
      querySelectorAll() {
        return [
          {
            getAttribute() {
              return "https://x.com/viewer/verified_followers";
            },
            textContent: "500 Followers"
          },
          {
            getAttribute() {
              return "/other/followers";
            },
            textContent: "88 Followers"
          }
        ];
      }
    },
    "viewer"
  );
  assert(dom.followers == null, "verified_followers alone is not the signed-in count");
}

{
  const disk = {
    following: new Array(962).fill("f"),
    followers: new Array(520).fill("r"),
    followingIds: new Array(962).fill("i"),
    followerIds: new Array(520).fill("d"),
    followingTotal: 962,
    followersTotal: 520,
    lastSyncAt: 1700000000000,
    selfUsername: "viewer",
    syncStatus: "ok"
  };
  const emptyTimeout = {};
  const kept = Sync.keepStorageSnapshot(emptyTimeout, disk);
  assert(kept.followersTotal === 520, "storage timeout keeps last disk snapshot");
  assert(Sync.hasFollowSnapshot(kept) === true, "timeout snapshot still has follow data");
  assert(
    Sync.showEmptyFollowBanner(kept) === false,
    "timeout must not show the red empty banner"
  );
  assert(Sync.displayFollowCount(kept.followersTotal, kept.followers) === 520, "paint stored total");
}

{
  assert(Sync.showEmptyFollowBanner({}) === true, "truly empty shows the banner");
  assert(
    Sync.showEmptyFollowBanner({ lastSyncAt: 1, following: [], followers: [] }) === false,
    "lastSyncAt alone is enough to skip the banner"
  );
  assert(
    Sync.showEmptyFollowBanner({ followingTotal: 0, followersTotal: 0 }) === false,
    "numeric totals of 0 still count as data"
  );
  assert(
    Sync.showEmptyFollowBanner({ followingIds: ["1"] }) === false,
    "IDs alone skip the banner"
  );
  assert(
    Sync.showEmptyFollowBanner({}, { syncing: true }) === false,
    "live sync hides the empty banner"
  );
}

{
  const painted = Sync.followSnapshot(
    {},
    {
      followingTotal: 965,
      followersTotal: 542,
      lastSyncAt: 99,
      following: ["a"],
      followers: ["b"]
    }
  );
  assert(painted.followersTotal === 542, "followSnapshot fills totals from fallback");
  assert(painted.lastSyncAt === 99, "followSnapshot keeps lastSyncAt");
  assert(Sync.asList(undefined).length === 0, "asList(undefined) is []");
  assert(Sync.asList([]).length === 0, "empty [] is not replaced");
}

{
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(__dirname, "../content/content.js"), "utf8");
  const railFn = content.slice(content.indexOf("async function refreshRailPanel"));
  const railBody = railFn.slice(0, railFn.indexOf("function isRailPanelOpen"));
  assert(
    !/catch\s*\([^)]*\)\s*\{\s*data = \{\}/.test(railBody),
    "refreshRailPanel catch must not assign data = {}"
  );
  assert(content.includes("lastFollowSnapshot || snapshotFromCache()"), "rail timeout uses last cache");
  assert(content.includes("verify_credentials"), "sync still hits verify_credentials for counts");
  const officialFn = content.slice(content.indexOf("async function fetchOfficialCounts"));
  assert(
    /graphqlFollow\(\s*gqlIds\.UserByScreenName/.test(officialFn.slice(0, 3000)),
    "UserByScreenName goes through page GraphQL"
  );
  assert(!/followerIds \|\| /.test(content), "content does not use arr || fallback for followerIds");
  assert(!content.includes("xfo-rail-listed"), "rail Followers/Following are one number");
  const setRail = content.slice(
    content.indexOf("function setRailCount"),
    content.indexOf("async function refreshRailPanel")
  );
  assert(
    /function setRailCount\(el, count\)/.test(setRail) && !setRail.includes("listed"),
    "setRailCount paints the official total only"
  );
  assert(
    /if \(followingEl\) setRailCount\(followingEl, followingCount\)/.test(content) &&
      /if \(followersEl\) setRailCount\(followersEl, followersCount\)/.test(content),
    "rail counts pass the official total, not an unlisted remainder"
  );

  // Every storage call outside the two wrappers and the rail's own
  // withTimeout must go through storageGet/storageSet (Safari can hang).
  const direct = content
    .split("\n")
    .map((line, i) => ({ line: line, n: i + 1 }))
    .filter((r) => /api\.storage\.local\.(get|set|remove)\(/.test(r.line))
    .filter((r) => !/withTimeout\(api\.storage\.local/.test(r.line));
  const inRail = direct.filter((r) => {
    const before = content.split("\n").slice(0, r.n).join("\n");
    const railStart = before.lastIndexOf("async function refreshRailPanel");
    const nextFn = before.lastIndexOf("\n  function isRailPanelOpen");
    return railStart !== -1 && railStart > nextFn;
  });
  const leftovers = direct.filter((r) => inRail.indexOf(r) === -1);
  assert(
    leftovers.length === 0,
    "untimed storage calls in content.js: " + leftovers.map((r) => r.n).join(",")
  );
  const sw = fs.readFileSync(path.join(__dirname, "../background/service-worker.js"), "utf8");
  assert(!/\bawait api\.storage\.local\./.test(sw), "service worker storage calls are wrapped in withTimeout");
  assert(!/storage\.local\.get\(null\)/.test(sw), "service worker never dumps the whole store");
}

console.log("All follow-totals tests passed.");
