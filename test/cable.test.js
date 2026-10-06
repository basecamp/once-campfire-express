import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import WebSocket from "ws";
import { initialize, run, get, now } from "../src/db.js";
import {
  attachCable,
  broadcastFrame,
  publish,
  publishMany,
  authChecks,
  forgetUser,
  indexedSubscriptions,
} from "../src/cable.js";
import { createMessage, publishMessage } from "../src/domain.js";
import { signCookie, signStream, stream } from "../src/rails.js";
let server, base, storage;
const room = { id: 1, type: "Rooms::Open" };
before(async () => {
  mkdirSync("tmp", { recursive: true });
  storage = mkdtempSync("tmp/cable-");
  process.env.DATABASE_PATH = storage + "/app.sqlite3";
  process.env.SECRET_KEY_BASE = "native-cable-tests-only";
  initialize();
  const t = now();
  for (const id of [1, 2])
    run(
      "INSERT INTO users(id,name,role,status,created_at,updated_at) VALUES(?,?,0,0,?,?)",
      id,
      "User" + id,
      t,
      t,
    );
  run(
    "INSERT INTO rooms(id,name,type,creator_id,created_at,updated_at) VALUES(1,?, ?,1,?,?)",
    "Public",
    room.type,
    t,
    t,
  );
  run(
    "INSERT INTO memberships(room_id,user_id,created_at,updated_at) VALUES(1,1,?,?)",
    t,
    t,
  );
  run(
    "INSERT INTO sessions(id,user_id,token,last_active_at,created_at,updated_at) VALUES(1,1,?,?,?,?)",
    "socket-token",
    t,
    t,
    t,
  );
  server = http.createServer((req, res) => res.end("ok"));
  attachCable(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `ws://127.0.0.1:${server.address().port}/cable`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(storage, { recursive: true, force: true });
});
async function connect() {
  const ws = new WebSocket(base, ["actioncable-v1-json"], {
    headers: {
      Cookie:
        "session_token=" +
        encodeURIComponent(signCookie("session_token", "socket-token")),
    },
  });
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw)));
  await once(ws, "open");
  return { ws, frames };
}
async function wait(predicate) {
  const end = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("socket timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const pastTtl = () =>
  new Promise((r) =>
    setTimeout(r, Number(process.env.CABLE_AUTH_TTL_MS || 1000) + 100),
  );
const id = () =>
  JSON.stringify({
    channel: "RoomMessagesChannel",
    signed_stream_name: signStream(stream(room)),
  });
test("Action Cable authenticates, subscribes and delivers native publications", async () => {
  const { ws, frames } = await connect();
  const identifier = id();
  ws.send(JSON.stringify({ command: "subscribe", identifier }));
  await wait(() => frames.some((f) => f.type === "confirm_subscription"));
  publish(stream(room), "<turbo-stream>actual message</turbo-stream>");
  await wait(() => frames.some((f) => f.message?.includes?.("actual message")));
  assert.equal(frames[0].type, "welcome");
  ws.close();
  await once(ws, "close");
});
test("Action Cable rejects forged signed streams and revoked membership", async () => {
  const { ws, frames } = await connect();
  const forged = JSON.stringify({
    channel: "RoomMessagesChannel",
    signed_stream_name: "forged",
  });
  ws.send(JSON.stringify({ command: "subscribe", identifier: forged }));
  await wait(() => frames.some((f) => f.type === "reject_subscription"));
  const identifier = id();
  ws.send(JSON.stringify({ command: "subscribe", identifier }));
  await wait(() => frames.some((f) => f.type === "confirm_subscription"));
  run("DELETE FROM memberships WHERE room_id=1 AND user_id=1");
  await pastTtl();
  publish(stream(room), "private-after-revoke");
  await wait(() =>
    frames.some(
      (f) => f.type === "reject_subscription" && f.identifier === identifier,
    ),
  );
  assert(!frames.some((f) => f.message === "private-after-revoke"));
  const t = now();
  run(
    "INSERT INTO memberships(room_id,user_id,created_at,updated_at) VALUES(1,1,?,?)",
    t,
    t,
  );
  ws.close();
  await once(ws, "close");
});
test("Presence refresh supports simultaneous tabs and uses room_id reads", async () => {
  const a = await connect(),
    b = await connect();
  const identifier = JSON.stringify({ channel: "PresenceChannel", room_id: 1 });
  for (const c of [a, b])
    c.ws.send(JSON.stringify({ command: "subscribe", identifier }));
  await wait(
    () =>
      get("SELECT connections FROM memberships WHERE room_id=1 AND user_id=1")
        .connections === 2,
  );
  a.ws.send(
    JSON.stringify({
      command: "message",
      identifier,
      data: JSON.stringify({ action: "refresh" }),
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    get("SELECT connections FROM memberships WHERE room_id=1 AND user_id=1")
      .connections,
    2,
  );
  a.ws.close();
  await once(a.ws, "close");
  await wait(
    () =>
      get("SELECT connections FROM memberships WHERE room_id=1 AND user_id=1")
        .connections === 1,
  );
  b.ws.close();
  await once(b.ws, "close");
  await wait(
    () =>
      get("SELECT connections FROM memberships WHERE room_id=1 AND user_id=1")
        .connections === 0,
  );
});
test("Logout stops delivery to an existing socket once the auth memo expires", async () => {
  const { ws, frames } = await connect();
  ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
  await wait(() => frames.some((f) => f.type === "confirm_subscription"));
  run("DELETE FROM sessions WHERE id=1");
  const closed = once(ws, "close");
  await pastTtl();
  publish(stream(room), "after-logout");
  await closed;
  assert(!frames.some((f) => f.message === "after-logout"));
  assert(
    frames.some(
      (f) =>
        f.type === "disconnect" &&
        f.reason === "unauthorized" &&
        f.reconnect === false,
    ),
  );
});
test("forgetUser makes the next publish re-check without waiting for the TTL", async () => {
  const t = now();
  run(
    "INSERT OR IGNORE INTO sessions(id,user_id,token,last_active_at,created_at,updated_at) VALUES(1,1,?,?,?,?)",
    "socket-token",
    t,
    t,
    t,
  );
  const { ws, frames } = await connect();
  ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
  await wait(() => frames.some((f) => f.type === "confirm_subscription"));
  publish(stream(room), "warm-memo");
  await wait(() => frames.some((f) => f.message === "warm-memo"));
  run("DELETE FROM sessions WHERE id=1");
  const closed = once(ws, "close");
  forgetUser(1);
  forgetUser("1");
  publish(stream(room), "after-forget");
  await closed;
  assert(!frames.some((f) => f.message === "after-forget"));
  assert(frames.some((f) => f.type === "disconnect"));
});
test("publishMessage delivers the room event then one unread event per member", async () => {
  const t = now();
  run(
    "INSERT OR IGNORE INTO sessions(id,user_id,token,last_active_at,created_at,updated_at) VALUES(1,1,?,?,?,?)",
    "socket-token",
    t,
    t,
    t,
  );
  run(
    "INSERT OR IGNORE INTO memberships(room_id,user_id,created_at,updated_at) VALUES(1,1,?,?)",
    t,
    t,
  );
  const { ws, frames } = await connect();
  ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
  const unreads = JSON.stringify({ channel: "UnreadRoomsChannel" });
  ws.send(JSON.stringify({ command: "subscribe", identifier: unreads }));
  await wait(
    () => frames.filter((f) => f.type === "confirm_subscription").length === 2,
  );
  publishMessage(createMessage(1, 1, "batched hello"));
  await wait(() => frames.some((f) => f.message?.roomId === 1));
  const delivered = frames.filter((f) => f.message);
  assert.match(delivered[0].message, /batched hello/);
  assert.deepEqual(delivered[1].message, { roomId: 1 });
  ws.close();
  await once(ws, "close");
});
test("Fan-out checks authorization at most once per TTL", async () => {
  const t = now();
  run(
    "INSERT OR IGNORE INTO sessions(id,user_id,token,last_active_at,created_at,updated_at) VALUES(1,1,?,?,?,?)",
    "socket-token",
    t,
    t,
    t,
  );
  const { ws, frames } = await connect();
  ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
  await wait(() => frames.some((f) => f.type === "confirm_subscription"));
  const before = authChecks();
  for (let i = 0; i < 20; i++) publish(stream(room), "burst-" + i);
  await wait(
    () => frames.filter((f) => f.message?.startsWith?.("burst-")).length === 20,
  );
  assert(authChecks() - before <= 1);
  ws.close();
  await once(ws, "close");
});
test("publishMany delivers every event in the batch", async () => {
  const { ws, frames } = await connect();
  ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
  await wait(() => frames.some((f) => f.type === "confirm_subscription"));
  publishMany(
    Array.from({ length: 5 }, (_, i) => ({
      stream: stream(room),
      message: "batch-" + i,
    })),
  );
  await wait(
    () => frames.filter((f) => f.message?.startsWith?.("batch-")).length === 5,
  );
  ws.close();
  await once(ws, "close");
});
test("One publish is serialized once per identifier and sent byte-identically", async () => {
  const rawFrames = [];
  const open = async () => {
    const c = await connect();
    c.ws.on("message", (raw) => rawFrames.push(raw.toString()));
    c.ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
    await wait(() => c.frames.some((f) => f.type === "confirm_subscription"));
    return c;
  };
  const a = await open(),
    b = await open();
  const marker = "shared-frame-marker";
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = function (value, ...rest) {
    if (value?.message === marker) calls++;
    return stringify.call(this, value, ...rest);
  };
  try {
    publish(stream(room), marker);
  } finally {
    JSON.stringify = stringify;
  }
  await wait(() => rawFrames.filter((f) => f.includes(marker)).length === 2);
  const [first, second] = rawFrames.filter((f) => f.includes(marker));
  assert.equal(first, second);
  assert.equal(first, stringify({ identifier: id(), message: marker }));
  assert.equal(calls, 1);
  for (const c of [a, b]) {
    c.ws.close();
    await once(c.ws, "close");
  }
});
test("broadcastFrame caches per identifier", () => {
  const cache = new Map();
  assert.equal(
    broadcastFrame(cache, "i", "m"),
    JSON.stringify({ identifier: "i", message: "m" }),
  );
  assert.equal(
    broadcastFrame(cache, "i", "other"),
    broadcastFrame(cache, "i", "m"),
  );
  assert.equal(cache.size, 1);
});
test("A client that fails alive() is checked once per batch, not per event", async () => {
  const t = now();
  run(
    "INSERT OR IGNORE INTO sessions(id,user_id,token,last_active_at,created_at,updated_at) VALUES(1,1,?,?,?,?)",
    "socket-token",
    t,
    t,
    t,
  );
  const { ws, frames } = await connect();
  ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
  await wait(() => frames.some((f) => f.type === "confirm_subscription"));
  run("DELETE FROM sessions WHERE id=1");
  forgetUser(1);
  const closed = once(ws, "close");
  const before = authChecks();
  publishMany(
    Array.from({ length: 5 }, (_, i) => ({
      stream: stream(room),
      message: "dead-" + i,
    })),
  );
  await closed;
  assert.equal(authChecks() - before, 1);
});
test("Unauthenticated sockets are denied before upgrade", async () => {
  const ws = new WebSocket(base, ["actioncable-v1-json"]);
  // Not events.once: Bun's ws shim forwards one failure once per on("error")
  // registration and once() registers via both once() and on(), so a copy goes unhandled.
  await new Promise((resolve) => ws.on("error", resolve));
  assert.equal(ws.readyState, WebSocket.CLOSED);
});
async function subscribed(identifier) {
  const t = now();
  run(
    "INSERT OR IGNORE INTO sessions(id,user_id,token,last_active_at,created_at,updated_at) VALUES(1,1,?,?,?,?)",
    "socket-token",
    t,
    t,
    t,
  );
  run(
    "INSERT OR IGNORE INTO memberships(room_id,user_id,created_at,updated_at) VALUES(1,1,?,?)",
    t,
    t,
  );
  const c = await connect();
  c.ws.send(JSON.stringify({ command: "subscribe", identifier }));
  await wait(() => c.frames.some((f) => f.type === "confirm_subscription"));
  return c;
}
const closeAll = async (list) => {
  for (const c of list) {
    c.ws.close();
    await once(c.ws, "close");
  }
};
test("Delivery reaches only subscribers of the target stream", async () => {
  const reads = JSON.stringify({ channel: "ReadRoomsChannel" });
  const a = await subscribed(id()),
    b = await subscribed(reads);
  publish(stream(room), "only-room");
  await wait(() => a.frames.some((f) => f.message === "only-room"));
  publish("user_1_reads", "only-reads");
  await wait(() => b.frames.some((f) => f.message === "only-reads"));
  assert(!b.frames.some((f) => f.message === "only-room"));
  assert(!a.frames.some((f) => f.message === "only-reads"));
  await closeAll([a, b]);
});
test("Stream index is cleaned on unsubscribe, reject and close", async () => {
  await wait(() => indexedSubscriptions() === 0);
  const base0 = 0;
  const c = await subscribed(id());
  assert.equal(indexedSubscriptions(), base0 + 1);
  c.ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
  c.ws.send(JSON.stringify({ command: "unsubscribe", identifier: id() }));
  await wait(() => indexedSubscriptions() === base0);
  c.ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
  await wait(() => indexedSubscriptions() === base0 + 1);
  run("DELETE FROM memberships WHERE room_id=1 AND user_id=1");
  forgetUser(1);
  publish(stream(room), "reject-me");
  await wait(() => c.frames.some((f) => f.type === "reject_subscription"));
  assert.equal(indexedSubscriptions(), base0);
  const t = now();
  run(
    "INSERT INTO memberships(room_id,user_id,created_at,updated_at) VALUES(1,1,?,?)",
    t,
    t,
  );
  c.ws.send(JSON.stringify({ command: "subscribe", identifier: id() }));
  await wait(() => indexedSubscriptions() === base0 + 1);
  await closeAll([c]);
  await wait(() => indexedSubscriptions() === base0);
});
test("Fan-out across 50 sockets and 2 streams delivers exact counts", async () => {
  const reads = JSON.stringify({ channel: "ReadRoomsChannel" });
  const sockets = [];
  for (let i = 0; i < 50; i++)
    sockets.push(await subscribed(i % 2 ? reads : id()));
  publishMany([
    { stream: stream(room), message: "fan-room-1" },
    { stream: "user_1_reads", message: "fan-reads-1" },
    { stream: stream(room), message: "fan-room-2" },
  ]);
  const msgs = (c) => c.frames.filter((f) => f.message).map((f) => f.message);
  await wait(() => sockets.every((c, i) => msgs(c).length === (i % 2 ? 1 : 2)));
  sockets.forEach((c, i) =>
    assert.deepEqual(
      msgs(c),
      i % 2 ? ["fan-reads-1"] : ["fan-room-1", "fan-room-2"],
    ),
  );
  await closeAll(sockets);
  await wait(() => indexedSubscriptions() === 0);
});
