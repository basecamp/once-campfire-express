import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-public-"));
process.env.DATABASE_PATH = path.join(root, "db.sqlite3");
process.env.CAMPFIRE_STORAGE_PATH = root;
process.env.SECRET_KEY_BASE = "public-responses-tests";
const dir = "assets/generated/public/assets";
if (!fs.existsSync("assets/generated/manifest.json"))
  execFileSync(process.execPath, ["bin/build-assets.js"], { stdio: "ignore" });
const { createServer: createAppServer } = await import("../src/app.js");
const { listenApp } = await import("./fastify_app.js");
const { run, now } = await import("../src/db.js");
const { replaceAttachment, removeAttachment } =
  await import("../src/storage.js");
const { avatar } = await import("../src/rendering.js");
const { publicResponses, cachedAssets, responseCache } =
  await import("../src/static_responses.js");

const servers = [];
async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
let fast, slow;
before(async () => {
  fast = await listen(await createAppServer());
  slow = await listen(await createAppServer({ publicCache: responseCache(0) }));
});
after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// Raw responses: status, header lines in wire order (Date and cookie values vary) and body bytes.
const fetchRaw = (base, url, { method = "GET", ...headers } = {}) =>
  new Promise((resolve, reject) => {
    request(base + url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const lines = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const [name, value] = res.rawHeaders.slice(i, i + 2);
          if (/^date$/i.test(name)) continue;
          lines.push(
            `${name}: ${/^set-cookie$/i.test(name) ? value.replace(/=[^;]*/, "=").replace(/expires=[^;]*/i, "") : value}`,
          );
        }
        const response = {
          status: res.statusCode,
          lines,
          body: Buffer.concat(chunks),
        };
        Object.defineProperty(response, "headers", { value: res.headers });
        resolve(response);
      });
    })
      .on("error", reject)
      .end();
  });
async function until(condition) {
  for (let i = 0; i < 500 && !condition(); i++)
    await new Promise((r) => setTimeout(r, 2));
  assert.ok(condition(), "timed out");
}
const assetKey = (name, accept) => {
  const encoding = accept && /\b(br|gzip)\b/.exec(accept)?.[1];
  return encoding &&
    fs.existsSync(path.join(dir, name + (encoding === "br" ? ".br" : ".gz")))
    ? `asset:${encoding}:${name}`
    : `asset:identity:${name}`;
};

const names = fs
  .readdirSync(dir, { recursive: true })
  .map((f) => f.split(path.sep).join("/"))
  .filter(
    (f) =>
      !f.split("/").some((part) => part.startsWith(".")) &&
      fs.statSync(path.join(dir, f)).isFile(),
  );

// What a client acts on. Header order and case, and the Content-* headers @fastify/static leaves
// on a 304, differ between the in-memory and the file-serving answers.
const ESSENTIAL = {
  200: [
    "content-type",
    "content-encoding",
    "content-length",
    "etag",
    "last-modified",
    "cache-control",
    "vary",
    "x-content-type-options",
  ],
  304: ["etag", "last-modified", "cache-control", "vary"],
};
const essentials = ({ status, headers, body }) => ({
  status,
  body,
  headers: Object.fromEntries(
    (ESSENTIAL[status] ?? []).map((name) => [name, headers[name]]),
  ),
});
test("every digested asset answers from memory like the file-serving chain does", async () => {
  assert.ok(names.length > 100);
  for (const name of names)
    for (const accept of [undefined, "br", "gzip"]) {
      const url = `/assets/${name}`;
      const ae = accept ? { "accept-encoding": accept } : {};
      await fetchRaw(fast, url, ae);
      await until(() => publicResponses.has(assetKey(name, accept)));
      const reference = await fetchRaw(slow, url, ae);
      const { etag, "last-modified": modified } = reference.headers;
      for (const extra of [
        {},
        { method: "HEAD" },
        { "if-none-match": etag },
        { "if-none-match": `"other", ${etag.replace(/^W\//, "")}` },
        { "if-none-match": etag, "cache-control": "no-cache" },
        { "if-modified-since": modified },
        { "if-none-match": '"other"', "if-modified-since": modified },
      ]) {
        const headers = { ...ae, ...extra };
        const [want, got] = await Promise.all([
          fetchRaw(slow, url, headers),
          fetchRaw(fast, url, headers),
        ]);
        assert.deepEqual(
          essentials(got),
          essentials(want),
          `${url} ${JSON.stringify(headers)}`,
        );
      }
    }
});

test("unknown, dotfile, traversal, Range and precondition requests keep the old chain", async () => {
  const css = names.find(
    (f) => f.endsWith(".css") && names.includes(f + ".br"),
  );
  await fetchRaw(fast, `/assets/${css}`, { "accept-encoding": "br" });
  await until(() => publicResponses.has(`asset:br:${css}`));
  for (const [url, headers] of [
    ["/assets/missing-0000.css", {}],
    ["/assets/.manifest.json", {}],
    [`/assets/..%2f${css}`, {}],
    [`/assets/%2e%2e/assets/${css}`, {}],
    ["/assets/sounds", {}],
    [`/assets/${css}`, { range: "bytes=0-9", "accept-encoding": "br" }],
    [`/assets/${css}`, { "if-match": '"x"', "accept-encoding": "br" }],
    [
      `/assets/${css}`,
      {
        "if-unmodified-since": "Thu, 01 Jan 1970 00:00:00 GMT",
        "accept-encoding": "br",
      },
    ],
    [`/assets/${css}`, { method: "POST", "accept-encoding": "br" }],
    [`/assets/${css}`, { "accept-encoding": "deflate" }],
    [`/ASSETS/${css}`, { "accept-encoding": "br" }],
  ]) {
    const [want, got] = await Promise.all([
      fetchRaw(slow, url, headers),
      fetchRaw(fast, url, headers),
    ]);
    assert.deepEqual(got, want, `${url} ${JSON.stringify(headers)}`);
  }
});

async function tinyAssets(sizes, budget) {
  const assets = fs.mkdtempSync(path.join(root, "assets-"));
  for (const [name, size] of Object.entries(sizes))
    fs.writeFileSync(path.join(assets, name), Buffer.alloc(size, 97));
  const cache = responseCache(budget);
  const served = cachedAssets(assets, cache);
  const server = await listenApp(
    (app) => {
      app.addHook("onRequest", (req, reply, done) => {
        if (served.hook(req, reply)) reply.hijack();
        done();
      });
      app.setNotFoundHandler((req, reply) => reply.code(404).send());
    },
    { finish: false },
  );
  servers.push(server);
  return {
    assets,
    cache,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

test("serves loaded assets from memory and evicts least recently used past the byte budget", async () => {
  const { assets, cache, base } = await tinyAssets(
    { "a-1.png": 3000, "b-2.png": 3000, "c-3.png": 3000 },
    8000,
  );
  const load = async (name) => {
    assert.equal((await fetchRaw(base, `/assets/${name}`)).status, 404);
    await until(() => cache.has(`asset:identity:${name}`));
  };
  await load("a-1.png");
  fs.rmSync(path.join(assets, "a-1.png"));
  const hit = await fetchRaw(base, "/assets/a-1.png");
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.body, Buffer.alloc(3000, 97));
  assert.equal(hit.headers["content-type"], "image/png");
  await load("b-2.png");
  await fetchRaw(base, "/assets/a-1.png");
  await load("c-3.png");
  assert.ok(cache.size <= 8000);
  assert.equal(cache.has("asset:identity:a-1.png"), true);
  assert.equal(cache.has("asset:identity:b-2.png"), false);
});

test("assets that could never be served from memory are not read", async () => {
  const { cache, base } = await tinyAssets(
    { "big-1.png": 5000, "app-2.js": 2000 },
    8000,
  );
  const { base: disabled } = await tinyAssets({ "a-1.png": 100 }, 0);
  const readFile = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = (...args) => (reads++, readFile(...args));
  try {
    for (let i = 0; i < 3; i++) {
      await fetchRaw(base, "/assets/big-1.png");
      await fetchRaw(base, "/assets/app-2.js", { "accept-encoding": "gzip" });
      await fetchRaw(disabled, "/assets/a-1.png");
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(reads, 0);
    assert.equal(cache.size, 0);
    await fetchRaw(base, "/assets/app-2.js");
    await until(() => cache.has("asset:identity:app-2.js"));
    assert.equal(reads, 1);
  } finally {
    fs.promises.readFile = readFile;
  }
});

test("/up skips the session cookie and still negotiates html or json", async () => {
  const html = await fetchRaw(fast, "/up");
  assert.equal(html.status, 200);
  assert.equal(html.headers["set-cookie"], undefined);
  assert.match(html.body.toString(), /background-color: green/);
  const json = await fetchRaw(fast, "/up.json", { accept: "application/json" });
  assert.deepEqual(JSON.parse(json.body), { status: "ok" });
  assert.equal(
    (await fetchRaw(fast, "/up", { "if-none-match": html.headers.etag }))
      .status,
    304,
  );
  // The paths "/up" matched behind the case-sensitive ".json"/".turbo_stream" stripping rewrite.
  for (const [url, status] of [
    ["/UP/", 200],
    ["/up/.json", 200],
    ["/Up.turbo_stream", 200],
    ["/up.json?x=1", 200],
    ["/up.json/", 404],
    ["/up.JSON", 404],
    ["/up.json.json", 404],
    // @fastify/static refuses the empty segment with 403 where Express answered 404.
    ["/up//", 403],
  ])
    assert.equal((await fetchRaw(fast, url)).status, status, url);
});

const image = (background) =>
  sharp({ create: { width: 64, height: 64, channels: 3, background } })
    .png()
    .toBuffer();
const upload = async (background) => ({
  buffer: await image(background),
  originalname: "face.png",
  mimetype: "image/png",
});

test("avatars match on miss and hit and change as soon as the user or attachment does", async () => {
  const at = now();
  run(
    "INSERT INTO users(id,name,role,status,created_at,updated_at) VALUES(5,'Ada Lovelace',0,0,?,?),(6,'Robo',2,0,?,?)",
    at,
    at,
    at,
    at,
  );
  const url = (id) => avatar(id, at);
  const compare = async (id, headers = {}) => {
    publicResponses.clear();
    const first = await fetchRaw(fast, url(id), headers);
    const second = await fetchRaw(fast, url(id), headers);
    assert.deepEqual(second, first);
    return first;
  };

  const initials = await compare(5);
  assert.match(
    initials.headers["content-type"],
    /^image\/svg\+xml; charset=utf-8/,
  );
  assert.match(initials.body.toString(), />\s*AL\s*</);
  const bot = await compare(6);
  assert.equal(bot.headers["content-type"], "image/svg+xml");

  replaceAttachment(await upload("#ff0000"), "User", 5, "avatar");
  const red = await compare(5);
  assert.equal(red.headers["content-type"], "image/webp");
  assert.notEqual(red.headers.etag, initials.headers.etag);
  for (const headers of [
    { method: "HEAD" },
    { range: "bytes=0-9" },
    { range: "bytes=-5" },
    { range: "bytes=99999-" },
    { "if-none-match": red.headers.etag },
  ])
    await compare(5, headers);

  replaceAttachment(await upload("#0000ff"), "User", 5, "avatar");
  const blue = await fetchRaw(fast, url(5));
  assert.notEqual(blue.headers.etag, red.headers.etag);
  assert.notDeepEqual(blue.body, red.body);
  const { data } = await sharp(blue.body)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.ok(data[2] > 200 && data[0] < 50, "serves the new image");

  removeAttachment("User", 5, "avatar");
  assert.deepEqual((await fetchRaw(fast, url(5))).body, initials.body);
  run("UPDATE users SET name='Grace Hopper' WHERE id=5");
  assert.match((await fetchRaw(fast, url(5))).body.toString(), />\s*GH\s*</);
});
