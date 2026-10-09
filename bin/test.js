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
process.exit(run(["--test", ...files]));
