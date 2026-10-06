import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-jobs-"));
process.env.DATABASE_PATH = path.join(root, "db.sqlite3");
process.env.JOBS_DATABASE_PATH = path.join(root, "jobs.sqlite3");
process.env.CAMPFIRE_STORAGE_PATH = root;
process.env.SECRET_KEY_BASE = "j".repeat(128);
const { initialize, get, run, now } = await import("../src/db.js");
initialize();
const jobs = await import("../src/jobs.js");
const domain = await import("../src/domain.js");

const rows = () =>
  jobs.jobsDb().prepare("SELECT * FROM jobs ORDER BY id").all();
const reset = () => jobs.jobsDb().exec("DELETE FROM jobs");
function insertUser(name, role = 0) {
  const time = now();
  return Number(
    run(
      "INSERT INTO users(name,email_address,password_digest,role,bot_token,status,created_at,updated_at) VALUES(?,?,'',?,?,0,?,?)",
      name,
      role === 2 ? null : `${name.toLowerCase()}@example.com`,
      role,
      role === 2 ? `${name}-token` : null,
      time,
      time,
    ).lastInsertRowid,
  );
}
function directRoom(userIds) {
  const time = now();
  const id = Number(
    run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(NULL,'Rooms::Direct',?,?,?)",
      userIds[0],
      time,
      time,
    ).lastInsertRowid,
  );
  domain.grantMemberships({ id, type: "Rooms::Direct" }, userIds);
  return id;
}
function addWebhook(userId, url) {
  const time = now();
  return Number(
    run(
      "INSERT INTO webhooks(user_id,url,created_at,updated_at) VALUES(?,?,?,?)",
      userId,
      url,
      time,
      time,
    ).lastInsertRowid,
  );
}

test("jobs database uses the main database durability pragmas", () => {
  const read = (name) =>
    jobs.jobsDb().prepare(`PRAGMA ${name}`).get()[
      name === "busy_timeout" ? "timeout" : name
    ];
  assert.equal(read("journal_mode"), "wal");
  assert.equal(read("synchronous"), 1);
  assert.equal(read("journal_size_limit"), 67108864);
  assert.equal(read("cache_size"), 2000);
  assert.equal(read("busy_timeout"), 10000);
});

test("enqueueMany commits a batch atomically", () => {
  reset();
  const ids = jobs.enqueueMany([
    { kind: "purge", data: { blob_id: 1 } },
    { kind: "purge", data: { blob_id: 2 } },
  ]);
  assert.equal(ids.length, 2);
  assert.deepEqual(
    rows().map((r) => r.id),
    ids,
  );
  assert.throws(() =>
    jobs.enqueueMany([
      { kind: "purge", data: { blob_id: 3 } },
      { kind: "purge", data: { blob_id: 10n } },
    ]),
  );
  assert.equal(rows().length, 2);
  assert.equal(typeof jobs.enqueue("purge", { blob_id: 4 }), "number");
  assert.equal(rows().length, 3);
});

test("enqueueSoon coalesces batches until flushed", async () => {
  reset();
  jobs.enqueueSoon([{ kind: "purge", data: { blob_id: 1 } }]);
  jobs.enqueueSoon([{ kind: "purge", data: { blob_id: 2 } }]);
  assert.equal(rows().length, 0);
  assert.equal(jobs.flushJobs(), 2);
  assert.equal(rows().length, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.flushJobs(), 0);
  jobs.enqueueSoon([{ kind: "purge", data: { blob_id: 3 } }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows().length, 3);
});

test("failed enqueue is logged with its payloads", () => {
  reset();
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    jobs.enqueueSoon([{ kind: "push", data: { user_id: 10n } }]);
    assert.equal(jobs.flushJobs(), 0);
  } finally {
    console.error = original;
  }
  assert.match(logged.join("\n"), /enqueue of 1 jobs failed/);
  assert.equal(rows().length, 0);
});

test("notifyMessage writes every job for a message in one batch", () => {
  reset();
  const author = insertUser("Author"),
    reader = insertUser("Reader"),
    bot = insertUser("Robot", 2);
  const room = directRoom([author, reader, bot]);
  addWebhook(bot, "http://127.0.0.1:9/a");
  addWebhook(bot, "http://127.0.0.1:9/b");
  const message = domain.createMessage(room, author, "Hello");
  domain.notifyMessage(message);
  assert.equal(rows().length, 0);
  assert.equal(jobs.flushJobs(), 4);
  const written = rows();
  assert.deepEqual(written.map((r) => JSON.parse(r.payload).kind).sort(), [
    "push",
    "push",
    "webhook",
    "webhook",
  ]);
  assert.equal(new Set(written.map((r) => r.available_at)).size, 1);
});

test("afterResponse runs work only after the response is finished", async () => {
  const seen = [];
  let received;
  const abortedRequest = new Promise((resolve) => (received = resolve));
  const server = http.createServer((req, res) => {
    if (req.url === "/abort") {
      jobs.afterResponse(res, () => seen.push("aborted"));
      received();
      return;
    }
    res.end("response body");
    jobs.afterResponse(res, () => seen.push(res.writableFinished));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await (await fetch(base)).text(), "response body");
    const controller = new AbortController();
    const pending = fetch(`${base}/abort`, { signal: controller.signal });
    await abortedRequest;
    controller.abort();
    await assert.rejects(pending);
    await jobs.settleJobHandoffs();
    assert.deepEqual(seen.sort(), [true, "aborted"].sort());
  } finally {
    server.close();
  }
});

test("drainQueue processes every ready job in one pass", async () => {
  reset();
  jobs.enqueueMany(
    Array.from({ length: 12 }, (_, i) => ({
      kind: "purge",
      data: { blob_id: 100000 + i },
    })),
  );
  await jobs.drainQueue();
  assert.equal(rows().length, 0);
  assert.equal(jobs.activeJobs(), 0);
});

test("drainQueue leaves failed jobs backed off with retry state", async () => {
  reset();
  const original = console.error;
  console.error = () => {};
  try {
    const author = insertUser("Failing"),
      peer = insertUser("Peer");
    const message = domain.createMessage(
      directRoom([author, peer]),
      author,
      "x",
    );
    jobs.enqueue("unknown", { message_id: message.id });
    await jobs.drainQueue();
  } finally {
    console.error = original;
  }
  const [job] = rows();
  assert.equal(job.status, "ready");
  assert.equal(job.attempts, 1);
  assert.equal(job.lease_token, null);
  assert.ok(job.available_at > Date.now() / 1000);
  assert.match(job.last_error, /unknown job/);
});

test("job runner respects JOB_CONCURRENCY", async () => {
  reset();
  assert.equal(jobs.jobConcurrency(), 3);
  process.env.JOB_CONCURRENCY = "2";
  let inFlight = 0,
    maxInFlight = 0,
    received = 0,
    released = false;
  const held = [];
  let reachedLimit;
  const limitReached = new Promise((resolve) => (reachedLimit = resolve));
  const server = http.createServer(async (req, res) => {
    for await (const _ of req);
    inFlight++;
    received++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const respond = () => {
      inFlight--;
      res.writeHead(204);
      res.end();
    };
    if (released) return respond();
    held.push(respond);
    if (held.length === 2) reachedLimit();
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const author = insertUser("Sender"),
      bot = insertUser("Worker", 2);
    const room = directRoom([author, bot]);
    const hook = addWebhook(bot, `http://127.0.0.1:${server.address().port}`);
    const message = domain.createMessage(room, author, "ping");
    jobs.enqueueMany(
      Array.from({ length: 5 }, () => ({
        kind: "webhook",
        data: { webhook_id: hook, message_id: message.id },
      })),
    );
    const drained = jobs.drainQueue();
    await limitReached;
    assert.equal(jobs.activeJobs(), 2);
    assert.equal(rows().filter((r) => r.lease_token).length, 2);
    released = true;
    for (const respond of held.splice(0)) respond();
    await drained;
    assert.equal(received, 5);
    assert.equal(maxInFlight, 2);
    assert.equal(rows().length, 0);
  } finally {
    delete process.env.JOB_CONCURRENCY;
    server.close();
  }
});

test("cluster workers hand job batches to the primary over IPC", () => {
  const jobsFile = path.join(root, "ipc-jobs.sqlite3");
  const script = path.join(root, "ipc.mjs");
  fs.writeFileSync(
    script,
    `import cluster from "node:cluster";
const jobs = await import(${JSON.stringify(new URL("../src/jobs.js", import.meta.url).href)});
if (cluster.isPrimary) {
  for (let i = 0; i < 2; i++) cluster.fork();
  cluster.on("message", (worker, event) => jobs.acceptJobsMessage(event));
  let exited = 0;
  cluster.on("exit", () => {
    if (++exited < 2) return;
    jobs.flushJobs();
    console.log(JSON.stringify({ n: jobs.jobsDb().prepare("SELECT count(*) AS n FROM jobs").get().n }));
    process.exit(0);
  });
} else {
  for (let i = 0; i < 5; i++)
    jobs.submitJobs([{ kind: "purge", data: { blob_id: i } }, { kind: "purge", data: { blob_id: 100 + i } }]);
  await jobs.settleJobHandoffs();
  process.disconnect();
}
`,
  );
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, JOBS_DATABASE_PATH: jobsFile },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), {
    n: 20,
  });
});
