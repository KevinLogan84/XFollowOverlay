/**
 * Lost-mutual marks (classic script).
 * Loaded by the content script and Node tests.
 *
 * Someone the viewer still follows, who used to be mutual and then stopped
 * following back, paints red — a cue to unfollow. The set is learned from
 * two local signals only: the previous/next follow lists on a completed
 * sync, and a passive observation that a mutual's followedBy flipped false.
 * No extra friends/followers requests.
 */
(function (root) {
  var CLASS = "ex_mutual";
  var STORE_VERSION = 1;

  function cleanHandle(h) {
    if (typeof h !== "string") return null;
    var s = h.toLowerCase().replace(/^@/, "").trim();
    if (!s || !/^[a-z0-9_]{1,15}$/.test(s)) return null;
    return s;
  }

  function cleanId(id) {
    if (typeof id === "string" && /^\d+$/.test(id)) return id;
    if (typeof id === "number" && isFinite(id) && id > 0 && Math.floor(id) === id) return String(id);
    return null;
  }

  function emptySet() {
    return { ids: {}, handles: {} };
  }

  function createSet(raw) {
    var set = emptySet();
    if (!raw || typeof raw !== "object") return set;
    var ids = raw.ids && typeof raw.ids === "object" ? raw.ids : null;
    var handles = raw.handles && typeof raw.handles === "object" ? raw.handles : null;
    if (ids) {
      Object.keys(ids).forEach(function (rawId) {
        var sid = cleanId(rawId);
        if (!sid) return;
        var h = cleanHandle(ids[rawId]);
        set.ids[sid] = h || true;
        if (h) set.handles[h] = sid;
      });
    }
    if (handles) {
      Object.keys(handles).forEach(function (rawHandle) {
        var h = cleanHandle(rawHandle);
        if (!h) return;
        var sid = cleanId(handles[rawHandle]);
        if (set.handles[h] && typeof set.handles[h] === "string" && !sid) return;
        set.handles[h] = sid || (typeof set.handles[h] === "string" ? set.handles[h] : true);
        if (sid) set.ids[sid] = h;
      });
    }
    return set;
  }

  function serialize(set) {
    return {
      v: STORE_VERSION,
      ids: set && set.ids ? set.ids : {},
      handles: set && set.handles ? set.handles : {}
    };
  }

  function union(a, b) {
    var set = createSet(serialize(a));
    var extra = b && b.ids && b.handles ? b : createSet(b);
    Object.keys(extra.ids).forEach(function (id) {
      remember(set, typeof extra.ids[id] === "string" ? extra.ids[id] : null, id);
    });
    Object.keys(extra.handles).forEach(function (h) {
      remember(set, h, typeof extra.handles[h] === "string" ? extra.handles[h] : null);
    });
    return set;
  }

  function remember(set, handle, id) {
    if (!set) return false;
    var h = cleanHandle(handle);
    var sid = cleanId(id);
    if (h && !sid && typeof set.handles[h] === "string") sid = set.handles[h];
    if (sid && !h && typeof set.ids[sid] === "string") h = set.ids[sid];
    if (!h && !sid) return false;
    var changed = false;
    if (sid) {
      var prev = set.ids[sid];
      var next = h || (typeof prev === "string" ? prev : true);
      if (prev !== next) {
        set.ids[sid] = next;
        changed = true;
      }
    }
    if (h) {
      var prevH = set.handles[h];
      var nextH = sid || (typeof prevH === "string" ? prevH : true);
      if (prevH !== nextH) {
        set.handles[h] = nextH;
        changed = true;
      }
    }
    return changed;
  }

  function forget(set, handle, id) {
    if (!set) return false;
    var h = cleanHandle(handle);
    var sid = cleanId(id);
    if (h && !sid && set.handles[h] && typeof set.handles[h] === "string") sid = set.handles[h];
    if (sid && !h && set.ids[sid] && typeof set.ids[sid] === "string") h = set.ids[sid];
    var changed = false;
    if (sid && Object.prototype.hasOwnProperty.call(set.ids, sid)) {
      delete set.ids[sid];
      changed = true;
    }
    if (h && Object.prototype.hasOwnProperty.call(set.handles, h)) {
      delete set.handles[h];
      changed = true;
    }
    return changed;
  }

  function has(set, handle, id) {
    if (!set) return false;
    var h = cleanHandle(handle);
    var sid = cleanId(id);
    if (sid && set.ids && set.ids[sid]) return true;
    if (h && set.handles && set.handles[h]) return true;
    return false;
  }

  /**
   * Turn a layered relationship into the class to paint.
   * ex_mutual is remembered. following stays red only when already lost.
   * mutual / follower / neither clear the mark (they followed back, or the
   * viewer no longer follows them). opts.allowClear false skips clears so a
   * scan before storage hydration cannot wipe the persisted set.
   */
  function paintClass(set, relation, handle, id, opts) {
    opts = opts || {};
    var allowClear = opts.allowClear !== false;
    if (!set) return { relation: relation, changed: false };
    if (relation === CLASS) {
      return { relation: CLASS, changed: remember(set, handle, id) };
    }
    if (relation === "following") {
      return {
        relation: has(set, handle, id) ? CLASS : "following",
        changed: false
      };
    }
    if (relation === "mutual" || relation === "follower" || relation === "neither") {
      if (!allowClear) return { relation: relation, changed: false };
      return { relation: relation, changed: forget(set, handle, id) };
    }
    return { relation: relation, changed: false };
  }

  function eachValue(list, fn) {
    if (!list || typeof list === "string") return;
    if (typeof list.forEach === "function") {
      list.forEach(function (v) {
        fn(v);
      });
      return;
    }
    if (typeof list === "object") {
      Object.keys(list).forEach(function (k) {
        if (list[k]) fn(k);
      });
    }
  }

  function collectHandles(list) {
    var out = {};
    eachValue(list, function (v) {
      var h = cleanHandle(v);
      if (h) out[h] = 1;
    });
    return out;
  }

  function collectIds(list) {
    var out = {};
    eachValue(list, function (v) {
      var id = cleanId(v);
      if (id) out[id] = 1;
    });
    return out;
  }

  function hasAny(map) {
    return Object.keys(map).length > 0;
  }

  function indexIdMap(map) {
    var byId = {};
    var byHandle = {};
    if (!map || typeof map !== "object") return { byId: byId, byHandle: byHandle };
    Object.keys(map).forEach(function (rawId) {
      var id = cleanId(rawId);
      var h = cleanHandle(map[rawId]);
      if (!id || !h) return;
      byId[id] = h;
      byHandle[h] = id;
    });
    return { byId: byId, byHandle: byHandle };
  }

  /**
   * true when any list includes them, false when every list that can
   * answer says no, "disagree" when the handle list includes them and the
   * id list does not (a reused handle snapshot laid over a newer id list).
   * A missing handle with the id present is a lookup miss, not a conflict:
   * the id still counts. null when this account cannot be checked.
   */
  function membership(handlesKnown, idsKnown, handle, id, handleMap, idMap) {
    var byH = handlesKnown && handle ? !!handleMap[handle] : null;
    var byI = idsKnown && id ? !!idMap[id] : null;
    if (byI === true || byH === true) {
      if (byH === true && byI === false) return "disagree";
      return true;
    }
    if (byH === null && byI === null) return null;
    return false;
  }

  /**
   * A reused follower snapshot is not a new observation that they followed
   * back. Keep painting the stored mark as "you follow" until a follower
   * list we actually refreshed says otherwise.
   */
  function relationAfterReuse(relation, set, handle, id, reuse) {
    if (relation === "mutual" && reuse && reuse.followers && has(set, handle, id)) {
      return "following";
    }
    return relation;
  }

  /**
   * On a completed following+followers replace, remember ids/handles that
   * were in both previous sets and are still followed but no longer follow
   * back. Drop marks the new lists no longer describe as "you follow, they
   * don't". An empty side against a non-empty previous side is ignored so a
   * failed replace cannot paint the whole graph red.
   *
   * opts.trustFollowing / opts.trustFollowers default true. A side that was
   * filled from the previous snapshot (the short-pull fallback) is not
   * trusted: it must not clear a red mark or mint new ones.
   * Handle and id lists that disagree also leave an existing mark alone.
   */
  function applySyncDelta(set, previous, next, opts) {
    set = set && set.ids && set.handles ? set : createSet(set);
    previous = previous || {};
    next = next || {};
    opts = opts || {};
    var trustYou = opts.trustFollowing !== false;
    var trustThey = opts.trustFollowers !== false;
    if (!trustYou && !trustThey) return set;
    var prevYouH = collectHandles(previous.following);
    var prevTheyH = collectHandles(previous.followers);
    var prevYouI = collectIds(previous.followingIds);
    var prevTheyI = collectIds(previous.followerIds);
    var nextYouH = collectHandles(next.following);
    var nextTheyH = collectHandles(next.followers);
    var nextYouI = collectIds(next.followingIds);
    var nextTheyI = collectIds(next.followerIds);
    if (
      (hasAny(prevTheyH) || hasAny(prevTheyI)) &&
      !hasAny(nextTheyH) &&
      !hasAny(nextTheyI)
    ) {
      return set;
    }
    if (
      (hasAny(prevYouH) || hasAny(prevYouI)) &&
      !hasAny(nextYouH) &&
      !hasAny(nextYouI)
    ) {
      return set;
    }

    var selfHandle = cleanHandle(next.selfUsername || previous.selfUsername);
    var selfId = cleanId(next.selfId || previous.selfId);
    var links = indexIdMap(next.idMap || previous.idMap);
    var handlesKnown = hasAny(nextYouH) || hasAny(nextTheyH);
    var idsKnown = hasAny(nextYouI) || hasAny(nextTheyI);

    function lostNow(handle, id) {
      var you = membership(handlesKnown, idsKnown, handle, id, nextYouH, nextYouI);
      var they = membership(handlesKnown, idsKnown, handle, id, nextTheyH, nextTheyI);
      return you === true && they === false;
    }

    if (trustYou && trustThey && handlesKnown) {
      Object.keys(prevYouH).forEach(function (h) {
        if (!prevTheyH[h] || h === selfHandle) return;
        var id = links.byHandle[h] || null;
        if (lostNow(h, id)) remember(set, h, id);
      });
    }
    if (trustYou && trustThey && idsKnown) {
      Object.keys(prevYouI).forEach(function (id) {
        if (!prevTheyI[id] || id === selfId) return;
        var h = links.byId[id] || null;
        if (selfHandle && h === selfHandle) return;
        if (lostNow(h, id)) remember(set, h, id);
      });
    }

    function stillLost(handle, id) {
      var you = membership(handlesKnown, idsKnown, handle, id, nextYouH, nextYouI);
      var they = membership(handlesKnown, idsKnown, handle, id, nextTheyH, nextTheyI);
      if (!trustThey) {
        // Not a re-follow. Clear only when a refreshed following list
        // shows the viewer unfollowed them.
        return you !== false;
      }
      if (!trustYou) {
        // Following list is the previous snapshot. Clear only when a
        // refreshed follower list shows they follow again.
        return they !== true;
      }
      if (they === true || you === false) return false;
      if (you !== true || they === "disagree" || they === null) return true;
      return they === false;
    }

    Object.keys(set.handles).forEach(function (h) {
      if (!set.handles[h]) return;
      var id = typeof set.handles[h] === "string" ? set.handles[h] : null;
      if (!stillLost(h, id)) forget(set, h, id);
    });
    Object.keys(set.ids).forEach(function (id) {
      if (!set.ids[id]) return;
      var h = typeof set.ids[id] === "string" ? set.ids[id] : null;
      if (!stillLost(h, id)) forget(set, h, id);
    });
    return set;
  }

  var XFOExMutual = {
    CLASS: CLASS,
    STORE_VERSION: STORE_VERSION,
    createSet: createSet,
    serialize: serialize,
    union: union,
    remember: remember,
    forget: forget,
    has: has,
    paintClass: paintClass,
    relationAfterReuse: relationAfterReuse,
    applySyncDelta: applySyncDelta
  };

  root.XFOExMutual = XFOExMutual;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOExMutual;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
