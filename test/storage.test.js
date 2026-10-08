import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-media-"));
process.env.DATABASE_PATH = path.join(root, "db.sqlite3");
process.env.CAMPFIRE_STORAGE_PATH = root;
process.env.SECRET_KEY_BASE = "a".repeat(128);
const { initialize, get, run, transaction, now } = await import("../src/db.js");
initialize();
const storage = await import("../src/storage.js");
const jobs = await import("../src/jobs.js");
const { createBackup } = await import("../bin/backup.js");
const { restoreBackup } = await import("../bin/restore.js");
const { publicAddress, resolvePublic } = await import("../src/opengraph.js");
function files() {
  const walk = (d) =>
    fs.existsSync(d)
      ? fs
          .readdirSync(d, { withFileTypes: true })
          .flatMap((e) =>
            e.isDirectory()
              ? walk(path.join(d, e.name))
              : [path.join(d, e.name)],
          )
      : [];
  return walk(storage.filesPath());
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test("actual JPEG thumbnail shrinks 3840x2160 to 1200x675, caches and purges owned variants", async () => {
  const raw = await sharp({
    create: { width: 3840, height: 2160, channels: 3, background: "#cc4433" },
  })
    .jpeg()
    .toBuffer();
  const blob = storage.storeUpload(
    { buffer: raw, originalname: "photo.jpg", mimetype: "image/jpeg" },
    "Message",
    99,
    "attachment",
  );
  const out = await storage.variant(blob);
  const metadata = await sharp(storage.pathFor(out.key)).metadata();
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 675);
  assert.equal(metadata.format, "jpeg");
  assert.notDeepEqual(fs.readFileSync(storage.pathFor(out.key)), raw);
  assert.equal((await storage.variant(blob)).id, out.id);
  assert.equal(
    storage.removeAttachment("Message", 99, "attachment")[0],
    blob.id,
  );
  storage.purgeBlob(blob.id);
  assert.equal(
    get("SELECT id FROM active_storage_blobs WHERE id=?", out.id),
    undefined,
  );
  assert.equal(fs.existsSync(storage.pathFor(out.key)), false);
});
test("outer SQL failure rolls back both blobs and native files", () => {
  const count = files().length;
  assert.throws(() =>
    storage.stagedFiles(() =>
      transaction(() => {
        storage.storeUpload(
          {
            buffer: Buffer.from("hello"),
            originalname: "a.txt",
            mimetype: "text/plain",
          },
          "Message",
          100,
          "attachment",
        );
        throw new Error("rollback");
      }),
    ),
  );
  assert.equal(
    get("SELECT id FROM active_storage_attachments WHERE record_id=100"),
    undefined,
  );
  assert.equal(files().length, count);
});
test("asynchronous staging failure cleans files", async () => {
  const count = files().length;
  await assert.rejects(
    storage.stagedFiles(async () => {
      const blob = storage.storeUpload(
        {
          buffer: Buffer.from("bad image"),
          originalname: "bad.jpg",
          mimetype: "image/jpeg",
        },
        "Message",
        101,
        "attachment",
      );
      try {
        await storage.variant(blob);
      } finally {
        storage.removeAttachment("Message", 101, "attachment");
        storage.purgeBlob(blob.id);
      }
    }),
  );
  assert.equal(files().length, count);
});
test("storage traversal and Rails binary MIME policy", () => {
  assert.throws(() => storage.pathFor("../evil"));
  assert.deepEqual(storage.servingAttributes("image/svg+xml"), [
    "application/octet-stream",
    "attachment",
  ]);
  assert.deepEqual(storage.servingAttributes("text/plain"), [
    "text/plain",
    "attachment",
  ]);
  assert.deepEqual(storage.servingAttributes("image/jpeg"), [
    "image/jpeg",
    "inline",
  ]);
});
test("public fetch rejects loopback and mapped private addresses", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.2",
    "192.168.0.1",
    "169.254.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  await assert.rejects(resolvePublic("http://127.0.0.1/private"));
});
test("durable jobs recover expired leases and fence obsolete acknowledgements", () => {
  jobs.jobsDb().exec("DELETE FROM jobs");
  const id = jobs.enqueue("purge", { blob_id: 999 });
  const first = jobs.claim();
  assert.equal(first.id, id);
  assert.equal(jobs.claim(), null);
  const second = jobs.claim(first.lease_until + 121);
  assert.equal(second.id, id);
  assert.notEqual(second.lease_token, first.lease_token);
  assert.equal(jobs.finish(first), 0);
  assert.equal(jobs.finish(second), 1);
});
test("failed jobs back off then remain inspectable as dead", () => {
  jobs.jobsDb().exec("DELETE FROM jobs");
  jobs.enqueue("unknown", {});
  let time = Date.now() / 1000 + 1;
  for (let i = 0; i < 5; i++) {
    const job = jobs.claim(time);
    assert.ok(job);
    jobs.finish(job, new Error("broken"), time);
    time += 400;
  }
  assert.equal(
    jobs.jobsDb().prepare("SELECT status,attempts,last_error FROM jobs").get()
      .status,
    "dead",
  );
  assert.equal(jobs.claim(time), null);
});
test("native backup/restore preserves database and storage bytes", async () => {
  const blob = storage.storeUpload(
    {
      buffer: Buffer.from("backup bytes"),
      originalname: "a.txt",
      mimetype: "text/plain",
    },
    "Message",
    102,
    "attachment",
  );
  const archive = path.join(root, "backup.tar.gz");
  await createBackup(archive, root);
  const dest = path.join(root, "restored");
  restoreBackup(archive, dest);
  assert.deepEqual(
    fs.readFileSync(
      path.join(
        dest,
        "files",
        blob.key.slice(0, 2),
        blob.key.slice(2, 4),
        blob.key,
      ),
    ),
    Buffer.from("backup bytes"),
  );
  assert.throws(() => restoreBackup(archive, dest), /empty/);
});
test("signed direct upload enforces checksum, actual ranges, draft ownership and private membership", async () => {
  const express = (await import("express")).default;
  const rails = await import("../src/rails.js");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = req.headers["x-user"]
      ? { id: Number(req.headers["x-user"]) }
      : null;
    next();
  });
  storage.registerStorage(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const raw = Buffer.from("0123456789");
    const checksum = (await import("node:crypto"))
      .createHash("md5")
      .update(raw)
      .digest("base64");
    const creation = await fetch(
      base + "/rails/active_storage/direct_uploads",
      {
        method: "POST",
        headers: { "x-user": "1", "Content-Type": "application/json" },
        body: JSON.stringify({
          blob: {
            filename: "notes.txt",
            content_type: "text/plain",
            byte_size: raw.length,
            checksum,
          },
        }),
      },
    );
    assert.equal(creation.status, 200);
    const blob = await creation.json();
    let response = await fetch(blob.direct_upload.url, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "bad",
    });
    assert.equal(response.status, 422);
    response = await fetch(blob.direct_upload.url, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: raw,
    });
    assert.equal(response.status, 204);
    const url =
      base + `/rails/active_storage/blobs/redirect/${blob.signed_id}/notes.txt`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (await fetch(url, { headers: { "x-user": "2" } })).status,
      403,
    );
    response = await fetch(url, {
      headers: { "x-user": "1", Range: "bytes=2-5" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await response.text(), "2345");
    assert.ok(
      response.headers.get("content-disposition").startsWith("attachment;"),
    );
    assert.equal(
      (await fetch(url, { headers: { "x-user": "1", Range: "bytes=40-" } }))
        .status,
      416,
    );
    assert.throws(
      () =>
        storage.attachSigned(blob.signed_id, "Message", 888, "attachment", 2),
      /belongs/,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("native audio/video/PDF analysis and previews use real ffmpeg/poppler", async () => {
  const { execFileSync } = await import("node:child_process");
  const video = path.join(root, "test.mp4");
  const audio = path.join(root, "test.wav");
  execFileSync("ffmpeg", [
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:d=0.2",
    "-c:v",
    "mpeg4",
    "-y",
    video,
  ]);
  execFileSync("ffmpeg", [
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.2",
    "-y",
    audio,
  ]);
  const v = storage.storeUpload(
    {
      buffer: fs.readFileSync(video),
      originalname: "test.mp4",
      mimetype: "video/mp4",
    },
    "Message",
    103,
    "attachment",
  );
  const vm = await storage.analyze(v);
  assert.equal(vm.width, 320);
  assert.equal(vm.height, 180);
  assert.ok(vm.duration > 0);
  const pv = await storage.preview(v);
  assert.equal(
    (await sharp(storage.pathFor(pv.key)).metadata()).format,
    "webp",
  );
  const a = storage.storeUpload(
    {
      buffer: fs.readFileSync(audio),
      originalname: "test.wav",
      mimetype: "audio/wav",
    },
    "Message",
    104,
    "attachment",
  );
  assert.ok((await storage.analyze(a)).duration > 0);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf +=
    "xref\n0 5\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const p = storage.storeUpload(
    {
      buffer: Buffer.from(pdf),
      originalname: "test.pdf",
      mimetype: "application/pdf",
    },
    "Message",
    105,
    "attachment",
  );
  const pp = await storage.preview(p);
  const pm = await sharp(storage.pathFor(pp.key)).metadata();
  assert.equal(pm.format, "webp");
  assert.ok(pm.width <= 1200);
  assert.ok(pm.width > 0);
});
test("actual queued administrator webhook posts Rails JSON and persists bot reply without a loop", async () => {
  const http = await import("node:http");
  const { createUser, grantMemberships, createMessage } =
    await import("../src/domain.js");
  const creator = createUser({
    name: "Human",
    email_address: "human@example.test",
    password: "password123",
  });
  const bot = createUser({ name: "Robot", role: 2, bot_token: "bot-token" });
  const time = now();
  const room = Number(
    run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,'Rooms::Direct',?,?,?)",
      "Bot room",
      creator.id,
      time,
      time,
    ).lastInsertRowid,
  );
  grantMemberships({ id: room, type: "Rooms::Direct" }, [creator.id, bot.id]);
  let received;
  const receiver = http.createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    received = JSON.parse(text);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Actual native reply");
  });
  receiver.listen(0, "127.0.0.1");
  await new Promise((r) => receiver.once("listening", r));
  try {
    const hook = Number(
      run(
        "INSERT INTO webhooks(user_id,url,created_at,updated_at) VALUES(?,?,?,?)",
        bot.id,
        `http://127.0.0.1:${receiver.address().port}`,
        time,
        time,
      ).lastInsertRowid,
    );
    const message = createMessage(room, creator.id, "Hello @Robot");
    jobs.jobsDb().exec("DELETE FROM jobs");
    jobs.enqueue("webhook", { message_id: message.id, webhook_id: hook });
    assert.equal(await jobs.workOnce(), true);
    assert.equal(
      received.room.path,
      `/rooms/${room}/${bot.id}-bot-token/messages`,
    );
    assert.equal(received.message.body.plain, "Hello");
    assert.equal(received.user.id, creator.id);
    const reply = get(
      "SELECT * FROM messages WHERE creator_id=? ORDER BY id DESC LIMIT 1",
      bot.id,
    );
    assert.ok(reply);
    assert.equal(
      get(
        "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
        reply.id,
      ).body,
      "Actual native reply",
    );
    assert.equal(
      jobs
        .jobsDb()
        .prepare(
          "SELECT count(*) AS n FROM jobs WHERE payload LIKE '%webhook%'",
        )
        .get().n,
      0,
    );
    assert.equal(
      get(
        "SELECT count(*) AS n FROM message_search_index WHERE rowid=?",
        reply.id,
      ).n,
      1,
    );
  } finally {
    await new Promise((r) => receiver.close(r));
  }
});
test("private attached legacy blob requires actual room membership for download and reattachment", () => {
  const time = now();
  const u = Number(
    run(
      "INSERT INTO users(name,status,role,created_at,updated_at) VALUES(?,0,0,?,?)",
      "Private member",
      time,
      time,
    ).lastInsertRowid,
  );
  const outsider = Number(
    run(
      "INSERT INTO users(name,status,role,created_at,updated_at) VALUES(?,0,0,?,?)",
      "Outsider",
      time,
      time,
    ).lastInsertRowid,
  );
  const room = Number(
    run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,'Rooms::Closed',?,?,?)",
      "Private storage room",
      u,
      time,
      time,
    ).lastInsertRowid,
  );
  run(
    "INSERT INTO memberships(room_id,user_id,created_at,updated_at) VALUES(?,?,?,?)",
    room,
    u,
    time,
    time,
  );
  const message = Number(
    run(
      "INSERT INTO messages(room_id,creator_id,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      room,
      u,
      "private-storage-test",
      time,
      time,
    ).lastInsertRowid,
  );
  const blob = storage.storeUpload(
    {
      buffer: Buffer.from("private bytes"),
      originalname: "private.txt",
      mimetype: "text/plain",
    },
    "Message",
    message,
    "attachment",
  );
  assert.equal(storage.authorizedBlob(blob, { id: u }), true);
  assert.equal(storage.authorizedBlob(blob, { id: outsider }), false);
  const token = storage.blobUrl(blob).split("/")[5];
  assert.throws(
    () => storage.attachSigned(token, "Message", 999, "attachment", outsider),
    /access denied/,
  );
  assert.equal(
    get("SELECT id FROM active_storage_attachments WHERE record_id=999"),
    undefined,
  );
});
test("actual Rails-issued variation URL renders native JPEG thumbnail", async () => {
  // Generated independently with ActiveStorage::Variation.encode in the pinned Rails image, fixed test-only key.
  const variation =
    "eyJfcmFpbHMiOnsiZGF0YSI6eyJmb3JtYXQiOiJqcGciLCJyZXNpemVfdG9fbGltaXQiOlsxMjAwLDgwMF19LCJwdXIiOiJ2YXJpYXRpb24ifX0=--167c4454bfaf9c46eed3049820a1d693a438771a";
  const express = (await import("express")).default;
  const rails = await import("../src/rails.js");
  assert.deepEqual(rails.verify(variation, "ActiveStorage", "variation"), {
    format: "jpg",
    resize_to_limit: [1200, 800],
  });
  const raw = await sharp({
    create: { width: 3840, height: 2160, channels: 3, background: "#bb3311" },
  })
    .jpeg()
    .toBuffer();
  const blob = storage.storeUpload(
    { buffer: raw, originalname: "rails.jpg", mimetype: "image/jpeg" },
    "Message",
    777,
    "attachment",
  );
  storage.removeAttachment("Message", 777, "attachment");
  run(
    "UPDATE active_storage_blobs SET metadata=? WHERE id=?",
    JSON.stringify({ campfire_upload_user_id: 1 }),
    blob.id,
  );
  const app = express();
  app.use((req, res, next) => {
    req.user = { id: 1 };
    next();
  });
  storage.registerStorage(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/rails/active_storage/representations/redirect/${rails.signedId("ActiveStorage::Blob", blob.id, "blob_id")}/${variation}/rails.jpg`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const image = await sharp(
      Buffer.from(await response.arrayBuffer()),
    ).metadata();
    assert.deepEqual(
      [image.width, image.height, image.format],
      [1200, 675, "jpeg"],
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
