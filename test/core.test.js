import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
process.env.SECRET_KEY_BASE = "core-test-secret-".repeat(8);
const temp = mkdtempSync(join(tmpdir(), "campfire-express-core-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { all, get, run, transaction, initialize, now } =
  await import("../src/db.js");
const domain = await import("../src/domain.js");
const { plainText, sanitize, mentionIds } = await import("../src/richtext.js");
const rails = await import("../src/rails.js");
const { createServer: createAppServer } = await import("../src/app.js");
const { fragment, render } = await import("../src/rendering.js");
let admin, member, outsider, open, privateRoom;
before(() => {
  initialize();
  const t = now();
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
    "Testing",
    "join-me",
    t,
    t,
  );
  admin = domain.createUser({
    name: "Admin",
    email_address: "admin@example.test",
    password: "password",
    role: 1,
  });
  member = domain.createUser({
    name: "Member",
    email_address: "member@example.test",
    password: "password",
  });
  outsider = domain.createUser({
    name: "Outside",
    email_address: "outside@example.test",
    password: "password",
  });
  const make = (name, type) => {
    const r = run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      name,
      type,
      admin.id,
      t,
      t,
    );
    return get("SELECT * FROM rooms WHERE id=?", Number(r.lastInsertRowid));
  };
  open = make("Open", "Rooms::Open");
  privateRoom = make("Secret", "Rooms::Closed");
  domain.grantMemberships(open, [admin.id, member.id, outsider.id]);
  domain.grantMemberships(privateRoom, [admin.id, member.id]);
});
test("synchronous nested transactions rollback together", () => {
  const n = get("SELECT count(*) n FROM users").n;
  assert.throws(() =>
    transaction(() => {
      domain.createUser({
        name: "Temp",
        email_address: "temp@example.test",
        password: "password",
      });
      throw new Error("rollback");
    }),
  );
  assert.equal(get("SELECT count(*) n FROM users").n, n);
});
test("messages preserve schema, search index, raw timestamp cursors and membership authorization", () => {
  const m = domain.createMessage(
    open.id,
    admin.id,
    "<p>Hello <strong>world</strong></p>",
    "client-1",
  );
  assert.equal(
    get(
      "SELECT body FROM action_text_rich_texts WHERE record_id=? AND record_type='Message'",
      m.id,
    ).body,
    "<p>Hello <strong>world</strong></p>",
  );
  assert.equal(
    get("SELECT rowid FROM message_search_index WHERE body MATCH 'world'")
      .rowid,
    m.id,
  );
  assert.throws(() =>
    domain.createMessage(privateRoom.id, outsider.id, "secret"),
  );
  assert.equal(domain.roomForUser(outsider, privateRoom.id), undefined);
  run(
    "UPDATE messages SET created_at=? WHERE id=?",
    "2026-01-01 00:00:00",
    m.id,
  );
  const newer = domain.createMessage(open.id, admin.id, "later");
  run(
    "UPDATE messages SET created_at=? WHERE id=?",
    "2026-01-01 00:00:01.000000",
    newer.id,
  );
  assert.deepEqual(
    domain.messagesForRoom(open.id, { after: m.id }).map((x) => x.id),
    [newer.id],
  );
  assert.deepEqual(
    domain.messagesForRoom(open.id, { before: newer.id }).map((x) => x.id),
    [m.id],
  );
});
test("updates replace FTS and deletes remove message and rich text", () => {
  let m = domain.createMessage(open.id, member.id, "obsolete");
  m = domain.updateMessage(m, "replacement");
  assert.equal(
    get("SELECT rowid FROM message_search_index WHERE body MATCH 'obsolete'"),
    undefined,
  );
  assert.equal(
    get("SELECT rowid FROM message_search_index WHERE body MATCH 'replacement'")
      .rowid,
    m.id,
  );
  domain.deleteMessage(m, { broadcast: false });
  assert.equal(domain.messageById(m.id), undefined);
  assert.equal(
    get("SELECT rowid FROM message_search_index WHERE rowid=?", m.id),
    undefined,
  );
  assert.equal(
    get(
      "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
      m.id,
    ),
    undefined,
  );
});
test("sanitize discards executable markup and unsafe URL schemes", () => {
  const html = sanitize(
    '<script>evil()</script><a href="javascript:evil()" onclick="evil()">hello</a><p>good</p>',
  );
  assert.equal(html, "<a>hello</a><p>good</p>");
  assert.equal(plainText("<p>a<br>b</p><p>c</p>"), "a\nb\n\nc");
});
test("Rails signed mentions are indexed with @ and notified securely", () => {
  const token = rails.sgid("User", member.id);
  const html = `<p>Hello <action-text-attachment sgid="${token}"></action-text-attachment></p>`;
  assert.equal(plainText(html), "Hello @Member");
  assert.deepEqual([...mentionIds(html)], [member.id]);
  assert.deepEqual(
    [...mentionIds(html.replace(token, token + "x"))],
    [member.id],
  );
});
test("retained frontend compiles room/login/sidebar/profile/admin screens", () => {
  const req = {
    user: admin,
    session: {},
    get: (name) => (name === "host" ? "example.test" : null),
    protocol: "http",
  };
  for (const screen of [
    "login",
    "welcome",
    "account",
    "bots",
    "bot-form",
    "custom-styles",
  ])
    assert.ok(render(req, screen, { Subject: { ID: 0 } }).includes("Campfire"));
  assert.ok(
    render(req, "room", {
      Room: {
        ID: open.id,
        Name: "Open",
        Type: "Rooms::Open",
        DOM: (p) => p + "_rooms_open_" + open.id,
      },
      Messages: [],
    }).includes('name="message[body]"'),
  );
  assert.ok(fragment("messages", { Messages: [] }) === "");
});
test("HTTP actual cookie login, Sec-Fetch-Site, rooms, search, posting and private denial", async () => {
  const server = await createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  try {
    let response = await fetch(base + "/session/new");
    const html = await response.text();
    assert.ok(!/csrf-token|authenticity_token/.test(html), "no CSRF tags");
    cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    response = await fetch(base + "/session", {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email_address: member.email_address,
        password: "password",
      }),
    });
    assert.equal(response.status, 302);
    cookie +=
      "; " +
      response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    response = await fetch(base + "/rooms/" + open.id, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes("Lexxy") === false);
    response = await fetch(base + "/rooms/" + open.id + "/messages", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        "message[body]": "<p>Persisted HTTP marker</p>",
      }),
    });
    assert.equal(response.status, 201);
    const message = await response.json();
    assert.equal(message.body.plain_text, "Persisted HTTP marker");
    assert.ok(
      get(
        "SELECT rowid FROM message_search_index WHERE body MATCH 'Persisted'",
      ),
    );
    response = await fetch(base + "/rooms/" + open.id + "/messages", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ message: { body: "cross-site" } }),
    });
    assert.equal(response.status, 422);
    response = await fetch(base + "/searches?q=Persisted", {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes("Persisted HTTP marker"));
    const outsideToken = "outside-session";
    run(
      "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
      outsider.id,
      outsideToken,
      now(),
      now(),
      now(),
    );
    response = await fetch(base + "/rooms/" + privateRoom.id + "/messages", {
      redirect: "manual",
      headers: {
        cookie:
          "session_token=" +
          encodeURIComponent(rails.signCookie("session_token", outsideToken)),
      },
    });
    assert.equal(response.status, 302);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("writes are verified by Sec-Fetch-Site and Origin instead of tokens", async () => {
  const trusted = process.env.TRUSTED_PROXIES;
  process.env.TRUSTED_PROXIES = "loopback";
  const server = await createAppServer();
  if (trusted === undefined) delete process.env.TRUSTED_PROXIES;
  else process.env.TRUSTED_PROXIES = trusted;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const setCookies = (r) =>
    r.headers.getSetCookie().map((c) => c.split(";")[0]);
  const sessionOf = (r) =>
    rails.decryptCookie(
      "_campfire_session",
      setCookies(r)
        .find((c) => c.startsWith("_campfire_session="))
        .slice("_campfire_session=".length),
    );
  try {
    const anonymous = await fetch(base + "/session/new");
    assert.ok(!/csrf|authenticity_token/.test(await anonymous.text()));
    assert.equal(sessionOf(anonymous)._csrf_token, undefined);

    const cookie = await signIn(base, member.email_address);
    const post = (headers) =>
      fetch(base + "/rooms/" + open.id + "/messages", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          accept: "application/json",
          ...headers,
        },
        body: JSON.stringify({ message: { body: "forgery check" } }),
      });
    for (const [headers, status, why] of [
      [{ "sec-fetch-site": "same-origin" }, 201, "same-origin"],
      [{ "sec-fetch-site": "same-site" }, 201, "same-site"],
      [{ "sec-fetch-site": "same-origin", origin: base }, 201, "own origin"],
      [{}, 201, "missing header over plain HTTP"],
      [{ "sec-fetch-site": "cross-site" }, 422, "cross-site"],
      [{ "sec-fetch-site": "none" }, 422, "none"],
      [{ "sec-fetch-site": "bogus" }, 422, "unknown value"],
      [
        { "sec-fetch-site": "same-origin", origin: "http://evil.test" },
        422,
        "foreign origin",
      ],
      [{ "x-forwarded-proto": "https" }, 422, "missing header over HTTPS"],
      [
        { "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" },
        201,
        "same-origin over HTTPS",
      ],
    ])
      assert.equal((await post(headers)).status, status, why);

    // A Rails-issued session keeps its token through rewrites even though nothing reads it.
    const railsToken = rails.b64(Buffer.alloc(32, 7));
    const railsSession = rails.encryptCookie("_campfire_session", {
      session_id: "f".repeat(32),
      _csrf_token: railsToken,
    });
    const sessionToken = cookie
      .split("; ")
      .find((c) => c.startsWith("session_token="));
    const withRails = `${sessionToken}; _campfire_session=${encodeURIComponent(railsSession)}`;
    const visited = await fetch(base + "/rooms/" + open.id, {
      headers: { cookie: withRails },
    });
    assert.equal(visited.status, 200);
    const rewritten = sessionOf(visited);
    assert.equal(rewritten._csrf_token, railsToken);
    assert.equal(rewritten.last_room_id, open.id);

    const settled = [sessionToken, ...setCookies(visited)].join("; ");
    const page = async () =>
      (
        await fetch(base + "/rooms/" + open.id, {
          headers: { cookie: settled },
        })
      ).text();
    const first = await page();
    assert.ok(!/csrf-token|authenticity_token/.test(first));
    assert.equal(await page(), first, "repeat pages are byte-identical");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
async function signIn(base, email) {
  let response = await fetch(base + "/session/new");
  const cookies = (r) => r.headers.getSetCookie().map((c) => c.split(";")[0]);
  const cookie = cookies(response).join("; ");
  response = await fetch(base + "/session", {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email_address: email,
      password: "password",
    }),
  });
  assert.equal(response.status, 302);
  return [cookie, ...cookies(response)].join("; ");
}

test("search and sidebar issue a bounded number of queries", async () => {
  const { queryCount } = await import("../src/db.js");
  for (let i = 0; i < 30; i++)
    domain.createMessage(open.id, admin.id, `needle ${i}`);
  for (const other of [member, outsider]) {
    const t = now();
    const id = run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(NULL,'Rooms::Direct',?,?,?)",
      admin.id,
      t,
      t,
    ).lastInsertRowid;
    domain.grantMemberships(get("SELECT * FROM rooms WHERE id=?", id), [
      admin.id,
      other.id,
    ]);
  }
  const server = await createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cookie = await signIn(base, admin.email_address);
    let before = queryCount();
    assert.equal(
      (await fetch(`${base}/searches?q=needle`, { headers: { cookie } }))
        .status,
      200,
    );
    assert.ok(
      queryCount() - before < 15,
      `search ran ${queryCount() - before} queries`,
    );
    before = queryCount();
    assert.equal(
      (await fetch(`${base}/users/me/sidebar`, { headers: { cookie } })).status,
      200,
    );
    assert.ok(
      queryCount() - before < 12,
      `sidebar ran ${queryCount() - before} queries`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));
import { readFileSync } from "node:fs";
test("64 independent Rails canonical editor plaintext examples", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("../compat/richtext.json", import.meta.url)),
  );
  for (const example of vectors.cases)
    assert.equal(plainText(example.body), example.plain_text, example.name);
});
import { storeUpload, blobUrl, purgeBlob } from "../src/storage.js";
import { messageData } from "../src/rendering.js";
test("inline native attachments preserve rich text ownership, private authorization and cleanup", () => {
  const privateMessage = domain.createMessage(
    privateRoom.id,
    admin.id,
    "private attachment",
  );
  const blob = storeUpload(
    {
      buffer: Buffer.from("private content"),
      originalname: "private.txt",
      mimetype: "text/plain",
    },
    "Message",
    privateMessage.id,
    "attachment",
  );
  const html = `<p>Attachment <action-text-attachment sgid="${rails.sgid("ActiveStorage::Blob", blob.id)}"></action-text-attachment></p>`;
  const n = get("SELECT count(*) n FROM messages").n;
  assert.throws(
    () => domain.createMessage(open.id, outsider.id, html),
    /membership/,
  );
  assert.equal(get("SELECT count(*) n FROM messages").n, n);
  const message = domain.createMessage(privateRoom.id, member.id, html);
  const rich = get(
    "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
    message.id,
  );
  assert.equal(
    get(
      "SELECT blob_id FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=?",
      rich.id,
    ).blob_id,
    blob.id,
  );
  assert.equal(plainText(html), "Attachment [private.txt]");
  assert.ok(String(messageData([message])[0].HTML).includes(blobUrl(blob)));
  domain.deleteMessage(message, { broadcast: false });
  assert.equal(
    get(
      "SELECT id FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=?",
      rich.id,
    ),
    undefined,
  );
  purgeBlob(blob.id);
  assert.ok(get("SELECT id FROM active_storage_blobs WHERE id=?", blob.id));
});
test("failed image create and edit leave existing message body, attachments and FTS intact", async () => {
  const sessionToken = "atomic-media-session";
  run(
    "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
    admin.id,
    sessionToken,
    now(),
    now(),
    now(),
  );
  const server = await createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`,
    auth =
      "session_token=" +
      encodeURIComponent(rails.signCookie("session_token", sessionToken));
  try {
    const response = await fetch(base + "/rooms/" + open.id, {
        headers: { cookie: auth },
      }),
      cookie =
        auth +
        "; " +
        response.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
    let m = domain.createMessage(open.id, admin.id, "Original atomic body");
    const original = storeUpload(
      {
        buffer: Buffer.from("original file"),
        originalname: "original.txt",
        mimetype: "text/plain",
      },
      "Message",
      m.id,
      "attachment",
    );
    const snapshot = () =>
      Object.fromEntries(
        [
          "messages",
          "action_text_rich_texts",
          "active_storage_blobs",
          "active_storage_attachments",
          "active_storage_variant_records",
        ].map((t) => [t, get(`SELECT count(*) n FROM ${t}`).n]),
      );
    const before = snapshot();
    const form = (method) => {
      const body = new FormData();
      if (method) body.append("_method", method);
      body.append("message[body]", "Must not persist");
      body.append(
        "message[attachment]",
        new Blob(["this is not a jpeg"], { type: "image/jpeg" }),
        "invalid.jpg",
      );
      return body;
    };
    for (const [path, method] of [
      [`/rooms/${open.id}/messages`, null],
      [`/rooms/${open.id}/messages/${m.id}`, "patch"],
    ]) {
      const reply = await fetch(base + path, {
        method: "POST",
        headers: { cookie },
        body: form(method),
      });
      assert.equal(reply.status, 422);
      assert.deepEqual(snapshot(), before);
    }
    assert.equal(
      get(
        "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
        m.id,
      ).body,
      "Original atomic body",
    );
    assert.equal(
      get(
        "SELECT blob_id FROM active_storage_attachments WHERE record_type='Message' AND record_id=?",
        m.id,
      ).blob_id,
      original.id,
    );
    assert.equal(
      get("SELECT rowid FROM message_search_index WHERE body MATCH 'Original'")
        .rowid,
      m.id,
    );
    assert.equal(
      all(
        "SELECT rowid FROM message_search_index WHERE body MATCH 'persist'",
      ).some((row) => row.rowid === m.id),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("room namespaces cannot promote direct history or bypass shared room administration", async () => {
  const time = now();
  const directId = Number(
    run(
      "INSERT INTO rooms(type,creator_id,created_at,updated_at) VALUES('Rooms::Direct',?,?,?)",
      admin.id,
      time,
      time,
    ).lastInsertRowid,
  );
  const direct = get("SELECT * FROM rooms WHERE id=?", directId);
  domain.grantMemberships(direct, [admin.id, member.id]);
  const sessionToken = "namespace-member-session";
  run(
    "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
    member.id,
    sessionToken,
    time,
    time,
    time,
  );
  const server = await createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth =
    "session_token=" +
    encodeURIComponent(rails.signCookie("session_token", sessionToken));
  try {
    const loginPage = await fetch(base + "/rooms/" + open.id, {
      headers: { cookie: auth },
    });
    const cookie =
      auth +
      "; " +
      loginPage.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    const snapshot = () =>
      JSON.stringify({
        rooms: all("SELECT * FROM rooms ORDER BY id"),
        memberships: all("SELECT * FROM memberships ORDER BY id"),
      });
    const initial = snapshot();
    const cases = [
      ["GET", "/rooms/unknown", 404],
      ["GET", `/rooms/opens/${direct.id}/edit`, 404],
      ["PATCH", `/rooms/opens/${direct.id}`, 404],
      ["DELETE", `/rooms/opens/${direct.id}`, 404],
      ["GET", `/rooms/closeds/${direct.id}/edit`, 404],
      ["PATCH", `/rooms/closeds/${direct.id}`, 404],
      ["GET", `/rooms/directs/${open.id}/edit`, 404],
      ["DELETE", `/rooms/directs/${open.id}`, 404],
      ["PATCH", `/rooms/directs/${open.id}`, 404],
      ["PATCH", `/rooms/directs/${direct.id}`, 405],
      ["PUT", `/rooms/directs/${direct.id}`, 405],
      ["DELETE", `/rooms/opens/${open.id}`, 403],
    ];
    for (const [method, path, expected] of cases) {
      const response = await fetch(base + path, {
        method,
        redirect: "manual",
        headers: {
          cookie,
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
        },
        ...(method === "GET"
          ? {}
          : {
              body: new URLSearchParams({
                "room[name]": "Leaked",
                "user_ids[]": outsider.id,
              }),
            }),
      });
      assert.equal(response.status, expected, method + " " + path);
      assert.equal(
        snapshot(),
        initial,
        method + " " + path + " changed persisted access",
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Attachment-only bot JSON and notification text use the original filename", async () => {
  const { messagePlainText } = await import("../src/richtext.js");
  const { serializeMessage } = await import("../src/routes.js");
  const message = domain.createMessage(open.id, admin.id, "");
  storeUpload(
    {
      buffer: Buffer.from("attachment-only"),
      originalname: "contract-file.txt",
      mimetype: "text/plain",
    },
    "Message",
    message.id,
    "attachment",
  );
  assert.equal(messagePlainText(message.id, ""), "contract-file.txt");
  assert.equal(messagePlainText(message.id, "<p>Caption</p>"), "Caption");
  const req = { protocol: "http", headers: { host: "example.test" } };
  assert.equal(
    serializeMessage(message, req).body.plain_text,
    "contract-file.txt",
  );
});

test("fragment renders precompiled Eta templates without recompiling", async () => {
  const { Eta } = await import("eta");
  const original = globalThis.Function;
  let compiles = 0;
  // Eta compiles each template with `new Function`, so counting constructions counts compiles.
  globalThis.Function = new Proxy(original, {
    construct(target, args) {
      compiles++;
      return Reflect.construct(target, args);
    },
  });
  try {
    new Eta().compile("probe");
    assert.equal(compiles, 1);
    for (let i = 0; i < 5; i++) {
      fragment("messages", { Messages: [] });
      fragment("prompt-item", { Mention: { Name: "x" } });
    }
    assert.equal(compiles, 1);
  } finally {
    globalThis.Function = original;
  }
  assert.throws(() => fragment("no-such-template"), /Unknown template/);
});
test("fragment output keeps nunjucks escaping and safe strings", async () => {
  const { safe } = await import("../src/rendering.js");
  const html = fragment("prompt-item", {
    Mention: { Name: `a\\<b>&"'`, SGID: null },
    HTML: safe("<i>kept</i>"),
  });
  assert.ok(html.includes('search="a&#92;&lt;b&gt;&amp;&quot;&#39;"'));
  assert.ok(html.includes('sgid=""'));
  assert.ok(html.includes("<i>kept</i>"));
});
const { replaceAttachment } = await import("../src/storage.js");
async function httpSession(user, token) {
  run(
    "INSERT INTO sessions(user_id,token,created_at,updated_at,last_active_at) VALUES(?,?,?,?,?)",
    user.id,
    token,
    now(),
    now(),
    now(),
  );
  const server = await createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${server.address().port}`,
    base = `http://${host}`,
    auth =
      "session_token=" +
      encodeURIComponent(rails.signCookie("session_token", token));
  const response = await fetch(base + "/", { headers: { cookie: auth } });
  const cookie = [
    auth,
    ...response.headers.getSetCookie().map((c) => c.split(";")[0]),
  ].join("; ");
  // node:http, not fetch: Node's fetch drops a custom Host header.
  const page = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      httpRequest(base + path, { headers: { cookie, ...headers } }, (r) => {
        r.setEncoding("utf8");
        let body = "";
        r.on("data", (chunk) => (body += chunk));
        r.on("error", reject);
        r.on("end", () => {
          assert.equal(r.statusCode, 200, path);
          resolve(body);
        });
      })
        .on("error", reject)
        .end();
    });
  const post = (path, fields) =>
    fetch(base + path, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/vnd.turbo-stream.html, text/html",
      },
      body: new URLSearchParams(fields),
    });
  return {
    host,
    cookie,
    page,
    post,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
test("room HTML reflects edits, boosts, renames and attachments even when timestamps do not move, and never leaks hosts", async () => {
  // Frozen time makes every write reuse one updated_at, so freshness cannot rely on timestamps alone.
  const frozen = process.env.CAMPFIRE_FROZEN_TIME;
  process.env.CAMPFIRE_FROZEN_TIME = "2026-01-02T03:04:05.678Z";
  const http = await httpSession(admin, "fragment-cache-session");
  try {
    const creator = domain.createUser({
      name: "Fragment Author",
      email_address: "fragment-author@example.test",
      password: "password",
    });
    domain.grantMemberships(open, [creator.id]);
    const message = domain.createMessage(
      open.id,
      creator.id,
      "<p>First fragment body</p>",
      "fragment-client",
    );
    const path = `/rooms/${open.id}/@${message.id}`;
    const room = () => http.page(path);
    const cold = await room();
    assert.ok(cold.includes("First fragment body"));
    const { messageFragments } = await import("../src/rendering.js");
    assert.ok(messageFragments.size > 0, "room messages are cached");
    assert.equal(await room(), cold, "warm page equals cold page");

    domain.updateMessage(message, "<p>Edited fragment body</p>");
    let html = await room();
    assert.ok(html.includes("Edited fragment body"), "a: edit shows");
    assert.ok(!html.includes("First fragment body"));

    let response = await http.post(`/messages/${message.id}/boosts`, {
      "boost[content]": "Fragboost",
    });
    assert.ok(response.status < 400, `boost create ${response.status}`);
    const boost = get(
      "SELECT id FROM boosts WHERE message_id=? AND content='Fragboost'",
      message.id,
    );
    assert.ok(boost);
    assert.ok((await room()).includes("Fragboost"), "b: boost shows");
    response = await http.post(`/messages/${message.id}/boosts/${boost.id}`, {
      _method: "delete",
    });
    assert.ok(response.status < 400, `boost delete ${response.status}`);
    assert.ok(!(await room()).includes("Fragboost"), "b: boost removed");
    await http.post(`/messages/${message.id}/boosts`, {
      "boost[content]": "Fragboost again",
    });
    assert.ok((await room()).includes("Admin boosted Fragboost again"));
    run("UPDATE users SET name='Booster Renamed' WHERE id=?", admin.id);
    try {
      assert.ok(
        (await room()).includes("Booster Renamed boosted Fragboost again"),
        "b: booster rename shows",
      );
    } finally {
      run("UPDATE users SET name='Admin' WHERE id=?", admin.id);
    }

    run(
      "UPDATE users SET name='Renamed',updated_at=? WHERE id=?",
      now(),
      creator.id,
    );
    html = await room();
    assert.ok(
      html.includes('<strong data-reply-target="author">Renamed</strong>'),
      "c: rename shows",
    );
    assert.ok(!html.includes("Fragment Author"));

    run("UPDATE rooms SET name='Open Renamed' WHERE id=?", open.id);
    assert.ok(
      (await room()).includes(">Open Renamed</a>"),
      "room rename shows",
    );
    run("UPDATE rooms SET name='Open' WHERE id=?", open.id);

    replaceAttachment(
      {
        buffer: Buffer.from("first"),
        originalname: "first-fragment.txt",
        mimetype: "text/plain",
      },
      "Message",
      message.id,
      "attachment",
    );
    assert.ok((await room()).includes("first-fragment.txt"));
    replaceAttachment(
      {
        buffer: Buffer.from("second"),
        originalname: "second-fragment.txt",
        mimetype: "text/plain",
      },
      "Message",
      message.id,
      "attachment",
    );
    html = await room();
    assert.ok(html.includes("second-fragment.txt"), "d: new attachment");
    assert.ok(!html.includes("first-fragment.txt"));

    html = await http.page(path, { host: "evil.test" });
    const permalink = (host) =>
      `data-copy-to-clipboard-content-value="http://${host}/rooms/${open.id}/@${message.id}"`;
    assert.ok(html.includes(permalink("evil.test")), "e: host permalink");
    html = await room();
    assert.ok(!html.includes("evil.test"), "e: host must not leak");
    assert.ok(html.includes(permalink(http.host)));
  } finally {
    await http.close();
    if (frozen === undefined) delete process.env.CAMPFIRE_FROZEN_TIME;
    else process.env.CAMPFIRE_FROZEN_TIME = frozen;
  }
});

test("messages page answers unchanged conditional requests with 304 before rendering", async () => {
  const { messageFragments } = await import("../src/rendering.js");
  const http = await httpSession(admin, "etag-session");
  const url = `http://${http.host}/rooms/${open.id}/messages`;
  // Node's fetch adds Cache-Control: no-cache to conditional requests unless one is set,
  // which makes `fresh` treat them as never fresh; browsers revalidate with max-age=0.
  const get = (headers = {}) =>
    fetch(url, {
      headers: {
        cookie: http.cookie,
        "cache-control": "max-age=0",
        ...headers,
      },
    });
  const fetchOriginal = messageFragments.fetch;
  let renders = 0;
  messageFragments.fetch = function (...args) {
    renders++;
    return fetchOriginal.apply(this, args);
  };
  try {
    domain.createMessage(open.id, admin.id, "<p>etag one</p>");
    const first = await get();
    const etag = first.headers.get("etag");
    assert.equal(first.status, 200);
    assert.match(etag, /^W\/"[0-9a-f]{40}"$/);
    await first.text();

    renders = 0;
    const second = await get({ "if-none-match": etag });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), "");
    assert.equal(renders, 0, "304 must not render");

    const created = domain.createMessage(open.id, admin.id, "<p>etag two</p>");
    const third = await get({ "if-none-match": etag });
    assert.equal(third.status, 200);
    const grown = third.headers.get("etag");
    assert.notEqual(grown, etag);
    await third.text();
    assert.equal((await get({ "if-none-match": grown })).status, 304);

    run("DELETE FROM messages WHERE id=?", created.id);
    const afterDelete = await get({ "if-none-match": grown });
    assert.equal(afterDelete.status, 200);
    assert.notEqual(afterDelete.headers.get("etag"), grown);
    await afterDelete.text();
  } finally {
    messageFragments.fetch = fetchOriginal;
    await http.close();
  }
});

test("messagesForRoom paging query returns exactly what the join-first query did", async () => {
  const { presentation } = domain;
  const room = open;
  for (let i = 0; i < 95; i++)
    domain.createMessage(
      room.id,
      i % 2 ? admin.id : member.id,
      `<p>page ${i}</p>`,
    );
  const ids = all(
    "SELECT id FROM messages WHERE room_id=? ORDER BY created_at,id",
    room.id,
  ).map((r) => r.id);
  const created = (id) =>
    get("SELECT created_at FROM messages WHERE id=?", id).created_at;
  const legacy = (clauses, args, direction) => {
    const rows = all(
      `${presentation} WHERE m.room_id=?${clauses} ORDER BY m.created_at ${direction}, m.id ${direction} LIMIT 40`,
      room.id,
      ...args,
    );
    return direction === "ASC" ? rows : rows.reverse();
  };
  const pivot = ids[50];
  assert.deepEqual(domain.messagesForRoom(room.id), legacy("", [], "DESC"));
  assert.deepEqual(
    domain.messagesForRoom(room.id, { before: pivot }),
    legacy(" AND m.created_at<?", [created(pivot)], "DESC"),
  );
  assert.deepEqual(
    domain.messagesForRoom(room.id, { after: pivot }),
    legacy(" AND m.created_at>?", [created(pivot)], "ASC"),
  );
  assert.equal(domain.messagesForRoom(room.id).length, 40);
});

test("fastEtag is stable per body, weak, and differs between bodies", async () => {
  const { fastEtag } = await import("../src/gzip.js");
  const a = Buffer.from("<p>one</p>".repeat(200));
  const b = Buffer.from("<p>two</p>".repeat(200));
  assert.match(fastEtag(a), /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  assert.equal(fastEtag(a), fastEtag(Buffer.from(a)));
  assert.notEqual(fastEtag(a), fastEtag(b));
});
test("a posted message answers with the same fragment it broadcasts and indexes it once", async () => {
  const { cachedMessages } = await import("../src/rendering.js");
  const http = await httpSession(admin, "turbo-post-session");
  try {
    const response = await http.post(`/rooms/${open.id}/messages`, {
      "message[body]": "<p>Turbo <b>echo</b> marker</p>",
      "message[client_message_id]": "turbo-echo-1",
    });
    assert.equal(response.status, 200);
    const message = get(
      "SELECT id FROM messages WHERE client_message_id='turbo-echo-1'",
    );
    assert.equal(
      await response.text(),
      `<turbo-stream action="append" target="messages_rooms_open_${open.id}"><template>${String(cachedMessages([domain.messageById(message.id)])[0].Fragment)}</template></turbo-stream>`,
    );
    assert.deepEqual(
      all(
        "SELECT rowid,body FROM message_search_index WHERE rowid=?",
        message.id,
      ).map((r) => ({ ...r })),
      [{ rowid: message.id, body: "Turbo echo marker" }],
    );
    assert.equal(
      get(
        "SELECT count(*) AS n FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
        message.id,
      ).n,
      1,
    );
  } finally {
    await http.close();
  }
});
