/**
 * Passive relations: store, ingest, layering over the synced lists, prune.
 * Run: node scripts/test-passive-relations.js
 */
const Passive = require("../shared/passive-relations.js");
const Identity = require("../shared/sync-identity.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const T0 = 1_800_000_000_000;

{
  const store = Passive.createStore(null);
  assert(Passive.size(store) === 0, "empty store");
  const res = Passive.ingest(
    store,
    [
      { id: "11", h: "Ada", f: true, b: true },
      { id: "22", h: "bob", f: false, b: true },
      { id: "33", h: "cyd", f: null, b: null },
      { id: "abc", h: "bad", f: true, b: true },
      { id: "44", h: null, f: true, b: null }
    ],
    { now: T0 }
  );
  assert(Passive.size(store) === 3, "unknown flags and non-numeric ids are not stored");
  assert(res.changed.join(",") === "11,22,44", "new observations are changes");
  assert(
    res.idPairs.length === 3 && res.idPairs[0].handle === "ada",
    "every id→handle pair is returned lowercased, handle-less ids skipped"
  );
  assert(Passive.lookup(store, "ADA", null).f === true, "lookup by handle is case-insensitive");
  assert(Passive.lookup(store, null, "22").b === true, "lookup by id");
  assert(Passive.lookup(store, "nobody", "99") === null, "miss is null");
}

{
  const store = Passive.createStore(null);
  Passive.ingest(store, [{ id: "11", h: "ada", f: true, b: true }], { now: T0 });
  const again = Passive.ingest(store, [{ id: "11", h: "ada", f: true, b: true }], {
    now: T0 + 10
  });
  assert(again.changed.length === 0, "same flags again is not a change");
  const partial = Passive.ingest(store, [{ id: "11", h: "ada", f: null, b: false }], {
    now: T0 + 20
  });
  assert(partial.changed.join(",") === "11", "followed_by flipped is a change");
  const e = Passive.lookup(store, "ada", null);
  assert(e.f === true && e.b === false && e.t === T0 + 20, "unknown direction keeps the old value");
  const renamed = Passive.ingest(store, [{ id: "11", h: "ada_new", f: true, b: false }], {
    now: T0 + 30
  });
  assert(renamed.changed.length === 0, "a rename alone is not a relationship change");
  assert(Passive.lookup(store, "ada_new", null).h === "ada_new", "new handle indexes the entry");
  assert(Passive.lookup(store, "ada", null) === null, "old handle is released");
}

{
  // Self is never stored.
  const store = Passive.createStore(null);
  const res = Passive.ingest(
    store,
    [
      { id: "1", h: "Viewer", f: false, b: false },
      { id: "2", h: "other", f: true, b: false }
    ],
    { now: T0, selfHandle: "viewer" }
  );
  assert(Passive.size(store) === 1 && res.changed.join(",") === "2", "self handle skipped");
  Passive.ingest(store, [{ id: "7", h: "me", f: false, b: false }], { now: T0, selfId: "7" });
  assert(Passive.lookup(store, null, "7") === null, "self id skipped");
}

{
  // relationFor only speaks for observations newer than the last sync.
  const store = Passive.createStore(null);
  Passive.ingest(store, [{ id: "11", h: "ada", f: true, b: null }], { now: T0 });
  assert(Passive.relationFor(store, "ada", null, T0 - 1).following === true, "newer than sync");
  assert(Passive.relationFor(store, "ada", null, T0) === null, "same instant as sync is superseded");
  assert(Passive.relationFor(store, "ada", null, T0 + 1) === null, "older than sync is superseded");
  assert(Passive.relationFor(store, "ada", null, null).following === true, "no sync yet: observation counts");
  const rel = Passive.relationFor(store, "ada", null, 0);
  assert(rel.followedBy === null, "unknown direction stays null");
}

{
  // mergeRelationship layers directions over the synced verdict.
  const M = Passive.mergeRelationship;
  assert(M("neither", { following: true, followedBy: null }) === "following", "you follow → following");
  assert(M("neither", { following: null, followedBy: true }) === "follower", "they follow → follower");
  assert(M("following", { following: null, followedBy: true }) === "mutual", "synced following + new follower → mutual");
  assert(M("mutual", { following: false, followedBy: null }) === "follower", "you unfollowed → follower");
  assert(M("mutual", { following: null, followedBy: false }) === "ex_mutual", "they unfollowed from mutual → ex_mutual");
  assert(M("mutual", { following: true, followedBy: false }) === "ex_mutual", "explicit they-unfollowed from mutual → ex_mutual");
  assert(M("following", { following: null, followedBy: false }) === "following", "never-mutual unfollow stays following");
  assert(M("follower", { following: false, followedBy: false }) === "neither", "both false → neither");
  assert(M("mutual", null) === "mutual", "no observation keeps the synced verdict");
  assert(M("self", { following: true, followedBy: true }) === "self", "self is never re-labelled");
  assert(M("unknown", { following: true, followedBy: true }) === "unknown", "unknown stays unknown");
}

{
  // End-to-end with the synced classifier: new follower appears in a
  // notification before the next sync.
  const sets = {
    selfUsername: "viewer",
    following: new Set(["ada"]),
    followers: new Set([]),
    followingIds: new Set(["11"]),
    followerIds: new Set([])
  };
  const store = Passive.createStore(null);
  Passive.ingest(store, [{ id: "11", h: "ada", f: true, b: true }], { now: T0 + 5000 });
  const base = Identity.classifyFollow("ada", "11", sets);
  assert(base === "following", "synced lists say following");
  const rel = Passive.relationFor(store, "ada", "11", T0);
  assert(Passive.mergeRelationship(base, rel) === "mutual", "passive followed_by upgrades to mutual");
  assert(Identity.classifyFollow("viewer", null, sets) === "self", "self stays self");
}

{
  // A follow click is pinned against X's eventually consistent payloads.
  const store = Passive.createStore(null);
  Passive.ingest(store, [{ id: "11", h: "ada", f: true, b: null }], { now: T0, action: true });
  assert(Passive.lookup(store, "ada", null).a === 1, "action entries are marked");
  const stale = Passive.ingest(store, [{ id: "11", h: "ada", f: false, b: true }], {
    now: T0 + 30_000
  });
  const e = Passive.lookup(store, "ada", null);
  assert(e.f === true, "a stale following:false within the pin window is ignored");
  assert(e.b === true, "the other direction still updates");
  assert(stale.changed.join(",") === "11", "followed_by update is reported as a change");
  Passive.ingest(store, [{ id: "11", h: "ada", f: false, b: true }], {
    now: T0 + Passive.ACTION_PIN_MS + 1
  });
  assert(Passive.lookup(store, "ada", null).f === false, "after the pin window X's word wins again");
  Passive.ingest(store, [{ id: "11", h: "ada", f: false, b: null }], {
    now: T0 + Passive.ACTION_PIN_MS + 2,
    action: true
  });
  assert(Passive.lookup(store, "ada", null).f === false, "unfollow click records following:false");
  assert(Passive.ACTION_PIN_MS === 5 * 60 * 1000, "pin window is five minutes");
}

{
  // Persistence round trip and merge with the in-memory copy.
  const store = Passive.createStore(null);
  Passive.ingest(store, [{ id: "11", h: "ada", f: true, b: true }], { now: T0 });
  Passive.ingest(store, [{ id: "22", h: "bob", f: false, b: true }], { now: T0 + 1 });
  const raw = JSON.parse(JSON.stringify(Passive.serialize(store)));
  assert(raw.v === Passive.STORE_VERSION && Object.keys(raw.byId).length === 2, "serialized shape");
  const reloaded = Passive.createStore(raw);
  assert(Passive.lookup(reloaded, "bob", null).b === true, "reload restores entries");
  assert(reloaded.byHandle.ada === "11", "reload rebuilds the handle index");

  const live = Passive.createStore(null);
  Passive.ingest(live, [{ id: "11", h: "ada", f: false, b: false }], { now: T0 + 500 });
  const merged = Passive.createStore(raw, live);
  assert(Passive.lookup(merged, "ada", null).f === false, "newer in-memory entry survives a storage reload");
  assert(Passive.lookup(merged, "bob", null).b === true, "storage-only entries are kept");

  const junk = Passive.createStore({ byId: { x: { f: true, t: T0 }, "5": { f: "yes", t: T0 }, "6": { f: true } } });
  assert(Passive.size(junk) === 0, "bad ids, non-boolean flags and missing timestamps are dropped");
  assert(Passive.size(Passive.createStore("nope")) === 0, "non-object storage is an empty store");
}

{
  // Prune: a finished sync supersedes older observations; cap by recency.
  const store = Passive.createStore(null);
  for (let i = 1; i <= 10; i++) {
    Passive.ingest(store, [{ id: String(i), h: "u" + i, f: true, b: null }], { now: T0 + i });
  }
  const afterSync = Passive.prune(store, { before: T0 + 5 });
  assert(Passive.size(afterSync) === 5, "observations at or before the sync start are dropped");
  assert(Passive.lookup(afterSync, "u6", null) && !Passive.lookup(afterSync, "u5", null), "newer ones stay");
  const capped = Passive.prune(store, { max: 3 });
  assert(Passive.size(capped) === 3, "cap keeps at most max entries");
  assert(
    Passive.lookup(capped, "u10", null) && Passive.lookup(capped, "u8", null) && !Passive.lookup(capped, "u7", null),
    "cap keeps the newest"
  );
  assert(capped.byHandle.u10 === "10" && !capped.byHandle.u1, "handle index follows the prune");
  assert(Passive.MAX_ENTRIES === 4000, "default cap is 4000 accounts");
  const pairs = Passive.idPairs(capped);
  assert(pairs.length === 3 && pairs.every((p) => p.id && p.handle), "idPairs feeds mergeIdMap");
}

{
  // Oversized batches are truncated, not rejected.
  const store = Passive.createStore(null);
  const big = [];
  for (let i = 0; i < Passive.MAX_BATCH + 50; i++) big.push({ id: String(i + 1), h: "h" + i, f: true, b: false });
  Passive.ingest(store, big, { now: T0 });
  assert(Passive.size(store) === Passive.MAX_BATCH, "batch is capped at MAX_BATCH");
  Passive.ingest(store, "not-an-array", { now: T0 });
  assert(Passive.size(store) === Passive.MAX_BATCH, "non-array payload is ignored");
}

// v1.1.28 — observations that only confirm the sync are not stored, so the
// 4000-entry cap holds changes since the sync instead of daily churn.
{
  const synced = { "1": "mutual", "2": "following", "3": "neither" };
  const syncedFn = (id) => synced[id] || null;
  const store = Passive.createStore(null);
  const r = Passive.ingest(
    store,
    [
      { id: "1", h: "same", f: true, b: true },
      { id: "2", h: "newfan", f: true, b: true },
      { id: "3", h: "halfknown", f: false, b: null },
      { id: "4", h: "unsynced", f: true, b: false }
    ],
    { now: T0, synced: syncedFn }
  );
  assert(!Passive.lookup(store, "same", "1"), "a sighting that matches the sync is not stored");
  assert(Passive.lookup(store, "newfan", "2").b === true, "a new follower since the sync is stored");
  assert(!Passive.lookup(store, "halfknown", "3"), "a partial sighting that agrees on what it knows is not stored");
  assert(Passive.lookup(store, "unsynced", "4"), "accounts the sync has no answer for are stored");
  assert(!r.changed.includes("1") && r.changed.includes("2"), "only real changes are reported");

  // The account reverts to what the sync said: the stale override goes away.
  const back = Passive.ingest(store, [{ id: "2", h: "newfan", f: true, b: false }], {
    now: T0 + 1000,
    synced: syncedFn
  });
  assert(!Passive.lookup(store, "newfan", "2"), "a reverted relation clears its override");
  assert(back.changed.includes("2"), "clearing an override repaints the badge");

  // A just-made follow is pinned even when it matches the sync, so a lagging
  // X response cannot flip the badge back.
  Passive.ingest(store, [{ id: "5", h: "clicked", f: true }], {
    now: T0,
    action: true,
    synced: () => "following"
  });
  assert(Passive.lookup(store, "clicked", "5"), "a pinned follow/unfollow survives agreement");

  // Existing stores from older builds are swept on load.
  const legacy = Passive.createStore(null);
  Passive.ingest(
    legacy,
    [
      { id: "1", h: "same", f: true, b: true },
      { id: "2", h: "newfan", f: true, b: true }
    ],
    { now: T0 }
  );
  const dropped = Passive.dropAgreeing(legacy, syncedFn, T0 + ACTION_GAP());
  assert(dropped === 1 && Passive.size(legacy) === 1, "dropAgreeing removes only redundant entries");
  assert(!Passive.lookup(legacy, "same", null), "the handle index is cleaned too");
  assert(Passive.dropAgreeing(legacy, null, T0) === 0, "no sync answer means nothing is dropped");
}

function ACTION_GAP() {
  return Passive.ACTION_PIN_MS + 1;
}

console.log("All passive-relations tests passed.");
