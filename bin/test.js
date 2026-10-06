import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
const scratch = path.resolve("tmp/tests");
mkdirSync(scratch, { recursive: true });
const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => "./test/" + name);
const env = { ...process.env, TMPDIR: scratch };
const run = (args) => {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  return result.status ?? 1;
};
if (!globalThis.Bun) process.exit(run(["--test", ...files]));
// db.js holds a single connection and each file sets its own DATABASE_PATH. node --test
// already isolates files in processes; bun test shares one module graph, so it runs per file.
const failed = files.filter(
  (file) => run(["test", "--timeout", "60000", file]) !== 0,
);
if (failed.length) console.error("Failed: " + failed.join(", "));
process.exit(failed.length ? 1 : 0);
