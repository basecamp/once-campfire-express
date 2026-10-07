import { openDatabase } from "./sqlite.js";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
let connection,
  depth = 0;
export const BUSY_TIMEOUT_MS = 10000;
const callbacks = [];
export function onCommit(fn) {
  if (depth) callbacks.at(-1).push(fn);
  else fn();
}
export function initialize(
  path = process.env.DATABASE_PATH ||
    join(
      process.env.CAMPFIRE_STORAGE_PATH ||
        process.env.STORAGE_PATH ||
        "storage",
      "db/production.sqlite3",
    ),
) {
  if (connection) return connection;
  statements.clear();
  queryCache.clear();
  seenDataVersion = undefined;
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  connection = openDatabase(path);
  connection.exec(
    `PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys=ON;`,
  );
  if (
    !connection
      .prepare("SELECT name FROM sqlite_master WHERE name='users'")
      .get()
  ) {
    connection.exec(
      readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
    );
  }
  validateSchema(connection);
  applyDurabilityPragmas(connection);
  return connection;
}
// Rails 8's SQLite adapter defaults; mmap stays off because every reader would remap after each commit.
export function applyDurabilityPragmas(target) {
  target.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=67108864; PRAGMA cache_size=2000;",
  );
}
// 16384 pages (64 MB at 4 KB pages) is a backstop so the WAL stays bounded if the background checkpointer stalls.
export const BACKSTOP_AUTOCHECKPOINT_PAGES = 16384;
export function deferCheckpoints(
  target = db(),
  pages = BACKSTOP_AUTOCHECKPOINT_PAGES,
) {
  target.exec(`PRAGMA wal_autocheckpoint=${pages}`);
}
export const databaseFile = () => connection && connection.location();
export function db() {
  return connection || initialize();
}
const statements = new Map();
const STATEMENT_LIMIT = 512;
function statement(sql) {
  let prepared = statements.get(sql);
  if (!prepared) {
    // Dynamic IN-lists create many distinct SQL strings; dropping the oldest keeps memory bounded.
    if (statements.size >= STATEMENT_LIMIT)
      statements.delete(statements.keys().next().value);
    prepared = db().prepare(sql);
    statements.set(sql, prepared);
  }
  return prepared;
}
export const statementCacheSize = () => statements.size;
// Counts statements actually executed against SQLite; query-cache hits do not count.
let executed = 0;
export const queryCount = () => executed;
export const all = (sql, ...params) => {
  executed++;
  return statement(sql).all(...params);
};
export const get = (sql, ...params) => {
  executed++;
  return statement(sql).get(...params);
};
// Counts this connection's own writes: PRAGMA data_version only moves for other connections' commits.
let writes = 0;
export const writeEpoch = () => writes;
export function run(sql, ...params) {
  executed++;
  writes++;
  clearQueryCache();
  const prepared = statement(sql);
  if (depth) return prepared.run(...params);
  // An autocommit statement that fails with SQLITE_BUSY changed nothing, so it is safe to retry.
  return pollWriteLock(db(), BUSY_TIMEOUT_MS, () => prepared.run(...params));
}

const queryCache = new Map();
let hits = 0,
  misses = 0,
  seenDataVersion;
export const clearQueryCache = () => queryCache.clear();
export const queryCacheStats = () => ({
  size: queryCache.size,
  hits,
  misses,
});
// data_version changes only when ANOTHER connection commits (cluster workers, other processes), so own writes clear explicitly.
function validateQueryCache() {
  const { data_version } = statement("PRAGMA data_version").get();
  if (data_version !== seenDataVersion) {
    queryCache.clear();
    seenDataVersion = data_version;
  }
}
let validatedThisTurn = false;
// Called once per request: later cached reads in the same synchronous turn skip the PRAGMA, but any await boundary re-arms validation so a foreign commit is seen.
export function validateQueryCacheForTurn() {
  validateQueryCache();
  if (validatedThisTurn) return;
  validatedThisTurn = true;
  queueMicrotask(() => {
    validatedThisTurn = false;
  });
}
function cached(sql, params, read, copy) {
  if (!validatedThisTurn) validateQueryCache();
  const key = `${sql}\u0000${JSON.stringify(params)}`;
  if (queryCache.has(key)) {
    const value = queryCache.get(key);
    queryCache.delete(key);
    queryCache.set(key, value);
    hits++;
    return copy(value);
  }
  misses++;
  const value = read(sql, ...params);
  const limit = Number(process.env.CAMPFIRE_QUERY_CACHE_ENTRIES) || 1000;
  while (queryCache.size >= limit)
    queryCache.delete(queryCache.keys().next().value);
  queryCache.set(key, value);
  return copy(value);
}
export const getCached = (sql, ...params) =>
  cached(sql, params, get, (row) => row && { ...row });
export const allCached = (sql, ...params) =>
  cached(sql, params, all, (rows) => rows.map((row) => ({ ...row })));
export function now() {
  return new Date(process.env.CAMPFIRE_FROZEN_TIME || Date.now())
    .toISOString()
    .replace("T", " ")
    .replace("Z", "")
    .replace(/(\.\d{3})$/, "$1000");
}
const isBusy = (error) => (error?.errcode & 0xff) === 5;
const pause = new Int32Array(new SharedArrayBuffer(4));
// SQLite's busy handler sleeps 1, 2, 5, 10... ms between lock attempts while a post holds the
// write lock for ~0.2 ms, so cluster workers mostly slept on a free lock. Retrying every
// 0.025-1.5 ms (jittered Atomics.wait sleeps, no spinning) keeps the same overall deadline.
// Every main-DB writer polls, so autocommit writes are not starved by polling transactions.
function pollWriteLock(target, timeout, attempt) {
  target.exec("PRAGMA busy_timeout=0");
  try {
    const deadline = Date.now() + timeout;
    for (let wait = 0.05; ; wait = Math.min(wait * 1.5, 1)) {
      try {
        return attempt();
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) throw error;
      }
      Atomics.wait(pause, 0, 0, wait * (0.5 + Math.random()));
    }
  } finally {
    target.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  }
}
export const beginImmediate = (target = db(), timeout = BUSY_TIMEOUT_MS) =>
  pollWriteLock(target, timeout, () => target.exec("BEGIN IMMEDIATE"));
export function transaction(fn) {
  const name = `nested_${depth}`,
    nested = depth > 0;
  clearQueryCache();
  if (nested) db().exec(`SAVEPOINT ${name}`);
  else beginImmediate();
  depth++;
  callbacks.push([]);
  let result, hooks;
  try {
    result = fn();
    if (result && typeof result.then === "function")
      throw new TypeError("SQLite transactions must be synchronous");
    db().exec(nested ? `RELEASE ${name}` : "COMMIT");
    hooks = callbacks.pop();
  } catch (error) {
    callbacks.pop();
    db().exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
    throw error;
  } finally {
    depth--;
    writes++;
    clearQueryCache();
  }
  if (nested) callbacks.at(-1).push(...hooks);
  else for (const callback of hooks) callback();
  return result;
}

function validateSchema(connection) {
  const required = {
    accounts: [
      "id",
      "name",
      "join_code",
      "settings",
      "custom_styles",
      "singleton_guard",
      "created_at",
      "updated_at",
    ],
    users: [
      "id",
      "name",
      "email_address",
      "password_digest",
      "role",
      "status",
      "bot_token",
      "bio",
      "created_at",
      "updated_at",
    ],
    rooms: ["id", "name", "type", "creator_id", "created_at", "updated_at"],
    memberships: [
      "id",
      "room_id",
      "user_id",
      "involvement",
      "connections",
      "connected_at",
      "unread_at",
      "created_at",
      "updated_at",
    ],
    messages: [
      "id",
      "room_id",
      "creator_id",
      "client_message_id",
      "created_at",
      "updated_at",
    ],
    action_text_rich_texts: [
      "id",
      "record_id",
      "record_type",
      "name",
      "body",
      "created_at",
      "updated_at",
    ],
    active_storage_blobs: [
      "id",
      "key",
      "filename",
      "content_type",
      "byte_size",
      "checksum",
      "metadata",
      "service_name",
      "created_at",
    ],
    active_storage_attachments: [
      "id",
      "name",
      "record_type",
      "record_id",
      "blob_id",
      "created_at",
    ],
    active_storage_variant_records: ["id", "blob_id", "variation_digest"],
    boosts: [
      "id",
      "message_id",
      "booster_id",
      "content",
      "created_at",
      "updated_at",
    ],
    sessions: [
      "id",
      "user_id",
      "token",
      "user_agent",
      "ip_address",
      "last_active_at",
      "created_at",
      "updated_at",
    ],
    searches: ["id", "user_id", "query", "created_at", "updated_at"],
    bans: ["id", "user_id", "ip_address", "created_at", "updated_at"],
    push_subscriptions: [
      "id",
      "user_id",
      "endpoint",
      "p256dh_key",
      "auth_key",
      "user_agent",
      "created_at",
      "updated_at",
    ],
    webhooks: ["id", "user_id", "url", "created_at", "updated_at"],
    message_search_index: ["body"],
  };
  for (const [table, columns] of Object.entries(required)) {
    const installed = new Set(
      connection
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((c) => c.name),
    );
    const missing = columns.filter((c) => !installed.has(c));
    if (missing.length)
      throw new Error(
        `Unsupported Campfire database schema: ${table} missing ${missing.join(", ")}. Upgrade the Rails installation to the pinned reference schema before importing it.`,
      );
  }
  const fts = connection
    .prepare("SELECT sql FROM sqlite_master WHERE name='message_search_index'")
    .get()?.sql;
  if (!/USING\s+fts5\b/i.test(fts || ""))
    throw new Error(
      "Unsupported Campfire database schema: message_search_index must be FTS5",
    );
}
