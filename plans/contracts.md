# Compatibility and verification

Native JavaScript/Express implementation; immutable public Rails reference `659f957`.
Existing SQLite schema, original files, bcrypt credentials and Rails JSON cookies are
the compatibility contract. Raw evidence stays ignored in `tmp/`.

| Area | Evidence |
|---|---|
| Rails signing, encryption and CSRF | Independent Rails vectors verify PBKDF2 keys, signed/encrypted cookies, signed IDs including large integers, SGIDs, application verifiers, Turbo streams, session continuity, purpose/expiry/signature rejection and 189 CSRF cases. Bounded data-only Marshal fixtures come from Ruby. |
| SQLite and messages | Real isolated databases test nested rollback, membership authorization, raw timestamp cursors, persisted writes, updates/deletion and FTS; independent HTTP checks compare actual stored records. |
| Frontend | Independent browser checks cover live compose/edit/delete/boost, mentions, paging, search, private/direct rooms, image upload/lightbox, administration and fresh setup. |
| Sessions | Independent original Rails server accepts Express-issued cookies and Express accepts Rails-issued cookies on shared disposable data. |
| Action Cable | Real sockets verify native subscription delivery, forged stream rejection, membership revocation, logout revocation and multi-tab presence. Cross-worker production browser delivery is exercised. |
| Storage and media | Actual 3840×2160 JPEG becomes 1200×675; real ffmpeg audio/video analysis and poppler PDF preview; Rails-issued signed transform accepted; direct upload checksum/range/owner/private-room checks and failed-media rollback. |
| Benchmarks | Matched production images with identical ordered 40-room/40-page/13-search windows, zero timed request failures, every acknowledged write stored with rich text and FTS, and SQLite integrity checks. Two paced runs admit all 100 sockets and deliver all 30 messages to every connection. Raw output remains ignored. |
| Jobs and bots | Actual queued HTTP delivery and persisted bot reply with FTS and recursive-webhook suppression; expired lease recovery, fencing, heartbeat renewal, bounded retries and dead state. |
| Backup/restore | Actual SQLite/storage round trip with integrity check; archive traversal/link rejection. Stop writers for consistency with file lifecycle. |

Verification is limited to the exercised workflows, not a claim of exhaustive Rails
parity. Public-site OpenGraph behavior and live browser-vendor push delivery remain
unverified; native transports reject private destinations and pin resolved addresses.
Malformed/legacy rich text outside the independent corpus can differ. Unsupported
older SQLite schemas require migration by the original application before upgrade.

The figures below describe the earlier frozen runtime `124694f` (Node 24.21.0 / Express
5.2.1); README.md lists a later matched run of the caching branch. All 52
native methods pass without seed skips. Independent checks passed 26 browser
assertions without JavaScript errors, 18 HTTP/session checks, 11 request boundaries,
6 crafted room-namespace checks, 4 real multi-tab presence checks and 3 socket
privacy checks. Runtime source and compiled asset hashes match the production image.

HTTP reads use two 4-second samples; writes use two 15-second samples, alternating
implementation order. Express posting varied from 206 to 305 requests/second, with
higher tail latency than Rails; the table reports the median, not a capacity limit.
The unchanged common load generator and original seed hashes are recorded in ignored
scratch evidence. Benchmark orchestration is Ruby, and server processes share four
hardware threads; Express uses three HTTP workers and its primary job/fanout process.

## Runtime, templates and caches: known differences

Node 24 is the only runtime (`.node-version`, `Dockerfile`, `node:sqlite`). Unit tests alone do not establish production parity; the
production image passed the shared route contracts and write audits in a local benchmark run on 2026-10-08
(README Benchmarks). It has not yet run in shared verification or the shared browser flows.

- Templates: Eta 4.6.0, one `templates/eta/*.eta` per former nunjucks macro, converted
  mechanically from `templates/pages.html` by `bin/nunjucks-to-eta.js`. Output is
  byte-identical (fuzz plus `bench/snapshot.js` comparison); the escape function matches
  nunjucks including backslash. `.eta` files must not gain a trailing newline. Fixed:
  `push_subscriptions` with two or more subscriptions threw under nunjucks.
- Pragmas and statements: WAL, `synchronous=NORMAL`, `journal_size_limit` 64 MB,
  `cache_size` 2000, mmap off; prepared-statement cache bounded at 512.
- Query-result LRU (`CAMPFIRE_QUERY_CACHE_ENTRIES`, default 1000) for per-request
  session/user/account/ban reads. Invalidated on own writes and on `PRAGMA data_version`
  change (other workers, jobs). Contract: every main-DB write goes through db.js
  `run()`/`transaction()`.
- Message fragment cache (`CAMPFIRE_FRAGMENT_CACHE_MB`, default 32, per worker). Key:
  template digest, origin and a digest of every value the fragment prints (message row,
  whole body, attachment and embedded blob names and types, boosts in display order,
  creator/booster/room names, avatar versions). Differs from Rails: writes that keep
  timestamps and creator/booster renames show immediately (Rails' `cache [message, ...]`
  keys on `updated_at`); @mention names stay stale until the message changes, as in Rails.
- Messages page answers 304 via ETag from the fragment keys (Rails `fresh_when @messages`).
- Action Cable authorization memo `CABLE_AUTH_TTL_MS` (default 1000): revocation is
  immediate in the worker that performs it (`forgetUser`), within the TTL elsewhere.
- Integers above 2^53 read from SQLite throw; Campfire's schema stores none.
- Two indexes absent from the Rails schema are created at startup (`CREATE INDEX IF NOT
  EXISTS`, tables unchanged): `messages(room_id, updated_at)` for room refresh and
  `messages(room_id, created_at)`, which covers message paging and response-cache window
  revalidation. The `around` halves break `created_at` ties by id like the other pages
  (Rails leaves their order to SQLite).
- `WEB_WORKERS` defaults to `auto` (`os.availableParallelism()`, respecting cpusets). Cluster
  workers listen with `reusePort` on Linux (`REUSE_PORT=0` disables).
- HTML ETags are `W/"<length>-<crc32>"`.
- CSRF: `Sec-Fetch-Site` replaces tokens. Writes accept `same-origin` and `same-site`,
  reject `cross-site`, `none`, invalid values and missing headers over HTTPS with 422.
  A provided Origin must match the effective origin, including its port; null and empty
  Origins fail. Only GET and HEAD bypass the check. Plain HTTP accepts missing metadata
  unless `FORCE_SSL=true` declares a TLS-only deployment, retaining `SameSite=Lax` cookies. Pages omit
  CSRF tags and fields; old tabs still work, but HTTPS forms require a browser that sends
  the header (Safari 16.4 or newer). Rails-issued sessions keep their `_csrf_token`; new
  sessions get none. Authenticated bot-key message routes and signed disk-upload capabilities retain their exemptions. `assets/overrides/models/file_uploader.js`
  drops the upload's `X-CSRF-Token` header, which read the removed meta tag.
  HTTPS is detected from `req.secure` (`X-Forwarded-Proto` only through `TRUSTED_PROXIES`);
  `FORCE_SSL=true` also requires metadata for requests arriving over plain HTTP; it does
  not configure TLS termination or redirects. The 189 Rails CSRF vectors still test `validCsrf`/`maskCsrf`, which
  requests no longer call.
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
  Verified in-process only: randomized domain/HTTP writes and a second SQLite connection,
  each cached page compared byte for byte with an uncached render (and, for writes that keep
  timestamps, with a render that rebuilds every message fragment); not yet exercised across
  production cluster workers.
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
  `If-Unmodified-Since` and on-the-fly-compressed requests keep the file-serving chain. Status,
  headers and bytes match it (diffed over every asset and encoding, and 2,010 captured
  responses on the seed).
- `/up` answers before the session middleware, as Rails' health controller does: no
  `_campfire_session` cookie, ban check or `last_active_at` update. Matched paths, body and ETag
  are unchanged.
- Rails cookie decryption and signature checks are memoized in bounded LRUs; cookies with an
  expiry are re-checked on every hit.
- Message notification, push and webhook jobs are enqueued in one batch after the response,
  through the primary (single writer). A hard crash between response and enqueue loses
  them; clean shutdown flushes. Jobs run in parallel up to `JOB_CONCURRENCY` (default 3),
  so completion order is not queue order; free slots are leased in one jobs-DB commit.
  The jobs DB uses `synchronous=NORMAL`.
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
  Cluster web workers disable WAL autocheckpoint; single-process mode keeps a 64 MB backstop.
- Action Cable keeps a per-stream subscriber index. A revoked or dead socket is cut off on
  the next publish to one of its own streams, by `forgetUser` in the revoking worker, or by
  the 3 s ping.
- Backups use `VACUUM INTO` (consistent snapshot) instead of the online backup API.
