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
  console.log("All sync-route tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
