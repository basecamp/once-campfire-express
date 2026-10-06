import zlib from "node:zlib";
import { randomBytes } from "node:crypto";

// Spliced gzip (port of the Rust kit's deflater/splice.rs). A page is split at the
// per-request values its caller names; every stable segment between them is deflated once
// and cached, and each response is a gzip header, those pieces, small hand-encoded pieces
// for the volatile values and a trailer with the body's CRC. Pages carry no per-request
// values since CSRF tokens gave way to Sec-Fetch-Site, so the middleware names none.

const WINDOW = 32 * 1024;
const HEADER = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
const FINAL_BLOCK = Buffer.from([0x03, 0x00]);
const OVERHEAD = 128;

// A sync flush ends each piece on a byte boundary without a final block, so pieces can be
// concatenated into one deflate stream.
const deflate = (bytes, dictionary) =>
  zlib.deflateRawSync(bytes, {
    level: 6,
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
    ...(dictionary.length ? { dictionary } : {}),
  });

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];
const lastAtMost = (table, value) => {
  let i = table.length - 1;
  while (table[i] > value) i--;
  return i;
};

// A fixed-Huffman block (RFC 1951 3.2.6) ending in a sync flush, built by hand so the
// per-request pieces cost no zlib stream. A value that occurred within the window is a
// back-reference to that occurrence (as whole-page deflate would encode it), else literals.
function fixedBlock(bytes, distance) {
  const out = [];
  let bits = 0;
  let count = 0;
  const put = (value, n) => {
    bits |= value << count;
    count += n;
    while (count >= 8) {
      out.push(bits & 255);
      bits >>>= 8;
      count -= 8;
    }
  };
  const code = (value, n) => {
    let reversed = 0;
    for (let i = 0; i < n; i++) reversed |= ((value >> i) & 1) << (n - 1 - i);
    put(reversed, n);
  };
  const symbol = (s) => {
    if (s < 144) code(0x30 + s, 8);
    else if (s < 256) code(0x190 + s - 144, 9);
    else if (s < 280) code(s - 256, 7);
    else code(0xc0 + s - 280, 8);
  };
  put(0, 1);
  put(1, 2);
  if (distance) {
    const d = lastAtMost(DISTANCE_BASE, distance);
    for (let left = bytes.length; left > 0;) {
      const length = left <= 258 ? left : left - 258 < 3 ? left - 3 : 258;
      const l = lastAtMost(LENGTH_BASE, length);
      symbol(257 + l);
      put(length - LENGTH_BASE[l], LENGTH_EXTRA[l]);
      code(d, 5);
      put(distance - DISTANCE_BASE[d], DISTANCE_EXTRA[d]);
      left -= length;
    }
  } else for (const byte of bytes) symbol(byte);
  symbol(256);
  put(0, 3);
  if (count) put(0, 8 - count);
  out.push(0, 0, 0xff, 0xff);
  return Buffer.from(out);
}

function split(bytes, needles) {
  const segments = [];
  const volatiles = [];
  let pos = 0;
  for (;;) {
    let at = -1;
    let which = -1;
    needles.forEach((needle, i) => {
      const found = bytes.indexOf(needle, pos);
      if (
        found >= 0 &&
        (at < 0 ||
          found < at ||
          (found === at && needle.length > needles[which].length))
      ) {
        at = found;
        which = i;
      }
    });
    const end = at < 0 ? bytes.length : at;
    if (end > pos) segments.push({ start: pos, end, after: volatiles.length });
    if (at < 0) return { segments, volatiles };
    volatiles.push({ at, which, length: needles[which].length });
    pos = at + needles[which].length;
  }
}

export class SplicedGzip {
  #entries = new Map();
  #texts = new Map();
  #nextId = 0;
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #seed = randomBytes(8).readBigUInt64LE();

  constructor(budget) {
    this.budget = budget;
    this.maxEntry = Math.floor(budget / 8);
  }

  hash(bytes) {
    return Bun.hash(bytes, this.#seed);
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

  gzip(body, volatile = []) {
    const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const needles = [...new Set(volatile.filter((v) => v && v.length))].map(
      (v) => Buffer.from(v, "utf8"),
    );
    const { segments, volatiles } = split(bytes, needles);
    for (const segment of segments) {
      segment.bytes = bytes.subarray(segment.start, segment.end);
      segment.hash = `${this.hash(segment.bytes)}:${segment.bytes.length}`;
      segment.text = this.#find(segment);
    }
    const out = [HEADER];
    const lastAt = needles.map(() => -1);
    let v = 0;
    let first = 0;
    const emitVolatiles = (until) => {
      for (; v < until; v++) {
        const { at, which, length } = volatiles[v];
        const distance = at - lastAt[which];
        out.push(
          fixedBlock(
            needles[which],
            lastAt[which] >= 0 && distance <= WINDOW && length >= 3
              ? distance
              : 0,
          ),
        );
        lastAt[which] = at;
      }
    };
    segments.forEach((segment, i) => {
      emitVolatiles(segment.after);
      while (segments[first].end <= segment.start - WINDOW) first++;
      out.push(this.#piece(bytes, segments, first, i));
    });
    emitVolatiles(volatiles.length);
    const trailer = Buffer.alloc(8);
    trailer.writeUInt32LE(zlib.crc32(bytes) >>> 0, 0);
    trailer.writeUInt32LE(bytes.length >>> 0, 4);
    out.push(FINAL_BLOCK, trailer);
    return Buffer.concat(out);
  }

  // A piece may refer back to anything in the 32 KiB before it, so it is cached under the
  // identity of its text and of every stable segment (with its offset) in that window. The
  // volatile values in the window differ per request, so the piece is compressed with NUL
  // bytes standing in for them: HTML has no NULs, so deflate never matches into a stand-in
  // and the piece decodes the same whatever the values are. Text that does contain NUL is
  // compressed against the real bytes before it and not cached.
  #piece(bytes, segments, first, i) {
    const segment = segments[i];
    const dictionaryStart = Math.max(0, segment.start - WINDOW);
    const window = segments.slice(first, i);
    const covered = window.reduce(
      (sum, s) => sum + s.end - Math.max(s.start, dictionaryStart),
      0,
    );
    const masked = covered < segment.start - dictionaryStart;
    if (masked && segment.bytes.includes(0)) {
      this.#misses++;
      return deflate(
        segment.bytes,
        bytes.subarray(dictionaryStart, segment.start),
      );
    }
    const keyOf = () =>
      segment.text &&
      window.every((s) => s.text) &&
      [segment.text.id, segment.start - dictionaryStart]
        .concat(window.map((s) => `${s.text.id}@${segment.start - s.start}`))
        .join(",");
    const key = keyOf();
    const entry = key && this.#entries.get(key);
    if (entry) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      this.#hits++;
      return entry.deflated;
    }
    this.#misses++;
    let dictionary = bytes.subarray(dictionaryStart, segment.start);
    if (masked) {
      dictionary = Buffer.alloc(dictionary.length);
      for (const s of window) {
        const from = Math.max(s.start, dictionaryStart);
        bytes.copy(dictionary, from - dictionaryStart, from, s.end);
      }
    }
    const deflated = deflate(segment.bytes, dictionary);
    // A rough admission check on the piece and its own text only; the window's texts and
    // the key are charged to #bytes below, and eviction is what keeps the total in budget.
    if (deflated.length + segment.bytes.length > this.maxEntry) return deflated;
    const texts = [segment, ...window].map((s) => (s.text = this.#intern(s)));
    for (const text of texts) text.refs++;
    const stored = { deflated, texts };
    const storedKey = keyOf();
    // The lookup may have used an id evicted earlier in this request; the live ids can
    // name an entry that already exists.
    const replaced = this.#entries.get(storedKey);
    if (replaced) this.#evict(storedKey, replaced);
    stored.cost = deflated.length + storedKey.length * 2 + OVERHEAD;
    this.#entries.set(storedKey, stored);
    this.#bytes += stored.cost;
    for (const [oldKey, old] of this.#entries) {
      if (this.#bytes <= this.budget) break;
      this.#evict(oldKey, old);
    }
    return deflated;
  }

  #find({ hash, bytes }) {
    return this.#texts.get(hash)?.find((text) => text.bytes.equals(bytes));
  }

  #intern(segment) {
    const known = this.#find(segment);
    if (known) return known;
    const text = {
      id: this.#nextId++,
      hash: segment.hash,
      bytes: Buffer.from(segment.bytes),
      refs: 0,
    };
    const list = this.#texts.get(text.hash);
    if (list) list.push(text);
    else this.#texts.set(text.hash, [text]);
    this.#bytes += text.bytes.length + OVERHEAD;
    return text;
  }

  #evict(key, entry) {
    this.#entries.delete(key);
    this.#bytes -= entry.cost;
    for (const text of entry.texts) {
      if (--text.refs > 0) continue;
      const list = this.#texts.get(text.hash);
      list.splice(list.indexOf(text), 1);
      if (!list.length) this.#texts.delete(text.hash);
      this.#bytes -= text.bytes.length + OVERHEAD;
    }
  }
}

const cacheMb = Number(process.env.CAMPFIRE_GZIP_CACHE_MB);
export const splicedGzipCache = new SplicedGzip(
  Math.floor(
    (Number.isFinite(cacheMb) && cacheMb >= 0 ? cacheMb : 32) * 1024 * 1024,
  ),
);

export const gzipSpliced = (body, volatile) =>
  splicedGzipCache.gzip(body, volatile);

// What res.send does to a string body's Content-Type (Express's setCharset via
// content-type: lowercased type and parameter names, parameters sorted), without importing
// Express internals.
function withUtf8Charset(type) {
  const [media, ...rest] = type.split(";");
  const parameters = rest
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf("=");
      return [
        part.slice(0, at).trim().toLowerCase(),
        part.slice(at + 1).trim(),
      ];
    })
    .filter(([name]) => name !== "charset")
    .concat([["charset", "utf-8"]])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    media.trim().toLowerCase(),
    ...parameters.map((p) => p.join("=")),
  ].join("; ");
}

const noTransform = /(?:^|,)\s*?no-transform\s*?(?:,|$)/i;

// The bytes SplicedGzip produces for a page with no volatile values (one piece, no window),
// without keeping that piece in its cache: the response cache keeps the whole result instead.
export function gzipWhole(bytes) {
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(zlib.crc32(bytes) >>> 0, 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([
    HEADER,
    deflate(bytes, Buffer.alloc(0)),
    FINAL_BLOCK,
    trailer,
  ]);
}

export const htmlType = withUtf8Charset("text/html; charset=utf-8");

// Sends an already rendered 200 HTML page ({ bytes, etag, gzip() }) with the headers, ETag,
// freshness and encoding res.type("html").send(string) produces through splicedGzip(), but
// without re-encoding, re-hashing or re-compressing the body.
export function sendPage(req, res, page) {
  res.set("Content-Type", htmlType);
  if (page.etag && !res.get("ETag")) res.set("ETag", page.etag);
  if (
    req.method !== "GET" ||
    page.bytes.length < 1024 ||
    req.fresh ||
    res.statusCode !== 200 ||
    res.get("Content-Encoding") ||
    noTransform.test(res.get("Cache-Control") || "") ||
    !req.acceptsEncodings("gzip")
  )
    return res.send(page.bytes);
  res.vary("Accept-Encoding");
  res.set("Content-Encoding", "gzip");
  return res.send(page.gzip());
}

// Installed before compression(): it answers large 200 text/html string bodies itself and
// sets Content-Encoding, which makes compression() pass them through untouched. ETag and
// freshness follow res.send exactly, over the uncompressed body. HEAD is left to Express.
export function splicedGzip(cache = splicedGzipCache) {
  return (req, res, next) => {
    if (req.method !== "GET") return next();
    const send = res.send;
    res.send = function (body) {
      if (
        typeof body !== "string" ||
        this.statusCode !== 200 ||
        this.get("Content-Encoding") ||
        noTransform.test(this.get("Cache-Control") || "") ||
        !req.acceptsEncodings("gzip")
      )
        return send.call(this, body);
      if (!this.get("Content-Type")) this.type("html");
      const type = this.get("Content-Type");
      if (typeof type !== "string" || !/^text\/html\b/i.test(type))
        return send.call(this, body);
      const bytes = Buffer.from(body, "utf8");
      if (bytes.length < 1024) return send.call(this, body);
      this.set("Content-Type", withUtf8Charset(type));
      const etagFn = req.app.get("etag fn");
      if (!this.get("ETag") && typeof etagFn === "function") {
        const etag = etagFn(bytes);
        if (etag) this.set("ETag", etag);
      }
      if (req.fresh) return send.call(this, bytes);
      this.vary("Accept-Encoding");
      this.set("Content-Encoding", "gzip");
      return send.call(this, cache.gzip(bytes));
    };
    next();
  };
}
