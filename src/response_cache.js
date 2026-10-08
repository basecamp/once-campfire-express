import { db, writeEpoch } from "./db.js";
import { fastEtag, gzipWhole, sendPage } from "./gzip.js";

const OVERHEAD = 256;

class Page {
  gzipped = null;
  cache = null;
  cost = 0;
  constructor(bytes, etag) {
    this.bytes = bytes;
    this.etag = etag;
  }
  gzip() {
    if (!this.gzipped) {
      this.gzipped = gzipWhole(this.bytes);
      this.cache?.charge(this, this.gzipped.length);
    }
    return this.gzipped;
  }
}

// Byte-bounded LRU of completed HTML and gzip representations. Entries are valid for one database epoch only:
// the first lookup under a new epoch drops them all, since none can be served again.
export class ResponseCache {
  #entries = new Map();
  #epoch;
  #bytes = 0;
  #hits = 0;
  #misses = 0;

  constructor(budget) {
    this.budget = budget;
    this.maxEntry = Math.floor(budget / 8);
  }

  stats() {
    return {
      hits: this.#hits,
      misses: this.#misses,
      bytes: this.#bytes,
      entries: this.#entries.size,
      budget: this.budget,
    };
  }

  clear() {
    for (const page of this.#entries.values()) page.cache = null;
    this.#entries.clear();
    this.#bytes = 0;
  }

  get(key, epoch) {
    if (epoch !== this.#epoch) {
      this.clear();
      this.#epoch = epoch;
    }
    const page = this.#entries.get(key);
    if (!page) {
      this.#misses++;
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, page);
    this.#hits++;
    return page;
  }

  set(key, epoch, page) {
    if (
      epoch !== this.#epoch ||
      page.bytes.length > this.maxEntry ||
      key.length > 8192
    )
      return;
    const replaced = this.#entries.get(key);
    if (replaced) this.#drop(key, replaced);
    page.key = key;
    page.cache = this;
    page.cost =
      page.bytes.length +
      (page.gzipped?.length || 0) +
      key.length * 2 +
      OVERHEAD;
    this.#entries.set(key, page);
    this.#bytes += page.cost;
    this.#evict();
  }

  charge(page, bytes) {
    if (this.#entries.get(page.key) !== page) return;
    page.cost += bytes;
    this.#bytes += bytes;
    this.#evict();
  }

  #drop(key, page) {
    this.#entries.delete(key);
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
  const mb = value === undefined || value === "" ? 64 : Number(value);
  return Math.floor(
    (Number.isFinite(mb) && mb > 0 ? Math.min(mb, 1024) : 0) * 1024 * 1024,
  );
}

export const responseCache = new ResponseCache(
  budgetFromEnv(process.env.CAMPFIRE_RESPONSE_CACHE_MB),
);

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
    req.get("origin") ?? "",
    req.get("user-agent") ?? "",
    req.get("cookie") ?? "",
    req.currentSession?.id ?? 0,
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

export function sendCachedPage(req, res, tag, produce, cache = responseCache) {
  if (
    !["GET", "HEAD"].includes(req.method) ||
    !cache.budget ||
    hasBody(req) ||
    req.session?.flash ||
    req.authenticatedByBot
  ) {
    const html = produce();
    return html === undefined ? undefined : res.type("html").send(html);
  }
  const epoch = req.pageEpoch ?? pageEpoch();
  const key = pageKey(req, tag);
  // A commit during authentication or authorization must not promote old reads to a newer epoch.
  const unchanged = pageEpoch() === epoch;
  const hit = unchanged ? cache.get(key, epoch) : undefined;
  if (hit) return sendPage(req, res, hit);
  const html = produce();
  if (html === undefined) return;
  const bytes = Buffer.from(html, "utf8");
  const page = new Page(
    bytes,
    res.get("ETag") || (req.app.enabled("etag") ? fastEtag(bytes) : undefined),
  );
  if (
    req.method === "GET" &&
    res.statusCode === 200 &&
    !res.get("Set-Cookie") &&
    !res.get("Content-Encoding") &&
    !/\b(?:no-store|no-transform)\b/i.test(res.get("Cache-Control") || "") &&
    pageEpoch() === epoch &&
    middlewareRowsCurrent(req)
  )
    cache.set(key, epoch, page);
  return sendPage(req, res, page);
}
