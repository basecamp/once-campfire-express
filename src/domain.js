import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { all, get, run, transaction, now, onCommit, touch } from "./db.js";
import {
  sanitize,
  plainText,
  mentionIds,
  reconcileEmbeds,
} from "./richtext.js";
import { publish, publishMany, forgetUser } from "./cable.js";
import { stream } from "./rails.js";
import { cachedMessages } from "./rendering.js";
import { enqueue, enqueueMany } from "./jobs.js";
export const userById = (id) =>
  get("SELECT * FROM users WHERE id=?", Number(id));
export const roomsForUser = (id) =>
  all(
    "SELECT r.*,m.involvement,m.unread_at,m.id AS membership_id,m.updated_at AS membership_updated_at FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE m.user_id=? ORDER BY lower(r.name)",
    Number(id),
  );
export const roomForUser = (user, id) =>
  get(
    "SELECT r.* FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE m.user_id=? AND r.id=?",
    Number(user?.id ?? user),
    Number(id),
  );
const presentationColumns =
  "m.*,u.name AS creator_name,u.bio AS creator_bio,u.updated_at AS creator_updated_at,r.name AS room_name,r.type AS room_type";
const presentationJoins =
  "JOIN users u ON u.id=m.creator_id JOIN rooms r ON r.id=m.room_id";
export const presentation = `SELECT ${presentationColumns} FROM messages m ${presentationJoins}`;
// Pages the messages first and joins the 40 survivors. Equivalent to joining first because
// messages.creator_id and room_id are NOT NULL foreign keys (foreign_keys=ON), so the inner
// joins never drop a row.
export const pagedPresentation = (clauses, direction) =>
  `SELECT ${presentationColumns} FROM (SELECT * FROM messages WHERE ${clauses} ORDER BY created_at ${direction}, id ${direction} LIMIT 40) m ${presentationJoins} ORDER BY m.created_at ${direction}, m.id ${direction}`;
export const messageById = (id) =>
  get(presentation + " WHERE m.id=?", Number(id));
export function messagesByIds(ids) {
  if (!ids.length) return [];
  const rows = new Map(
    all(
      presentation + " WHERE m.id IN (SELECT value FROM json_each(?))",
      JSON.stringify(ids),
    ).map((row) => [row.id, row]),
  );
  return ids.map((id) => rows.get(id)).filter(Boolean);
}
export function refreshMessages(roomId, since) {
  // The browser cursor is milliseconds, while SQLite stores microseconds. Match
  // epoch(updated_at) > since without truncating the indexed column in SQL.
  if (since >= 8640000000000000) return [];
  const cutoff =
    since <= -8640000000000000
      ? ""
      : new Date(Math.floor(since) + 1)
          .toISOString()
          .replace("T", " ")
          .replace("Z", "");
  return all(
    "SELECT * FROM messages WHERE room_id=? AND updated_at>=? ORDER BY +created_at DESC,id DESC LIMIT 80",
    roomId,
    cutoff,
  ).reverse();
}
// Read newest FTS matches without sorting the entire history. Sparse memberships
// fall back after a bounded probe; hydration rechecks the current membership.
export function searchMessages(user, query) {
  const terms = query
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => '"' + word.replaceAll('"', '""') + '"')
    .join(" ");
  if (!terms) return [];
  const probe = all(
    "SELECT m.id, ms.user_id IS NOT NULL AS reachable FROM message_search_index idx JOIN messages m ON m.id=idx.rowid LEFT JOIN memberships ms ON ms.room_id=m.room_id AND ms.user_id=? WHERE idx.body MATCH ? ORDER BY idx.rowid DESC LIMIT 1000",
    user.id,
    terms,
  );
  let ids = probe
    .filter((row) => row.reachable)
    .slice(0, 100)
    .map((row) => row.id);
  if (ids.length < 100 && probe.length === 1000)
    ids = all(
      "SELECT m.id FROM messages m JOIN message_search_index idx ON idx.rowid=m.id JOIN memberships ms ON ms.room_id=m.room_id WHERE ms.user_id=? AND idx.body MATCH ? ORDER BY m.id DESC LIMIT 100",
      user.id,
      terms,
    ).map((row) => row.id);
  return all(
    presentation +
      " JOIN memberships ms ON ms.room_id=m.room_id WHERE ms.user_id=? AND m.id IN (SELECT value FROM json_each(?)) ORDER BY m.id",
    user.id,
    JSON.stringify(ids),
  );
}

export function directMembers(roomIds) {
  const members = new Map(roomIds.map((id) => [id, []]));
  if (roomIds.length)
    for (const row of all(
      "SELECT m.room_id AS member_room_id,u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.room_id IN (SELECT value FROM json_each(?)) ORDER BY u.name",
      JSON.stringify(roomIds),
    ))
      members.get(row.member_room_id).push(row);
  return members;
}
export function messagesForRoom(id, { before, after, around } = {}) {
  if (around) {
    const pivot = get(
      "SELECT * FROM messages WHERE id=? AND room_id=?",
      Number(around),
      Number(id),
    );
    if (!pivot) return messagesForRoom(id);
    return [
      ...all(
        presentation +
          " WHERE m.room_id=? AND m.created_at<? ORDER BY m.created_at DESC LIMIT 40",
        Number(id),
        pivot.created_at,
      ).reverse(),
      messageById(pivot.id),
      ...all(
        presentation +
          " WHERE m.room_id=? AND m.created_at>? ORDER BY m.created_at ASC LIMIT 40",
        Number(id),
        pivot.created_at,
      ),
    ];
  }
  let clauses = "room_id=?",
    args = [Number(id)];
  for (const [anchor, operator] of [
    [before, "<"],
    [after, ">"],
  ])
    if (anchor) {
      const pivot = get(
        "SELECT created_at FROM messages WHERE id=? AND room_id=?",
        Number(anchor),
        Number(id),
      );
      if (!pivot)
        throw Object.assign(new Error("Message not found"), { status: 404 });
      clauses += ` AND created_at${operator}?`;
      args.push(pivot.created_at);
    }
  const rows = all(pagedPresentation(clauses, after ? "ASC" : "DESC"), ...args);
  return after ? rows : rows.reverse();
}
export function grantMemberships(room, userIds) {
  const timestamp = now();
  for (const id of userIds)
    run(
      "INSERT OR IGNORE INTO memberships(room_id,user_id,involvement,created_at,updated_at) VALUES(?,?,?,?,?)",
      room.id,
      Number(id),
      room.type === "Rooms::Direct" ? "everything" : "mentions",
      timestamp,
      timestamp,
    );
}
export function createUser({
  name,
  email_address = null,
  password = "",
  role = 0,
  bot_token = null,
}) {
  if (!name?.trim() || (role !== 2 && (!email_address || !password)))
    throw Object.assign(new Error("Name, email and password required"), {
      status: 422,
    });
  return transaction(() => {
    const time = now();
    const result = run(
      "INSERT INTO users(name,email_address,password_digest,role,bot_token,status,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)",
      name,
      email_address,
      bcrypt.hashSync(password, 12),
      role,
      bot_token,
      time,
      time,
    );
    const user = userById(Number(result.lastInsertRowid));
    for (const room of all("SELECT * FROM rooms WHERE type='Rooms::Open'"))
      grantMemberships(room, [user.id]);
    return user;
  });
}
export function indexMessage(id, body, filename = "") {
  run("DELETE FROM message_search_index WHERE rowid=?", Number(id));
  run(
    "INSERT INTO message_search_index(rowid,body) VALUES(?,?)",
    Number(id),
    plainText(body) || filename,
  );
}
export function createMessage(roomId, userId, body = "", clientId = null) {
  return transaction(() => {
    if (
      !get(
        "SELECT id FROM memberships WHERE room_id=? AND user_id=?",
        Number(roomId),
        Number(userId),
      )
    )
      throw Object.assign(new Error("Room membership required"), {
        status: 403,
      });
    const time = now(),
      content = sanitize(body);
    const result = run(
      "INSERT INTO messages(room_id,creator_id,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      Number(roomId),
      Number(userId),
      clientId || randomUUID(),
      time,
      time,
    );
    const id = Number(result.lastInsertRowid);
    run(
      "INSERT INTO action_text_rich_texts(name,record_type,record_id,body,created_at,updated_at) VALUES('body','Message',?,?,?,?)",
      id,
      content,
      time,
      time,
    );
    reconcileEmbeds(
      get(
        "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
        id,
      ).id,
      content,
      Number(userId),
    );
    indexMessage(id, content);
    run("UPDATE rooms SET updated_at=? WHERE id=?", time, Number(roomId));
    const cutoff = new Date(Date.now() - 60000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    run(
      "UPDATE memberships SET unread_at=?,updated_at=? WHERE room_id=? AND user_id<>? AND involvement<>'invisible' AND (connected_at IS NULL OR connected_at<?)",
      time,
      time,
      Number(roomId),
      Number(userId),
      cutoff,
    );
    return messageById(id);
  });
}
export function updateMessage(
  message,
  body = null,
  userId = message.creator_id,
) {
  transaction(() => {
    const time = now();
    if (body !== null) {
      const content = sanitize(body);
      run(
        "INSERT INTO action_text_rich_texts(name,record_type,record_id,body,created_at,updated_at) VALUES('body','Message',?,?,?,?) ON CONFLICT(record_type,record_id,name) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
        message.id,
        content,
        time,
        time,
      );
      const obsolete = reconcileEmbeds(
        get(
          "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
          message.id,
        ).id,
        content,
        userId,
      );
      onCommit(() => {
        for (const blobId of obsolete) enqueue("purge", { blob_id: blobId });
      });
      const attachment = get(
        "SELECT b.filename FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='Message' AND a.record_id=? AND a.name='attachment'",
        message.id,
      );
      indexMessage(message.id, content, attachment?.filename || "");
    }
    touch("messages", message.id);
    run("UPDATE rooms SET updated_at=? WHERE id=?", time, message.room_id);
  });
  return messageById(message.id);
}
export function deleteMessage(message, { broadcast = true } = {}) {
  if (typeof message === "number") message = messageById(message);
  if (!message) return;
  const richIds = all(
    "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
    message.id,
  ).map((r) => r.id);
  const blobIds = all(
    "SELECT blob_id FROM active_storage_attachments WHERE record_type='Message' AND record_id=?",
    message.id,
  ).map((a) => a.blob_id);
  for (const id of richIds)
    blobIds.push(
      ...all(
        "SELECT blob_id FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=?",
        id,
      ).map((a) => a.blob_id),
    );
  transaction(() => {
    run("DELETE FROM boosts WHERE message_id=?", message.id);
    for (const id of richIds)
      run(
        "DELETE FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=?",
        id,
      );
    run(
      "DELETE FROM active_storage_attachments WHERE record_type='Message' AND record_id=?",
      message.id,
    );
    run(
      "DELETE FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
      message.id,
    );
    run("DELETE FROM message_search_index WHERE rowid=?", message.id);
    run("DELETE FROM messages WHERE id=?", message.id);
    run("UPDATE rooms SET updated_at=? WHERE id=?", now(), message.room_id);
  });
  onCommit(() => {
    for (const id of blobIds) enqueue("purge", { blob_id: id });
    if (broadcast) publishMessage(message, "remove");
  });
}
export function publishMessage(message, action = "append") {
  const room = get("SELECT * FROM rooms WHERE id=?", message.room_id);
  if (!room) return;
  const target =
    action === "append"
      ? `messages_rooms_${room.type.split("::").pop().toLowerCase()}_${room.id}`
      : `message_${message.client_message_id}`;
  const html =
    action === "remove"
      ? ""
      : String(cachedMessages([messageById(message.id)])[0].Fragment);
  const events = [
    {
      stream: stream(room),
      message: `<turbo-stream action="${action}" target="${target}"><template>${html}</template></turbo-stream>`,
    },
  ];
  if (action === "append")
    for (const m of all(
      "SELECT user_id FROM memberships WHERE room_id=?",
      room.id,
    ))
      events.push({
        stream: `user_${m.user_id}_unreads`,
        message: { roomId: room.id },
      });
  publishMany(events);
}
export function notifyMessage(message, { webhooks = true } = {}) {
  const body =
      get(
        "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
        message.id,
      )?.body || "",
    mentions = mentionIds(body),
    room = get("SELECT * FROM rooms WHERE id=?", message.room_id),
    jobs = [];
  for (const m of all(
    "SELECT m.*,u.role,u.status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.room_id=? AND m.user_id<>?",
    message.room_id,
    message.creator_id,
  )) {
    if (m.status !== 0) continue;
    if (
      webhooks &&
      m.role === 2 &&
      (room.type === "Rooms::Direct" || mentions.has(m.user_id))
    )
      for (const w of all("SELECT id FROM webhooks WHERE user_id=?", m.user_id))
        jobs.push({
          kind: "webhook",
          data: { webhook_id: w.id, message_id: message.id },
        });
    if (
      (!m.connected_at ||
        Date.now() - Date.parse(m.connected_at + "Z") > 60000) &&
      (m.involvement === "everything" ||
        (m.involvement === "mentions" && mentions.has(m.user_id)))
    )
      jobs.push({
        kind: "push",
        data: { user_id: m.user_id, message_id: message.id },
      });
  }
  if (jobs.length) enqueueMany(jobs);
}
export function deleteRoom(room) {
  for (const message of all("SELECT * FROM messages WHERE room_id=?", room.id))
    deleteMessage(message);
  const memberIds = all(
    "SELECT user_id FROM memberships WHERE room_id=?",
    room.id,
  ).map((m) => m.user_id);
  transaction(() => {
    run("DELETE FROM memberships WHERE room_id=?", room.id);
    run("DELETE FROM rooms WHERE id=?", room.id);
  });
  for (const id of memberIds) forgetUser(id);
  publish(
    "rooms",
    `<turbo-stream action="remove" target="list_rooms_${room.type.split("::").pop().toLowerCase()}_${room.id}"></turbo-stream>`,
  );
}
