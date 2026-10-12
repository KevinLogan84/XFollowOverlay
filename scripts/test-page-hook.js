/**
 * Page-hook installs a GraphQL command channel and ignores unknown ops.
 * Run: node scripts/test-page-hook.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const src = fs.readFileSync(path.join(__dirname, "../content/page-hook.js"), "utf8");
const messages = [];
const listeners = [];

// Per-URL response bodies for the passive-capture tests; default is a
// trivial GraphQL envelope.
const bodies = [];
function bodyFor(url) {
  for (let i = 0; i < bodies.length; i++) {
    if (bodies[i].test.test(String(url))) return bodies[i].json;
  }
  return { data: { ok: true } };
}

function plainResponder(url) {
  const json = bodyFor(url);
  return Promise.resolve({
    ok: true,
    text: () => Promise.resolve(JSON.stringify(json)),
    clone() {
      return this;
    },
    json: () => Promise.resolve(json)
  });
}

// The hook captures window.fetch once at load, so tests swap the responder
// underneath rather than replacing window.fetch (which would drop the wrapper).
let responder = plainResponder;
function mockFetch(url) {
  return responder(url);
}

const xhrProto = {
  open() {},
  send() {},
  addEventListener() {}
};

const targets = [];
const fakeWindow = {
  fetch: mockFetch,
  postMessage: function (data, target) {
    messages.push(data);
    targets.push(target);
  },
  addEventListener: function (type, fn) {
    if (type === "message") listeners.push(fn);
  },
  removeEventListener: function () {}
};

const context = {
  window: fakeWindow,
  document: {
    cookie: "ct0=csrf-token; twid=u%3D123456789",
    documentElement: {
      attrs: {},
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      getAttribute(k) {
        return this.attrs[k] || null;
      }
    }
  },
  location: { origin: "https://x.com" },
  XMLHttpRequest: function () {},
  Promise: Promise,
  Date: Date,
  URL: URL,
  URLSearchParams: URLSearchParams,
  encodeURIComponent: encodeURIComponent,
  JSON: JSON,
  String: String,
  Error: Error
};
context.XMLHttpRequest.prototype = xhrProto;
fakeWindow.document = context.document;
fakeWindow.location = context.location;

vm.createContext(context);
vm.runInContext(src, context);

assert(fakeWindow.__xfoPageHook === true, "hook marks itself installed");
assert(
  context.document.documentElement.getAttribute("data-xfo-hook") === "1",
  "hook sets data-xfo-hook"
);
assert(listeners.length === 1, "hook listens for page messages");

function send(data) {
  listeners[0]({ source: fakeWindow, data: data });
}

(async () => {
  send({
    source: "xfo-content",
    type: "XFO_GQL",
    id: 7,
    queryId: "abc",
    operationName: "NotAllowed",
    variables: {},
    features: {}
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(messages.length === 1, "rejected unknown op");
  assert(messages[0].ok === false, "unknown op is not ok");
  assert(/Unsupported/i.test(messages[0].error), "unknown op error text");

  messages.length = 0;
  send({
    source: "xfo-content",
    type: "XFO_GQL",
    id: 8,
    queryId: "qGZZDF3mp91q7X22s3HxpA",
    operationName: "Following",
    variables: { userId: "1", count: 50 },
    features: {}
  });
  await new Promise((r) => setTimeout(r, 20));
  const tapped = messages.find((m) => m.op === "Following" && !m.type);
  const result = messages.find((m) => m.type === "XFO_GQL_RESULT");
  assert(tapped && tapped.json, "hook still taps Following responses");
  assert(result, "allowed Following op replies");
  assert(result.id === 8, "echoes request id");
  assert(result.ok === true, "Following op succeeds in the stub");
  assert(result.json && result.json.data, "returns JSON");

  messages.length = 0;
  const fetches = [];
  const prevFetch = fakeWindow.fetch;
  fakeWindow.fetch = function (url, init) {
    fetches.push({ url: String(url), method: init && init.method });
    return prevFetch.apply(this, arguments);
  };
  send({
    source: "xfo-content",
    type: "XFO_GQL",
    id: 11,
    queryId: "FIFgycIi-CNJcV0R-135Uw",
    operationName: "UserTweetsAndReplies",
    variables: { userId: "1", count: 20 },
    features: {},
    fieldToggles: { withArticlePlainText: false }
  });
  await new Promise((r) => setTimeout(r, 20));
  const tweetsResult = messages.find((m) => m.type === "XFO_GQL_RESULT" && m.id === 11);
  assert(tweetsResult && tweetsResult.ok === true, "UserTweetsAndReplies is allowed");
  assert(
    fetches.some((f) => /UserTweetsAndReplies/.test(f.url) && f.method === "GET"),
    "UserTweetsAndReplies is fetched with GET"
  );
  assert(
    fetches.some((f) => /fieldToggles=/.test(f.url)),
    "GET carries fieldToggles"
  );
  fakeWindow.fetch = prevFetch;

  messages.length = 0;
  send({
    source: "xfo-content",
    type: "XFO_REST",
    id: 9,
    path: "/i/api/1.1/not-allowed.json",
    params: {}
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(messages.length === 1, "rejected unknown REST path");
  assert(messages[0].ok === false, "unknown REST path is not ok");
  assert(/Unsupported/i.test(messages[0].error), "unknown REST path error text");

  messages.length = 0;
  send({
    source: "xfo-content",
    type: "XFO_REST",
    id: 10,
    path: "/i/api/1.1/friends/ids.json",
    params: { user_id: "1", count: 5000, stringify_ids: true }
  });
  await new Promise((r) => setTimeout(r, 20));
  const rest = messages.find((m) => m.type === "XFO_REST_RESULT");
  assert(rest, "allowed friends/ids replies");
  assert(rest.id === 10, "echoes REST request id");
  assert(rest.ok === true, "friends/ids succeeds in the stub");
  assert(targets.length > 0, "hook posted replies");
  assert(
    targets.every((t) => t === "https://x.com"),
    "hook replies target the page origin, never *"
  );
  assert(!/postMessage\([^;]*?,\s*"\*"\s*\)/.test(src), "page-hook has no '*' postMessage target");
  assert(src.includes("UserTweets: 1"), "hook allows UserTweets");
  assert(src.includes("UserTweetsAndReplies: 1"), "hook allows UserTweetsAndReplies");
  assert(src.includes("SearchTimeline: 1"), "hook allows SearchTimeline");
  assert(src.includes("/i/api/2/search/adaptive.json"), "hook allows adaptive search");
  assert(src.includes("XFO_GQL_LEARN"), "hook learns live query ids");
  assert(src.includes("GQL_GET"), "hook uses GET for timeline reads");

  messages.length = 0;
  send({
    source: "xfo-content",
    type: "XFO_REST",
    id: 12,
    path: "/i/api/2/search/adaptive.json",
    params: { q: "from:test", count: 20 }
  });
  await new Promise((r) => setTimeout(r, 20));
  const adaptive = messages.find((m) => m.type === "XFO_REST_RESULT" && m.id === 12);
  assert(adaptive && adaptive.ok === true, "adaptive search path is allowed");

  // v1.1.21 — passive relationship capture from X's own responses.
  // A HomeTimeline page: 2025+ user shape (core + relationship_perspectives),
  // legacy shape, a retweet nested under legacy, a user with no viewer
  // flags, and a Tweet node that must not be mistaken for a user.
  const homeTimeline = {
    data: {
      home: {
        home_timeline_urt: {
          instructions: [
            {
              type: "TimelineAddEntries",
              entries: [
                {
                  entryId: "tweet-1",
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: "Tweet",
                          rest_id: "900001",
                          core: {
                            user_results: {
                              result: {
                                __typename: "User",
                                rest_id: "1001",
                                core: { name: "Ada", screen_name: "AdaL" },
                                legacy: { followers_count: 5, follow_request_sent: false },
                                relationship_perspectives: {
                                  blocking: false,
                                  followed_by: true,
                                  following: true
                                }
                              }
                            }
                          },
                          legacy: {
                            full_text: "RT @Bob: hi",
                            id_str: "900001",
                            entities: {
                              user_mentions: [{ id_str: "1002", screen_name: "Bob" }]
                            },
                            retweeted_status_result: {
                              result: {
                                __typename: "Tweet",
                                rest_id: "900000",
                                core: {
                                  user_results: {
                                    result: {
                                      __typename: "User",
                                      rest_id: "1002",
                                      legacy: {
                                        screen_name: "Bob",
                                        following: false,
                                        followed_by: true
                                      }
                                    }
                                  }
                                },
                                legacy: { full_text: "hi", id_str: "900000" }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                },
                {
                  entryId: "tweet-2",
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: "Tweet",
                          rest_id: "900002",
                          core: {
                            user_results: {
                              result: {
                                __typename: "User",
                                rest_id: "1003",
                                core: { screen_name: "NoFlags" },
                                legacy: { followers_count: 1 }
                              }
                            }
                          },
                          legacy: { full_text: "no viewer context", id_str: "900002" }
                        }
                      }
                    }
                  }
                },
                {
                  entryId: "cursor-bottom-1",
                  content: { cursorType: "Bottom", value: "abc" }
                }
              ]
            }
          ]
        }
      }
    }
  };
  bodies.push({ test: /HomeTimeline/, json: homeTimeline });
  bodies.push({
    test: /notifications\/all\.json/,
    json: {
      globalObjects: {
        users: {
          "2001": { id_str: "2001", screen_name: "NewFan", following: false, followed_by: true },
          "2002": { id_str: "2002", screen_name: "Quiet" }
        },
        tweets: {}
      }
    }
  });
  bodies.push({
    test: /friendships\/create\.json/,
    // X's own response can lag (following:false right after a follow);
    // the endpoint decides.
    json: { id_str: "3001", screen_name: "JustFollowed", following: false }
  });
  bodies.push({
    test: /friendships\/destroy\.json/,
    json: { id_str: "3002", screen_name: "Dropped", following: true }
  });

  messages.length = 0;
  await fakeWindow.fetch("https://x.com/i/api/graphql/abc123/HomeTimeline?variables=%7B%7D");
  await new Promise((r) => setTimeout(r, 20));
  const rel = messages.find((m) => m.type === "XFO_RELATIONS");
  assert(rel, "HomeTimeline response yields an XFO_RELATIONS message");
  assert(rel.action === false, "timeline harvest is not an action");
  assert(typeof rel.at === "number", "harvest carries a timestamp");
  const byId = {};
  rel.users.forEach((u) => (byId[u.id] = u));
  assert(rel.users.length === 2, "only users with explicit viewer flags are posted (" + rel.users.length + ")");
  assert(
    byId["1001"] && byId["1001"].h === "adal" && byId["1001"].f === true && byId["1001"].b === true,
    "2025+ shape: core.screen_name + relationship_perspectives"
  );
  assert(
    byId["1002"] && byId["1002"].h === "bob" && byId["1002"].f === false && byId["1002"].b === true,
    "legacy shape nested under a retweet is harvested"
  );
  assert(!byId["1003"], "a user without viewer flags is skipped");
  assert(!byId["900001"] && !byId["900000"], "Tweet nodes are not users");
  assert(rel.users.every((u) => Object.keys(u).sort().join(",") === "b,f,h,id"), "records are compact");

  messages.length = 0;
  await fakeWindow.fetch("https://x.com/i/api/2/notifications/all.json?count=40");
  await new Promise((r) => setTimeout(r, 20));
  const notif = messages.find((m) => m.type === "XFO_RELATIONS");
  assert(notif && notif.users.length === 1, "notifications globalObjects.users are harvested");
  assert(
    notif.users[0].id === "2001" && notif.users[0].h === "newfan" && notif.users[0].b === true && notif.users[0].f === false,
    "REST v1.1 user shape: id_str/screen_name/following/followed_by"
  );

  messages.length = 0;
  await fakeWindow.fetch("https://x.com/i/api/1.1/friendships/create.json", {
    method: "POST",
    body: "include_profile_interstitial_type=1&user_id=3001"
  });
  await new Promise((r) => setTimeout(r, 20));
  const follow = messages.find((m) => m.type === "XFO_RELATIONS");
  assert(follow && follow.action === true, "friendships/create is posted as an action");
  assert(
    follow.users.length === 1 && follow.users[0].id === "3001" && follow.users[0].f === true && follow.users[0].b === null,
    "follow click records following:true regardless of the lagging response body"
  );
  assert(follow.users[0].h === "justfollowed", "action carries the handle from the response");

  messages.length = 0;
  await fakeWindow.fetch("https://x.com/i/api/1.1/friendships/destroy.json", {
    method: "POST",
    body: "user_id=3002"
  });
  await new Promise((r) => setTimeout(r, 20));
  const unfollow = messages.find((m) => m.type === "XFO_RELATIONS");
  assert(unfollow && unfollow.action === true && unfollow.users[0].f === false, "unfollow click records following:false");

  messages.length = 0;
  await fakeWindow.fetch("https://x.com/i/api/graphql/zzz/SomethingWithoutUsers");
  await fakeWindow.fetch("https://x.com/i/api/1.1/users/lookup.json?user_id=1");
  await fakeWindow.fetch("https://x.com/some/page");
  await new Promise((r) => setTimeout(r, 20));
  assert(
    !messages.some((m) => m.type === "XFO_RELATIONS"),
    "no relations message when a response has no viewer flags or is not an API call"
  );

  // XHR path harvests the same way.
  messages.length = 0;
  const xhrListeners = [];
  const xhr = {
    responseType: "",
    status: 200,
    responseText: JSON.stringify(bodyFor("HomeTimeline")),
    addEventListener(type, fn) {
      if (type === "load") xhrListeners.push(fn);
    }
  };
  context.XMLHttpRequest.prototype.open.call(xhr, "GET", "https://x.com/i/api/graphql/abc123/HomeTimeline");
  context.XMLHttpRequest.prototype.send.call(xhr);
  xhrListeners.forEach((fn) => fn.call(xhr));
  const viaXhr = messages.find((m) => m.type === "XFO_RELATIONS");
  assert(viaXhr && viaXhr.users.length === 2, "XHR responses are harvested too");
  assert(
    targets.every((t) => t === "https://x.com"),
    "relation messages target the page origin, never *"
  );

  // v1.1.22 — rate-limit windows from X's own GraphQL traffic (XFO_RATE) and
  // on our XFO_GQL replies, so the pump can budget instead of hitting 429.
  const RESET = String(Math.floor(Date.now() / 1000) + 600);
  function ratedFetch(status, headers) {
    return function (url) {
      const json = bodyFor(url);
      const map = new Map(Object.entries(headers || {}));
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status: status,
        headers: { get: (k) => (map.has(k) ? map.get(k) : null) },
        text: () => Promise.resolve(JSON.stringify(json)),
        clone() {
          return this;
        },
        json: () => Promise.resolve(json)
      });
    };
  }
  messages.length = 0;
  responder = ratedFetch(200, {
    "x-rate-limit-limit": "50",
    "x-rate-limit-remaining": "12",
    "x-rate-limit-reset": RESET
  });
  await fakeWindow.fetch("https://x.com/i/api/graphql/q1/UserTweets?variables=%7B%7D");
  await new Promise((r) => setTimeout(r, 20));
  const rate = messages.find((m) => m.type === "XFO_RATE");
  assert(rate, "X's own UserTweets response posts an XFO_RATE window");
  assert(rate.op === "UserTweets", "XFO_RATE names the GraphQL op");
  assert(rate.limit === "50" && rate.remaining === "12" && rate.reset === RESET, "XFO_RATE carries limit/remaining/reset");
  assert(rate.status === 200 && typeof rate.at === "number", "XFO_RATE carries status and timestamp");

  messages.length = 0;
  await fakeWindow.fetch("https://x.com/i/api/graphql/q2/HomeTimeline?variables=%7B%7D");
  await fakeWindow.fetch("https://x.com/i/api/graphql/q3/UserTweetsByRestIdNope?variables=%7B%7D");
  await fakeWindow.fetch("https://x.com/i/api/1.1/friends/ids.json?user_id=1");
  await new Promise((r) => setTimeout(r, 20));
  assert(!messages.some((m) => m.type === "XFO_RATE"), "ops the pump does not spend from post no XFO_RATE");

  messages.length = 0;
  responder = ratedFetch(429, {});
  await fakeWindow.fetch("https://x.com/i/api/graphql/q4/UserTweetsAndReplies?variables=%7B%7D");
  await new Promise((r) => setTimeout(r, 20));
  const hit = messages.find((m) => m.type === "XFO_RATE");
  assert(hit && hit.op === "UserTweetsAndReplies" && hit.status === 429, "a 429 without headers still posts XFO_RATE");
  assert(hit.remaining === null && hit.reset === null, "missing headers are null, not strings");

  messages.length = 0;
  responder = ratedFetch(200, {});
  await fakeWindow.fetch("https://x.com/i/api/graphql/q5/UserTweets?variables=%7B%7D");
  await new Promise((r) => setTimeout(r, 20));
  assert(!messages.some((m) => m.type === "XFO_RATE"), "a 200 without rate headers posts nothing");

  // Our own XFO_GQL command: the reply carries the window too.
  messages.length = 0;
  responder = ratedFetch(200, {
    "x-rate-limit-limit": "50",
    "x-rate-limit-remaining": "7",
    "x-rate-limit-reset": RESET
  });
  send({
    source: "xfo-content",
    type: "XFO_GQL",
    id: 21,
    queryId: "FIFgycIi-CNJcV0R-135Uw",
    operationName: "UserTweetsAndReplies",
    variables: { userId: "1", count: 20 },
    features: {}
  });
  await new Promise((r) => setTimeout(r, 20));
  const okReply = messages.find((m) => m.type === "XFO_GQL_RESULT" && m.id === 21);
  assert(okReply && okReply.ok === true, "XFO_GQL reply is ok");
  assert(
    okReply.rateLimitRemaining === "7" && okReply.rateLimitLimit === "50" && okReply.rateLimitReset === RESET,
    "XFO_GQL_RESULT carries remaining/limit/reset"
  );
  assert(
    messages.some((m) => m.type === "XFO_RATE" && m.op === "UserTweetsAndReplies" && m.remaining === "7"),
    "our own GraphQL call also reports its window (it goes through window.fetch)"
  );

  messages.length = 0;
  responder = ratedFetch(429, {
    "x-rate-limit-limit": "50",
    "x-rate-limit-remaining": "0",
    "x-rate-limit-reset": RESET,
    "retry-after": "120"
  });
  send({
    source: "xfo-content",
    type: "XFO_GQL",
    id: 22,
    queryId: "FIFgycIi-CNJcV0R-135Uw",
    operationName: "UserTweetsAndReplies",
    variables: { userId: "1", count: 20 },
    features: {}
  });
  await new Promise((r) => setTimeout(r, 20));
  const limited = messages.find((m) => m.type === "XFO_GQL_RESULT" && m.id === 22);
  assert(limited && limited.ok === false && limited.status === 429, "a 429 XFO_GQL reply is not ok and carries status");
  assert(
    limited.rateLimitRemaining === "0" && limited.rateLimitReset === RESET && limited.retryAfter === "120",
    "a 429 XFO_GQL reply carries the reset so the pump can sleep exactly"
  );
  responder = plainResponder;

  // XHR path reports the window too.
  messages.length = 0;
  const xhrRateListeners = [];
  const ratedXhr = {
    responseType: "",
    status: 200,
    responseText: JSON.stringify({ data: {} }),
    getResponseHeader(name) {
      return { "x-rate-limit-limit": "50", "x-rate-limit-remaining": "3", "x-rate-limit-reset": RESET }[name] || null;
    },
    addEventListener(type, fn) {
      if (type === "load") xhrRateListeners.push(fn);
    }
  };
  context.XMLHttpRequest.prototype.open.call(ratedXhr, "GET", "https://x.com/i/api/graphql/q6/UserTweets?variables=%7B%7D");
  context.XMLHttpRequest.prototype.send.call(ratedXhr);
  xhrRateListeners.forEach((fn) => fn.call(ratedXhr));
  const xhrRate = messages.find((m) => m.type === "XFO_RATE");
  assert(xhrRate && xhrRate.op === "UserTweets" && xhrRate.remaining === "3", "XHR GraphQL responses report their window");
  assert(
    targets.every((t) => t === "https://x.com"),
    "rate messages target the page origin, never *"
  );

  // v1.1.27 — copy the features / fieldToggles X itself sends, so a Grok
  // release that adds a required switch does not 400 our baked-in contract.
  const liveFeatures = {
    responsive_web_grok_annotations_enabled: true,
    responsive_web_grok_bio_auto_translation_is_enabled: true
  };
  const liveToggles = { withGrokAnalyze: true, withArticlePlainText: false };
  const contractUrl =
    "https://x.com/i/api/graphql/abc/UserTweets?variables=%7B%7D&features=" +
    encodeURIComponent(JSON.stringify(liveFeatures)) +
    "&fieldToggles=" +
    encodeURIComponent(JSON.stringify(liveToggles));
  messages.length = 0;
  await fakeWindow.fetch(contractUrl);
  await new Promise((r) => setTimeout(r, 20));
  const learned = messages.filter((m) => m.type === "XFO_GQL_FEATURES");
  assert(learned.length === 1, "X's UserTweets request posts its contract once");
  assert(learned[0].operationName === "UserTweets", "contract names the op");
  assert(
    learned[0].features.responsive_web_grok_bio_auto_translation_is_enabled === true,
    "contract carries the new feature switch"
  );
  assert(learned[0].fieldToggles.withGrokAnalyze === true, "contract carries field toggles");
  messages.length = 0;
  await fakeWindow.fetch(contractUrl);
  await new Promise((r) => setTimeout(r, 20));
  assert(
    !messages.some((m) => m.type === "XFO_GQL_FEATURES"),
    "an unchanged contract is not posted again"
  );

  messages.length = 0;
  const postBody = JSON.stringify({
    variables: { userId: "1" },
    features: { responsive_web_grok_imagine_annotation_enabled: false },
    fieldToggles: { withAuxiliaryUserLabels: true }
  });
  const postXhrListeners = [];
  const postXhr = {
    responseType: "",
    status: 200,
    responseText: "{}",
    getResponseHeader() {
      return null;
    },
    addEventListener(type, fn) {
      if (type === "load") postXhrListeners.push(fn);
    }
  };
  context.XMLHttpRequest.prototype.open.call(
    postXhr,
    "POST",
    "https://x.com/i/api/graphql/abc/UserTweetsAndReplies"
  );
  context.XMLHttpRequest.prototype.send.call(postXhr, postBody);
  const posted = messages.find((m) => m.type === "XFO_GQL_FEATURES");
  assert(
    posted &&
      posted.operationName === "UserTweetsAndReplies" &&
      posted.features.responsive_web_grok_imagine_annotation_enabled === false &&
      posted.fieldToggles.withAuxiliaryUserLabels === true,
    "XHR POST bodies yield the contract too"
  );

  messages.length = 0;
  send({
    source: "xfo-content",
    type: "XFO_GQL",
    id: 31,
    queryId: "FIFgycIi-CNJcV0R-135Uw",
    operationName: "UserTweets",
    variables: { userId: "1", count: 20 },
    features: { stale_baked_in: true },
    fieldToggles: { withArticlePlainText: false }
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(
    !messages.some((m) => m.type === "XFO_GQL_FEATURES"),
    "our own GraphQL call does not overwrite X's contract"
  );

  messages.length = 0;
  responder = function () {
    const text = JSON.stringify({
      errors: [
        {
          message:
            "The following features cannot be null: responsive_web_grok_bio_auto_translation_is_enabled, responsive_web_grok_analyze_post_followups_enabled"
        },
        { message: "The following fieldToggles cannot be null: withGrokAnalyze" }
      ]
    });
    return Promise.resolve({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: () => Promise.resolve(text),
      clone() {
        return this;
      },
      json: () => Promise.resolve({})
    });
  };
  send({
    source: "xfo-content",
    type: "XFO_GQL",
    id: 32,
    queryId: "FIFgycIi-CNJcV0R-135Uw",
    operationName: "UserTweetsAndReplies",
    variables: { userId: "1", count: 20 },
    features: {},
    fieldToggles: { withArticlePlainText: false }
  });
  await new Promise((r) => setTimeout(r, 20));
  const denied = messages.find((m) => m.type === "XFO_GQL_RESULT" && m.id === 32);
  assert(denied && denied.ok === false && denied.status === 400, "a 400 XFO_GQL reply is not ok");
  assert(
    Array.isArray(denied.missingFeatures) &&
      denied.missingFeatures.indexOf("responsive_web_grok_bio_auto_translation_is_enabled") !== -1 &&
      denied.missingFeatures.indexOf("responsive_web_grok_analyze_post_followups_enabled") !== -1,
    "a 400 names every missing feature switch (" + JSON.stringify(denied && denied.missingFeatures) + ")"
  );
  assert(
    Array.isArray(denied.missingFieldToggles) && denied.missingFieldToggles[0] === "withGrokAnalyze",
    "a 400 names missing field toggles"
  );
  assert(
    /features cannot be null/.test(denied.error) && denied.error.length > 160,
    "the 400 error keeps the switch list instead of a 160-character slice"
  );
  responder = plainResponder;

  console.log("All page-hook tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
