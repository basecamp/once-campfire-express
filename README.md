# once-campfire-express

ONCE Campfire implemented natively with Node.js 24 (`node:sqlite`) and Fastify 5. The existing SQLite
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

Measured with 16 concurrent clients on an AMD Ryzen AI MAX+ 395,
with four hardware threads allocated to each app.

| HTTP workload (requests/sec) | Rails | [Django](https://github.com/basecamp/once-campfire-django) | [Laravel](https://github.com/basecamp/once-campfire-laravel) | [Express](https://github.com/basecamp/once-campfire-express) | [Elixir](https://github.com/basecamp/once-campfire-elixir) | [Go](https://github.com/basecamp/once-campfire-go) | [Rust](https://github.com/basecamp/once-campfire-rust) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Room page | 241 | 170 | 164 | 559 | 722 | 3,860 | 36,260 |
| Messages page | 413 | 196 | 175 | 777 | 1,053 | 5,573 | 40,872 |
| Sidebar | 552 | 615 | 715 | 4,125 | 1,275 | 19,753 | 34,672 |
| Search | 435 | 315 | 305 | 1,294 | 1,156 | 7,053 | 33,299 |
| Post a message | 273 | 154 | 137 | 256 | 801 | 4,767 | 6,896 |

At 100 WebSocket connections and five messages/second, median delivery to every
connection was 24 ms for Rails and 14 ms for Express. Every message reached every
connection in both runs.

The tables here were measured while the HTTP layer was Express 5, before the move to Fastify.
The first table also predates the caching work below. A later matched run on a 16-thread x86-64
host (same harness, 16 clients, servers on 4 hardware threads) measured this branch (the first column is `main` before these changes, same host):

| HTTP workload (requests/sec) | Node 24 + Express before caching | Node.js 24 + Fastify | Rust |
|---|---:|---:|---:|
| Room page | 395 | 21,632 | 19,121 |
| Messages page | 546 | 32,399 | 21,336 |
| Sidebar | 3,059 | 45,509 | 17,702 |
| Search | 935 | 42,285 | 18,222 |
| Post a message | 124 | 1,914 | 4,346 |

Reads hit the whole-page response cache because the read benchmark performs no concurrent
writes. After a commit, cached pages are revalidated rather than dropped, so writes to other
rooms keep them; this and the in-memory asset cache are not covered by `npm run bench`.

Optimizations compared with the Rust port (🟡 = partial; the extra index is omitted to keep
the original schema):

| Optimization | Rust | Node.js + Fastify |
|---|:---:|:---:|
| Message fragment cache (Rails `cache message`) | ✅ | ✅ |
| Whole-page response cache | ❌ | ✅ |
| Query-result cache for per-request auth reads | ❌ | ✅ |
| Prepared-statement cache + Rails 8 SQLite pragmas | ✅ | ✅ |
| 304 for the messages page (`fresh_when`) | ✅ | ✅ |
| CSRF via `Sec-Fetch-Site` (byte-stable pages) | ✅ | ✅ |
| Spliced gzip from cached deflate pieces | ✅ | ✅ |
| Whole-body gzip cache | ✅ | ✅ |
| Precompressed `.br`/`.gz` assets | 🟡 | ✅ |
| Zero-copy assets embedded in the binary | ✅ | 🟡 |
| In-memory cache for public responses (Thruster-style) | ✅ | ✅ |
| WAL checkpoints off the request path | ✅ | ✅ |
| Jobs off the request path | ✅ | ✅ |
| Single writer + reader pool | ✅ | ❌ |
| Extra `messages(room_id, created_at)` index | ✅ | ❌ |
| Cable: one frame per broadcast, per-stream index | ✅ | ✅ |
| Cable: `permessage-deflate` compressed once | ✅ | ❌ |
| All cores used | ✅ threads | ✅ processes |

## Known differences

- TLS terminates at a configured proxy.
- HTTP runs on Fastify 5 (`@fastify/static`, `@fastify/multipart`, `@fastify/compress`,
  `@fastify/cookie`, `@fastify/accepts`; `qs` for query strings and form bodies) instead of
  Express 5. Routes, statuses, redirects, cookies, CSRF, uploads and caching are functionally
  unchanged; bytes are not: redirects carry no body, header names are lowercase, string
  bodies without a type default to `text/plain`, and ETags of non-page bodies are
  `W/"<length>-<crc32>"` instead of Express's SHA-1. A form's `_method` is honoured by
  `src/router.js`, which also keeps Express's ordered `next()` fall-through between
  same-shaped routes (`/rooms/:kind` before `/rooms/:roomId`). `/up//` gets 403 from the
  static fallback where Express answered 404. Verified by `npm test` and a seed smoke run
  (single and cluster workers); not re-benchmarked.
- CSRF: `Sec-Fetch-Site` replaces tokens. Writes accept `same-origin` and `same-site`,
  reject `cross-site`, `none` and missing headers over HTTPS with 422, and retain the
  `Origin` check. Plain HTTP accepts missing headers with `SameSite=Lax` cookies. Pages omit
  CSRF tags and fields; old tabs still work, but HTTPS forms require a browser that sends
  the header (Safari 16.4 or newer). Rails-issued sessions keep their `_csrf_token`; new
  sessions get none. Bot-key message routes stay exempt. `assets/overrides/models/file_uploader.js`
  drops the upload's `X-CSRF-Token` header, which read the removed meta tag.
- Attached downloads and inline attachments recheck room membership; new draft uploads
  belong to their uploader. Legacy unattached signed drafts remain usable after sign-in.
- Native media variants use a separate digest namespace, preserving original files and
  rebuilding previews as needed. Native-library media bytes can differ.
- HTML whitespace and malformed-fragment repair can differ. Full byte parity is not claimed.
- Direct-room autocomplete explicitly requests JSON, repairing the original fetch-header bug.
- Integers above 2^53 read from SQLite throw (`node:sqlite`); the Campfire schema stores none.
- Eta templates replace nunjucks with byte-identical output (fuzz and snapshot checked,
  escaping identical including backslash). `push_subscriptions` with two or more
  subscriptions threw under nunjucks and now renders.
- SQLite uses Rails 8 pragmas (WAL, `synchronous=NORMAL`, `journal_size_limit` 64 MB,
  `cache_size` 2000, mmap off) and a bounded (512) prepared-statement cache.
- Per-request session/user/account/ban reads use a query-result LRU
  (`CAMPFIRE_QUERY_CACHE_ENTRIES`, default 1000), cleared on own writes and when
  `PRAGMA data_version` shows another worker or job committed.
- Rendered messages use a per-worker fragment cache (`CAMPFIRE_FRAGMENT_CACHE_MB`,
  default 32). The key covers id/`updated_at`, a content hash, creator/booster/room names,
  avatar versions, origin and template digest, so creator and booster renames show
  immediately (Rails keeps them stale). @mention names stay stale until the message
  changes, as in Rails.
- The messages page answers 304 from an ETag built from the fragment keys (Rails
  `fresh_when @messages`).
- Action Cable authorization is memoized for `CABLE_AUTH_TTL_MS` (default 1000).
  Revocation is immediate in the worker performing it, within the TTL in other workers.
- Whole-page response cache per worker (`CAMPFIRE_RESPONSE_CACHE_MB`, default 32, 0
  disables) for GET HTML: room, permalink, messages page, sidebar, search, show-message.
  An entry is current for the DB epoch it was stored in. After any commit (any process) it is
  revalidated, like Rails cache keys: a few indexed reads of exactly what the page prints
  (viewer/account rows, logo, room row, involvement, direct members, sidebar rooms with
  unread flags, recent searches, the shown messages with creators, room names, attachments
  and boosts, a re-run FTS search, and whether a new message entered the shown window).
  A match is served and re-stamped; posts to other rooms keep pages. Message bodies are
  compared by rich-text `updated_at`/length/edges, so a page showing a message posted or
  edited in the last 15 s (or under `CAMPFIRE_FROZEN_TIME`) is kept for its epoch only.
  `CAMPFIRE_CACHE_VERIFY=1` re-renders every revalidated hit, serves and counts the fresh
  page on a mismatch. Mention names stay as cached, like the fragment cache. Rails has no
  equivalent; output is unchanged.
- Large HTML is gzip, not brotli: spliced from cached deflate pieces (`CAMPFIRE_GZIP_CACHE_MB`,
  default 32) or built once per cached page. Digested assets are served from precompressed
  `.br`/`.gz` files built by `bin/build-assets.js`; the file set is read at startup.
- Public responses are kept in memory per worker (`CAMPFIRE_PUBLIC_CACHE_MB`, default 32, 0
  disables; LRU): each digested asset variant (identity/br/gzip) with prebuilt headers is answered
  before Fastify, and avatar bodies are keyed by their ETag, which covers user name,
  `updated_at` and avatar blob, so changes show on the next request. A file is read on its
  first request (served from disk meanwhile) and never re-read (files over half the budget
  are never read, and ones resized since startup never stored). Range, `If-Match`,
  `If-Unmodified-Since` and on-the-fly-compressed requests keep the file-serving chain, whose
  status, bytes and client-relevant headers the cache reproduces.
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
