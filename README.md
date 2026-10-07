# once-campfire-express

ONCE Campfire implemented natively with Node.js 24 (`node:sqlite`) and Express 5; the same code
also runs on Bun 1.4.2 (`bun:sqlite`, `Dockerfile.bun`). The existing SQLite
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
(each test file in its own process; `bun run test:bun` runs the suite on Bun) for native integration and independent
Rails golden-vector tests. The public Rails
reference is immutable and pinned at `659f957`.

See [verification](plans/contracts.md) for tested workflows and remaining limits,
and [benchmark commands](bench/README.md) for the production comparison.

## Benchmarks

Measured with 16 concurrent clients on an AMD Ryzen AI MAX+ 395 with 32 GB RAM,
with four hardware threads allocated to each app.

| HTTP workload (requests/sec) | Rails | [Django](https://github.com/basecamp/once-campfire-django) | [Laravel](https://github.com/basecamp/once-campfire-laravel) | [Express](https://github.com/basecamp/once-campfire-express) | [Elixir](https://github.com/basecamp/once-campfire-elixir) | [Go](https://github.com/basecamp/once-campfire-go) | [Rust](https://github.com/basecamp/once-campfire-rust) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Room page | 236 | 62 | 764 | 2,702 | 981 | 32,132 | 35,056 |
| Messages page | 384 | 70 | 922 | 3,183 | 1,341 | 31,564 | 40,481 |
| Sidebar | 474 | 230 | 1,399 | 34,595 | 2,546 | 17,993 | 33,924 |
| Search | 415 | 120 | 1,291 | 6,725 | 1,907 | 29,775 | 34,199 |
| Post a message | 244 | 113 | 498 | 2,183 | 1,431 | 9,442 | 8,995 |

## Known differences

- TLS terminates at a configured proxy.
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
- Node 24 is the default runtime; Bun 1.4.2 is optional. Integers above 2^53 read from
  SQLite throw on Node and are rounded by `bun:sqlite` (safeIntegers off); the Campfire
  schema stores none. HTML ETag hash values differ between runtimes.
- Eta templates replace nunjucks with byte-identical output (fuzz and snapshot checked,
  escaping identical including backslash). `push_subscriptions` with two or more
  subscriptions threw under nunjucks and now renders.
- SQLite uses Rails 8 pragmas (WAL, `synchronous=NORMAL`, `journal_size_limit` 64 MB,
  `cache_size` 2000, mmap off) and a bounded (512) prepared-statement cache.
- Per-request session/user/account/ban reads use a query-result LRU
  (`CAMPFIRE_QUERY_CACHE_ENTRIES`, default 1000), cleared on own writes and when
  `PRAGMA data_version` shows another worker or job committed.
- Rendered messages use a per-worker fragment cache (`CAMPFIRE_FRAGMENT_CACHE_MB`,
  default 32) keyed like Rails/Rust: template digest, id, `updated_at`, `presentation-v3`,
  plus origin (permalinks embed the host). Body edits, attachment changes and boosts touch
  `messages.updated_at` with strictly increasing microsecond values (also under
  `CAMPFIRE_FROZEN_TIME`). Creator/booster/room renames and @mention names stay stale until
  the message changes, as in Rails/Rust.
- Sidebar direct-room rows share that cache, keyed by membership id/`updated_at` plus the
  room's `updated_at` and unread flag; member renames/avatars stay stale until the
  membership changes, as in Rails/Rust.
- Thruster-style in-memory cache (`CAMPFIRE_FRONT_CACHE_MB`, default 64, items ≤ 1 MB) for
  GET/HEAD responses with `public` and a positive max-age (avatars, assets): keyed by
  method, URL, host and `Vary` headers, Set-Cookie stripped, `X-Cache: hit|miss|bypass`,
  304 from the stored ETag.
- The messages page answers 304 from an ETag built from the fragment keys (Rails
  `fresh_when @messages`).
- Action Cable authorization is memoized for `CABLE_AUTH_TTL_MS` (default 1000).
  Every publication checks the database generation; local and external revocations invalidate the authorization memo immediately.
- Opt-in whole-page response cache per worker (`CAMPFIRE_RESPONSE_CACHE_MB`, default 0 =
  off) for GET HTML: room, permalink, messages page, sidebar, search, show-message.
  Any committed write to the main DB, from any process, invalidates all entries. Rails has
  no equivalent; output is unchanged.
- Large HTML is gzip, not brotli: spliced from cached deflate pieces (`CAMPFIRE_GZIP_CACHE_MB`,
  default 32) or built once per cached page. Digested assets are served from precompressed
  `.br`/`.gz` files built by `bin/build-assets.js`; the file set is read at startup.
- Rails cookie decryption and signature checks are memoized in bounded LRUs; cookies with an
  expiry are re-checked on every hit.
- Message notification, push and webhook jobs are persisted in one batch before the response,
  so acknowledged posts already have durable queue entries. Jobs run in parallel up to
  `JOB_CONCURRENCY` (default 3),
  so completion order is not queue order. The jobs DB uses `synchronous=NORMAL`.
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
