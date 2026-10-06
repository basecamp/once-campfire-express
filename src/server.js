import cluster from "node:cluster";
import http from "node:http";
import { initialize, deferCheckpoints, databaseFile } from "./db.js";
import { createApp } from "./app.js";
import { attachCable } from "./cable.js";
import {
  startWorker,
  stopWorker,
  acceptJobsMessage,
  flushJobs,
  settleJobHandoffs,
} from "./jobs.js";
import { startCheckpointer } from "./checkpoint.js";

let shuttingDown = false;
const workers = Number(process.env.WEB_WORKERS || "1");
if (!Number.isInteger(workers) || workers < 1 || workers > 64)
  throw new Error("WEB_WORKERS must be between 1 and 64");
const serves = workers === 1 || cluster.isWorker;

initialize();
deferCheckpoints();
let checkpointer, server;
if (cluster.isPrimary) {
  const file = databaseFile();
  if (file && file !== ":memory:") checkpointer = startCheckpointer(file);
  startWorker();
  if (workers > 1) {
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on("message", (worker, event) => {
      if (event?.type === "cable" || event?.type === "cable-batch")
        for (const w of Object.values(cluster.workers)) w.send(event);
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
  server.listen(
    Number(process.env.HTTP_PORT || 8080),
    process.env.BIND || "0.0.0.0",
    () =>
      console.log(
        `Campfire Express listening on ${process.env.HTTP_PORT || 8080}`,
      ),
  );
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
