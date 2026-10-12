#!/usr/bin/env node
/**
 * Unit checks for shared/graphql-timeline.js — timeline payload parsing and
 * the GraphQL features / fieldToggles contract patching.
 */
const Timeline = require("../shared/graphql-timeline.js");
const Days = require("../shared/metrics-days.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const LEGACY_DATE = "Wed Oct 10 20:19:24 +0000 2018";

// --- walker: own posts only, cursor, dedupe, flat schema ------------------------
{
  const page = {
    data: {
      user: {
        result: {
          timeline: {
            instructions: [
              {
                entries: [
                  {
                    entryId: "tweet-1",
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            __typename: "Tweet",
                            rest_id: "10",
                            legacy: {
                              created_at: LEGACY_DATE,
                              id_str: "10",
                              quoted_status_result: {
                                result: { rest_id: "99", legacy: { created_at: LEGACY_DATE, id_str: "99" } }
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
                        tweetResult: {
                          result: {
                            rest_id: "11",
                            legacy: null,
                            created_at: "2026-05-01T12:00:00.000Z",
                            full_text: "flat 2026 schema"
                          }
                        }
                      }
                    }
                  },
                  {
                    entryId: "tweet-dup",
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: { rest_id: "10", legacy: { created_at: LEGACY_DATE, id_str: "10" } }
                        }
                      }
                    }
                  },
                  { entryId: "cursor-bottom-0", content: { value: "NEXT" } }
                ]
              }
            ]
          }
        }
      }
    }
  };
  const out = Timeline.walkGraphqlInstructions(page);
  const ids = out.tweets.map((t) => t.id).sort();
  assert(JSON.stringify(ids) === '["10","11"]', "walker keeps own posts once (" + ids + ")");
  assert(out.cursor === "NEXT", "walker finds the bottom cursor");
  assert(!ids.includes("99"), "quoted statuses are not counted as the user's posts");
  assert(Timeline.walkGraphqlInstructions(null).tweets.length === 0, "null page is empty");
}

// --- created time: legacy, flat, snowflake fallback -------------------------------
{
  const snow = "1788969391138000000";
  const fromSnow = Timeline.tweetCreatedAndId({ rest_id: snow, __typename: "Tweet" });
  assert(fromSnow && fromSnow.created === Timeline.snowflakeToMs(snow), "missing created_at falls back to the id");
  assert(Timeline.tweetCreatedAndId({}) === null, "non-tweet object is null");
  assert(isNaN(Timeline.snowflakeToMs("not-a-number")), "bad snowflake is NaN");
  const rest = Timeline.extractRestTimelineTweets([
    { id_str: "7", created_at: LEGACY_DATE },
    null,
    { id: "garbage" }
  ]);
  assert(rest.length === 1 && rest[0].id === "7", "REST timeline keeps parseable tweets only");
}

// --- contract: X's 400 names switches, we fill them with false -----------------
{
  const features = { keep_me: true, drop_me: true };
  const text =
    "The following features cannot be null: responsive_web_grok_bio_auto_translation_is_enabled, withNew";
  assert(Timeline.adjustFeaturesFromError(features, text) === true, "missing features are added");
  assert(features.responsive_web_grok_bio_auto_translation_is_enabled === false, "added as false");
  assert(features.withNew === false && features.keep_me === true, "existing switches are kept");
  assert(Timeline.adjustFeaturesFromError(features, text) === false, "second pass changes nothing");
  assert(
    Timeline.adjustFeaturesFromError(features, "features are unknown: drop_me") === true && !("drop_me" in features),
    "unknown switches are removed"
  );

  const feats = {};
  const toggles = { withArticlePlainText: false };
  const err = new Error("X GQL 400: The following fieldToggles cannot be null: withGrokAnalyze");
  err.missingFeatures = ["responsive_web_grok_annotations_enabled", "bad name!"];
  assert(Timeline.adjustContractFromError(feats, toggles, err) === true, "page-hook 400 patches the contract");
  assert(feats.responsive_web_grok_annotations_enabled === false, "names from the page hook are added");
  assert(!("bad name!" in feats), "only identifier-shaped names are accepted");
  assert(toggles.withGrokAnalyze === false, "field toggles named in the message are added");
  assert(Timeline.adjustContractFromError(feats, toggles, err) === false, "an already-patched contract is final");
  assert(Timeline.adjustContractFromError(feats, null, new Error("X GQL 500")) === false, "other errors are not retried");
}

// --- depthKey path of ingestTweetPage (what content.js actually passes) --------
{
  const now = Date.parse("2026-09-02T18:00:00-05:00");
  const day = 24 * 60 * 60 * 1000;
  const depthKey = Days.chicagoDaysAgoKey(now, 90);
  const days = {};
  const res = Days.ingestTweetPage(
    [
      { created: now, id: "300" },
      { created: now - 100 * day, id: "100" }
    ],
    days,
    { depthKey: depthKey }
  );
  assert(res.added === 1, "depthKey skips tweets older than the window");
  assert(res.newestId === "300", "newest id still advances");
  assert(res.reachedDepth === false, "a page with recent tweets has not reached depth");
  const old = Days.ingestTweetPage([{ created: now - 120 * day, id: "5" }], {}, { depthKey: depthKey });
  assert(old.reachedDepth === true && old.added === 0, "an all-old page reaches depth");
}

console.log("All graphql-timeline tests passed.");
