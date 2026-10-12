/**
 * X Follow Overlay — content script
 * 1) Syncs following/followers via the logged-in x.com session
 * 2) Draws relationship dots on avatars
 * 3) Relationship dots only — mutual, you follow, follows you, was mutual
 */

(() => {
  const XFO_VERSION = "1.2.3";
  if (window.__xfoVersion === XFO_VERSION) return;
  if (typeof window.__xfoCleanup === "function") {
    try {
      window.__xfoCleanup();
    } catch (e) {
      /* ignore */
    }
  }
  window.__xfoVersion = XFO_VERSION;

  const api = typeof browser !== "undefined" ? browser : chrome;
  const Theme = globalThis.XFOTheme;
  const Identity = globalThis.XFOSyncIdentity;
  const FollowRest = globalThis.XFOFollowRest;
  const MetricsRefill = globalThis.XFOMetricsRefill;
  const Passive = globalThis.XFOPassiveRelations;
  const ExMutual = globalThis.XFOExMutual;
  const Budget = globalThis.XFOMetricsBudget;
  const Route = globalThis.XFOSyncRoute;
  const XApi = globalThis.XFOApiKeys;
  const Days = globalThis.XFOMetricsDays;
  const Timeline = globalThis.XFOGraphqlTimeline;
  const {
    chicagoDateParts,
    dayKeyFromParts,
    shiftCivilDate,
    dayKeyFromMs,
    dayStartFromKey,
    chicagoDaysAgoKey,
    calendarDaysAgoStart,
    consWindowStart,
    periodBounds,
    oldestDayMs,
    activeDaysInWindow,
    postsInWindow,
    avgPerActiveDay,
    currentStreak,
    daysSinceLastPost,
    formatPace,
    pruneDays,
    mergeDayMaps,
    countsFromDays,
    dayMapTweetCount,
    idLessOrEqual,
    maxSnowflake,
    ingestTweetPage,
    isUsableMetricsEntry,
    isEmptyMetricsEntry
  } = Days;
  const {
    parseTweetCreatedAt,
    snowflakeToMs,
    extractScreenNameFromUser,
    unwrapTweetResult,
    tweetCreatedAndId,
    extractRestTimelineTweets,
    tweetBagFromNode,
    walkGraphqlInstructions,
    adjustFeaturesFromError,
    adjustContractFromError
  } = Timeline;
  const DOT_CLASS = "xfo-dot";
  const METRICS_CLASS = "xfo-metrics";
  // Public X web-client token (same value every browser session uses).
  const BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  // Page-hook messages stay on this document; never broadcast with "*".
  const MSG_ORIGIN =
    location.origin && location.origin !== "null" ? location.origin : "*";

  /**
   * A "page" is one API response (~20–40 tweets), not a profile screen.
   * Every page is one call out of X's ~50-per-15-minute window for that
   * GraphQL op, shared with x.com itself — so pages are the scarce resource.
   * Quick = fast first paint; deep = one bounded pass to finish the window.
   */
  const METRICS_MAX_PAGES = 8;
  const METRICS_QUICK_PAGES = 3;
  const METRICS_DEEP_PAGES = 12;
  const METRICS_PAGE_SIZE = 40;
  /** Pause between GraphQL pages inside one account (budget may stretch it). */
  const METRICS_PAGE_GAP_MS = 450;
  /** Consistency window for Avg pace (posts per active day). */
  const METRICS_CONS_DAYS = 30;
  /**
   * A crawl is complete once it covers the consistency window; only an
   * unbroken streak keeps paging past it, up to METRICS_DEPTH_DAYS.
   */
  const METRICS_CRAWL_DAYS = METRICS_CONS_DAYS;
  /** Day-map retention and the streak ceiling. */
  const METRICS_DEPTH_DAYS = 90;
  const METRICS_DAY_MS = 24 * 60 * 60 * 1000;
  const METRICS_CONS_MS = METRICS_CONS_DAYS * METRICS_DAY_MS;
  const METRICS_DEPTH_MS = METRICS_DEPTH_DAYS * METRICS_DAY_MS;
  const METRICS_ACCOUNT_TIMEOUT_MS = 90000;
  const METRICS_QUICK_TIMEOUT_MS = 15000;
  const METRICS_SOFT_REFRESH_MS = 12 * 60 * 60 * 1000;
  /** Empty (0-post) caches were sticking forever — retry periodically. */
  const METRICS_EMPTY_RETRY_MS = 15 * 60 * 1000;
  /** Min/default/max delay between accounts (ms). */
  const METRICS_GAP_MIN_MS = 1500;
  const METRICS_GAP_DEFAULT_MS = 2200;
  const METRICS_GAP_MAX_MS = 5 * 60 * 1000;
  /** Floor pause when X returns 429 / rate-limit toast. */
  const METRICS_RATE_LIMIT_FLOOR_MS = 90 * 1000;
  /** Bump to invalidate old D/W/M/Y-shaped caches / stuck empty completes. */
  const METRICS_CACHE_EPOCH = "40";
  /** Throttle Search so empty GraphQL does not stampede the session. */
  const METRICS_SEARCH_GAP_MS = 4000;
  const METRICS_SEARCH_WINDOW_MS = 5 * 60 * 1000;
  const METRICS_SEARCH_MAX_PER_WINDOW = 6;
  const METRICS_IDLE_SCAN_MS = 8000;
  /** Debounce rescans — X mutates the DOM constantly. */
  const SCAN_DEBOUNCE_MS = 350;
  /** Wait this long after the last scroll before scanning again. */
  const SCAN_SCROLL_SETTLE_MS = 180;
  /** Only decorate tweets near the viewport (px margin). */
  const SCAN_VIEW_MARGIN_PX = 900;
  /** Keep recently seen accounts in the queue briefly after they scroll off. */
  const METRICS_RECENT_MS = 90000;
  /** Alternate Days ↔ Avg under the badge. */
  const METRICS_FLIP_MS = 4000;

  const COLORS = {
    mutual: "#68e050",
    following: "#1d9bf0",
    follower: "#ffe600",
    ex_mutual: "#ff3b30"
  };

  const LABELS = {
    mutual: "Mutual",
    following: "You follow",
    follower: "Follows you",
    ex_mutual: "Was mutual"
  };

  // Baked-in GraphQL IDs (refreshed from page scripts / live fetches when stale).
  // Following/Followers are the last-resort sync path if REST v1.1 is dead.
  let gqlIds = {
    UserByScreenName: "Gb-d6r0vxPOADdG62OEBpQ",
    UserTweets: "V7H0Ap3_Hh2FyS75OCDO3Q",
    UserTweetsAndReplies: "FIFgycIi-CNJcV0R-135Uw",
    SearchTimeline: "hyPfJYJ_XAtDYoslQc-Rgg",
    Following: "qGZZDF3mp91q7X22s3HxpA",
    Followers: "JNyQdTISpzCkj_1fqxDvFg"
  };
  const GQL_ID_ALTS = {
    UserByScreenName: ["G3KGOASz96M-Qu0nwmGXNg"],
    UserTweets: ["SXVCYB8XHSS25nzIljNtZA", "6r5OLCC_wFH4CpRyXKuAmQ"],
    UserTweetsAndReplies: ["qUpkZU6eN8MbtQb7rC_pYg", "wc5DRl4VaW5lSqJ8YbftZQ"],
    SearchTimeline: ["Bcw3RzK-PatNAmbnw54hFw", "BGd0T_j7oVwlW5U79tO_0A"]
  };
  let gqlIdsRefreshedAt = 0;
  /** Live features / fieldToggles copied from X's own GraphQL calls. */
  const learnedGqlFeatures = {};
  const learnedGqlToggles = {};
  let metricsSearchAt = 0;
  const metricsSearchTimes = [];

  // Exact featureSwitches lists from the live x.com bundle. X returns
  // 400 "features cannot be null" when any required switch is missing.
  const USER_BY_SCREEN_FEATURES = {
    hidden_profile_subscriptions_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true
  };

  // UserTweets, UserTweetsAndReplies, Following and Followers all require
  // the same switch list in the current bundle.
  const USER_TWEETS_FEATURES = {
    rweb_video_screen_enabled: false,
    rweb_cashtags_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: false,
    rweb_cashtags_composer_attachment_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: true,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };

  /** Features for Following / Followers GraphQL timelines (same list). */
  const FOLLOW_GRAPHQL_FEATURES = USER_TWEETS_FEATURES;
  const USER_TWEETS_FIELD_TOGGLES = { withArticlePlainText: false };

  let cache = {
    following: new Set(),
    followers: new Set(),
    followingIds: new Set(),
    followerIds: new Set(),
    followingTotal: null,
    followersTotal: null,
    selfUsername: null,
    lastSyncAt: null,
    syncStatus: null,
    syncError: null,
    syncStartedAt: null
  };
  let lastFollowSnapshot = null;
  let lastSignedInOfficial = { following: null, followers: null };
  /** Relations X's own responses reported since the last sync (page hook). */
  let passiveStore = Passive ? Passive.createStore(null) : null;
  let passivePersistTimer = null;
  const PASSIVE_PERSIST_MS = 2000;
  /** Accounts that were mutual and then unfollowed him, while he still follows. */
  let exMutualSet = ExMutual ? ExMutual.createSet(null) : null;
  let exMutualHydrated = false;
  /** True when that side of the last saved sync was the previous snapshot. */
  let followListReuse = { following: false, followers: false };
  let exMutualPersistTimer = null;
  let exMutualGen = 0;
  const EX_MUTUAL_PERSIST_MS = 1500;
  /** What X last said about each GraphQL op's 15-minute window (page hook). */
  let budgetState = Budget ? Budget.create(null) : null;
  let budgetPersistTimer = null;
  const BUDGET_PERSIST_MS = 1500;

  /** @type {Map<string, {day:number,week:number,month:number,fetchedAt:number,days?:object,complete?:boolean}>} */
  const metricsMemory = new Map();
  /** @type {Map<string, string>} username -> userId */
  const userIdCache = new Map();
  /** @type {Map<string, {statusesCount:?number, protected:?boolean}>} */
  const userProfileCache = new Map();
  /** @type {string[]} ordered queue; front = highest priority */
  const metricsQueue = [];
  /** @type {Set<string>} */
  const metricsQueuedSet = new Set();
  /** @type {Set<string>} */
  const metricsInFlight = new Set();
  /** @type {Set<string>} */
  const metricsForced = new Set();
  /** Handles already given a deep page-budget pass this session. */
  const metricsDeepTried = new Set();
  let metricsPumpRunning = false;
  /** @type {"graphql"|"search"|null} */
  let metricsFetchMode = null; // kept for probe/debug; crawl no longer sticky-skips GraphQL
  /** Users that failed last time — retried first on the next Sync. */
  const metricsFailed = new Set();
  /** @type {Map<string, number>} per-handle attempts this counting run */
  const metricsAttempts = new Map();
  /** @type {Map<string, number>} handle -> last seen on screen (ms) */
  const metricsRecentlyVisible = new Map();
  let metricsGapMs = METRICS_GAP_DEFAULT_MS;
  let metricsPausedUntil = 0;
  /** Whether the current metrics pause is X's rate limit (vs. our retry backoff). */
  let metricsPauseIsRateLimit = false;
  let syncBackoffUntil = 0;
  let syncProgressCount = null;
  let syncProgressSide = "";
  let pageAbort = null;
  let pageInFlightSince = 0;
  let pageSilentRetries = 0;
  let pageInFlightCursor = null;
  let keysHintDismissed = false;
  let userHasApiKeys = false;
  let metricsHold = true;
  /** Set when a kick is requested during sync; flushed after sync / next scan. */
  let pendingVisibleMetricsKick = false;
  let syncAutoRetryTimer = null;
  let syncAutoRetries = 0;
  let allowSyncRetries = false;
  const SYNC_AUTO_RETRY_MAX = 1;
  const SYNC_BACKOFF_MS = 8000;
  const SYNC_BACKOFF_MAX_MS = 20000;
  let metricsRateLimitHits = 0;
  let metricsPersistTimer = null;
  let scanIdleCallbackId = null;

  let scanQueued = false;
  let scanTimer = null;
  let idleScanTimer = null;
  let observer = null;
  const Sync = globalThis.XFOSyncState;
  const RATE_LIMIT_ERROR =
    (Sync && Sync.RATE_LIMIT_ERROR) ||
    "X is rate-limiting. Wait a minute and tap Sync now.";
  let syncInFlight = null;
  let syncStartedAtLocal = 0;
  let lastSyncProgressAt = 0;
  let syncProgressLabel = "";
  let syncGeneration = 0;
  let syncAbort = null;
  let syncWatchdogTimer = null;
  const SYNC_HARD_TIMEOUT_MS = (Sync && Sync.HARD_MS) || 60000;
  /** @type {"days"|"avg"} */
  let metricsPhase = "days";
  let metricsFlipTimer = null;
  let resizeHandler = null;
  let scrollHandler = null;
  let scrollSettleTimer = null;
  let scrolling = false;
  let scanPendingAfterScroll = false;
  let lastPathname = location.pathname;
  let railHost = null;
  let railPanelHost = null;
  let railInsertBackoffUntil = 0;
  let railDocPointerDown = null;
  let railKeepPanelOnIcon = null;
  let pageHookMessageHandler = null;
  let storageChangedHandler = null;
  let rateLimitToastObserver = null;
  let rateLimitToastTimer = null;
  let rateLimitToastCheckTimer = null;

  window.__xfoCleanup = () => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (idleScanTimer) {
      clearInterval(idleScanTimer);
      idleScanTimer = null;
    }
    if (metricsFlipTimer) {
      clearInterval(metricsFlipTimer);
      metricsFlipTimer = null;
    }
    if (metricsPersistTimer) {
      clearTimeout(metricsPersistTimer);
      metricsPersistTimer = null;
      try {
        flushMetricsCacheToStorage();
      } catch (e) {
        /* ignore */
      }
    }
    if (scanIdleCallbackId != null && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(scanIdleCallbackId);
      scanIdleCallbackId = null;
    }
    if (resizeHandler) {
      window.removeEventListener("resize", resizeHandler);
      resizeHandler = null;
    }
    if (scrollHandler) {
      window.removeEventListener("scroll", scrollHandler, true);
      scrollHandler = null;
    }
    if (scrollSettleTimer) {
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = null;
    }
    if (syncWatchdogTimer) {
      clearInterval(syncWatchdogTimer);
      syncWatchdogTimer = null;
    }
    if (progressPersistTimer) {
      clearTimeout(progressPersistTimer);
      progressPersistTimer = null;
    }
    if (followHydrateTimer) {
      clearTimeout(followHydrateTimer);
      followHydrateTimer = null;
    }
    if (syncAutoRetryTimer) {
      clearTimeout(syncAutoRetryTimer);
      syncAutoRetryTimer = null;
    }
    if (syncAbort) {
      try {
        syncAbort.abort();
      } catch (e) {
        /* ignore */
      }
      syncAbort = null;
    }
    syncInFlight = null;
    if (window.__xfoRailDocClose) {
      document.removeEventListener("click", window.__xfoRailDocClose, true);
      window.__xfoRailDocClose = null;
    }
    if (railDocPointerDown) {
      document.removeEventListener("pointerdown", railDocPointerDown, true);
      railDocPointerDown = null;
    }
    if (railKeepPanelOnIcon) {
      window.removeEventListener("resize", railKeepPanelOnIcon);
      window.removeEventListener("scroll", railKeepPanelOnIcon, true);
      railKeepPanelOnIcon = null;
    }
    if (pageHookMessageHandler) {
      window.removeEventListener("message", pageHookMessageHandler);
      pageHookMessageHandler = null;
    }
    if (storageChangedHandler) {
      try {
        api.storage.onChanged.removeListener(storageChangedHandler);
      } catch (e) {
        /* extension context may already be gone */
      }
      storageChangedHandler = null;
    }
    if (rateLimitToastObserver) {
      rateLimitToastObserver.disconnect();
      rateLimitToastObserver = null;
    }
    if (rateLimitToastTimer) {
      clearInterval(rateLimitToastTimer);
      rateLimitToastTimer = null;
    }
    if (rateLimitToastCheckTimer) {
      clearTimeout(rateLimitToastCheckTimer);
      rateLimitToastCheckTimer = null;
    }
    if (passivePersistTimer) {
      clearTimeout(passivePersistTimer);
      passivePersistTimer = null;
    }
    if (exMutualPersistTimer) {
      clearTimeout(exMutualPersistTimer);
      exMutualPersistTimer = null;
    }
    if (budgetPersistTimer) {
      clearTimeout(budgetPersistTimer);
      budgetPersistTimer = null;
    }
    document.querySelectorAll("#xfo-rail, #xfo-rail-panel, .xfo-rail-panel").forEach((el) => {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    railHost = null;
    railPanelHost = null;
    scanQueued = false;
    scrolling = false;
    scanPendingAfterScroll = false;
  };

  function classifySynced(username, restId) {
    let relation;
    if (Identity && typeof Identity.classifyFollow === "function") {
      relation = Identity.classifyFollow(username, restId, cache);
    } else if (!username && !restId) {
      relation = "unknown";
    } else {
      const handle = username
        ? String(username).toLowerCase().replace(/^@/, "")
        : "";
      const self = (cache.selfUsername || "").toLowerCase();
      if (self && handle && handle === self) relation = "self";
      else {
        const id = restId ? String(restId) : "";
        const youFollow =
          (handle && cache.following.has(handle)) ||
          (id && cache.followingIds.has(id));
        const theyFollow =
          (handle && cache.followers.has(handle)) ||
          (id && cache.followerIds.has(id));
        if (youFollow && theyFollow) relation = "mutual";
        else if (youFollow) relation = "following";
        else if (theyFollow) relation = "follower";
        else relation = "neither";
      }
    }
    if (
      relation !== "self" &&
      relation !== "unknown" &&
      ExMutual &&
      typeof ExMutual.relationAfterReuse === "function"
    ) {
      relation = ExMutual.relationAfterReuse(
        relation,
        exMutualSet,
        username,
        restId,
        followListReuse
      );
    }
    return relation;
  }

  function writeExMutuals() {
    if (!ExMutual || !exMutualSet) return;
    const sent = exMutualGen;
    storageSet({ exMutuals: ExMutual.serialize(exMutualSet) }).then(
      () => {
        // A sync save bumped the generation while this write was in flight
        // and may have landed first. Write the set again so the stale copy
        // cannot be the one that survives reload.
        if (sent !== exMutualGen) writeExMutuals();
      },
      () => {}
    );
  }

  function scheduleExMutualPersist() {
    if (exMutualPersistTimer || !ExMutual || !exMutualSet) return;
    exMutualPersistTimer = setTimeout(() => {
      exMutualPersistTimer = null;
      writeExMutuals();
    }, EX_MUTUAL_PERSIST_MS);
  }

  function adoptExMutuals(raw) {
    if (!ExMutual) return;
    const loaded = ExMutual.createSet(raw);
    if (!exMutualHydrated) {
      const merged = ExMutual.union(loaded, exMutualSet);
      const dirty =
        JSON.stringify(ExMutual.serialize(merged)) !== JSON.stringify(ExMutual.serialize(loaded));
      exMutualSet = merged;
      exMutualHydrated = true;
      if (dirty) scheduleExMutualPersist();
      return;
    }
    if (exMutualPersistTimer) return;
    exMutualSet = loaded;
  }

  /**
   * Remember or clear a lost-mutual mark for the layered relationship.
   * Clears wait until storage has hydrated so an early scan cannot wipe it.
   */
  function applyExMutual(relation, username, restId) {
    if (!ExMutual || !exMutualSet || relation === "self" || relation === "unknown") {
      return relation;
    }
    const painted = ExMutual.paintClass(exMutualSet, relation, username, restId, {
      allowClear: exMutualHydrated
    });
    if (painted.changed) scheduleExMutualPersist();
    return painted.relation;
  }

  function noteExMutualChanges(ids) {
    if (!ExMutual || !exMutualSet || !ids || !ids.length) return;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const entry = passiveStore && passiveStore.byId ? passiveStore.byId[id] : null;
      const handle = entry && entry.h;
      const base = classifySynced(handle, id);
      if (base === "self" || base === "unknown") continue;
      let merged = base;
      if (Passive && passiveStore) {
        const rel = Passive.relationFor(passiveStore, handle, id, cache.lastSyncAt);
        if (rel) merged = Passive.mergeRelationship(base, rel);
      }
      applyExMutual(merged, handle, id);
    }
  }

  // Synced lists first; then whatever X itself said about this account in a
  // response newer than that sync (page hook harvest) overrides the
  // directions it knows. A new follower shows up as soon as X mentions them.
  // A mutual who then unfollows paints red (ex_mutual) instead of blue.
  function classify(username, restId) {
    const base = classifySynced(username, restId);
    let merged = base;
    if (Passive && passiveStore && base !== "self" && base !== "unknown") {
      const rel = Passive.relationFor(passiveStore, username, restId, cache.lastSyncAt);
      if (rel) merged = Passive.mergeRelationship(base, rel);
    }
    return applyExMutual(merged, username, restId);
  }

  /**
   * The synced class for an account, or null before any sync has landed
   * (then every observation is news and nothing is dropped as redundant).
   */
  function syncedClassFor(restId, username) {
    if (!cache.lastSyncAt) return null;
    const base = classifySynced(username, restId);
    return base === "self" || base === "unknown" ? null : base;
  }

  function schedulePassivePersist() {
    if (passivePersistTimer || !Passive || !passiveStore) return;
    passivePersistTimer = setTimeout(() => {
      passivePersistTimer = null;
      storageSet({ passiveRelations: Passive.serialize(passiveStore) }).catch(() => {});
    }, PASSIVE_PERSIST_MS);
  }

  function ingestPassiveRelations(msg) {
    if (!Passive || !passiveStore || !msg || !Array.isArray(msg.users)) return;
    const result = Passive.ingest(passiveStore, msg.users, {
      now: Date.now(),
      action: !!msg.action,
      selfHandle: cache.selfUsername,
      synced: syncedClassFor
    });
    for (let i = 0; i < result.idPairs.length; i++) {
      rememberUserId(result.idPairs[i].handle, result.idPairs[i].id);
    }
    if (!result.changed.length) return;
    noteExMutualChanges(result.changed);
    if (Passive.size(passiveStore) > Passive.MAX_ENTRIES) {
      passiveStore = Passive.prune(passiveStore, { max: Passive.MAX_ENTRIES });
    }
    schedulePassivePersist();
    queueScan();
  }

  function scheduleBudgetPersist() {
    if (budgetPersistTimer || !Budget || !budgetState) return;
    budgetPersistTimer = setTimeout(() => {
      budgetPersistTimer = null;
      storageSet({ metricsBudget: Budget.serialize(budgetState) }).catch(() => {});
    }, BUDGET_PERSIST_MS);
  }

  /** One GraphQL response's x-rate-limit-* window, ours or x.com's own. */
  function noteBudget(op, headers) {
    if (!Budget || !budgetState || !Budget.isOp(op)) return;
    Budget.note(budgetState, op, headers, Date.now());
    scheduleBudgetPersist();
  }

  function budgetWaitMs(op) {
    if (!Budget || !budgetState) return 0;
    return Budget.waitMs(budgetState, op, Date.now());
  }

  function budgetPageGapMs(op) {
    if (!Budget || !budgetState) return METRICS_PAGE_GAP_MS;
    return Budget.pageGapMs(budgetState, op, Date.now(), { minGap: METRICS_PAGE_GAP_MS });
  }

  function budgetHealthy(op, pages) {
    if (!Budget || !budgetState) return true;
    return Budget.healthy(budgetState, op, Date.now(), { pages: pages });
  }

  /**
   * A fallback op whose window is spent is skipped, not waited for: the
   * windows are per op (UserTweets is 50/15min, UserTweetsAndReplies 500),
   * so a spent fallback must not pause the pump while the primary has room.
   */
  function budgetSpent(op) {
    return budgetWaitMs(op) > 0;
  }

  /**
   * Before each page: stop instead of spending the window's last calls.
   * The pump treats the error like a 429 and sleeps until X's reset.
   */
  function throwIfBudgetSpent(op) {
    const wait = budgetWaitMs(op);
    if (wait <= 0) {
      if (Budget && budgetState) Budget.spend(budgetState, op, Date.now());
      return;
    }
    const err = new Error(
      "X GQL 429: " + op + " window spent — resets in " + Math.ceil(wait / 1000) + "s"
    );
    err.status = 429;
    err.budgetWaitMs = wait;
    throw err;
  }

  function asList(value) {
    if (FollowRest && typeof FollowRest.asList === "function") {
      return FollowRest.asList(value);
    }
    if (Sync && typeof Sync.asList === "function") return Sync.asList(value);
    return Array.isArray(value) ? value : [];
  }

  function rememberFollowSnapshot(data) {
    if (Sync && typeof Sync.followSnapshot === "function") {
      lastFollowSnapshot = Sync.followSnapshot(data, lastFollowSnapshot);
    } else {
      lastFollowSnapshot = data && typeof data === "object" ? data : lastFollowSnapshot;
    }
    if (!lastFollowSnapshot) return;
    if (Array.isArray(lastFollowSnapshot.following)) {
      cache.following = new Set(
        lastFollowSnapshot.following.map((u) => String(u).toLowerCase())
      );
    }
    if (Array.isArray(lastFollowSnapshot.followers)) {
      cache.followers = new Set(
        lastFollowSnapshot.followers.map((u) => String(u).toLowerCase())
      );
    }
    if (Array.isArray(lastFollowSnapshot.followingIds)) {
      cache.followingIds = new Set(
        lastFollowSnapshot.followingIds.map((id) => String(id))
      );
    }
    if (Array.isArray(lastFollowSnapshot.followerIds)) {
      cache.followerIds = new Set(
        lastFollowSnapshot.followerIds.map((id) => String(id))
      );
    }
    if (typeof lastFollowSnapshot.followingTotal === "number") {
      cache.followingTotal = lastFollowSnapshot.followingTotal;
    }
    if (typeof lastFollowSnapshot.followersTotal === "number") {
      cache.followersTotal = lastFollowSnapshot.followersTotal;
    }
    if (lastFollowSnapshot.selfUsername) {
      cache.selfUsername = lastFollowSnapshot.selfUsername;
    }
    if (lastFollowSnapshot.lastSyncAt) cache.lastSyncAt = lastFollowSnapshot.lastSyncAt;
    if (lastFollowSnapshot.syncStatus != null) {
      cache.syncStatus = lastFollowSnapshot.syncStatus;
    }
    if (lastFollowSnapshot.syncError !== undefined) {
      cache.syncError = lastFollowSnapshot.syncError;
    }
    if (lastFollowSnapshot.syncStartedAt !== undefined) {
      cache.syncStartedAt = lastFollowSnapshot.syncStartedAt;
    }
  }

  function snapshotFromCache() {
    return {
      following: Array.from(cache.following),
      followers: Array.from(cache.followers),
      followingIds: Array.from(cache.followingIds),
      followerIds: Array.from(cache.followerIds),
      followingTotal: cache.followingTotal,
      followersTotal: cache.followersTotal,
      selfUsername: cache.selfUsername,
      lastSyncAt: cache.lastSyncAt,
      syncStatus: cache.syncStatus,
      syncError: cache.syncError,
      syncStartedAt: cache.syncStartedAt
    };
  }

  async function loadCacheFromStorage() {
    let data = {};
    try {
      data = await storageGet([
        "following",
        "followers",
        "followingIds",
        "followerIds",
        "followingTotal",
        "followersTotal",
        "selfUsername",
        "lastSyncAt",
        "syncStatus",
        "syncError",
        "syncStartedAt",
        "metricsCache",
        "metricsFailed",
        "metricsCacheEpoch",
        "passiveRelations",
        "exMutuals",
        "followListReuse"
      ]);
    } catch (e) {
      return;
    }
    followListReuse = {
      following: !!(data.followListReuse && data.followListReuse.following),
      followers: !!(data.followListReuse && data.followListReuse.followers)
    };
    rememberFollowSnapshot(data);
    if (Passive) {
      // Storage lags the debounced flush; keep the newer copy of each entry.
      passiveStore = Passive.createStore(data.passiveRelations, passiveStore);
      // Older builds stored every sighting; keep only what differs from the sync.
      if (Passive.dropAgreeing(passiveStore, syncedClassFor, Date.now()) > 0) {
        schedulePassivePersist();
      }
    }
    adoptExMutuals(data.exMutuals);

    metricsFailed.clear();
    asList(data.metricsFailed).forEach((u) => {
      metricsFailed.add(String(u).toLowerCase());
    });

    // Drop bad shallow-complete counts from older builds.
    if (data.metricsCacheEpoch !== METRICS_CACHE_EPOCH) {
      metricsMemory.clear();
      try {
        await storageSet({
          metricsCache: {},
          metricsCacheEpoch: METRICS_CACHE_EPOCH
        });
      } catch (e) {
        /* ignore */
      }
      // Do not return with {} and no refill — that stuck Days-only after 1.1.14.
      kickVisibleMetrics(true);
      return;
    }

    const stored = data.metricsCache || {};
    const now = Date.now();
    Object.keys(stored).forEach((user) => {
      const entry = stored[user];
      if (entry && typeof entry.fetchedAt === "number") {
        const handle = String(user).toLowerCase();
        // This reload also runs from onChanged right after a sync, while a
        // fresh count may still be waiting on the debounced flush. Storage
        // is behind memory then; keep the newer entry.
        const inMemory = metricsMemory.get(handle);
        if (
          inMemory &&
          typeof inMemory.fetchedAt === "number" &&
          inMemory.fetchedAt > entry.fetchedAt
        ) {
          return;
        }
        const finalized = finalizeMetricsEntry(entry, now);
        metricsMemory.set(handle, finalized);
        // Keep retry list in sync with unusable cache entries.
        if (!isUsableMetricsEntry(finalized)) metricsFailed.add(handle);
      }
    });
  }

  async function persistFailedList() {
    try {
      await storageSet({ metricsFailed: Array.from(metricsFailed) });
    } catch (e) {
      /* ignore */
    }
  }

  async function markMetricsFailed(user) {
    const handle = String(user).toLowerCase();
    metricsFailed.add(handle);
    await persistFailedList();
  }

  async function clearMetricsFailed(user) {
    const handle = String(user).toLowerCase();
    if (!metricsFailed.has(handle)) return;
    metricsFailed.delete(handle);
    await persistFailedList();
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch (e) {
      return match[1];
    }
  }

  /**
   * The logged-in account's numeric id lives in the twid cookie
   * (twid="u=123456"). Free — avoids the UserByScreenName endpoint,
   * whose small quota the metrics crawler can exhaust.
   */
  function selfUserIdFromCookie() {
    if (Identity && typeof Identity.parseSelfUserIdFromTwid === "function") {
      return Identity.parseSelfUserIdFromTwid(getCookie("twid"));
    }
    const twid = getCookie("twid");
    if (!twid) return null;
    const m = String(twid).match(/u\s*=\s*(\d{3,})/);
    return m ? m[1] : null;
  }

  function isTransientMetricsError(message) {
    return /429|rate.?limit|over.?capacity|Try again|timed out|timeout|503|502|capacity/i.test(
      String(message || "")
    );
  }

  function isRateLimitError(message) {
    return /429|rate.?limit/i.test(String(message || ""));
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));
  }

  /** Gap between free-session GraphQL pages. 429 waits are separate and longer. */
  async function politeSessionPause() {
    const gap = (Route && Route.SESSION_PAGE_GAP_MS) || 1200;
    await sleepAwake(gap);
    throwIfSyncAborted();
  }

  /**
   * setTimeout is dropped when Safari freezes a background tab. On wake,
   * finish immediately if the deadline already passed.
   */
  function sleepAwake(ms) {
    const delay = Math.max(0, Number(ms) || 0);
    const started = Date.now();
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(finish, delay);
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVis);
        window.removeEventListener("pageshow", onVis);
        resolve();
      }
      function onVis() {
        if (document.visibilityState === "hidden") return;
        if (Date.now() - started >= delay) finish();
      }
      document.addEventListener("visibilitychange", onVis);
      window.addEventListener("pageshow", onVis);
    });
  }

  function syncStillCurrent() {
    return !!(syncAbort && syncAbort.signal && !syncAbort.signal.aborted);
  }

  function parseRetryAfterMs(res) {
    if (!res || !res.headers || typeof res.headers.get !== "function") return 0;
    const raw = res.headers.get("retry-after");
    if (!raw) return 0;
    const secs = Number(raw);
    if (!Number.isNaN(secs) && secs >= 0) return Math.ceil(secs * 1000);
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
    return 0;
  }

  /**
   * Pause activity metrics only — do not block follow-list sync.
   * suggestedMs > 0 is X's own reset time (headers / budget); sleeping any
   * less just repeats the 429. Without it, escalate the old way.
   */
  function noteRateLimit(suggestedMs, reason) {
    metricsRateLimitHits += 1;
    const exact = Number(suggestedMs) || 0;
    let wait;
    if (exact > 0) {
      wait = Math.min(exact, ((Budget && Budget.WINDOW_MS) || 900000) + 30000);
    } else {
      const floor =
        METRICS_RATE_LIMIT_FLOOR_MS *
        Math.min(4, Math.max(1, metricsRateLimitHits));
      wait = Math.min(
        METRICS_GAP_MAX_MS,
        Math.max(floor, metricsGapMs * 2, METRICS_RATE_LIMIT_FLOOR_MS)
      );
    }
    // The pause itself is the backoff; the between-account gap only needs a
    // nudge. Copying the pause into the gap used to drag the pump for an
    // hour after one 429.
    metricsGapMs = Math.min(
      METRICS_GAP_MAX_MS,
      Math.max(metricsGapMs, METRICS_GAP_DEFAULT_MS * 2)
    );
    metricsPausedUntil = Math.max(metricsPausedUntil, Date.now() + wait);
    metricsPauseIsRateLimit = true;
    storageSet({
      metricsLastError: reason || "rate limited — paused metrics crawl",
      metricsPausedUntil: metricsPausedUntil
    }).catch(() => {});
  }

  /** Exact pause for a rate-limit error, from X's headers or the budget. */
  function rateLimitWaitFromError(err) {
    if (!err) return 0;
    if (Number(err.budgetWaitMs) > 0) return Number(err.budgetWaitMs);
    if (err.rateLimitReset != null && Budget) {
      const at = Budget.resetToMs(err.rateLimitReset, Date.now());
      if (at) return Math.max(1000, at - Date.now() + 1500);
    }
    if (err.op) return budgetWaitMs(err.op);
    return 0;
  }

  function noteSyncBackoff(suggestedMs) {
    const wait = Math.min(
      SYNC_BACKOFF_MAX_MS,
      Math.max(SYNC_BACKOFF_MS, Number(suggestedMs) || 0)
    );
    syncBackoffUntil = Math.max(syncBackoffUntil, Date.now() + wait);
    metricsHold = true;
    metricsPausedUntil = Math.max(metricsPausedUntil, Date.now() + 120000);
  }

  async function waitForSyncBackoff(maxMs) {
    throwIfSyncAborted();
    const left = syncBackoffUntil - Date.now();
    if (left <= 0) return 0;
    const wait = Math.max(0, Math.min(left, maxMs == null ? left : maxMs));
    const end = Date.now() + wait;
    while (Date.now() < end) {
      throwIfSyncAborted();
      noteSyncProgress("Syncing…");
      await sleep(Math.min(1000, end - Date.now()));
    }
    return wait;
  }

  function scheduleRateLimitRetry() {
    if (syncAutoRetries >= SYNC_AUTO_RETRY_MAX) return;
    if (syncAutoRetryTimer) clearTimeout(syncAutoRetryTimer);
    const delay = Math.max(20000, syncBackoffUntil - Date.now() + 500);
    syncAutoRetryTimer = setTimeout(() => {
      syncAutoRetryTimer = null;
      if (syncInFlight) return;
      syncAutoRetries += 1;
      startSync(true).then(() => {
        const panel = railPanelHost || document.getElementById("xfo-rail-panel");
        if (panel && panel.classList.contains("xfo-open")) {
          refreshRailPanel(panel).catch(() => {});
        }
      });
    }, delay);
  }

  async function runWithRateLimitRetry(execOnce) {
    const maxAttempts = allowSyncRetries ? 3 : 1;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      throwIfSyncAborted();
      if (allowSyncRetries && attempt > 0) {
        await waitForSyncBackoff(SYNC_BACKOFF_MAX_MS);
      }
      try {
        return await execOnce();
      } catch (err) {
        lastErr = err;
        if (!isRateLimitError(err && err.message)) throw err;
        if (attempt >= maxAttempts - 1) {
          const wrapped = new Error(RATE_LIMIT_ERROR);
          wrapped.status = (err && err.status) || 429;
          if (err && typeof err === "object") {
            wrapped.retryAfter = err.retryAfter;
            wrapped.rateLimitReset = err.rateLimitReset;
            wrapped.budgetWaitMs = err.budgetWaitMs;
            wrapped.op = err.op;
          }
          throw wrapped;
        }
      }
    }
    throw lastErr;
  }

  function noteMetricsSuccess() {
    if (Date.now() < metricsPausedUntil) return;
    metricsRateLimitHits = Math.max(0, metricsRateLimitHits - 1);
    metricsGapMs = Math.max(
      METRICS_GAP_MIN_MS,
      Math.floor(metricsGapMs * 0.9)
    );
  }

  let followHydrateTimer = null;
  function scheduleFollowHydratePersist() {
    if (followHydrateTimer) return;
    followHydrateTimer = setTimeout(() => {
      followHydrateTimer = null;
      storageSet({
        following: Array.from(cache.following),
        followers: Array.from(cache.followers)
      }).catch(() => {});
    }, 800);
  }

  function rememberUserId(screenName, id) {
    if (!screenName || !id) return;
    const handle = String(screenName).toLowerCase().replace(/^@/, "");
    const sid = String(id);
    userIdCache.set(handle, sid);
    let changed = false;
    if (cache.followerIds.has(sid) && !cache.followers.has(handle)) {
      cache.followers.add(handle);
      changed = true;
    }
    if (cache.followingIds.has(sid) && !cache.following.has(handle)) {
      cache.following.add(handle);
      changed = true;
    }
    if (changed) scheduleFollowHydratePersist();
  }

  function rememberUserProfile(screenName, info) {
    const handle = String(screenName || "")
      .toLowerCase()
      .replace(/^@/, "");
    if (!handle || !info || typeof info !== "object") return;
    const prev = userProfileCache.get(handle) || {};
    const statusesCount =
      info.statusesCount != null ? info.statusesCount : prev.statusesCount;
    const prot = info.protected != null ? info.protected : prev.protected;
    userProfileCache.set(handle, {
      statusesCount: statusesCount,
      protected: prot
    });
  }

  function profileClearlyPosts(screenName) {
    const handle = String(screenName || "")
      .toLowerCase()
      .replace(/^@/, "");
    if (!handle) return false;
    const info = userProfileCache.get(handle);
    if (info && ((Number(info.statusesCount) || 0) > 0 || info.protected === true)) {
      return true;
    }
    // Timeline overlay only paints people whose tweets are on screen.
    if (metricsRecentlyVisible.has(handle)) return true;
    return false;
  }

  function withTimeout(promise, ms, label, abortCtrl) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (abortCtrl) {
          try {
            abortCtrl.abort();
          } catch (e) {
            /* ignore */
          }
        }
        reject(new Error(label + " timed out"));
      }, ms);
      promise.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  function storageTimeout() {
    return (Sync && Sync.STORAGE_MS) || 2000;
  }

  /**
   * Opt-in diagnostics. Most failures here are expected and recovered
   * silently (Safari storage hangs, X 429s, a missing page hook), so they are
   * only printed after running `localStorage.xfoDebug = "1"` in x.com's
   * console. Remove the key to turn it back off.
   */
  function debugEnabled() {
    try {
      return window.localStorage.getItem("xfoDebug") === "1";
    } catch (e) {
      return false;
    }
  }

  function debugLog(scope, detail) {
    if (!debugEnabled()) return;
    const text = detail && detail.message ? detail.message : detail;
    console.info("[X Follow Overlay] " + scope + ":", text, detail && detail.status ? "(HTTP " + detail.status + ")" : "");
  }

  function logged(scope, promise) {
    return promise.catch((err) => {
      debugLog(scope, err);
      throw err;
    });
  }

  async function storageGet(keys) {
    return logged(
      "storage read",
      withTimeout(api.storage.local.get(keys), storageTimeout(), "Read storage")
    );
  }

  async function storageSet(obj) {
    return logged(
      "storage write",
      withTimeout(api.storage.local.set(obj), storageTimeout(), "Write storage")
    );
  }

  async function storageRemove(keys) {
    return logged(
      "storage remove",
      withTimeout(api.storage.local.remove(keys), storageTimeout(), "Remove storage")
    );
  }

  /**
   * Written by builds that had a toolbar popup (or a status mirror for it)
   * and read by nothing since; cleared once per load so old installs shed them.
   */
  const RETIRED_STORAGE_KEYS = [
    "settings",
    "rateLimitedUntil",
    "metricsSyncTotal",
    "metricsSyncDone",
    "metricsSyncOk",
    "metricsSyncFail",
    "metricsSyncPending",
    "metricsSyncStatus",
    "metricsCurrentUser",
    "metricsFailedCount",
    "metricsProbe"
  ];

  function throwIfSyncAborted() {
    if (syncAbort && syncAbort.signal && syncAbort.signal.aborted) {
      throw new Error("Sync cancelled");
    }
  }

  let progressPersistTimer = null;
  let persistSyncProgress = true;
  function noteSyncProgress(label) {
    lastSyncProgressAt = Date.now();
    if (label) syncProgressLabel = label;
    if (!persistSyncProgress) return;
    if (progressPersistTimer) return;
    progressPersistTimer = setTimeout(() => {
      progressPersistTimer = null;
      if (!persistSyncProgress) return;
      storageSet({
        syncProgressLabel: syncProgressLabel,
        lastSyncProgressAt: lastSyncProgressAt,
        syncBackoffUntil: syncBackoffUntil || null,
        syncProgressCount: syncProgressCount,
        syncProgressSide: syncProgressSide || ""
      }).catch(() => {});
    }, 400);
  }

  function clearSyncProgress() {
    persistSyncProgress = false;
    if (progressPersistTimer) {
      clearTimeout(progressPersistTimer);
      progressPersistTimer = null;
    }
    syncProgressLabel = "";
  }

  function syncStillProgressing() {
    if (!syncInFlight || !lastSyncProgressAt) return false;
    if (Sync && typeof Sync.isStuck === "function") {
      return !Sync.isStuck({
        busy: true,
        busySince: syncStartedAtLocal,
        lastProgressAt: lastSyncProgressAt,
        syncStatus: "syncing",
        syncStartedAt: syncStartedAtLocal,
        progressLabel: syncProgressLabel,
        now: Date.now()
      });
    }
    return Date.now() - lastSyncProgressAt < 15000;
  }

  function abortSyncRun() {
    syncGeneration += 1;
    if (syncAbort) {
      try {
        syncAbort.abort();
      } catch (e) {
        /* ignore */
      }
    }
    syncAbort = null;
    syncInFlight = null;
  }

  function apiUrl(path, params) {
    const origin = (location && location.origin) || "https://x.com";
    let url = String(origin).replace(/\/$/, "") + path;
    const keys = Object.keys(params || {});
    if (!keys.length) return url;
    const parts = [];
    keys.forEach((k) => {
      if (params[k] === undefined || params[k] === null) return;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])));
    });
    return parts.length ? url + "?" + parts.join("&") : url;
  }

  async function xFetch(path, params, timeoutMs) {
    const csrf = getCookie("ct0");
    if (!csrf) throw new Error("Not logged in on x.com.");
    const wait = timeoutMs || (Sync && Sync.FETCH_MS) || 20000;

    return runWithRateLimitRetry(async () => {
      throwIfSyncAborted();
      const url = apiUrl(path, params);
      const ctrl = new AbortController();
      const onAbort = () => {
        try {
          ctrl.abort();
        } catch (e) {
          /* ignore */
        }
      };
      if (syncAbort && syncAbort.signal) {
        if (syncAbort.signal.aborted) throw new Error("Sync cancelled");
        syncAbort.signal.addEventListener("abort", onAbort, { once: true });
      }

      const res = await withTimeout(
        fetch(url, {
          credentials: "include",
          signal: ctrl.signal,
          headers: {
            authorization: "Bearer " + BEARER,
            "x-csrf-token": csrf,
            "x-twitter-auth-type": "OAuth2Session",
            "x-twitter-active-user": "yes",
            "x-twitter-client-language": "en",
            accept: "application/json"
          }
        }),
        wait,
        path,
        ctrl
      );

      if (!res.ok) {
        const text = await withTimeout(
          res.text().catch(() => ""),
          wait,
          path + " body"
        );
        if (res.status === 429 || /rate.?limit/i.test(text)) {
          if (allowSyncRetries) noteSyncBackoff(parseRetryAfterMs(res));
          else noteRateLimit(parseRetryAfterMs(res), "X API 429");
          const err429 = new Error("X API 429: rate limited");
          err429.status = 429;
          err429.retryAfter = res.headers && res.headers.get
            ? res.headers.get("retry-after")
            : null;
          err429.rateLimitReset = res.headers && res.headers.get
            ? res.headers.get("x-rate-limit-reset")
            : null;
          throw err429;
        }
        const err = new Error("X API " + res.status + ": " + text.slice(0, 120));
        err.status = res.status;
        throw err;
      }
      return withTimeout(res.json(), wait, path + " body");
    });
  }

  async function xGraphql(queryId, operationName, variables, features, externalSignal) {
    const csrf = getCookie("ct0");
    if (!csrf) throw new Error("Not logged in on x.com.");
    if (!queryId || !operationName) {
      throw new Error("Missing GraphQL query for " + (operationName || "unknown"));
    }

    return runWithRateLimitRetry(async () => {
      throwIfSyncAborted();
      // POST body avoids Safari rejecting very long GET GraphQL URLs
      // ("The string did not match the expected pattern").
      const origin = (location && location.origin) || "https://x.com";
      const url =
        String(origin).replace(/\/$/, "") +
        "/i/api/graphql/" +
        encodeURIComponent(queryId) +
        "/" +
        encodeURIComponent(operationName);

      const ctrl = new AbortController();
      const onAbort = () => {
        try {
          ctrl.abort();
        } catch (e) {
          /* ignore */
        }
      };
      if (syncAbort && syncAbort.signal) {
        if (syncAbort.signal.aborted) throw new Error("Sync cancelled");
        syncAbort.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (externalSignal) {
        if (externalSignal.aborted) {
          const stalled = new Error("page stalled");
          stalled.pageStall = true;
          throw stalled;
        }
        externalSignal.addEventListener("abort", onAbort, { once: true });
      }

      let res = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await withTimeout(
          fetch(url, {
            method: "POST",
            credentials: "include",
            signal: ctrl.signal,
            headers: {
              authorization: "Bearer " + BEARER,
              "x-csrf-token": csrf,
              "x-twitter-auth-type": "OAuth2Session",
              "x-twitter-active-user": "yes",
              "x-twitter-client-language": "en",
              accept: "application/json",
              "content-type": "application/json"
            },
            body: JSON.stringify({
              variables: variables || {},
              features: features || {}
            })
          }),
          (Sync && Sync.FETCH_MS) || 20000,
          operationName,
          ctrl
        );
        if (res.headers && typeof res.headers.get === "function") {
          noteBudget(operationName, {
            limit: res.headers.get("x-rate-limit-limit"),
            remaining: res.headers.get("x-rate-limit-remaining"),
            reset: res.headers.get("x-rate-limit-reset"),
            status: res.status
          });
        }
        if (res.ok) break;

        const text = await withTimeout(
          res.text().catch(() => ""),
          (Sync && Sync.FETCH_MS) || 20000,
          operationName + " body"
        );
        if (res.status === 429 || /rate.?limit/i.test(text)) {
          const err429 = new Error("X GQL 429: rate limited");
          err429.status = 429;
          err429.op = operationName;
          err429.retryAfter = res.headers && res.headers.get
            ? res.headers.get("retry-after")
            : null;
          err429.rateLimitReset = res.headers && res.headers.get
            ? res.headers.get("x-rate-limit-reset")
            : null;
          if (allowSyncRetries) noteSyncBackoff(parseRetryAfterMs(res));
          else noteRateLimit(rateLimitWaitFromError(err429), "X GQL 429");
          throw err429;
        }
        if (
          res.status === 400 &&
          attempt < 2 &&
          adjustFeaturesFromError(features, text)
        ) {
          continue;
        }
        throw new Error("X GQL " + res.status + ": " + text.slice(0, 160));
      }
      const json = await withTimeout(
        res.json(),
        (Sync && Sync.FETCH_MS) || 20000,
        operationName + " body"
      );
      if (json && Array.isArray(json.errors) && json.errors.length) {
        const msg = json.errors
          .map((e) => (e && e.message) || "GraphQL error")
          .join("; ");
        if (isRateLimitError(msg)) {
          const err429 = new Error("X GQL 429: rate limited");
          err429.status = 429;
          err429.op = operationName;
          err429.retryAfter =
            res && res.headers && res.headers.get ? res.headers.get("retry-after") : null;
          err429.rateLimitReset =
            res && res.headers && res.headers.get
              ? res.headers.get("x-rate-limit-reset")
              : null;
          if (allowSyncRetries) noteSyncBackoff(parseRetryAfterMs(res));
          else noteRateLimit(rateLimitWaitFromError(err429), "X GQL 429");
          throw err429;
        }
        const hasUser = json.data && json.data.user && json.data.user.result;
        if (!hasUser) throw new Error("X GQL: " + msg.slice(0, 160));
      }
      return json;
    });
  }

  function detectSelfUsername() {
    // Live DOM only. A stored handle is not a signed-in session.
    if (Identity && typeof Identity.detectSelfUsernameFromDom === "function") {
      return Identity.detectSelfUsernameFromDom(document, { location: location });
    }
    const profileLink =
      document.querySelector('a[data-testid="AppTabBar_Profile_Link"]') ||
      document.querySelector('a[href^="/"][aria-label*="Profile"]');
    if (profileLink) {
      return extractUsernameFromHref(profileLink.getAttribute("href") || "");
    }
    return null;
  }

  function uniqueLower(list) {
    return Array.from(new Set(asList(list).map((u) => String(u).toLowerCase())));
  }

  function numberOrNull(v) {
    if (FollowRest && typeof FollowRest.numberOrNull === "function") {
      return FollowRest.numberOrNull(v);
    }
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function coalesceCount(a, b, c) {
    const first = numberOrNull(a);
    if (first != null) return first;
    const second = numberOrNull(b);
    if (second != null) return second;
    return numberOrNull(c);
  }

  function countsFromUserNode(node) {
    if (FollowRest && typeof FollowRest.countsFromUserNode === "function") {
      return FollowRest.countsFromUserNode(node);
    }
    if (!node || typeof node !== "object") return { following: null, followers: null };
    const legacy = node.legacy && typeof node.legacy === "object" ? node.legacy : {};
    const core = node.core && typeof node.core === "object" ? node.core : {};
    const following =
      numberOrNull(legacy.friends_count) ??
      numberOrNull(core.friends_count) ??
      numberOrNull(node.friends_count);
    const followers =
      numberOrNull(legacy.followers_count) ??
      numberOrNull(core.followers_count) ??
      numberOrNull(node.followers_count);
    return { following: following, followers: followers };
  }

  function countsFromProfileDom(screenName) {
    if (FollowRest && typeof FollowRest.countsFromProfileDom === "function") {
      return FollowRest.countsFromProfileDom(document, screenName);
    }
    const handle = String(screenName || "")
      .toLowerCase()
      .replace(/^@/, "");
    if (!handle) return { following: null, followers: null };
    let following = null;
    let followers = null;
    const links = document.querySelectorAll("a[href]");
    for (let i = 0; i < links.length; i++) {
      const href = (links[i].getAttribute("href") || "").split("?")[0].toLowerCase();
      const text = links[i].textContent || "";
      const m = text.replace(/,/g, "").match(/([\d.]+)\s*(k|m)?/i);
      if (!m) continue;
      let n = parseFloat(m[1]);
      if (Number.isNaN(n)) continue;
      const suffix = (m[2] || "").toLowerCase();
      if (suffix === "k") n *= 1000;
      if (suffix === "m") n *= 1000000;
      n = Math.round(n);
      const path = href.replace(/\/$/, "");
      if (path === "/" + handle + "/following" && /following/i.test(text)) {
        following = n;
      }
      if (path === "/" + handle + "/followers" && /follower/i.test(text)) {
        followers = n;
      }
    }
    return { following: following, followers: followers };
  }

  /**
   * Follow-list GraphQL from the isolated world is missing
   * x-client-transaction-id. page-hook.js issues those requests via the
   * page's window.fetch so X can attach the header. Sync now never
   * navigates to Following/Followers or scrolls those lists.
   */
  const pageGraphUsers = {
    Following: new Set(),
    Followers: new Set()
  };
  const pageGqlPending = new Map();
  const pageRestPending = new Map();
  let pageGqlSeq = 0;
  let pageRestSeq = 0;

  function injectPageHook() {
    if (document.documentElement.getAttribute("data-xfo-hook") === "1") {
      return;
    }
    if (document.getElementById("xfo-page-hook")) return;
    try {
      const s = document.createElement("script");
      s.id = "xfo-page-hook";
      s.src = api.runtime.getURL("content/page-hook.js");
      s.onload = function () {
        if (s.parentNode) s.parentNode.removeChild(s);
      };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      // Isolated-world REST / GraphQL still run without the hook.
      debugLog("page hook inject", e);
    }
  }

  function pageHookReady() {
    return document.documentElement.getAttribute("data-xfo-hook") === "1";
  }

  async function waitForPageHook(ms) {
    injectPageHook();
    const end = Date.now() + (ms || 2500);
    while (Date.now() < end) {
      if (pageHookReady()) return true;
      await sleep(50);
    }
    return pageHookReady();
  }

  pageHookMessageHandler = (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== "xfo-page-hook") return;
    if (d.type === "XFO_GQL_LEARN") {
      if (d.operationName && d.queryId && gqlIds[d.operationName] !== undefined) {
        gqlIds[d.operationName] = String(d.queryId);
      }
      return;
    }
    if (d.type === "XFO_GQL_FEATURES") {
      rememberGqlContract(d.operationName, d.features, d.fieldToggles);
      return;
    }
    if (d.type === "XFO_RELATIONS") {
      ingestPassiveRelations(d);
      return;
    }
    if (d.type === "XFO_RATE") {
      noteBudget(d.op, {
        limit: d.limit,
        remaining: d.remaining,
        reset: d.reset,
        status: d.status
      });
      return;
    }
    if (d.type === "XFO_GQL_RESULT") {
      const pending = pageGqlPending.get(d.id);
      if (!pending) return;
      pageGqlPending.delete(d.id);
      clearTimeout(pending.timer);
      noteBudget(pending.op, {
        limit: d.rateLimitLimit,
        remaining: d.rateLimitRemaining,
        reset: d.rateLimitReset,
        status: d.ok ? 200 : d.status
      });
      if (d.ok) pending.resolve(d.json);
      else {
        const err = new Error(d.error || "Page GraphQL failed");
        err.status = d.status;
        err.op = pending.op;
        err.retryAfter = d.retryAfter;
        err.rateLimitReset = d.rateLimitReset;
        err.missingFeatures = Array.isArray(d.missingFeatures) ? d.missingFeatures : null;
        err.missingFieldToggles = Array.isArray(d.missingFieldToggles)
          ? d.missingFieldToggles
          : null;
        pending.reject(err);
      }
      return;
    }
    if (d.type === "XFO_REST_RESULT") {
      const pending = pageRestPending.get(d.id);
      if (!pending) return;
      pageRestPending.delete(d.id);
      clearTimeout(pending.timer);
      if (d.error && !d.status) {
        pending.reject(new Error(d.error));
        return;
      }
      pending.resolve({
        ok: !!d.ok,
        status: d.status || 0,
        json: d.json,
        text: d.text || d.error || "",
        headers: {
          "retry-after": d.retryAfter,
          "x-rate-limit-reset": d.rateLimitReset
        }
      });
      return;
    }
    const bucket = pageGraphUsers[d.op];
    if (!bucket) return;
    const parsed = walkGraphqlUsers(d.json);
    for (let i = 0; i < parsed.users.length; i++) bucket.add(parsed.users[i]);
  };
  window.addEventListener("message", pageHookMessageHandler);

  async function pageGraphql(queryId, operationName, variables, features, fieldToggles, signal) {
    if (signal && signal.aborted) {
      const stalled = new Error(operationName + " stalled");
      stalled.pageStall = true;
      throw stalled;
    }
    if (!(await waitForPageHook(2500))) {
      throw new Error("Page hook not ready");
    }
    const id = ++pageGqlSeq;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        const err = new Error(operationName + " timed out");
        if (signal) err.pageStall = true;
        fail(err);
      }, (Sync && Sync.FETCH_MS) || 20000);
      function fail(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pageGqlPending.delete(id);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      }
      function onAbort() {
        const err = new Error(operationName + " stalled");
        err.pageStall = true;
        fail(err);
      }
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      pageGqlPending.set(id, {
        resolve: function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: fail,
        timer: timer,
        op: operationName
      });
      try {
        window.postMessage(
          {
            source: "xfo-content",
            type: "XFO_GQL",
            id: id,
            queryId: queryId,
            operationName: operationName,
            variables: variables || {},
            features: features || {},
            fieldToggles: fieldToggles || null
          },
          MSG_ORIGIN
        );
      } catch (e) {
        fail(e);
      }
    });
  }

  async function pageRest(path, params) {
    if (!(await waitForPageHook(2500))) {
      throw new Error("Page hook not ready");
    }
    const id = ++pageRestSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pageRestPending.delete(id);
        reject(new Error(path + " timed out"));
      }, (Sync && Sync.FETCH_MS) || 20000);
      pageRestPending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        window.postMessage(
          {
            source: "xfo-content",
            type: "XFO_REST",
            id: id,
            path: path,
            params: params || {}
          },
          MSG_ORIGIN
        );
      } catch (e) {
        clearTimeout(timer);
        pageRestPending.delete(id);
        reject(e);
      }
    });
  }

  function headerBag(retryAfter, rateLimitReset) {
    const headers = {};
    if (retryAfter != null) headers["retry-after"] = retryAfter;
    if (rateLimitReset != null) headers["x-rate-limit-reset"] = rateLimitReset;
    return headers;
  }

  async function isolatedRest(path, params) {
    const csrf = getCookie("ct0");
    if (!csrf) throw new Error("Not logged in on x.com.");
    const wait = (Sync && Sync.FETCH_MS) || 20000;
    const url = apiUrl(path, params);
    const ctrl = new AbortController();
    const res = await withTimeout(
      fetch(url, {
        credentials: "include",
        signal: ctrl.signal,
        headers: {
          authorization: "Bearer " + BEARER,
          "x-csrf-token": csrf,
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-active-user": "yes",
          "x-twitter-client-language": "en",
          accept: "application/json"
        }
      }),
      wait,
      path,
      ctrl
    );
    const text = await withTimeout(res.text().catch(() => ""), wait, path + " body");
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (e) {
        json = null;
      }
    }
    return {
      ok: !!res.ok,
      status: res.status,
      json: json,
      text: String(text || "").slice(0, 240),
      headers: headerBag(
        res.headers && res.headers.get && res.headers.get("retry-after"),
        res.headers && res.headers.get && res.headers.get("x-rate-limit-reset")
      )
    };
  }

  async function restRequest(path, params) {
    throwIfSyncAborted();
    try {
      return await pageRest(path, params);
    } catch (err) {
      return isolatedRest(path, params);
    }
  }

  function makeRestClient() {
    return {
      request: restRequest,
      async requestV2(path, params, token) {
        const url = new URL(path, "https://api.x.com");
        const query = {};
        Object.keys(params || {}).forEach((k) => {
          if (params[k] !== undefined && params[k] !== null) {
            query[k] = String(params[k]);
            url.searchParams.set(k, query[k]);
          }
        });
        let authorization = "";
        if (token && typeof token === "object") {
          if (!XApi || typeof XApi.authorizationHeader !== "function") {
            return {
              ok: false,
              status: 0,
              json: null,
              text: "API signer missing",
              headers: {}
            };
          }
          authorization = await XApi.authorizationHeader({
            method: "GET",
            url: url.origin + url.pathname,
            params: query,
            keys: token
          });
        } else if (token) {
          authorization = "Bearer " + token;
        } else {
          return {
            ok: false,
            status: 401,
            json: null,
            text: "no user token",
            headers: {}
          };
        }
        try {
          const res = await fetch(url.toString(), {
            credentials: "omit",
            headers: {
              authorization: authorization,
              accept: "application/json"
            }
          });
          const text = await res.text().catch(() => "");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (e) {
            json = null;
          }
          return {
            ok: !!res.ok,
            status: res.status,
            json: json,
            text: String(text || "").slice(0, 240),
            headers: headerBag(
              res.headers && res.headers.get && res.headers.get("retry-after"),
              res.headers && res.headers.get && res.headers.get("x-rate-limit-reset")
            )
          };
        } catch (e) {
          return {
            ok: false,
            status: 0,
            json: null,
            text: e && e.message ? e.message : String(e),
            headers: {}
          };
        }
      },
      async wait(ms) {
        await waitOutBackoff(ms, syncProgressCount, syncProgressSide);
      },
      noteProgress(label) {
        noteSyncProgress(label);
      },
      throwIfAborted() {
        throwIfSyncAborted();
      },
      async saveIdMap(map) {
        try {
          await storageSet({ followIdMap: map || {} });
        } catch (e) {
          /* in-memory map still used */
        }
      }
    };
  }

  async function readStoredApiKeys() {
    const names =
      (XApi && XApi.STORAGE_KEYS) || [
        "xApiKey",
        "xApiSecret",
        "xAccessToken",
        "xAccessSecret",
        "xApiBearer",
        "xUserToken",
        "xBearerToken",
        "xApiUserToken"
      ];
    try {
      const data = await storageGet(names);
      if (XApi && typeof XApi.keysFromStorage === "function") {
        return XApi.keysFromStorage(data);
      }
      return {};
    } catch (e) {
      return {};
    }
  }

  async function currentSyncRoute() {
    const keys = await readStoredApiKeys();
    if (Route && typeof Route.chooseSyncRoute === "function") {
      return Route.chooseSyncRoute({
        ct0: getCookie("ct0"),
        twid: getCookie("twid"),
        keys: keys
      });
    }
    const userId = selfUserIdFromCookie();
    if (!getCookie("ct0") || !userId) {
      return {
        ok: false,
        path: null,
        userId: null,
        reason: "Sign in on x.com in this tab, then run Sync."
      };
    }
    return { ok: true, path: "session", userId: userId, reason: "" };
  }

  function flagMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return Object.keys(value).length ? value : null;
  }

  function rememberGqlContract(op, features, fieldToggles) {
    if (!op || gqlIds[op] === undefined) return;
    const feats = flagMap(features);
    const toggles = flagMap(fieldToggles);
    if (feats) learnedGqlFeatures[op] = feats;
    if (toggles) learnedGqlToggles[op] = toggles;
  }

  async function graphqlFollow(queryId, operationName, variables, features, fieldToggles, signal) {
    const feats = learnedGqlFeatures[operationName] || features;
    const toggles = learnedGqlToggles[operationName] || fieldToggles;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal && signal.aborted) {
        const stalled = new Error("page stalled");
        stalled.pageStall = true;
        throw stalled;
      }
      try {
        return await pageGraphql(queryId, operationName, variables, feats, toggles, signal);
      } catch (err) {
        lastErr = err;
        if (err && err.pageStall) throw err;
        // X named a missing switch. Patch the contract and retry this call.
        // Any other HTTP answer is final — the isolated world would only
        // spend the window again.
        if (
          err &&
          err.status === 400 &&
          attempt < 2 &&
          adjustContractFromError(feats, toggles, err)
        ) {
          continue;
        }
        if (err && err.status) throw err;
        break;
      }
    }
    if (signal && signal.aborted) {
      const stalled = new Error("page stalled");
      stalled.pageStall = true;
      throw stalled;
    }
    try {
      return await xGraphql(queryId, operationName, variables, feats, signal);
    } catch (err2) {
      if ((signal && signal.aborted) || (err2 && err2.pageStall)) {
        const stalled = new Error("page stalled");
        stalled.pageStall = true;
        throw stalled;
      }
      throw lastErr || err2;
    }
  }

  function rememberGraphqlId(operationName, queryId) {
    if (!operationName || !queryId || gqlIds[operationName] === undefined) return;
    gqlIds[operationName] = String(queryId);
  }

  function queryIdsForOp(op) {
    const primary = gqlIds[op];
    const alts = GQL_ID_ALTS[op] || [];
    const out = [];
    const seen = new Set();
    [primary].concat(alts).forEach((id) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    });
    return out;
  }

  async function ensureFreshGraphqlIds(force) {
    if (!force && gqlIdsRefreshedAt && Date.now() - gqlIdsRefreshedAt < 10 * 60 * 1000) {
      return;
    }
    await refreshGraphqlIdsFromPage();
    gqlIdsRefreshedAt = Date.now();
  }

  function listLooksComplete(got, expected, previous, opts) {
    if (Identity && typeof Identity.listLooksComplete === "function") {
      return Identity.listLooksComplete(got, expected, previous, opts);
    }
    const handles = asList(got).length;
    const ids = opts && opts.ids != null ? asList(opts.ids).length : 0;
    const membership = Math.max(ids, handles);
    const target = Math.max(Number(expected) || 0, asList(previous).length);
    if (membership <= 0) return false;
    if (target < 20) return true;
    if (membership >= target) return true;
    if (!opts || !opts.exhausted) return false;
    const gap = Math.max(0, Number(opts.confirmedGap) || 0);
    // Mirror of Identity.exhaustedListShortfall: a cursor that reached 0 is
    // trusted up to a quarter of the target.
    return (
      target - membership <=
      Math.max(Math.max(15, 0.02 * target) + gap, 0.25 * target)
    );
  }

  function pruneLiveIdMap(map, followingIds, followerIds) {
    if (FollowRest && typeof FollowRest.pruneIdMap === "function") {
      return FollowRest.pruneIdMap(
        map || {},
        uniqueIdsList(asList(followingIds).concat(asList(followerIds)))
      );
    }
    return map || {};
  }

  async function fetchSelfUsernameFromSession(userId) {
    try {
      const data = await xFetch("/i/api/1.1/account/verify_credentials.json", {
        skip_status: true
      });
      if (data && data.screen_name) {
        if (FollowRest && typeof FollowRest.countsFromRestUser === "function") {
          lastSignedInOfficial = FollowRest.mergeOfficialCounts(
            lastSignedInOfficial,
            FollowRest.countsFromRestUser(data)
          );
        }
        return String(data.screen_name).toLowerCase();
      }
    } catch (e) {
      /* try the next session endpoint */
    }
    try {
      const data = await xFetch("/i/api/1.1/account/settings.json", {});
      if (data && data.screen_name) return String(data.screen_name).toLowerCase();
    } catch (e2) {
      /* try twid lookup */
    }
    if (userId) {
      try {
        const data = await xFetch("/i/api/1.1/users/show.json", { user_id: userId });
        if (data && data.screen_name) {
          if (FollowRest && typeof FollowRest.countsFromRestUser === "function") {
            lastSignedInOfficial = FollowRest.mergeOfficialCounts(
              lastSignedInOfficial,
              FollowRest.countsFromRestUser(data)
            );
          }
          return String(data.screen_name).toLowerCase();
        }
      } catch (e3) {
        /* fall through */
      }
    }
    return null;
  }

  async function resolveSelfIdentity(route) {
    const userId = route && route.userId ? String(route.userId) : null;
    if (!userId) {
      throw new Error(
        (Route && Route.NO_SESSION_REASON) ||
          "Sign in on x.com in this tab, then run Sync."
      );
    }
    noteSyncProgress("Finding your account…");
    let username = detectSelfUsername();
    if (!username) {
      username = await fetchSelfUsernameFromSession(userId);
    }
    if (!username) {
      throw new Error(
        "Could not detect your username. Sign in on x.com in this tab, then run Sync."
      );
    }
    username = String(username).toLowerCase().replace(/^@/, "");
    rememberUserId(username, userId);
    cache.selfUsername = username;
    try {
      await storageSet({ selfUsername: username });
    } catch (e) {
      /* rail can still show the signed-in username */
    }
    return { username: username, userId: userId };
  }

  function walkGraphqlUsers(data) {
    const users = [];
    const ids = [];
    const seen = new Set();
    const seenIds = new Set();
    let bottomCursor = null;

    function considerUser(node) {
      if (!node || typeof node !== "object") return;
      if (node.__typename && node.__typename !== "User") return;
      const handle = extractScreenNameFromUser(node);
      const restId =
        node.rest_id || (node.legacy && node.legacy.id_str) || null;
      if (restId) {
        const sid = String(restId);
        if (!seenIds.has(sid)) {
          seenIds.add(sid);
          ids.push(sid);
        }
        if (handle) rememberUserId(handle, sid);
      }
      if (!handle) return;
      if (seen.has(handle)) return;
      seen.add(handle);
      users.push(handle);
    }

    function visit(node, depth) {
      if (!node || depth > 30) return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) visit(node[i], depth + 1);
        return;
      }
      if (typeof node !== "object") return;

      if (node.cursorType === "Bottom" && node.value) {
        bottomCursor = node.value;
      }
      if (
        node.entryId &&
        String(node.entryId).indexOf("cursor-bottom") === 0 &&
        node.content &&
        node.content.value
      ) {
        bottomCursor = node.content.value;
      }

      if (
        node.__typename === "User" ||
        (node.rest_id && (node.core || node.legacy))
      ) {
        considerUser(node);
      }
      if (node.user_results && node.user_results.result) {
        considerUser(node.user_results.result);
      }
      if (node.result && node.result.__typename === "User") {
        considerUser(node.result);
      }

      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (
          k === "legacy" ||
          k === "core" ||
          k === "entities" ||
          k === "privacy"
        ) {
          continue;
        }
        visit(node[k], depth + 1);
      }
    }

    visit(data, 0);
    return { users, ids, cursor: bottomCursor };
  }

  async function writeGraphqlCheckpoint(side, userId, users, cursor, ids) {
    try {
      await storageSet({
        syncCheckpoint: {
          path: "graphql",
          side: side,
          userId: userId ? String(userId) : null,
          users: users.slice(),
          ids: asList(ids).slice(),
          cursor: cursor || null,
          updatedAt: Date.now()
        }
      });
    } catch (e) {
      // The next Sync now can still start fresh.
      debugLog("sync checkpoint", e);
    }
  }

  async function clearGraphqlCheckpoint() {
    try {
      await storageSet({ syncCheckpoint: null });
    } catch (e) {
      /* ignore */
    }
  }

  function backoffMsForError(err) {
    const source = {
      retryAfter: err && err.retryAfter,
      rateLimitReset: err && err.rateLimitReset,
      budgetWaitMs:
        (err && Number(err.budgetWaitMs)) || rateLimitWaitFromError(err) || 0
    };
    if (FollowRest && typeof FollowRest.backoffMsFromRateLimit === "function") {
      return FollowRest.backoffMsFromRateLimit(source, Date.now());
    }
    return 60000;
  }

  async function waitOutBackoff(waitMs, count, side) {
    const ms = Math.max(0, Number(waitMs) || 0);
    const end = Date.now() + ms;
    syncBackoffUntil = end;
    if (count != null) syncProgressCount = count;
    if (side) syncProgressSide = side;
    const label =
      Sync && typeof Sync.backoffStatusText === "function"
        ? Sync.backoffStatusText({
            resumeAt: end,
            now: Date.now(),
            count: syncProgressCount,
            side: syncProgressSide
          })
        : "Waiting for x.com rate limit…";
    noteSyncProgress(label);
    try {
      await storageSet({
        syncBackoffUntil: end,
        syncProgressLabel: syncProgressLabel,
        lastSyncProgressAt: lastSyncProgressAt,
        syncProgressCount: syncProgressCount,
        syncProgressSide: syncProgressSide || ""
      });
    } catch (e) {
      /* the in-memory countdown still ticks */
    }
    try {
      while (Date.now() < end) {
        if (!syncStillCurrent()) throw new Error("Sync cancelled");
        noteSyncProgress(
          Sync && typeof Sync.backoffStatusText === "function"
            ? Sync.backoffStatusText({
                resumeAt: end,
                now: Date.now(),
                count: syncProgressCount,
                side: syncProgressSide
              })
            : label
        );
        const left = end - Date.now();
        if (left <= 0) break;
        await sleepAwake(Math.min(1000, left));
      }
    } finally {
      syncBackoffUntil = 0;
      storageSet({ syncBackoffUntil: null }).catch(() => {});
    }
  }

  function abortInFlightPage() {
    const ctrl = pageAbort;
    if (!ctrl) return;
    try {
      ctrl.abort();
    } catch (e) {
      /* ignore */
    }
  }

  function checkPageWatchdog() {
    if (!pageInFlightSince || !pageAbort) return;
    if (!Sync || typeof Sync.pageWatchdog !== "function") return;
    const decision = Sync.pageWatchdog({
      now: Date.now(),
      lastProgressAt: pageInFlightSince,
      backoffUntil: syncBackoffUntil,
      silentRetries: pageSilentRetries,
      cursor: pageInFlightCursor
    });
    if (decision.action === "retry-page" || decision.action === "fail") {
      abortInFlightPage();
    }
  }

  async function fetchFollowPage(queryId, op, variables, cursor) {
    const ctrl = new AbortController();
    pageAbort = ctrl;
    pageInFlightSince = Date.now();
    pageInFlightCursor = cursor || null;
    const onSyncAbort = () => abortInFlightPage();
    if (syncAbort && syncAbort.signal) {
      if (syncAbort.signal.aborted) ctrl.abort();
      else syncAbort.signal.addEventListener("abort", onSyncAbort, { once: true });
    }
    try {
      return await graphqlFollow(
        queryId,
        op,
        variables,
        FOLLOW_GRAPHQL_FEATURES,
        undefined,
        ctrl.signal
      );
    } finally {
      if (syncAbort && syncAbort.signal) {
        syncAbort.signal.removeEventListener("abort", onSyncAbort);
      }
      if (pageAbort === ctrl) pageAbort = null;
      pageInFlightSince = 0;
      pageInFlightCursor = null;
    }
  }

  async function paginateFollowGraph(operationName, userId, checkpoint) {
    const op = operationName === "Following" ? "Following" : "Followers";
    const queryId = gqlIds[op];
    if (!queryId) throw new Error("Missing GraphQL id for " + op);

    const resumed =
      FollowRest && typeof FollowRest.resumeGraphqlCheckpoint === "function"
        ? FollowRest.resumeGraphqlCheckpoint(checkpoint, op, userId)
        : null;
    const users = resumed && Array.isArray(resumed.users) ? resumed.users.slice() : [];
    const ids = resumed && Array.isArray(resumed.ids) ? resumed.ids.slice() : [];
    let cursor = resumed ? resumed.cursor : null;
    let pages = 0;
    const maxPages = 200;
    let exhausted = false;
    let rateWaits = 0;
    const maxRateWaits =
      (FollowRest && Number(FollowRest.MAX_GRAPHQL_429_WAITS)) || 2;
    pageSilentRetries = 0;

    while (pages < maxPages) {
      if (!syncStillCurrent()) throw new Error("Sync cancelled");
      syncProgressCount = users.length;
      syncProgressSide = op.toLowerCase();
      noteSyncProgress("Syncing " + syncProgressSide + "… " + users.length);
      // Save the cursor before the request so a frozen tab can resume here.
      await writeGraphqlCheckpoint(op, userId, users, cursor, ids);
      const variables =
        FollowRest && typeof FollowRest.graphqlFollowVariables === "function"
          ? FollowRest.graphqlFollowVariables(userId, cursor, 100)
          : {
              userId: String(userId),
              count: 100,
              includePromotedContent: false
            };
      if (cursor && !variables.cursor) variables.cursor = cursor;

      let data;
      try {
        data = await fetchFollowPage(queryId, op, variables, cursor);
        pageSilentRetries = 0;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        const status = err && err.status;
        if (!syncStillCurrent() || /cancelled/i.test(msg)) throw err;
        if (err && (err.pageStall || /stalled|timed out/i.test(msg))) {
          const decision =
            Sync && typeof Sync.pageWatchdog === "function"
              ? Sync.pageWatchdog({
                  now: Date.now(),
                  lastProgressAt: 0,
                  backoffUntil: 0,
                  silentRetries: pageSilentRetries,
                  forceSilent: true,
                  cursor: cursor
                })
              : {
                  action: pageSilentRetries > 0 ? "fail" : "retry-page",
                  cursor: cursor,
                  message: (Sync && Sync.STALL_ERROR) || "Sync stalled on this page."
                };
          if (decision.action !== "retry-page" || (decision.cursor && decision.cursor !== cursor)) {
            await writeGraphqlCheckpoint(op, userId, users, cursor, ids);
            throw new Error(
              decision.message ||
                (Sync && Sync.STALL_ERROR) ||
                "Sync stalled on this page."
            );
          }
          pageSilentRetries += 1;
          noteSyncProgress("Retrying " + op.toLowerCase() + "… " + users.length);
          continue;
        }
        if (status === 429 || /429|rate.?limit/i.test(msg)) {
          rateWaits += 1;
          // Checkpoint first: the next sync resumes here even if we give up.
          await writeGraphqlCheckpoint(op, userId, users, cursor, ids);
          if (rateWaits > maxRateWaits) {
            const giveUp = new Error(RATE_LIMIT_ERROR);
            giveUp.status = 429;
            throw giveUp;
          }
          await waitOutBackoff(backoffMsForError(err), users.length, op.toLowerCase());
          continue;
        }
        if (/404|422|QueryId|query.?id|unsupported/i.test(msg) && pages === 0) {
          await refreshGraphqlIdsFromPage();
          const retryId = gqlIds[op];
          data = await fetchFollowPage(retryId, op, variables, cursor);
        } else {
          throw err;
        }
      }

      const parsed = walkGraphqlUsers(data);
      for (let i = 0; i < parsed.users.length; i++) users.push(parsed.users[i]);
      for (let r = 0; r < (parsed.ids || []).length; r++) ids.push(parsed.ids[r]);
      syncProgressCount = users.length;
      noteSyncProgress(
        "Syncing " + op.toLowerCase() + "… " + users.length
      );

      if (!parsed.users.length && !parsed.cursor) {
        exhausted = true;
        break;
      }
      if (!parsed.cursor || parsed.cursor === cursor) {
        exhausted = true;
        break;
      }
      cursor = parsed.cursor;
      pages += 1;
      await writeGraphqlCheckpoint(op, userId, users, cursor, ids);
      await politeSessionPause();
    }

    return { users: users, ids: uniqueIdsList(ids), exhausted: exhausted };
  }

  function uniqueIdsList(list) {
    if (FollowRest && typeof FollowRest.uniqueIds === "function") {
      return FollowRest.uniqueIds(list);
    }
    return Array.from(new Set(asList(list).map((id) => String(id)).filter(Boolean)));
  }

  async function collectFollowSide(side, userId, expected, previous, checkpoint) {
    if (!userId) {
      throw new Error(
        "Could not resolve your account id. Stay on this tab and tap Sync now."
      );
    }
    const graph = await paginateFollowGraph(side, userId, checkpoint);
    const users = uniqueLower(graph.users);
    return {
      users: users,
      ids: graph.ids || [],
      ok: listLooksComplete(users, expected, previous, {
        exhausted: graph.exhausted,
        ids: graph.ids || []
      }),
      exhausted: graph.exhausted
    };
  }

  function confirmedGapSide(confirmedGap, side) {
    if (FollowRest && typeof FollowRest.confirmedGapFor === "function") {
      return FollowRest.confirmedGapFor(confirmedGap, side);
    }
    if (!confirmedGap || typeof confirmedGap !== "object") return 0;
    return Math.max(0, Number(confirmedGap[side]) || 0);
  }

  function packageFollowGraph(raw, fallbackIdMap, expected, previous, confirmedGap) {
    const following = uniqueLower(raw.following || raw.users);
    const followers = uniqueLower(raw.followers);
    const followingIds = uniqueIdsList(asList(raw.followingIds));
    const followerIds = uniqueIdsList(asList(raw.followerIds));
    const path = raw.path || "rest-ids";
    const restMembership =
      path === "rest-ids" || path === "rest-list" || path === "rest-v2";
    const restIds = path === "rest-ids";
    const followingExhausted =
      raw.followingExhausted != null ? !!raw.followingExhausted : !!raw.exhausted;
    const followersExhausted =
      raw.followersExhausted != null ? !!raw.followersExhausted : !!raw.exhausted;
    return {
      following: following,
      followers: followers,
      followingIds: followingIds,
      followerIds: followerIds,
      idMap: pruneLiveIdMap(raw.idMap || fallbackIdMap, followingIds, followerIds),
      path: path,
      followingExhausted: followingExhausted,
      followersExhausted: followersExhausted,
      followingOk: listLooksComplete(
        following,
        expected.following,
        previous.following,
        {
          exhausted: followingExhausted,
          restIds: restIds,
          restMembership: restMembership,
          ids: followingIds,
          confirmedGap: confirmedGapSide(confirmedGap, "following")
        }
      ),
      followersOk: listLooksComplete(
        followers,
        expected.followers,
        previous.followers,
        {
          exhausted: followersExhausted,
          restIds: restIds,
          restMembership: restMembership,
          ids: followerIds,
          confirmedGap: confirmedGapSide(confirmedGap, "followers")
        }
      )
    };
  }

  async function collectGraphqlGraph(
    self,
    expected,
    previous,
    stored,
    idMap,
    confirmedGap
  ) {
    const followingRes = await collectFollowSide(
      "Following",
      self.userId,
      expected.following,
      previous.following,
      stored && stored.syncCheckpoint
    );
    throwIfSyncAborted();
    const followersRes = await collectFollowSide(
      "Followers",
      self.userId,
      expected.followers,
      previous.followers,
      stored &&
        stored.syncCheckpoint &&
        stored.syncCheckpoint.side === "Followers"
        ? stored.syncCheckpoint
        : null
    );
    return packageFollowGraph(
      {
        following: followingRes.users,
        followers: followersRes.users,
        followingIds: asList(followingRes.ids),
        followerIds: asList(followersRes.ids),
        idMap: idMap,
        path: "graphql",
        followingExhausted: !!followingRes.exhausted,
        followersExhausted: !!followersRes.exhausted
      },
      idMap,
      expected,
      previous,
      confirmedGap
    );
  }

  function syncWasAborted() {
    return !!(syncAbort && syncAbort.signal && syncAbort.signal.aborted);
  }

  async function collectFollowGraph(self, expected, previous, stored, route) {
    if (!route || !route.ok) {
      throw new Error(
        (route && route.reason) ||
          (Route && Route.NO_SESSION_REASON) ||
          "Sign in on x.com in this tab, then run Sync."
      );
    }
    if (!self || !self.userId) {
      throw new Error(
        "Could not resolve your account id. Sign in on x.com in this tab, then run Sync."
      );
    }
    let idMap =
      stored && stored.followIdMap && typeof stored.followIdMap === "object"
        ? stored.followIdMap
        : {};
    if (Passive && passiveStore && FollowRest && typeof FollowRest.mergeIdMap === "function") {
      idMap = FollowRest.mergeIdMap(idMap, Passive.idPairs(passiveStore));
    }
    const confirmedGap =
      FollowRest && typeof FollowRest.freshConfirmedGap === "function"
        ? FollowRest.freshConfirmedGap(stored && stored.syncConfirmedGap)
        : null;

    if (route.path === "api") {
      const keys = await readStoredApiKeys();
      const credential =
        XApi && typeof XApi.credentialForRequest === "function"
          ? XApi.credentialForRequest(keys)
          : null;
      if (!credential) {
        throw new Error(
          "API keys are incomplete. Add them in the extension popup, or clear them to use the free session sync."
        );
      }
      try {
        noteSyncProgress("Syncing with your API keys…");
        const apiResult = await FollowRest.collectViaV2(makeRestClient(), {
          screenName: self.username,
          userId: self.userId,
          idMap: idMap,
          userToken: credential,
          expectedFollowing: expected.following,
          expectedFollowers: expected.followers,
          previousFollowing: previous.following,
          previousFollowers: previous.followers,
          confirmedGap: confirmedGap
        });
        const apiGraph = packageFollowGraph(
          apiResult,
          idMap,
          expected,
          previous,
          confirmedGap
        );
        if (apiGraph.followingOk && apiGraph.followersOk) return apiGraph;
        noteSyncProgress("API list incomplete — using your x.com session…");
      } catch (err) {
        if (syncWasAborted()) throw err;
        const msg = err && err.message ? err.message : String(err);
        if (/cancelled/i.test(msg)) throw err;
        noteSyncProgress("API keys unavailable — using your x.com session…");
      }
    }

    noteSyncProgress("Syncing from your x.com session…");
    return collectGraphqlGraph(
      self,
      expected,
      previous,
      stored,
      idMap,
      confirmedGap
    );
  }

  async function runSync(gen) {
    // Hold activity crawls so they cannot 429 the follow-list session.
    metricsHold = true;
    pauseScanObserver();
    metricsPausedUntil = Math.max(
      metricsPausedUntil,
      Date.now() + SYNC_HARD_TIMEOUT_MS
    );
    const startedAt = Date.now();
    try {
      await storageSet({
        syncStatus: "syncing",
        syncError: null,
        syncStartedAt: startedAt
      });
    } catch (eSet) {
      /* Safari storage can hang; keep going with in-memory progress */
    }

    try {
      const work = (async () => {
        allowSyncRetries = false;
        throwIfSyncAborted();
        injectPageHook();
        const route = await currentSyncRoute();
        if (!route.ok) throw new Error(route.reason);
        noteSyncProgress("Syncing…");
        const self = await resolveSelfIdentity(route);
        const selfUsername = self.username;

        let stored = {};
        try {
          stored = await storageGet([
            "following",
            "followers",
            "followingIds",
            "followerIds",
            "followingTotal",
            "followersTotal",
            "followIdMap",
            "syncCheckpoint",
            "syncConfirmedGap"
          ]);
        } catch (eGet) {
          stored = {};
        }
        const prevFollowing = uniqueLower(asList(stored.following));
        const prevFollowers = uniqueLower(asList(stored.followers));
        noteSyncProgress("Reading follow counts…");
        let official = await fetchOfficialCounts(selfUsername, self.userId).catch(
          () => ({
            following: null,
            followers: null
          })
        );
        official = FollowRest
          ? FollowRest.mergeOfficialCounts(official, lastSignedInOfficial)
          : official;
        const expectFollowing =
          coalesceCount(
            official.following,
            stored.followingTotal,
            prevFollowing.length
          ) || 0;
        const expectFollowers =
          coalesceCount(
            official.followers,
            stored.followersTotal,
            prevFollowers.length
          ) || 0;
        const graph = await collectFollowGraph(
          self,
          { following: expectFollowing, followers: expectFollowers },
          { following: prevFollowing, followers: prevFollowers },
          stored,
          route
        );
        let following = graph.following;
        let followers = graph.followers;
        let followingIds = uniqueIdsList(asList(graph.followingIds));
        let followerIds = uniqueIdsList(asList(graph.followerIds));
        if (official.following == null || official.followers == null) {
          official = await fetchOfficialCounts(selfUsername, self.userId).catch(
            () => official
          );
          official = FollowRest
            ? FollowRest.mergeOfficialCounts(official, lastSignedInOfficial)
            : official;
        }
        let followingOk =
          graph.followingOk ||
          listLooksComplete(
            following,
            coalesceCount(official.following, stored.followingTotal),
            prevFollowing
          );
        let followersOk =
          graph.followersOk ||
          listLooksComplete(
            followers,
            coalesceCount(official.followers, stored.followersTotal),
            prevFollowers
          );
        // A short pull must not replace a longer stored list, and it must
        // not count as a fresh observation. Keep that side's previous
        // handles and ids together so a reused snapshot cannot clear red
        // dots or shrink the id list.
        let followingReused = false;
        let followersReused = false;
        if (!followingOk && prevFollowing.length > following.length) {
          const ok = listLooksComplete(
            prevFollowing,
            coalesceCount(official.following, stored.followingTotal),
            prevFollowing
          );
          if (ok) {
            following = prevFollowing;
            followingIds = uniqueIdsList(asList(stored.followingIds));
            followingOk = true;
            followingReused = true;
          }
        }
        if (!followersOk && prevFollowers.length > followers.length) {
          const ok = listLooksComplete(
            prevFollowers,
            coalesceCount(official.followers, stored.followersTotal),
            prevFollowers
          );
          if (ok) {
            followers = prevFollowers;
            followerIds = uniqueIdsList(asList(stored.followerIds));
            followersOk = true;
            followersReused = true;
          }
        }
        if (!followingOk || !followersOk) {
          const wantF = coalesceCount(
            official.following,
            stored.followingTotal,
            prevFollowing.length
          );
          const wantR = coalesceCount(
            official.followers,
            stored.followersTotal,
            prevFollowers.length
          );
          const foundF = followingIds.length || following.length;
          const foundR = followerIds.length || followers.length;
          throw new Error(
            "Sync only found " +
              foundF +
              (wantF ? " of " + wantF : "") +
              " following and " +
              foundR +
              (wantR ? " of " + wantR : "") +
              " followers. Leave this tab open and tap Sync now."
          );
        }
        return {
          selfUsername: selfUsername,
          following: following,
          followers: followers,
          followingIds: followingIds,
          followerIds: followerIds,
          official: official,
          followIdMap: pruneLiveIdMap(
            graph.idMap || stored.followIdMap || {},
            followingIds,
            followerIds
          ),
          syncPath: graph.path || "rest-ids",
          storedFollowingTotal: stored.followingTotal,
          storedFollowersTotal: stored.followersTotal,
          // A GraphQL-confirmed hole is remembered for a week; a REST-only
          // pass carries the stored one; an unconfirmed pass keeps the
          // GraphQL checkpoint so the next sync resumes the crawl.
          confirmedGap:
            graph.confirmedGap !== undefined
              ? graph.confirmedGap
              : FollowRest && typeof FollowRest.freshConfirmedGap === "function"
                ? FollowRest.freshConfirmedGap(stored.syncConfirmedGap)
                : stored.syncConfirmedGap || null,
          keepCheckpoint: !!graph.unconfirmed,
          syncNote:
            FollowRest && typeof FollowRest.listGapNote === "function"
              ? FollowRest.listGapNote(official, {
                  following: following,
                  followers: followers,
                  followingIds: followingIds,
                  followerIds: followerIds
                })
              : "",
          previous: {
            following: prevFollowing,
            followers: prevFollowers,
            followingIds: asList(stored.followingIds),
            followerIds: asList(stored.followerIds),
            selfUsername: selfUsername,
            selfId: self.userId
          },
          followingReused: followingReused,
          followersReused: followersReused
        };
      })().finally(() => {
        allowSyncRetries = false;
      });

      // Per-request fetches already time out. Do not wall-clock the whole
      // job — a 429 wait on Sync now must resume instead of dying at HARD_MS.
      const result = await work;

      if (gen !== syncGeneration) {
        return { ok: false, error: "superseded" };
      }

      clearSyncProgress();
      const saved = {
        selfUsername: result.selfUsername,
        following: asList(result.following),
        followers: asList(result.followers),
        followingTotal: FollowRest
          ? FollowRest.preferredListTotal(
              result.official.following,
              result.followingIds,
              result.following,
              result.storedFollowingTotal
            )
          : result.official.following != null
            ? result.official.following
            : asList(result.followingIds).length || asList(result.following).length,
        followersTotal: FollowRest
          ? FollowRest.preferredListTotal(
              result.official.followers,
              result.followerIds,
              result.followers,
              result.storedFollowersTotal
            )
          : result.official.followers != null
            ? result.official.followers
            : asList(result.followerIds).length || asList(result.followers).length,
        followingIds: asList(result.followingIds),
        followerIds: asList(result.followerIds),
        lastSyncAt: Date.now(),
        syncStatus: "ok",
        syncError: null,
        syncStartedAt: null,
        followIdMap: pruneLiveIdMap(
          result.followIdMap || {},
          result.followingIds,
          result.followerIds
        ),
        syncPath: result.syncPath || null,
        syncConfirmedGap: result.confirmedGap || null,
        syncNote: result.syncNote || "",
        syncProgressLabel: "",
        lastSyncProgressAt: null,
        syncBackoffUntil: null,
        syncProgressCount: null,
        syncProgressSide: "",
        followListReuse: {
          following: !!result.followingReused,
          followers: !!result.followersReused
        }
      };
      followListReuse = saved.followListReuse;
      if (!result.keepCheckpoint) saved.syncCheckpoint = null;
      if (Passive && passiveStore) {
        // The lists just fetched supersede anything X said before this run.
        passiveStore = Passive.prune(passiveStore, { before: startedAt });
        const followingSet = new Set(asList(saved.following).map((h) => String(h).toLowerCase()));
        const followerSet = new Set(asList(saved.followers).map((h) => String(h).toLowerCase()));
        const followingIdSet = new Set(asList(saved.followingIds).map(String));
        const followerIdSet = new Set(asList(saved.followerIds).map(String));
        Passive.dropAgreeing(
          passiveStore,
          (id, handle) => {
            const you = followingIdSet.has(id) || (!!handle && followingSet.has(handle));
            const they = followerIdSet.has(id) || (!!handle && followerSet.has(handle));
            return you && they ? "mutual" : you ? "following" : they ? "follower" : "neither";
          },
          Date.now()
        );
        saved.passiveRelations = Passive.serialize(passiveStore);
      }
      if (ExMutual) {
        exMutualSet = ExMutual.applySyncDelta(
          exMutualSet || ExMutual.createSet(null),
          result.previous,
          {
            following: saved.following,
            followers: saved.followers,
            followingIds: saved.followingIds,
            followerIds: saved.followerIds,
            idMap: saved.followIdMap,
            selfUsername: saved.selfUsername,
            selfId: result.previous && result.previous.selfId
          },
          {
            trustFollowing: !result.followingReused,
            trustFollowers: !result.followersReused
          }
        );
        saved.exMutuals = ExMutual.serialize(exMutualSet);
        exMutualHydrated = true;
        exMutualGen += 1;
        if (exMutualPersistTimer) {
          clearTimeout(exMutualPersistTimer);
          exMutualPersistTimer = null;
        }
      }
      rememberFollowSnapshot(saved);
      try {
        await storageSet(saved);
      } catch (ePersist) {
        rememberFollowSnapshot(saved);
      }

      await loadCacheFromStorage();
      syncAutoRetries = 0;
      if (syncAutoRetryTimer) {
        clearTimeout(syncAutoRetryTimer);
        syncAutoRetryTimer = null;
      }

      return {
        ok: true,
        followingCount: result.following.length,
        followersCount: result.followers.length,
        selfUsername: result.selfUsername
      };
    } catch (err) {
      if (gen !== syncGeneration) {
        return { ok: false, error: "superseded" };
      }
      debugLog("sync failed", err);
      const raw = err && err.message ? err.message : String(err);
      const message = /timed out/i.test(raw)
        ? (Sync && Sync.TIMEOUT_ERROR) || raw
        : raw;
      try {
        const patch =
          (Sync && Sync.expirePatch(message)) || {
            syncStatus: "error",
            syncError: message,
            syncStartedAt: null
          };
        patch.syncBackoffUntil = null;
        patch.syncProgressLabel = "";
        patch.lastSyncProgressAt = null;
        syncBackoffUntil = 0;
        await storageSet(patch);
      } catch (eStore) {
        /* still return the error to the rail */
      }
      return { ok: false, error: message };
    } finally {
      if (gen === syncGeneration) {
        metricsHold = false;
        resumeScanObserver();
        // Drop the sync-duration pause so visible Days can refill immediately.
        metricsPausedUntil = Date.now() + 2000;
        metricsGapMs = Math.max(metricsGapMs, METRICS_GAP_DEFAULT_MS);
      }
    }
  }

  function startSync(force) {
    // Coalesce repeated rail taps into one in-flight run.
    // Retry only aborts a crawl that has gone silent. A live page-by-page
    // sync of hundreds of follows takes longer than the stuck timer.
    if (force && syncAutoRetryTimer) {
      clearTimeout(syncAutoRetryTimer);
      syncAutoRetryTimer = null;
    }
    if (syncInFlight) {
      if (!force || syncStillProgressing()) return syncInFlight;
      abortSyncRun();
    }
    const gen = ++syncGeneration;
    syncAbort = new AbortController();
    syncStartedAtLocal = Date.now();
    lastSyncProgressAt = Date.now();
    persistSyncProgress = true;
    syncProgressLabel = "Syncing…";
    const run = runSync(gen).finally(() => {
      if (syncGeneration === gen) {
        syncInFlight = null;
        syncAbort = null;
        kickVisibleMetrics(true);
        queueScan();
      }
    });
    syncInFlight = run;
    return run;
  }

  async function recoverStuckSync() {
    checkPageWatchdog();
    const hardMs =
      Sync && typeof Sync.hardMsFor === "function"
        ? Sync.hardMsFor({
            progressLabel: syncProgressLabel,
            backoffUntil: syncBackoffUntil,
            now: Date.now()
          })
        : SYNC_HARD_TIMEOUT_MS;
    if (
      syncInFlight &&
      !(syncBackoffUntil > Date.now()) &&
      Date.now() - (lastSyncProgressAt || syncStartedAtLocal) > hardMs
    ) {
      abortSyncRun();
      await storageSet(
        (Sync && Sync.expirePatch()) || {
          syncStatus: "error",
          syncError: "Sync timed out. Keep x.com open and tap Sync now to retry.",
          syncStartedAt: null
        }
      );
      return;
    }
    if (syncInFlight) return;
    try {
      const data = await storageGet([
        "syncStatus",
        "syncStartedAt",
        "lastSyncProgressAt",
        "syncProgressLabel"
      ]);
      if (
        Sync &&
        Sync.shouldHardExpire(
          data.syncStatus,
          data.syncStartedAt,
          Date.now(),
          data.lastSyncProgressAt,
          data.syncProgressLabel
        )
      ) {
        await storageSet(Sync.expirePatch());
      }
    } catch (e) {
      /* ignore */
    }
  }

  function onSyncWake() {
    if (document.visibilityState === "hidden") return;
    checkPageWatchdog();
    const panel = railPanelHost || document.getElementById("xfo-rail-panel");
    if (panel && panel.classList.contains("xfo-open")) {
      refreshRailPanel(panel).catch(() => {});
    }
  }

  function startSyncWatchdog() {
    if (syncWatchdogTimer) return;
    syncWatchdogTimer = setInterval(() => {
      recoverStuckSync().catch(() => {});
      const panel = railPanelHost || document.getElementById("xfo-rail-panel");
      if (panel && panel.classList.contains("xfo-open")) refreshRailPanel(panel).catch(() => {});
    }, 1000);
    if (!window.__xfoSyncWake) {
      window.__xfoSyncWake = true;
      document.addEventListener("visibilitychange", onSyncWake);
      window.addEventListener("pageshow", onSyncWake);
    }
  }

  function extractUsernameFromHref(href) {
    if (Identity && typeof Identity.extractUsernameFromHref === "function") {
      return Identity.extractUsernameFromHref(href);
    }
    if (!href) return null;
    try {
      let path = href;
      if (/^https?:\/\//i.test(href)) {
        try {
          path = new URL(href).pathname;
        } catch (e) {
          const m = href.match(/^https?:\/\/[^/]+(\/.*)?$/i);
          path = (m && m[1]) || "/";
        }
      } else {
        path = String(path).split("?")[0].split("#")[0];
      }
      const parts = path.split("/").filter(Boolean);
      if (!parts.length) return null;
      const candidate = parts[0];
      const reserved = new Set([
        "home",
        "explore",
        "search",
        "notifications",
        "messages",
        "i",
        "settings",
        "compose",
        "login",
        "signup",
        "intent",
        "hashtag",
        "following",
        "followers",
        "verified_followers",
        "lists",
        "communities",
        "jobs",
        "premium",
        "tos",
        "privacy"
      ]);
      if (reserved.has(candidate.toLowerCase())) return null;
      if (!/^[A-Za-z0-9_]{1,15}$/.test(candidate)) return null;
      return candidate.toLowerCase();
    } catch (e) {
      return null;
    }
  }

  function findAvatarHost(scope) {
    if (!scope) return null;
    const tweetAvatar = scope.querySelector('[data-testid="Tweet-User-Avatar"]');
    if (tweetAvatar) {
      return (
        tweetAvatar.querySelector('[data-testid^="UserAvatar-Container"]') ||
        tweetAvatar.querySelector("a[href^='/']") ||
        tweetAvatar
      );
    }
    return (
      scope.querySelector('[data-testid^="UserAvatar-Container"]') ||
      scope.querySelector('a[href^="/"] img[src*="profile_images"]')?.closest("a") ||
      null
    );
  }

  function restIdFromScope(scope) {
    if (!scope || typeof scope.querySelectorAll !== "function") return null;
    const links = scope.querySelectorAll('a[href*="/i/user/"]');
    for (let i = 0; i < links.length; i++) {
      const href = links[i].getAttribute("href") || "";
      const id =
        Identity && typeof Identity.extractRestIdFromHref === "function"
          ? Identity.extractRestIdFromHref(href)
          : (href.match(/\/i\/user\/(\d{3,})/) || [])[1];
      if (id) return id;
    }
    const av = scope.querySelector('[data-testid^="UserAvatar-Container-"]');
    if (av) {
      const t = av.getAttribute("data-testid") || "";
      const m = t.match(/UserAvatar-Container-(\d{3,})$/);
      if (m) return m[1];
    }
    return null;
  }

  function authorFromScope(scope) {
    if (!scope) return null;
    const avatarLink =
      scope.querySelector('[data-testid="Tweet-User-Avatar"] a[href^="/"]') ||
      scope.querySelector('a[href^="/"] img[src*="profile_images"]')?.closest("a");
    if (avatarLink) {
      const user = extractUsernameFromHref(avatarLink.getAttribute("href") || "");
      if (user) return user;
    }
    const nameRow = scope.querySelector('[data-testid="User-Name"]');
    if (nameRow) {
      const links = nameRow.querySelectorAll('a[href^="/"]');
      for (const a of links) {
        const user = extractUsernameFromHref(a.getAttribute("href") || "");
        if (user) return user;
      }
    }
    return null;
  }

  function authorInfoFromScope(scope) {
    const handle = authorFromScope(scope);
    const restId = restIdFromScope(scope);
    if (handle && restId) rememberUserId(handle, restId);
    if (!handle && !restId) return null;
    return { handle: handle, restId: restId };
  }

  function activityFromEntry(entry, now) {
    const ts = now || Date.now();
    const days = (entry && entry.days) || {};
    const todayKey = dayKeyFromMs(ts);
    const today = Number(days[todayKey]) || 0;
    const since = daysSinceLastPost(days, ts);
    const active30 = activeDaysInWindow(days, ts, METRICS_CONS_DAYS);
    const avg = avgPerActiveDay(days, ts, METRICS_CONS_DAYS);
    let streak = currentStreak(days, ts);
    // Stale-zero (newest day before yesterday, sample not fresh): paint
    // the consecutive run ending at that newest day instead of 0 / "…".
    if (
      streak === 0 &&
      MetricsRefill &&
      typeof MetricsRefill.isStaleZeroStreak === "function" &&
      MetricsRefill.isStaleZeroStreak(entry, ts, {
        softRefreshMs: METRICS_SOFT_REFRESH_MS
      }) &&
      typeof MetricsRefill.streakFromNewestDay === "function"
    ) {
      streak = MetricsRefill.streakFromNewestDay(days);
    }
    // The streak ran off the edge of what we fetched (and the timeline did
    // not end there): it is at least this long, so it paints as "N+".
    const capped =
      streak > 0 &&
      !(entry && entry.ended === true) &&
      streakReachesOldest(days, ts, streak);
    const week = postsInWindow(days, ts, 7);
    const month = postsInWindow(days, ts, METRICS_CONS_DAYS);
    const oldest = oldestDayMs(days);
    const depthCutoff = consWindowStart(ts, METRICS_CONS_DAYS);
    const consIncomplete =
      entry &&
      entry.complete !== true &&
      (oldest == null || oldest > depthCutoff);
    return {
      today: today,
      since: since,
      active30: active30,
      avg: avg,
      streak: streak,
      capped: capped,
      week: week,
      month: month,
      consIncomplete: !!consIncomplete,
      complete: !!(entry && entry.complete === true)
    };
  }

  function paintMetricsEl(el) {
    if (el && el.remove) el.remove();
  }

  function updateMetricsDom() {
    stripMetricsNodes();
  }

  function metricsEntryAgeMs(entry) {
    return Date.now() - (entry && entry.fetchedAt ? entry.fetchedAt : 0);
  }

  function isStaleZeroStreak(entry, now) {
    if (MetricsRefill && typeof MetricsRefill.isStaleZeroStreak === "function") {
      return MetricsRefill.isStaleZeroStreak(entry, now || Date.now(), {
        softRefreshMs: METRICS_SOFT_REFRESH_MS
      });
    }
    return false;
  }

  function shouldRefetchMetrics(entry) {
    if (MetricsRefill && typeof MetricsRefill.shouldRefetchMetrics === "function") {
      return MetricsRefill.shouldRefetchMetrics(entry, {
        now: Date.now(),
        softRefreshMs: METRICS_SOFT_REFRESH_MS,
        emptyRetryMs: METRICS_EMPTY_RETRY_MS,
        isUsable: isUsableMetricsEntry,
        isEmpty: isEmptyMetricsEntry
      });
    }
    if (!entry) return true;
    if (entry.error && !isUsableMetricsEntry(entry)) return true;
    if (!isUsableMetricsEntry(entry) || isEmptyMetricsEntry(entry)) {
      // Don't re-queue every scan — empty samples retry on a cooldown.
      return metricsEntryAgeMs(entry) > METRICS_EMPTY_RETRY_MS;
    }
    if (metricsEntryAgeMs(entry) > METRICS_SOFT_REFRESH_MS) return true;
    return isStaleZeroStreak(entry);
  }

  function timelineSampleComplete(opts) {
    const full = !!(opts && opts.full);
    if (!full) return true;
    if (!opts.gotAny) return false;
    return !!(
      opts.reachedDepth ||
      activityDepthReached(opts.days, opts.now) ||
      opts.timelineEnded
    );
  }

  function finalizeMetricsEntry(entry, now) {
    if (!entry) return null;
    const ts = now || Date.now();
    if (entry.error && !isUsableMetricsEntry(entry)) {
      return {
        day: null,
        week: null,
        month: null,
        fetchedAt: entry.fetchedAt || ts,
        newestId: null,
        days: null,
        error: true,
        complete: false
      };
    }
    if (entry.days && typeof entry.days === "object") {
      const days = pruneDays(entry.days, ts);
      const counts = countsFromDays(days, ts);
      return {
        day: counts.day,
        week: counts.week,
        month: counts.month,
        fetchedAt: entry.fetchedAt || ts,
        newestId: entry.newestId || null,
        days: days,
        error: false,
        complete: entry.complete === true,
        ended: entry.ended === true
      };
    }
    // Legacy flat counts — keep until next refresh upgrades them.
    return {
      day: entry.day || 0,
      week: entry.week || 0,
      month: entry.month || 0,
      fetchedAt: entry.fetchedAt || ts,
      newestId: entry.newestId || null,
      days: entry.days || null,
      error: !!entry.error,
      complete: entry.complete === true
    };
  }

  /** The sample covers the consistency window: a counted day ≥ 30 days back. */
  function activityDepthReached(days, now) {
    const oldest = oldestDayMs(days);
    if (oldest == null) return false;
    return oldest <= calendarDaysAgoStart(now, METRICS_CRAWL_DAYS);
  }

  /**
   * The streak runs to the oldest day in the sample without meeting an
   * empty day, so the sample cannot say where it ends.
   */
  function streakReachesOldest(days, now, knownStreak) {
    const oldest = oldestDayMs(days);
    if (oldest == null) return false;
    const streak =
      typeof knownStreak === "number" ? knownStreak : currentStreak(days, now);
    if (streak <= 0) return false;
    const start = chicagoDateParts(now);
    if (!start) return false;
    const first =
      (Number(days[dayKeyFromParts(start)]) || 0) > 0
        ? start
        : shiftCivilDate(start.y, start.m, start.d, -1);
    const last = shiftCivilDate(first.y, first.m, first.d, -(streak - 1));
    return dayStartFromKey(dayKeyFromParts(last)) <= oldest;
  }

  /**
   * Past the consistency window, only an unbroken streak is worth more
   * pages — and only while the op's window can spare them. Stops at
   * METRICS_DEPTH_DAYS either way.
   */
  function shouldExtendForStreak(days, now, pagesUsed, maxPages, op) {
    if (pagesUsed >= maxPages) return false;
    if (!streakReachesOldest(days, now)) return false;
    const oldest = oldestDayMs(days);
    if (oldest == null || oldest <= calendarDaysAgoStart(now, METRICS_DEPTH_DAYS)) {
      return false;
    }
    return !op || budgetHealthy(op, 2);
  }

  /** Whether a full crawl can stop paging after this page. */
  function crawlCovered(days, now, pagesUsed, maxPages, op) {
    if (!activityDepthReached(days, now)) return false;
    return !shouldExtendForStreak(days, now, pagesUsed, maxPages, op);
  }

  /** A pump timeout marks its crawl aborted; the next page never goes out. */
  function throwIfCrawlAborted(options) {
    if (options && options.ctl && options.ctl.aborted) {
      throw new Error("metrics crawl aborted");
    }
  }

  async function refreshGraphqlIdsFromPage() {
    try {
      // The new x-web app loads chunks via modulepreload links, not
      // script[src] tags, so scan both. Also take JS already on the wire.
      const scripts = Array.from(
        document.querySelectorAll(
          'script[src], link[rel="modulepreload"][href], link[rel="preload"][as="script"][href]'
        )
      );
      const urls = [];
      const seen = new Set();

      function pushUrl(src) {
        if (!src || seen.has(src) || urls.length >= 24) return;
        seen.add(src);
        urls.push(src);
      }

      try {
        const entries =
          typeof performance !== "undefined" &&
          performance.getEntriesByType
            ? performance.getEntriesByType("resource")
            : [];
        for (let e = 0; e < entries.length; e++) {
          const name = entries[e] && entries[e].name;
          if (/abs\.twimg\.com\/(responsive-web|x-web)\//i.test(name || "")) {
            pushUrl(name);
          }
        }
      } catch (ePerf) {
        /* ignore */
      }

      // Prefer bundles that usually embed GraphQL operation metadata.
      scripts.forEach((s) => {
        const src = s.src || s.href || "";
        if (
          /responsive-web/i.test(src) &&
          /(main\.|api\.|bundle|graphql|loader)/i.test(src)
        ) {
          pushUrl(src);
        }
        if (
          /\/x-web\//i.test(src) &&
          /(entry|main|api|graphql|chunk|assets|client)/i.test(src)
        ) {
          pushUrl(src);
        }
      });

      // Broader fallback: any responsive-web or x-web script on the page.
      scripts.forEach((s) => {
        const src = s.src || s.href || "";
        if (/abs\.twimg\.com\/(responsive-web|x-web)\//i.test(src)) {
          pushUrl(src);
        }
      });

      const opNames = [
        "UserByScreenName",
        "UserTweets",
        "UserTweetsAndReplies",
        "SearchTimeline",
        "Following",
        "Followers"
      ];
      const found = {};

      const deadline =
        Date.now() + ((Sync && Sync.GQL_ID_REFRESH_MS) || 12000);

      for (let i = 0; i < urls.length; i++) {
        if (Date.now() > deadline) break;
        throwIfSyncAborted();
        const remain = Math.max(500, deadline - Date.now());
        const ctrl = new AbortController();
        const text = await withTimeout(
          fetch(urls[i], {
            credentials: "omit",
            signal: ctrl.signal
          }).then((r) => (r.ok ? r.text() : "")),
          remain,
          "graphql id refresh",
          ctrl
        ).catch(() => "");
        if (!text) continue;

        for (let j = 0; j < opNames.length; j++) {
          const op = opNames[j];
          const patterns = [
            new RegExp(
              'queryId:"([A-Za-z0-9_-]+)",operationName:"' + op + '"'
            ),
            new RegExp(
              'operationName:"' + op + '"[\\s\\S]{0,80}queryId:"([A-Za-z0-9_-]+)"'
            ),
            new RegExp(
              '"' +
                op +
                '"[\\s\\S]{0,120}"queryId"\\s*:\\s*"([A-Za-z0-9_-]+)"'
            ),
            new RegExp(
              "/i/api/graphql/([A-Za-z0-9_-]+)/" + op + "(?:\\?|\"|')"
            )
          ];
          for (let p = 0; p < patterns.length; p++) {
            const m = text.match(patterns[p]);
            if (m && m[1]) {
              gqlIds[op] = m[1];
              found[op] = true;
              break;
            }
          }
        }

        // Only stop early once this run has actually located fresh ids —
        // baked-in ids are always truthy, so testing gqlIds here would
        // bail after the first script and never refresh anything.
        if (opNames.every((op) => found[op])) break;
      }
    } catch (e) {
      // Keep the baked-in ids.
      debugLog("graphql id refresh", e);
    }
  }

  async function fetchOfficialCounts(screenName, userId) {
    let official = FollowRest
      ? FollowRest.mergeOfficialCounts(lastSignedInOfficial, {
          following: null,
          followers: null
        })
      : { following: lastSignedInOfficial.following, followers: lastSignedInOfficial.followers };

    function apply(part) {
      official = FollowRest
        ? FollowRest.mergeOfficialCounts(official, part)
        : {
            following:
              official.following != null
                ? official.following
                : part && part.following != null
                  ? part.following
                  : null,
            followers:
              official.followers != null
                ? official.followers
                : part && part.followers != null
                  ? part.followers
                  : null
          };
    }

    if (FollowRest && typeof FollowRest.fetchRestOfficialCounts === "function") {
      try {
        apply(
          await FollowRest.fetchRestOfficialCounts(makeRestClient(), {
            screenName: screenName,
            userId: userId
          })
        );
      } catch (eRest) {
        /* GraphQL next */
      }
    }
    if (official.following != null && official.followers != null) {
      lastSignedInOfficial = official;
      return official;
    }

    async function readUserByScreenName() {
      const data = await graphqlFollow(
        gqlIds.UserByScreenName,
        "UserByScreenName",
        {
          screen_name: screenName,
          withSafetyModeUserFields: true
        },
        USER_BY_SCREEN_FEATURES
      );
      const node =
        data &&
        data.data &&
        data.data.user &&
        data.data.user.result;
      const fromApi = FollowRest && typeof FollowRest.countsFromGraphqlUser === "function"
        ? FollowRest.countsFromGraphqlUser(data)
        : countsFromUserNode(node);
      const id = node && node.rest_id;
      if (id) rememberUserId(String(screenName).toLowerCase(), String(id));
      return fromApi;
    }

    try {
      apply(await readUserByScreenName());
    } catch (eGql) {
      try {
        await refreshGraphqlIdsFromPage();
        apply(await readUserByScreenName());
      } catch (eRetry) {
        /* DOM last */
      }
    }
    if (official.following != null && official.followers != null) {
      lastSignedInOfficial = official;
      return official;
    }
    apply(countsFromProfileDom(screenName));
    lastSignedInOfficial = FollowRest
      ? FollowRest.mergeOfficialCounts(lastSignedInOfficial, official)
      : official;
    return official;
  }

  async function resolveUserId(screenName) {
    const key = String(screenName).toLowerCase().replace(/^@/, "");
    if (userIdCache.has(key)) return userIdCache.get(key);

    // Prefer GraphQL via the page hook (transaction id). Isolated-world
    // UserByScreenName often returns an empty user without that header.
    try {
      throwIfBudgetSpent("UserByScreenName");
      const data = await graphqlFollow(
        gqlIds.UserByScreenName,
        "UserByScreenName",
        {
          screen_name: screenName,
          withSafetyModeUserFields: true
        },
        USER_BY_SCREEN_FEATURES
      );
      const result =
        data &&
        data.data &&
        data.data.user &&
        data.data.user.result;
      const id =
        (result && result.rest_id) ||
        (result && result.id) ||
        (result && result.legacy && result.legacy.id_str);
      const legacy =
        result && result.legacy && typeof result.legacy === "object"
          ? result.legacy
          : {};
      const core =
        result && result.core && typeof result.core === "object"
          ? result.core
          : {};
      rememberUserProfile(key, {
        statusesCount:
          numberOrNull(legacy.statuses_count) ??
          numberOrNull(core.statuses_count) ??
          numberOrNull(result && result.statuses_count),
        protected: !!(legacy.protected || result && result.protected)
      });
      if (id) {
        rememberUserId(key, id);
        return String(id);
      }
    } catch (e) {
      if (isRateLimitError(e && e.message) || isTransientMetricsError(e && e.message)) {
        throw e;
      }
    }

    const data = await xFetch("/i/api/1.1/users/show.json", {
      screen_name: screenName
    });
    if (data && data.id_str) {
      rememberUserId(key, data.id_str);
      rememberUserProfile(key, {
        statusesCount: numberOrNull(data.statuses_count),
        protected: !!data.protected
      });
      return data.id_str;
    }
    throw new Error("Could not resolve user id for @" + screenName);
  }

  /**
   * Collect tweets into a day histogram.
   * options.sinceId: stop when reaching this id or older (incremental)
   * Full crawl walks back ~45 days (enough for consistency metrics).
   */
  async function collectTimelineViaRest(screenName, options) {
    const sinceId = options && options.sinceId;
    const full = !sinceId;
    const now = options.now || Date.now();
    const bounds = periodBounds(now);
    const maxPages =
      (options && options.maxPages) || METRICS_MAX_PAGES;
    const days = {};
    let newestId = null;
    let maxId = null;
    let pages = 0;
    let gotAny = false;
    let reachedDepth = false;
    let reachedSince = false;
    let hitPageLimit = false;
    let timelineEnded = false;

    while (pages < maxPages) {
      const params = {
        screen_name: screenName,
        count: 200,
        include_rts: false,
        exclude_replies: false,
        tweet_mode: "extended"
      };
      if (sinceId && !maxId) params.since_id = sinceId;
      if (maxId) params.max_id = maxId;

      const data = await xFetch("/i/api/1.1/statuses/user_timeline.json", params);
      const tweets = extractRestTimelineTweets(data);
      if (!tweets.length) {
        timelineEnded = true;
        break;
      }
      gotAny = true;

      const ingested = ingestTweetPage(tweets, days, {
        sinceId: sinceId,
        depthBound: full ? bounds.depth : null,
        depthKey: full ? chicagoDaysAgoKey(now, METRICS_DEPTH_DAYS) : "",
        newestId: newestId
      });
      newestId = ingested.newestId;
      if (ingested.reachedSince) reachedSince = true;
      if (ingested.reachedDepth) reachedDepth = true;

      if (reachedSince || reachedDepth) break;

      const last = tweets[tweets.length - 1];
      if (!last.id) {
        timelineEnded = true;
        break;
      }
      try {
        const next = BigInt(last.id) - 1n;
        maxId = String(next);
      } catch (e) {
        timelineEnded = true;
        break;
      }
      pages += 1;
      if (pages >= maxPages) hitPageLimit = true;
    }

    const gotAnyFinal = dayMapTweetCount(days) > 0 || !!newestId || gotAny;
    return {
      gotAny: gotAnyFinal,
      days: days,
      newestId: newestId,
      complete: timelineSampleComplete({
        full: full,
        gotAny: gotAnyFinal,
        reachedDepth: reachedDepth,
        days: days,
        now: now,
        timelineEnded: timelineEnded && !hitPageLimit
      })
    };
  }

  function timelineVariablesForOp(op, userId, cursor) {
    const variables = {
      userId: String(userId),
      count: METRICS_PAGE_SIZE,
      includePromotedContent: false,
      withVoice: true
    };
    if (cursor) variables.cursor = cursor;
    // Live UserTweetsAndReplies rejects withV2Timeline; UserTweets still takes it.
    if (op === "UserTweetsAndReplies") {
      variables.withCommunity = true;
    } else {
      variables.withQuickPromoteEligibilityTweetFields = true;
      variables.withV2Timeline = true;
    }
    return variables;
  }

  async function collectTimelineViaGraphql(userId, options, operationName) {
    const op = operationName || "UserTweetsAndReplies";
    const ids = queryIdsForOp(op);
    const sinceId = options && options.sinceId;
    const full = !sinceId;
    const now = options.now || Date.now();
    const bounds = periodBounds(now);
    const maxPages =
      (options && options.maxPages) || METRICS_MAX_PAGES;
    let lastEmpty = null;
    let lastErr = null;

    for (let i = 0; i < ids.length; i++) {
      const queryId = ids[i];
      const days = {};
      let newestId = null;
      let cursor = null;
      let pages = 0;
      let reachedDepth = false;
      let reachedSince = false;
      let hitPageLimit = false;
      let timelineEnded = false;
      let emptyFirstPage = false;

      try {
        while (pages < maxPages) {
          throwIfCrawlAborted(options);
          throwIfBudgetSpent(op);
          const variables = timelineVariablesForOp(op, userId, cursor);
          const data = await graphqlFollow(
            queryId,
            op,
            variables,
            USER_TWEETS_FEATURES,
            USER_TWEETS_FIELD_TOGGLES
          );
          const parsed = walkGraphqlInstructions(data);
          if (!parsed.tweets.length) {
            if (pages === 0) {
              emptyFirstPage = true;
              break;
            }
            if (!parsed.cursor) {
              timelineEnded = true;
              break;
            }
          }

          const ingested = ingestTweetPage(parsed.tweets, days, {
            sinceId: sinceId,
            depthBound: full ? bounds.depth : null,
            depthKey: full ? chicagoDaysAgoKey(now, METRICS_DEPTH_DAYS) : "",
            newestId: newestId
          });
          newestId = ingested.newestId;
          if (ingested.reachedSince) reachedSince = true;
          if (ingested.reachedDepth) reachedDepth = true;

          if (reachedSince || reachedDepth) break;
          if (full && crawlCovered(days, now, pages + 1, maxPages, op)) break;
          if (!parsed.cursor || parsed.cursor === cursor) {
            timelineEnded = true;
            break;
          }
          cursor = parsed.cursor;
          pages += 1;
          if (pages >= maxPages) hitPageLimit = true;
          else await sleep(budgetPageGapMs(op));
        }
      } catch (gqlErr) {
        lastErr = gqlErr;
        const msg = gqlErr && gqlErr.message ? gqlErr.message : String(gqlErr);
        if (isTransientMetricsError(msg) || isRateLimitError(msg)) throw gqlErr;
        if (/404|422|QueryId|query.?id|unsupported/i.test(msg) && i < ids.length - 1) {
          continue;
        }
        if (i < ids.length - 1) continue;
        throw gqlErr;
      }

      const gotAny = dayMapTweetCount(days) > 0 || !!newestId;
      const result = {
        gotAny: gotAny,
        days: days,
        newestId: newestId,
        emptyFirstPage: emptyFirstPage,
        ended: timelineEnded && !hitPageLimit,
        complete: timelineSampleComplete({
          full: full,
          gotAny: gotAny,
          reachedDepth: reachedDepth,
          days: days,
          now: now,
          timelineEnded: timelineEnded && !hitPageLimit
        })
      };
      if (gotAny) {
        rememberGraphqlId(op, queryId);
        return result;
      }
      lastEmpty = result;
      // Empty first page is not "try every historic queryId" — that 429s.
      // Caller refreshes ids once, then tries the other UserTweets op / Search.
      return result;
    }

    if (lastEmpty) return lastEmpty;
    if (lastErr) throw lastErr;
    return {
      gotAny: false,
      days: {},
      newestId: null,
      emptyFirstPage: true,
      complete: false
    };
  }

  async function fetchAdaptiveSearch(params) {
    try {
      const res = await pageRest("/i/api/2/search/adaptive.json", params);
      if (res && res.ok && res.json) return res.json;
      if (res && (res.status === 429 || /rate.?limit/i.test(res.text || ""))) {
        noteRateLimit(0, "X API 429");
        throw new Error("X API 429: rate limited");
      }
    } catch (e) {
      if (isRateLimitError(e && e.message) || isTransientMetricsError(e && e.message)) {
        throw e;
      }
    }
    return xFetch("/i/api/2/search/adaptive.json", params);
  }

  async function collectTimelineViaSearch(screenName, options) {
    const sinceId = options && options.sinceId;
    const full = !sinceId;
    const now = options.now || Date.now();
    const bounds = periodBounds(now);
    const maxPages =
      (options && options.maxPages) || METRICS_MAX_PAGES;
    const sinceStr = chicagoDaysAgoKey(now, METRICS_DEPTH_DAYS);
    const days = {};
    let newestId = null;
    let cursor = null;
    let pages = 0;
    let reachedDepth = false;
    let reachedSince = false;
    let hitPageLimit = false;
    let timelineEnded = false;

    while (pages < maxPages) {
      throwIfCrawlAborted(options);
      const params = {
        q: "from:" + screenName + " since:" + sinceStr,
        count: 50,
        query_source: "typed_query",
        pc: 1,
        spelling_correction: 1
      };
      if (cursor) params.cursor = cursor;

      const data = await fetchAdaptiveSearch(params);
      const raw = (data && data.globalObjects && data.globalObjects.tweets) || {};
      const tweets = [];
      Object.keys(raw).forEach((id) => {
        const tw = raw[id];
        if (!tw) return;
        const created = parseTweetCreatedAt(tw.created_at);
        const tid = tw.id_str || id;
        const ms = Number.isNaN(created) && tid ? snowflakeToMs(tid) : created;
        if (Number.isNaN(ms)) return;
        tweets.push({ created: ms, id: tid });
      });
      tweets.sort((a, b) => b.created - a.created);
      if (!tweets.length && !cursor) {
        timelineEnded = true;
        break;
      }

      const ingested = ingestTweetPage(tweets, days, {
        sinceId: sinceId,
        depthBound: full ? bounds.depth : null,
        depthKey: full ? chicagoDaysAgoKey(now, METRICS_DEPTH_DAYS) : "",
        newestId: newestId
      });
      newestId = ingested.newestId;
      if (ingested.reachedSince) reachedSince = true;
      if (ingested.reachedDepth) reachedDepth = true;

      // Adaptive search cursor from timeline instructions
      let nextCursor = null;
      const instructions =
        (data &&
          data.timeline &&
          data.timeline.instructions) ||
        [];
      instructions.forEach((instr) => {
        const entries = instr.entries || (instr.replaceEntry ? [instr.replaceEntry] : []);
        (Array.isArray(entries) ? entries : []).forEach((entry) => {
          if (
            entry &&
            entry.content &&
            entry.content.operation &&
            entry.content.operation.cursor &&
            entry.content.operation.cursor.cursorType === "Bottom"
          ) {
            nextCursor = entry.content.operation.cursor.value;
          }
          if (
            entry &&
            entry.content &&
            entry.content.cursorType === "Bottom" &&
            entry.content.value
          ) {
            nextCursor = entry.content.value;
          }
        });
      });

      if (reachedSince || reachedDepth) break;
      if (full && crawlCovered(days, now, pages + 1, maxPages, null)) break;
      if (!nextCursor || nextCursor === cursor) {
        timelineEnded = true;
        break;
      }
      cursor = nextCursor;
      pages += 1;
      if (pages >= maxPages) hitPageLimit = true;
      else await sleep(METRICS_PAGE_GAP_MS);
    }

    const gotAny = dayMapTweetCount(days) > 0 || !!newestId;
    return {
      gotAny: gotAny,
      days: days,
      newestId: newestId,
      ended: timelineEnded && !hitPageLimit,
      complete: timelineSampleComplete({
        full: full,
        gotAny: gotAny,
        reachedDepth: reachedDepth,
        days: days,
        now: now,
        timelineEnded: timelineEnded && !hitPageLimit
      })
    };
  }

  function noteMetricsSearchUse() {
    const now = Date.now();
    metricsSearchAt = now;
    metricsSearchTimes.push(now);
    while (
      metricsSearchTimes.length &&
      now - metricsSearchTimes[0] > METRICS_SEARCH_WINDOW_MS
    ) {
      metricsSearchTimes.shift();
    }
  }

  function searchBudgetRemaining() {
    const now = Date.now();
    while (
      metricsSearchTimes.length &&
      now - metricsSearchTimes[0] > METRICS_SEARCH_WINDOW_MS
    ) {
      metricsSearchTimes.shift();
    }
    return METRICS_SEARCH_MAX_PER_WINDOW - metricsSearchTimes.length;
  }

  async function waitForSearchGap() {
    const wait = METRICS_SEARCH_GAP_MS - (Date.now() - metricsSearchAt);
    if (wait > 0) await sleep(wait);
  }

  function collectVisibleTweetsForUser(screenName) {
    const handle = String(screenName || "")
      .toLowerCase()
      .replace(/^@/, "");
    if (!handle) return [];
    const tweets = [];
    const seen = new Set();
    const articles = document.querySelectorAll("article");
    for (let i = 0; i < articles.length; i++) {
      const scope = articles[i];
      const info = authorInfoFromScope(scope);
      if (!info || info.handle !== handle) continue;
      const time = scope.querySelector("time[datetime]");
      if (!time) continue;
      const created = Date.parse(time.getAttribute("datetime") || "");
      if (Number.isNaN(created)) continue;
      const href =
        (time.closest && time.closest("a") && time.closest("a").getAttribute("href")) ||
        "";
      const id = (String(href).match(/\/status\/(\d+)/) || [])[1] || "";
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      tweets.push({ created: created, id: id });
    }
    return tweets;
  }

  function histogramFromVisibleTweets(screenName, options) {
    const now = (options && options.now) || Date.now();
    const tweets = collectVisibleTweetsForUser(screenName);
    if (!tweets.length) {
      return {
        gotAny: false,
        days: {},
        newestId: null,
        complete: false,
        method: "dom"
      };
    }
    const days = {};
    const ingested = ingestTweetPage(tweets, days, {
      sinceId: options && options.sinceId,
      newestId: null
    });
    const gotAny = dayMapTweetCount(days) > 0 || !!ingested.newestId;
    return {
      gotAny: gotAny,
      days: days,
      newestId: ingested.newestId,
      complete: false,
      method: "dom"
    };
  }

  async function collectTimelineViaSearchGraphql(screenName, options) {
    const sinceId = options && options.sinceId;
    const full = !sinceId;
    const now = options.now || Date.now();
    const bounds = periodBounds(now);
    const maxPages =
      (options && options.maxPages) || METRICS_MAX_PAGES;
    const sinceStr = chicagoDaysAgoKey(now, METRICS_DEPTH_DAYS);
    const ids = queryIdsForOp("SearchTimeline");
    const days = {};
    let newestId = null;
    let cursor = null;
    let pages = 0;
    let reachedDepth = false;
    let reachedSince = false;
    let hitPageLimit = false;
    let timelineEnded = false;
    let queryId = ids[0];
    let idIndex = 0;

    while (pages < maxPages) {
      throwIfCrawlAborted(options);
      throwIfBudgetSpent("SearchTimeline");
      const variables = {
        rawQuery: "from:" + screenName + " since:" + sinceStr,
        count: 20,
        querySource: "typed_query",
        product: "Latest"
      };
      if (cursor) variables.cursor = cursor;
      let data = null;
      try {
        data = await graphqlFollow(
          queryId,
          "SearchTimeline",
          variables,
          USER_TWEETS_FEATURES,
          USER_TWEETS_FIELD_TOGGLES
        );
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (isTransientMetricsError(msg) || isRateLimitError(msg)) throw err;
        if (idIndex < ids.length - 1 && pages === 0) {
          idIndex += 1;
          queryId = ids[idIndex];
          continue;
        }
        throw err;
      }
      rememberGraphqlId("SearchTimeline", queryId);
      const parsed = walkGraphqlInstructions(data);
      if (!parsed.tweets.length && !parsed.cursor) {
        if (idIndex < ids.length - 1 && pages === 0) {
          idIndex += 1;
          queryId = ids[idIndex];
          continue;
        }
        timelineEnded = true;
        break;
      }
      const ingested = ingestTweetPage(parsed.tweets, days, {
        sinceId: sinceId,
        depthBound: full ? bounds.depth : null,
        depthKey: full ? chicagoDaysAgoKey(now, METRICS_DEPTH_DAYS) : "",
        newestId: newestId
      });
      newestId = ingested.newestId;
      if (ingested.reachedSince) reachedSince = true;
      if (ingested.reachedDepth) reachedDepth = true;
      if (reachedSince || reachedDepth) break;
      if (full && crawlCovered(days, now, pages + 1, maxPages, "SearchTimeline")) break;
      if (!parsed.cursor || parsed.cursor === cursor) {
        timelineEnded = true;
        break;
      }
      cursor = parsed.cursor;
      pages += 1;
      if (pages >= maxPages) hitPageLimit = true;
      else await sleep(budgetPageGapMs("SearchTimeline"));
    }

    const gotAny = dayMapTweetCount(days) > 0 || !!newestId;
    return {
      gotAny: gotAny,
      days: days,
      newestId: newestId,
      ended: timelineEnded && !hitPageLimit,
      complete: timelineSampleComplete({
        full: full,
        gotAny: gotAny,
        reachedDepth: reachedDepth,
        days: days,
        now: now,
        timelineEnded: timelineEnded && !hitPageLimit
      })
    };
  }

  async function fetchTimelineHistogram(screenName, options) {
    // REST 1.1 user_timeline is usually blocked/empty and costs a long timeout
    // per account — skip it. Timeline GraphQL must go through the page hook
    // (GET + x-client-transaction-id). An empty GraphQL page is not done.
    let userId = null;
    try {
      userId = await resolveUserId(screenName);
    } catch (idErr) {
      const msg = idErr && idErr.message ? idErr.message : String(idErr);
      if (isTransientMetricsError(msg) || isRateLimitError(msg)) throw idErr;
    }

    async function gql(op) {
      if (!userId) {
        return {
          gotAny: false,
          days: {},
          newestId: null,
          complete: false,
          emptyFirstPage: true
        };
      }
      try {
        return await collectTimelineViaGraphql(userId, options, op);
      } catch (gqlErr) {
        const msg = gqlErr && gqlErr.message ? gqlErr.message : String(gqlErr);
        if (/404|422|QueryId|query.?id|unsupported/i.test(msg)) {
          await ensureFreshGraphqlIds(true);
          return collectTimelineViaGraphql(userId, options, op);
        }
        throw gqlErr;
      }
    }

    // Always try GraphQL first (never sticky-skip after one Search success).
    // Replies first — UserTweets hides replies, and replies count as posts.
    try {
      const replies = await gql("UserTweetsAndReplies");
      if (replies.gotAny || options.sinceId) {
        replies.method = "UserTweetsAndReplies";
        return replies;
      }
      if (replies.emptyFirstPage) {
        await ensureFreshGraphqlIds(true);
        const retry = await gql("UserTweetsAndReplies");
        if (retry.gotAny || options.sinceId) {
          retry.method = "UserTweetsAndReplies";
          return retry;
        }
      }
    } catch (e1) {
      const msg = e1 && e1.message ? e1.message : String(e1);
      if (isTransientMetricsError(msg)) throw e1;
    }

    // Fallbacks only run while their own window has room; a spent fallback
    // is skipped rather than pausing the whole pump until its reset.
    if (!budgetSpent("UserTweets")) {
      try {
        const posts = await gql("UserTweets");
        if (posts.gotAny || options.sinceId) {
          posts.method = "UserTweets";
          return posts;
        }
      } catch (e2) {
        const msg = e2 && e2.message ? e2.message : String(e2);
        if (isTransientMetricsError(msg) && !(Number(e2 && e2.budgetWaitMs) > 0)) throw e2;
      }
    }

    // Empty GraphQL is not the final Days paint when another path can get tweets.
    if (searchBudgetRemaining() > 0) {
      await waitForSearchGap();
      noteMetricsSearchUse();
      if (!budgetSpent("SearchTimeline")) {
        try {
          const gqlSearch = await collectTimelineViaSearchGraphql(screenName, options);
          if (gqlSearch.gotAny || options.sinceId) {
            gqlSearch.method = "SearchTimeline";
            return gqlSearch;
          }
        } catch (eSearchGql) {
          if (
            isTransientMetricsError(eSearchGql && eSearchGql.message) &&
            !(Number(eSearchGql && eSearchGql.budgetWaitMs) > 0)
          ) {
            throw eSearchGql;
          }
        }
      }
      try {
        const search = await collectTimelineViaSearch(screenName, options);
        if (search.gotAny || options.sinceId) {
          search.method = "SearchAdaptive";
          return search;
        }
      } catch (e3) {
        if (isTransientMetricsError(e3 && e3.message)) throw e3;
      }
    }

    const visible = histogramFromVisibleTweets(screenName, options);
    if (visible.gotAny) return visible;

    // Empty sample: never complete. Callers paint — / …, not a fake 0.
    return {
      days: {},
      newestId: null,
      complete: false,
      gotAny: false,
      method: "empty",
      profilePosts: profileClearlyPosts(screenName)
    };
  }

  async function computePostMetrics(screenName, options) {
    const now = Date.now();
    const existing = getCachedMetrics(screenName);
    const deep = !!(options && options.deep);
    const quick = !!(options && options.quick);
    const maxPages = deep
      ? METRICS_DEEP_PAGES
      : quick
        ? METRICS_QUICK_PAGES
        : METRICS_MAX_PAGES;
    // Refresh from the newest known post whenever we have one — complete or
    // not. The streak only needs the days since; a partial 30-day window
    // is finished by the bounded deep pass, not by re-walking on every refresh.
    const canIncremental =
      !deep &&
      !quick &&
      existing &&
      isUsableMetricsEntry(existing) &&
      existing.days &&
      typeof existing.days === "object" &&
      existing.newestId;

    if (canIncremental) {
      const delta = await fetchTimelineHistogram(screenName, {
        now: now,
        sinceId: existing.newestId,
        ctl: options && options.ctl
      });
      const days = pruneDays(mergeDayMaps(existing.days, delta.days), now);
      const counts = countsFromDays(days, now);
      return {
        day: counts.day,
        week: counts.week,
        month: counts.month,
        fetchedAt: now,
        newestId: maxSnowflake(existing.newestId, delta.newestId),
        days: days,
        error: false,
        complete: existing.complete === true || activityDepthReached(days, now),
        ended: existing.ended === true
      };
    }

    // Full walk (first load, incomplete cache, or deepen). Preserve real completeness.
    const full = await fetchTimelineHistogram(screenName, {
      now: now,
      maxPages: maxPages,
      ctl: options && options.ctl
    });
    const days = pruneDays(full.days || {}, now);
    const counts = countsFromDays(days, now);
    const gotAny = dayMapTweetCount(days) > 0 || !!full.newestId;
    return {
      day: counts.day,
      week: counts.week,
      month: counts.month,
      fetchedAt: now,
      newestId: full.newestId || null,
      days: days,
      error: false,
      // Completeness is what the crawl saw (window covered / timeline ended),
      // whatever its page cap. Empty samples are never complete when the
      // profile posts — that was the fake 0 Days path.
      complete: !gotAny ? false : !!full.complete,
      ended: !!full.ended
    };
  }

  async function persistMetricsEntry(user, entry) {
    const handle = String(user).toLowerCase();
    const finalized = finalizeMetricsEntry(entry, Date.now());
    metricsMemory.set(handle, finalized);
    // Debounce the full-cache storage write — writing 1000s of entries on every
    // account was a major Safari beach-ball source during on-screen counting.
    if (metricsPersistTimer) clearTimeout(metricsPersistTimer);
    metricsPersistTimer = setTimeout(() => {
      metricsPersistTimer = null;
      flushMetricsCacheToStorage();
    }, 1200);
  }

  async function flushMetricsCacheToStorage() {
    try {
      const store = {};
      metricsMemory.forEach((value, key) => {
        if (!value || value.error) {
          store[key] = value;
          return;
        }
        // Don't persist ephemeral bookkeeping fields.
        const { __finalizedAt, ...rest } = value;
        store[key] = rest;
      });
      const remaining = Object.keys(store);
      const maxKeep = 2500;
      if (remaining.length > maxKeep) {
        remaining
          .sort(
            (a, b) => (store[a].fetchedAt || 0) - (store[b].fetchedAt || 0)
          )
          .slice(0, remaining.length - maxKeep)
          .forEach((k) => {
            delete store[k];
            metricsMemory.delete(k);
          });
      }
      await storageSet({ metricsCache: store });
    } catch (e) {
      /* memory still updated */
    }
  }

  function getCachedMetrics(user) {
    const handle = String(user).toLowerCase();
    const entry = metricsMemory.get(handle);
    if (!entry) return null;
    // Avoid rewriting memory on every paint/scan — finalize only when needed.
    if (entry.__finalizedAt && Date.now() - entry.__finalizedAt < 60000) {
      return entry;
    }
    const finalized = finalizeMetricsEntry(entry, Date.now());
    finalized.__finalizedAt = Date.now();
    metricsMemory.set(handle, finalized);
    return finalized;
  }

  function metricsQueuedHandles() {
    const handles = metricsQueue.slice();
    metricsInFlight.forEach((h) => handles.push(h));
    return handles;
  }

  /**
   * First-face pending: unique queued/in-flight handles that still need a
   * usable Days face. Not shown on the rail (Activity is Live / Paused).
   */
  function metricsPendingCount() {
    if (MetricsRefill && typeof MetricsRefill.activityPendingCount === "function") {
      return MetricsRefill.activityPendingCount(
        metricsQueuedHandles(),
        getCachedMetrics,
        Date.now(),
        {
          isUsable: isUsableMetricsEntry,
          isEmpty: isEmptyMetricsEntry,
          softRefreshMs: METRICS_SOFT_REFRESH_MS
        }
      );
    }
    const seen = {};
    let n = 0;
    metricsQueuedHandles().forEach((user) => {
      const handle = String(user || "").toLowerCase();
      if (!handle || seen[handle]) return;
      seen[handle] = true;
      const cached = getCachedMetrics(handle);
      if (
        !isUsableMetricsEntry(cached) ||
        isEmptyMetricsEntry(cached) ||
        isStaleZeroStreak(cached)
      ) {
        n += 1;
      }
    });
    return n;
  }

  function prioritizeQueued(handle) {
    const idx = metricsQueue.indexOf(handle);
    if (idx > 0) {
      metricsQueue.splice(idx, 1);
      metricsQueue.unshift(handle);
    }
  }

  function enqueueMetrics(user, force, prioritize) {
    void user;
    void force;
    void prioritize;
    // Days / pace badges are gone, so timeline crawls are not started.
    return;
    if (metricsHold || syncInFlight) return;
    const handle = String(user).toLowerCase();
    const cached = getCachedMetrics(handle);
    const needsRefetch = force || shouldRefetchMetrics(cached);
    if (!needsRefetch) return;
    if (force || isEmptyMetricsEntry(cached)) metricsForced.add(handle);
    // Fresh on-screen request: allow retries even after earlier failures.
    if (!isUsableMetricsEntry(cached) || isEmptyMetricsEntry(cached)) {
      metricsAttempts.delete(handle);
    }

    if (metricsInFlight.has(handle)) {
      if (force) {
        // Re-queue after current in-flight fetch finishes.
        if (!metricsQueuedSet.has(handle)) {
          metricsQueuedSet.add(handle);
          if (prioritize) metricsQueue.unshift(handle);
          else metricsQueue.push(handle);
        } else if (prioritize) {
          prioritizeQueued(handle);
        }
      }
      return;
    }

    if (metricsQueuedSet.has(handle)) {
      if (prioritize) prioritizeQueued(handle);
      return;
    }

    metricsQueuedSet.add(handle);
    if (prioritize) metricsQueue.unshift(handle);
    else metricsQueue.push(handle);
    pumpMetricsQueue();
  }

  /**
   * Days / pace badges are retired. Do not queue timeline crawls or paint
   * a face. Drop any leftover metrics nodes from an older build.
   */
  function kickVisibleMetrics(forceUnusable) {
    void forceUnusable;
    stripMetricsNodes();
    return 0;
  }

  async function pumpMetricsQueue() {
    if (metricsHold || syncInFlight) return;
    if (metricsPumpRunning) return;
    metricsPumpRunning = true;
    try {
      while (metricsQueue.length) {
        if (syncInFlight) {
          await syncInFlight.catch(() => {});
          continue;
        }
        // Keep fetching while scrolling — pausing the pump left the feed full of dashes.
        if (metricsQueue.length > 40) trimMetricsQueueToVisible();
        const handle = metricsQueue.shift();
        metricsQueuedSet.delete(handle);
        const forced = metricsForced.delete(handle);
        const priorCached = getCachedMetrics(handle);
        if (
          !forced &&
          isUsableMetricsEntry(priorCached) &&
          priorCached.complete === true &&
          !shouldRefetchMetrics(priorCached)
        ) {
          continue;
        }
        if (metricsInFlight.has(handle)) continue;
        metricsInFlight.add(handle);
        // Timing out an account must also stop its crawl, or the orphaned
        // pages keep spending the window behind the next account's back.
        const ctl = {
          aborted: false,
          abort() {
            this.aborted = true;
          }
        };
        try {
          // X's window for the timeline op is the real pause; honor it before
          // the first page rather than discovering it with a 429.
          const budgetWait = budgetWaitMs("UserTweetsAndReplies");
          if (budgetWait > 0) {
            metricsPausedUntil = Math.max(metricsPausedUntil, Date.now() + budgetWait);
          }
          const waitMs = metricsPausedUntil - Date.now();
          if (waitMs > 0) {
            if (isUsableMetricsEntry(priorCached)) {
              updateMetricsDom(handle, priorCached, false);
            } else {
              updateMetricsDom(handle, null, true);
            }
            await new Promise((r) => setTimeout(r, waitMs));
          }
          if (isUsableMetricsEntry(priorCached)) {
            updateMetricsDom(handle, priorCached, false);
          } else {
            updateMetricsDom(handle, null, true);
          }
          const deep =
            !!(
              priorCached &&
              isUsableMetricsEntry(priorCached) &&
              priorCached.complete !== true
            );
          const quick = !deep && !isUsableMetricsEntry(priorCached);
          if (deep) metricsDeepTried.add(handle);
          const entry = await withTimeout(
            computePostMetrics(handle, { deep: deep, quick: quick, ctl: ctl }),
            quick ? METRICS_QUICK_TIMEOUT_MS : METRICS_ACCOUNT_TIMEOUT_MS,
            "metrics @" + handle,
            ctl
          );
          if (!isUsableMetricsEntry(entry)) {
            // Never cache a finished zero. Empty / protected / failed samples
            // stay retryable and paint — or …, not 0 Days.
            const soft = {
              day: 0,
              week: 0,
              month: 0,
              fetchedAt: Date.now(),
              newestId: null,
              days: {},
              error: false,
              complete: false
            };
            await persistMetricsEntry(handle, soft);
            updateMetricsDom(handle, soft, false);
            await markMetricsFailed(handle);
          } else {
            await persistMetricsEntry(handle, entry);
            updateMetricsDom(handle, entry, false);
            await clearMetricsFailed(handle);
            // Deepen later only when the queue is calm and the window can
            // afford a full pass — immediate deepen stampeded X.
            if (
              entry.complete !== true &&
              !metricsDeepTried.has(handle) &&
              metricsQueue.length <= 2 &&
              Date.now() >= metricsPausedUntil &&
              metricsRateLimitHits === 0 &&
              budgetHealthy("UserTweetsAndReplies", METRICS_DEEP_PAGES)
            ) {
              metricsForced.add(handle);
              if (!metricsQueuedSet.has(handle)) {
                metricsQueuedSet.add(handle);
                metricsQueue.push(handle);
              }
            }
          }
          metricsAttempts.delete(handle);
          noteMetricsSuccess();
          try {
            await storageSet({ metricsLastError: null });
          } catch (e0) {
            /* ignore */
          }
        } catch (err) {
          debugLog("activity @" + handle, err);
          const message = err && err.message ? err.message : String(err);
          const attempts = (metricsAttempts.get(handle) || 0) + 1;
          metricsAttempts.set(handle, attempts);
          const transient = isTransientMetricsError(message);
          const rateLimited = isRateLimitError(message);

          if (transient && attempts < 5) {
            trimMetricsQueueToVisible();
            metricsForced.add(handle);
            if (!metricsQueuedSet.has(handle)) {
              metricsQueuedSet.add(handle);
              // Back of queue — don't immediately re-hammer the same account.
              metricsQueue.push(handle);
            }
            if (rateLimited) {
              noteRateLimit(rateLimitWaitFromError(err), message);
            } else {
              metricsGapMs = Math.min(
                METRICS_GAP_MAX_MS,
                Math.max(metricsGapMs * 2, 8000)
              );
              if (Date.now() + metricsGapMs > metricsPausedUntil) {
                metricsPausedUntil = Date.now() + metricsGapMs;
                metricsPauseIsRateLimit = false;
              }
            }
            const prior = getCachedMetrics(handle);
            if (isUsableMetricsEntry(prior)) {
              updateMetricsDom(handle, prior, false);
            } else {
              updateMetricsDom(handle, null, true);
            }
          } else {
            if (rateLimited) noteRateLimit(rateLimitWaitFromError(err), message);
            else {
              metricsGapMs = Math.min(
                transient ? 15000 : METRICS_GAP_DEFAULT_MS,
                Math.max(metricsGapMs, transient ? 8000 : metricsGapMs + 200)
              );
            }
            const prior = getCachedMetrics(handle);
            if (isUsableMetricsEntry(prior)) {
              updateMetricsDom(handle, prior, false);
              await clearMetricsFailed(handle);
            } else {
              // Don't freeze failures as complete zeros — keep retryable.
              const softFail = {
                day: 0,
                week: 0,
                month: 0,
                fetchedAt: Date.now(),
                newestId: null,
                days: {},
                error: true,
                complete: false
              };
              await persistMetricsEntry(handle, softFail);
              updateMetricsDom(handle, null, true);
              await markMetricsFailed(handle);
              metricsAttempts.delete(handle);
            }
          }
        } finally {
          metricsInFlight.delete(handle);
        }
        // Always honor global pause (e.g. 429) before the next account.
        const pauseLeft = metricsPausedUntil - Date.now();
        await sleep(Math.max(metricsGapMs, pauseLeft > 0 ? pauseLeft : 0));
      }
    } finally {
      metricsPumpRunning = false;
      if (metricsQueue.length) pumpMetricsQueue();
    }
  }

  function prepareHostOverflow(host) {
    // Forced style reads + parent walks are expensive; do once per host.
    if (!host || host.dataset.xfoOverflow === "1") return;
    host.dataset.xfoOverflow = "1";
    const computed = window.getComputedStyle(host);
    if (computed.position === "static") host.style.position = "relative";
    host.style.overflow = "visible";
    host.style.zIndex = "5";

    // The thread connector is a DOM sibling of Tweet-User-Avatar (not of the
    // inner avatar). Overflowing badge/metrics paint under that sibling unless
    // the avatar cell itself is a higher stacking context.
    let tweetAvatar = host.closest('[data-testid="Tweet-User-Avatar"]');
    if (!tweetAvatar && host.getAttribute("data-testid") === "Tweet-User-Avatar") {
      tweetAvatar = host;
    }
    if (tweetAvatar) {
      tweetAvatar.style.position = "relative";
      tweetAvatar.style.overflow = "visible";
      tweetAvatar.style.zIndex = "5";
      const col = tweetAvatar.parentElement;
      if (col) {
        col.style.position = col.style.position || "relative";
        col.style.overflow = "visible";
        if (!col.style.zIndex) col.style.zIndex = "2";
      }
    }

    let parent = host.parentElement;
    for (let i = 0; i < 4 && parent; i++) {
      parent.style.overflow = "visible";
      parent = parent.parentElement;
    }
  }

  function stripMetricsNodes(root) {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    scope.querySelectorAll("." + METRICS_CLASS).forEach((el) => el.remove());
  }

  function ensureMetrics(host, user, focal) {
    void user;
    void focal;
    if (!host) return;
    stripMetricsNodes(host);
  }

  function collectBadgedUsers() {
    const users = new Set();
    const now = Date.now();
    document.querySelectorAll("." + METRICS_CLASS).forEach((el) => {
      const user = (el.dataset.user || "").toLowerCase();
      if (user) {
        users.add(user);
        metricsRecentlyVisible.set(user, now);
      }
    });
    // Only walk near-viewport articles — full-timeline walks are costly.
    document.querySelectorAll("article").forEach((scope) => {
      if (!isNearViewport(scope)) return;
      const info = authorInfoFromScope(scope);
      if (!info || !info.handle) return;
      if (COLORS[classify(info.handle, info.restId)]) {
        users.add(info.handle);
        metricsRecentlyVisible.set(info.handle, now);
      }
    });
    return users;
  }

  function pruneRecentlyVisible(now) {
    const cutoff = (now || Date.now()) - METRICS_RECENT_MS * 2;
    metricsRecentlyVisible.forEach((ts, handle) => {
      if (ts < cutoff) metricsRecentlyVisible.delete(handle);
    });
  }

  function trimMetricsQueueToVisible() {
    const visible = collectBadgedUsers();
    const now = Date.now();
    const kept = [];
    while (metricsQueue.length) {
      const handle = metricsQueue.shift();
      metricsQueuedSet.delete(handle);
      const recent = metricsRecentlyVisible.get(handle) || 0;
      if (
        visible.has(handle) ||
        metricsInFlight.has(handle) ||
        now - recent < METRICS_RECENT_MS
      ) {
        kept.push(handle);
      }
    }
    kept.forEach((handle) => {
      if (!metricsQueuedSet.has(handle)) {
        metricsQueuedSet.add(handle);
        metricsQueue.push(handle);
      }
    });
  }

  function removeOverlay(host) {
    if (!host) return;
    host.querySelectorAll("." + DOT_CLASS + ", ." + METRICS_CLASS).forEach((el) => {
      el.remove();
    });
    host.style.removeProperty("--xfo-focal-x");
    delete host.dataset.xfoFocal;
  }

  function ensureDot(host, relationship, user, focalX) {
    if (!host) return;
    const color = COLORS[relationship];
    if (!color) {
      if (host.querySelector("." + DOT_CLASS + ", ." + METRICS_CLASS)) {
        removeOverlay(host);
      } else {
        host.style.removeProperty("--xfo-focal-x");
        delete host.dataset.xfoFocal;
      }
      return;
    }

    prepareHostOverflow(host);

    const focal = typeof focalX === "number" && isFinite(focalX);
    const focalPx = focal ? Math.round(focalX) + "px" : "";
    if (focal) {
      if (host.style.getPropertyValue("--xfo-focal-x") !== focalPx) {
        host.style.setProperty("--xfo-focal-x", focalPx);
      }
      host.dataset.xfoFocal = "1";
    } else if (host.dataset.xfoFocal) {
      host.style.removeProperty("--xfo-focal-x");
      delete host.dataset.xfoFocal;
    }

    let dot = host.querySelector("." + DOT_CLASS);
    if (!dot) {
      dot = document.createElement("span");
      dot.className = DOT_CLASS;
      host.appendChild(dot);
    }

    const relChanged = dot.dataset.rel !== relationship;
    const userChanged = dot.dataset.user !== user;
    const wasFocal = dot.classList.contains("xfo-focal");
    if (!relChanged && !userChanged && wasFocal === focal && dot.dataset.xfoRound === "1") {
      ensureMetrics(host, user, focal);
      return;
    }

    dot.dataset.rel = relationship;
    dot.dataset.user = user;
    if (!dot.dataset.xfoStyled || dot.querySelector("svg") || dot.style.borderRadius === "0px") {
      dot.style.cssText = [
        "position:absolute",
        "left:50%",
        "right:auto",
        "bottom:-19px",
        "width:12px",
        "height:12px",
        "min-width:12px",
        "min-height:12px",
        "margin:0 0 0 -6px",
        "padding:0",
        "border:0",
        "border-radius:6px",
        "box-sizing:border-box",
        "display:block",
        "pointer-events:none",
        "z-index:50",
        "transform:none",
        "overflow:hidden",
        "line-height:0"
      ].join(";");
      dot.textContent = "";
      dot.dataset.xfoStyled = "1";
      dot.dataset.xfoRound = "1";
    }
    if (dot.style.backgroundColor !== color) {
      dot.style.backgroundColor = color;
    }

    dot.classList.toggle("xfo-focal", focal);

    const titleLabel = /^\d{6,}$/.test(String(user || ""))
      ? "user " + user
      : "@" + user;
    const title = titleLabel + ": " + (LABELS[relationship] || relationship);
    if (dot.title !== title) {
      dot.title = title;
      dot.setAttribute("aria-label", title);
    }

    if (user && !/^\d{6,}$/.test(String(user))) {
      ensureMetrics(host, user, focal);
    }
  }

  /**
   * Right-side overlay placement for compact layouts where under-avatar
   * metrics would cover content:
   *  - opened posts (/status/) with full-width body under the avatar
   *  - notifications tab rows (avatar + text share a tight left column)
   *
   * Returns x-offset relative to the avatar host, or null for normal feed.
   * Layout reads are expensive — reuse a cached offset when already placed.
   */
  function focalRightOffset(scope, host) {
    if (!host) return null;
    const path = location.pathname;
    const onStatus = /\/status\//.test(path);
    const onNotifications = /^\/(notifications|i\/notifications)(\/|$)/.test(path);
    if (!onStatus && !onNotifications) return null;

    if (host.dataset.xfoFocal === "1") {
      const cached = parseFloat(host.style.getPropertyValue("--xfo-focal-x"));
      if (isFinite(cached)) return cached;
    }

    const a = host.getBoundingClientRect();
    if (!a.width) return null;

    if (onStatus) {
      const textEl = scope.querySelector('[data-testid="tweetText"]');
      if (!textEl) return null;
      const t = textEl.getBoundingClientRect();
      if (!t.width) return null;
      // Timeline-style rows on a status page keep body beside the avatar.
      if (t.left > a.left + 6) return null;
    }

    // Prefer the three-dots caret when present.
    const caret = scope.querySelector('[data-testid="caret"]');
    if (caret) {
      const c = caret.getBoundingClientRect();
      if (c.width) return c.left + c.width / 2 - a.left;
    }

    // Notifications often have no caret — pin near the row's right edge.
    const art = scope.getBoundingClientRect();
    if (!art.width) return null;
    const RIGHT_MARGIN = onNotifications ? 28 : 24;
    return art.right - a.left - RIGHT_MARGIN;
  }

  function processScope(scope) {
    if (!scope || scope.nodeType !== 1) return;
    if (!isNearViewport(scope)) return;
    const info = authorInfoFromScope(scope);
    if (!info) return;
    const relationship = classify(info.handle, info.restId);
    const user = info.handle || info.restId;
    const host = findAvatarHost(scope);
    if (host) ensureDot(host, relationship, user, focalRightOffset(scope, host));
  }

  function isNearViewport(el) {
    const r = el.getBoundingClientRect();
    const margin = SCAN_VIEW_MARGIN_PX;
    return r.bottom >= -margin && r.top <= (window.innerHeight || 800) + margin;
  }

  function runScan() {
    if (!document.body) return;
    // SPA navigations (feed ↔ post) need a fresh focal layout pass.
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      clearFocalCaches();
    }
    ensureSidebarRail();
    stripMetricsNodes();
    document.querySelectorAll("article").forEach(processScope);
    // Follow/list pages only — avoid walking UserCells on the home feed.
    if (/\/(followers|following|verified_followers|connections)/.test(location.pathname)) {
      document.querySelectorAll('[data-testid="UserCell"]').forEach(processScope);
    }
  }

  function scan() {
    if (syncInFlight) return;
    if (scrolling) {
      scanPendingAfterScroll = true;
      return;
    }
    if (document.hidden) return;
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback
        : null;
    if (idle) {
      if (scanIdleCallbackId != null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(scanIdleCallbackId);
      }
      scanIdleCallbackId = idle(
        () => {
          scanIdleCallbackId = null;
          runScan();
        },
        { timeout: 600 }
      );
    } else {
      runScan();
    }
  }

  function queueScan() {
    if (syncInFlight) return;
    if (scrolling) {
      scanPendingAfterScroll = true;
      return;
    }
    if (scanQueued) return;
    scanQueued = true;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanQueued = false;
      scanTimer = null;
      scan();
      if (pendingVisibleMetricsKick && !syncInFlight) {
        kickVisibleMetrics(true);
      }
    }, SCAN_DEBOUNCE_MS);
  }

  function isXfoNode(node) {
    return (
      !!node &&
      node.nodeType === 1 &&
      (node.classList.contains(DOT_CLASS) ||
        node.classList.contains(METRICS_CLASS) ||
        node.id === "xfo-rail" ||
        node.id === "xfo-rail-panel" ||
        !!(node.closest && (node.closest("#xfo-rail") || node.closest("#xfo-rail-panel"))))
    );
  }

  function isXfoOnlyMutation(mutation) {
    if (isXfoNode(mutation.target)) return true;
    const lists = [mutation.addedNodes, mutation.removedNodes];
    for (const list of lists) {
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (n.nodeType === 3) continue; // text inside our spans
        if (!isXfoNode(n)) return false;
      }
    }
    return mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0;
  }

  /** True when a mutation likely introduced tweets/avatars we care about. */
  function mutationNeedsScan(mutation) {
    if (isXfoOnlyMutation(mutation)) return false;
    const nodes = mutation.addedNodes;
    if (!nodes || !nodes.length) return false;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType !== 1) continue;
      if (
        n.matches &&
        n.matches(
          'article, [data-testid="UserCell"], [data-testid="Tweet-User-Avatar"], [data-testid^="UserAvatar-Container"]'
        )
      ) {
        return true;
      }
      if (
        n.querySelector &&
        n.querySelector(
          'article, [data-testid="UserCell"], [data-testid="Tweet-User-Avatar"]'
        )
      ) {
        return true;
      }
    }
    return false;
  }

  function pageLooksRateLimited() {
    const nodes = document.querySelectorAll(
      '[role="alert"], [data-testid="toast"], [data-testid="error-detail"]'
    );
    for (let i = 0; i < nodes.length; i++) {
      const t = nodes[i].textContent || "";
      if (/rate limited/i.test(t)) return true;
    }
    // X often uses a plain banner without those roles.
    const banners = document.querySelectorAll("div[dir='ltr'] span, div[dir='auto'] span");
    const limit = Math.min(banners.length, 40);
    for (let i = 0; i < limit; i++) {
      const t = banners[i].textContent || "";
      if (/sorry,\s*you are rate limited/i.test(t)) return true;
    }
    return false;
  }

  function watchRateLimitToast() {
    if (!document.body || rateLimitToastObserver) return;
    let lastHit = 0;
    const check = () => {
      const now = Date.now();
      if (now - lastHit < 20000) return;
      if (!pageLooksRateLimited()) return;
      lastHit = now;
      noteRateLimit(METRICS_RATE_LIMIT_FLOOR_MS, "X page rate-limit toast");
    };
    const schedule = () => {
      if (rateLimitToastCheckTimer) return;
      rateLimitToastCheckTimer = setTimeout(() => {
        rateLimitToastCheckTimer = null;
        check();
      }, 600);
    };
    rateLimitToastObserver = new MutationObserver(schedule);
    rateLimitToastObserver.observe(document.body, { childList: true, subtree: true });
    rateLimitToastTimer = setInterval(check, 12000);
  }

  function startObserver() {
    if (observer) observer.disconnect();
    if (!document.body) return;
    observer = new MutationObserver((mutations) => {
      if (syncInFlight) return;
      for (let i = 0; i < mutations.length; i++) {
        if (mutationNeedsScan(mutations[i])) {
          queueScan();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function pauseScanObserver() {
    if (observer) observer.disconnect();
  }

  function resumeScanObserver() {
    startObserver();
  }

  function startIdleScan() {
    if (idleScanTimer) clearInterval(idleScanTimer);
    idleScanTimer = setInterval(() => {
      if (syncInFlight || scrolling || document.hidden) return;
      pruneRecentlyVisible();
      // Empty queue after sync used to skip forever — kick visible handles.
      kickVisibleMetrics(false);
      // Catch tweets the filtered observer might miss (rare).
      queueScan();
    }, METRICS_IDLE_SCAN_MS);
  }

  function startScrollGuard() {
    if (scrollHandler) return;
    scrollHandler = () => {
      scrolling = true;
      scanPendingAfterScroll = true;
      if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
      scrollSettleTimer = setTimeout(() => {
        scrolling = false;
        scrollSettleTimer = null;
        if (scanPendingAfterScroll) {
          scanPendingAfterScroll = false;
          queueScan();
        }
        stripMetricsNodes();
      }, SCAN_SCROLL_SETTLE_MS);
    };
    window.addEventListener("scroll", scrollHandler, {
      passive: true,
      capture: true
    });
  }

  function clearFocalCaches() {
    document.querySelectorAll('[data-xfo-focal="1"]').forEach((host) => {
      delete host.dataset.xfoFocal;
    });
  }

  const RAIL_ICON_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>' +
    '<circle fill="none" stroke="currentColor" stroke-width="2" cx="9" cy="7" r="4"></circle>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M22 21v-2a4 4 0 0 0-3-3.87"></path>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16 3.13a4 4 0 0 1 0 7.75"></path>' +
    "</svg>";

  function findSideNavPostButton() {
    const selectors = [
      '[data-testid="SideNav_NewTweet_Button"]',
      'a[href="/compose/post"]',
      'a[href="/compose/tweet"]'
    ];
    const found = [];
    for (let s = 0; s < selectors.length; s++) {
      const nodes = document.querySelectorAll(selectors[s]);
      for (let i = 0; i < nodes.length; i++) found.push(nodes[i]);
    }
    for (let i = 0; i < found.length; i++) {
      const r = found[i].getBoundingClientRect();
      if (r.width > 2 && r.height > 2) return found[i];
    }
    return found[0] || null;
  }

  function formatRailTime(ts) {
    if (!ts) return "Never";
    try {
      return new Date(ts).toLocaleString();
    } catch (e) {
      return "Never";
    }
  }

  function formatRailClock(ts) {
    try {
      return new Date(ts).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit"
      });
    } catch (e) {
      return "";
    }
  }

  /**
   * Activity row: Paused while X's window or our retry backoff is active,
   * otherwise Live. Days badges may still read "…" while the pump works;
   * the rail does not count pending first-faces.
   */
  function activityStatusText(now) {
    const ts = now || Date.now();
    let until = metricsPausedUntil > ts ? metricsPausedUntil : 0;
    let rateLimited = until > 0 && metricsPauseIsRateLimit;
    if (Budget && budgetState) {
      const st = Budget.status(budgetState, null, ts);
      if (st.paused && st.until > until) {
        until = st.until;
        rateLimited = true;
      }
    }
    if (MetricsRefill && typeof MetricsRefill.activityStatusText === "function") {
      return MetricsRefill.activityStatusText({
        now: ts,
        pausedUntil: until,
        rateLimited: rateLimited,
        formatClock: formatRailClock
      });
    }
    if (until > 0) {
      const clock = formatRailClock(until);
      return (rateLimited ? "Paused · X limit resets " : "Paused · retry at ") + clock;
    }
    return "Live";
  }

  // Official profile total only. Membership length stays off the rail so
  // X's phantom hole (counted but unlistable) is not advertised.
  function setRailCount(el, count) {
    const total = Number(count) || 0;
    const text = String(total);
    if (el.dataset.xfoCount === text) return;
    el.dataset.xfoCount = text;
    el.textContent = text;
  }

  async function refreshRailPanel(panel) {
    if (!panel) return;
    const storageKeys =
      (Sync && Sync.FOLLOW_STORAGE_KEYS) || [
        "following",
        "followers",
        "followingIds",
        "followerIds",
        "followingTotal",
        "followersTotal",
        "selfUsername",
        "lastSyncAt",
        "syncStatus",
        "syncError",
        "syncStartedAt",
        "lastSyncProgressAt",
        "syncProgressLabel",
        "syncNote"
      ];
    let data = lastFollowSnapshot || snapshotFromCache();
    try {
      const fresh = await withTimeout(
        api.storage.local.get(storageKeys),
        (Sync && Sync.STORAGE_MS) || 2000,
        "Read rail status"
      );
      data = Sync && typeof Sync.keepStorageSnapshot === "function"
        ? Sync.keepStorageSnapshot(fresh, data)
        : fresh && typeof fresh === "object" && Object.keys(fresh).length
          ? fresh
          : data;
      rememberFollowSnapshot(data);
    } catch (e) {
      data = lastFollowSnapshot || snapshotFromCache();
    }
    const snap =
      Sync && typeof Sync.followSnapshot === "function"
        ? Sync.followSnapshot(data, snapshotFromCache())
        : data;
    const followingList = asList(snap.following);
    const followersList = asList(snap.followers);
    const followingCount =
      Sync && typeof Sync.displayFollowCount === "function"
        ? Sync.displayFollowCount(snap.followingTotal, followingList)
        : typeof snap.followingTotal === "number"
          ? snap.followingTotal
          : followingList.length;
    const followersCount =
      Sync && typeof Sync.displayFollowCount === "function"
        ? Sync.displayFollowCount(snap.followersTotal, followersList)
        : typeof snap.followersTotal === "number"
          ? snap.followersTotal
          : followersList.length;
    const syncing = snap.syncStatus === "syncing";
    try {
      const keys = await readStoredApiKeys();
      userHasApiKeys = !!(
        XApi &&
        typeof XApi.hasUserApiKeys === "function" &&
        XApi.hasUserApiKeys(keys)
      );
    } catch (eKeys) {
      /* keep the last answer so a storage hiccup does not flash the hint */
    }
    if (snap.hideRateLimitKeysHint === true) keysHintDismissed = true;
    ensureSyncStatusExtras(panel);
    const now = Date.now();
    const backoffUntil = syncInFlight
      ? syncBackoffUntil
      : Number(snap.syncBackoffUntil) || 0;
    const countForStatus = syncInFlight ? syncProgressCount : snap.syncProgressCount;
    const sideForStatus = syncInFlight ? syncProgressSide : snap.syncProgressSide;
    let liveLabel =
      (syncInFlight && syncProgressLabel) || snap.syncProgressLabel || "";
    if (
      Sync &&
      typeof Sync.backoffStatusText === "function" &&
      backoffUntil > now
    ) {
      liveLabel = Sync.backoffStatusText({
        resumeAt: backoffUntil,
        now: now,
        count: countForStatus,
        side: sideForStatus
      });
    }
    const ui = {
      busy: !!syncInFlight,
      busySince: syncStartedAtLocal,
      // Only this tab's own run may vouch for itself; a run owned by
      // another tab is judged by the heartbeat it writes to storage.
      lastProgressAt: syncInFlight ? lastSyncProgressAt : 0,
      storedProgressAt: snap.lastSyncProgressAt,
      syncStatus: snap.syncStatus,
      syncStartedAt: snap.syncStartedAt,
      progressLabel: liveLabel,
      backoffUntil: backoffUntil,
      now: now
    };
    const stuck = Sync
      ? Sync.isStuck(ui)
      : syncing &&
        (!snap.syncStartedAt ||
          Date.now() - Number(snap.syncStartedAt) > 15000);

    const selfEl = panel.querySelector("[data-xfo-self]");
    const followingEl = panel.querySelector("[data-xfo-following]");
    const followersEl = panel.querySelector("[data-xfo-followers]");
    const lastEl = panel.querySelector("[data-xfo-last]");
    const activityEl = panel.querySelector("[data-xfo-activity]");
    const errEl = panel.querySelector("[data-xfo-err]");
    const syncBtn = panel.querySelector("[data-xfo-sync]");
    if (selfEl) {
      const shown = snap.selfUsername || cache.selfUsername;
      selfEl.textContent = shown ? "@" + shown : "—";
    }
    if (followingEl) setRailCount(followingEl, followingCount);
    if (followersEl) setRailCount(followersEl, followersCount);
    if (lastEl) lastEl.textContent = formatRailTime(snap.lastSyncAt);
    if (activityEl) {
      const text = activityStatusText(Date.now());
      if (activityEl.textContent !== text) activityEl.textContent = text;
    }
    const showLive =
      Sync && typeof Sync.showSyncing === "function"
        ? Sync.showSyncing(ui)
        : (syncInFlight || syncing) && !stuck;
    if (errEl) {
      const liveText = showLive
        ? ui.progressLabel || snap.syncError || "Syncing follow lists…"
        : "";
      const empty =
        Sync && typeof Sync.showEmptyFollowBanner === "function"
          ? Sync.showEmptyFollowBanner(snap, { syncing: syncing, busy: !!syncInFlight })
          : !snap.lastSyncAt &&
            snap.followingTotal == null &&
            snap.followersTotal == null &&
            !followingList.length &&
            !followersList.length &&
            !asList(snap.followingIds).length &&
            !asList(snap.followerIds).length &&
            !syncing;
      if (liveText) {
        errEl.hidden = false;
        errEl.classList.add("xfo-info");
        errEl.textContent = liveText;
      } else if (snap.syncError) {
        errEl.hidden = false;
        errEl.classList.remove("xfo-info");
        errEl.textContent = snap.syncError;
      } else if (empty) {
        errEl.hidden = false;
        errEl.classList.remove("xfo-info");
        errEl.textContent = "No follow data yet — tap Sync now.";
      } else if (stuck) {
        errEl.hidden = false;
        errEl.classList.remove("xfo-info");
        errEl.textContent = "Sync looks stuck — tap Sync now to retry.";
      } else if (snap.syncNote) {
        errEl.hidden = false;
        errEl.classList.add("xfo-info");
        errEl.textContent = snap.syncNote;
      } else {
        errEl.hidden = true;
        errEl.classList.remove("xfo-info");
        errEl.textContent = "";
      }
    }
    const ageEl = panel.querySelector("[data-xfo-age]");
    if (ageEl) {
      const beat =
        Sync && typeof Sync.lastProgressAt === "function" ? Sync.lastProgressAt(ui) : 0;
      const ageText =
        showLive && Sync && typeof Sync.lastUpdateText === "function"
          ? Sync.lastUpdateText(beat, now)
          : "";
      ageEl.hidden = !ageText;
      ageEl.textContent = ageText;
    }
    const hintEl = panel.querySelector("[data-xfo-keys-hint]");
    if (hintEl) {
      const showHint =
        Sync && typeof Sync.showRateLimitKeysHint === "function"
          ? Sync.showRateLimitKeysHint({
              backingOff: backoffUntil > now,
              hasKeys: userHasApiKeys,
              dismissed: keysHintDismissed || snap.hideRateLimitKeysHint === true
            })
          : false;
      hintEl.hidden = !showHint;
      const readme = hintEl.querySelector("[data-xfo-keys-readme]");
      if (readme && Sync && Sync.KEYS_HINT_README_URL) {
        readme.href = Sync.KEYS_HINT_README_URL;
      }
    }
    if (syncBtn) {
      const label = Sync ? Sync.buttonText(ui) : stuck ? "Retry sync" : syncing ? "Syncing…" : "Sync now";
      const pulsing = !!(Sync && Sync.showSyncing(ui));
      syncBtn.disabled = Sync ? Sync.buttonDisabled(ui) : syncing && !stuck;
      syncBtn.textContent = label;
      syncBtn.classList.toggle("is-syncing", pulsing);
    }
  }

  let ignoreRailCloseUntil = 0;

  function isRailPanelOpen(panel) {
    return !!(panel && panel.classList.contains("xfo-open"));
  }

  function closeRailPanel() {
    const rail = railHost || document.getElementById("xfo-rail");
    const btn = rail ? rail.querySelector(".xfo-rail-btn") : null;
    const panel = railPanelHost || document.getElementById("xfo-rail-panel");
    if (panel) {
      panel.classList.remove("xfo-open");
      panel.removeAttribute("hidden");
    }
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function positionRailPanel(btn, panel) {
    if (!btn || !panel) return;
    const r = btn.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) return;
    const gap = 6;
    const vw = window.innerWidth || 800;
    const vh = window.innerHeight || 600;
    const panelW = Math.min(panel.offsetWidth || 292, vw - 16);
    const panelH = panel.offsetHeight || 320;
    let left = Math.round(r.right + gap);
    let top = Math.round(r.top + r.height / 2 - panelH / 2);
    if (left + panelW > vw - 8) {
      left = Math.round(r.left - gap - panelW);
    }
    if (top < 8) top = 8;
    if (top + panelH > vh - 8) top = Math.max(8, vh - panelH - 8);
    const originX = r.left + r.width / 2 - left;
    const originY = r.top + r.height / 2 - top;
    panel.style.setProperty("left", left + "px", "important");
    panel.style.setProperty("top", top + "px", "important");
    panel.style.setProperty("right", "auto", "important");
    panel.style.setProperty("bottom", "auto", "important");
    panel.style.setProperty("transform-origin", originX + "px " + originY + "px", "important");
  }

  async function openRailPanel() {
    const rail = railHost || document.getElementById("xfo-rail");
    if (!rail) return;
    const btn = rail.querySelector(".xfo-rail-btn");
    const panel = ensureRailPanel();
    if (!panel || !btn) return;
    ignoreRailCloseUntil = Date.now() + 400;
    panel.removeAttribute("hidden");
    btn.setAttribute("aria-expanded", "true");
    positionRailPanel(btn, panel);
    panel.classList.add("xfo-open");
    try {
      await refreshRailPanel(panel);
    } catch (e) {
      /* still show the card */
    }
    positionRailPanel(btn, panel);
    requestAnimationFrame(() => positionRailPanel(btn, panel));
  }

  function isRailUiTarget(node) {
    let el = node;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || !el.closest) return false;
    return !!(el.closest("#xfo-rail") || el.closest("#xfo-rail-panel"));
  }

  function eventHitsRail(ev) {
    const panel = railPanelHost || document.getElementById("xfo-rail-panel");
    const rail = railHost || document.getElementById("xfo-rail");
    const path = ev && typeof ev.composedPath === "function" ? ev.composedPath() : [];
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      if (n === panel || n === rail) return true;
    }
    let el = ev && ev.target;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (el && panel && panel.contains(el)) return true;
    if (el && rail && rail.contains(el)) return true;
    return isRailUiTarget(el);
  }

  function wireRailControls(rail, panel) {
    if (!rail || rail.dataset.xfoWired === "1") return;
    const btn = rail.querySelector(".xfo-rail-btn");
    const syncBtn = panel && panel.querySelector("[data-xfo-sync]");
    if (!btn || !syncBtn) return;

    function stop(e) {
      e.preventDefault();
      e.stopPropagation();
    }

    function stopBubble(e) {
      e.stopPropagation();
    }

    btn.addEventListener("pointerdown", stopBubble);
    btn.addEventListener("mousedown", stopBubble);
    btn.addEventListener("click", (e) => {
      stop(e);
      const p = railPanelHost || document.getElementById("xfo-rail-panel") || panel;
      if (!isRailPanelOpen(p)) openRailPanel();
      else closeRailPanel();
    });

    if (panel.dataset.xfoSyncWired !== "1") {
      syncBtn.addEventListener(
        "click",
        async (e) => {
          stop(e);
          const p = railPanelHost || document.getElementById("xfo-rail-panel") || panel;
          ignoreRailCloseUntil = Date.now() + 4000;
          p.classList.add("xfo-open");
          syncBtn.textContent = "Syncing…";
          syncBtn.disabled = true;
          const errEl = p.querySelector("[data-xfo-err]");
          if (errEl) {
            errEl.hidden = true;
            errEl.textContent = "";
          }
          try {
            await startSync(true);
          } finally {
            ignoreRailCloseUntil = Date.now() + 800;
            try {
              await refreshRailPanel(p);
            } catch (err) {
              /* keep the card open */
            }
          }
        },
        true
      );
      panel.dataset.xfoSyncWired = "1";
    }

    if (!window.__xfoRailDocClose) {
      window.__xfoRailDocClose = (ev) => {
        if (Date.now() < ignoreRailCloseUntil) return;
        if (eventHitsRail(ev)) return;
        closeRailPanel();
      };
      railDocPointerDown = (ev) => {
        if (eventHitsRail(ev)) ignoreRailCloseUntil = Date.now() + 800;
      };
      document.addEventListener("pointerdown", railDocPointerDown, true);
      document.addEventListener("click", window.__xfoRailDocClose, true);
      railKeepPanelOnIcon = () => {
        const host = railHost || document.getElementById("xfo-rail");
        const b = host && host.querySelector(".xfo-rail-btn");
        const p = railPanelHost || document.getElementById("xfo-rail-panel");
        if (b && isRailPanelOpen(p)) positionRailPanel(b, p);
      };
      window.addEventListener("resize", railKeepPanelOnIcon, { passive: true });
      window.addEventListener("scroll", railKeepPanelOnIcon, { passive: true, capture: true });
    }
    rail.dataset.xfoWired = "1";
  }

  function railThemeControlHTML() {
    if (Theme && typeof Theme.controlHTML === "function") {
      return Theme.controlHTML("xfo-theme");
    }
    return (
      '<div class="xfo-theme" role="radiogroup" aria-label="Theme">' +
      '<button type="button" role="radio" data-theme-option="light" aria-checked="false">Light</button>' +
      '<button type="button" role="radio" data-theme-option="dark" aria-checked="false">Dark</button>' +
      '<button type="button" role="radio" data-theme-option="system" aria-checked="true">Follow system</button>' +
      "</div>"
    );
  }

  function applyThemeToPanel(panel, preference) {
    const pref = Theme
      ? Theme.normalize(preference)
      : preference === "light" || preference === "dark"
        ? preference
        : "system";
    if (document.documentElement) {
      if (Theme) {
        Theme.applyTo(document.documentElement, pref, "data-xfo-theme");
      } else {
        document.documentElement.setAttribute("data-xfo-theme", pref);
      }
    }
    if (!panel) return;
    if (Theme) {
      Theme.applyTo(panel, pref);
      Theme.paintControl(panel, pref);
    } else {
      panel.setAttribute("data-theme", pref);
    }
  }

  function loadAndApplyPageTheme() {
    if (!Theme) {
      applyThemeToPanel(null, "system");
      return Promise.resolve();
    }
    return Theme.read(api, storageTimeout())
      .then((pref) => {
        applyThemeToPanel(
          railPanelHost || document.getElementById("xfo-rail-panel"),
          pref
        );
      })
      .catch(() => applyThemeToPanel(null, "system"));
  }

  function loadAndApplyRailTheme(panel) {
    if (!panel) return Promise.resolve();
    if (panel.dataset.xfoThemeApplied === "1") return Promise.resolve();
    if (!Theme) {
      applyThemeToPanel(panel, "system");
      panel.dataset.xfoThemeApplied = "1";
      return Promise.resolve();
    }
    return Theme.read(api, storageTimeout())
      .then((pref) => {
        applyThemeToPanel(panel, pref);
        panel.dataset.xfoThemeApplied = "1";
      })
      .catch(() => {
        applyThemeToPanel(panel, "system");
        panel.dataset.xfoThemeApplied = "1";
      });
  }

  function wireRailTheme(panel) {
    if (!panel || panel.dataset.xfoThemeWired === "1") return;
    panel.addEventListener(
      "click",
      (e) => {
        const target = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
        const opt = target && target.closest ? target.closest("[data-theme-option]") : null;
        if (!opt || !panel.contains(opt)) return;
        e.preventDefault();
        e.stopPropagation();
        ignoreRailCloseUntil = Date.now() + 800;
        const pref = Theme
          ? Theme.normalize(opt.getAttribute("data-theme-option"))
          : opt.getAttribute("data-theme-option");
        applyThemeToPanel(panel, pref);
        if (Theme) {
          Theme.write(api, pref, storageTimeout()).catch(() => {});
        } else {
          storageSet({ themePreference: pref }).catch(() => {});
        }
      },
      true
    );
    panel.dataset.xfoThemeWired = "1";
  }

  function ensureRailThemeChrome(panel) {
    if (!panel) return;
    if (!panel.querySelector("[data-theme-option]")) {
      const footer = panel.querySelector(".xfo-rail-legend");
      const wrap = document.createElement("div");
      wrap.innerHTML = railThemeControlHTML();
      const node = wrap.firstElementChild;
      if (node) {
        if (footer) panel.insertBefore(node, footer);
        else panel.appendChild(node);
      }
    }
    if (!panel.hasAttribute("data-theme")) {
      panel.setAttribute("data-theme", "system");
    }
    wireRailTheme(panel);
    loadAndApplyRailTheme(panel);
  }

  function railLegendHTML() {
    return (
      '<span class="xfo-rail-leg mutual"><i class="m"></i> Mutual</span>' +
      '<span class="xfo-rail-leg following"><i class="f"></i> You follow</span>' +
      '<span class="xfo-rail-leg follower"><i class="r"></i> Follows you</span>' +
      '<span class="xfo-rail-leg ex-mutual"><i class="x"></i> Was mutual</span>'
    );
  }

  function ensureRailPanel() {
    let panel = railPanelHost && railPanelHost.id === "xfo-rail-panel" ? railPanelHost : null;
    if (!panel) panel = document.getElementById("xfo-rail-panel");
    document.querySelectorAll(".xfo-rail-panel").forEach((el) => {
      if (panel && el !== panel && el.parentNode) el.parentNode.removeChild(el);
    });
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "xfo-rail-panel";
      panel.className = "xfo-rail-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "X Follow Overlay");
      panel.setAttribute("data-theme", "system");
      panel.innerHTML =
        '<header class="xfo-rail-head">' +
        "<h2>X Follow Overlay</h2>" +
        '<p class="xfo-rail-sub">Mutual, you follow, follows you, was mutual</p>' +
        "</header>" +
        '<section class="xfo-rail-card">' +
        '<div class="xfo-rail-row"><span class="xfo-rail-label">Account</span><span class="xfo-rail-value" data-xfo-self>—</span></div>' +
        '<div class="xfo-rail-row"><span class="xfo-rail-label">Following</span><span class="xfo-rail-value" data-xfo-following>0</span></div>' +
        '<div class="xfo-rail-row"><span class="xfo-rail-label">Followers</span><span class="xfo-rail-value" data-xfo-followers>0</span></div>' +
        '<div class="xfo-rail-row"><span class="xfo-rail-label">Last sync</span><span class="xfo-rail-value" data-xfo-last>Never</span></div>' +
        '<p class="xfo-rail-err" data-xfo-err hidden></p>' +
        '<p class="xfo-keys-hint" data-xfo-keys-hint hidden>' +
        "Want faster syncs? Add your own X API keys (paid, optional). " +
        "The free sync keeps working. " +
        '<a href="#" data-xfo-open-keys>settings</a> ' +
        '<a data-xfo-keys-readme target="_blank" rel="noopener">README</a> ' +
        '<button type="button" class="xfo-keys-hint-hide" data-xfo-hide-keys-hint>Don\'t show again</button>' +
        "</p>" +
        '<p class="xfo-rail-age" data-xfo-age hidden></p>' +
        '<button type="button" class="xfo-rail-sync" data-xfo-sync>Sync now</button>' +
        "</section>" +
        railThemeControlHTML() +
        '<footer class="xfo-rail-legend">' +
        railLegendHTML() +
        "</footer>" +
        '<p class="xfo-rail-feedback"><a href="mailto:kevinlogan@mail.grokbot.com">Feedback &amp; support</a></p>';
    }
    const legend = panel.querySelector(".xfo-rail-legend");
    if (legend && !legend.querySelector(".ex-mutual")) legend.innerHTML = railLegendHTML();
    if (!panel.querySelector(".xfo-rail-feedback")) {
      const feedback = document.createElement("p");
      feedback.className = "xfo-rail-feedback";
      feedback.innerHTML =
        '<a href="mailto:kevinlogan@mail.grokbot.com">Feedback &amp; support</a>';
      panel.appendChild(feedback);
    }
    const activityRow = panel.querySelector("[data-xfo-activity]");
    if (activityRow && activityRow.parentElement) activityRow.parentElement.remove();
    const sub = panel.querySelector(".xfo-rail-sub");
    if (sub && /activity|Days|per day/i.test(sub.textContent || "")) {
      sub.textContent = "Mutual, you follow, follows you, was mutual";
    }
    stripMetricsNodes();
    railPanelHost = panel;
    if (document.body && panel.parentElement !== document.body) {
      document.body.appendChild(panel);
    }
    ensureRailThemeChrome(panel);
    ensureSyncStatusExtras(panel);
    return panel;
  }

  function keysHintMarkup() {
    return (
      '<p class="xfo-keys-hint" data-xfo-keys-hint hidden>' +
      "Want faster syncs? Add your own X API keys (paid, optional). " +
      "The free sync keeps working. " +
      '<a href="#" data-xfo-open-keys>settings</a> ' +
      '<a data-xfo-keys-readme target="_blank" rel="noopener">README</a> ' +
      '<button type="button" class="xfo-keys-hint-hide" data-xfo-hide-keys-hint>Don\'t show again</button>' +
      "</p>"
    );
  }

  function wireKeysHint(panel) {
    if (!panel || panel.dataset.xfoKeysHintWired === "1") return;
    panel.addEventListener(
      "click",
      (e) => {
        const target =
          e.target && e.target.nodeType === 1
            ? e.target
            : e.target && e.target.parentElement;
        if (!target || !target.closest) return;
        const hide = target.closest("[data-xfo-hide-keys-hint]");
        const open = target.closest("[data-xfo-open-keys]");
        if (!hide && !open) return;
        e.preventDefault();
        e.stopPropagation();
        ignoreRailCloseUntil = Date.now() + 800;
        if (hide) {
          keysHintDismissed = true;
          const hint = panel.querySelector("[data-xfo-keys-hint]");
          if (hint) hint.hidden = true;
          storageSet({ hideRateLimitKeysHint: true }).catch(() => {});
          return;
        }
        if (api.runtime && api.runtime.sendMessage) {
          api.runtime.sendMessage({ type: "XFO_OPEN_KEYS" }).catch(() => {});
        }
      },
      true
    );
    panel.dataset.xfoKeysHintWired = "1";
  }

  function ensureSyncStatusExtras(panel) {
    if (!panel) return;
    const err = panel.querySelector("[data-xfo-err]");
    if (!panel.querySelector("[data-xfo-keys-hint]")) {
      const wrap = document.createElement("div");
      wrap.innerHTML = keysHintMarkup();
      const hint = wrap.firstElementChild;
      if (hint) {
        if (err && err.parentNode) err.parentNode.insertBefore(hint, err.nextSibling);
        else panel.appendChild(hint);
      }
    }
    if (!panel.querySelector("[data-xfo-age]")) {
      const age = document.createElement("p");
      age.className = "xfo-rail-age";
      age.setAttribute("data-xfo-age", "");
      age.hidden = true;
      const hint = panel.querySelector("[data-xfo-keys-hint]");
      const anchor = hint || err;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(age, anchor.nextSibling);
      else panel.appendChild(age);
    }
    const readme = panel.querySelector("[data-xfo-keys-readme]");
    if (readme && Sync && Sync.KEYS_HINT_README_URL) {
      readme.href = Sync.KEYS_HINT_README_URL;
    }
    wireKeysHint(panel);
  }

  function ensureSidebarRail() {
    const postBtn = findSideNavPostButton();
    if (!postBtn) return;

    const panel = ensureRailPanel();
    let rail = (railHost && railHost.id === "xfo-rail" ? railHost : null) || document.getElementById("xfo-rail");
    document.querySelectorAll("#xfo-rail").forEach((el) => {
      if (rail && el !== rail && el.parentNode) el.parentNode.removeChild(el);
    });

    if (!rail) {
      rail = document.createElement("div");
      rail.id = "xfo-rail";
      rail.className = "xfo-rail";
      rail.innerHTML =
        '<button type="button" class="xfo-rail-btn" aria-label="X Follow Overlay" title="X Follow Overlay" aria-expanded="false" aria-haspopup="dialog">' +
        RAIL_ICON_SVG +
        "</button>";
    } else {
      const nested = rail.querySelector("#xfo-rail-panel, .xfo-rail-panel");
      if (nested && nested !== panel && nested.parentNode) nested.parentNode.removeChild(nested);
    }
    railHost = rail;
    wireRailControls(rail, panel);

    if (Date.now() < railInsertBackoffUntil && !rail.isConnected) return;

    let anchor = postBtn.parentElement;
    if (
      !anchor ||
      anchor === document.body ||
      (anchor.childElementCount > 2 && !anchor.contains(postBtn))
    ) {
      anchor = postBtn;
    } else if (anchor.childElementCount > 2) {
      anchor = postBtn;
    }

    const alreadyPlaced =
      rail.isConnected &&
      rail.previousElementSibling === anchor &&
      rail.parentNode === anchor.parentNode;
    if (alreadyPlaced || !anchor.parentNode) return;

    anchor.parentNode.insertBefore(rail, anchor.nextSibling);
    requestAnimationFrame(() => {
      if (rail.isConnected) {
        railInsertBackoffUntil = 0;
        return;
      }
      railInsertBackoffUntil = Date.now() + 2000;
    });
  }

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || !sender || sender.id !== api.runtime.id) return;
    if (msg.type === "XFO_SESSION") {
      currentSyncRoute().then((route) => {
        sendResponse({ signedIn: !!route.ok });
      });
      return true;
    }
    if (msg.type === "XFO_RUN_SYNC") {
      const routePromise = currentSyncRoute();
      routePromise.then((route) => {
        if (!route.ok) {
          sendResponse({ ok: false, error: route.reason });
          return;
        }
        startSync(true);
        sendResponse({ ok: true, started: true });
      });
      return true;
    }
  }

  if (api.runtime && api.runtime.onMessage && api.runtime.onMessage.addListener) {
    api.runtime.onMessage.addListener(onRuntimeMessage);
  }

  storageChangedHandler = (changes, area) => {
    if (area !== "local") return;
    if (
      changes.following ||
      changes.followers ||
      changes.followingIds ||
      changes.followerIds ||
      changes.followingTotal ||
      changes.followersTotal ||
      changes.lastSyncAt ||
      changes.selfUsername
    ) {
      loadCacheFromStorage().then(() => {
        queueScan();
        if (!syncInFlight) kickVisibleMetrics(false);
      });
    }
    if (changes.passiveRelations && Passive && passiveStore) {
      // Another tab saw a follow change; merge it (newest entry wins).
      passiveStore = Passive.createStore(changes.passiveRelations.newValue, passiveStore);
      queueScan();
    }
    if (changes.exMutuals && ExMutual && exMutualHydrated && !exMutualPersistTimer) {
      exMutualSet = ExMutual.createSet(changes.exMutuals.newValue);
      queueScan();
    }
    if (changes.metricsBudget && Budget && budgetState && !budgetPersistTimer) {
      // Another tab spent from the same windows; take the smaller remaining.
      const theirs = Budget.create(changes.metricsBudget.newValue, Date.now());
      Object.keys(theirs.ops).forEach((op) => {
        const e = theirs.ops[op];
        Budget.note(budgetState, op, {
          limit: e.limit,
          remaining: e.remaining,
          reset: e.resetAt
        }, Date.now());
      });
    }
    const panel = railPanelHost || document.getElementById("xfo-rail-panel");
    if (changes.themePreference) {
      applyThemeToPanel(panel, changes.themePreference.newValue);
    }
    if (isRailPanelOpen(panel)) refreshRailPanel(panel).catch(() => {});
  };
  api.storage.onChanged.addListener(storageChangedHandler);

  async function init() {
    await loadCacheFromStorage();
    try {
      await loadAndApplyPageTheme();
    } catch (eTheme) {
      applyThemeToPanel(null, "system");
    }
    // Drop mass-sync leftovers — counts are lazy/on-screen only now.
    try {
      metricsFailed.clear();
      metricsAttempts.clear();
      metricsQueue.length = 0;
      metricsQueuedSet.clear();
      const cool = await storageGet(["metricsPausedUntil", "metricsBudget"]);
      const storedPause = Number(cool.metricsPausedUntil) || 0;
      metricsPausedUntil = storedPause > Date.now() ? storedPause : 0;
      if (Budget && cool.metricsBudget) {
        // Windows another tab (or the last load) already saw as spent.
        budgetState = Budget.create(cool.metricsBudget, Date.now());
      }
      metricsHold = false;
      metricsRateLimitHits = 0;
      metricsGapMs = METRICS_GAP_DEFAULT_MS;
      try {
        await storageRemove(RETIRED_STORAGE_KEYS);
      } catch (e0) {
        /* ignore */
      }
      await storageSet({
        metricsFailed: [],
        metricsLastError: null
      });
      const stale = await storageGet([
        "syncStatus",
        "syncStartedAt",
        "lastSyncProgressAt",
        "syncBackoffUntil",
        "hideRateLimitKeysHint"
      ]);
      if (stale.hideRateLimitKeysHint === true) keysHintDismissed = true;
      // A sync dies with its page, so a "syncing" marker older than the
      // stuck window is an orphan. Reset it quietly — waiting the full
      // hard timeout left the panel on "Retry sync" for minutes after a
      // reload. The window still protects a just-clicked sync.
      // A live x-rate-limit-reset is not an orphan: the countdown is still real.
      if (Sync && Sync.isSyncing(stale.syncStatus)) {
        const beat = stale.lastSyncProgressAt || stale.syncStartedAt;
        const age = Sync.ageMs(beat, Date.now());
        if (age > Sync.STUCK_MS && !(Number(stale.syncBackoffUntil) > Date.now())) {
          await storageSet({
            syncStatus: null,
            syncError: null,
            syncStartedAt: null
          });
        }
      }
    } catch (e) {
      /* ignore */
    }

    startObserver();
    watchRateLimitToast();
    startIdleScan();
    startScrollGuard();
    if (!resizeHandler) {
      resizeHandler = () => {
        clearFocalCaches();
        queueScan();
      };
      window.addEventListener("resize", resizeHandler, { passive: true });
    }
    injectPageHook();
    ensureSidebarRail();
    startSyncWatchdog();
    queueScan();
    kickVisibleMetrics(true);
    setTimeout(() => {
      queueScan();
      kickVisibleMetrics(true);
    }, 500);
    setTimeout(() => {
      queueScan();
      kickVisibleMetrics(true);
    }, 1500);
    setTimeout(() => {
      queueScan();
      kickVisibleMetrics(true);
    }, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
