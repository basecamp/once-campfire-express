import { createHash } from "node:crypto";
import { db, now, writeEpoch } from "./db.js";
import { searchMessageIds } from "./domain.js";
import { fastEtag, sendPage, splicedGzipCache } from "./gzip.js";
import { epoch as timeOf, renderChunks } from "./rendering.js";

const OVERHEAD = 256;

class Page {
  gzipped = null;
  cache = null;
  cost = 0;
  epoch = undefined;
  validator = undefined;
  deps = undefined;
  constructor(chunks, etag, bytes = Buffer.concat(chunks)) {
    this.chunks = chunks;
    this.bytes = bytes;
    this.etag = etag;
  }
  gzip() {
    if (!this.gzipped) {
      this.gzipped = splicedGzipCache.gzipChunks(this.chunks, this.bytes);
      this.cache?.charge(this, this.gzipped.length);
    }
    return this.gzipped;
  }
}

// Byte-bounded LRU of whole rendered HTML pages, each stamped with the database epoch it was
// rendered or last revalidated in. A page without a validator is valid for that epoch only and
// is dropped as soon as the epoch moves; a page with one is revalidated by the caller instead.
export class ResponseCache {
  #entries = new Map();
  #unvalidated = new Set();
  #epoch;
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #revalidated = 0;
  #invalidated = 0;
  #mismatches = 0;

  constructor(budget) {
    this.budget = budget;
    this.maxEntry = Math.floor(budget / 8);
  }

  stats() {
    return {
      hits: this.#hits,
      misses: this.#misses,
      revalidated: this.#revalidated,
      invalidated: this.#invalidated,
      mismatches: this.#mismatches,
      bytes: this.#bytes,
      entries: this.#entries.size,
      budget: this.budget,
    };
  }

  clear() {
    for (const page of this.#entries.values()) page.cache = null;
    this.#entries.clear();
    this.#unvalidated.clear();
    this.#bytes = 0;
  }

  // Returns the entry for key, current or not; a hit is counted only when it is current.
  get(key, epoch) {
    if (epoch !== this.#epoch) {
      for (const stale of this.#unvalidated)
        this.#drop(stale, this.#entries.get(stale));
      this.#epoch = epoch;
    }
    const page = this.#entries.get(key);
    if (!page) {
      this.#misses++;
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, page);
    if (page.epoch === epoch) this.#hits++;
    return page;
  }

  set(key, epoch, page) {
    if (epoch !== this.#epoch || page.bytes.length > this.maxEntry) return;
    const replaced = this.#entries.get(key);
    if (replaced) this.#drop(key, replaced);
    page.key = key;
    page.cache = this;
    page.epoch = epoch;
    page.cost =
      page.bytes.length +
      (page.gzipped?.length || 0) +
      key.length * 2 +
      (page.validator?.length || 0) * 2 +
      (page.deps ? JSON.stringify(page.deps).length * 2 : 0) +
      OVERHEAD;
    this.#entries.set(key, page);
    if (!page.validator) this.#unvalidated.add(key);
    this.#bytes += page.cost;
    this.#evict();
  }

  revalidated(page, epoch) {
    page.epoch = epoch;
    this.#hits++;
    this.#revalidated++;
  }

  invalidate(page, { mismatch = false } = {}) {
    if (this.#entries.get(page.key) === page) this.#drop(page.key, page);
    this.#misses++;
    this.#invalidated++;
    if (mismatch) this.#mismatches++;
  }

  charge(page, bytes) {
    if (this.#entries.get(page.key) !== page) return;
    page.cost += bytes;
    this.#bytes += bytes;
    this.#evict();
  }

  #drop(key, page) {
    this.#entries.delete(key);
    this.#unvalidated.delete(key);
    this.#bytes -= page.cost;
    page.cache = null;
  }

  #evict() {
    for (const [key, page] of this.#entries) {
      if (this.#bytes <= this.budget) break;
      this.#drop(key, page);
    }
  }
}

export function budgetFromEnv(value) {
  const mb = value === undefined || value === "" ? NaN : Number(value);
  return Math.floor((Number.isFinite(mb) && mb >= 0 ? mb : 32) * 1024 * 1024);
}

export const responseCache = new ResponseCache(
  budgetFromEnv(process.env.CAMPFIRE_RESPONSE_CACHE_MB),
);

// Validator queries read exactly what the cached pages print (see dependOn() call sites).
// Message bodies are the one input represented by timestamps instead of content; see SETTLE_MS.
const VALIDATOR_SQL = {
  logo: "SELECT EXISTS(SELECT 1 FROM active_storage_attachments WHERE record_type='Account' AND record_id=? AND name='logo') AS value",
  room: "SELECT json_array(r.id,r.name,r.type,r.creator_id,r.updated_at,m.involvement,CASE WHEN r.type='Rooms::Direct' THEN (SELECT json_group_array(json_array(u.id,u.name)) FROM memberships d JOIN users u ON u.id=d.user_id WHERE d.room_id=r.id) END) AS value FROM rooms r LEFT JOIN memberships m ON m.room_id=r.id AND m.user_id=?1 WHERE r.id=?2",
  sidebar:
    "SELECT json_group_array(json_array(r.id,r.name,r.type,m.involvement,m.unread_at IS NOT NULL,CASE WHEN r.type='Rooms::Direct' THEN json_array(r.updated_at,(SELECT json_group_array(json_array(u.id,u.name,u.updated_at)) FROM memberships d JOIN users u ON u.id=d.user_id WHERE d.room_id=r.id)) END)) AS value FROM memberships m JOIN rooms r ON r.id=m.room_id WHERE m.user_id=?",
  searches:
    "SELECT json_group_array(json_array(id,query,updated_at)) AS value FROM (SELECT id,query,updated_at FROM searches WHERE user_id=? ORDER BY updated_at DESC LIMIT 10)",
  messages:
    "SELECT json_group_array(json_array(m.id,m.room_id,m.creator_id,m.client_message_id,m.created_at,m.updated_at,u.name,u.updated_at,r.name,t.id,t.updated_at,length(t.body),substr(t.body,1,32)||substr(t.body,-32),a.blob_id)) AS value, max(t.updated_at) AS newest, (SELECT json_group_array(json_array(b.id,b.message_id,b.booster_id,b.content,b.updated_at,bu.name,bu.updated_at)) FROM json_each(?1) k JOIN boosts b ON b.message_id=k.value JOIN users bu ON bu.id=b.booster_id) AS boosts FROM json_each(?1) j JOIN messages m ON m.id=j.value JOIN users u ON u.id=m.creator_id JOIN rooms r ON r.id=m.room_id LEFT JOIN action_text_rich_texts t ON t.record_type='Message' AND t.record_id=m.id AND t.name='body' LEFT JOIN active_storage_attachments a ON a.record_type='Message' AND a.record_id=m.id AND a.name='attachment'",
  tail: "SELECT (SELECT id FROM messages WHERE room_id=?1 ORDER BY id DESC LIMIT 1) AS top, EXISTS(SELECT 1 FROM messages WHERE room_id=?1 AND id>?2 AND (?3 IS NULL OR created_at<=?3)) AS entered",
};

const connections = new WeakMap();
let nextConnection = 0;
function connectionState(connection) {
  let state = connections.get(connection);
  if (!state) {
    state = {
      id: nextConnection++,
      dataVersion: connection.prepare("PRAGMA data_version"),
      user: connection.prepare("SELECT * FROM users WHERE id=?"),
      account: connection.prepare("SELECT * FROM accounts ORDER BY id LIMIT 1"),
      ...Object.fromEntries(
        Object.entries(VALIDATOR_SQL).map(([name, sql]) => [
          name,
          connection.prepare(sql),
        ]),
      ),
    };
    connections.set(connection, state);
  }
  return state;
}

// Signing keys and the VAPID key are read from the environment on every render.
let envGeneration = 0,
  lastSecret,
  lastVapid;
function environment() {
  const secret = process.env.SECRET_KEY_BASE,
    vapid = process.env.VAPID_PUBLIC_KEY;
  if (secret !== lastSecret || vapid !== lastVapid) {
    lastSecret = secret;
    lastVapid = vapid;
    envGeneration++;
  }
  return envGeneration;
}

// PRAGMA data_version moves on other connections' commits (other workers, the jobs process),
// writeEpoch() on this process's own; the connection id keeps a reopened database apart.
export function pageEpoch() {
  const state = connectionState(db());
  return `${state.id}:${state.dataVersion.get().data_version}:${writeEpoch()}:${environment()}`;
}

// Everything a cached page's bytes may depend on besides the database: the handler, the full
// URL (path, query and the stripped .json/.turbo_stream format), scheme and host (absolute
// URLs and permalinks), the headers handlers or render() read, the viewer and the session
// value render() prints (ReturnRoom).
export function pageKey(req, tag) {
  return JSON.stringify([
    tag,
    req.protocol,
    req.get("host") ?? "",
    req.originalUrl,
    req.format ?? "",
    req.get("turbo-frame") ?? "",
    req.get("accept") ?? "",
    req.user?.id ?? 0,
    req.authenticatedByBot ? 1 : 0,
    req.session?.last_room_id ?? "",
  ]);
}

// Marks the start of the page's database reads. Call it before the handler reads anything the
// page shows, so a commit landing in between cannot be stored under the newer epoch.
export function beginPage(req) {
  req.pageEpoch ??= pageEpoch();
}

const sameRow = (a, b) => {
  if (!a || !b) return !a && !b;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
};

// req.user and req.account were loaded by the session middleware, possibly from the query cache
// and before beginPage(); a page is stored only if they still match the database.
function middlewareRowsCurrent(req) {
  const state = connectionState(db());
  return (
    sameRow(req.user, req.user && state.user.get(req.user.id)) &&
    sameRow(req.account, state.account.get())
  );
}

// A message body is validated by its rich text updated_at (plus length and edges), which a later
// edit could repeat within the same millisecond, or always under CAMPFIRE_FROZEN_TIME. Edits take
// that timestamp inside their write transaction, so one committed after a render is newer than the
// render time minus the transaction's duration. Pages showing a body written (posted or edited)
// less than SETTLE_MS before the render (far longer than any write transaction) are cached for their epoch only.
// This assumes the system clock does not step backwards by more than that.
const SETTLE_MS = 15_000;

// Records what the page being rendered shows, for revalidating it in a later epoch:
// room: id (room row, viewer's involvement, direct members); sidebar: true (the viewer's rooms);
// search: { query, found } (searched again, plus recent searches); messages: shown or anchoring
// message ids; tail: { room, until } (see windowTail() in routes.js).
export function dependOn(req, deps) {
  if (req.pageDeps) Object.assign(req.pageDeps, deps);
}

// The viewer and account rows render() prints are part of every validator, so they must be the
// database's current rows (see middlewareRowsCurrent). While rendering, the search results the
// page has just read in this turn are reused instead of searched again.
function pageValidator(req, deps, rendering = false) {
  const state = connectionState(db());
  const parts = [
    state.id,
    environment(),
    JSON.stringify(req.user ?? null),
    JSON.stringify(req.account ?? null),
    state.logo.get(req.account?.id ?? 0).value,
  ];
  const userId = req.user?.id ?? 0;
  let newest = null;
  if (deps.room) parts.push(state.room.get(userId, deps.room)?.value);
  if (deps.sidebar) parts.push(state.sidebar.get(userId).value);
  if (deps.search)
    parts.push(
      JSON.stringify(
        rendering
          ? deps.search.found
          : searchMessageIds(userId, deps.search.query),
      ),
      state.searches.get(userId).value,
    );
  if (deps.messages?.length) {
    const row = state.messages.get(JSON.stringify(deps.messages));
    parts.push(row.value, row.boosts);
    newest = row.newest || null;
  }
  // Hashed so entries hold neither the rows (password digests included) nor their size.
  const value = createHash("sha1").update(parts.join("\n")).digest("base64");
  return { value, newest };
}

const settled = (newest) =>
  newest === null || timeOf(newest) < timeOf(now()) - SETTLE_MS;

// Messages ids are AUTOINCREMENT, so every message added after the render has an id above since.
const settleTail = ({ room, until }) => ({
  room,
  until,
  since: connectionState(db()).tail.get(room, 0, null).top ?? 0,
});

function revalidates(req, page, epoch) {
  if (!page.validator || !middlewareRowsCurrent(req)) return false;
  const { value } = pageValidator(req, page.deps);
  const { tail } = page.deps;
  const grown =
    tail && connectionState(db()).tail.get(tail.room, tail.since, tail.until);
  if (value !== page.validator || grown?.entered || pageEpoch() !== epoch)
    return false;
  if (grown?.top) tail.since = grown.top;
  return true;
}

const verifying = () => process.env.CAMPFIRE_CACHE_VERIFY === "1";

// Answers a 200 HTML GET from the response cache, or renders it with produce() and caches it.
// produce() may answer by itself (a 204 or 304) and return undefined; a returned string is the
// page. Response headers (Set-Cookie included) are not cached: the handler code up to this call
// and the session middleware's writeHead hook run on every request.
// A GET may carry a body (handlers read e.g. req.body.q as a fallback); the key has no body.
const hasBody = (req) =>
  req.files?.length > 0 ||
  (req.body != null &&
    (typeof req.body === "object" && !Buffer.isBuffer(req.body)
      ? Object.keys(req.body).length > 0
      : req.body.length > 0));

function renderPage(req, produce) {
  req.pageDeps = {};
  return renderChunks(produce);
}

export function sendCachedPage(req, res, tag, produce, cache = responseCache) {
  if (req.method !== "GET" || !cache.budget || hasBody(req)) {
    const html = produce();
    return html === undefined ? undefined : res.type("html").send(html);
  }
  const epoch = req.pageEpoch ?? pageEpoch();
  const key = pageKey(req, tag);
  const cached = cache.get(key, epoch);
  let chunks;
  if (cached?.epoch === epoch) return sendPage(req, res, cached);
  if (cached) {
    if (!revalidates(req, cached, epoch)) cache.invalidate(cached);
    else if (!verifying()) {
      cache.revalidated(cached, epoch);
      return sendPage(req, res, cached);
    } else {
      chunks = renderPage(req, produce);
      if (chunks === undefined) return;
      const fresh = Buffer.concat(chunks);
      if (pageEpoch() !== epoch || fresh.equals(cached.bytes)) {
        cache.revalidated(cached, epoch);
        return sendPage(req, res, cached);
      }
      console.error(
        `response cache: revalidated page differs from a fresh render: ${key}`,
      );
      cache.invalidate(cached, { mismatch: true });
    }
  }
  chunks ??= renderPage(req, produce);
  if (chunks === undefined) return;
  const bytes = Buffer.concat(chunks);
  const page = new Page(
    chunks,
    res.get("ETag") || (req.app.enabled("etag") ? fastEtag(bytes) : undefined),
    bytes,
  );
  if (
    res.statusCode === 200 &&
    !res.get("Set-Cookie") &&
    middlewareRowsCurrent(req)
  ) {
    const deps = req.pageDeps;
    const validator =
      Object.keys(deps).length > 0 ? pageValidator(req, deps, true) : null;
    const tail = validator && deps.tail && settleTail(deps.tail);
    if (pageEpoch() === epoch) {
      if (validator && settled(validator.newest)) {
        // search.found only spares the store-time search; entries keep the query alone.
        const { search, ...kept } = deps;
        page.validator = validator.value;
        page.deps = {
          ...kept,
          ...(tail && { tail }),
          ...(search && { search: { query: search.query } }),
        };
      }
      cache.set(key, epoch, page);
    }
  }
  return sendPage(req, res, page);
}
