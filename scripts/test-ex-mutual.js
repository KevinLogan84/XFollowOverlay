/**
 * Lost mutuals: sync delta, passive unfollow, persistence, and clears.
 * Run: node scripts/test-ex-mutual.js
 */
const fs = require("fs");
const path = require("path");
const Ex = require("../shared/ex-mutual.js");
const Passive = require("../shared/passive-relations.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const mutualPrev = {
  following: ["ada", "bob", "cara", "dan"],
  followers: ["ada", "cara", "dan", "erin"],
  followingIds: ["1", "2", "3", "4"],
  followerIds: ["1", "3", "4", "5"],
  selfUsername: "viewer",
  selfId: "9"
};
const lostNext = {
  following: ["ada", "bob", "cara", "viewer"],
  followers: ["cara", "erin", "viewer"],
  followingIds: ["1", "2", "3", "9"],
  followerIds: ["3", "5", "9"],
  idMap: { "1": "ada", "2": "bob", "3": "cara", "4": "dan", "9": "viewer" },
  selfUsername: "viewer",
  selfId: "9"
};

{
  const set = Ex.applySyncDelta(null, mutualPrev, lostNext);
  assert(Ex.has(set, "ada", null) && Ex.has(set, null, "1"), "sync delta marks a mutual who stopped following back");
  assert(set.handles.ada === "1" && set.ids["1"] === "ada", "idMap links the handle and rest id");
  assert(!Ex.has(set, "bob", "2"), "someone he followed who was never mutual stays unmarked");
  assert(!Ex.has(set, "cara", "3"), "a mutual who still follows back is not marked");
  assert(!Ex.has(set, "dan", "4"), "a mutual he unfollowed is not marked");
  assert(!Ex.has(set, "erin", "5"), "a follower he does not follow is not marked");
  assert(!Ex.has(set, "viewer", "9"), "the signed-in account is never marked");
  assert(
    Ex.paintClass(set, "following", "ada", "1").relation === "ex_mutual",
    "a stored lost mutual paints ex_mutual over plain following"
  );
  assert(
    Ex.paintClass(set, "following", "bob", "2").relation === "following",
    "never-mutual following stays following"
  );
}

{
  // The next sync still has them as following-only. The mark must survive
  // even though they are no longer in the previous followers set.
  let set = Ex.applySyncDelta(null, mutualPrev, lostNext);
  const still = {
    following: ["ada", "bob", "cara"],
    followers: ["cara", "erin"],
    followingIds: ["1", "2", "3"],
    followerIds: ["3", "5"],
    idMap: lostNext.idMap
  };
  set = Ex.applySyncDelta(set, lostNext, still);
  assert(Ex.has(set, "ada", "1"), "a later sync that still shows following-only keeps the red mark");

  const refollow = {
    following: ["ada", "bob", "cara"],
    followers: ["ada", "cara", "erin"],
    followingIds: ["1", "2", "3"],
    followerIds: ["1", "3", "5"],
    idMap: lostNext.idMap
  };
  set = Ex.applySyncDelta(set, still, refollow);
  assert(!Ex.has(set, "ada", "1"), "re-follow clears the red mark");

  set = Ex.applySyncDelta(null, mutualPrev, lostNext);
  const unfollowed = {
    following: ["bob", "cara"],
    followers: ["cara", "erin"],
    followingIds: ["2", "3"],
    followerIds: ["3", "5"],
    idMap: lostNext.idMap
  };
  set = Ex.applySyncDelta(set, lostNext, unfollowed);
  assert(!Ex.has(set, "ada", "1"), "unfollowing them clears the red mark");
}

{
  // Short follower pull: handles were rolled back to the previous snapshot
  // (ada still listed) while ids are the incomplete new page (ada absent).
  // That contradiction is not a re-follow.
  let set = Ex.applySyncDelta(null, mutualPrev, lostNext);
  const mixed = {
    following: ["ada", "bob", "cara"],
    followers: ["ada", "cara", "erin"],
    followingIds: ["1", "2", "3"],
    followerIds: ["3", "5"],
    idMap: lostNext.idMap,
    selfUsername: "viewer",
    selfId: "9"
  };
  set = Ex.applySyncDelta(set, lostNext, mixed);
  assert(Ex.has(set, "ada", "1"), "handle/id disagreement does not clear a lost mutual");
  assert(!Ex.has(set, "bob", "2"), "disagreement does not mint a new lost-mutual mark");

  // The same stale follower snapshot, handles and ids together, is what the
  // short-pull fallback saves. It must not count as "they followed back".
  set = Ex.applySyncDelta(null, mutualPrev, lostNext);
  const reused = {
    following: lostNext.following,
    followers: mutualPrev.followers,
    followingIds: lostNext.followingIds,
    followerIds: mutualPrev.followerIds,
    idMap: lostNext.idMap,
    selfUsername: "viewer",
    selfId: "9"
  };
  set = Ex.applySyncDelta(set, lostNext, reused, { trustFollowers: false });
  assert(Ex.has(set, "ada", "1"), "a reused follower snapshot keeps the red mark");
  assert(
    Ex.relationAfterReuse("mutual", set, "ada", "1", { followers: true }) === "following",
    "reused followers do not paint a stored lost mutual as mutual"
  );
  assert(
    Ex.relationAfterReuse("mutual", set, "cara", "3", { followers: true }) === "mutual",
    "reused followers still paint someone who is not a lost mutual"
  );

  const viewerLeft = {
    following: ["bob", "cara"],
    followers: mutualPrev.followers,
    followingIds: ["2", "3"],
    followerIds: mutualPrev.followerIds,
    idMap: lostNext.idMap,
    selfUsername: "viewer",
    selfId: "9"
  };
  set = Ex.applySyncDelta(set, lostNext, viewerLeft, { trustFollowers: false });
  assert(!Ex.has(set, "ada", "1"), "unfollowing still clears when followers were reused");

  set = Ex.applySyncDelta(null, mutualPrev, lostNext);
  const theyCameBack = {
    following: lostNext.following,
    followers: ["ada", "cara", "erin"],
    followingIds: lostNext.followingIds,
    followerIds: ["1", "3", "5"],
    idMap: lostNext.idMap,
    selfUsername: "viewer",
    selfId: "9"
  };
  set = Ex.applySyncDelta(set, lostNext, theyCameBack, { trustFollowing: false });
  assert(!Ex.has(set, "ada", "1"), "a refreshed follower list clears the mark even if following was reused");

  // Lookup miss: her id is a follower again, but the handle list never
  // hydrated her. The id is enough to clear. The inverse (handle says
  // follower, id does not) stays red and is covered above.
  set = Ex.applySyncDelta(null, mutualPrev, lostNext);
  set = Ex.applySyncDelta(set, lostNext, {
    following: ["bob", "cara"],
    followers: ["cara"],
    followingIds: ["1", "2", "3"],
    followerIds: ["1", "3"],
    idMap: lostNext.idMap,
    selfUsername: "viewer",
    selfId: "9"
  });
  assert(!Ex.has(set, "ada", "1"), "an id that is a follower again clears even if the handle was not hydrated");
}

{
  // Id-only lists (handles not hydrated) still detect the loss.
  const set = Ex.applySyncDelta(
    null,
    { followingIds: ["11", "22"], followerIds: ["11", "33"] },
    { followingIds: ["11", "22"], followerIds: ["33"], idMap: { "11": "ada", "22": "bob" } }
  );
  assert(Ex.has(set, "ada", "11"), "id-only delta marks the lost mutual and keeps the handle");
  assert(!Ex.has(set, "bob", "22"), "id-only never-mutual following stays unmarked");
}

{
  const seeded = Ex.createSet(null);
  Ex.remember(seeded, "zoe", "77");
  const kept = Ex.applySyncDelta(
    seeded,
    { following: ["zoe"], followers: ["zoe"] },
    { following: [], followers: [], followingIds: [], followerIds: [] }
  );
  assert(Ex.has(kept, "zoe", "77"), "an empty replace does not wipe or mass-mark");
  const untouched = Ex.applySyncDelta(
    seeded,
    { following: ["ada", "zoe"], followers: ["ada", "zoe"], followingIds: ["1"], followerIds: ["1"] },
    { following: ["ada", "zoe"], followers: [] }
  );
  assert(
    Ex.has(untouched, "zoe", "77") && !Ex.has(untouched, "ada", null),
    "a missing followers side does not paint every mutual red"
  );
}

{
  const raw = JSON.parse(JSON.stringify(Ex.serialize(Ex.applySyncDelta(null, mutualPrev, lostNext))));
  assert(raw.v === Ex.STORE_VERSION && raw.handles.ada === "1", "serialize keeps the linked pair");
  const reloaded = Ex.createSet(raw);
  assert(Ex.has(reloaded, "Ada", "1"), "reload restores the mark, handle lookup is case-insensitive");
  Ex.remember(reloaded, "solo", null);
  const solo = Ex.createSet(JSON.parse(JSON.stringify(Ex.serialize(reloaded))));
  assert(solo.handles.solo === true && Ex.has(solo, "solo", null), "an unlinked handle survives reload");
  assert(solo.ids["1"] === "ada", "the presence flag is not treated as rest id 1");
  const live = Ex.createSet(null);
  Ex.remember(live, "ned", "8");
  const merged = Ex.union(reloaded, live);
  assert(Ex.has(merged, "ada", "1") && Ex.has(merged, "ned", "8"), "union keeps storage and in-memory marks");
  assert(Ex.createSet(null).handles && !Ex.has(Ex.createSet("nope"), "ada", "1"), "bad storage is an empty set");
}

{
  const M = Passive.mergeRelationship;
  assert(
    M("mutual", { following: null, followedBy: false }) === Ex.CLASS,
    "passive they-unfollowed from mutual → ex_mutual"
  );
  assert(
    M("mutual", { following: true, followedBy: false }) === "ex_mutual",
    "explicit followedBy false from mutual → ex_mutual"
  );
  assert(
    M("following", { following: null, followedBy: false }) === "following",
    "passive unfollow of a never-mutual stays following"
  );
  assert(M("mutual", { following: false, followedBy: null }) === "follower", "viewer unfollow stays follower");
  assert(M("mutual", { following: false, followedBy: false }) === "neither", "both directions gone → neither");
  assert(M("mutual", { following: null, followedBy: true }) === "mutual", "still mutual when they follow");

  const set = Ex.createSet(null);
  const marked = Ex.paintClass(set, M("mutual", { following: null, followedBy: false }), "ada", "1");
  assert(marked.relation === "ex_mutual" && marked.changed && Ex.has(set, "ada", "1"), "passive loss is stored");
  const again = Ex.paintClass(set, "ex_mutual", "ada", "1");
  assert(!again.changed, "remembering the same account twice is not a new write");

  // After the next sync the passive sighting agrees with "following" and is
  // dropped. The stored set is what keeps the dot red.
  const sighting = { h: "ada", f: true, b: false, t: 5 };
  assert(Passive.agreesWithSync(sighting, "following", 0), "followedBy false agrees with synced following");
  assert(
    Ex.paintClass(set, "following", "ada", "1").relation === "ex_mutual",
    "once stored, plain following still paints red"
  );

  const back = Ex.paintClass(set, "mutual", "ada", "1");
  assert(back.relation === "mutual" && back.changed && !Ex.has(set, "ada", "1"), "re-follow clears the stored mark");

  Ex.remember(set, "ada", "1");
  const viewerLeft = Ex.paintClass(set, "follower", "ada", "1");
  assert(viewerLeft.relation === "follower" && !Ex.has(set, "ada", null), "viewer unfollow clears the stored mark");

  Ex.remember(set, "ada", "1");
  const gone = Ex.paintClass(set, "neither", "@Ada", "1");
  assert(gone.relation === "neither" && !Ex.has(set, "ada", "1"), "neither clears the stored mark");

  Ex.remember(set, "ada", "1");
  const held = Ex.paintClass(set, "mutual", "ada", "1", { allowClear: false });
  assert(held.relation === "mutual" && Ex.has(set, "ada", "1"), "clears wait until the set is hydrated");
}

{
  const root = path.join(__dirname, "..");
  const content = fs.readFileSync(path.join(root, "content/content.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "content/styles.css"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const install = fs.readFileSync(path.join(root, "scripts/install-macos.sh"), "utf8");
  assert(Ex.CLASS === "ex_mutual", "class name is ex_mutual");
  assert(content.includes('ex_mutual: "#ff3b30"'), "avatar dot uses bright red #ff3b30");
  assert(content.includes('following: "#1d9bf0"'), "never-mutual following stays Twitter blue");
  assert(content.includes('ex_mutual: "Was mutual"'), "legend label is Was mutual");
  assert(content.includes("Was mutual"), "rail legend spells out Was mutual");
  assert(content.includes("ExMutual.applySyncDelta"), "sync replace updates the lost-mutual set");
  assert(content.includes("trustFollowers: !result.followersReused"), "a reused follower list is not a re-follow");
  assert(content.includes("relationAfterReuse"), "classify does not paint reused followers as mutual");
  assert(content.includes("followListReuse"), "reuse is persisted so the next paint keeps the red dot");
  assert(
    content.includes("followingIds = uniqueIdsList(asList(stored.followingIds))") &&
      content.includes("followerIds = uniqueIdsList(asList(stored.followerIds))"),
    "a reused side keeps its previous ids with its previous handles"
  );
  assert(content.includes("ExMutual.paintClass"), "classify paints through the shared helper");
  assert(content.includes("exMutuals"), "the red set is persisted");
  const throwAt = content.indexOf("if (!followingOk || !followersOk)");
  const deltaAt = content.indexOf("ExMutual.applySyncDelta");
  assert(throwAt !== -1 && deltaAt > throwAt, "lost-mutual delta runs only after a complete replace");
  assert(!/fetch\(/.test(fs.readFileSync(path.join(root, "shared/ex-mutual.js"), "utf8")), "detector makes no requests");
  assert(/--dot-ex-mutual:\s*#ff3b30/.test(css), "legend token is #ff3b30 in light");
  assert(/--dot-ex-mutual:\s*#ff453a/.test(css), "legend token is #ff453a in dark");
  assert(/\.xfo-rail-leg \.x\s*\{[\s\S]*?background:\s*var\(--dot-ex-mutual\)/.test(css), "legend mark is a filled circle");
  const js = manifest.content_scripts.find((s) => (s.js || []).includes("content/content.js")).js;
  assert(
    js.indexOf("shared/ex-mutual.js") !== -1 && js.indexOf("shared/ex-mutual.js") < js.indexOf("content/content.js"),
    "ex-mutual.js loads before content.js"
  );
  assert(manifest.version === "1.2.12", "manifest is 1.2.12");
  assert(/MARKETING_VERSION=1\.2\.12/.test(install), "install marketing version is 1.2.12");
  assert(/CURRENT_PROJECT_VERSION=157/.test(install), "install project version is 157");
}

console.log("All ex-mutual tests passed.");
