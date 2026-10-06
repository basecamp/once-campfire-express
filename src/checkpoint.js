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
// PASSIVE never blocks writers; TRUNCATE takes the writer lock, so it runs only once the WAL is already oversized.
export function checkpoint(db, file, limit = WAL_TRUNCATE_BYTES) {
  const wal = walBytes(file);
  const mode = wal > limit ? "TRUNCATE" : "PASSIVE";
  const { busy, log, checkpointed } = db
    .prepare(`PRAGMA wal_checkpoint(${mode})`)
    .get();
  return { mode, wal, busy, log, checkpointed };
}

// Runs in a worker thread so checkpoint I/O never stalls the primary's event loop (it relays cable IPC).
export function startCheckpointer(
  file,
  { interval = 1000, limit = WAL_TRUNCATE_BYTES } = {},
) {
  let worker,
    stopped = false;
  const spawn = () => {
    worker = new Worker(new URL(import.meta.url), {
      workerData: { campfireCheckpointer: { file, interval, limit } },
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
  const { file, interval, limit } = workerData.campfireCheckpointer;
  const db = openDatabase(file);
  // Short wait: a TRUNCATE holding the writer lock must not stall request commits for long.
  db.exec("PRAGMA busy_timeout=100");
  const tick = () => {
    try {
      return checkpoint(db, file, limit);
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
