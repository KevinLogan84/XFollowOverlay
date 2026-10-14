/**
 * Repeat free syncs stop after 20 known accounts in a row, and a full
 * reconcile still runs on the 24 hour, 5th sync, and count-mismatch rules.
 * Run: node scripts/test-incremental-sync.js
 */
const fs = require("fs");
const path = require("path");
const Inc = require("../shared/incremental-sync.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(Inc.KNOWN_STREAK_STOP === 20, "incremental sync stops after 20 known accounts");
assert(Inc.FULL_RECONCILE_EVERY === 5, "every 5th free sync is a full reconcile");
assert(Inc.FULL_RECONCILE_MS === 24 * 60 * 60 * 1000, "a full reconcile runs every 24 hours");

const known = [];
for (let i = 0; i < 30; i++) known.push("known" + i);

{
  const page = ["new-a", "new-b"].concat(known.slice(0, 20)).concat(["new-c"]);
  const scan = Inc.takeIncremental(page, known, []);
  assert(scan.stopped === true, "20 known accounts in a row stop the walk");
  assert(
    scan.added.map((account) => account.handle).join(",") === "new-a,new-b",
    "new accounts before the streak are kept"
  );
  assert(
    !scan.added.some((account) => account.handle === "new-c"),
    "accounts after the stop are not added"
  );
  const merged = Inc.mergeNewestFirst(known, scan.added, "handle");
  assert(merged[0] === "new-a" && merged[1] === "new-b", "new accounts stay newest-first");
  assert(merged.length === known.length + 2, "older accounts stay in the list");
  assert(merged[merged.length - 1] === "known29", "the stored tail is kept");
}

{
  const accounts = known.slice(0, 19).concat(["new-z"]).concat(known.slice(0, 20)).concat(["too-late"]);
  const scan = Inc.takeIncremental(accounts, known, []);
  assert(scan.stopped === true, "the streak reaches 20 after a new account resets it");
  assert(scan.added.map((account) => account.handle).join(",") === "new-z", "the reset account is kept");
  assert(scan.knownStreak === 20, "the stop lands on the 20th known account");
}

{
  const scan = Inc.takeIncremental(known.slice(0, 19), known, []);
  assert(scan.stopped === false, "19 known accounts in a row do not stop");
  assert(scan.knownStreak === 19, "the streak is the run of known accounts");
  assert(scan.added.length === 0, "known accounts are not added again");
}

{
  const state = Inc.takeIncremental(known.slice(0, 15), known, []);
  assert(state.stopped === false && state.knownStreak === 15, "a short page keeps the streak");
  Inc.takeIncremental(known.slice(15, 25), known, [], state);
  assert(state.stopped === true, "the streak continues onto the next page");
  assert(state.knownStreak === 20, "the next page stops at 20 known accounts");
  assert(state.scanned === 20, "the walk does not read past the stop");
}

{
  const knownIds = new Set(["10", "11"]);
  const scan = Inc.takeIncremental(
    [
      { handle: "ada", id: "1" },
      { handle: "bob", id: "10" },
      { handle: "cy", id: "11" }
    ],
    [],
    knownIds
  );
  assert(scan.added.length === 1 && scan.added[0].handle === "ada", "a known id counts as known");
  assert(scan.knownStreak === 2, "known ids continue the streak");
}

{
  const hour = 60 * 60 * 1000;
  const now = Date.UTC(2026, 9, 14);
  const steady = {
    hadFullSync: true,
    lastFullSyncAt: now - 23 * hour,
    now: now,
    freeSyncCount: 2,
    profileFollowing: 10,
    profileFollowers: 4,
    storedFollowing: 10,
    storedFollowers: 4
  };
  assert(Inc.needsFullReconcile({ hadFullSync: false, now: now }) === true, "the first sync is a full reconcile");
  assert(Inc.needsFullReconcile(steady) === false, "a recent matching sync stays incremental");
  assert(
    Inc.needsFullReconcile(Object.assign({}, steady, { lastFullSyncAt: now - 24 * hour })) === true,
    "24 hours since the last full reconcile starts another"
  );
  assert(
    Inc.needsFullReconcile(Object.assign({}, steady, { freeSyncCount: 5 })) === true,
    "every 5th free sync is a full reconcile"
  );
  assert(
    Inc.needsFullReconcile(Object.assign({}, steady, { freeSyncCount: 4 })) === false,
    "the 4th free sync can stay incremental"
  );
  assert(
    Inc.needsFullReconcile(Object.assign({}, steady, { profileFollowing: 9, profileFollowers: 99 })) === false,
    "a follower change does not force both sides into a full walk"
  );
  assert(
    Inc.needsFullReconcile(Object.assign({}, steady, { hasCheckpoint: true })) === true,
    "a leftover full-sync checkpoint is resumed instead of ignored"
  );
  assert(
    Inc.sideNeedsFullReconcile({ profileCount: null, merged: ["a"] }) === true,
    "a side whose profile count cannot be read is fully reconciled"
  );
  assert(
    Inc.sideNeedsFullReconcile({ profileCount: 100, merged: new Array(100) }) === false,
    "a merged list that matches the profile stays incremental"
  );
  assert(
    Inc.sideNeedsFullReconcile({ profileCount: 101, merged: new Array(101) }) === false,
    "one new follower does not force that side into a full walk"
  );
  const hundred = [];
  for (let n = 0; n < 100; n++) hundred.push("acct" + n);
  const swapped = ["new1"].concat(hundred);
  assert(swapped.length === 101, "a swap adds the new account and keeps the unfollowed one");
  assert(
    Inc.sideNeedsFullReconcile({ profileCount: 100, merged: swapped }) === true,
    "a merged list longer than the profile count catches a swap"
  );
  assert(
    Inc.sideNeedsFullReconcile({ profileCount: 100, merged: new Array(100), mergedIds: new Array(101) }) === true,
    "an id list longer than the profile count catches a swap"
  );
  assert(
    Inc.sideNeedsFullReconcile({ profileCount: 100, merged: swapped }) === true &&
      Inc.sideNeedsFullReconcile({ profileCount: 40, merged: new Array(40) }) === false,
    "a swap on one side leaves the other side incremental"
  );
}

{
  const handles = [];
  const ids = [];
  const idMap = {};
  for (let i = 0; i < 100; i++) {
    handles.push("u" + i);
    ids.push(String(i));
    idMap[String(i)] = "u" + i;
  }
  const page = [{ handle: "new1", id: "900" }].concat(
    handles.slice(0, 20).map((handle, index) => ({ handle: handle, id: String(index) }))
  );
  page[5] = { handle: "renamed", id: "4" };
  const scan = Inc.takeIncremental(page, handles, ids);
  assert(scan.added.map((account) => account.handle).join(",") === "new1", "the new account is added");
  assert(
    scan.renames.length === 1 && scan.renames[0].id === "4" && scan.renames[0].handle === "renamed",
    "a known id with a new handle is a rename, not a new account"
  );
  const merged = Inc.mergeNewestFirst(handles, scan.added, "handle");
  assert(merged.length === 101 && merged.indexOf("u4") !== -1, "the swap still holds the old handle before refresh");
  const refreshed = Inc.refreshHandles(merged, scan.renames, idMap);
  assert(refreshed.indexOf("u4") === -1, "the old handle is replaced");
  assert(refreshed.indexOf("renamed") !== -1, "the new handle is stored");
  assert(idMap["4"] === "renamed", "the id map points at the new handle");
  assert(
    Inc.sideNeedsFullReconcile({ profileCount: 100, merged: refreshed }) === true,
    "the swap is still longer than the profile after the rename"
  );
}

{
  const content = fs.readFileSync(path.join(__dirname, "../content/content.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  assert(content.includes("takeIncremental"), "free sync uses the incremental stop rule");
  assert(content.includes("needsFullReconcile"), "free sync asks when a full reconcile is due");
  assert(content.includes("mergeNewestFirst"), "new accounts are merged onto the stored list");
  assert(content.includes("sideNeedsFullReconcile"), "each side checks its merged length against the profile count");
  assert(content.includes("reconcileFollowSide"), "a long merged list full-reconciles that side in the same run");
  assert(
    content.indexOf('reconcileFollowSide(\n      "Following"') !== -1 &&
      content.indexOf('reconcileFollowSide(\n      "Followers"') !== -1,
    "following and followers are reconciled separately"
  );
  assert(content.includes("refreshHandles"), "incremental runs replace a handle when the id matches");
  assert(content.includes("bothListsFetched"), "the full-sync timestamp waits until both lists were fetched");
  assert(
    /lastFullSyncAt:[\s\S]{0,280}!followingReused &&[\s\S]{0,120}!followersReused/.test(content),
    "lastFullSyncAt is set only when both lists were fetched"
  );
  assert(content.includes("restoreCheckpoint"), "an incremental sync can put a resume point back");
  assert(
    /if \(result\.bothListsFetched\) \{\s*passiveStore = Passive\.prune\(passiveStore, \{ before: startedAt \}\)/.test(
      content
    ),
    "observed unfollows are discarded only after a full or API sync"
  );
  assert(
    content.includes("if (result.restoreCheckpoint) saved.syncCheckpoint = result.restoreCheckpoint"),
    "an incremental sync does not clear a full sync resume point"
  );
  assert(content.includes("xApiBearer"), "bearer storage stays xApiBearer");
  assert(content.includes("following:"), "follow lists stay on the following storage key");
  const js = manifest.content_scripts.find((script) => (script.js || []).includes("content/content.js")).js;
  assert(
    js.indexOf("shared/incremental-sync.js") !== -1 &&
      js.indexOf("shared/incremental-sync.js") < js.indexOf("content/content.js"),
    "incremental-sync.js loads before content.js"
  );
}

console.log("All incremental sync tests passed.");
