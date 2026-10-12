/**
 * Passive follow relations (classic script).
 * Loaded by the content script and Node tests.
 *
 * Every user object X sends to its own web client carries the viewer's
 * relationship to that account (relationship_perspectives.following /
 * followed_by, older payloads legacy.following / followed_by). page-hook.js
 * harvests those from the responses X already fetches and posts compact
 * {id, h, f, b} records; this module stores them and layers them over the
 * synced follow lists so badges stay current with zero requests of our own.
 *
 * Only explicit booleans are recorded. A missing flag means "unknown" and
 * the synced list keeps the last word for that direction.
 */
(function (root) {
  var STORE_VERSION = 1;
  var MAX_ENTRIES = 4000;
  // A follow/unfollow the user just performed beats X's own eventually
  // consistent user objects for a few minutes.
  var ACTION_PIN_MS = 5 * 60 * 1000;
  var MAX_BATCH = 800;

  function cleanHandle(h) {
    if (h == null) return null;
    var s = String(h).toLowerCase().replace(/^@/, "").trim();
    return s ? s : null;
  }

  function cleanId(id) {
    if (id == null) return null;
    var s = String(id);
    return /^\d+$/.test(s) ? s : null;
  }

  function boolOrNull(v) {
    return v === true || v === false ? v : null;
  }

  function emptyStore() {
    return { byId: {}, byHandle: {} };
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    var f = boolOrNull(raw.f);
    var b = boolOrNull(raw.b);
    if (f == null && b == null) return null;
    var t = Number(raw.t) || 0;
    if (!t) return null;
    var entry = { h: cleanHandle(raw.h), f: f, b: b, t: t };
    if (raw.a) entry.a = 1;
    return entry;
  }

  function indexHandle(store, id, entry) {
    if (!entry.h) return;
    var prevId = store.byHandle[entry.h];
    if (prevId && prevId !== id) {
      var prev = store.byId[prevId];
      // Two ids for one handle: the newer observation owns the handle.
      if (prev && prev.t > entry.t) return;
    }
    store.byHandle[entry.h] = id;
  }

  function put(store, id, entry) {
    var old = store.byId[id];
    if (old && old.h && old.h !== entry.h && store.byHandle[old.h] === id) {
      delete store.byHandle[old.h];
    }
    store.byId[id] = entry;
    indexHandle(store, id, entry);
  }

  /**
   * Build an in-memory store from persisted data, keeping whichever copy of
   * an entry is newer when an existing store is passed (storage lags the
   * debounced flush, so a plain reload could roll back fresh observations).
   */
  function createStore(raw, existing) {
    var store = emptyStore();
    var byId = raw && typeof raw === "object" && raw.byId ? raw.byId : null;
    if (byId && typeof byId === "object") {
      Object.keys(byId).forEach(function (rawId) {
        var id = cleanId(rawId);
        var entry = normalizeEntry(byId[rawId]);
        if (id && entry) put(store, id, entry);
      });
    }
    if (existing && existing.byId) {
      Object.keys(existing.byId).forEach(function (id) {
        var mine = existing.byId[id];
        var theirs = store.byId[id];
        if (!theirs || mine.t >= theirs.t) put(store, id, mine);
      });
    }
    return store;
  }

  function serialize(store) {
    return { v: STORE_VERSION, byId: store && store.byId ? store.byId : {} };
  }

  function size(store) {
    return store && store.byId ? Object.keys(store.byId).length : 0;
  }

  function pinned(entry, now) {
    return !!(entry && entry.a && now - entry.t < ACTION_PIN_MS);
  }

  function remove(store, id) {
    var old = store.byId[id];
    if (!old) return;
    delete store.byId[id];
    if (old.h && store.byHandle[old.h] === id) delete store.byHandle[old.h];
  }

  var BASE_PARTS = {
    mutual: { you: true, they: true },
    following: { you: true, they: false },
    follower: { you: false, they: true },
    neither: { you: false, they: false }
  };

  /**
   * True when every direction the entry knows matches the synced class.
   * Such an entry changes no badge, so storing it only crowds out the
   * observations that do. A pinned follow/unfollow is kept regardless: it
   * guards against X's lagging responses until the pin expires.
   */
  function agreesWithSync(entry, base, now) {
    var parts = BASE_PARTS[base];
    if (!parts || !entry || pinned(entry, now)) return false;
    if (entry.f != null && entry.f !== parts.you) return false;
    if (entry.b != null && entry.b !== parts.they) return false;
    return true;
  }

  /**
   * Drop entries the synced lists already agree with. synced(id, handle)
   * returns the synced class or null when it has no answer.
   */
  function dropAgreeing(store, synced, now) {
    if (!store || !store.byId || typeof synced !== "function") return 0;
    var ts = typeof now === "number" ? now : Date.now();
    var ids = Object.keys(store.byId);
    var dropped = 0;
    for (var i = 0; i < ids.length; i++) {
      var entry = store.byId[ids[i]];
      if (agreesWithSync(entry, synced(ids[i], entry.h), ts)) {
        remove(store, ids[i]);
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * Merge harvested records into the store.
   * users: [{id, h, f, b}] — f = viewer follows them, b = they follow viewer,
   * either may be null (unknown). opts.action marks a follow/unfollow the
   * user just performed (f is authoritative and pinned for ACTION_PIN_MS).
   * opts.synced(id, handle), when given, returns the synced class; an
   * observation that agrees with it is not stored (and clears a stale one).
   * Returns the ids whose relationship changed and every id→handle pair seen.
   */
  function ingest(store, users, opts) {
    opts = opts || {};
    var now = typeof opts.now === "number" ? opts.now : Date.now();
    var synced = typeof opts.synced === "function" ? opts.synced : null;
    var selfHandle = cleanHandle(opts.selfHandle);
    var selfId = cleanId(opts.selfId);
    var list = Array.isArray(users) ? users.slice(0, MAX_BATCH) : [];
    var changed = [];
    var pairs = [];
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (!u || typeof u !== "object") continue;
      var id = cleanId(u.id);
      if (!id || id === selfId) continue;
      var handle = cleanHandle(u.h);
      if (selfHandle && handle === selfHandle) continue;
      var f = boolOrNull(u.f);
      var b = boolOrNull(u.b);
      if (handle) pairs.push({ id: id, handle: handle });
      if (f == null && b == null) continue;

      var old = store.byId[id];
      var next = {
        h: handle || (old && old.h) || null,
        f: f != null ? f : old ? old.f : null,
        b: b != null ? b : old ? old.b : null,
        t: now
      };
      if (opts.action) {
        next.a = 1;
      } else if (old && pinned(old, now)) {
        // Keep the user's own action for the direction it set.
        next.f = old.f;
        next.a = 1;
        next.t = old.t;
        if (b == null) next.b = old.b;
      }
      var was = old ? old.f + "/" + old.b : "new";
      var is = next.f + "/" + next.b;
      if (synced && agreesWithSync(next, synced(id, next.h), now)) {
        if (old) {
          remove(store, id);
          changed.push(id);
        }
        continue;
      }
      put(store, id, next);
      if (was !== is) changed.push(id);
    }
    return { changed: changed, idPairs: pairs };
  }

  function lookup(store, handle, id) {
    if (!store || !store.byId) return null;
    var sid = cleanId(id);
    if (sid && store.byId[sid]) return store.byId[sid];
    var h = cleanHandle(handle);
    if (h && store.byHandle[h]) return store.byId[store.byHandle[h]] || null;
    return null;
  }

  /**
   * What X last said about this account, if it is newer than the last full
   * sync. Older observations are superseded by the synced lists.
   */
  function relationFor(store, handle, id, lastSyncAt) {
    var entry = lookup(store, handle, id);
    if (!entry) return null;
    var since = Number(lastSyncAt) || 0;
    if (entry.t <= since) return null;
    if (entry.f == null && entry.b == null) return null;
    return { following: entry.f, followedBy: entry.b, at: entry.t };
  }

  /**
   * Layer a passive observation over a synced classification. Directions
   * the observation does not know keep the synced answer. A mutual who
   * stops following back (followedBy explicitly false) while the viewer
   * still follows them is ex_mutual — the red mark — not plain following.
   */
  function mergeRelationship(base, rel) {
    var parts = BASE_PARTS[base];
    if (!parts || !rel) return base;
    var you = rel.following != null ? rel.following : parts.you;
    var they = rel.followedBy != null ? rel.followedBy : parts.they;
    if (you && they) return "mutual";
    if (you && !they && base === "mutual" && rel.followedBy === false) return "ex_mutual";
    if (you) return "following";
    if (they) return "follower";
    return "neither";
  }

  /**
   * Drop observations a completed sync has superseded (opts.before = sync
   * start) and keep at most opts.max newest entries.
   */
  function prune(store, opts) {
    opts = opts || {};
    var before = Number(opts.before) || 0;
    var max = typeof opts.max === "number" ? opts.max : MAX_ENTRIES;
    var ids = Object.keys(store.byId);
    var keep = [];
    for (var i = 0; i < ids.length; i++) {
      var entry = store.byId[ids[i]];
      if (before && entry.t <= before) continue;
      keep.push(ids[i]);
    }
    if (keep.length > max) {
      keep.sort(function (a, b) {
        return store.byId[b].t - store.byId[a].t;
      });
      keep = keep.slice(0, max);
    }
    var next = emptyStore();
    for (var j = 0; j < keep.length; j++) put(next, keep[j], store.byId[keep[j]]);
    return next;
  }

  function idPairs(store) {
    var out = [];
    if (!store || !store.byId) return out;
    Object.keys(store.byId).forEach(function (id) {
      var h = store.byId[id].h;
      if (h) out.push({ id: id, handle: h });
    });
    return out;
  }

  var XFOPassiveRelations = {
    STORE_VERSION: STORE_VERSION,
    MAX_ENTRIES: MAX_ENTRIES,
    ACTION_PIN_MS: ACTION_PIN_MS,
    MAX_BATCH: MAX_BATCH,
    createStore: createStore,
    serialize: serialize,
    size: size,
    ingest: ingest,
    lookup: lookup,
    relationFor: relationFor,
    mergeRelationship: mergeRelationship,
    agreesWithSync: agreesWithSync,
    dropAgreeing: dropAgreeing,
    prune: prune,
    idPairs: idPairs
  };

  root.XFOPassiveRelations = XFOPassiveRelations;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOPassiveRelations;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
