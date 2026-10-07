# once-campfire-express

Native Node.js / Express port. Read pinned public Rails reference for behavior. Preserve original SQLite schema, storage keys, bcrypt passwords and Rails signing/encryption. No other language app at runtime.

Use ES modules and Node built-ins where practical. Node 24 (`.node-version`) is the only runtime. Keep raw benchmark/test artifacts in ignored tmp/. Test actual databases and independently generated vectors. No production parity claims from unit tests alone. Document deliberate differences and verification limits in README.md and plans/contracts.md. Run `npm test` and production Docker checks before committing. Never edit reference/.

All writes to the main DB go through db.js `run()`/`transaction()`; the query-result cache is invalidated only there. Templates are `templates/eta/*.eta`; never add a trailing newline to them (output must stay byte-identical to the former nunjucks).
