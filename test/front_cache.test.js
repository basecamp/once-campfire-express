import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, existsSync } from "node:fs";
process.env.DATABASE_PATH = ":memory:";
process.env.SECRET_KEY_BASE = "front-cache-tests-".repeat(8);
const { run, now, initialize } = await import("../src/db.js");
const domain = await import("../src/domain.js");
const rails = await import("../src/rails.js");
const { avatar } = await import("../src/rendering.js");
const { createApp } = await import("../src/app.js");
const { FrontCache, frontCache, cacheLifetime, shouldCacheRequest } =
  await import("../src/front_cache.js");

let server, base, user;
before(async () => {
  initialize();
  const t = now();
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
    "Testing",
    "join-me",
    t,
    t,
  );
  user = domain.createUser({
    name: "Avatar Person",
    email_address: "avatar@example.test",
    password: "password",
  });
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test("only public responses with a positive max-age are cacheable", () => {
  const life = (cacheControl, extra = {}, status = 200) =>
    cacheLifetime(status, { "cache-control": cacheControl, ...extra });
  assert.equal(life("public, max-age=2592000"), 2592000);
  assert.equal(life("max-age=300, public, stale-while-revalidate=604800"), 300);
  assert.equal(life("public, s-max-age=10, max-age=99"), 10);
  assert.equal(life("max-age=0, private, must-revalidate"), 0);
  assert.equal(life("public"), 0);
  assert.equal(life("public, max-age=0"), 0);
  assert.equal(life("public, no-cache, max-age=60"), 0);
  assert.equal(life("public, max-age=60", { vary: "*" }), 0);
  assert.equal(life("public, max-age=60", {}, 304), 0);
  assert.equal(life("public, max-age=60", {}, 404), 0);
  assert.equal(life("public, max-age=60", {}, 301), 60);
});

test("upgrades, ranges, writes and long URIs bypass the cache", () => {
  const req = (method, headers = {}, url = "/x") => ({ method, headers, url });
  assert.ok(shouldCacheRequest(req("GET")));
  assert.ok(shouldCacheRequest(req("HEAD")));
  assert.ok(!shouldCacheRequest(req("POST")));
  assert.ok(!shouldCacheRequest(req("GET", { upgrade: "websocket" })));
  assert.ok(!shouldCacheRequest(req("GET", { connection: "Upgrade" })));
  assert.ok(!shouldCacheRequest(req("GET", { range: "bytes=0-1" })));
  assert.ok(!shouldCacheRequest(req("GET", {}, "/" + "x".repeat(2048))));
});

test("the store is bounded by bytes, keys on Vary headers and expires entries", () => {
  const cache = new FrontCache(2000, 1000);
  const req = (url, encoding = "gzip") => ({
    method: "GET",
    url,
    headers: { host: "chat.test", "accept-encoding": encoding },
  });
  const body = Buffer.alloc(400);
  cache.store(req("/a"), 200, { vary: "Accept-Encoding" }, body, 60, 0);
  assert.ok(cache.lookup(req("/a"), 0));
  assert.equal(cache.lookup(req("/a", "br"), 0), undefined);
  assert.equal(cache.lookup(req("/a"), 61_000), undefined, "expired");
  cache.store(req("/big"), 200, {}, Buffer.alloc(1000), 60, 0);
  assert.equal(cache.lookup(req("/big"), 0), undefined, "over the item limit");
  for (const path of ["/1", "/2", "/3", "/4", "/5"])
    cache.store(req(path), 200, {}, body, 60, 0);
  assert.ok(cache.size <= 2000);
  assert.equal(cache.lookup(req("/1"), 0), undefined, "oldest evicted");
  assert.ok(cache.lookup(req("/5"), 0));
});

test("avatars are replayed from memory without cookies and answer 304 from the stored ETag", async () => {
  frontCache.clear();
  const url = base + avatar(user.id, user.updated_at);
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-cache"), "miss");
  assert.deepEqual(first.headers.getSetCookie(), [], "Set-Cookie stripped");
  const body = await first.text();
  const second = await fetch(url);
  assert.equal(second.headers.get("x-cache"), "hit");
  assert.equal(await second.text(), body);
  assert.equal(second.headers.get("etag"), first.headers.get("etag"));
  assert.equal(
    second.headers.get("cache-control"),
    first.headers.get("cache-control"),
  );
  const conditional = await fetch(url, {
    headers: { "if-none-match": first.headers.get("etag") },
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get("x-cache"), "hit");

  const page = await fetch(base + "/session/new");
  assert.equal(page.headers.get("x-cache"), "miss");
  await page.text();
  assert.equal(
    (await fetch(base + "/session/new")).headers.get("x-cache"),
    "miss",
    "pages are never public",
  );
  const post = await fetch(base + "/session", { method: "POST" });
  assert.equal(post.headers.get("x-cache"), "bypass");
});

test("precompressed assets are cached per Accept-Encoding", async (t) => {
  const root = "assets/generated/public/assets";
  const name =
    existsSync(root) &&
    readdirSync(root).find(
      (file) =>
        file.endsWith(".css") && readdirSync(root).includes(file + ".gz"),
    );
  if (!name) return t.skip("no precompressed assets built");
  frontCache.clear();
  const get = (encoding) =>
    new Promise((resolve, reject) =>
      http
        .get(
          `${base}/assets/${name}`,
          { headers: { "accept-encoding": encoding } },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({ res, body: Buffer.concat(chunks).toString("latin1") }),
            );
          },
        )
        .on("error", reject),
    );
  const gzip = await get("gzip");
  assert.equal(gzip.res.headers["content-encoding"], "gzip");
  assert.equal(gzip.res.headers["x-cache"], "miss");
  const plain = await get("identity");
  assert.equal(plain.res.headers["content-encoding"], undefined);
  assert.equal(plain.res.headers["x-cache"], "miss");
  const gzipAgain = await get("gzip");
  assert.equal(gzipAgain.res.headers["x-cache"], "hit");
  assert.equal(gzipAgain.res.headers["content-encoding"], "gzip");
  assert.equal(gzipAgain.body, gzip.body);
  const plainAgain = await get("identity");
  assert.equal(plainAgain.res.headers["x-cache"], "hit");
  assert.equal(plainAgain.body, plain.body);
});

test("a signed avatar URL for a missing user is not cached", async () => {
  const url = `${base}/users/${rails.signedId("User", 999999, "avatar")}/avatar`;
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(url)).headers.get("x-cache"), "miss");
});
