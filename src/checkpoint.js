import { statSync } from "node:fs";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { openDatabase } from "./sqlite.js";

export const WAL_TRUNCATE_BYTES = 64 * 1024 * 1024;

export function walBytes(file) {
  return statSync(`${file}-wal`, { throwIfNoEntry: false })?.size || 0;
}
export const WAL_MAX_BYTES =
  Number(process.env.CAMPFIRE_WAL_MAX_MB || 256) * 1024 * 1024;

// PASSIVE never blocks writers; TRUNCATE takes the writer lock, so it runs only once the WAL is already oversized.
// Above maxLimit the WAL is runaway (readers kept pinning TRUNCATE): RESTART with a long busy wait blocks writers briefly but bounds the file.
export function checkpoint(
  db,
  file,
  limit = WAL_TRUNCATE_BYTES,
  maxLimit = WAL_MAX_BYTES,
) {
  const wal = walBytes(file);
  const mode =
    wal > maxLimit ? "RESTART" : wal > limit ? "TRUNCATE" : "PASSIVE";
  if (mode === "RESTART") {
    console.error(`Campfire WAL is ${wal} bytes; forcing blocking RESTART`);
    db.exec("PRAGMA busy_timeout=5000");
  }
  const { busy, log, checkpointed } = db
    .prepare(`PRAGMA wal_checkpoint(${mode})`)
    .get();
  if (mode === "RESTART") db.exec("PRAGMA busy_timeout=100");
  return { mode, wal, busy, log, checkpointed };
}

// Runs in a worker thread so checkpoint I/O never stalls the primary's event loop (it relays cable IPC).
export function startCheckpointer(
  file,
  { interval = 250, limit = WAL_TRUNCATE_BYTES, maxLimit = WAL_MAX_BYTES } = {},
) {
  let worker,
    stopped = false;
  const spawn = () => {
    worker = new Worker(new URL(import.meta.url), {
      workerData: { campfireCheckpointer: { file, interval, limit, maxLimit } },
    });
    worker.unref();
    worker.on("error", (error) =>
      console.error("Campfire WAL checkpointer failed:", error.message),
    );
    worker.on("exit", () => {
      if (stopped) return;
      console.error("Campfire WAL checkpointer exited; restarting");
      setTimeout(() => stopped || spawn(), interval).unref();
    });
  };
  spawn();
  return {
    checkpoint: () =>
      new Promise((resolve) => {
        worker.once("message", resolve);
        worker.postMessage("checkpoint");
      }),
    async stop() {
      stopped = true;
      await worker.terminate();
    },
  };
}

if (!isMainThread && workerData?.campfireCheckpointer) {
  const { file, interval, limit, maxLimit } = workerData.campfireCheckpointer;
  const db = openDatabase(file);
  // Short wait: a TRUNCATE holding the writer lock must not stall request commits for long.
  db.exec("PRAGMA busy_timeout=100");
  const tick = () => {
    try {
      return checkpoint(db, file, limit, maxLimit);
    } catch (error) {
      console.error("Campfire WAL checkpoint failed:", error.message);
      return { error: error.message };
    }
  };
  setInterval(tick, interval);
  parentPort.on("message", (message) => {
    if (message === "checkpoint") parentPort.postMessage(tick());
  });
}
