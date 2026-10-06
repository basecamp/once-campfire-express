import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SECRET_KEY_BASE = "response-cache-tests-".repeat(8);
const temp = mkdtempSync(join(tmpdir(), "campfire-response-cache-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { run, get, now, initialize, databaseFile } =
  await import("../src/db.js");
const { openDatabase } = await import("../src/sqlite.js");
const domain = await import("../src/domain.js");
const rails = await import("../src/rails.js");
const { createApp } = await import("../src/app.js");
const { messageCacheKeys } = await import("../src/rendering.js");
const { ResponseCache, responseCache, sendCachedPage, budgetFromEnv } =
  await import("../src/response_cache.js");

let admin, member, open, server, port, adminCookie, memberCookie;
const sessionCookie = (token) =>
  "session_token=" +
  encodeURIComponent(rails.signCookie("session_token", token));

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
  admin = domain.createUser({
    name: "Admin",
    email_address: "admin@example.test",
    password: "password",
    role: 1,
  });
  member = domain.createUser({
    name: "Member",
    email_address: "member@example.test",
    password: "password",
  });
  const r = run(
    "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
    "Open",
    "Rooms::Open",
    admin.id,
    t,
    t,
  );
  open = get("SELECT * FROM rooms WHERE id=?", Number(r.lastInsertRowid));
  domain.grantMemberships(open, [admin.id, member.id]);
  for (let i = 0; i < 30; i++)
    domain.createMessage(
      open.id,
      admin.id,
      `<p>cached message ${i} żółć 🔥</p>`,
    );
  for (const [user, token] of [
    [admin, "admin-session"],
    [member, "member-session"],
  ])
    run(
      "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
      user.id,
      token,
      t,
      t,
      t,
    );
  adminCookie = sessionCookie("admin-session");
  memberCookie = sessionCookie("member-session");
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
});

function raw(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (response) => {
        const chunks = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () =>
          resolve({ response, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

const page = (path, headers = {}) =>
  raw(path, { headers: { cookie: adminCookie, ...headers } });

async function counted(fn) {
  const before = responseCache.stats();
  const result = await fn();
  const after = responseCache.stats();
  return {
    result,
    hits: after.hits - before.hits,
    misses: after.misses - before.misses,
  };
}

async function uncached(fn) {
  const budget = responseCache.budget;
  responseCache.budget = 0;
  try {
    return await fn();
  } finally {
    responseCache.budget = budget;
  }
}

test("a repeated room GET is a byte-identical hit in identity and gzip, equal to an uncached render", async () => {
  const path = `/rooms/${open.id}`;
  const first = await counted(() => page(path));
  assert.equal(first.result.response.statusCode, 200);
  assert.equal(first.misses, 1);
  const second = await counted(() => page(path));
  assert.equal(second.hits, 1);
  assert.equal(second.misses, 0);
  assert.ok(second.result.body.equals(first.result.body));
  assert.equal(
    second.result.response.headers.etag,
    first.result.response.headers.etag,
  );
  assert.equal(
    second.result.response.headers["content-type"],
    "text/html; charset=utf-8",
  );
  assert.equal(
    second.result.response.headers.etag,
    createApp().get("etag fn")(first.result.body),
  );

  const zipped = await counted(() => page(path, { "accept-encoding": "gzip" }));
  assert.equal(zipped.hits, 1);
  assert.equal(zipped.result.response.headers["content-encoding"], "gzip");
  assert.match(zipped.result.response.headers.vary, /Accept-Encoding/);
  assert.ok(zlib.gunzipSync(zipped.result.body).equals(first.result.body));
  const zippedAgain = await page(path, { "accept-encoding": "gzip" });
  assert.ok(zippedAgain.body.equals(zipped.result.body));

  const plain = await uncached(() => page(path));
  const plainZipped = await uncached(() =>
    page(path, { "accept-encoding": "gzip" }),
  );
  assert.ok(plain.body.equals(first.result.body));
  assert.equal(plain.response.headers.etag, first.result.response.headers.etag);
  assert.ok(
    plainZipped.body.equals(zipped.result.body),
    "cached gzip is the spliced gzip of the same page, byte for byte",
  );
  for (const name of ["content-type", "vary", "content-length"])
    assert.equal(
      zipped.result.response.headers[name],
      plainZipped.response.headers[name],
      name,
    );
});

test("hits still emit the cookies the handler sets", async () => {
  const path = `/rooms/${open.id}`;
  await page(path);
  const hit = await counted(() => page(path));
  assert.equal(hit.hits, 1);
  const cookies = hit.result.response.headers["set-cookie"] || [];
  assert.ok(cookies.some((c) => c.startsWith(`last_room=${open.id};`)));
  assert.ok(cookies.some((c) => c.startsWith("_campfire_session=")));
});

test("304 is answered from a hit", async () => {
  const path = `/rooms/${open.id}`;
  const { response } = await page(path);
  const fresh = await counted(() =>
    page(path, {
      "if-none-match": response.headers.etag,
      "accept-encoding": "gzip",
    }),
  );
  assert.equal(fresh.hits, 1);
  assert.equal(fresh.result.response.statusCode, 304);
  assert.equal(fresh.result.body.length, 0);
  assert.equal(fresh.result.response.headers["content-encoding"], undefined);
});

test("user, host, Turbo-Frame, Accept and query each get their own entry", async () => {
  const path = `/rooms/${open.id}`;
  const own = (await page(path)).body.toString();
  assert.equal((await counted(() => page(path))).hits, 1);
  const variants = [
    () => raw(path, { headers: { cookie: memberCookie } }),
    () => page(path, { host: "other.example.test" }),
    () => page(path, { "turbo-frame": "messages" }),
    () => page(path, { accept: "text/html" }),
    () => page(path + "?x=1"),
  ];
  const bodies = [];
  for (const variant of variants) {
    const first = await counted(variant);
    assert.equal(first.misses, 1);
    assert.equal(first.result.response.statusCode, 200);
    const again = await counted(variant);
    assert.equal(again.hits, 1);
    assert.ok(again.result.body.equals(first.result.body));
    bodies.push(first.result.body.toString());
  }
  assert.ok(bodies[1].includes("other.example.test"));
  assert.notEqual(bodies[0], own, "the member sees their own page");
});

test("own writes, foreign commits, renames and membership changes re-render", async () => {
  const path = `/rooms/${open.id}`;
  const sidebar = "/users/me/sidebar";
  await page(path);
  await page(sidebar);
  assert.equal((await counted(() => page(path))).hits, 1);

  const posted = await raw(`/rooms/${open.id}/messages`, {
    method: "POST",
    headers: {
      cookie: adminCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "message[body]": "brand new message",
    }).toString(),
  });
  assert.equal(posted.response.statusCode, 200);
  const afterPost = await counted(() => page(path));
  assert.equal(afterPost.misses, 1);
  assert.ok(afterPost.result.body.toString().includes("brand new message"));

  run("UPDATE rooms SET name=? WHERE id=?", "Renamed Room", open.id);
  const renamed = await counted(() => page(sidebar));
  assert.equal(renamed.misses, 1);
  assert.ok(renamed.result.body.toString().includes("Renamed Room"));

  const foreign = openDatabase(databaseFile());
  foreign.exec("PRAGMA busy_timeout=10000");
  try {
    foreign
      .prepare("UPDATE rooms SET name=? WHERE id=?")
      .run("Foreign Name", open.id);
  } finally {
    foreign.close();
  }
  const foreignRename = await counted(() => page(sidebar));
  assert.equal(foreignRename.misses, 1);
  assert.ok(foreignRename.result.body.toString().includes("Foreign Name"));

  const t = now();
  const id = Number(
    run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      "Late Joined",
      "Rooms::Open",
      admin.id,
      t,
      t,
    ).lastInsertRowid,
  );
  assert.ok(!(await page(sidebar)).body.toString().includes("Late Joined"));
  domain.grantMemberships(get("SELECT * FROM rooms WHERE id=?", id), [
    admin.id,
  ]);
  const joined = await counted(() => page(sidebar));
  assert.equal(joined.misses, 1);
  assert.ok(joined.result.body.toString().includes("Late Joined"));
});

test("messages page: weak ETag, 304 on a hit, 204 never cached, search cached", async () => {
  const path = `/rooms/${open.id}/messages`;
  const first = await counted(() => page(path));
  assert.equal(first.result.response.statusCode, 200);
  const etag = first.result.response.headers.etag;
  assert.match(etag, /^W\/"[0-9a-f]{40}"$/);
  const hit = await counted(() => page(path));
  assert.equal(hit.hits, 1);
  assert.equal(hit.result.response.headers.etag, etag);
  assert.ok(hit.result.body.equals(first.result.body));
  const fresh = await counted(() => page(path, { "if-none-match": etag }));
  assert.equal(fresh.hits, 1);
  assert.equal(fresh.result.response.statusCode, 304);

  const newest = get(
    "SELECT id FROM messages WHERE room_id=? ORDER BY created_at DESC LIMIT 1",
    open.id,
  ).id;
  for (let i = 0; i < 2; i++) {
    const empty = await page(`${path}?after=${newest}`);
    assert.equal(empty.response.statusCode, 204);
  }

  const search = "/searches?q=cached";
  const found = await counted(() => page(search));
  assert.equal(found.misses, 1);
  assert.ok(found.result.body.toString().includes("cached message"));
  assert.equal((await counted(() => page(search))).hits, 1);
});

test("render runs once per key and epoch; non-200 and HEAD are not cached", async () => {
  const express = (await import("express")).default;
  const app = express();
  app.use((req, res, next) => {
    req.account = get("SELECT * FROM accounts ORDER BY id LIMIT 1");
    next();
  });
  const cache = new ResponseCache(1 << 20);
  let renders = 0;
  const html = "<!DOCTYPE html><p>" + "x".repeat(4000) + "</p>";
  app.get("/page", (req, res) =>
    sendCachedPage(req, res, "t", () => (renders++, html), cache),
  );
  app.get("/created", (req, res) =>
    sendCachedPage(
      req,
      res,
      "c",
      () => (renders++, res.status(201), html),
      cache,
    ),
  );
  const local = http.createServer(app);
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  const at = local.address().port;
  const fetchPage = (path, method = "GET") =>
    new Promise((resolve, reject) =>
      http
        .request({ host: "127.0.0.1", port: at, path, method }, (r) => {
          const chunks = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => resolve({ r, body: Buffer.concat(chunks) }));
        })
        .on("error", reject)
        .end(),
    );
  try {
    await fetchPage("/page");
    await fetchPage("/page");
    assert.equal(renders, 1);
    await fetchPage("/page", "HEAD");
    assert.equal(renders, 2);
    run("UPDATE accounts SET name=name");
    const changed = await fetchPage("/page");
    assert.equal(renders, 3);
    assert.equal(changed.body.toString(), html);
    await fetchPage("/created");
    const created = await fetchPage("/created");
    assert.equal(created.r.statusCode, 201);
    assert.equal(renders, 5);
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

test("the cache stays within its byte budget, gzip included", () => {
  const cache = new ResponseCache(64 * 1024);
  const pageOf = (i) => {
    const bytes = Buffer.from(`<p>${i}</p>`.padEnd(6000, String(i % 10)));
    return { bytes, etag: `W/"${i}"` };
  };
  const epoch = "e1";
  for (let i = 0; i < 100; i++) {
    cache.get(`k${i}`, epoch);
    cache.set(`k${i}`, epoch, {
      ...pageOf(i),
      gzipped: null,
      gzip() {
        this.gzipped = zlib.gzipSync(this.bytes);
        this.cache?.charge(this, this.gzipped.length);
        return this.gzipped;
      },
    });
    assert.ok(cache.stats().bytes <= cache.budget, `after ${i}`);
  }
  const live = cache.get("k99", epoch);
  assert.ok(live);
  live.gzip();
  assert.ok(cache.stats().bytes <= cache.budget);
  assert.equal(cache.get("k0", epoch), undefined);
  cache.get("k99", "e2");
  assert.deepEqual(
    { entries: cache.stats().entries, bytes: cache.stats().bytes },
    { entries: 0, bytes: 0 },
    "a new epoch drops every entry",
  );
  const tooBig = { bytes: Buffer.alloc(cache.maxEntry + 1), etag: "x" };
  cache.set("big", "e2", tooBig);
  assert.equal(cache.get("big", "e2"), undefined);
});

test("CAMPFIRE_RESPONSE_CACHE_MB clamps invalid and negative values to 32", () => {
  const mb = 1024 * 1024;
  assert.equal(budgetFromEnv(undefined), 32 * mb);
  assert.equal(budgetFromEnv(""), 32 * mb);
  assert.equal(budgetFromEnv("nope"), 32 * mb);
  assert.equal(budgetFromEnv("-5"), 32 * mb);
  assert.equal(budgetFromEnv("0"), 0);
  assert.equal(budgetFromEnv("8"), 8 * mb);
});

test("message cache keys see a body change that keeps updated_at", () => {
  const message = domain.createMessage(open.id, admin.id, "<p>before</p>");
  const row = domain.messageById(message.id);
  const [first] = messageCacheKeys([row]);
  assert.equal(messageCacheKeys([row])[0], first);
  run(
    "UPDATE action_text_rich_texts SET body=? WHERE record_type='Message' AND record_id=?",
    "<p>after</p>",
    message.id,
  );
  assert.notEqual(messageCacheKeys([row])[0], first);
});
