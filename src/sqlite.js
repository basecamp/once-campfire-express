import { Database } from "bun:sqlite";

export function openDatabase(path, { readOnly = false } = {}) {
  // strict: bare ?/plain-object binding; safeIntegers:false reads numbers, not BigInt.
  return new Database(path, {
    ...(readOnly ? { readonly: true } : { create: true }),
    strict: true,
    safeIntegers: false,
  });
}

export function backupDatabase(db, destination) {
  // bun:sqlite has no online backup API; VACUUM INTO writes a transactionally consistent copy.
  db.prepare("VACUUM INTO ?").run(destination);
}
