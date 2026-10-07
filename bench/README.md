# Benchmarks

Ruby orchestrates fresh production containers of Express on Node (`express`), the same
Express code on Bun 1.4.2 (`express-bun`) and the
[Rust port](https://github.com/basecamp/once-campfire-rust), alternating their order.
Both the seed and the load generator come from a sibling `once-campfire-rust` checkout,
and this repository is expected at the sibling path `once-campfire-express`:

```sh
cd ../once-campfire-rust
git submodule update --init reference
parity/bin/reference build && parity/bin/seed build default
docker build -t campfire-rust:app .
cargo build --release --manifest-path bench/loadgen/Cargo.toml --target-dir target/bench
```

Then, from this repository with the `reference` submodule checked out:

```sh
npm run bench:image       # rebuild once-campfire-express:app (Node) after every change
npm run bench:image:bun   # rebuild once-campfire-express:bun from Dockerfile.bun
npm run bench             # bench:reads, bench:writes and bench:cable in turn
```

Each suite writes `summary.json` and per-round JSON to `tmp/bench/results/{reads,writes,cable}/`.
`--apps` picks a subset (default `express,express-bun,rust`). `LOADGEN`, `BENCH_ENV_FILE`,
`RUST_IMAGE`, `EXPRESS_IMAGE` and `EXPRESS_BUN_IMAGE` override the defaults
(`target/bench/release/loadgen`, `parity/.env.reference`, `campfire-rust:app`,
`once-campfire-express:app`, `once-campfire-express:bun`); `<APP>_BENCH_ENV` (JSON) adds
environment, e.g. `EXPRESS_BUN_BENCH_ENV='{"WEB_WORKERS":"3"}'`. Each run's metadata records
the runtime per app. For other options, run `ruby bench/compare.rb --help`.

Server processes share four hardware threads (`--cpus`); clients use separate threads
(`--client-cpus`). The shared Rust repository’s Ruby runner checks every response’s route contract and exact
seeded result window, then matches each POST’s unique body and acknowledged message ID
to its persisted row and FTS entry. Invalid responses, duplicate acknowledgements, SQLite
corruption or incomplete WebSocket delivery fail the run. It
replaces fixture push and webhook destinations with loopback test endpoints. Raw output
stays in ignored `tmp/bench/`; no benchmark results are tracked.

## Render parity snapshots

`npm run snapshot` fetches hot routes from a running server as a logged-in user and stores
the bodies; `npm run snapshot:compare` compares two stored snapshots byte for byte
(`bench/snapshot.js`; flags in its header). CSRF meta tags and hidden token fields (which
older commits rendered) are removed and the server origin is normalized first. Use it to confirm template and cache changes keep output identical.
