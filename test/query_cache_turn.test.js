import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, getCached, validateQueryCacheForTurn } from "../src/db.js";
import { openDatabase } from "../src/sqlite.js";

test("data_version is validated once per turn and re-armed after it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "campfire-qcache-turn-"));
  const path = join(dir, "q.sqlite3");
  initialize(path);
  const foreign = openDatabase(path);
  foreign.exec("PRAGMA busy_timeout=10000");
  try {
    const sql = "SELECT COUNT(*) AS n FROM users";
    validateQueryCacheForTurn();
    assert.equal(getCached(sql).n, 0);
    foreign
      .prepare(
        "INSERT INTO users(name,created_at,updated_at) VALUES('F','2026-01-01','2026-01-01')",
      )
      .run();
    assert.equal(getCached(sql).n, 0);
    await Promise.resolve();
    validateQueryCacheForTurn();
    assert.equal(getCached(sql).n, 1);
  } finally {
    foreign.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid query cache limits cannot prevent a cache miss from returning", () => {
  const previous = process.env.CAMPFIRE_QUERY_CACHE_ENTRIES;
  try {
    for (const limit of ["-1", "0", "NaN", "Infinity", "0.5"]) {
      process.env.CAMPFIRE_QUERY_CACHE_ENTRIES = limit;
      assert.equal(getCached("SELECT ? AS n", limit).n, limit);
    }
  } finally {
    if (previous === undefined) delete process.env.CAMPFIRE_QUERY_CACHE_ENTRIES;
    else process.env.CAMPFIRE_QUERY_CACHE_ENTRIES = previous;
  }
});
