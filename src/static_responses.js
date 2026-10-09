import fs from "node:fs";
import path from "node:path";
import compressible from "compressible";
import fresh from "fresh";
import mime from "mime-types";
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
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
const SUFFIXES = { br: ".br", gzip: ".gz" };
const ENCODINGS = ["br", "gzip"];
const NEGOTIATED_LIMIT = 256;

const typeOf = (name) =>
  mime.contentType(path.extname(name)) || "application/octet-stream";

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
      // compression() encodes these itself for any request with Accept-Encoding.
      compressedOnTheFly: compressible(typeOf(name)) && size >= 1024,
    });
  return files;
}

// Rebuilds the exact headers of the precompressedAssets + express.static + compression chain in
// app.js: send's validators come from the served file's stat, compression adds Vary only while
// a compressible Content-Type is present, and send's 304 drops every Content-* header.
function buildEntry(name, encoding, stat, body) {
  const type = typeOf(name);
  const validators = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Last-Modified": stat.mtime.toUTCString(),
    ETag: `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`,
  };
  const vary = { Vary: "Accept-Encoding" };
  const length = { "Content-Length": String(body.length) };
  if (encoding === "identity")
    return {
      body,
      validators,
      ok: {
        ...SECURITY_HEADERS,
        ...validators,
        "Content-Type": type,
        ...length,
        ...(compressible(type) ? vary : {}),
      },
      notModified: { ...SECURITY_HEADERS, ...validators },
    };
  return {
    body,
    validators,
    ok: {
      ...SECURITY_HEADERS,
      "Content-Type": type,
      "Content-Encoding": encoding,
      ...vary,
      ...validators,
      ...length,
    },
    notModified: { ...SECURITY_HEADERS, ...vary, ...validators },
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
  // Returns whether it answered. Without Express (negotiate null) only Accept-Encoding values
  // already negotiated are answered; the Express pass negotiates and remembers the rest.
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
        etag: entry.validators.ETag,
        "last-modified": entry.validators["Last-Modified"],
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
  const middleware = (req, res, next) =>
    respond(req, res, req.path, () => req.acceptsEncodings(ENCODINGS)) ||
    next();
  // For use before Express wraps req/res: names are exact file paths, so a raw pathname that
  // differs from Express's parse (absolute-form, encoded) simply misses and goes the long way.
  middleware.direct = (req, res) => {
    const query = req.url.indexOf("?");
    return respond(
      req,
      res,
      query < 0 ? req.url : req.url.slice(0, query),
      null,
    );
  };
  return middleware;
}
