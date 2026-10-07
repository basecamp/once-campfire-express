# Benchmarks

[once-campfire-verification](https://github.com/basecamp/once-campfire-verification)
owns the shared response contracts, load generator, exact write audits and browser flows.
Clone it alongside this repo and follow its setup instructions to build the client and
canonical seed. This repo should have the sibling name `once-campfire-express`.

With this repository's `reference` submodule checked out:

```sh
npm run bench:image       # rebuild the Node production image after changes
npm run bench            # HTTP reads, then HTTP writes
```

The default apps are `express,rust`; build the Rust production image separately
or pass `--apps` to select a subset. `--help` lists all options. `VERIFICATION_ROOT`,
`LOADGEN`, `BENCH_ENV_FILE`, `RUST_IMAGE` and `EXPRESS_IMAGE`
can override paths or image names. `<APP>_BENCH_ENV` adds JSON environment overrides.
Each npm suite writes to ignored `tmp/bench/results/{reads,writes}/` here; the direct
`ruby bench/compare.rb` command uses ignored `tmp/bench/` in the verification checkout.

Server processes share four assigned hardware threads; clients use separate threads.
Every warmup and timed HTTP response must pass its content contract, and every
acknowledged POST must match its exact stored message and search-index entry.
The maintained comparison measures HTTP. Live Action Cable correctness is checked
by the shared browser gate against a fresh disposable instance; HTTP throughput
is not a WebSocket capacity result.

## Render parity snapshots

`npm run snapshot` fetches hot routes from a running server as a logged-in user and stores
the bodies; `npm run snapshot:compare` compares two stored snapshots byte for byte
(`bench/snapshot.js`; flags in its header). CSRF meta tags and hidden token fields (which
older commits rendered) are removed and the server origin is normalized first. Use it to
confirm template and cache changes keep output identical. The default labels path still
uses the local Rust parity seed; pass `--labels` to use the shared canonical seed.
