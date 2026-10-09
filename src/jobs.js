import cluster from "node:cluster";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import webpush from "web-push";
import { get, all, run, applyDurabilityPragmas } from "./db.js";
import { openDatabase } from "./sqlite.js";
import { publicAddress, resolvePublic, requestPinned } from "./opengraph.js";
import {
  purgeBlob,
  processAttachment,
  storeUpload,
  stagedFiles,
} from "./storage.js";

let connection,
  timer,
  stopping = false,
  active = 0;
const statements = new Map();
const idle = [];
function statement(sql) {
  let prepared = statements.get(sql);
  if (!prepared) statements.set(sql, (prepared = jobsDb().prepare(sql)));
  return prepared;
}
export function jobsDb() {
  if (connection) return connection;
  const file =
    process.env.JOBS_DATABASE_PATH ||
    path.join(
      process.env.CAMPFIRE_STORAGE_PATH ||
        process.env.STORAGE_PATH ||
        "storage",
      "db/jobs.sqlite3",
    );
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  connection = openDatabase(file);
  connection.exec("PRAGMA busy_timeout=10000");
  applyDurabilityPragmas(connection);
  connection.exec(
    "CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at REAL NOT NULL,lease_until REAL,lease_token TEXT,status TEXT NOT NULL DEFAULT 'ready',last_error TEXT)",
  );
  statements.clear();
  return connection;
}
export function enqueue(kind, data) {
  return enqueueMany([{ kind, data }])[0];
}
export function enqueueMany(list, at = Date.now() / 1000) {
  const db = jobsDb(),
    insert = statement("INSERT INTO jobs(payload,available_at) VALUES(?,?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    const ids = list.map(({ kind, data }) =>
      Number(insert.run(JSON.stringify({ kind, data }), at).lastInsertRowid),
    );
    db.exec("COMMIT");
    return ids;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function logLostJobs(list, error) {
  const payloads = JSON.stringify(list, (key, value) =>
    typeof value === "bigint" ? String(value) : value,
  );
  console.error(
    `Campfire enqueue of ${list.length} jobs failed: ${error.message}; lost payloads: ${payloads}`,
  );
}
let buffered = [],
  flushScheduled = false;
const handoffs = new Set();
// Coalesces every batch that arrives within one event-loop turn into a single jobs-DB commit.
export function enqueueSoon(list) {
  if (!list.length) return;
  buffered.push(...list);
  if (!flushScheduled) {
    flushScheduled = true;
    setImmediate(flushJobs);
  }
}
export function flushJobs() {
  flushScheduled = false;
  if (!buffered.length) return 0;
  const batch = buffered;
  buffered = [];
  try {
    enqueueMany(batch);
  } catch (error) {
    logLostJobs(batch, error);
    return 0;
  }
  if (timer && !stopping) fill();
  return batch.length;
}
// Cluster workers hand jobs to the primary so it is the only jobs-DB writer on the hot path.
export function submitJobs(list) {
  if (!list.length) return;
  if (!cluster.isWorker || !process.connected) return enqueueSoon(list);
  const handoff = new Promise((resolve) => {
    const fallback = (error) => {
      console.error(
        `Campfire job handoff to primary failed (${error.message}); enqueueing locally`,
      );
      try {
        enqueueMany(list);
      } catch (failure) {
        logLostJobs(list, failure);
      }
    };
    try {
      process.send(
        { type: "jobs", jobs: list },
        undefined,
        undefined,
        (error) => {
          if (error) fallback(error);
          resolve();
        },
      );
    } catch (error) {
      fallback(error);
      resolve();
    }
  });
  handoffs.add(handoff);
  handoff.finally(() => handoffs.delete(handoff));
}
export function acceptJobsMessage(event) {
  if (event?.type !== "jobs" || !Array.isArray(event.jobs)) return false;
  enqueueSoon(event.jobs);
  return true;
}
// The response is already on the wire; work deferred here is lost only if the process dies hard before it runs.
export function afterResponse(res, work) {
  let settle;
  const deferred = new Promise((resolve) => (settle = resolve));
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    setImmediate(() => {
      try {
        work();
      } catch (error) {
        console.error("Campfire deferred work failed:", error);
      } finally {
        settle();
      }
    });
  };
  if (res.writableFinished || res.destroyed) start();
  res.once("finish", start);
  res.once("close", start);
  handoffs.add(deferred);
  deferred.finally(() => handoffs.delete(deferred));
}
export async function settleJobHandoffs() {
  while (handoffs.size) await Promise.all([...handoffs]);
}
export function claim(at = Date.now() / 1000) {
  return claimMany(1, at)[0] || null;
}
// One jobs-DB commit leases a whole batch instead of one commit per job.
export function claimMany(limit, at = Date.now() / 1000) {
  const db = jobsDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = statement(
      "SELECT * FROM jobs WHERE status='ready' AND available_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY id LIMIT ?",
    ).all(at, at, limit);
    const tokens = crypto.randomBytes(16 * rows.length).toString("hex");
    const lease = statement(
      "UPDATE jobs SET attempts=attempts+1,lease_until=?,lease_token=? WHERE id=?",
    );
    const claimed = rows.map((row, i) => {
      const token = tokens.slice(i * 32, i * 32 + 32);
      lease.run(at + 120, token, row.id);
      return {
        ...row,
        attempts: row.attempts + 1,
        lease_token: token,
        lease_until: at + 120,
      };
    });
    db.exec("COMMIT");
    return claimed;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function finish(job, error = null, at = Date.now() / 1000) {
  if (!error)
    return statement("DELETE FROM jobs WHERE id=? AND lease_token=?").run(
      job.id,
      job.lease_token,
    ).changes;
  return statement(
    "UPDATE jobs SET lease_until=NULL,lease_token=NULL,available_at=?,status=?,last_error=? WHERE id=? AND lease_token=?",
  ).run(
    at + Math.min(300, 2 ** job.attempts),
    job.attempts >= 5 ? "dead" : "ready",
    String(error).slice(0, 1000),
    job.id,
    job.lease_token,
  ).changes;
}
// Imported lazily because domain.js imports this module; the promise is reused per job.
let domainImport, richtextImport;
const domainModule = () => (domainImport ||= import("./domain.js"));
const richtextModule = () => (richtextImport ||= import("./richtext.js"));
export async function perform(kind, data) {
  if (kind === "purge") {
    purgeBlob(data.blob_id);
    return;
  }
  if (kind === "media") {
    const blob = get(
      "SELECT * FROM active_storage_blobs WHERE id=?",
      data.blob_id,
    );
    if (blob) await processAttachment(blob);
    return;
  }
  const domain = await domainModule();
  if (kind === "ban-content") {
    for (const message of all(
      "SELECT * FROM messages WHERE creator_id=?",
      data.user_id,
    ))
      await domain.deleteMessage(message);
    return;
  }
  const message = get(
    "SELECT m.*,r.name AS room_name,r.type AS room_type,u.name AS creator_name FROM messages m JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=m.creator_id WHERE m.id=?",
    data.message_id,
  );
  if (!message) return;
  const body =
    get(
      "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
      message.id,
    )?.body || "";
  const { messagePlainText } = await richtextModule();
  async function reply(text, attachment = null) {
    let result;
    try {
      result = stagedFiles(() =>
        domain.createMessage(
          message.room_id,
          hookUserId,
          text,
          crypto.randomUUID(),
        ),
      );
      if (attachment) {
        const blob = storeUpload(
          attachment,
          "Message",
          result.id,
          "attachment",
        );
        await processAttachment(blob);
        domain.indexMessage(result.id, text, blob.filename);
      }
    } catch (error) {
      if (result) domain.deleteMessage(result, { broadcast: false });
      throw error;
    }
    domain.publishMessage(result);
    domain.notifyMessage(result, { webhooks: false });
    return result;
  }
  let hookUserId;
  if (kind === "webhook") {
    const hook = get(
      "SELECT w.*,u.name,u.bot_token,u.status FROM webhooks w JOIN users u ON u.id=w.user_id WHERE w.id=?",
      data.webhook_id,
    );
    if (
      !hook ||
      hook.status !== 0 ||
      !get(
        "SELECT id FROM memberships WHERE user_id=? AND room_id=?",
        hook.user_id,
        message.room_id,
      )
    )
      return;
    hookUserId = hook.user_id;
    const payload = {
      user: { id: message.creator_id, name: message.creator_name },
      room: {
        id: message.room_id,
        name: message.room_name,
        path: `/rooms/${message.room_id}/${hook.user_id}-${hook.bot_token}/messages`,
      },
      message: {
        id: message.id,
        body: {
          html: body,
          plain: messagePlainText(message.id, body)
            .replaceAll(`@${hook.name}`, "")
            .trim(),
        },
        path: `/rooms/${message.room_id}/@${message.id}`,
      },
    };
    const url = new URL(hook.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("invalid webhook URL");
    // Only administrators configure webhook endpoints; preserve legitimate internal bot services.
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const address = net.isIP(hostname)
      ? { address: hostname, family: net.isIP(hostname) }
      : await dns.lookup(hostname);
    let response;
    try {
      response = await requestPinned(url, address, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        maxBytes: 50 * 1024 * 1024,
      });
    } catch (error) {
      if (String(error).includes("timeout")) {
        await reply("Failed to respond within 7 seconds");
        return;
      }
      throw error;
    }
    const type = response.headers["content-type"]?.split(";")[0];
    if (response.status === 200 && ["text/plain", "text/html"].includes(type))
      await reply(response.body.toString("utf8"));
    else if (type && response.body.length) {
      const extensions = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "application/pdf": "pdf",
        "audio/mpeg": "mp3",
        "video/mp4": "mp4",
      };
      await reply("", {
        buffer: response.body,
        originalname: `attachment.${extensions[type] || "bin"}`,
        mimetype: type,
      });
    }
  } else if (kind === "push") {
    if (!process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) return;
    const payload = {
      title:
        message.room_type === "Rooms::Direct"
          ? message.creator_name
          : message.room_name,
      options: {
        body:
          message.room_type === "Rooms::Direct"
            ? messagePlainText(message.id, body)
            : `${message.creator_name}: ${messagePlainText(message.id, body)}`,
        data: {
          path: `/rooms/${message.room_id}`,
          badge: get(
            "SELECT count(*) AS n FROM memberships WHERE user_id=? AND unread_at IS NOT NULL",
            data.user_id,
          ).n,
        },
      },
    };
    for (const subscription of all(
      "SELECT * FROM push_subscriptions WHERE user_id=?",
      data.user_id,
    )) {
      let resolved;
      try {
        resolved = await resolvePublic(subscription.endpoint);
        if (resolved.url.protocol !== "https:") continue;
      } catch {
        continue;
      }
      const details = webpush.generateRequestDetails(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh_key,
            auth: subscription.auth_key,
          },
        },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: process.env.VAPID_SUBJECT || "mailto:campfire@example.com",
            publicKey: process.env.VAPID_PUBLIC_KEY,
            privateKey: process.env.VAPID_PRIVATE_KEY,
          },
        },
      );
      const response = await requestPinned(resolved.url, resolved.address, {
        method: details.method,
        headers: details.headers,
        body: details.body,
        maxBytes: 1024 * 1024,
      });
      if ([404, 410].includes(response.status))
        run("DELETE FROM push_subscriptions WHERE id=?", subscription.id);
      else if (response.status >= 400)
        throw new Error(`push HTTP ${response.status}`);
    }
  } else throw new Error(`unknown job ${kind}`);
}
async function execute(job) {
  const heartbeat = setInterval(() => {
    try {
      statement(
        "UPDATE jobs SET lease_until=? WHERE id=? AND lease_token=?",
      ).run(Date.now() / 1000 + 120, job.id, job.lease_token);
    } catch (error) {
      console.error("Campfire lease renewal failed:", error.message);
    }
  }, 30000);
  heartbeat.unref();
  try {
    const payload = JSON.parse(job.payload);
    await perform(payload.kind, payload.data);
    finish(job);
  } catch (error) {
    console.error("Campfire job failed:", error.message);
    try {
      finish(job, error);
    } catch (failure) {
      console.error("Campfire job bookkeeping failed:", failure.message);
    }
  } finally {
    clearInterval(heartbeat);
  }
}
export async function workOnce() {
  const job = claim();
  if (!job) return false;
  await execute(job);
  return true;
}
export function jobConcurrency() {
  const value = Number(process.env.JOB_CONCURRENCY);
  return Number.isInteger(value) && value > 0 ? value : 3;
}
export const activeJobs = () => active;
let refillScheduled = false;
function scheduleFill() {
  if (refillScheduled) return;
  refillScheduled = true;
  setImmediate(() => {
    refillScheduled = false;
    fill();
  });
}
function fill() {
  const free = jobConcurrency() - active;
  if (stopping || free <= 0) return;
  let claimed;
  try {
    claimed = claimMany(free);
  } catch (error) {
    console.error("Campfire queue failed:", error.message);
    return;
  }
  for (const job of claimed) {
    active++;
    execute(job).finally(() => {
      active--;
      // Jobs finishing in the same turn share one refill claim; the last one refills at once so
      // drainQueue only resolves when a claim found nothing left.
      if (active) return scheduleFill();
      fill();
      if (!active) for (const resolve of idle.splice(0)) resolve();
    });
  }
}
// Resolves once nothing is running and the last claim found no ready job.
export function drainQueue() {
  fill();
  return active
    ? new Promise((resolve) => idle.push(resolve))
    : Promise.resolve();
}
export function startWorker() {
  if (timer) return;
  stopping = false;
  timer = setInterval(fill, 250);
  timer.unref();
  fill();
}
export async function stopWorker() {
  stopping = true;
  clearInterval(timer);
  timer = null;
  if (active) await new Promise((resolve) => idle.push(resolve));
}
