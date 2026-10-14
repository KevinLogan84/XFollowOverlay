/**
 * Repeat free syncs.
 * After a full reconcile, page the signed-in follow lists newest-first,
 * add accounts that are not stored yet, and stop after 20 known accounts
 * in a row. A full reconcile still runs every 24 hours, every 5th free
 * sync, or when the profile counts no longer match the stored totals,
 * so unfollows are not left in the list forever.
 */
(function (root) {
  var KNOWN_STREAK_STOP = 20;
  var FULL_RECONCILE_EVERY = 5;
  var FULL_RECONCILE_MS = 24 * 60 * 60 * 1000;

  function countOrNull(value) {
    if (value == null || value === "") return null;
    var n = Number(value);
    if (!isFinite(n) || n < 0) return null;
    return n;
  }

  function listCount(value) {
    if (value == null) return 0;
    if (typeof value === "number" && isFinite(value)) return value;
    if (value instanceof Set) return value.size;
    return Array.isArray(value) ? value.length : 0;
  }

  /**
   * True when this free sync must walk both sides.
   * A follower change is not one of these reasons: each side decides
   * after its own merge. freeSyncCount is the 1-based number of the
   * sync about to run. A leftover full-crawl checkpoint is resumed
   * instead of being ignored.
   */
  function needsFullReconcile(input) {
    input = input || {};
    if (!input.hadFullSync) return true;
    if (input.hasCheckpoint) return true;
    var now = typeof input.now === "number" ? input.now : Date.now();
    var last = Number(input.lastFullSyncAt) || 0;
    if (!last || now - last >= FULL_RECONCILE_MS) return true;
    var n = Number(input.freeSyncCount) || 0;
    if (n > 0 && n % FULL_RECONCILE_EVERY === 0) return true;
    return false;
  }

  /**
   * After this side's incremental merge, a list longer than the profile
   * count is a follow that replaced an unfollow. An unreadable profile
   * count full-reconciles this side only.
   */
  function sideNeedsFullReconcile(input) {
    input = input || {};
    var profile = countOrNull(input.profileCount);
    if (profile == null) return true;
    var merged = listCount(input.merged);
    if (input.mergedIds != null) merged = Math.max(merged, listCount(input.mergedIds));
    return merged > profile;
  }

  function createScan() {
    return { added: [], renames: [], knownStreak: 0, stopped: false, scanned: 0 };
  }

  function asHandleSet(value) {
    var set = new Set();
    if (!value) return set;
    var list = value instanceof Set ? Array.from(value) : Array.isArray(value) ? value : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] == null || list[i] === "") continue;
      set.add(String(list[i]).toLowerCase());
    }
    return set;
  }

  function asIdSet(value) {
    var set = new Set();
    if (!value) return set;
    var list = value instanceof Set ? Array.from(value) : Array.isArray(value) ? value : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] == null || list[i] === "") continue;
      set.add(String(list[i]));
    }
    return set;
  }

  function accountParts(account) {
    if (account == null) return { handle: "", id: "" };
    if (typeof account === "string") return { handle: account.toLowerCase(), id: "" };
    var handle = account.handle ? String(account.handle).toLowerCase() : "";
    var id = account.id != null && account.id !== "" ? String(account.id) : "";
    return { handle: handle, id: id };
  }

  function isKnownAccount(account, handles, ids) {
    var parts = accountParts(account);
    if (parts.handle && handles.has(parts.handle)) return true;
    if (parts.id && ids.has(parts.id)) return true;
    return false;
  }

  /**
   * Walk accounts in newest-first order. Unknown accounts are added and
   * reset the streak. The walk stops once KNOWN_STREAK_STOP known accounts
   * have been seen in a row; anything after that is left unread.
   * Pass the same state into the next page to keep the streak.
   */
  function takeIncremental(accounts, knownHandles, knownIds, state) {
    if (!state) state = createScan();
    if (!state.renames) state.renames = [];
    if (state.stopped) return state;
    var handles = asHandleSet(knownHandles);
    var ids = asIdSet(knownIds);
    var list = Array.isArray(accounts) ? accounts : [];
    for (var i = 0; i < list.length; i++) {
      if (state.stopped) break;
      state.scanned += 1;
      var parts = accountParts(list[i]);
      if (isKnownAccount(parts, handles, ids)) {
        state.knownStreak += 1;
        if (parts.id && parts.handle && ids.has(parts.id) && !handles.has(parts.handle)) {
          state.renames.push({ id: parts.id, handle: parts.handle });
        }
        if (state.knownStreak >= KNOWN_STREAK_STOP) state.stopped = true;
      } else if (parts.handle || parts.id) {
        state.knownStreak = 0;
        state.added.push(parts);
      }
    }
    return state;
  }

  /**
   * idMap is id → handle. A known id with a new handle replaces the old
   * handle in the list and in the map. The id stays put.
   */
  function refreshHandles(handles, renames, idMap) {
    var list = [];
    var source = Array.isArray(handles) ? handles : [];
    for (var h = 0; h < source.length; h++) {
      if (source[h] == null || source[h] === "") continue;
      list.push(String(source[h]).toLowerCase());
    }
    var map = idMap && typeof idMap === "object" ? idMap : null;
    var pending = Array.isArray(renames) ? renames : [];
    for (var i = 0; i < pending.length; i++) {
      var id = pending[i] && pending[i].id != null ? String(pending[i].id) : "";
      var next = pending[i] && pending[i].handle ? String(pending[i].handle).toLowerCase() : "";
      if (!id || !next) continue;
      var prev = map && map[id] ? String(map[id]).toLowerCase() : "";
      if (map) map[id] = next;
      if (prev && prev !== next) {
        for (var j = 0; j < list.length; j++) {
          if (list[j] === prev) list[j] = next;
        }
      } else if (list.indexOf(next) < 0) {
        list.unshift(next);
      }
    }
    var seen = {};
    var out = [];
    for (var k = 0; k < list.length; k++) {
      if (seen[list[k]]) continue;
      seen[list[k]] = 1;
      out.push(list[k]);
    }
    return out;
  }

  function mergeNewestFirst(previous, added, field) {
    var seen = {};
    var out = [];
    function push(value) {
      if (value == null || value === "") return;
      var text = String(value);
      var key = field === "id" ? text : text.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      out.push(field === "id" ? text : text.toLowerCase());
    }
    var fresh = Array.isArray(added) ? added : [];
    var old = Array.isArray(previous) ? previous : [];
    for (var i = 0; i < fresh.length; i++) {
      var item = fresh[i];
      if (item && typeof item === "object") push(field ? item[field] : item.handle || item.id);
      else push(item);
    }
    for (var j = 0; j < old.length; j++) push(old[j]);
    return out;
  }

  var XFOIncrementalSync = {
    KNOWN_STREAK_STOP: KNOWN_STREAK_STOP,
    FULL_RECONCILE_EVERY: FULL_RECONCILE_EVERY,
    FULL_RECONCILE_MS: FULL_RECONCILE_MS,
    needsFullReconcile: needsFullReconcile,
    sideNeedsFullReconcile: sideNeedsFullReconcile,
    createScan: createScan,
    takeIncremental: takeIncremental,
    refreshHandles: refreshHandles,
    mergeNewestFirst: mergeNewestFirst
  };

  root.XFOIncrementalSync = XFOIncrementalSync;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XFOIncrementalSync;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
