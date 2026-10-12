/**
 * REST follow-graph helpers: request counts, cache reuse, 429 wait-and-resume.
 * Run: node scripts/test-follow-rest.js
 */
const Identity = require("../shared/sync-identity.js");
const Rest = require("../shared/follow-rest.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const dry = Rest.estimateRestSyncRequests(960, 540);
{
  assert(dry.idPages === 2, "960/540 needs 2 ID-list pages");
  assert(dry.lookups === 15, "worst-case unique 1493 needs 15 lookups");
  assert(dry.total === 17, "first sync is 2 id pages + 15 lookups");
  assert(dry.total < 25, "REST stays a handful of calls");
  assert(dry.graphqlPagesAt50 === 31, "GraphQL count 50 is ~31 pages");
  assert(dry.total < dry.graphqlPagesAt50, "REST is far cheaper than GQL-50");
}

{
  const warm = Rest.estimateRestSyncRequests(960, 540, { uniqueCount: 1093, cachedCount: 1093 });
  assert(warm.idPages === 2, "warm refresh still lists ids");
  assert(warm.lookups === 0, "cached handles skip lookup");
  assert(warm.total === 2, "typical refresh is two ID-list calls");
}

{
  assert(
    Rest.preferredListTotal(542, new Array(542), new Array(520)) === 542,
    "rail total uses X's public count over hydrated handles"
  );
  assert(
    Rest.preferredListTotal(null, new Array(542), new Array(520)) === 542,
    "without official counts, ID membership is the total"
  );
  assert(
    Rest.preferredListTotal(null, [], new Array(520)) === 520,
    "handle length is last resort"
  );
  assert(
    Rest.preferredListTotal(542, new Array(521), new Array(521)) === 542,
    "official 542 wins over rest-list 521"
  );
  assert(
    Rest.preferredListTotal(null, new Array(521), new Array(521), 542) === 542,
    "missing official this run keeps a higher stored profile count"
  );
  assert(
    Rest.preferredListTotal(null, new Array(521), new Array(521), 520) === 521,
    "stored handle-length 520 does not beat a longer ID list"
  );
  assert(
    Rest.countsFromRestUser({ friends_count: 962, followers_count: 542 }).followers ===
      542,
    "users/show payload carries the public follower count"
  );
  assert(
    Rest.asList(undefined).length === 0 && Rest.asList([]).length === 0,
    "asList never uses || so empty [] stays empty"
  );
}

{
  const map = Rest.mergeIdMap({ "1": "old" }, [
    { id: "2", handle: "NewUser" },
    { id: "1", handle: "renamed" }
  ]);
  assert(map["2"] === "newuser", "lookup pairs fold into the id map");
  assert(map["1"] === "renamed", "renames overwrite the cache");
  const need = Rest.idsNeedingLookup(["1", "2", "3", "2"], map);
  assert(need.join(",") === "3", "only unknown ids are looked up");
  const handles = Rest.handlesFromIds(["2", "1", "9"], map);
  assert(handles.join(",") === "newuser,renamed", "hydrate preserves list order, skips missing");
  const pruned = Rest.pruneIdMap(map, ["2"]);
  assert(!pruned["1"] && pruned["2"] === "newuser", "prune drops ids no longer on either list");
}

{
  const now = 1_700_000_000_000;
  assert(
    Rest.waitMsFromRateLimitHeaders({ "retry-after": "12" }, now) === 12000,
    "Retry-After seconds"
  );
  assert(
    Rest.waitMsFromRateLimitHeaders({ retryAfter: "2" }, now) === 2000,
    "retryAfter alias"
  );
  const resetSec = Math.floor((now + 45000) / 1000);
  const fromReset = Rest.waitMsFromRateLimitHeaders(
    { "x-rate-limit-reset": String(resetSec) },
    now
  );
  assert(fromReset >= 45000 && fromReset <= 46000, "x-rate-limit-reset unix seconds");
  assert(
    Rest.waitMsFromRateLimitHeaders({}, now) === Rest.DEFAULT_429_WAIT_MS,
    "missing headers use the default wait"
  );
  assert(
    Rest.waitMsFromRateLimitHeaders({ "retry-after": "99999" }, now) ===
      Rest.MAX_429_WAIT_MS,
    "wait is capped"
  );
}

{
  assert(Rest.isRestUnavailableStatus(403) === true, "403 is dead REST");
  assert(Rest.isRestUnavailableStatus(410) === true, "410 is dead REST");
  assert(Rest.isRestUnavailableStatus(404) === true, "404 is dead REST");
  assert(Rest.isRestUnavailableStatus(429) === false, "429 is not dead REST");
  assert(Rest.isRestUnavailableStatus(401) === false, "401 is session, not dead REST");
  const err = Rest.httpError(403, "forbidden");
  assert(Rest.isRestUnavailable(err) === true, "403 error is unavailable");
  assert(Rest.canTryNextRestPath(err) === true, "403 falls through to list/v2");
}

function mockClient(handler) {
  const calls = [];
  return {
    calls: calls,
    waits: 0,
    async request(path, params) {
      calls.push({ path: path, params: params || {} });
      return handler(path, params || {}, calls.length);
    },
    async wait() {
      this.waits += 1;
    },
    noteProgress() {},
    throwIfAborted() {}
  };
}

(async () => {
  const followingIds = [];
  for (let i = 1; i <= 960; i++) followingIds.push(String(i));
  const followerIds = [];
  for (let i = 554; i <= 1093; i++) followerIds.push(String(i));

  const cached = {};
  followingIds.concat(followerIds).forEach((id) => {
    cached[id] = "u" + id;
  });
  cached["999999"] = "stale";

  const warmClient = mockClient((path) => {
    if (path === Rest.IDS_FOLLOWING) {
      return { ok: true, status: 200, json: { ids: followingIds, next_cursor: 0 } };
    }
    if (path === Rest.IDS_FOLLOWERS) {
      return { ok: true, status: 200, json: { ids: followerIds, next_cursor: 0 } };
    }
    throw new Error("unexpected " + path);
  });
  const warm = await Rest.collectViaIds(warmClient, {
    screenName: "viewer",
    userId: "42",
    idMap: cached
  });
  assert(warm.path === "rest-ids", "warm path is rest-ids");
  assert(warmClient.calls.length === 2, "warm refresh is 2 ID-list calls");
  assert(warm.following.length === 960, "warm following hydrates from cache");
  assert(warm.followers.length === 540, "warm followers hydrates from cache");
  assert(!warm.idMap["999999"], "stale ids are pruned");

  let lookups = 0;
  const coldClient = mockClient((path, params) => {
    if (path === Rest.IDS_FOLLOWING) {
      return { ok: true, status: 200, json: { ids: followingIds, next_cursor: 0 } };
    }
    if (path === Rest.IDS_FOLLOWERS) {
      return { ok: true, status: 200, json: { ids: followerIds, next_cursor: 0 } };
    }
    if (path === Rest.LOOKUP) {
      lookups += 1;
      const ids = String(params.user_id || "").split(",").filter(Boolean);
      return {
        ok: true,
        status: 200,
        json: ids.map((id) => ({ id_str: id, screen_name: "u" + id }))
      };
    }
    throw new Error("unexpected " + path);
  });
  const cold = await Rest.collectViaIds(coldClient, {
    screenName: "viewer",
    userId: "42",
    idMap: {}
  });
  assert(cold.following.length === 960, "cold following hydrates via lookup");
  assert(cold.followers.length === 540, "cold followers hydrates via lookup");
  assert(lookups === 11, "1093 unique ids is 11 lookup chunks");
  assert(coldClient.calls.length === 13, "cold 960/540 is 2 id pages + 11 lookups");
  assert(coldClient.calls.length < 25, "still a handful, not dozens of GQL pages");

  let saw429 = false;
  const resumeClient = mockClient((path, params, n) => {
    if (path === Rest.IDS_FOLLOWING && !saw429) {
      saw429 = true;
      return {
        ok: false,
        status: 429,
        text: "Rate limit exceeded",
        headers: { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 5) }
      };
    }
    if (path === Rest.IDS_FOLLOWING) {
      return { ok: true, status: 200, json: { ids: ["10"], next_cursor: 0 } };
    }
    if (path === Rest.IDS_FOLLOWERS) {
      return { ok: true, status: 200, json: { ids: ["11"], next_cursor: 0 } };
    }
    if (path === Rest.LOOKUP) {
      const ids = String(params.user_id || "").split(",").filter(Boolean);
      return {
        ok: true,
        status: 200,
        json: ids.map((id) => ({ id_str: id, screen_name: "u" + id }))
      };
    }
    throw new Error("unexpected " + path);
  });
  const resumed = await Rest.tryRestFollowLists(resumeClient, {
    screenName: "viewer",
    userId: "42",
    idMap: {}
  });
  assert(saw429 === true, "first ID page 429ed");
  assert(resumeClient.waits >= 1, "429 waited instead of failing the job");
  assert(resumed.following.join(",") === "u10", "same Sync now continued after 429");
  assert(resumed.path === "rest-ids", "completed on REST ids after wait");

  const deadIds = mockClient((path) => {
    if (path === Rest.IDS_FOLLOWING || path === Rest.IDS_FOLLOWERS) {
      return { ok: false, status: 403, text: "forbidden" };
    }
    if (path === Rest.LIST_FOLLOWING) {
      return {
        ok: true,
        status: 200,
        json: { users: [{ id_str: "1", screen_name: "Ada" }], next_cursor: 0 }
      };
    }
    if (path === Rest.LIST_FOLLOWERS) {
      return {
        ok: true,
        status: 200,
        json: { users: [{ id_str: "2", screen_name: "Bob" }], next_cursor: 0 }
      };
    }
    throw new Error("unexpected " + path);
  });
  const listed = await Rest.tryRestFollowLists(deadIds, {
    screenName: "viewer",
    userId: "42"
  });
  assert(listed.path === "rest-list", "403 on ids falls through to friends/list");
  assert(listed.following.join(",") === "ada", "list endpoint hydrates screen names");

  const allDead = mockClient(() => ({ ok: false, status: 410, text: "gone" }));
  let threw = null;
  try {
    await Rest.tryRestFollowLists(allDead, { screenName: "viewer", userId: "42" });
  } catch (e) {
    threw = e;
  }
  assert(threw && Rest.isRestUnavailable(threw), "all-dead REST throws unavailable");

  const v2Client = mockClient(() => ({ ok: false, status: 404, text: "gone" }));
  v2Client.requestV2 = async function (path) {
    this.calls.push({ path: path, v2: true });
    const side = /following$/.test(path) ? "following" : "followers";
    return {
      ok: true,
      status: 200,
      json: {
        data: [{ id: "9", username: side === "following" ? "cara" : "dan" }],
        meta: {}
      }
    };
  };
  const v2 = await Rest.tryRestFollowLists(v2Client, {
    screenName: "viewer",
    userId: "42",
    userToken: "already-in-storage"
  });
  assert(v2.path === "rest-v2", "v2 runs only when a user token already exists");
  assert(v2.following.join(",") === "cara" && v2.followers.join(",") === "dan", "v2 hydrates");

  const noToken = mockClient(() => ({ ok: false, status: 404, text: "gone" }));
  let noTokenErr = null;
  try {
    await Rest.tryRestFollowLists(noToken, { screenName: "viewer", userId: "42" });
  } catch (e) {
    noTokenErr = e;
  }
  assert(noTokenErr && Rest.isRestUnavailable(noTokenErr), "no token means REST unavailable, not a signup flow");

  const followerIds542 = [];
  for (let i = 1; i <= 542; i++) followerIds542.push("f" + i);
  let showCalls = 0;
  const omitClient = mockClient((path, params) => {
    if (path === Rest.IDS_FOLLOWING) {
      return { ok: true, status: 200, json: { ids: ["1"], next_cursor: 0 } };
    }
    if (path === Rest.IDS_FOLLOWERS) {
      return { ok: true, status: 200, json: { ids: followerIds542, next_cursor: 0 } };
    }
    if (path === Rest.LOOKUP) {
      const ids = String(params.user_id || "").split(",").filter(Boolean);
      return {
        ok: true,
        status: 200,
        json: ids
          .filter((id) => id === "1" || (id.startsWith("f") && Number(id.slice(1)) <= 520))
          .map((id) => ({ id_str: id, screen_name: "u" + id }))
      };
    }
    if (path === Rest.SHOW) {
      showCalls += 1;
      const id = String(params.user_id);
      const n = Number(String(id).slice(1));
      if (id.startsWith("f") && n > 520 && n <= 530) {
        return { ok: true, status: 200, json: { id_str: id, screen_name: "u" + id } };
      }
      return { ok: false, status: 404, text: "Not found" };
    }
    throw new Error("unexpected " + path);
  });
  const omitted = await Rest.collectViaIds(omitClient, {
    screenName: "viewer",
    userId: "42",
    idMap: {}
  });
  assert(omitted.followerIds.length === 542, "ID list keeps all 542 follower ids");
  assert(omitted.followers.length === 530, "lookup+show hydrates 520 + 10 leftover");
  assert(showCalls === 22, "only the 22 lookup misses hit users/show");
  assert(omitted.exhausted === true, "cursor 0 on both ID lists is exhausted");
  assert(
    Rest.preferredListTotal(542, omitted.followerIds, omitted.followers) === 542,
    "official count still wins when the handle list is short"
  );
  assert(
    Rest.preferredListTotal(542, new Array(521), new Array(521), 520) === 542,
    "fresh official 542 replaces a stale stored 520"
  );

  const showUser = {
    friends_count: 962,
    followers_count: 542,
    screen_name: "viewer"
  };
  const credsClient = mockClient((path) => {
    if (path === Rest.VERIFY_CREDENTIALS) {
      return { ok: true, status: 200, json: showUser };
    }
    throw new Error("unexpected " + path);
  });
  const fromCreds = await Rest.fetchRestOfficialCounts(credsClient, {
    screenName: "viewer",
    userId: "42"
  });
  assert(fromCreds.followers === 542, "verify_credentials is the signed-in Followers count");
  assert(fromCreds.following === 962, "verify_credentials is the signed-in Following count");
  assert(
    credsClient.calls.every((c) => c.path === Rest.VERIFY_CREDENTIALS),
    "signed-in counts do not need users/show when verify_credentials works"
  );

  const showOnly = mockClient((path) => {
    if (path === Rest.VERIFY_CREDENTIALS) {
      return { ok: false, status: 403, text: "forbidden" };
    }
    if (path === Rest.SHOW) {
      return { ok: true, status: 200, json: showUser };
    }
    throw new Error("unexpected " + path);
  });
  const fromShow = await Rest.fetchRestOfficialCounts(showOnly, {
    screenName: "viewer",
    userId: "42"
  });
  assert(fromShow.followers === 542, "users/show fills in when verify_credentials dies");

  const gqlUser = {
    data: {
      user: {
        result: {
          __typename: "User",
          rest_id: "42",
          legacy: { friends_count: 962, followers_count: 542 }
        }
      }
    }
  };
  assert(
    Rest.countsFromGraphqlUser(gqlUser).followers === 542,
    "UserByScreenName legacy.followers_count is the profile Followers number"
  );
  assert(
    Rest.countsFromGraphqlUser({
      data: { user: { result: { verified_follower_count: 500 } } }
    }).followers == null,
    "verified_follower_count is not the signed-in Followers number"
  );

  const dom = Rest.countsFromProfileDom(
    {
      querySelectorAll() {
        return [
          {
            getAttribute() {
              return "/viewer/verified_followers";
            },
            textContent: "500 Followers"
          },
          {
            getAttribute() {
              return "/viewer/followers";
            },
            textContent: "542 Followers"
          },
          {
            getAttribute() {
              return "/viewer/following";
            },
            textContent: "962 Following"
          },
          {
            getAttribute() {
              return "/someone/followers";
            },
            textContent: "12 Followers"
          }
        ];
      }
    },
    "viewer"
  );
  assert(dom.followers === 542, "DOM uses /handle/followers, not verified_followers");
  assert(dom.following === 962, "DOM uses /handle/following for the signed-in user");
  assert(
    omitted.followers.indexOf("uf521") !== -1,
    "per-id show recovers protected/lookup-omitted handles"
  );
  assert(
    omitted.followers.indexOf("uf542") === -1,
    "dead leftover IDs stay out of the handle list"
  );

  let followingPages = 0;
  const emptyThenIds = mockClient((path, params) => {
    if (path === Rest.IDS_FOLLOWING) {
      followingPages += 1;
      if (followingPages === 1) {
        return {
          ok: true,
          status: 200,
          json: { ids: [], next_cursor: "9", next_cursor_str: "9" }
        };
      }
      return { ok: true, status: 200, json: { ids: ["88"], next_cursor: 0 } };
    }
    if (path === Rest.IDS_FOLLOWERS) {
      return { ok: true, status: 200, json: { ids: ["99"], next_cursor: 0 } };
    }
    if (path === Rest.LOOKUP) {
      const ids = String(params.user_id || "").split(",").filter(Boolean);
      return {
        ok: true,
        status: 200,
        json: ids.map((x) => ({ id_str: x, screen_name: "u" + x }))
      };
    }
    if (path === Rest.SHOW) {
      const id = String(params.user_id);
      return { ok: true, status: 200, json: { id_str: id, screen_name: "u" + id } };
    }
    throw new Error("unexpected " + path);
  });
  const paged = await Rest.collectViaIds(emptyThenIds, {
    screenName: "viewer",
    userId: "42"
  });
  assert(followingPages >= 2, "empty ID page with a next_cursor keeps paging");
  assert(paged.followingIds.join(",") === "88", "IDs from the later page are kept");
  assert(paged.followingExhausted === true, "later cursor 0 marks following exhausted");

  const cp = {
    path: "graphql",
    side: "Following",
    userId: "42",
    users: ["a"],
    cursor: "cur-2",
    updatedAt: Date.now()
  };
  const resume = Rest.resumeGraphqlCheckpoint(cp, "Following", "42");
  assert(resume && resume.cursor === "cur-2", "GraphQL checkpoint resumes the same side");
  assert(Array.isArray(resume.ids) && resume.ids.length === 0, "legacy checkpoint resumes with no ids");
  assert(Rest.resumeGraphqlCheckpoint(cp, "Followers", "42") === null, "other side starts fresh");
  const cpIds = Rest.resumeGraphqlCheckpoint(
    Object.assign({}, cp, { ids: ["1", "2"] }),
    "Following",
    "42"
  );
  assert(cpIds.ids.join(",") === "1,2", "checkpoint carries rest_ids so membership survives a resume");
  assert(Rest.MAX_GRAPHQL_429_WAITS === 2, "GraphQL fallback waits out at most two 429 windows");
  const now429 = 1_700_000_000_000;
  const fourTwelve = 4 * 60 + 12;
  const resetSec = Math.floor(now429 / 1000) + fourTwelve;
  const fromHeader = Rest.backoffMsFromRateLimit(
    { headers: { "x-rate-limit-reset": String(resetSec) } },
    now429
  );
  assert(fromHeader !== Rest.DEFAULT_429_WAIT_MS, "x-rate-limit-reset is not the default minute");
  assert(
    fromHeader >= fourTwelve * 1000 && fromHeader <= fourTwelve * 1000 + 1250,
    "x-rate-limit-reset waits about 4:12 plus a small slack"
  );
  assert(
    Rest.backoffMsFromRateLimit({ budgetWaitMs: 90000 }, now429) === 90000,
    "a known budget wait is used when the reset header is missing"
  );
  const withCursor = Rest.graphqlFollowVariables("42", "cursor-1432", 100);
  assert(withCursor.userId === "42" && withCursor.count === 100, "follow variables keep the account and page size");
  assert(withCursor.cursor === "cursor-1432", "follow variables send the saved cursor");
  const firstPage = Rest.graphqlFollowVariables("42", null, 100);
  assert(!Object.prototype.hasOwnProperty.call(firstPage, "cursor"), "the first page omits an empty cursor");
  const savedUsers = [];
  for (let i = 0; i < 1432; i++) savedUsers.push("u" + i);
  const deep = Rest.resumeGraphqlCheckpoint(
    {
      path: "graphql",
      side: "Following",
      userId: "42",
      users: savedUsers,
      ids: ["9"],
      cursor: "cursor-1432",
      updatedAt: Date.now()
    },
    "Following",
    "42"
  );
  assert(deep && deep.cursor === "cursor-1432", "a deep crawl resumes at cursor-1432");
  assert(deep.users.length === 1432, "a deep crawl keeps the 1432 accounts already read");
  assert(
    Rest.checkpointFresh({ updatedAt: Date.now() - Rest.CHECKPOINT_MAX_AGE_MS - 1 }) === false,
    "stale GraphQL checkpoint is ignored"
  );

  const listPruneClient = mockClient((path) => {
    if (path === Rest.LIST_FOLLOWING) {
      return {
        ok: true,
        status: 200,
        json: { users: [{ id_str: "1", screen_name: "Ada" }], next_cursor: 0 }
      };
    }
    if (path === Rest.LIST_FOLLOWERS) {
      return {
        ok: true,
        status: 200,
        json: { users: [{ id_str: "2", screen_name: "Bob" }], next_cursor: 0 }
      };
    }
    throw new Error("unexpected " + path);
  });
  const listedPrune = await Rest.collectViaList(listPruneClient, {
    screenName: "viewer",
    userId: "42",
    idMap: { "1": "ada", "2": "bob", "999": "banned" }
  });
  assert(!listedPrune.idMap["999"], "list path prunes banned/stale ids");
  assert(
    listedPrune.idMap["1"] === "ada" && listedPrune.idMap["2"] === "bob",
    "list path keeps live following ∪ follower ids"
  );

  function nIds(n, prefix) {
    const ids = [];
    for (let i = 1; i <= n; i++) ids.push(prefix + i);
    return ids;
  }
  function nHandles(n, prefix) {
    return nIds(n, prefix);
  }
  const idsRicher = {
    path: "rest-ids",
    followingIds: nIds(1060, "g"),
    followerIds: nIds(620, "r"),
    following: nHandles(1060, "g"),
    followers: nHandles(580, "r")
  };
  const listShorter = {
    path: "rest-list",
    followingIds: nIds(1060, "g"),
    followerIds: nIds(586, "r"),
    following: nHandles(1060, "g"),
    followers: nHandles(586, "r")
  };
  assert(
    Rest.pickRicherRestResult(idsRicher, listShorter).path === "rest-ids",
    "rest-ids membership wins over a shorter rest-list handle set"
  );
  // v1.1.21: an exhausted cursor is final. 586/620 is X's phantom count,
  // not a reason to crawl friends/list or GraphQL.
  assert(
    Rest.restResultLooksComplete(
      {
        path: "rest-list",
        following: nHandles(1060, "g"),
        followers: nHandles(586, "r"),
        followingIds: nIds(1060, "g"),
        followerIds: nIds(586, "r"),
        exhausted: true,
        followingExhausted: true,
        followersExhausted: true
      },
      { expectedFollowing: 1060, expectedFollowers: 620 }
    ) === true,
    "tryRestFollowLists treats live 586/620 exhausted rest-list as complete"
  );
  assert(
    Identity.listLooksComplete(new Array(586).fill("h"), 620, [], {
      exhausted: true,
      restMembership: true,
      ids: new Array(586).fill("id")
    }) === true,
    "Identity and FollowRest share the 586/620 acceptance"
  );
  assert(
    Rest.restResultLooksComplete(
      {
        path: "rest-ids",
        following: nHandles(1060, "g"),
        followers: nHandles(586, "r"),
        followingIds: nIds(1060, "g"),
        followerIds: nIds(586, "r"),
        followingExhausted: true,
        followersExhausted: false
      },
      { expectedFollowing: 1060, expectedFollowers: 620 }
    ) === false,
    "a follower cursor that did not reach 0 is still incomplete"
  );
  assert(Rest.EXHAUSTED_TRUST_PCT === 0.25, "FollowRest fallback mirrors the 25% trust bound");

  function nUsers(n, prefix) {
    return nIds(n, prefix).map((id) => ({ id_str: id, screen_name: id }));
  }
  function hydrateLookup(path, params) {
    if (path !== Rest.LOOKUP) return null;
    const ids = String(params.user_id || "").split(",").filter(Boolean);
    return {
      ok: true,
      status: 200,
      json: ids.map((id) => ({ id_str: id, screen_name: id }))
    };
  }

  let listCalls = 0;
  const completeIds = mockClient((path, params) => {
    const lookup = hydrateLookup(path, params);
    if (lookup) return lookup;
    if (path === Rest.IDS_FOLLOWING) {
      return { ok: true, status: 200, json: { ids: nIds(40, "g"), next_cursor: 0 } };
    }
    if (path === Rest.IDS_FOLLOWERS) {
      return { ok: true, status: 200, json: { ids: nIds(100, "r"), next_cursor: 0 } };
    }
    if (path === Rest.LIST_FOLLOWING || path === Rest.LIST_FOLLOWERS) {
      listCalls += 1;
      throw new Error("complete rest-ids must not fall through to list");
    }
    throw new Error("unexpected " + path);
  });
  const complete = await Rest.tryRestFollowLists(completeIds, {
    screenName: "viewer",
    userId: "42",
    expectedFollowing: 40,
    expectedFollowers: 100
  });
  assert(complete.path === "rest-ids", "complete rest-ids is kept");
  assert(complete.followerIds.length === 100, "complete rest-ids keeps the full ID set");
  assert(listCalls === 0, "complete rest-ids does not call friends/list");

  // 80/100 with both cursors at 0: X counts 20 accounts it will not list.
  // The cursor is trusted; friends/list is never asked for a second opinion.
  let shortListCalls = 0;
  const shortExhausted = mockClient((path, params) => {
    const lookup = hydrateLookup(path, params);
    if (lookup) return lookup;
    if (path === Rest.IDS_FOLLOWING) {
      return { ok: true, status: 200, json: { ids: nIds(40, "g"), next_cursor: 0 } };
    }
    if (path === Rest.IDS_FOLLOWERS) {
      return { ok: true, status: 200, json: { ids: nIds(80, "r"), next_cursor: 0 } };
    }
    if (path === Rest.LIST_FOLLOWING || path === Rest.LIST_FOLLOWERS) {
      shortListCalls += 1;
      return { ok: true, status: 200, json: { users: nUsers(100, "r"), next_cursor: 0 } };
    }
    throw new Error("unexpected " + path);
  });
  const trusted = await Rest.tryRestFollowLists(shortExhausted, {
    screenName: "viewer",
    userId: "42",
    expectedFollowing: 40,
    expectedFollowers: 100
  });
  assert(trusted.path === "rest-ids", "short but exhausted rest-ids is trusted as final");
  assert(trusted.followerIds.length === 80, "the 80 listed followers are kept as-is");
  assert(shortListCalls === 0, "no friends/list second opinion for an exhausted cursor");
  assert(
    Rest.restResultLooksComplete(trusted, { expectedFollowing: 40, expectedFollowers: 100 }) === true,
    "caller marks 80/100 exhausted rest-ids as followersOk"
  );

  // A cursor that never reached 0 is a cut-off crawl and still escalates.
  assert(
    Rest.restResultLooksComplete(
      Object.assign({}, trusted, { followersExhausted: false, exhausted: false }),
      { expectedFollowing: 40, expectedFollowers: 100 }
    ) === false,
    "80/100 without an exhausted follower cursor is incomplete"
  );

  // Missing more than a quarter of the list is a broken response, not a
  // phantom hole; the fuller friends/list result is still fetched.
  const grosslyShort = mockClient((path, params) => {
    const lookup = hydrateLookup(path, params);
    if (lookup) return lookup;
    if (path === Rest.IDS_FOLLOWING) {
      return { ok: true, status: 200, json: { ids: nIds(40, "g"), next_cursor: 0 } };
    }
    if (path === Rest.IDS_FOLLOWERS) {
      return { ok: true, status: 200, json: { ids: nIds(50, "r"), next_cursor: 0 } };
    }
    if (path === Rest.LIST_FOLLOWING) {
      return { ok: true, status: 200, json: { users: nUsers(40, "g"), next_cursor: 0 } };
    }
    if (path === Rest.LIST_FOLLOWERS) {
      return { ok: true, status: 200, json: { users: nUsers(100, "r"), next_cursor: 0 } };
    }
    throw new Error("unexpected " + path);
  });
  const filled = await Rest.tryRestFollowLists(grosslyShort, {
    screenName: "viewer",
    userId: "42",
    expectedFollowing: 40,
    expectedFollowers: 100
  });
  assert(filled.path === "rest-list", "50/100 exhausted rest-ids still falls through to list");
  assert(filled.followerIds.length === 100, "fuller rest-list membership is used for badges");

  const shortListOnly = mockClient((path) => {
    if (path === Rest.IDS_FOLLOWING || path === Rest.IDS_FOLLOWERS) {
      return { ok: false, status: 403, text: "forbidden" };
    }
    if (path === Rest.LIST_FOLLOWING) {
      return { ok: true, status: 200, json: { users: nUsers(40, "g"), next_cursor: 0 } };
    }
    if (path === Rest.LIST_FOLLOWERS) {
      return { ok: true, status: 200, json: { users: nUsers(50, "r"), next_cursor: 0 } };
    }
    throw new Error("unexpected " + path);
  });
  const stillShort = await Rest.tryRestFollowLists(shortListOnly, {
    screenName: "viewer",
    userId: "42",
    expectedFollowing: 40,
    expectedFollowers: 100
  });
  assert(stillShort.path === "rest-list", "no fuller REST path still returns the short list");
  assert(stillShort.followerIds.length === 50, "short list is not padded");
  assert(
    Rest.restResultLooksComplete(stillShort, {
      expectedFollowing: 40,
      expectedFollowers: 100
    }) === false,
    "caller must not mark 50/100 exhausted rest-list as followersOk"
  );

  // When every list API stops on the same short count, the sync finishes.
  const now = 1_800_000_000_000;
  const expected = { following: 960, followers: 620 };
  const restLive = {
    path: "rest-ids",
    following: nHandles(960, "g"),
    followers: nHandles(586, "r"),
    followingIds: nIds(960, "g"),
    followerIds: nIds(586, "r"),
    idMap: { r1: "r1" },
    exhausted: true,
    followingExhausted: true,
    followersExhausted: true,
    followingOk: true,
    followersOk: false
  };
  const gqlLive = {
    path: "graphql",
    following: nHandles(960, "g"),
    followers: nHandles(586, "r"),
    followingIds: nIds(960, "g"),
    followerIds: nIds(586, "r"),
    idMap: { r2: "r2" },
    followingExhausted: true,
    followersExhausted: true,
    followingOk: true,
    followersOk: false
  };

  const union = Rest.unionFollowResults(restLive, gqlLive);
  assert(union.followerIds.length === 586, "union of identical follower lists stays 586");
  assert(union.followingIds.length === 960, "union keeps all following ids");
  assert(union.idMap.r1 === "r1" && union.idMap.r2 === "r2", "union merges both id maps");
  assert(union.followersExhausted === true && union.followingExhausted === true, "union is exhausted");
  assert(union.path === "rest-ids+graphql", "union path names both sources");
  const unionMore = Rest.unionFollowResults(restLive, {
    path: "graphql",
    followers: nHandles(600, "r").concat(["Extra"]),
    followerIds: nIds(600, "r").concat(["x1"]),
    following: [],
    followingIds: [],
    followingExhausted: false,
    followersExhausted: true
  });
  assert(unionMore.followerIds.length === 601, "GraphQL extras are added to the REST set");
  assert(unionMore.followers.indexOf("extra") !== -1, "union lowercases handles");
  assert(unionMore.followingExhausted === true, "one exhausted source is enough for the union");

  const packaged = Object.assign({}, union, { followingOk: true, followersOk: false });
  const confirmed = Rest.confirmGapAfterGraphql(packaged, restLive, gqlLive, expected, now);
  assert(confirmed.followersOk === true, "REST + GraphQL both exhausted at 586 → followers accepted");
  assert(confirmed.followingOk === true, "following stays ok");
  assert(
    confirmed.confirmedGap &&
      confirmed.confirmedGap.followers === 34 &&
      confirmed.confirmedGap.following === 0 &&
      confirmed.confirmedGap.at === now,
    "the 34-account hole is remembered with a timestamp"
  );

  const gqlCutOff = Object.assign({}, gqlLive, { followersExhausted: false });
  const notAgreed = Rest.confirmGapAfterGraphql(packaged, restLive, gqlCutOff, expected, now);
  assert(notAgreed.followersOk === false, "an unfinished GraphQL crawl cannot confirm the hole");
  assert(notAgreed.confirmedGap === undefined, "no hole is remembered without agreement");

  const fresh = Rest.freshConfirmedGap(confirmed.confirmedGap, now + 60000);
  assert(fresh && fresh.followers === 34, "confirmed hole is fresh a minute later");
  assert(
    Rest.freshConfirmedGap(confirmed.confirmedGap, now + Rest.CONFIRMED_GAP_MAX_AGE_MS + 1) === null,
    "confirmed hole expires after a week so REST truncation is rechecked"
  );
  assert(Rest.freshConfirmedGap(null, now) === null, "missing hole is null");
  assert(Rest.confirmedGapFor(fresh, "followers") === 34, "per-side gap lookup");
  assert(Rest.confirmedGapFor(null, "followers") === 0, "no gap is zero");

  // The two-call REST path passes on its own, confirmed hole or not.
  assert(
    Rest.restResultLooksComplete(restLive, {
      expectedFollowing: 960,
      expectedFollowers: 620,
      confirmedGap: fresh
    }) === true,
    "exhausted 586/620 REST is complete with a confirmed hole"
  );
  assert(
    Rest.restResultLooksComplete(restLive, {
      expectedFollowing: 960,
      expectedFollowers: 620
    }) === true,
    "v1.1.21: exhausted 586/620 REST is complete without any GraphQL confirmation"
  );
  assert(
    Rest.restResultLooksComplete(
      Object.assign({}, restLive, { followersExhausted: false, exhausted: false }),
      { expectedFollowing: 960, expectedFollowers: 620 }
    ) === false,
    "586/620 with a cut-off follower cursor still falls through"
  );
  let confirmedListCalls = 0;
  const confirmedIds = mockClient((path, params) => {
    const lookup = hydrateLookup(path, params);
    if (lookup) return lookup;
    if (path === Rest.IDS_FOLLOWING) {
      return { ok: true, status: 200, json: { ids: nIds(960, "g"), next_cursor: 0 } };
    }
    if (path === Rest.IDS_FOLLOWERS) {
      return { ok: true, status: 200, json: { ids: nIds(586, "r"), next_cursor: 0 } };
    }
    if (path === Rest.LIST_FOLLOWING || path === Rest.LIST_FOLLOWERS) {
      confirmedListCalls += 1;
      throw new Error("confirmed hole must not re-crawl friends/list");
    }
    throw new Error("unexpected " + path);
  });
  const quick = await Rest.tryRestFollowLists(confirmedIds, {
    screenName: "viewer",
    userId: "42",
    expectedFollowing: 960,
    expectedFollowers: 620,
    confirmedGap: fresh
  });
  assert(quick.path === "rest-ids", "confirmed hole keeps the two-call rest-ids path");
  assert(confirmedListCalls === 0, "no friends/list crawl after the hole is confirmed");

  // GraphQL could not answer (429 budget spent): exhausted REST is saved.
  const restOnly = Rest.acceptExhaustedSides(restLive);
  assert(restOnly.followersOk === true, "exhausted REST followers are saved without GraphQL");
  assert(restOnly.unconfirmed === true, "…but flagged unconfirmed so GraphQL retries next sync");
  const restCut = Rest.acceptExhaustedSides(
    Object.assign({}, restLive, { followersExhausted: false })
  );
  assert(restCut.followersOk === false, "a cut-off REST cursor is still incomplete");
  assert(!restCut.unconfirmed, "nothing accepted, nothing unconfirmed");

  const gapTail = " — the rest are accounts X counts but no longer shows.";
  assert(
    Rest.listGapNote({ following: 960, followers: 620 }, restLive) ===
      "X lists 586 of 620 followers" + gapTail,
    "rail note explains the hole in plain numbers"
  );
  assert(
    Rest.listGapNote({ following: 960, followers: 590 }, restLive) === "",
    "a hole within slack gets no note"
  );
  assert(
    Rest.listGapNote(
      { following: 1000, followers: 620 },
      restLive
    ) === "X lists 960 of 1000 following and 586 of 620 followers" + gapTail,
    "both sides are listed when both have a material hole"
  );
  assert(Rest.listGapNote({ following: null, followers: null }, restLive) === "", "no counts, no note");

  console.log("All follow-rest tests passed.");
  console.log(
    "Dry run 960/540: first sync " +
      dry.total +
      " REST calls (2 id + 15 lookup worst-case); warm cache 2 calls; GraphQL@50 would be " +
      dry.graphqlPagesAt50 +
      " pages."
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
