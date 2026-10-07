#!/usr/bin/env node
import { openDatabase, backupDatabase } from "../src/sqlite.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
export async function createBackup(
  output,
  storage = process.env.CAMPFIRE_STORAGE_PATH || "storage",
) {
  output = path.resolve(output);
  storage = path.resolve(storage);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = fs.mkdtempSync(
    path.join(path.dirname(output), ".campfire-backup-"),
  );
  const stage = path.join(temp, "storage");
  fs.mkdirSync(path.join(stage, "db"), { recursive: true });
  try {
    const db = openDatabase(
      process.env.DATABASE_PATH || path.join(storage, "db/production.sqlite3"),
    );
    try {
      backupDatabase(db, path.join(stage, "db/production.sqlite3"));
    } finally {
      db.close();
    }
    const jobs =
      process.env.JOBS_DATABASE_PATH || path.join(storage, "db/jobs.sqlite3");
    if (fs.existsSync(jobs)) {
      const queue = openDatabase(jobs);
      try {
        backupDatabase(queue, path.join(stage, "db/jobs.sqlite3"));
      } finally {
        queue.close();
      }
    }
    // Run during a maintenance window to keep the SQLite snapshot and file lifecycle consistent.
    if (fs.existsSync(path.join(storage, "files")))
      fs.cpSync(path.join(storage, "files"), path.join(stage, "files"), {
        recursive: true,
      });
    fs.writeFileSync(
      path.join(stage, "backup.json"),
      JSON.stringify({
        format: 1,
        implementation: "once-campfire-express",
        created_at: new Date().toISOString(),
      }),
    );
    execFileSync("tar", [
      "-czf",
      path.join(temp, "backup.tar.gz"),
      "-C",
      temp,
      "storage",
    ]);
    fs.renameSync(path.join(temp, "backup.tar.gz"), output);
    return output;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (!process.argv[2])
    throw new Error("Usage: node bin/backup.js OUTPUT.tar.gz");
  console.log(await createBackup(process.argv[2]));
}
