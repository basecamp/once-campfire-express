import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "campfire-avatar-cache-"));
process.env.DATABASE_PATH = path.join(root, "db.sqlite3");
process.env.CAMPFIRE_STORAGE_PATH = root;
process.env.SECRET_KEY_BASE = "avatar-cache-tests";
const { createServer: createAppServer } = await import("../src/app.js");
const { run, now } = await import("../src/db.js");
const { openDatabase } = await import("../src/sqlite.js");
const { avatar } = await import("../src/rendering.js");
const { publicResponses } = await import("../src/static_responses.js");

let server, base, foreign;
before(async () => {
  server = await createAppServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  foreign = openDatabase(process.env.DATABASE_PATH);
  foreign.exec("PRAGMA busy_timeout=10000");
});
after(() => {
  foreign.close();
  server.closeAllConnections();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const fetchAvatar = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    request(base + url, { headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    })
      .on("error", reject)
      .end();
  });

const botSvg = fs.readFileSync(
  "reference/app/assets/images/default-bot-avatar.svg",
  "utf8",
);

test("a foreign role change switches between the initials and bot avatars without touching updated_at", async () => {
  const at = now();
  run(
    "INSERT INTO users(id,name,role,status,created_at,updated_at) VALUES(9,'Ada Lovelace',0,0,?,?)",
    at,
    at,
  );
  const url = avatar(9, at);
  publicResponses.clear();
  const initials = await fetchAvatar(url);
  assert.equal(initials.status, 200);
  assert.match(initials.body, />\s*AL\s*</);
  assert.equal(
    (await fetchAvatar(url, { "if-none-match": initials.headers.etag })).status,
    304,
  );

  foreign.prepare("UPDATE users SET role=2 WHERE id=9").run();
  const bot = await fetchAvatar(url);
  assert.equal(bot.status, 200);
  assert.equal(bot.body, botSvg);
  assert.equal(bot.headers["content-type"], "image/svg+xml");
  assert.notEqual(bot.headers.etag, initials.headers.etag);
  const revalidated = await fetchAvatar(url, {
    "if-none-match": initials.headers.etag,
  });
  assert.equal(revalidated.status, 200, "the old initials ETag is not fresh");
  assert.equal(revalidated.body, botSvg);

  foreign.prepare("UPDATE users SET role=0 WHERE id=9").run();
  const back = await fetchAvatar(url);
  assert.equal(back.body, initials.body);
  assert.equal(back.headers.etag, initials.headers.etag);
});

test("a foreign rename without touching updated_at serves the new initials", async () => {
  const at = now();
  run(
    "INSERT INTO users(id,name,role,status,created_at,updated_at) VALUES(10,'Grace Hopper',0,0,?,?)",
    at,
    at,
  );
  const url = avatar(10, at);
  const before = await fetchAvatar(url);
  assert.match(before.body, />\s*GH\s*</);
  foreign.prepare("UPDATE users SET name='Alan Turing' WHERE id=10").run();
  const after = await fetchAvatar(url, {
    "if-none-match": before.headers.etag,
  });
  assert.equal(after.status, 200);
  assert.match(after.body, />\s*AT\s*</);
});
