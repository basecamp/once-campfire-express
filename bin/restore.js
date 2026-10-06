#!/usr/bin/env node
import { openDatabase } from "../src/sqlite.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
export function restoreBackup(
  input,
  storage = process.env.CAMPFIRE_STORAGE_PATH || "storage",
) {
  storage = path.resolve(storage);
  if (fs.existsSync(storage) && fs.readdirSync(storage).length)
    throw new Error(
      "Restore requires an empty storage directory and stopped application",
    );
  fs.mkdirSync(path.dirname(storage), { recursive: true });
  const temp = fs.mkdtempSync(
    path.join(path.dirname(storage), ".campfire-restore-"),
  );
  try {
    const entries = execFileSync("tar", ["-tzf", path.resolve(input)], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .trim()
      .split("\n");
    if (
      entries.some(
        (entry) =>
          !entry.startsWith("storage/") ||
          entry.split("/").includes("..") ||
          entry.includes("\0"),
      )
    )
      throw new Error("invalid archive path");
    const listing = execFileSync("tar", ["-tvzf", path.resolve(input)], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (
      listing.split("\n").some((line) => line && !["-", "d"].includes(line[0]))
    )
      throw new Error("archive links are not allowed");
    execFileSync("tar", [
      "-xzf",
      path.resolve(input),
      "-C",
      temp,
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    const stage = path.join(temp, "storage");
    const database = path.join(stage, "db/production.sqlite3");
    const db = openDatabase(database, { readOnly: true });
    try {
      if (
        db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
        !db.prepare("SELECT name FROM sqlite_master WHERE name='users'").get()
      )
        throw new Error("invalid Campfire database");
    } finally {
      db.close();
    }
    if (fs.existsSync(storage)) fs.rmdirSync(storage);
    fs.renameSync(stage, storage);
    return storage;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (!process.argv[2])
    throw new Error("Usage: node bin/restore.js INPUT.tar.gz");
  console.log(restoreBackup(process.argv[2]));
}
