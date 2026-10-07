import fs from "node:fs";
import path from "node:path";
import compressible from "compressible";
import fresh from "fresh";
import send from "@fastify/send";
import { FragmentCache } from "./fragment_cache.js";

const OVERHEAD = 512;
export const responseCache = (budget) =>
  new FragmentCache(budget, (entry) => entry.body.length + OVERHEAD);
const mb = Number(process.env.CAMPFIRE_PUBLIC_CACHE_MB);
// Fully formed public responses (digested assets, avatars) shared by every route in this worker.
export const publicResponses = responseCache(
  Math.floor((Number.isFinite(mb) && mb >= 0 ? mb : 32) * 1024 * 1024),
);

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};
// @fastify/compress's default compressibleTypes, then mime-db's compressible flag.
const PLUGIN_COMPRESSIBLE =
  /^text\/(?!event-stream)|(?:\+|\/)json(?:;|$)|(?:\+|\/)text(?:;|$)|(?:\+|\/)xml(?:;|$)|octet-stream(?:;|$)/u;
const compressedByPlugin = (type) =>
  PLUGIN_COMPRESSIBLE.test(type) || compressible(type) === true;
const SUFFIXES = { br: ".br", gzip: ".gz" };
const ENCODINGS = ["br", "gzip"];
const NEGOTIATED_LIMIT = 256;

// The Content-Type @fastify/send gives the file (its mime table and utf-8 rule).
function typeOf(name) {
  const type = send.mime.getType(name) || "application/octet-stream";
  return /^(?:text\/|application\/(?:javascript|json))/.test(type)
    ? type + "; charset=utf-8"
    : type;
}

function listFiles(root) {
  if (!fs.existsSync(root)) return new Map();
  const sizes = new Map();
  for (const relative of fs.readdirSync(root, { recursive: true })) {
    const name = relative.split(path.sep).join("/");
    if (name.split("/").some((part) => part.startsWith("."))) continue;
    const stat = fs.statSync(path.join(root, relative));
    if (stat.isFile()) sizes.set(name, stat.size);
  }
  const files = new Map();
  for (const [name, size] of sizes)
    files.set(name, {
      encodings: ENCODINGS.filter((encoding) =>
        sizes.has(name + SUFFIXES[encoding]),
      ),
      sizes: {
        identity: size,
        br: sizes.get(name + ".br"),
        gzip: sizes.get(name + ".gz"),
      },
      // @fastify/compress encodes these itself, whatever their size (its threshold applies only
      // to in-memory bodies), for any request with Accept-Encoding.
      compressedOnTheFly: compressedByPlugin(typeOf(name)),
    });
  return files;
}

// Rebuilds the headers of the @fastify/static (preCompressed) + @fastify/compress chain in
// app.js: send's validators come from the served file's stat, and a 304 drops every Content-* header.
function buildEntry(name, encoding, stat, body) {
  const validators = {
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
    "last-modified": stat.mtime.toUTCString(),
    etag: `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`,
  };
  // preCompressed static serving varies every asset on Accept-Encoding.
  const vary = { vary: "accept-encoding" };
  return {
    body,
    validators,
    ok: {
      ...SECURITY_HEADERS,
      ...validators,
      "content-type": typeOf(name),
      "content-length": String(body.length),
      ...vary,
      ...(encoding === "identity" ? {} : { "content-encoding": encoding }),
    },
    notModified: { ...SECURITY_HEADERS, ...validators, ...vary },
  };
}

// Serves digested assets from memory with the same status, headers and bytes as the stream-based
// chain behind it. A first request for a file falls through while the file loads in the
// background; Range and If-Match/If-Unmodified-Since requests always fall through.
export function cachedAssets(root, cache = publicResponses) {
  const files = listFiles(root);
  const negotiated = new Map();
  const loading = new Set();
  const load = (key, name, encoding, size) => {
    if (loading.has(key) || !cache.admits(key, size + OVERHEAD)) return;
    loading.add(key);
    const file = path.join(
      root,
      name + (encoding === "identity" ? "" : SUFFIXES[encoding]),
    );
    Promise.all([fs.promises.stat(file), fs.promises.readFile(file)])
      .then(([stat, body]) => {
        // A file changed since startup could flip compressedOnTheFly; leave it to the chain.
        if (stat.size === body.length && body.length === size)
          cache.fetch(key, () => buildEntry(name, encoding, stat, body));
      })
      .catch(() => {})
      .finally(() => loading.delete(key));
  };
  // Returns whether it answered. Without Fastify (negotiate null) only Accept-Encoding values
  // already negotiated are answered; the Fastify pass negotiates and remembers the rest.
  const respond = (req, res, pathname, negotiate) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const headers = req.headers;
    if (headers.range || headers["if-match"] || headers["if-unmodified-since"])
      return false;
    if (!pathname.startsWith("/assets/")) return false;
    const name = pathname.slice(8);
    const file = files.get(name);
    if (!file) return false;
    const accept = headers["accept-encoding"];
    let preferred = negotiated.get(accept);
    if (preferred === undefined) {
      if (!negotiate) return false;
      if (negotiated.size >= NEGOTIATED_LIMIT) negotiated.clear();
      preferred = negotiate();
      negotiated.set(accept, preferred);
    }
    const encoding =
      preferred && file.encodings.includes(preferred) ? preferred : "identity";
    if (encoding === "identity" && accept && file.compressedOnTheFly)
      return false;
    const key = `asset:${encoding}:${name}`;
    const entry = cache.get(key);
    if (!entry) {
      load(key, name, encoding, file.sizes[encoding]);
      return false;
    }
    if (
      fresh(headers, {
        etag: entry.validators.etag,
        "last-modified": entry.validators["last-modified"],
      })
    ) {
      res.writeHead(304, entry.notModified);
      res.end();
    } else {
      res.writeHead(200, entry.ok);
      res.end(req.method === "HEAD" ? undefined : entry.body);
    }
    return true;
  };
  return {
    // Inside Fastify (an onRequest hook): negotiates and remembers new Accept-Encoding values.
    hook: (req, reply) => {
      const query = req.url.indexOf("?");
      return respond(
        req.raw,
        reply.raw,
        query < 0 ? req.url : req.url.slice(0, query),
        () => req.encodings(ENCODINGS),
      );
    },
    // Before Fastify wraps req/res: names are exact file paths, so a raw pathname that differs
    // from Fastify's parse (absolute-form, encoded) simply misses and goes the long way.
    direct: (req, res) => {
      const query = req.url.indexOf("?");
      return respond(
        req,
        res,
        query < 0 ? req.url : req.url.slice(0, query),
        null,
      );
    },
  };
}
