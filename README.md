# once-campfire-express

ONCE Campfire implemented natively with Node.js 24 (`node:sqlite`) and Express 5. The existing SQLite
schema, uploaded files, bcrypt passwords and Rails login cookies remain compatible.
Eta templates (`templates/eta/`, converted byte for byte from the former nunjucks macros by
`bin/nunjucks-to-eta.js`) render the retained Turbo/Stimulus/Lexxy frontend; native WebSockets
speak Action Cable. No other Campfire implementation runs in the application process.

```sh
git submodule update --init
docker build -t once-campfire-express .
docker run --rm -p 8080:80 -e SECRET_KEY_BASE="$(openssl rand -hex 64)" \
  -v campfire:/rails/storage once-campfire-express
```

Existing installs must reuse their `SECRET_KEY_BASE` and mount their storage at
`/rails/storage`. Preserve VAPID keys for existing push subscriptions. `WEB_WORKERS`
sets the HTTP process count (default `auto`: available CPUs, respecting cpusets);
publications pass through the primary process to every worker. A separate leased SQLite
queue handles jobs. TLS terminates at a proxy; configure `TRUSTED_PROXIES` with its addresses.

For local development, install the pinned Node (`.node-version`), run `npm ci`,
`npm run build:assets`, set `SECRET_KEY_BASE`, then `npm start`. Run `npm test`
(each test file in its own process) for native integration and independent
Rails golden-vector tests. The public Rails
reference is immutable and pinned at `659f957`.

See [verification](plans/contracts.md) for tested workflows and remaining limits,
and [benchmark commands](bench/README.md) for the production comparison.

## Benchmarks

Measured with 16 concurrent clients on an AMD Ryzen AI MAX+ 395 with 32 GB RAM,
with four hardware cores allocated to each app.

| HTTP workload (requests/sec) | Rails | [Django](https://github.com/basecamp/once-campfire-django) | [Laravel](https://github.com/basecamp/once-campfire-laravel) | [Express](https://github.com/basecamp/once-campfire-express) | [Elixir](https://github.com/basecamp/once-campfire-elixir) | [Go](https://github.com/basecamp/once-campfire-go) | [Rust](https://github.com/basecamp/once-campfire-rust) | [C](https://github.com/basecamp/once-campfire-c) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Room page | 2,063 | 478 | 3,038 | 43,925 | 5,350 | 53,060 | 106,494 | 137,524 |
| Messages page | 2,063 | 486 | 3,081 | 74,176 | 5,712 | 54,800 | 102,697 | 144,642 |
| Sidebar | 2,545 | 601 | 3,832 | 94,322 | 5,949 | 59,144 | 120,294 | 152,002 |
| Search | 2,528 | 594 | 3,710 | 82,937 | 5,848 | 60,509 | 121,378 | 149,487 |
| Post a message | 234 | 112 | 577 | 2,098 | 1,278 | 9,021 | 8,037 | 7,530 |

[Shared verification](https://github.com/basecamp/once-campfire-verification) · [Detailed results](https://github.com/basecamp/once-campfire-verification/blob/main/docs/performance-review.md).

This branch has not yet been re-measured on Express. Its earlier local numbers were taken
on Fastify and do not apply; results will be added after a run with the shared harness.

## Known differences

- Sidebar connection refresh waits for the current Turbo frame to finish loading,
  preventing an aborted response on startup or reconnect. Obsolete connections and removed frames do not reload.

- Cached message copy-link buttons store paths and resolve them against the current page,
  keeping copied links absolute without embedding a request host in shared markup.

- Search selects the newest 100 matching messages by insertion ID, then displays them in ID order. Backdated messages can appear in a different order from the original Rails app.

- TLS terminates at a configured proxy.
- CSRF: `Sec-Fetch-Site` replaces tokens. Writes accept `same-origin` and `same-site`,
  reject `cross-site`, `none`, invalid values and missing headers over HTTPS with 422.
  A provided Origin must match the effective origin, including its port; null and empty
  Origins fail. Only GET and HEAD bypass the check. Plain HTTP accepts missing metadata
  unless `FORCE_SSL=true` declares a TLS-only deployment, retaining `SameSite=Lax` cookies. Pages omit
  CSRF tags and fields; old tabs still work, but HTTPS forms require a browser that sends
  the header (Safari 16.4 or newer). Rails-issued sessions keep their `_csrf_token`; new
  sessions get none. Authenticated bot-key message routes and signed disk-upload capabilities retain their exemptions. `assets/overrides/models/file_uploader.js`
  drops the upload's `X-CSRF-Token` header, which read the removed meta tag.
- Attached downloads and inline attachments recheck room membership; new draft uploads
  belong to their uploader. Legacy unattached signed drafts remain usable after sign-in.
- Native media variants use a separate digest namespace, preserving original files and
  rebuilding previews as needed. Native-library media bytes can differ.
- HTML whitespace and malformed-fragment repair can differ. Full byte parity is not claimed.
- Direct-room autocomplete explicitly requests JSON, repairing the original fetch-header bug.
- Integers above 2^53 read from SQLite throw (`node:sqlite`); the Campfire schema stores none.
- Two indexes absent from the Rails schema are created at startup (`CREATE INDEX IF NOT
  EXISTS`, tables unchanged): `messages(room_id, updated_at)` for room refresh and
  `messages(room_id, created_at)`, which covers message paging and response-cache window
  revalidation. The `around` halves break `created_at` ties by id like the other pages
  (Rails leaves their order to SQLite).
- Eta templates replace nunjucks with byte-identical output (fuzz and snapshot checked,
  escaping identical including backslash). `push_subscriptions` with two or more
  subscriptions threw under nunjucks and now renders.
- SQLite uses Rails 8 pragmas (WAL, `synchronous=NORMAL`, `journal_size_limit` 64 MB,
  `cache_size` 2000, mmap off) and a bounded (512) prepared-statement cache.
- Per-request session/user/account/ban reads use a query-result LRU
  (`CAMPFIRE_QUERY_CACHE_ENTRIES`, default 1000), cleared on own writes and when
  `PRAGMA data_version` shows another worker or job committed.
- Rendered messages use a per-worker fragment cache (`CAMPFIRE_FRAGMENT_CACHE_MB`,
  default 32). The key digests every value the fragment prints (message row, whole body,
  attachment and embedded blob names and types, boosts in display order, creator/booster/room
  names and avatar versions), origin and template digest, so writes that keep timestamps
  (other processes, the sqlite3 CLI) and creator and booster renames show immediately (Rails
  keys on `updated_at` and keeps them stale). @mention names stay stale until the message
  changes, as in Rails.
- The messages page answers 304 from an ETag built from the fragment keys (Rails
  `fresh_when @messages`).
- Action Cable authorization is memoized for `CABLE_AUTH_TTL_MS` (default 1000).
  Every publication checks the database generation; local and external revocations invalidate the authorization memo immediately.
- Whole-page response cache per worker (`CAMPFIRE_RESPONSE_CACHE_MB`, default 64 MiB,
  capped at 1024; 0 or invalid disables) for GET/HEAD HTML: room, permalink, messages page, sidebar, search, show-message.
  An entry is current for the DB epoch it was stored in. After any commit (any process) it is
  revalidated, like Rails cache keys: a few indexed reads of exactly what the page prints
  (viewer/account rows, logo, room row, involvement, direct members, sidebar rooms with
  unread flags, recent searches, the shown messages with creators, room names, attachments
  and boosts, a re-run FTS search, and the ids of the shown window).
  A match is served and re-stamped; posts to other rooms keep pages. Shown messages are
  compared by their fragment keys, so no timestamp stands in for content. The shown window
  is selected again, ids only, from the arguments the page used (room and `before`/`after`/
  `around` anchor, falling back to the latest page when an `around` anchor is gone), so any
  write that adds, deletes or moves a message into or out of it re-renders the page,
  including a foreign one rewriting `room_id` or `created_at`; writes that leave it as it was
  keep the page. The selection reads only the `messages(room_id, created_at)` index.
  `CAMPFIRE_CACHE_VERIFY=1` re-renders every revalidated hit, serves and counts the fresh
  page on a mismatch. Mention names stay as cached, like the fragment cache. Rails has no
  equivalent; output is unchanged. Session and access checks run on every request;
  request variants (origin, user agent, cookie, session) stay separate and cookies and
  security headers stay fresh. HEAD reuses GET bodies but never stores; flash-bearing
  and bot-authenticated responses bypass the cache.
- Large HTML is gzip, not brotli: spliced from cached deflate pieces (`CAMPFIRE_GZIP_CACHE_MB`,
  default 32) or built once per cached page. Digested assets are served from precompressed
  `.br`/`.gz` files built by `bin/build-assets.js`; the file set is read at startup.
- Public responses are kept in memory per worker (`CAMPFIRE_PUBLIC_CACHE_MB`, default 32, 0
  disables; LRU): each digested asset variant (identity/br/gzip) with prebuilt headers is answered
  before Express, and avatar bodies are keyed by their ETag, which covers every body input
  (user id, name, role, `updated_at` and the avatar blob's id, key and checksum), so changes,
  including a foreign role change to bot that leaves `updated_at` alone, show on the next
  request that reaches the server; browsers keep their copy for the 30-minute `max-age`
  because the printed `?v=` follows `updated_at` only. A file is read on its
  first request (served from disk meanwhile) and never re-read (files over half the budget
  are never read, and ones resized since startup never stored). Range, `If-Match`,
  `If-Unmodified-Since` and on-the-fly-compressed requests keep the file-serving chain, whose
  status, headers and bytes the cache reproduces.
- `/up` answers before the session middleware, as Rails' health controller does: no
  `_campfire_session` cookie, ban check or `last_active_at` update. Matched paths, body and ETag
  are unchanged.
- Rails cookie decryption and signature checks are memoized in bounded LRUs; cookies with an
  expiry are re-checked on every hit.
- Message notification, push and webhook jobs are persisted in one batch before the response,
  so acknowledged posts already have durable queue entries. Jobs run in parallel up to
  `JOB_CONCURRENCY` (default 3),
  so completion order is not queue order. The jobs DB uses `synchronous=NORMAL`.
- Main-DB writes (`BEGIN IMMEDIATE` and autocommit `run()`) poll the write lock every
  0.025-1.5 ms (jittered `Atomics.wait`) for up to 10 s instead of SQLite's busy handler,
  which sleeps 1, 2, 5, 10... ms while a post holds the lock for about 0.2 ms; mixing the two
  starved the slower one. Reads, the jobs DB and the checkpointer keep `busy_timeout`. New messages
  insert their search-index row without a prior delete (`AUTOINCREMENT` ids, as Rails).
- A publishing worker delivers broadcasts to its own sockets at once; the primary relays
  them to the other workers over structured-clone (`advanced`) IPC. Workers may therefore
  see concurrent messages in different orders (before, all followed the primary's relay
  order); the client re-sorts appended messages by sort value.
- WAL checkpoints run on a background thread (`src/checkpoint.js`) in the primary: PASSIVE
  every 250 ms, TRUNCATE above 64 MB, forced RESTART above `CAMPFIRE_WAL_MAX_MB` (256).
  Every writer keeps a 64 MB autocheckpoint backstop if the background worker stalls.
- `WEB_WORKERS` defaults to `auto`; cluster workers listen with `reusePort` on Linux
  (`REUSE_PORT=0` disables). HTML ETags are `W/"<length>-<fast hash>"`.
- Action Cable keeps a per-stream subscriber index. A revoked or dead socket is cut off on
  the next publish to one of its own streams, by `forgetUser` in the revoking worker, or by
  the 3 s ping.
- Backups use `VACUUM INTO` (consistent snapshot) instead of the online backup API.
- Backups require a maintenance window for consistent database and file snapshots. App and
  queue snapshots are separate; external job effects have at-least-once delivery.

MIT. Templates, asset compilation and compatibility contracts draw on the public Rails
application and existing Campfire ports; vendored frontend assets retain their licenses.
