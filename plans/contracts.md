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
5.2.1); README.md lists a later matched run of the caching branch on Node and Bun. All 52
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

## Runtimes, templates and caches: known differences

Node 24 is the default runtime (`.node-version`, `Dockerfile`); Bun 1.4.2 is optional
(`.bun-version`, `Dockerfile.bun`). `src/sqlite.js` selects `node:sqlite` or `bun:sqlite`
once at load; `src/gzip.js` hashes with `Bun.hash` on Bun and `zlib.crc32` on Node. Unit tests alone do not establish production parity; the
branch needs fresh production Docker checks and re-measured benchmarks.

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
  id/`updated_at`, content hash, creator/booster/room names, avatar versions, origin,
  template digest. Differs from Rails: creator/booster renames show immediately (Rails'
  `cache [message, ...]` keeps them stale); @mention names stay stale until the message
  changes, as in Rails.
- Messages page answers 304 via ETag from the fragment keys (Rails `fresh_when @messages`).
- Action Cable authorization memo `CABLE_AUTH_TTL_MS` (default 1000): revocation is
  immediate in the worker that performs it (`forgetUser`), within the TTL elsewhere.
- Integers above 2^53 read from SQLite throw on Node and are rounded by `bun:sqlite`
  (safeIntegers off); Campfire's schema stores none.
- `WEB_WORKERS` defaults to `auto` (`os.availableParallelism()`, respecting cpusets). Cluster
  workers listen with `reusePort` on Linux (`REUSE_PORT=0` disables).
- HTML ETags are `W/"<length>-<fast hash>"`; values differ between runtimes. The message
  body digest memo keys on `updated_at`, length and a head/tail sample, so a same-millisecond
  edit with identical length, head and tail can serve stale cached HTML (Rails keys on
  `updated_at` alone).
- CSRF: `Sec-Fetch-Site` replaces tokens. Writes accept `same-origin` and `same-site`,
  reject `cross-site`, `none` and missing headers over HTTPS with 422, and retain the
  `Origin` check. Plain HTTP accepts missing headers with `SameSite=Lax` cookies. Pages omit
  CSRF tags and fields; old tabs still work, but HTTPS forms require a browser that sends
  the header (Safari 16.4 or newer). Rails-issued sessions keep their `_csrf_token`; new
  sessions get none. Bot-key message routes stay exempt. `assets/overrides/models/file_uploader.js`
  drops the upload's `X-CSRF-Token` header, which read the removed meta tag.
  HTTPS is detected from `req.secure` (`X-Forwarded-Proto` only through `TRUSTED_PROXIES`);
  Express has no `force_ssl` setting, so the Rust port's extra "app forces SSL" condition
  has no counterpart. The 189 Rails CSRF vectors still test `validCsrf`/`maskCsrf`, which
  requests no longer call.
- Whole-page response cache per worker (`CAMPFIRE_RESPONSE_CACHE_MB`, default 32, 0
  disables) for GET HTML: room, permalink, messages page, sidebar, search, show-message.
  Any committed write to the main DB, from any process, invalidates all entries. Rails has
  no equivalent; output is unchanged.
- Large HTML is gzip, not brotli: spliced from cached deflate pieces (`CAMPFIRE_GZIP_CACHE_MB`,
  default 32) or built once per cached page. Digested assets are served from precompressed
  `.br`/`.gz` files built by `bin/build-assets.js`; the file set is read at startup.
- Rails cookie decryption and signature checks are memoized in bounded LRUs; cookies with an
  expiry are re-checked on every hit.
- Message notification, push and webhook jobs are enqueued in one batch after the response,
  through the primary (single writer). A hard crash between response and enqueue loses
  them; clean shutdown flushes. Jobs run in parallel up to `JOB_CONCURRENCY` (default 3),
  so completion order is not queue order. The jobs DB uses `synchronous=NORMAL`.
- WAL checkpoints run on a background thread (`src/checkpoint.js`) in the primary: PASSIVE
  every 250 ms, TRUNCATE above 64 MB, forced RESTART above `CAMPFIRE_WAL_MAX_MB` (256).
  Cluster web workers disable WAL autocheckpoint; single-process mode keeps a 64 MB backstop.
- Action Cable keeps a per-stream subscriber index. A revoked or dead socket is cut off on
  the next publish to one of its own streams, by `forgetUser` in the revoking worker, or by
  the 3 s ping.
- Backups use `VACUUM INTO` (consistent snapshot) instead of the online backup API.
