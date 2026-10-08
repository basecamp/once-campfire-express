import cluster from "node:cluster";
import http from "node:http";
import { initialize, deferCheckpoints, databaseFile, db } from "./db.js";
import { parseWebWorkers } from "./workers.js";
import { createApp } from "./app.js";
import { attachCable, relayCable } from "./cable.js";
import {
  startWorker,
  stopWorker,
  acceptJobsMessage,
  flushJobs,
  settleJobHandoffs,
} from "./jobs.js";
import { startCheckpointer } from "./checkpoint.js";

let shuttingDown = false;
const workers = parseWebWorkers();
const serves = workers === 1 || cluster.isWorker;

initialize();
// The background thread normally checkpoints; every writer retains the 64 MB backstop.
deferCheckpoints(db());
let checkpointer, server;
if (cluster.isPrimary) {
  const file = databaseFile();
  if (file && file !== ":memory:") checkpointer = startCheckpointer(file);
  startWorker();
  if (workers > 1) {
    // Advanced (structured clone) IPC copies broadcast HTML as raw bytes; JSON escaped every quote.
    cluster.setupPrimary({ serialization: "advanced" });
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on("message", (worker, event) => {
      if (event?.type === "cable" || event?.type === "cable-batch")
        relayCable(event);
      else acceptJobsMessage(event);
    });
    cluster.on("exit", (worker, code, signal) => {
      if (!shuttingDown) {
        console.error(`HTTP worker exited (${code || signal}); restarting`);
        cluster.fork();
      }
    });
  }
}
if (serves) {
  server = http.createServer(createApp());
  attachCable(server);
  listen();
}

function listen() {
  const port = Number(process.env.HTTP_PORT || 8080);
  const host = process.env.BIND || "0.0.0.0";
  const announce = () => console.log(`Campfire Express listening on ${port}`);
  const reusePort =
    cluster.isWorker &&
    process.platform === "linux" &&
    process.env.REUSE_PORT !== "0";
  if (!reusePort) return server.listen(port, host, announce);
  const fallback = (error) => {
    console.error(
      `reusePort listen failed (${error.code || error.message}); using shared listen`,
    );
    server.listen(port, host, announce);
  };
  server.once("error", fallback);
  try {
    server.listen({ port, host, reusePort: true, exclusive: true }, () => {
      server.off("error", fallback);
      announce();
    });
  } catch (error) {
    server.off("error", fallback);
    fallback(error);
  }
}

function closeServer() {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}
function workersExited() {
  const alive = Object.values(cluster.workers || {});
  return Promise.all(
    alive.map(
      (w) =>
        new Promise((resolve) => {
          if (w.isDead()) return resolve();
          // "disconnect" means the primary has read every message the worker sent, so no job batch is still in the pipe.
          let pending = 2;
          const done = () => --pending || resolve();
          w.once("exit", done);
          if (!w.isConnected()) return done();
          w.once("disconnect", done);
          w.send({ type: "shutdown" });
        }),
    ),
  );
}
// Jobs deferred past the response live only in memory until committed, so every exit path drains them first.
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(
    () => {
      if (cluster.isPrimary) flushJobs();
      process.exit(0);
    },
    cluster.isPrimary ? 8000 : 5000,
  ).unref();
  await closeServer();
  await settleJobHandoffs();
  if (cluster.isPrimary) {
    await Promise.all([workersExited(), stopWorker()]);
    flushJobs();
    await checkpointer?.stop();
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (cluster.isWorker)
  process.on("message", (event) => {
    if (event?.type === "shutdown") shutdown();
  });
