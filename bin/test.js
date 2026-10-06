import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
const scratch = path.resolve("tmp/tests");
mkdirSync(scratch, { recursive: true });
const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => "./test/" + name);
// bun test shares one module graph across files; db.js holds a single connection
// and each file sets its own DATABASE_PATH, so every file needs its own process.
const failed = files.filter((file) => {
  const result = spawnSync(
    process.execPath,
    ["test", "--timeout", "60000", file],
    { stdio: "inherit", env: { ...process.env, TMPDIR: scratch } },
  );
  if (result.error) throw result.error;
  return result.status !== 0;
});
if (failed.length) console.error("Failed: " + failed.join(", "));
process.exit(failed.length ? 1 : 0);
