import { DatabaseSync } from "node:sqlite";

export function openDatabase(path, { readOnly = false } = {}) {
  return new DatabaseSync(path, { readOnly });
}

export function backupDatabase(db, destination) {
  // VACUUM INTO writes a transactionally consistent copy synchronously, unlike the async backup() API.
  db.prepare("VACUUM INTO ?").run(destination);
}
