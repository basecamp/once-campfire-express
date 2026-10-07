import { WebSocketServer, WebSocket } from "ws";
import cluster from "node:cluster";
import { get, run, now, transaction } from "./db.js";
import * as rails from "./rails.js";
// Keep the socket module independent from the HTTP router to avoid import cycles.
function identity(header = "") {
  try {
    const part = header
      .split(";")
      .find((p) => p.trim().startsWith("session_token="));
    if (!part) return null;
    const raw = part.trim().slice("session_token=".length),
      token = rails.verifyCookie("session_token", raw);
    return get(
      "SELECT s.id AS session_id,u.id AS user_id,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.status=0 AND u.role<>2",
      token,
    );
  } catch {
    return null;
  }
}
const clients = new Set();
const streamIndex = new Map();
export const indexedSubscriptions = () => {
  let n = 0;
  for (const subs of streamIndex.values()) n += subs.size;
  return n;
};
function unindex(sub) {
  const subs = streamIndex.get(sub.stream);
  if (!subs) return;
  subs.delete(sub);
  if (!subs.size) streamIndex.delete(sub.stream);
}
function removeSubscription(client, identifier) {
  const sub = client.subscriptions.get(identifier);
  if (!sub) return;
  client.subscriptions.delete(identifier);
  unindex(sub);
}
function addSubscription(client, identifier, sub) {
  removeSubscription(client, identifier);
  sub.client = client;
  sub.identifier = identifier;
  client.subscriptions.set(identifier, sub);
  let subs = streamIndex.get(sub.stream);
  if (!subs) streamIndex.set(sub.stream, (subs = new Set()));
  subs.add(sub);
}
const AUTH_TTL = Number(process.env.CABLE_AUTH_TTL_MS || 1000);
let authCheckCount = 0;
export const authChecks = () => authCheckCount;
// Revocation reaches open sockets within AUTH_TTL instead of on the very next
// broadcast; the 3-second ping bounds it the same way.
function alive(client) {
  const at = Date.now();
  if (client.aliveUntil > at) return true;
  authCheckCount++;
  const ok = Boolean(
    get(
      "SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND u.status=0 AND u.role<>2",
      client.session_id,
      client.user_id,
    ),
  );
  client.aliveUntil = ok ? at + AUTH_TTL : 0;
  return ok;
}
export function forgetUser(userId) {
  for (const client of clients) {
    if (client.user_id !== Number(userId)) continue;
    client.aliveUntil = 0;
    for (const sub of client.subscriptions.values()) sub.authorizedUntil = 0;
  }
}
function authorize(client, identifier) {
  try {
    if (!alive(client)) return null;
    const p = JSON.parse(identifier);
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const channel = p.channel;
    let room = 0,
      stream = "";
    if (["ApplicationCable::Channel", "HeartbeatChannel"].includes(channel)) {
    } else if (["ReadRoomsChannel", "UnreadRoomsChannel"].includes(channel))
      stream = `user_${client.user_id}_${channel === "ReadRoomsChannel" ? "reads" : "unreads"}`;
    else if (channel === "RoomMessagesChannel") {
      stream = rails.verifyStream(p.signed_stream_name);
      if (typeof stream !== "string") return null;
      const [encoded, suffix, ...rest] = stream.split(":");
      if (suffix !== "messages" || rest.length) return null;
      const m = rails
        .decode64(encoded)
        .toString()
        .match(
          /^gid:\/\/campfire\/(Room|Rooms::Open|Rooms::Closed|Rooms::Direct)\/(\d+)$/,
        );
      if (!m) return null;
      room = Number(m[2]);
      const r = get(
        "SELECT r.* FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE r.id=? AND m.user_id=?",
        room,
        client.user_id,
      );
      if (!r || !["Room", r.type].includes(m[1])) return null;
    } else if (
      ["RoomChannel", "PresenceChannel", "TypingNotificationsChannel"].includes(
        channel,
      )
    ) {
      room = Number(p.room_id);
      if (
        !Number.isSafeInteger(room) ||
        !get(
          "SELECT id FROM memberships WHERE room_id=? AND user_id=?",
          room,
          client.user_id,
        )
      )
        return null;
      stream = channel + ":" + room;
    } else if (channel === "Turbo::StreamsChannel") {
      stream = rails.verifyStream(p.signed_stream_name);
      const own =
        Buffer.from(`gid://campfire/User/${client.user_id}`)
          .toString("base64")
          .replace(/=+$/, "") + ":rooms";
      if (!["rooms", own].includes(stream)) return null;
    } else return null;
    return { channel, room, stream };
  } catch {
    return null;
  }
}
function sendRaw(client, text) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (client.ws.bufferedAmount > 1024 * 1024) {
    client.ws.close(1013, "slow consumer");
    return;
  }
  client.ws.send(text);
}
function frame(client, value) {
  sendRaw(client, JSON.stringify(value));
}
export function broadcastFrame(cache, identifier, message) {
  let text = cache.get(identifier);
  if (text === undefined) {
    text = JSON.stringify({ identifier, message });
    cache.set(identifier, text);
  }
  return text;
}
function deliverOne(stream, message) {
  const subs = streamIndex.get(stream);
  if (!subs) return;
  const frames = new Map();
  for (const sub of subs) {
    const { client, identifier } = sub;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (!alive(client)) {
      frame(client, {
        type: "disconnect",
        reason: "unauthorized",
        reconnect: false,
      });
      client.ws.close(1008);
      continue;
    }
    if (!(sub.authorizedUntil > Date.now())) {
      if (!authorize(client, identifier)) {
        removeSubscription(client, identifier);
        frame(client, { type: "reject_subscription", identifier });
        continue;
      }
      sub.authorizedUntil = Date.now() + AUTH_TTL;
    }
    sendRaw(client, broadcastFrame(frames, identifier, message));
  }
}
export function deliver(stream, message) {
  deliverOne(stream, message);
}
export function deliverBatch(events) {
  for (const event of events) deliverOne(event.stream, event.message);
}
// The publishing worker delivers to its own sockets directly; the primary relays to the others,
// so a broadcast is serialized and parsed once less. Workers may see concurrent broadcasts in
// different orders; the client re-sorts appended messages by sort value.
export function publishMany(events) {
  if (!events.length) return;
  deliverBatch(events);
  if (cluster.isWorker)
    process.send?.({ type: "cable-batch", events, origin: cluster.worker.id });
  else relayCable({ type: "cable-batch", events });
}
export function relayCable(event, workers = cluster.workers || {}) {
  for (const worker of Object.values(workers))
    if (worker.id !== event.origin) worker.send(event);
}
export function publish(stream, message) {
  publishMany([{ stream, message }]);
}
function presence(user, room, action) {
  transaction(() => {
    const m = get(
      "SELECT * FROM memberships WHERE user_id=? AND room_id=?",
      user,
      room,
    );
    if (!m) return;
    const active =
      m.connected_at &&
      new Date(m.connected_at.replace(" ", "T") + "Z").getTime() >=
        Date.now() - 60000;
    if (["present", "refresh"].includes(action)) {
      const count = active
        ? action === "present"
          ? Number(m.connections) + 1
          : Number(m.connections)
        : 1;
      run(
        "UPDATE memberships SET connections=?,connected_at=?,unread_at=NULL,updated_at=? WHERE id=?",
        count,
        now(),
        now(),
        m.id,
      );
    } else {
      const count = active ? Math.max(0, Number(m.connections) - 1) : 0;
      run(
        "UPDATE memberships SET connections=?,connected_at=?,updated_at=? WHERE id=?",
        count,
        count ? m.connected_at : null,
        now(),
        m.id,
      );
    }
  });
  if (action === "present") publish(`user_${user}_reads`, { room_id: room });
}
export function attachCable(server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    handleProtocols: (protocols) =>
      protocols.has("actioncable-v1-json") ? "actioncable-v1-json" : false,
  });
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname !== "/cable") {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "");
    const trusted = (process.env.TRUSTED_PROXIES || "")
      .split(",")
      .includes(remote);
    const forwarded = trusted && req.headers["x-forwarded-proto"];
    const protocol = forwarded === "https" ? "https" : "http";
    if (origin && origin !== protocol + "://" + req.headers.host) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const id = identity(req.headers.cookie);
    if (
      !id ||
      !req.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((s) => s.trim())
        .includes("actioncable-v1-json")
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { ...id, ws, subscriptions: new Map() };
      clients.add(client);
      frame(client, { type: "welcome" });
      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          ws.close(1003);
          return;
        }
        try {
          const msg = JSON.parse(raw.toString());
          const identifier = msg.identifier;
          if (typeof identifier !== "string" || identifier.length > 8192)
            return ws.close(1008);
          if (msg.command === "subscribe") {
            if (
              client.subscriptions.size >= 32 &&
              !client.subscriptions.has(identifier)
            )
              return ws.close(1008);
            const sub = authorize(client, identifier);
            if (!sub) {
              frame(client, { type: "reject_subscription", identifier });
              return;
            }
            if (sub.channel === "PresenceChannel") {
              const existing = client.subscriptions.get(identifier);
              sub.present = existing ? existing.present : true;
              if (!existing) presence(client.user_id, sub.room, "present");
            }
            addSubscription(client, identifier, sub);
            frame(client, { type: "confirm_subscription", identifier });
          } else if (msg.command === "unsubscribe") {
            const sub = client.subscriptions.get(identifier);
            if (sub?.channel === "PresenceChannel" && sub.present)
              presence(client.user_id, sub.room, "absent");
            removeSubscription(client, identifier);
          } else if (
            msg.command === "message" &&
            client.subscriptions.has(identifier)
          ) {
            const sub = authorize(client, identifier);
            if (!sub) return;
            const body = JSON.parse(msg.data);
            if (sub.channel === "PresenceChannel") {
              const stored = client.subscriptions.get(identifier);
              if (body.action === "refresh" && stored.present)
                presence(client.user_id, sub.room, "refresh");
              else if (body.action === "absent" && stored.present) {
                presence(client.user_id, sub.room, "absent");
                stored.present = false;
              } else if (body.action === "present" && !stored.present) {
                presence(client.user_id, sub.room, "present");
                stored.present = true;
              }
            } else if (
              sub.channel === "TypingNotificationsChannel" &&
              ["start", "stop"].includes(body.action)
            )
              publish(sub.stream, {
                action: body.action,
                user: { id: client.user_id, name: client.name },
              });
          }
        } catch {
          ws.close(1008);
        }
      });
      ws.on("close", () => {
        clients.delete(client);
        for (const sub of client.subscriptions.values()) {
          unindex(sub);
          if (sub.channel === "PresenceChannel" && sub.present)
            presence(client.user_id, sub.room, "absent");
        }
        client.subscriptions.clear();
      });
    });
  });
  const ping = setInterval(() => {
    for (const client of clients) {
      if (!alive(client)) {
        frame(client, {
          type: "disconnect",
          reason: "unauthorized",
          reconnect: false,
        });
        client.ws.close(1008);
      } else
        frame(client, { type: "ping", message: Math.floor(Date.now() / 1000) });
    }
  }, 3000);
  ping.unref();
  server.on("close", () => {
    clearInterval(ping);
    for (const c of clients) c.ws.terminate();
    wss.close();
  });
  if (cluster.isWorker)
    process.on("message", (event) => {
      if (event?.type === "cable") deliver(event.stream, event.message);
      else if (event?.type === "cable-batch") deliverBatch(event.events);
    });
  return wss;
}
