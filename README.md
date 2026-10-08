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
with four hardware cores allocated to each app.

| HTTP workload (requests/sec) | Rails | [Django](https://github.com/basecamp/once-campfire-django) | [Laravel](https://github.com/basecamp/once-campfire-laravel) | [Express](https://github.com/basecamp/once-campfire-express) | [Elixir](https://github.com/basecamp/once-campfire-elixir) | [Go](https://github.com/basecamp/once-campfire-go) | [Rust](https://github.com/basecamp/once-campfire-rust) | [C](https://github.com/basecamp/once-campfire-c) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Room page | 4,132 | 478 | 3,872 | 42,636 | 5,350 | 53,060 | 106,494 | 137,524 |
| Messages page | 4,035 | 486 | 3,995 | 74,362 | 5,712 | 54,800 | 102,697 | 144,642 |
| Sidebar | 4,257 | 601 | 4,493 | 94,329 | 5,949 | 59,144 | 120,294 | 152,002 |
| Search | 4,216 | 594 | 4,172 | 84,665 | 5,848 | 60,509 | 121,378 | 149,487 |
| Post a message | 325 | 112 | 794 | 2,155 | 1,278 | 9,021 | 8,037 | 7,530 |

[Shared verification](https://github.com/basecamp/once-campfire-verification) · [Detailed results](https://github.com/basecamp/once-campfire-verification/blob/main/docs/performance-review.md).

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
  `CAMPFIRE_FROZEN_TIME`). An observed DB generation also namespaces fragments, so
  related-user changes and external edits without timestamp updates refresh their HTML.
- Sidebar direct-room rows share that cache, keyed by membership id/`updated_at` plus the
  room's `updated_at`, unread flag and observed DB generation; member changes refresh
  their HTML even without touching the membership.
- Thruster-style in-memory cache (`CAMPFIRE_FRONT_CACHE_MB`, default 64, items ≤ 1 MB) for
  GET/HEAD responses with `public` and a positive max-age (avatars, assets): keyed by
  method, URL, host and `Vary` headers, Set-Cookie stripped, `X-Cache: hit|miss|bypass`,
  304 from the stored ETag.
- The messages page answers 304 from an ETag built from the fragment keys (Rails
  `fresh_when @messages`).
- Action Cable authorization is memoized for `CABLE_AUTH_TTL_MS` (default 1000).
  Every publication checks the database generation; local and external revocations invalidate the authorization memo immediately.
- Whole-page response cache per worker (`CAMPFIRE_RESPONSE_CACHE_MB`, default 64 MiB,
  0 disables it) for room, permalink, messages, sidebar, search and show-message HTML.
  Session and access checks run on every request; any main-DB commit, including one from
  another process, invalidates entries. Request variants remain separate, and cookies
  and security headers stay fresh. GET and HEAD share completed HTML/gzip bodies without
  changing their content or validators. Flash-bearing responses bypass the cache.
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
