# Benchmarks

Ruby orchestrates fresh production containers of Express and the
[Rust port](https://github.com/basecamp/once-campfire-rust), alternating their order.
Both the seed and the load generator come from a sibling `once-campfire-rust` checkout,
and this repository is expected at the sibling path `once-campfire-express`:

```sh
cd ../once-campfire-rust
git submodule update --init reference
parity/bin/reference build && parity/bin/seed build default
docker build -t campfire-rust:app .
(cd bench/loadgen && cargo build --release)
```

Then, from this repository with the `reference` submodule checked out:

```sh
bun run bench:image   # rebuild once-campfire-express:app after every change
bun run bench         # bench:reads, bench:writes and bench:cable in turn
```

Each suite writes `summary.json` and per-round JSON to `tmp/bench/results/{reads,writes,cable}/`.
`LOADGEN`, `BENCH_ENV_FILE`, `RUST_IMAGE` and `EXPRESS_IMAGE` override the defaults
(`bench/loadgen/target/release/loadgen`, `parity/.env.reference`, `campfire-rust:app`,
`once-campfire-express:app`). For other options, run `ruby bench/compare.rb --help`.

Server processes share four hardware threads (`--cpus`); clients use separate threads
(`--client-cpus`). The runner verifies exact ordered HTTP result windows, successful
persisted writes, FTS entries, SQLite integrity and complete WebSocket delivery. It
replaces fixture push and webhook destinations with loopback test endpoints. Raw output
stays in ignored `tmp/bench/`; no benchmark results are tracked.

## Render parity snapshots

`bun run snapshot` fetches hot routes from a running server as a logged-in user and stores
the bodies; `bun run snapshot:compare` compares two stored snapshots byte for byte
(`bench/snapshot.js`; flags in its header). CSRF meta tags and hidden token fields (which
older commits rendered) are removed and the server origin is normalized first. Use it to confirm template and cache changes keep output identical.
