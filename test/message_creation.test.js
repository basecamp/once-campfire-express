import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
process.env.SECRET_KEY_BASE = "message-creation-tests-".repeat(8);
const temp = mkdtempSync(join(tmpdir(), "campfire-message-creation-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { initialize, run, get, all, now, queryCount } =
  await import("../src/db.js");
const domain = await import("../src/domain.js");
const rails = await import("../src/rails.js");
const { createApp } = await import("../src/app.js");
const { cachedMessages, messageFragments } =
  await import("../src/rendering.js");
let user, member, room, server, base, cookie;
before(async () => {
  initialize();
  const time = now();
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
    "Messages",
    "messages",
    time,
    time,
  );
  user = domain.createUser({
    name: "Writer",
    email_address: "writer@example.test",
    password: "password",
    role: 1,
  });
  member = domain.createUser({
    name: "Reader",
    email_address: "reader@example.test",
    password: "password",
    role: 0,
  });
  room = Number(
    run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      "Messages",
      "Rooms::Open",
      user.id,
      time,
      time,
    ).lastInsertRowid,
  );
  domain.grantMemberships(get("SELECT * FROM rooms WHERE id=?", room), [
    user.id,
    member.id,
  ]);
  run(
    "INSERT INTO sessions(user_id,token,last_active_at,created_at,updated_at) VALUES(?,?,?,?,?)",
    user.id,
    "writer-session",
    "2099-01-01 00:00:00",
    time,
    time,
  );
  cookie =
    "session_token=" +
    encodeURIComponent(rails.signCookie("session_token", "writer-session"));
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
});
test("new rich HTML messages avoid reading their just-inserted rich-text ID and deleting a nonexistent index row", () => {
  const before = queryCount();
  const message = domain.createMessage(
    room,
    user.id,
    "<p>Fish &amp; <strong>chips</strong> café</p>",
  );
  assert.ok(
    queryCount() - before <= 8,
    `creation executed ${queryCount() - before} queries`,
  );
  assert.equal(
    get("SELECT body FROM message_search_index WHERE rowid=?", message.id).body,
    "Fish & chips café",
  );
  assert.ok(
    get(
      "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
      message.id,
    ).body.includes("<strong>chips</strong>"),
  );
});
test("creation preserves native mention indexing and later updates replace old FTS content", () => {
  const message = domain.createMessage(
    room,
    user.id,
    `<p>Hello <action-text-attachment sgid="${rails.sgid("User", member.id)}"></action-text-attachment></p>`,
  );
  assert.equal(
    get("SELECT body FROM message_search_index WHERE rowid=?", message.id).body,
    "Hello @Reader",
  );
  domain.updateMessage(message, "<p>replacement &amp; entity</p>");
  assert.equal(
    get("SELECT body FROM message_search_index WHERE rowid=?", message.id).body,
    "replacement & entity",
  );
  assert.equal(
    all("SELECT rowid FROM message_search_index WHERE rowid=?", message.id)
      .length,
    1,
  );
  assert.equal(
    get("SELECT rowid FROM message_search_index WHERE body MATCH 'Hello'"),
    undefined,
  );
});
test("a failure after FTS insertion rolls back message, rich text, index and unread state", () => {
  const counts = () => [
    get("SELECT count(*) AS n FROM messages").n,
    get("SELECT count(*) AS n FROM action_text_rich_texts").n,
    get("SELECT count(*) AS n FROM message_search_index").n,
  ];
  const before = counts();
  const unread = get(
    "SELECT unread_at FROM memberships WHERE room_id=? AND user_id=?",
    room,
    member.id,
  ).unread_at;
  run(
    "CREATE TEMP TRIGGER fail_unread BEFORE UPDATE OF unread_at ON memberships BEGIN SELECT RAISE(ABORT,'forced unread failure'); END",
  );
  try {
    assert.throws(
      () => domain.createMessage(room, user.id, "rollback creation"),
      /forced unread failure/,
    );
  } finally {
    run("DROP TRIGGER fail_unread");
  }
  assert.deepEqual(counts(), before);
  assert.equal(
    get(
      "SELECT unread_at FROM memberships WHERE room_id=? AND user_id=?",
      room,
      member.id,
    ).unread_at,
    unread,
  );
});
test("publishMessage returns exactly the native fragment it publishes", () => {
  const message = domain.createMessage(
    room,
    user.id,
    "<p>broadcast &amp; reply</p>",
  );
  const expected = String(
    cachedMessages([domain.messageById(message.id)])[0].Fragment,
  );
  assert.equal(domain.publishMessage(message), expected);
});
async function post(body, headers = {}) {
  return fetch(`${base}/rooms/${room}/messages`, {
    method: "POST",
    headers: { cookie, "sec-fetch-site": "same-origin", ...headers },
    body,
    redirect: "manual",
  });
}
test("the HTML poster reuses the broadcast fragment instead of looking it up twice", async () => {
  const original = messageFragments.fetch;
  let reads = 0;
  messageFragments.fetch = function (...args) {
    reads++;
    return original.apply(this, args);
  };
  try {
    const response = await post(
      new URLSearchParams({
        "message[body]": "<p>Posted &amp; <strong>rich</strong></p>",
      }),
    );
    const html = await response.text();
    assert.equal(response.status, 200, html);
    assert.equal(reads, 1);
    assert.ok(html.includes("Posted &amp; <strong>rich</strong>"));
    const message = get("SELECT * FROM messages ORDER BY id DESC LIMIT 1");
    const expected = String(
      cachedMessages([domain.messageById(message.id)])[0].Fragment,
    );
    assert.ok(html.includes(`<template>${expected}</template>`));
  } finally {
    messageFragments.fetch = original;
  }
});
test("attachment-only HTTP creation keeps filename indexing and native response HTML", async () => {
  const form = new FormData();
  form.set("message[body]", "");
  form.set(
    "message[attachment]",
    new Blob(["native attachment"], { type: "text/plain" }),
    "creation-note.txt",
  );
  const response = await post(form);
  const html = await response.text();
  assert.equal(response.status, 200, html);
  const message = get("SELECT * FROM messages ORDER BY id DESC LIMIT 1");
  assert.equal(
    get("SELECT body FROM message_search_index WHERE rowid=?", message.id).body,
    "creation-note.txt",
  );
  assert.ok(html.includes("creation-note.txt"));
  assert.equal(
    get(
      "SELECT count(*) AS n FROM active_storage_attachments WHERE record_type='Message' AND record_id=?",
      message.id,
    ).n,
    1,
  );
});
