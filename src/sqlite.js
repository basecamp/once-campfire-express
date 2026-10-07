// The same code runs on Node (default) and Bun; the driver is picked once at load.
const bun = globalThis.Bun !== undefined;
const driver = bun ? await import("bun:sqlite") : await import("node:sqlite");

export function openDatabase(path, { readOnly = false } = {}) {
  if (!bun) return new driver.DatabaseSync(path, { readOnly });
  // strict: bare ?/plain-object binding; safeIntegers:false reads numbers, not BigInt.
  return new driver.Database(path, {
    ...(readOnly ? { readonly: true } : { create: true }),
    strict: true,
    safeIntegers: false,
  });
}

export function backupDatabase(db, destination) {
  // bun:sqlite has no online backup API; VACUUM INTO writes a transactionally consistent
  // copy on both drivers, so backups are byte-for-byte the same shape on either runtime.
  db.prepare("VACUUM INTO ?").run(destination);
}
