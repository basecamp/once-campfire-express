import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, transaction, onCommit, get, run } from "../src/db.js";
import { openDatabase, backupDatabase } from "../src/sqlite.js";
initialize(":memory:");
test("Nested post-commit work runs only after durable outer commit and disappears on rollback", () => {
  const observed = [];
  assert.throws(() =>
    transaction(() => {
      run(
        "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
        "Rolled back",
        "abc",
        "2026-01-01",
        "2026-01-01",
      );
      transaction(() => onCommit(() => observed.push("must not run")));
      throw new Error("rollback");
    }),
  );
  assert.deepEqual(observed, []);
  assert.equal(get("SELECT id FROM accounts"), undefined);
  transaction(() => {
    run(
      "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
      "Committed",
      "abc",
      "2026-01-01",
      "2026-01-01",
    );
    transaction(() =>
      onCommit(() => observed.push(get("SELECT name FROM accounts").name)),
    );
    assert.deepEqual(observed, []);
  });
  assert.deepEqual(observed, ["Committed"]);
});
test("Integers read back as numbers; values beyond 2^53 throw on Node and round on Bun", () => {
  run("CREATE TABLE IF NOT EXISTS big(v INTEGER)");
  run("INSERT INTO big VALUES(?)", 2 ** 53 - 1);
  assert.equal(get("SELECT v FROM big").v, 2 ** 53 - 1);
  run("DELETE FROM big");
  run("INSERT INTO big VALUES(?)", 9007199254740993n);
  if (globalThis.Bun)
    // safeIntegers:false trades exactness above 2^53 for the native number fast path.
    assert.equal(get("SELECT v FROM big").v, 9007199254740992);
  else
    assert.throws(() => get("SELECT v FROM big"), { code: "ERR_OUT_OF_RANGE" });
  run("DROP TABLE big");
});
test("SQLite adapter opens read-only databases and writes consistent backups", () => {
  const dir = mkdtempSync(join(tmpdir(), "campfire-sqlite-"));
  try {
    const source = openDatabase(join(dir, "source.sqlite3"));
    source.exec("CREATE TABLE t(v TEXT); INSERT INTO t VALUES('kept');");
    assert.deepEqual(
      { ...source.prepare("INSERT INTO t VALUES(?)").run("second") },
      { changes: 1, lastInsertRowid: 2 },
    );
    backupDatabase(source, join(dir, "copy.sqlite3"));
    source.close();
    const copy = openDatabase(join(dir, "copy.sqlite3"), { readOnly: true });
    try {
      assert.deepEqual(
        copy
          .prepare("SELECT v FROM t ORDER BY rowid")
          .all()
          .map((r) => r.v),
        ["kept", "second"],
      );
      assert.throws(() => copy.exec("INSERT INTO t VALUES('x')"));
    } finally {
      copy.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("statements are prepared once and the cache stays bounded", async () => {
  const { all, get, statementCacheSize } = await import("../src/db.js");
  const before = statementCacheSize();
  get("SELECT 1 AS x");
  get("SELECT 1 AS x");
  assert.equal(statementCacheSize(), before + 1);
  for (let n = 1; n <= 600; n++)
    all(
      `SELECT value FROM json_each(?) WHERE value IN (${Array(n).fill("?").join(",")})`,
      "[1]",
      ...Array(n).fill(1),
    );
  assert.ok(statementCacheSize() <= 512);
});
test("connection uses Rails 8 SQLite pragmas", async () => {
  const { applyDurabilityPragmas } = await import("../src/db.js");
  const dir = mkdtempSync(join(tmpdir(), "campfire-pragmas-"));
  const file = openDatabase(join(dir, "p.sqlite3"));
  try {
    applyDurabilityPragmas(file);
    const read = (name) => file.prepare(`PRAGMA ${name}`).get()[name];
    assert.equal(read("journal_mode"), "wal");
    assert.equal(read("synchronous"), 1);
    assert.equal(read("journal_size_limit"), 67108864);
    assert.equal(read("cache_size"), 2000);
  } finally {
    file.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(get("PRAGMA synchronous").synchronous, 1);
});
test("getCached equals get, counts hits and returns copies", async () => {
  const { getCached, clearQueryCache, queryCacheStats } =
    await import("../src/db.js");
  clearQueryCache();
  const sql = "SELECT * FROM accounts ORDER BY id LIMIT 1";
  const first = getCached(sql);
  // node:sqlite rows have a null prototype; the cache hands out plain copies.
  assert.deepEqual(first, { ...get(sql) });
  const before = queryCacheStats();
  const second = getCached(sql);
  assert.equal(queryCacheStats().hits, before.hits + 1);
  first.name = "mutated";
  second.name = "mutated";
  assert.notEqual(getCached(sql).name, "mutated");
});
test("allCached returns copies of every row", async () => {
  const { allCached, clearQueryCache } = await import("../src/db.js");
  clearQueryCache();
  const sql = "SELECT * FROM accounts ORDER BY id";
  allCached(sql)[0].name = "mutated";
  assert.notEqual(allCached(sql)[0].name, "mutated");
});
test("query cache evicts the least recently used entry", async () => {
  const { getCached, clearQueryCache, queryCacheStats } =
    await import("../src/db.js");
  clearQueryCache();
  process.env.CAMPFIRE_QUERY_CACHE_ENTRIES = "2";
  try {
    getCached("SELECT 1 AS a");
    getCached("SELECT 2 AS a");
    getCached("SELECT 1 AS a");
    getCached("SELECT 3 AS a");
    assert.equal(queryCacheStats().size, 2);
    const { hits } = queryCacheStats();
    getCached("SELECT 1 AS a");
    assert.equal(queryCacheStats().hits, hits + 1);
    getCached("SELECT 2 AS a");
    assert.equal(queryCacheStats().hits, hits + 1);
  } finally {
    delete process.env.CAMPFIRE_QUERY_CACHE_ENTRIES;
  }
});
test("own writes invalidate cached reads", async () => {
  const { getCached } = await import("../src/db.js");
  const sql = "SELECT name FROM accounts ORDER BY id LIMIT 1";
  const original = getCached(sql).name;
  run(
    "UPDATE accounts SET name=? WHERE id=(SELECT MIN(id) FROM accounts)",
    "Renamed",
  );
  assert.equal(getCached(sql).name, "Renamed");
  assert.throws(() =>
    transaction(() => {
      run(
        "UPDATE accounts SET name=? WHERE id=(SELECT MIN(id) FROM accounts)",
        "Inside",
      );
      assert.equal(getCached(sql).name, "Inside");
      throw new Error("rollback");
    }),
  );
  assert.equal(getCached(sql).name, "Renamed");
  run(
    "UPDATE accounts SET name=? WHERE id=(SELECT MIN(id) FROM accounts)",
    original,
  );
});
test("negative results are cached and invalidated by inserts", async () => {
  const { getCached, queryCacheStats } = await import("../src/db.js");
  const sql = "SELECT id FROM users WHERE name=?";
  assert.equal(getCached(sql, "Nobody"), undefined);
  const { hits } = queryCacheStats();
  assert.equal(getCached(sql, "Nobody"), undefined);
  assert.equal(queryCacheStats().hits, hits + 1);
  run(
    "INSERT INTO users(name,created_at,updated_at) VALUES(?,?,?)",
    "Nobody",
    "2026-01-01",
    "2026-01-01",
  );
  assert.ok(getCached(sql, "Nobody"));
  run("DELETE FROM users WHERE name=?", "Nobody");
});
test("background checkpoints keep the WAL bounded without autocheckpoint", async () => {
  const { checkpoint, walBytes, startCheckpointer } =
    await import("../src/checkpoint.js");
  const {
    applyDurabilityPragmas,
    deferCheckpoints,
    BACKSTOP_AUTOCHECKPOINT_PAGES,
  } = await import("../src/db.js");
  const dir = mkdtempSync(join(tmpdir(), "campfire-wal-"));
  const path = join(dir, "w.sqlite3");
  const writer = openDatabase(path);
  const checkpointer = startCheckpointer(path, {
    interval: 3600000,
    limit: 256 * 1024,
  });
  try {
    applyDurabilityPragmas(writer);
    writer.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x)");
    const insert = writer.prepare("INSERT INTO t VALUES(?)");
    const burst = () => {
      for (let i = 0; i < 200; i++) insert.run("x".repeat(4000));
    };
    burst();
    burst();
    assert.ok(walBytes(path) > 256 * 1024);
    const truncated = await checkpointer.checkpoint();
    assert.equal(truncated.mode, "TRUNCATE");
    assert.equal(truncated.busy, 0);
    assert.equal(walBytes(path), 0);
    burst();
    const single = walBytes(path);
    await checkpointer.checkpoint();
    let largest = 0;
    for (let round = 0; round < 10; round++) {
      burst();
      largest = Math.max(largest, walBytes(path));
      const result = await checkpointer.checkpoint();
      assert.equal(result.busy, 0);
    }
    // Without checkpoints ten bursts would leave the WAL ~10x one burst.
    assert.ok(
      largest <= single * 1.25,
      `WAL grew to ${largest} (one burst ${single})`,
    );
    assert.equal(checkpoint(writer, path, 0).busy, 0);
    deferCheckpoints(writer);
    assert.equal(
      writer.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint,
      BACKSTOP_AUTOCHECKPOINT_PAGES,
    );
  } finally {
    await checkpointer.stop();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("WEB_WORKERS parses auto, numbers and rejects invalid values", async () => {
  const { parseWebWorkers } = await import("../src/workers.js");
  assert.equal(parseWebWorkers(undefined, 4), 4);
  assert.equal(parseWebWorkers("auto", 4), 4);
  assert.equal(parseWebWorkers("auto", 0), 1);
  assert.equal(parseWebWorkers("auto", 200), 64);
  assert.equal(parseWebWorkers("2", 4), 2);
  for (const bad of ["0", "65", "1.5", "abc", "-1"])
    assert.throws(() => parseWebWorkers(bad, 4), /WEB_WORKERS/, bad);
});

test("WAL stays bounded with autocheckpoint disabled and the checkpoint thread running", async () => {
  const { startCheckpointer, walBytes } = await import("../src/checkpoint.js");
  const { applyDurabilityPragmas, deferCheckpoints } =
    await import("../src/db.js");
  const dir = mkdtempSync(join(tmpdir(), "campfire-wal-bound-"));
  const path = join(dir, "bound.sqlite3");
  const writer = openDatabase(path);
  applyDurabilityPragmas(writer);
  writer.exec("PRAGMA busy_timeout=10000");
  deferCheckpoints(writer, 0);
  writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)");
  assert.equal(
    writer.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint,
    0,
  );
  const checkpointer = startCheckpointer(path, {
    interval: 20,
    limit: 256 * 1024,
    maxLimit: 1024 * 1024,
  });
  try {
    const body = "x".repeat(2000);
    let largest = 0;
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 50; i++)
        writer.prepare("INSERT INTO t (body) VALUES (?)").run(body);
      largest = Math.max(largest, walBytes(path));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    // 2000 rows of 2 KB written would be ~4 MB of WAL uncheckpointed.
    assert.ok(largest < 3 * 1024 * 1024, `WAL reached ${largest}`);
    assert.equal(writer.prepare("SELECT COUNT(*) n FROM t").get().n, 2000);
  } finally {
    await checkpointer.stop();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
