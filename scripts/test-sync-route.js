/**
 * Sync route: refuse without a signed-in tab, session GraphQL with no keys,
 * API only when the user entered keys.
 * Run: node scripts/test-sync-route.js
 */
const Route = require("../shared/sync-route.js");
const Api = require("../shared/x-api.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ct0 = "csrf-token-value";
const twid = "u=424242";
const snapshot = {
  selfUsername: "viewer",
  following: ["ada"],
  followers: ["bob"],
  userId: "999"
};
const oauth = {
  apiKey: "consumer-key-0123456789",
  apiSecret: "consumer-secret-0123456789",
  accessToken: "access-token-0123456789",
  accessSecret: "access-secret-0123456789"
};

{
  const refused = Route.chooseSyncRoute({
    storedUsername: "viewer",
    storedUserId: "999",
    snapshot: snapshot,
    cache: { selfUsername: "viewer" }
  });
  assert(refused.ok === false && refused.path === null, "no cookies refuses sync");
  assert(refused.reason === Route.NO_SESSION_REASON, "refusal tells the user to sign in");
  assert(
    Route.chooseSyncRoute({ ct0: ct0, snapshot: snapshot }).ok === false,
    "csrf without twid is not a session"
  );
  assert(
    Route.chooseSyncRoute({ twid: twid, keys: oauth, snapshot: snapshot }).ok === false,
    "keys do not replace a signed-in tab"
  );
}

{
  const session = Route.chooseSyncRoute({ ct0: ct0, twid: twid });
  assert(session.ok === true && session.path === "session", "no keys uses the session path");
  assert(session.userId === "424242", "user id comes from the twid cookie");
  const blanks = Route.chooseSyncRoute({
    ct0: ct0,
    twid: twid,
    keys: { apiKey: "   ", apiSecret: "", accessToken: "", accessSecret: "", bearer: "" }
  });
  assert(blanks.path === "session", "blank key fields stay on the session path");
  const partial = Route.chooseSyncRoute({
    ct0: ct0,
    twid: twid,
    keys: Object.assign({}, oauth, { accessSecret: "" })
  });
  assert(partial.path === "session", "three of four keys do not select the API");
  const placeholder = Route.chooseSyncRoute({
    ct0: ct0,
    twid: twid,
    keys: {
      apiKey: "your_api_key_placeholder",
      apiSecret: "your_api_secret_placeholder",
      accessToken: "your_access_token_placeholder",
      accessSecret: "your_access_secret_placeholder"
    }
  });
  assert(placeholder.path === "session", "placeholder keys are not the user's keys");
}

{
  const api = Route.chooseSyncRoute({ ct0: ct0, twid: twid, keys: oauth });
  assert(api.ok === true && api.path === "api", "four user keys select the API path");
  const bearer = Route.chooseSyncRoute({
    ct0: ct0,
    twid: twid,
    keys: { bearer: "bearer-token-the-user-pasted-0123456789" }
  });
  assert(bearer.path === "api", "a user bearer token selects the API path");
  assert(Api.credentialForRequest(oauth).apiKey === oauth.apiKey, "oauth credential keeps the user's key");
  assert(
    Api.credentialForRequest({ bearer: "bearer-token-the-user-pasted-0123456789" }) ===
      "bearer-token-the-user-pasted-0123456789",
    "bearer credential is the pasted token"
  );
  assert(Api.credentialForRequest({}) === null, "empty storage yields no credential");
  assert(Api.hasUserApiKeys(null) === false, "missing keys are not keys");
}

{
  const stored = Api.keysFromStorage({
    xApiKey: oauth.apiKey,
    xApiSecret: oauth.apiSecret,
    xAccessToken: oauth.accessToken,
    xAccessSecret: oauth.accessSecret
  });
  assert(Route.chooseSyncRoute({ ct0: ct0, twid: twid, keys: stored }).path === "api", "storage keys select API");
  const legacy = Api.keysFromStorage({ xUserToken: "legacy-user-bearer-token-0123456789" });
  assert(Api.hasBearer(legacy), "a bearer the user saved earlier still counts");
  assert(
    Route.chooseSyncRoute({ ct0: ct0, twid: twid, keys: Api.keysFromStorage({}) }).path === "session",
    "empty storage stays on the session path"
  );
}

{
  const half = {
    apiKey: oauth.apiKey,
    apiSecret: "only-half-secret",
    accessToken: "",
    accessSecret: "",
    bearer: "bearer-token-the-user-pasted-0123456789"
  };
  assert(Api.hasOAuthKeys(half) === false, "half-filled OAuth is not a full OAuth set");
  assert(Api.hasBearer(half) === true, "half-filled OAuth still has a bearer");
  assert(
    Api.credentialForRequest(half) === "bearer-token-the-user-pasted-0123456789",
    "half-filled OAuth keys use the bearer"
  );
  assert(
    Route.chooseSyncRoute({ ct0: ct0, twid: twid, keys: half }).path === "api",
    "half-filled OAuth with a bearer selects the API"
  );
  assert(
    Route.chooseSyncRoute({ ct0: ct0, twid: twid, keys: oauth, prefer: "session" }).path === "session",
    "Sync free stays on the session path when keys exist"
  );
  assert(
    Route.chooseSyncRoute({ ct0: ct0, twid: twid, keys: oauth, prefer: "free" }).path === "session",
    "prefer free is the session path"
  );
  assert(
    Route.chooseSyncRoute({ ct0: ct0, twid: twid, keys: oauth, prefer: "api" }).path === "api",
    "Sync with API keys selects the API path"
  );
  const refusedApi = Route.chooseSyncRoute({ ct0: ct0, twid: twid, prefer: "api" });
  assert(refusedApi.ok === false && refusedApi.path !== "session", "API choice does not fall back to free sync");
  assert(
    Api.savedKeyLabel("bearer-token-the-user-pasted-0123456789") === "Saved, ends in …6789",
    "saved keys show the last four characters"
  );
  assert(Api.savedKeyLabel("   ") === "", "a blank key has no saved label");
  assert(Api.savedKeyLabel("short") === "Saved", "a short key is masked fully");
  assert(Api.savedKeyLabel("12345678") === "Saved", "an 8 character key is masked fully");
  assert(Api.savedKeyLabel("123456789") === "Saved, ends in …6789", "nine characters still show only the last four");
  const apiError = "X API 403: your plan doesn't include follower lists";
  assert(
    Api.formatApiSyncError(403, { detail: "your plan doesn't include follower lists" }) === apiError,
    "API errors keep the status and the message"
  );
  assert(
    Api.formatApiSyncError(403, { errors: [{ message: "your plan doesn't include follower lists" }] }) ===
      apiError,
    "API errors read the errors array"
  );
  assert(
    Api.railErrorText({ apiSyncError: apiError, syncError: "Sync only found 1 of 10" }) === apiError,
    "the rail shows the API error"
  );
  assert(
    Api.railErrorText({ syncError: "Sign in on x.com in this tab, then run Sync." }) ===
      "Sign in on x.com in this tab, then run Sync.",
    "a session error still shows when there is no API error"
  );
  const probe = Api.keyProbeRequest("424242");
  assert(probe.path === "/2/users/424242/following", "test keys calls the following endpoint");
  assert(probe.params.max_results === 1, "test keys asks for one account");
  assert(
    Api.keyProbeVerdict({ ok: true, status: 200, json: { data: [] } }).message === "Keys work",
    "a successful probe says Keys work"
  );
  assert(
    Api.keyProbeVerdict({
      ok: false,
      status: 403,
      json: { detail: "your plan doesn't include follower lists" }
    }).message === apiError,
    "a failed probe reports the exact error"
  );
  assert(Api.isCrossSiteApiFailure({ ok: false, status: 0, text: "Load failed" }), "status 0 is a cross-site failure");
  assert(
    !Api.isCrossSiteApiFailure({ ok: false, status: 403, text: "Forbidden", json: { detail: "no" } }),
    "a real HTTP status is not treated as CORS"
  );
}

(async () => {
  const header = await Api.authorizationHeader({
    method: "POST",
    url: "https://api.twitter.com/1.1/statuses/update.json",
    params: {
      include_entities: "true",
      status: "Hello Ladies + Gentlemen, a signed OAuth request!"
    },
    keys: {
      apiKey: "xvz1evFS4wEEPTGEFPHBog",
      apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE"
    },
    nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    timestamp: "1318622958"
  });
  assert(header.indexOf("OAuth ") === 0, "API requests are OAuth-signed");
  assert(header.indexOf("oauth_consumer_key") !== -1, "header names the user's API key");
  assert(
    header.indexOf("hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D") !== -1,
    "signature matches the published OAuth 1.0a example"
  );
  assert(header.indexOf("kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw") === -1, "secret stays out of the header");
  assert(Route.SESSION_PAGE_GAP_MS >= 1000, "session pages wait at least a second");

  const calls = [];
  const proxied = await Api.fetchApiV2WithFallback(
    async () => {
      calls.push("content");
      return { ok: false, status: 0, text: "CORS", json: null, headers: {} };
    },
    async () => {
      calls.push("background");
      return { ok: true, status: 200, json: { data: [{ id: "1", username: "ada" }] }, text: "", headers: {} };
    }
  );
  assert(calls.join(",") === "content,background", "status 0 routes the API call through the background");
  assert(Api.keyProbeVerdict(proxied).message === "Keys work", "the background probe reports Keys work");

  const once = [];
  const denied = await Api.fetchApiV2WithFallback(
    async () => {
      once.push("content");
      return {
        ok: false,
        status: 403,
        json: { detail: "your plan doesn't include follower lists" },
        text: "",
        headers: {}
      };
    },
    async () => {
      once.push("background");
      return { ok: true, status: 200, json: {}, text: "", headers: {} };
    }
  );
  assert(once.join(",") === "content", "an API 403 is returned, not retried as CORS");
  assert(
    Api.keyProbeVerdict(denied).message === "X API 403: your plan doesn't include follower lists",
    "the 403 probe keeps the API message"
  );

  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(__dirname, "../content/content.js"), "utf8");
  const popup = fs.readFileSync(path.join(__dirname, "../popup/popup.html"), "utf8");
  const popupJs = fs.readFileSync(path.join(__dirname, "../popup/popup.js"), "utf8");
  const worker = fs.readFileSync(path.join(__dirname, "../background/service-worker.js"), "utf8");
  assert(!content.includes("API keys unavailable — using your x.com session"), "API errors are not a silent free-sync fallback");
  assert(!content.includes("API list incomplete — using your x.com session"), "an incomplete API list is not a silent free-sync fallback");
  assert(content.includes("apiSyncError"), "the API error is stored as apiSyncError");
  assert(content.includes("Sync free"), "the rail offers Sync free");
  assert(content.includes("Sync with API keys"), "the rail offers Sync with API keys");
  assert(!content.includes("X API keys cost money (X pay-per-use)"), "the rail does not say API keys cost money");
  assert(!content.includes("The free path still works."), "the rail does not repeat the free-path note");
  assert(content.includes("fetchApiV2WithFallback"), "content routes API calls through the fallback helper");
  assert(content.includes("XFO_API_FETCH"), "content asks the service worker to fetch api.x.com");
  assert(content.includes('data-xfo-sync="free"'), "Sync free is a rail button");
  assert(!content.includes(">Test keys<"), "the rail page does not host the key inputs");
  assert(!content.includes('type="password"'), "x.com's page has no key inputs to read");
  assert(content.includes('data-xfo-key-frame'), "the key form is an extension frame in the panel");
  assert(!content.includes('class="xfo-key-summary"'), "the rail does not render a Saved, ends in line");
  assert(!content.includes("Saved, ends in"), "the rail does not print a saved-key suffix");
  assert(content.includes('data-xfo-sync="api"'), "Sync with API keys stays in the panel");
  assert(worker.includes("XFO_API_FETCH"), "the service worker fetches API calls");
  assert(
    worker.includes("https:\\/\\/api\\.x\\.com\\/2\\/"),
    "the service worker only calls api.x.com/2/"
  );
  assert(popup.includes("Sync free"), "the popup offers Sync free");
  assert(popup.includes("Sync with API keys"), "the popup offers Sync with API keys");
  assert(popup.includes("Stays on this Mac, only sent to X."), "the popup uses the short key line");
  assert(!popup.includes("X API keys cost money (X pay-per-use)"), "the popup does not say API keys cost money");
  assert(!popup.includes("<summary>Advanced</summary>"), "the popup has no Advanced block");
  assert(!popup.includes("<summary>OAuth</summary>"), "the popup has no OAuth disclosure");
  assert(!popup.includes("<details"), "the popup has no tucked details block");
  assert(!popup.includes('name="apiKey"'), "the popup has no OAuth key fields");
  assert(popup.includes("X Bearer Token"), "the popup labels the bearer field");
  assert(
    popup.includes("From developer.x.com → your app → Keys and tokens"),
    "the popup shows where to find the bearer token"
  );
  assert(!popup.includes(">Test keys<"), "the popup has no Test keys button");
  assert(popup.includes(">Cancel<"), "the popup can cancel");
  assert(popup.includes('name="bearer"'), "the popup has the bearer field");
  assert(!popupJs.includes("savedKeyLabel"), "the popup does not show a Saved, ends in line");
  assert(popupJs.includes('input.value = keys[name]'), "a saved key is filled into the field");
  assert(popupJs.includes("XFO_TEST_KEYS"), "the popup runs the live key check");

  const frameHtml = fs.readFileSync(path.join(__dirname, "../popup/keys-frame.html"), "utf8");
  const frameJs = fs.readFileSync(path.join(__dirname, "../popup/keys-frame.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  const resources = (manifest.web_accessible_resources || [])[0].resources;
  assert(resources.indexOf("popup/keys-frame.html") !== -1, "the key form page is web accessible");
  assert(frameHtml.includes('name="bearer"'), "the key inputs live in the extension frame");
  assert(!frameHtml.includes('type="password"'), "the key frame has no password input");
  assert(!frameHtml.includes(">Test<"), "the frame has no Test button");
  assert(frameHtml.includes("Save and Sync"), "the frame can save and sync");
  assert(frameHtml.includes(">Cancel<"), "the frame can cancel");
  assert(!frameHtml.includes("Use saved key"), "the frame has no Use saved key button");
  assert(frameHtml.includes("Use free sync instead"), "the frame can switch to free sync");
  assert(
    frameHtml.includes("Stays on this Mac, only sent to X."),
    "the frame tells the user keys stay on this Mac"
  );
  assert(!frameHtml.includes("<summary>OAuth</summary>"), "the frame has no OAuth disclosure");
  assert(!frameHtml.includes("<details"), "the frame has no tucked details block");
  assert(!frameHtml.includes('name="apiKey"'), "the frame has no OAuth key fields");
  assert(frameHtml.includes("X Bearer Token"), "the frame labels the bearer field");
  assert(
    frameHtml.includes("From developer.x.com → your app → Keys and tokens"),
    "the frame shows where to find the bearer token"
  );
  assert(frameJs.indexOf("async function testKeys") === -1, "the frame has no separate Test action");
  assert(frameJs.indexOf("async function persistKeys") !== -1, "Save keys still persists");
  assert(/\[.keydown., .keypress., .keyup.\]\.forEach/.test(frameJs), "the frame listens for the shortcut keys");
  assert(frameJs.includes("stopPropagation"), "typing in the frame does not reach x.com shortcuts");
  assert(content.includes('document.addEventListener("keydown"'), "the panel also stops keys while the frame is focused");

  assert(popupJs.indexOf("async function probeKeys(") === -1, "the popup has no separate Test action");
  assert(!popupJs.includes("testKeysBtn"), "the popup has no Test keys button");
  assert(popupJs.includes('"Retry sync"'), "a stuck popup offers Retry sync");
  assert(content.includes('"Retry sync"'), "a stuck rail offers Retry sync");
  assert(content.includes("syncPrefer:"), "the free-or-API choice is written to storage");
  assert(/storageGet\(\[[\s\S]*?"syncPrefer"/.test(content), "the free-or-API choice is read back");
  assert(Route.normalizePrefer("free") === "session", "Sync free is stored as the session choice");
  assert(Route.normalizePrefer("API") === "api", "Sync with API keys is stored as the API choice");
  assert(!content.includes("tap Sync now"), "error copy no longer says Sync now");
  assert(!popupJs.includes("tap Sync now"), "the popup no longer says Sync now");
  const syncState = fs.readFileSync(path.join(__dirname, "../shared/sync-state.js"), "utf8");
  assert(!syncState.includes("tap Sync now"), "shared error copy no longer says Sync now");
  assert(syncState.includes("tap Retry sync"), "a timeout tells the user to tap Retry sync");
  assert(syncState.includes("tap Sync free"), "a rate limit tells the user to tap Sync free");
  console.log("All sync-route tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
