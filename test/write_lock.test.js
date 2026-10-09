import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  initialize,
  db,
  transaction,
  run,
  get,
  beginImmediate,
  BUSY_TIMEOUT_MS,
} from "../src/db.js";

const dir = mkdtempSync(join(tmpdir(), "campfire-lock-"));
const file = join(dir, "db.sqlite3");
initialize(file);
run("CREATE TABLE contention(writer TEXT, n INTEGER)");
const busyTimeout = () => db().prepare("PRAGMA busy_timeout").get().timeout;

function holdWriteLock(ms) {
  const worker = new Worker(
    `const { DatabaseSync } = require("node:sqlite");
const { parentPort, workerData } = require("node:worker_threads");
const db = new DatabaseSync(workerData.file);
db.exec("BEGIN IMMEDIATE");
parentPort.postMessage("locked");
setTimeout(() => { db.exec("COMMIT"); db.close(); parentPort.postMessage("released"); }, workerData.ms);`,
    { eval: true, workerData: { file, ms } },
  );
  const message = (expected) =>
    new Promise((resolve, reject) => {
      worker.on("message", (m) => m === expected && resolve());
      worker.once("error", reject);
    });
  return { locked: message("locked"), released: message("released"), worker };
}

test("a busy write lock is retried until free, then busy_timeout is restored", async () => {
  const holder = holdWriteLock(60);
  await holder.locked;
  const started = Date.now();
  transaction(() => run("INSERT INTO contention VALUES('main', 0)"));
  assert.ok(Date.now() - started >= 40, "waited for the other connection");
  assert.equal(busyTimeout(), BUSY_TIMEOUT_MS);
  await holder.released;
  await holder.worker.terminate();
});

test("autocommit writes also wait for a busy lock, then restore busy_timeout", async () => {
  const holder = holdWriteLock(60);
  await holder.locked;
  const started = Date.now();
  run("INSERT INTO contention VALUES('autocommit', 0)");
  assert.ok(Date.now() - started >= 40, "waited for the other connection");
  assert.equal(busyTimeout(), BUSY_TIMEOUT_MS);
  assert.equal(
    get("SELECT count(*) AS n FROM contention WHERE writer='autocommit'").n,
    1,
  );
  await holder.released;
  await holder.worker.terminate();
});

test("the lock wait still gives up with SQLITE_BUSY at its deadline", async () => {
  const holder = holdWriteLock(400);
  await holder.locked;
  const started = Date.now();
  assert.throws(() => beginImmediate(db(), 50), { errcode: 5 });
  const waited = Date.now() - started;
  assert.ok(waited >= 50 && waited < 350, `waited ${waited}ms`);
  assert.equal(busyTimeout(), BUSY_TIMEOUT_MS);
  await holder.released;
  await holder.worker.terminate();
  transaction(() => run("INSERT INTO contention VALUES('after', 0)"));
});

test("errors other than SQLITE_BUSY are not retried", () => {
  db().exec("BEGIN");
  try {
    assert.throws(() => beginImmediate(), /within a transaction/);
    assert.equal(busyTimeout(), BUSY_TIMEOUT_MS);
  } finally {
    db().exec("ROLLBACK");
  }
});

function spawnWriter(workerData) {
  const script = join(dir, "writer.mjs");
  writeFileSync(
    script,
    `import { workerData, parentPort } from "node:worker_threads";
const { initialize, transaction, run } = await import(workerData.db);
initialize(workerData.file);
parentPort.postMessage("ready");
await new Promise((resolve) => parentPort.once("message", resolve));
const until = Date.now() + (workerData.ms || 0);
const pause = new Int32Array(new SharedArrayBuffer(4));
const stop = new Int32Array(workerData.stop || new SharedArrayBuffer(4));
for (let n = 0; n < workerData.rounds || (Date.now() < until && !stop[0]); n++) {
  transaction(() => {
    run("INSERT INTO contention VALUES('worker', ?)", n);
    run("UPDATE contention SET n=n WHERE writer='main'");
    if (workerData.holdMs) Atomics.wait(pause, 0, 0, workerData.holdMs);
  });
  if (n === 0) parentPort.postMessage("running");
}
parentPort.postMessage("done");`,
  );
  const worker = new Worker(script, {
    workerData: {
      file,
      db: new URL("../src/db.js", import.meta.url).href,
      ...workerData,
    },
  });
  const next = () =>
    new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  return {
    worker,
    // Resolves once the writer loop runs; the returned promise settles when it ends.
    async start() {
      await next();
      const running = next();
      worker.postMessage("go");
      await running;
      return { done: next() };
    },
  };
}

// SQLite's busy handler backs off up to 100 ms, so an autocommit writer using it loses nearly
// every race against transactions that retry every millisecond.
test("autocommit writes are not starved by back-to-back transactions", async () => {
  run("DELETE FROM contention");
  const stop = new SharedArrayBuffer(4);
  const { worker, start } = spawnWriter({
    rounds: 0,
    ms: 5000,
    holdMs: 0.3,
    stop,
  });
  const { done } = await start();
  const started = Date.now();
  for (let n = 0; n < 20; n++)
    run("INSERT INTO contention VALUES('autocommit', ?)", n);
  const elapsed = Date.now() - started;
  Atomics.store(new Int32Array(stop), 0, 1);
  await done;
  await worker.terminate();
  assert.ok(elapsed < 4000, `20 autocommit writes took ${elapsed}ms`);
});

test("writers on two threads interleave every transaction without errors", async () => {
  run("DELETE FROM contention");
  const rounds = 300;
  const { worker, start } = spawnWriter({ rounds });
  const { done } = await start();
  for (let n = 0; n < rounds; n++)
    transaction(() => {
      run("INSERT INTO contention VALUES('main', ?)", n);
      run("UPDATE contention SET n=n WHERE writer='worker'");
    });
  await done;
  await worker.terminate();
  const counts = Object.fromEntries(
    db()
      .prepare(
        "SELECT writer,count(*) AS n FROM contention GROUP BY writer ORDER BY writer",
      )
      .all()
      .map((r) => [r.writer, r.n]),
  );
  assert.deepEqual(counts, { main: rounds, worker: rounds });
  assert.equal(get("PRAGMA busy_timeout").timeout, BUSY_TIMEOUT_MS);
});
