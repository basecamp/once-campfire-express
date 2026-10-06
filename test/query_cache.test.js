import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, getCached, allCached } from "../src/db.js";
import { openDatabase } from "../src/sqlite.js";

test("commits from another connection invalidate cached reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "campfire-qcache-"));
  const path = join(dir, "q.sqlite3");
  initialize(path);
  const foreign = openDatabase(path);
  foreign.exec("PRAGMA busy_timeout=10000");
  try {
    const sql = "SELECT COUNT(*) AS n FROM users";
    assert.equal(getCached(sql).n, 0);
    assert.equal(allCached("SELECT * FROM users").length, 0);
    foreign
      .prepare(
        "INSERT INTO users(name,created_at,updated_at) VALUES('Foreign','2026-01-01','2026-01-01')",
      )
      .run();
    assert.equal(getCached(sql).n, 1);
    assert.equal(allCached("SELECT * FROM users").length, 1);
  } finally {
    foreign.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
