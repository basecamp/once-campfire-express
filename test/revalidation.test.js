import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SECRET_KEY_BASE = "revalidation-tests-".repeat(8);
const temp = mkdtempSync(join(tmpdir(), "campfire-revalidation-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { run, get, all, now, initialize, databaseFile } =
  await import("../src/db.js");
const { openDatabase } = await import("../src/sqlite.js");
const domain = await import("../src/domain.js");
const rails = await import("../src/rails.js");
const storage = await import("../src/storage.js");
const { createApp } = await import("../src/app.js");
const { responseCache } = await import("../src/response_cache.js");

// Timestamps a page shows must be SETTLE_MS old before the page is revalidated; the tests move a
// frozen clock forward instead of waiting.
const clockStart = Date.now() + 3600_000;
let tick = 0;
const advance = () => {
  process.env.CAMPFIRE_FROZEN_TIME = new Date(
    clockStart + ++tick * 20_000,
  ).toISOString();
};

let users, rooms, account, server, base;
const cookies = new Map();

function seedRoom(name, type, members) {
  const t = now();
  const id = Number(
    run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      name,
      type,
      users.admin.id,
      t,
      t,
    ).lastInsertRowid,
  );
  const room = get("SELECT * FROM rooms WHERE id=?", id);
  domain.grantMemberships(
    room,
    members.map((u) => u.id),
  );
  return room;
}

before(async () => {
  initialize();
  const t = now();
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
    "Revalidation",
    "join-code",
    t,
    t,
  );
  account = get("SELECT * FROM accounts");
  users = {};
  for (const [key, role] of [
    ["admin", 1],
    ["member", 0],
    ["third", 0],
  ])
    users[key] = domain.createUser({
      name: key[0].toUpperCase() + key.slice(1),
      email_address: `${key}@example.test`,
      password: "password",
      role,
    });
  const { admin, member, third } = users;
  rooms = {
    lobby: seedRoom("Lobby", "Rooms::Open", [admin, member, third]),
    other: seedRoom("Other", "Rooms::Open", [admin, member, third]),
    secret: seedRoom("Secret", "Rooms::Closed", [admin, member]),
    direct: seedRoom(null, "Rooms::Direct", [admin, member]),
  };
  const words = ["alpha", "beta", "gamma"];
  for (let i = 0; i < 50; i++)
    domain.createMessage(
      rooms.lobby.id,
      [admin, member, third][i % 3].id,
      `<p>lobby ${words[i % 3]} ${i} żółć</p>`,
    );
  for (const room of [rooms.other, rooms.secret, rooms.direct])
    for (let i = 0; i < 6; i++)
      domain.createMessage(
        room.id,
        [admin, member][i % 2].id,
        `<p>${room.name || "direct"} ${words[i % 3]} ${i}</p>`,
      );
  for (const [key, user] of Object.entries(users)) {
    run(
      "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
      user.id,
      `${key}-session`,
      t,
      t,
      t,
    );
    cookies.set(
      user.id,
      "session_token=" +
        encodeURIComponent(rails.signCookie("session_token", `${key}-session`)),
    );
  }
  advance();
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  delete process.env.CAMPFIRE_FROZEN_TIME;
  delete process.env.CAMPFIRE_CACHE_VERIFY;
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
});

async function request(user, path, { method = "GET", form } = {}) {
  const response = await fetch(base + path, {
    method: form && method === "GET" ? "POST" : method,
    redirect: "manual",
    headers: {
      cookie: cookies.get(user.id),
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

async function uncached(fn) {
  const budget = responseCache.budget;
  responseCache.budget = 0;
  try {
    return await fn();
  } finally {
    responseCache.budget = budget;
  }
}

// GETs a page through the cache and asserts it equals an uncached render of the same state.
async function checked(user, path) {
  const cachedPage = await request(user, path);
  const fresh = await uncached(() => request(user, path));
  assert.equal(cachedPage.status, fresh.status, `${path} status`);
  assert.equal(cachedPage.type, fresh.type, `${path} type`);
  assert.ok(
    cachedPage.body.equals(fresh.body),
    `${path} for user ${user.id} differs from an uncached render`,
  );
  return cachedPage;
}

async function counted(fn) {
  const start = responseCache.stats();
  const result = await fn();
  const end = responseCache.stats();
  const delta = {};
  for (const key of ["hits", "misses", "revalidated", "invalidated"])
    delta[key] = end[key] - start[key];
  return { result, ...delta };
}

function withForeign(fn) {
  const foreign = openDatabase(databaseFile());
  foreign.exec("PRAGMA busy_timeout=10000");
  try {
    return fn(foreign);
  } finally {
    foreign.close();
  }
}

const newestIn = (room) =>
  get(
    "SELECT id FROM messages WHERE room_id=? ORDER BY created_at DESC, id DESC LIMIT 1",
    room.id,
  ).id;

test("a write to another room keeps the room page; a write to the same room re-renders it", async () => {
  const { admin, member } = users;
  const path = `/rooms/${rooms.lobby.id}`;
  await checked(admin, path);
  const posted = await request(member, `/rooms/${rooms.other.id}/messages`, {
    form: { "message[body]": "elsewhere" },
  });
  assert.equal(posted.status, 200);
  const elsewhere = await counted(() => request(admin, path));
  assert.deepEqual(
    [elsewhere.hits, elsewhere.revalidated, elsewhere.misses],
    [1, 1, 0],
  );
  assert.equal((await counted(() => request(admin, path))).hits, 1);

  await request(member, `/rooms/${rooms.lobby.id}/messages`, {
    form: { "message[body]": "right here" },
  });
  const here = await counted(() => checked(admin, path));
  assert.equal(here.invalidated, 1);
  assert.ok(here.result.body.toString().includes("right here"));
});

test("the sidebar survives posts that leave its unread flags as they are", async () => {
  const { admin, member } = users;
  advance();
  run(
    "UPDATE memberships SET unread_at=NULL WHERE room_id=? AND user_id=?",
    rooms.other.id,
    admin.id,
  );
  await checked(admin, "/users/me/sidebar");
  const post = () =>
    request(member, `/rooms/${rooms.other.id}/messages`, {
      form: { "message[body]": "unread" },
    });
  await post();
  const flipped = await counted(() => checked(admin, "/users/me/sidebar"));
  assert.equal(flipped.invalidated, 1, "the first post marks Other unread");
  await post();
  const kept = await counted(() => request(admin, "/users/me/sidebar"));
  assert.deepEqual([kept.revalidated, kept.misses], [1, 0]);
});

test("commits from another connection revalidate without IPC", async () => {
  const { admin } = users;
  advance();
  const path = `/rooms/${rooms.lobby.id}`;
  await checked(admin, path);
  withForeign((foreign) => {
    const t = now();
    const id = Number(
      foreign
        .prepare(
          "INSERT INTO messages(room_id,creator_id,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?)",
        )
        .run(rooms.other.id, admin.id, "foreign-other", t, t).lastInsertRowid,
    );
    foreign
      .prepare(
        "INSERT INTO action_text_rich_texts(name,record_type,record_id,body,created_at,updated_at) VALUES('body','Message',?,?,?,?)",
      )
      .run(id, "<p>foreign</p>", t, t);
  });
  const unrelated = await counted(() => checked(admin, path));
  assert.equal(unrelated.revalidated, 1);

  withForeign((foreign) =>
    foreign
      .prepare("UPDATE rooms SET name=? WHERE id=?")
      .run("Lobby (foreign)", rooms.lobby.id),
  );
  const renamed = await counted(() => checked(admin, path));
  assert.equal(renamed.invalidated, 1);
  assert.ok(renamed.result.body.toString().includes("Lobby (foreign)"));

  const shown = newestIn(rooms.lobby);
  withForeign((foreign) => {
    const t = now();
    foreign
      .prepare(
        "INSERT INTO boosts(message_id,booster_id,content,created_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(shown, users.third.id, "🎈", t, t);
  });
  const boosted = await counted(() => checked(admin, path));
  assert.equal(
    boosted.invalidated,
    1,
    "a boost that does not touch the message still changes the page",
  );
  assert.ok(boosted.result.body.toString().includes("🎈"));
});

test("older pages ignore new messages, and lose their anchor when it is deleted", async () => {
  const { admin, member } = users;
  advance();
  const lobby = all(
    "SELECT id FROM messages WHERE room_id=? ORDER BY created_at, id",
    rooms.lobby.id,
  );
  const anchor = lobby[45].id;
  const path = `/rooms/${rooms.lobby.id}/messages?before=${anchor}`;
  await checked(admin, path);
  await request(member, `/rooms/${rooms.lobby.id}/messages`, {
    form: { "message[body]": "newest" },
  });
  const older = await counted(() => checked(admin, path));
  assert.equal(older.revalidated, 1);

  advance();
  const latest = `/rooms/${rooms.lobby.id}/messages`;
  await checked(admin, latest);
  await request(member, `/rooms/${rooms.lobby.id}/messages`, {
    form: { "message[body]": "even newer" },
  });
  assert.equal((await counted(() => checked(admin, latest))).invalidated, 1);

  await request(admin, `/rooms/${rooms.lobby.id}/messages/${anchor}`, {
    form: { _method: "delete" },
  });
  const gone = await counted(() => checked(admin, path));
  assert.equal(gone.result.status, 404);
  assert.equal(gone.invalidated, 1);
});

test("an around window whose pivot ties with a newer message still takes later posts", async () => {
  const { admin } = users;
  const room = seedRoom("Ties", "Rooms::Open", [admin]);
  advance();
  for (let i = 0; i < 3; i++)
    domain.createMessage(room.id, admin.id, `<p>older ${i}</p>`);
  advance();
  // Same created_at under the frozen clock; the sibling is in neither half of the window.
  const pivot = domain.createMessage(room.id, admin.id, "<p>pivot</p>");
  const sibling = domain.createMessage(room.id, admin.id, "<p>sibling</p>");
  assert.equal(pivot.created_at, sibling.created_at);
  advance();
  const path = `/rooms/${room.id}/messages?around=${pivot.id}`;
  await checked(admin, path);
  advance();
  domain.createMessage(room.id, admin.id, "<p>later post</p>");
  const later = await counted(() => checked(admin, path));
  assert.deepEqual([later.revalidated, later.invalidated], [0, 1]);
});

test("full anchored windows ignore later posts but not backdated ones", async () => {
  const { admin, member } = users;
  advance();
  const lobby = all(
    "SELECT id, created_at FROM messages WHERE room_id=? ORDER BY created_at, id",
    rooms.lobby.id,
  );
  const paths = [
    `/rooms/${rooms.lobby.id}/messages?after=${lobby[0].id}`,
    `/rooms/${rooms.lobby.id}/messages?around=${lobby[5].id}`,
    `/rooms/${rooms.lobby.id}/messages?before=${lobby[45].id}`,
  ];
  for (const path of paths) await checked(admin, path);
  await request(member, `/rooms/${rooms.lobby.id}/messages`, {
    form: { "message[body]": "after every window" },
  });
  for (const path of paths)
    assert.equal((await counted(() => checked(admin, path))).revalidated, 1);
  withForeign((foreign) => {
    const created = lobby[20].created_at;
    const id = foreign
      .prepare(
        "INSERT INTO messages(room_id,creator_id,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(
        rooms.lobby.id,
        member.id,
        "backdated",
        created,
        created,
      ).lastInsertRowid;
    foreign
      .prepare(
        "INSERT INTO action_text_rich_texts(name,record_type,record_id,body,created_at,updated_at) VALUES('body','Message',?,'<p>backdated</p>',?,?)",
      )
      .run(id, created, created);
  });
  for (const path of paths)
    assert.equal((await counted(() => checked(admin, path))).invalidated, 1);
});

test("a page showing a body edited moments ago is cached for its epoch only", async () => {
  const { admin, member } = users;
  advance();
  const id = newestIn(rooms.secret);
  const path = `/rooms/${rooms.secret.id}/messages/${id}`;
  await request(admin, path, {
    form: { _method: "patch", "message[body]": "<p>edited</p>" },
  });
  await checked(admin, path);
  await request(member, `/rooms/${rooms.other.id}/messages`, {
    form: { "message[body]": "unrelated" },
  });
  const unsettled = await counted(() => checked(admin, path));
  assert.deepEqual([unsettled.misses, unsettled.revalidated], [1, 0]);
  advance();
  await request(member, `/rooms/${rooms.other.id}/messages`, {
    form: { "message[body]": "unrelated again" },
  });
  const settled = await counted(() => checked(admin, path));
  assert.equal(settled.misses, 1, "stored epoch-only before the clock moved");
  await request(member, `/rooms/${rooms.other.id}/messages`, {
    form: { "message[body]": "and again" },
  });
  assert.equal((await counted(() => checked(admin, path))).revalidated, 1);
});

// A small deterministic PRNG so a failing sequence can be replayed with CAMPFIRE_TEST_SEED.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let extra;
async function randomized(seed) {
  const rand = random(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const { admin, member, third } = users;
  const people = [admin, member, third];
  // Never a viewer, so it can be deactivated: it posts, boosts and shares a direct room.
  if (!extra) {
    extra = domain.createUser({
      name: "Extra",
      email_address: "extra@example.test",
      password: "password",
      role: 0,
    });
    for (const room of [rooms.lobby, rooms.other, rooms.direct])
      domain.grantMemberships(room, [extra.id]);
  }
  const active = () =>
    get("SELECT status FROM users WHERE id=?", extra.id).status === 0;
  const words = ["alpha", "beta", "gamma", "delta"];
  const lobbyIds = () =>
    all(
      "SELECT id FROM messages WHERE room_id=? ORDER BY created_at, id",
      rooms.lobby.id,
    ).map((m) => m.id);
  const anchors = lobbyIds().slice(5, 8);
  const roomsOf = (user) =>
    Object.values(rooms).filter((room) =>
      get(
        "SELECT id FROM memberships WHERE room_id=? AND user_id=?",
        room.id,
        user.id,
      ),
    );
  const messageIn = (user) => {
    const ids = roomsOf(user).map((r) => r.id);
    const rows = all(
      `SELECT * FROM messages WHERE room_id IN (${ids.map(() => "?").join(",")}) AND id NOT IN (${anchors.join(",")}) ORDER BY id DESC LIMIT 60`,
      ...ids,
    );
    return rows.length ? pick(rows) : null;
  };
  const upload = (name) => ({
    buffer: Buffer.from(`${name} ${rand()}`),
    originalname: `${name}.txt`,
    mimetype: "text/plain",
  });
  const pages = (user) => [
    "/users/me/sidebar",
    `/searches?q=${pick(words)}`,
    "/searches",
    `/rooms/${rooms.lobby.id}/messages`,
    `/rooms/${rooms.lobby.id}/messages?around=${anchors[2]}`,
    `/rooms/${rooms.lobby.id}/messages?before=${anchors[1]}`,
    `/rooms/${rooms.lobby.id}/messages?after=${anchors[0]}`,
    `/rooms/${rooms.lobby.id}/@${anchors[2]}`,
    `/messages/${anchors[1]}`,
    ...all("SELECT id FROM rooms").map((room) => `/rooms/${room.id}`),
    ...(user === admin
      ? [`/rooms/${rooms.other.id}/messages/${anchors[0]}`]
      : []),
  ];

  const actions = {
    async post(user) {
      const room = pick(roomsOf(user));
      await request(user, `/rooms/${room.id}/messages`, {
        form: { "message[body]": `<p>${pick(words)} ${rand()}</p>` },
      });
    },
    async edit() {
      const message = messageIn(admin);
      if (message)
        await request(
          admin,
          `/rooms/${message.room_id}/messages/${message.id}`,
          {
            form: {
              _method: "patch",
              "message[body]": `<p>${pick(words)} edited ${rand()}</p>`,
            },
          },
        );
    },
    async remove() {
      const message = messageIn(admin);
      if (message)
        await request(
          admin,
          `/rooms/${message.room_id}/messages/${message.id}`,
          { form: { _method: "delete" } },
        );
    },
    async boost(user) {
      const message = messageIn(user);
      if (message)
        await request(user, `/messages/${message.id}/boosts`, {
          form: { "boost[content]": pick(["🔥", "👍", "+1"]) },
        });
    },
    async unboost() {
      const boost = get("SELECT * FROM boosts ORDER BY random() LIMIT 1");
      const booster = people.find((u) => u.id === boost?.booster_id);
      if (booster)
        await request(
          booster,
          `/messages/${boost.message_id}/boosts/${boost.id}`,
          { form: { _method: "delete" } },
        );
    },
    attach() {
      const message = messageIn(admin);
      if (message)
        storage.replaceAttachment(
          upload("attached"),
          "Message",
          message.id,
          "attachment",
        );
    },
    async rename(user) {
      await request(user, "/users/me/profile", {
        form: { _method: "patch", "user[name]": `${pick(words)} ${user.id}` },
      });
    },
    avatar(user) {
      storage.replaceAttachment(upload("avatar"), "User", user.id, "avatar");
    },
    async bio(user) {
      await request(user, "/users/me/profile", {
        form: { _method: "patch", "user[bio]": `${pick(words)} bio` },
      });
    },
    extraPost() {
      if (active())
        domain.createMessage(
          pick(roomsOf(extra)).id,
          extra.id,
          `<p>extra ${pick(words)}</p>`,
        );
    },
    async deactivation() {
      if (!active()) {
        run(
          "UPDATE users SET status=0,updated_at=? WHERE id=?",
          now(),
          extra.id,
        );
        domain.grantMemberships(rooms.lobby, [extra.id]);
      } else
        await request(admin, `/account/users/${extra.id}`, {
          form: { _method: "delete" },
        });
    },
    async direct(user) {
      const form = new URLSearchParams();
      for (const other of [...people, extra])
        if (other !== user && rand() < 0.5)
          form.append("user_ids[]", String(other.id));
      await request(user, "/rooms/directs", { form });
    },
    async scratchRoom() {
      const scratch = get(
        "SELECT id FROM rooms WHERE id NOT IN (SELECT value FROM json_each(?)) ORDER BY random() LIMIT 1",
        JSON.stringify(Object.values(rooms).map((r) => r.id)),
      );
      if (scratch && rand() < 0.5)
        await request(admin, `/rooms/${scratch.id}`, {
          form: { _method: "delete" },
        });
      else {
        const form = new URLSearchParams({
          "room[name]": `Scratch ${pick(words)}`,
        });
        for (const other of [member, third])
          if (rand() < 0.5) form.append("user_ids[]", String(other.id));
        await request(admin, "/rooms/closeds", { form });
      }
    },
    async role() {
      await request(admin, `/account/users/${pick([member, third]).id}`, {
        form: {
          _method: "patch",
          "user[role]": pick(["administrator", "member"]),
        },
      });
    },
    async renameRoom() {
      await request(admin, `/rooms/opens/${rooms.other.id}`, {
        form: { _method: "patch", "room[name]": `Other ${pick(words)}` },
      });
    },
    async membership() {
      const ids = [admin.id, member.id, ...(rand() < 0.5 ? [third.id] : [])];
      const form = new URLSearchParams({
        _method: "patch",
        "room[name]": "Secret",
      });
      for (const id of ids) form.append("user_ids[]", String(id));
      await request(admin, `/rooms/closeds/${rooms.secret.id}`, {
        form,
      });
    },
    async involvement(user) {
      const room = pick(roomsOf(user));
      const choices =
        room.type === "Rooms::Direct"
          ? ["everything", "nothing"]
          : ["mentions", "everything", "nothing", "invisible"];
      await request(user, `/rooms/${room.id}/involvement`, {
        form: { _method: "put", involvement: pick(choices) },
      });
    },
    presence(user) {
      const room = pick(roomsOf(user));
      if (rand() < 0.5)
        run(
          "UPDATE memberships SET connections=1,connected_at=?,unread_at=NULL,updated_at=? WHERE room_id=? AND user_id=?",
          now(),
          now(),
          room.id,
          user.id,
        );
      else
        run(
          "UPDATE memberships SET connections=0,connected_at=NULL,unread_at=?,updated_at=? WHERE room_id=? AND user_id=?",
          now(),
          now(),
          room.id,
          user.id,
        );
    },
    async account() {
      await request(admin, "/account", {
        form: {
          _method: "patch",
          "account[name]": `Campfire ${pick(words)}`,
          "account[settings][restrict_room_creation_to_administrators]": pick([
            "1",
            "0",
          ]),
        },
      });
    },
    async styles() {
      await request(admin, "/account/custom_styles", {
        form: {
          _method: "patch",
          "account[custom_styles]": `body { --x: ${pick(words)}; }`,
        },
      });
    },
    logo() {
      if (rand() < 0.3) storage.removeAttachment("Account", account.id, "logo");
      else
        storage.replaceAttachment(
          upload("logo"),
          "Account",
          account.id,
          "logo",
        );
    },
    async search(user) {
      await request(user, "/searches", { form: { q: pick(words) } });
    },
    session(user) {
      if (rand() < 0.5)
        run(
          "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
          user.id,
          `extra-${rand()}`,
          now(),
          now(),
          now(),
        );
      else
        run(
          "UPDATE sessions SET last_active_at=?,updated_at=? WHERE user_id=?",
          now(),
          now(),
          user.id,
        );
    },
    foreign(user) {
      withForeign((foreign) => {
        const t = now();
        const choice = pick(["user", "unread", "boost", "room", "backdated"]);
        if (choice === "user")
          foreign
            .prepare("UPDATE users SET name=?,updated_at=? WHERE id=?")
            .run(`Foreign ${pick(words)}`, t, user.id);
        else if (choice === "unread")
          foreign
            .prepare(
              "UPDATE memberships SET unread_at=?,updated_at=? WHERE user_id=?",
            )
            .run(t, t, user.id);
        else if (choice === "backdated") {
          // Lands inside, or tied with, the older windows' rows.
          const { created_at } = pick(
            all(
              "SELECT created_at FROM messages WHERE room_id=? ORDER BY created_at LIMIT 12",
              rooms.lobby.id,
            ),
          );
          const id = Number(
            foreign
              .prepare(
                "INSERT INTO messages(room_id,creator_id,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?)",
              )
              .run(
                rooms.lobby.id,
                user.id,
                `backdated-${rand()}`,
                created_at,
                t,
              ).lastInsertRowid,
          );
          foreign
            .prepare(
              "INSERT INTO action_text_rich_texts(name,record_type,record_id,body,created_at,updated_at) VALUES('body','Message',?,?,?,?)",
            )
            .run(id, `<p>backdated ${pick(words)}</p>`, created_at, created_at);
        } else if (choice === "room")
          foreign
            .prepare("UPDATE rooms SET name=? WHERE id=?")
            .run(`Lobby ${pick(words)}`, rooms.lobby.id);
        else {
          const message = messageIn(user);
          if (message)
            foreign
              .prepare(
                "INSERT INTO boosts(message_id,booster_id,content,created_at,updated_at) VALUES(?,?,?,?,?)",
              )
              .run(message.id, user.id, "🛰", t, t);
        }
      });
    },
  };

  const names = Object.keys(actions);
  const visited = [];
  try {
    for (let step = 0; step < 160; step++) {
      if (rand() < 0.5) advance();
      if (rand() < 0.5) process.env.CAMPFIRE_CACHE_VERIFY = "1";
      else delete process.env.CAMPFIRE_CACHE_VERIFY;
      const name = pick(names);
      const actor = pick(people);
      visited.push(`${step}:${name}:${actor.id}`);
      await actions[name](actor);
      for (let i = 0; i < 8; i++) {
        const viewer = pick(people);
        await checked(viewer, pick(pages(viewer)));
      }
    }
  } catch (error) {
    error.message += `\nseed ${seed}, steps ${visited.slice(-5).join(" ")}`;
    throw error;
  } finally {
    delete process.env.CAMPFIRE_CACHE_VERIFY;
  }
}

// Each seed continues from the state the previous one left; CAMPFIRE_TEST_SEED replays one.
test("randomized writes never let a revalidated page differ from a fresh render", async () => {
  const seeds = process.env.CAMPFIRE_TEST_SEED
    ? [Number(process.env.CAMPFIRE_TEST_SEED)]
    : [20261007, 1, 2];
  const start = responseCache.stats();
  for (const seed of seeds) await randomized(seed);
  const end = responseCache.stats();
  assert.equal(end.mismatches, start.mismatches, "verify mode saw mismatches");
  assert.ok(
    end.revalidated - start.revalidated > 50,
    `only ${end.revalidated - start.revalidated} revalidated hits`,
  );
  assert.ok(end.invalidated - start.invalidated > 50);
});
