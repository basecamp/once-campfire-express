import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.SECRET_KEY_BASE = "embedded-blobs-tests-".repeat(8);
const temp = mkdtempSync(join(tmpdir(), "campfire-embedded-blobs-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { run, get, now, initialize, databaseFile } =
  await import("../src/db.js");
const { openDatabase } = await import("../src/sqlite.js");
const domain = await import("../src/domain.js");
const rails = await import("../src/rails.js");
const storage = await import("../src/storage.js");
const { cachedMessages } = await import("../src/rendering.js");

let admin, room;

before(() => {
  initialize();
  const t = now();
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
    "Embedded",
    "join-code",
    t,
    t,
  );
  admin = domain.createUser({
    name: "Admin",
    email_address: "admin@example.test",
    password: "password",
    role: 1,
  });
  const id = Number(
    run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      "Lobby",
      "Rooms::Open",
      admin.id,
      t,
      t,
    ).lastInsertRowid,
  );
  room = get("SELECT * FROM rooms WHERE id=?", id);
  domain.grantMemberships(room, [admin.id]);
});

after(() => rmSync(temp, { recursive: true, force: true }));

function foreignly(sql, ...params) {
  const foreign = openDatabase(databaseFile());
  try {
    foreign.prepare(sql).run(...params);
  } finally {
    foreign.close();
  }
}

const rendered = (message) =>
  String(cachedMessages([domain.messageById(message.id)])[0].Fragment);

function embed(name, html) {
  const message = domain.createMessage(room.id, admin.id, "<p>embed</p>");
  const blob = storage.replaceAttachment(
    {
      buffer: Buffer.from("doc"),
      originalname: name,
      mimetype: "text/plain",
    },
    "Message",
    message.id,
    "spare",
  );
  const sgid = rails.sgid("ActiveStorage::Blob", blob.id);
  run(
    "UPDATE action_text_rich_texts SET body=? WHERE record_type='Message' AND record_id=?",
    html(sgid),
    message.id,
  );
  return { message, blob };
}

for (const [label, html] of [
  [
    "an entity-encoded sgid",
    (sgid) =>
      `<p><action-text-attachment sgid="${sgid.replace("--", "-&#45;")}"></action-text-attachment></p>`,
  ],
  [
    "an entity-encoded trix figure",
    (sgid) =>
      `<figure data-trix-attachment="{&quot;sgid&quot;:&quot;${sgid.replace("--", "-&#45;")}&quot;}"></figure>`,
  ],
])
  test(`a foreign rename of a blob embedded through ${label} re-renders the message`, () => {
    const { message, blob } = embed(`${label}.txt`, html);
    assert.match(rendered(message), new RegExp(`>${label}\\.txt<`));
    foreignly(
      "UPDATE active_storage_blobs SET filename=? WHERE id=?",
      "renamed.txt",
      blob.id,
    );
    assert.match(rendered(message), />renamed\.txt</);
  });
