import { test, before } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import http from "node:http";
process.env.DATABASE_PATH = ":memory:";
process.env.SECRET_KEY_BASE = "spliced-gzip-tests-".repeat(8);
const { SplicedGzip, gzipSpliced, splicedGzipCache, fastEtag } =
  await import("../src/gzip.js");
const { run, get, now, initialize } = await import("../src/db.js");
const domain = await import("../src/domain.js");
const rails = await import("../src/rails.js");
const { createApp } = await import("../src/app.js");
const { responseCache } = await import("../src/response_cache.js");

const token = (n) =>
  Buffer.from(`token-${n}-`.padEnd(64, String(n % 10))).toString("base64");
const messages = (n, csrf) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<div class="message" id="m${i}"><p>Zażółć gęślą jaźń 🔥 ${i} ${"lorem ipsum ".repeat(i % 7)}</p>` +
      `<form action="/m/${i}/boosts" method="post"><input type="hidden" name="authenticity_token" value="${csrf}"></form></div>`,
  ).join("\n");
const page = (csrf, n = 40) =>
  `<!DOCTYPE html><html><head><meta name="csrf-token" content="${csrf}"></head><body>${messages(n, csrf)}</body></html>`;

function assertSingleMemberGzip(gz, body) {
  const bytes = Buffer.from(body, "utf8");
  assert.equal(zlib.gunzipSync(gz).toString("utf8"), body);
  assert.deepEqual([...gz.subarray(0, 4)], [0x1f, 0x8b, 8, 0]);
  assert.deepEqual([...gz.subarray(-10, -8)], [0x03, 0x00]);
  assert.equal(gz.readUInt32LE(gz.length - 8), zlib.crc32(bytes) >>> 0);
  assert.equal(gz.readUInt32LE(gz.length - 4), bytes.length >>> 0);
  assert.ok(
    zlib.inflateRawSync(gz.subarray(10, -8)).equals(bytes),
    "one deflate stream fills everything between header and trailer",
  );
}

test("a/f: round trips with 0, 1 and many volatiles, at edges, adjacent, and next to multi-byte UTF-8", () => {
  const t = token(1);
  const cases = [
    ["", []],
    ["x", [t]],
    [page(t), []],
    [page(t), [""]],
    [page(t), ["not-present"]],
    [`<p>${t}</p>`.repeat(1).padEnd(3000, "ą"), [t]],
    [t + page(t) + t, [t]],
    [t + t + "ż" + t + t + "🔥" + t, [t]],
    [`ź${t}ę${t}😀${t}`.repeat(50), [t]],
    [page(t, 200), [t]],
    [page(t) + "second" + token(2), [t, token(2)]],
  ];
  for (const [body, volatile] of cases)
    assertSingleMemberGzip(gzipSpliced(body, volatile), body);
});

test("b: the same page with different tokens reuses every stable piece", () => {
  const gzip = new SplicedGzip(32 << 20);
  const first = page(token(1));
  assertSingleMemberGzip(gzip.gzip(first, [token(1)]), first);
  const cold = gzip.stats();
  assert.equal(cold.hits, 0);
  assert.ok(cold.misses > 40);
  const second = page(token(2));
  assertSingleMemberGzip(gzip.gzip(second, [token(2)]), second);
  const warm = gzip.stats();
  assert.equal(warm.misses, cold.misses, "no stable piece compressed again");
  assert.equal(warm.hits, cold.misses);
});

test("whole bodies without volatiles are cached as one piece", () => {
  const gzip = new SplicedGzip(32 << 20);
  const body = page("static", 10);
  gzip.gzip(body, [token(3)]);
  gzip.gzip(body, []);
  assert.deepEqual(
    { hits: gzip.stats().hits, misses: gzip.stats().misses },
    { hits: 1, misses: 1 },
  );
});

test("c: a segment after a different predecessor never uses the other's piece", () => {
  const gzip = new SplicedGzip(32 << 20);
  const tail = "<p>shared tail shared tail shared tail</p>".repeat(30);
  const t = token(4);
  const a = "<p>predecessor A shared tail shared</p>".repeat(30) + t + tail;
  const b = "<div>predecessor B other content</div>".repeat(30) + t + tail;
  assertSingleMemberGzip(gzip.gzip(a, [t]), a);
  assertSingleMemberGzip(gzip.gzip(b, [t]), b);
  assert.equal(gzip.stats().hits, 0);
  const longer = token(5) + "xx";
  const c =
    "<p>predecessor A shared tail shared</p>".repeat(30) + longer + tail;
  assertSingleMemberGzip(gzip.gzip(c, [longer]), c);
  assert.equal(gzip.stats().hits, 1, "only the first segment matches");
});

test("cached pieces never refer into a volatile value", () => {
  const gzip = new SplicedGzip(32 << 20);
  const shared = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
  const first = shared + "1234567890abcdef";
  const second = "ZZZZZZZZZZZZZZZZZZZZZZZZZZ" + "fedcba0987654321";
  const body = (t) => `<meta content="${t}"><p>${shared} and more</p>`;
  assertSingleMemberGzip(gzip.gzip(body(first), [first]), body(first));
  assertSingleMemberGzip(gzip.gzip(body(second), [second]), body(second));
  assert.equal(gzip.stats().hits, 2);
});

test("hash collisions cannot serve another text: hits are confirmed by equality", () => {
  const gzip = new SplicedGzip(32 << 20);
  gzip.hash = () => 42n;
  const one = "<p>one</p>".repeat(200);
  const two = "<p>two</p>".repeat(200);
  assertSingleMemberGzip(gzip.gzip(one, []), one);
  assertSingleMemberGzip(gzip.gzip(two, []), two);
  assertSingleMemberGzip(gzip.gzip(one, []), one);
});

test("stable segments containing NUL bytes stay exact after a volatile", () => {
  const t = token(6);
  const body = "head\0er".repeat(100) + t + "\0\0\0abc".repeat(100) + t;
  assertSingleMemberGzip(gzipSpliced(body, [t]), body);
  const gzip = new SplicedGzip(32 << 20);
  gzip.gzip(body, [t]);
  const other = body.replaceAll(t, token(7));
  assertSingleMemberGzip(gzip.gzip(other, [token(7)]), other);
});

test("d: cache bytes stay within the budget under many distinct pages", () => {
  const budget = 256 * 1024;
  const gzip = new SplicedGzip(budget);
  for (let i = 0; i < 300; i++) {
    const body = `<h1>page ${i}</h1>` + page(token(i), 8);
    assertSingleMemberGzip(gzip.gzip(body, [token(i)]), body);
    assert.ok(gzip.stats().bytes <= budget, `bytes ${gzip.stats().bytes}`);
  }
  assert.ok(gzip.stats().entries > 0);
});

test("eviction in the middle of a page keeps later pieces exact", () => {
  const gzip = new SplicedGzip(24 * 1024);
  for (let round = 0; round < 3; round++)
    for (let i = 0; i < 12; i++) {
      const t = token(round * 100 + i);
      const body = `<h1>${i % 4}</h1>` + page(t, 30);
      assertSingleMemberGzip(gzip.gzip(body, [t]), body);
      assert.ok(gzip.stats().bytes <= gzip.budget);
    }
});

test("pieces are keyed by the whole 32 KiB window, not only the predecessor", () => {
  const gzip = new SplicedGzip(32 << 20);
  const t = token(8);
  const middle = "<p>same middle</p>".repeat(20);
  const tail = "<p>same tail, earlier differs</p>".repeat(20);
  const a = "<p>early A content</p>".repeat(40) + t + middle + t + tail;
  const b = "<p>early B content</p>".repeat(40) + t + middle + t + tail;
  assertSingleMemberGzip(gzip.gzip(a, [t]), a);
  assertSingleMemberGzip(gzip.gzip(b, [t]), b);
  assert.equal(gzip.stats().hits, 0);
  const far = "x".repeat(40 * 1024);
  const c = far + t + middle + t + tail;
  const d = "y".repeat(40 * 1024) + t + middle + t + tail;
  assertSingleMemberGzip(gzip.gzip(c, [t]), c);
  const before = gzip.stats().hits;
  assertSingleMemberGzip(gzip.gzip(d, [t]), d);
  assert.equal(
    gzip.stats().hits,
    before,
    "the 32 KiB window still reaches x/y",
  );
  const pad = "<p>pad</p>".repeat(3300);
  const e = "z".repeat(80 * 1024) + t + pad + t + tail;
  const f = "w".repeat(80 * 1024) + t + pad + t + tail;
  gzip.gzip(e, [t]);
  const hitsBefore = gzip.stats().hits;
  assertSingleMemberGzip(gzip.gzip(f, [t]), f);
  assert.equal(
    gzip.stats().hits,
    hitsBefore + 1,
    "content beyond the window does not matter",
  );
});

// Filler that puts a value's next occurrence exactly 32 KiB after its previous one.
const WINDOW_GAP = (length) => 32 * 1024 - length;
test("volatile values are back-references within the window and literals otherwise", () => {
  const gzip = new SplicedGzip(32 << 20);
  for (const length of [1, 2, 3, 4, 10, 88, 257, 258, 259, 260, 261, 516, 600])
    for (const gap of [
      0,
      1,
      500,
      WINDOW_GAP(length) - 1,
      WINDOW_GAP(length),
      WINDOW_GAP(length) + 1,
    ]) {
      const value = Array.from({ length }, (_, i) =>
        String.fromCharCode(33 + ((i * 7) % 90)),
      ).join("");
      const filler = "<b>x</b>".repeat(Math.ceil(gap / 8)).slice(0, gap);
      const body = `<a>${value}${filler}${value}${value}</a>${filler}${value}`;
      assertSingleMemberGzip(gzip.gzip(body, [value]), body);
    }
  const one = token(9);
  const two = token(10) + "-other";
  const body = `${one}<p>${two}${one}</p>${two}${two}${one}`.repeat(30);
  assertSingleMemberGzip(gzip.gzip(body, [one, two]), body);
  const repeated = page(token(11), 40);
  const spliced = gzip.gzip(repeated, [token(11)]).length;
  const whole = zlib.gzipSync(repeated, { level: 6 }).length;
  assert.ok(
    spliced < whole + 32 * 41,
    `41 occurrences add little over whole-page gzip: ${spliced} vs ${whole}`,
  );
});

let open, admin;
before(() => {
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
  const r = run(
    "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
    "Open",
    "Rooms::Open",
    admin.id,
    t,
    t,
  );
  open = get("SELECT * FROM rooms WHERE id=?", Number(r.lastInsertRowid));
  domain.grantMemberships(open, [admin.id]);
  for (let i = 0; i < 30; i++)
    domain.createMessage(open.id, admin.id, `<p>gzip message ${i} żółć 🔥</p>`);
  run(
    "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
    admin.id,
    "gzip-session",
    t,
    t,
    t,
  );
});

function raw(port, path, { method = "GET", headers = {} } = {}) {
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
    request.end();
  });
}

test("e: room pages are served as spliced gzip through the real app", async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const cookie =
    "session_token=" +
    encodeURIComponent(rails.signCookie("session_token", "gzip-session"));
  const path = `/rooms/${open.id}`;
  try {
    const plain = await raw(port, path, {
      headers: { cookie, "accept-encoding": "identity" },
    });
    assert.equal(plain.response.statusCode, 200);
    assert.equal(plain.response.headers["content-encoding"], undefined);
    const identity = plain.body.toString("utf8");
    assert.ok(identity.length > 1024);
    assert.equal(
      Number(plain.response.headers["content-length"]),
      plain.body.length,
    );

    const zipped = await raw(port, path, {
      headers: { cookie, "accept-encoding": "gzip, deflate, br" },
    });
    const headers = zipped.response.headers;
    assert.equal(zipped.response.statusCode, 200);
    assert.equal(headers["content-encoding"], "gzip");
    assert.match(headers.vary, /Accept-Encoding/);
    assert.match(headers["content-type"], /^text\/html; charset=utf-8$/);
    assert.equal(Number(headers["content-length"]), zipped.body.length);
    const html = zlib.gunzipSync(zipped.body).toString("utf8");
    assertSingleMemberGzip(zipped.body, html);
    assert.ok(!/csrf-token|authenticity_token/.test(html), "no CSRF tags");
    assert.equal(html, identity);
    const etag = headers.etag;
    assert.match(etag, /^W\/"/);
    assert.equal(
      etag,
      fastEtag(Buffer.from(html, "utf8")),
      "ETag is the fast weak ETag over the uncompressed body",
    );

    const viaFetch = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { cookie },
    });
    assert.equal(viaFetch.headers.get("content-encoding"), "gzip");
    assert.equal(await viaFetch.text(), identity);

    // With no per-request values the whole page is one piece; a repeat is a response-cache hit
    // that reuses the stored gzip bytes and compresses nothing.
    const before = splicedGzipCache.stats();
    const pagesBefore = responseCache.stats();
    const again = await raw(port, path, {
      headers: { cookie, "accept-encoding": "gzip" },
    });
    const after = splicedGzipCache.stats();
    assert.ok(again.body.equals(zipped.body), "repeat gzip is byte-identical");
    assert.equal(after.misses, before.misses, "no piece recompressed");
    assert.equal(responseCache.stats().hits, pagesBefore.hits + 1);

    const head = await raw(port, path, {
      method: "HEAD",
      headers: { cookie, "accept-encoding": "gzip" },
    });
    assert.equal(head.response.statusCode, 200);
    assert.equal(head.body.length, 0);
    assert.match(head.response.headers["content-type"], /^text\/html/);
    assert.ok(head.response.headers.etag);

    const messagesPath = `/rooms/${open.id}/messages`;
    const messages = await raw(port, messagesPath, {
      headers: { cookie, "accept-encoding": "gzip" },
    });
    assert.equal(messages.response.statusCode, 200);
    const fragmentEtag = messages.response.headers.etag;
    assert.match(fragmentEtag, /^W\/"[0-9a-f]{40}"$/);
    if (messages.body.length)
      assert.ok(
        messages.response.headers["content-encoding"] !== "gzip" ||
          zlib.gunzipSync(messages.body).length > 0,
      );
    const notModified = await raw(port, messagesPath, {
      headers: {
        cookie,
        "accept-encoding": "gzip",
        "if-none-match": fragmentEtag,
      },
    });
    assert.equal(notModified.response.statusCode, 304);
    assert.equal(notModified.body.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the middleware keeps Express ETag, 304, HEAD and identity semantics", async () => {
  const express = (await import("express")).default;
  const { splicedGzip } = await import("../src/gzip.js");
  const app = express();
  app.use(splicedGzip());
  const body = page("fixed-token", 20);
  app.get("/page", (req, res) => {
    res.send(body);
  });
  app.get("/small", (req, res) => res.send("<p>small</p>"));
  app.get("/json", (req, res) => res.json({ body }));
  app.get("/created", (req, res) => res.status(201).send(body));
  app.get("/no-transform", (req, res) =>
    res.set("Cache-Control", "no-transform").send(body),
  );
  app.get("/typed", (req, res) =>
    res.set("Content-Type", req.query.type).send(body),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const gzipHeaders = { "accept-encoding": "gzip" };
  try {
    const zipped = await raw(port, "/page", { headers: gzipHeaders });
    assert.equal(zipped.response.headers["content-encoding"], "gzip");
    assertSingleMemberGzip(zipped.body, body);
    const etag = zipped.response.headers.etag;
    assert.equal(etag, fastEtag(Buffer.from(body, "utf8")));

    const plain = await raw(port, "/page");
    assert.equal(plain.response.headers["content-encoding"], undefined);
    assert.equal(plain.body.toString("utf8"), body);
    assert.equal(plain.response.headers.etag, etag);

    const fresh = await raw(port, "/page", {
      headers: { ...gzipHeaders, "if-none-match": etag },
    });
    assert.equal(fresh.response.statusCode, 304);
    assert.equal(fresh.body.length, 0);
    assert.equal(fresh.response.headers["content-encoding"], undefined);

    const head = await raw(port, "/page", {
      method: "HEAD",
      headers: gzipHeaders,
    });
    assert.equal(head.response.statusCode, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.response.headers.etag, etag);

    for (const path of ["/small", "/json", "/created", "/no-transform"]) {
      const other = await raw(port, path, { headers: gzipHeaders });
      assert.equal(other.response.headers["content-encoding"], undefined, path);
    }

    for (const type of [
      "text/html",
      "Text/HTML; charset=latin1",
      "text/html; level=1",
    ]) {
      const path = "/typed?type=" + encodeURIComponent(type);
      const zippedType = (await raw(port, path, { headers: gzipHeaders }))
        .response.headers["content-type"];
      const plainType = (await raw(port, path)).response.headers[
        "content-type"
      ];
      assert.equal(zippedType, plainType, type);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Deterministic PRNG (mulberry32) so a failing iteration reproduces from the seed.
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzz(gzip, seed, iterations) {
  const random = prng(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const words = [
    "zażółć",
    "gęślą",
    "jaźń",
    "🔥",
    "日本語",
    "<b>bold</b>",
    "&amp;",
    "QWxhZGRpbjpvcGVu",
    "abc-_XYZ09",
    "lorem",
    "ipsum",
    "dolor",
  ];
  const layouts = Array.from({ length: 4 }, (_, l) =>
    Array.from(
      { length: 5 + Math.floor(random() * 80) },
      (_, i) =>
        `<div class="message" id="l${l}m${i}"><p>` +
        Array.from({ length: Math.floor(random() * 30) }, () =>
          pick(l === 3 ? [...words, "\0", "x\0y"] : words),
        ).join(" ") +
        `</p><form method="post" action="/m/${i}"><input name="authenticity_token" value="`,
    ),
  );
  const tokenOf = () => {
    const value = Buffer.from(
      Array.from({ length: 64 }, () => Math.floor(random() * 256)),
    ).toString("base64url");
    return random() < 0.8
      ? value
      : value.slice(0, 3 + Math.floor(random() * 80));
  };
  const warmed = new Set();
  let fullyReused = 0;
  for (let i = 0; i < iterations; i++) {
    const token = tokenOf();
    const layout = layouts[i % layouts.length];
    let body =
      `<meta name="csrf-token" content="${token}">` +
      layout.map((part) => part + token + '"></form></div>').join("\n");
    if (i % 7 === 0) body += `<p>user typed ${token.slice(5, 20)} and \0</p>`;
    const misses = gzip.stats().misses;
    assertSingleMemberGzip(gzip.gzip(body, [token]), body);
    assert.ok(gzip.stats().bytes <= gzip.budget, `iteration ${i}`);
    // Same NUL-free layout and token length as an earlier plain iteration: every piece is
    // cached (segments with NUL after a token are never cached).
    const shape = `${i % layouts.length}:${token.length}`;
    if (i % 7 === 0 || i % layouts.length === 3) continue;
    if (warmed.has(shape) && gzip.stats().misses === misses) fullyReused++;
    warmed.add(shape);
  }
  return fullyReused;
}

test("gzipWhole equals the one-piece spliced gzip without touching its cache", async () => {
  const { gzipWhole } = await import("../src/gzip.js");
  const gzip = new SplicedGzip(32 << 20);
  for (const body of [page("whole", 5), page("whole", 120), "ż".repeat(5000)]) {
    const bytes = Buffer.from(body, "utf8");
    const before = splicedGzipCache.stats();
    const whole = gzipWhole(bytes);
    assert.deepEqual(splicedGzipCache.stats(), before);
    assert.ok(whole.equals(gzip.gzip(bytes)));
    assertSingleMemberGzip(whole, body);
  }
});

test("sendPage answers like res.send(string) through the middleware", async () => {
  const express = (await import("express")).default;
  const { splicedGzip, sendPage, gzipWhole } = await import("../src/gzip.js");
  const app = express();
  app.use(splicedGzip());
  const body = page("fixed-token", 20);
  const small = "<p>small</p>";
  const pageOf = (html) => {
    const bytes = Buffer.from(html, "utf8");
    return {
      bytes,
      etag: fastEtag(bytes),
      gzip: () => gzipWhole(bytes),
    };
  };
  app.get("/string", (req, res) => res.type("html").send(body));
  app.get("/page", (req, res) => sendPage(req, res, pageOf(body)));
  app.get("/small-string", (req, res) => res.type("html").send(small));
  app.get("/small-page", (req, res) => sendPage(req, res, pageOf(small)));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const relevant = (headers) => ({
    type: headers["content-type"],
    etag: headers.etag,
    encoding: headers["content-encoding"],
    vary: headers.vary,
    length: headers["content-length"],
  });
  try {
    for (const [a, b] of [
      ["/string", "/page"],
      ["/small-string", "/small-page"],
    ])
      for (const headers of [
        {},
        { "accept-encoding": "gzip" },
        { "accept-encoding": "identity" },
      ]) {
        const expected = await raw(port, a, { headers });
        const actual = await raw(port, b, { headers });
        assert.equal(actual.response.statusCode, expected.response.statusCode);
        assert.deepEqual(
          relevant(actual.response.headers),
          relevant(expected.response.headers),
        );
        assert.ok(actual.body.equals(expected.body));
        const fresh = await raw(port, b, {
          headers: {
            ...headers,
            "if-none-match": expected.response.headers.etag,
          },
        });
        assert.equal(fresh.response.statusCode, 304);
        assert.equal(fresh.body.length, 0);
      }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fuzz: random tokens over reused layouts with the default budget reuse pieces", () => {
  const gzip = new SplicedGzip(32 << 20);
  const fullyReused = fuzz(gzip, 20261006, 200);
  assert.ok(fullyReused > 60, `fully reused iterations: ${fullyReused}`);
  assert.ok(gzip.stats().hits > 0);
});

test("fuzz: random tokens under a tiny budget stay exact while evicting", () => {
  const gzip = new SplicedGzip(16 * 1024);
  fuzz(gzip, 7, 200);
  assert.ok(gzip.stats().hits > 0);
});
