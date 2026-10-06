// Thruster's response cache, as the Rust port runs it in front of the app: GET and HEAD responses
// that say `public` with a positive `s-max-age` (sic) or `max-age`, and no `no-cache` or
// `Vary: *`, are kept in memory until they expire and replayed with `X-Cache: hit`, or a 304 when
// the request already has the stored ETag. Set-Cookie is stripped from such responses, as Thruster
// does. Unlike Thruster, entries are keyed by every header the response varies on (Thruster keeps
// one variant per URL), and eviction is least recently used rather than sampled.

export const MAX_CACHEABLE_URI = 2048;
const ENTRY_OVERHEAD = 256;

export function shouldCacheRequest(req) {
  const header = (name) => req.headers[name] ?? "";
  return (
    (req.method === "GET" || req.method === "HEAD") &&
    header("connection") !== "Upgrade" &&
    header("upgrade") !== "websocket" &&
    !header("range") &&
    req.url.length <= MAX_CACHEABLE_URI
  );
}

const first = (value) =>
  Array.isArray(value) ? (value[0] ?? "") : String(value ?? "");

// Seconds the response may be cached for, or 0.
export function cacheLifetime(status, headers) {
  if (status < 200 || status > 399 || status === 304) return 0;
  if (first(headers.vary).includes("*")) return 0;
  const cacheControl = first(headers["cache-control"]);
  if (!/\bpublic\b/.test(cacheControl) || /\bno-cache\b/.test(cacheControl))
    return 0;
  const maxAge =
    /\bs-max-age=(\d+)\b/.exec(cacheControl) ||
    /\bmax-age=(\d+)\b/.exec(cacheControl);
  const seconds = maxAge ? Number(maxAge[1]) : 0;
  return seconds > 0 ? seconds : 0;
}

const varyNames = (headers) => {
  const vary = first(headers.vary);
  return vary
    ? vary
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .sort()
    : [];
};

export class FrontCache {
  #entries = new Map();
  // Per URL: the Vary names last stored, so a lookup can build the full key up front, and how
  // many entries still hold that URL.
  #varies = new Map();
  size = 0;
  constructor(capacity, maxItemSize) {
    this.capacity = capacity;
    this.maxItemSize = maxItemSize;
  }
  baseKey(req) {
    return `${req.method}\n${req.url}\n${req.headers.host ?? ""}`;
  }
  key(base, names, req) {
    let key = base;
    for (const name of names) key += `\n${name}=${req.headers[name] ?? ""}`;
    return key;
  }
  lookup(req, now = Date.now()) {
    const base = this.baseKey(req);
    const key = this.key(base, this.#varies.get(base)?.names ?? [], req);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < now) {
      this.#drop(key, entry);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }
  // `base` is baseKey(req) taken before routing, which rewrites req.url.
  store(
    req,
    status,
    headers,
    body,
    lifetime,
    now = Date.now(),
    base = this.baseKey(req),
  ) {
    const names = varyNames(headers);
    const key = this.key(base, names, req);
    let headerBytes = 0;
    for (const [name, value] of Object.entries(headers))
      headerBytes += name.length + String(value).length;
    const cost = body.length + headerBytes + key.length + ENTRY_OVERHEAD;
    if (cost > this.maxItemSize || cost > this.capacity) return;
    const replaced = this.#entries.get(key);
    if (replaced) this.#drop(key, replaced);
    const vary = this.#varies.get(base);
    if (vary) {
      vary.names = names;
      vary.count++;
    } else this.#varies.set(base, { names, count: 1 });
    this.#entries.set(key, {
      status,
      headers,
      body,
      expiresAt: now + lifetime * 1000,
      cost,
      base,
    });
    this.size += cost;
    for (const [oldKey, entry] of this.#entries) {
      if (this.size <= this.capacity) break;
      this.#drop(oldKey, entry);
    }
  }
  #drop(key, entry) {
    this.#entries.delete(key);
    this.size -= entry.cost;
    const vary = this.#varies.get(entry.base);
    if (vary && --vary.count === 0) this.#varies.delete(entry.base);
  }
  clear() {
    this.#entries.clear();
    this.#varies.clear();
    this.size = 0;
  }
}

function wasNotModified(entry, req) {
  const etag = first(entry.headers.etag);
  if (!etag) return false;
  return String(req.headers["if-none-match"] ?? "")
    .split(",")
    .some((candidate) => candidate.trim() === etag);
}

function replay(entry, req, res) {
  const notModified = wasNotModified(entry, req);
  for (const [name, value] of Object.entries(entry.headers))
    res.setHeader(name, value);
  res.setHeader("X-Cache", "hit");
  if (notModified) {
    for (const name of ["content-type", "content-length", "transfer-encoding"])
      res.removeHeader(name);
    res.statusCode = 304;
    return res.end();
  }
  res.statusCode = entry.status;
  res.end(entry.body);
}

const megabytes = (value, fallback) => {
  const mb = value === undefined || value === "" ? NaN : Number(value);
  return Math.floor((Number.isFinite(mb) && mb >= 0 ? mb : fallback) * 1048576);
};

export const frontCache = new FrontCache(
  megabytes(process.env.CAMPFIRE_FRONT_CACHE_MB, 64),
  1048576,
);

export function frontCacheMiddleware(cache = frontCache) {
  return (req, res, next) => {
    if (!cache.capacity) return next();
    if (!shouldCacheRequest(req)) {
      res.setHeader("X-Cache", "bypass");
      return next();
    }
    const now = Date.now();
    const base = cache.baseKey(req);
    const hit = cache.lookup(req, now);
    if (hit) return replay(hit, req, res);
    res.setHeader("X-Cache", "miss");

    let lifetime = 0,
      stored,
      chunks = [],
      recorded = 0;
    const head = req.method === "HEAD";
    const writeHead = res.writeHead;
    res.writeHead = function (status, ...rest) {
      const headers = rest.find((arg) => arg && typeof arg === "object");
      if (headers && !Array.isArray(headers)) {
        for (const [name, value] of Object.entries(headers))
          this.setHeader(name, value);
        rest = rest.filter((arg) => arg !== headers);
      }
      this.statusCode = status;
      lifetime = cacheLifetime(status, this.getHeaders());
      if (lifetime) {
        this.removeHeader("set-cookie");
        stored = { ...this.getHeaders() };
        delete stored["x-cache"];
      }
      return writeHead.call(this, status, ...rest);
    };
    const record = (chunk, encoding) => {
      if (!lifetime || head || chunks === null || chunk == null) return;
      if (typeof chunk === "function") return;
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      recorded += buffer.length;
      if (recorded > cache.maxItemSize) chunks = null;
      else chunks.push(Buffer.from(buffer));
    };
    const write = res.write;
    res.write = function (chunk, encoding, ...rest) {
      const result = write.call(this, chunk, encoding, ...rest);
      record(chunk, encoding);
      return result;
    };
    const end = res.end;
    res.end = function (chunk, encoding, ...rest) {
      const result = end.call(this, chunk, encoding, ...rest);
      record(chunk, encoding);
      if (lifetime && chunks !== null)
        cache.store(
          req,
          res.statusCode,
          stored,
          head ? Buffer.alloc(0) : Buffer.concat(chunks),
          lifetime,
          now,
          base,
        );
      lifetime = 0;
      return result;
    };
    next();
  };
}
