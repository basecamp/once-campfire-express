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
const { fastEtag } = await import("../src/gzip.js");
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
    fastEtag(first.result.body),
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
    zlib
      .gunzipSync(plainZipped.body)
      .equals(zlib.gunzipSync(zipped.result.body)),
  );
  for (const name of ["content-type", "vary"])
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

test("render runs once per key and epoch; non-200 and HEAD misses are not cached", async () => {
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
    assert.equal(renders, 1);
    run("UPDATE accounts SET name=name");
    const changed = await fetchPage("/page");
    assert.equal(renders, 2);
    assert.equal(changed.body.toString(), html);
    await fetchPage("/created");
    const created = await fetchPage("/created");
    assert.equal(created.r.statusCode, 201);
    assert.equal(renders, 4);
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

test("CAMPFIRE_RESPONSE_CACHE_MB defaults to 64MiB, supports off and bounds configuration", () => {
  const mb = 1024 * 1024;
  assert.equal(budgetFromEnv(undefined), 64 * mb);
  assert.equal(budgetFromEnv(""), 64 * mb);
  assert.equal(budgetFromEnv("nope"), 0);
  assert.equal(budgetFromEnv("-5"), 0);
  assert.equal(budgetFromEnv("0"), 0);
  assert.equal(budgetFromEnv("8"), 8 * mb);
  assert.equal(budgetFromEnv("1000000000"), 1024 * mb);
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

test("message cache keys see a middle edit that keeps length, edges and timestamps", () => {
  const padding = "x".repeat(40);
  const message = domain.createMessage(
    open.id,
    admin.id,
    `<p>${padding} yes ${padding}</p>`,
  );
  const row = domain.messageById(message.id);
  const [first] = messageCacheKeys([row]);
  const foreign = openDatabase(databaseFile());
  try {
    foreign
      .prepare(
        "UPDATE action_text_rich_texts SET body=replace(body,' yes ',' no! ') WHERE record_type='Message' AND record_id=?",
      )
      .run(message.id);
  } finally {
    foreign.close();
  }
  assert.notEqual(messageCacheKeys([row])[0], first);
});

test("a cache miss encodes the rendered page to bytes once and answers 304 on the fast ETag", async () => {
  const path = `/rooms/${open.id}`;
  responseCache.clear?.();
  const original = Buffer.from;
  let pageEncodings = 0;
  Buffer.from = function (value, ...rest) {
    if (typeof value === "string" && value.length > 20000) pageEncodings++;
    return original.call(this, value, ...rest);
  };
  let first;
  try {
    first = await counted(() => page(path, { "accept-encoding": "gzip" }));
  } finally {
    Buffer.from = original;
  }
  assert.equal(first.misses, 1);
  assert.equal(pageEncodings, 1);
  const etag = first.result.response.headers.etag;
  assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  const plain = await page(path);
  assert.equal(plain.response.headers.etag, etag);
  assert.equal(etag, fastEtag(plain.body));
  const fresh = await page(path, { "if-none-match": etag });
  assert.equal(fresh.response.statusCode, 304);
  assert.equal(fresh.body.length, 0);
});

test("message cache keys are stable across calls and see same-length edits", () => {
  const message = domain.createMessage(open.id, admin.id, "<p>aaaa</p>");
  const row = domain.messageById(message.id);
  const [first] = messageCacheKeys([row]);
  assert.equal(messageCacheKeys([row])[0], first);
  run(
    "UPDATE action_text_rich_texts SET body=? WHERE record_type='Message' AND record_id=?",
    "<p>bbbb</p>",
    message.id,
  );
  assert.notEqual(messageCacheKeys([row])[0], first);
});

test("message cache keys follow updated_at, which every edit moves even in one frozen millisecond", () => {
  const frozen = process.env.CAMPFIRE_FROZEN_TIME;
  process.env.CAMPFIRE_FROZEN_TIME = "2026-01-02T03:04:05.678Z";
  try {
    const message = domain.createMessage(open.id, admin.id, "<p>aaaa</p>");
    const key = () => messageCacheKeys([domain.messageById(message.id)])[0];
    const first = key();
    assert.equal(key(), first);
    assert.match(
      domain.messageById(message.id).updated_at,
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/,
    );
    domain.updateMessage(domain.messageById(message.id), "<p>bbbb</p>");
    const second = key();
    assert.notEqual(second, first, "same-length edit in the same millisecond");
    domain.updateMessage(domain.messageById(message.id), "<p>cccc</p>");
    assert.notEqual(key(), second);
    const third = key();
    run(
      "UPDATE action_text_rich_texts SET body=? WHERE record_type='Message' AND record_id=?",
      "<p>dddd</p>",
      message.id,
    );
    assert.notEqual(
      key(),
      third,
      "a body write that keeps timestamps also changes the key",
    );
  } finally {
    if (frozen === undefined) delete process.env.CAMPFIRE_FROZEN_TIME;
    else process.env.CAMPFIRE_FROZEN_TIME = frozen;
  }
});

test("cached responses never outlive session, user or room authorization", async () => {
  const user = domain.createUser({
    name: "Cache security",
    email_address: "cache-security@example.test",
    password: "password",
  });
  const t = now();
  const room = Number(
    run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      "Cached private",
      "Rooms::Closed",
      user.id,
      t,
      t,
    ).lastInsertRowid,
  );
  domain.grantMemberships(get("SELECT * FROM rooms WHERE id=?", room), [
    user.id,
  ]);
  for (const token of ["cache-security-one", "cache-security-two"])
    run(
      "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
      user.id,
      token,
      t,
      t,
      t,
    );
  const one = sessionCookie("cache-security-one"),
    two = sessionCookie("cache-security-two");
  const path = `/rooms/${room}`;
  const request = (cookie) => raw(path, { headers: { cookie } });
  await request(one);
  assert.equal((await counted(() => request(one))).hits, 1);
  assert.equal(
    (await counted(() => request(two))).misses,
    1,
    "Two sessions must have independent cache keys",
  );
  assert.equal((await counted(() => request(two))).hits, 1);
  const expired =
    "session_token=" +
    encodeURIComponent(
      rails.signCookie(
        "session_token",
        "cache-security-one",
        new Date(Date.now() - 1000),
      ),
    );
  assert.equal((await counted(() => request(expired))).hits, 0);
  assert.equal((await request(expired)).response.statusCode, 302);
  const foreign = openDatabase(databaseFile());
  try {
    foreign
      .prepare("DELETE FROM sessions WHERE token=?")
      .run("cache-security-one");
    const revoked = await counted(() => request(one));
    assert.equal(revoked.result.response.statusCode, 302);
    assert.equal(revoked.hits, 0);
    await request(two);
    foreign
      .prepare("DELETE FROM memberships WHERE room_id=? AND user_id=?")
      .run(room, user.id);
    const unreachable = await counted(() => request(two));
    assert.equal(unreachable.result.response.statusCode, 302);
    assert.equal(unreachable.hits, 0);
    foreign.prepare("UPDATE users SET status=2 WHERE id=?").run(user.id);
    assert.equal((await request(two)).response.statusCode, 302);
  } finally {
    foreign.close();
  }
});

test("warm GET caches leave native Origin and Sec-Fetch-Site forgery checks active", async () => {
  const path = `/rooms/${open.id}`;
  await page(path);
  await page(path);
  for (const headers of [
    { origin: "https://attacker.test" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const rejected = await counted(() =>
      raw(`${path}/messages`, {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: "message%5Bbody%5D=forged-cache-message",
      }),
    );
    assert.equal(rejected.result.response.statusCode, 422);
    assert.equal(rejected.hits, 0);
  }
  assert.equal(
    get(
      "SELECT count(*) AS n FROM action_text_rich_texts WHERE body LIKE '%forged-cache-message%'",
    ).n,
    0,
  );
});

test("keys separate cookies, Origin and User-Agent without unused token dimensions or page substitution", async () => {
  const { pageKey } = await import("../src/response_cache.js");
  const headers = { host: "cache.test" };
  const req = {
    protocol: "http",
    originalUrl: "/searches?q=literal",
    session: {},
    get: (name) => headers[name.toLowerCase()],
  };
  const base = pageKey(req, "search");
  for (const [header, value] of [
    ["cookie", "_campfire_session=signed"],
    ["origin", "https://other.test"],
    ["user-agent", "Native user agent"],
  ]) {
    headers[header] = value;
    assert.notEqual(pageKey(req, "search"), base);
    delete headers[header];
  }
  req.csrfToken = "literal-csrf-token";
  assert.equal(pageKey(req, "search"), base);
  delete req.csrfToken;
  req.session._csrf_token = "another-literal-token";
  assert.equal(pageKey(req, "search"), base);
  domain.createMessage(
    open.id,
    admin.id,
    "<p>literal __csrf_token__ and csrf-token=original stay unchanged</p>",
  );
  const path = `/rooms/${open.id}`;
  const first = await page(path),
    hit = await counted(() => page(path));
  assert.equal(hit.hits, 1);
  assert.ok(hit.result.body.equals(first.body));
  assert.ok(
    hit.result.body
      .toString()
      .includes(
        "literal __csrf_token__ and csrf-token=original stay unchanged",
      ),
  );
});

test("a commit between pre-authentication capture and rendering prevents hits and admission", async () => {
  const express = (await import("express")).default;
  const { beginPage } = await import("../src/response_cache.js");
  const cache = new ResponseCache(1 << 20);
  let renders = 0,
    mutate = false;
  const app = express();
  app.use((req, res, next) => {
    beginPage(req);
    req.account = get("SELECT * FROM accounts ORDER BY id LIMIT 1");
    if (mutate) run("UPDATE accounts SET name=name");
    next();
  });
  app.get("/page", (req, res) =>
    sendCachedPage(
      req,
      res,
      "race",
      () => {
        renders++;
        return "<!DOCTYPE html><p>captured before commit</p>";
      },
      cache,
    ),
  );
  const local = http.createServer(app);
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  const request = () =>
    fetch(`http://127.0.0.1:${local.address().port}/page`).then((res) =>
      res.text(),
    );
  try {
    await request();
    await request();
    assert.equal(renders, 1);
    mutate = true;
    await request();
    assert.equal(renders, 2);
    const after = cache.stats();
    await request();
    assert.equal(renders, 3);
    assert.equal(cache.stats().hits, after.hits);
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

test("flash-bearing pages bypass lookup and admission", async () => {
  const express = (await import("express")).default;
  const cache = new ResponseCache(1 << 20);
  const app = express();
  let renders = 0;
  app.get("/page", (req, res) => {
    req.account = get("SELECT * FROM accounts ORDER BY id LIMIT 1");
    req.session = req.query.flash ? { flash: { notice: "only once" } } : {};
    sendCachedPage(
      req,
      res,
      "flash",
      () => {
        renders++;
        return (
          "<!DOCTYPE html><p>" +
          (req.session.flash?.notice || "ordinary") +
          "</p>"
        );
      },
      cache,
    );
  });
  const local = http.createServer(app);
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  const request = (path) =>
    fetch(`http://127.0.0.1:${local.address().port}${path}`).then((res) =>
      res.text(),
    );
  try {
    await request("/page");
    await request("/page");
    assert.equal(renders, 1);
    const before = cache.stats();
    assert.match(await request("/page?flash=1"), /only once/);
    assert.match(await request("/page?flash=1"), /only once/);
    assert.equal(cache.stats().entries, before.entries);
    assert.match(await request("/page"), /ordinary/);
    assert.equal(renders, 3);
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
});

test("foreign edits without timestamps invalidate nested message fragments", async () => {
  const message = domain.createMessage(
    open.id,
    member.id,
    "<p>original nested body</p>",
  );
  const path = `/rooms/${open.id}`;
  await page(path);
  await page(path);
  const foreign = openDatabase(databaseFile());
  try {
    foreign
      .prepare(
        "UPDATE action_text_rich_texts SET body=? WHERE record_type='Message' AND record_id=?",
      )
      .run("<p>foreign nested body</p>", message.id);
    let fresh = await page(path);
    assert.match(fresh.body.toString(), /foreign nested body/);
    assert.doesNotMatch(fresh.body.toString(), /original nested body/);
    foreign
      .prepare("UPDATE users SET name=? WHERE id=?")
      .run("Foreign fragment creator", member.id);
    fresh = await page(path);
    assert.match(fresh.body.toString(), /Foreign fragment creator/);
    foreign
      .prepare(
        "INSERT INTO boosts(booster_id,content,created_at,message_id,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(admin.id, "🍊", now(), message.id, now());
    fresh = await page(path);
    assert.match(fresh.body.toString(), /🍊/);
    foreign
      .prepare("UPDATE boosts SET content=? WHERE message_id=?")
      .run("🍋", message.id);
    fresh = await page(path);
    assert.match(fresh.body.toString(), /🍋/);
    assert.doesNotMatch(fresh.body.toString(), /🍊/);
  } finally {
    foreign.close();
  }
});
