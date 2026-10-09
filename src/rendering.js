import { Eta } from "eta";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { all, get } from "./db.js";
import * as rails from "./rails.js";
import { embeddedBlobIds, escape, plainText, renderBody } from "./richtext.js";
import { blobUrl, representationUrl } from "./storage.js";
import { FragmentCache } from "./fragment_cache.js";
// Output keeps nunjucks autoescape semantics byte for byte: null and undefined print nothing,
// SafeString values print verbatim, and everything else is stringified and escaped with the
// nunjucks table, which unlike Eta's default also escapes backslash. The check is per value at
// runtime, so data such as message HTML stays unescaped wherever it is printed.
class SafeString {
  constructor(value) {
    this.val = value;
  }
  toString() {
    return this.val;
  }
}
export const safe = (value) => new SafeString(value || "");
// Message HTML stored with its UTF-8 bytes. Inside renderChunks() it prints a marker instead,
// and the page is assembled around the stored bytes rather than encoding them again.
class FragmentHtml extends SafeString {
  constructor({ text, bytes }) {
    super(text);
    this.bytes = bytes;
  }
}
// NUL never occurs in rendered HTML text; the random part keeps user input from forging a marker.
const MARK = `\u0000${randomBytes(6).toString("hex")}:`;
let spliced = null;
const escapes = {
  "&": "&amp;",
  '"': "&quot;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
  "\\": "&#92;",
};
function escapeOutput(value) {
  if (value == null) return "";
  if (value instanceof SafeString) {
    if (!spliced || !(value instanceof FragmentHtml)) return value.val;
    spliced.push(value.bytes);
    return `${MARK}${spliced.length - 1}\u0000`;
  }
  return String(value).replace(/[&"'<>\\]/g, (char) => escapes[char]);
}
const templateDir = new URL("../templates/eta/", import.meta.url);
const templateSources = readdirSync(templateDir)
  .filter((file) => file.endsWith(".eta"))
  .sort()
  .map((file) => [
    file.slice(0, -".eta".length),
    readFileSync(new URL(file, templateDir), "utf8"),
  ]);
const generatedCache = new Map();
function generated(name, fallback = "") {
  if (!generatedCache.has(name)) {
    const path = new URL(`../assets/generated/${name}`, import.meta.url);
    generatedCache.set(
      name,
      existsSync(path) ? readFileSync(path, "utf8") : fallback,
    );
  }
  return generatedCache.get(name);
}
let manifest;
export function asset(name) {
  manifest ||= JSON.parse(generated("manifest.json", "{}"));
  return "/assets/" + (manifest[name]?.digested_path || name);
}
export function epoch(value) {
  return value
    ? new Date(
        String(value).replace(" ", "T") +
          (String(value).endsWith("Z") ? "" : "Z"),
      ).getTime() || 0
    : 0;
}
export function iso(value) {
  return new Date(epoch(value)).toISOString();
}
export function avatar(id, updated) {
  return (
    `/users/${rails.signedId("User", Number(id), "avatar")}/avatar` +
    (updated ? "?v=" + versionTime(updated) : "")
  );
}
export function versionTime(value) {
  return new Date(epoch(value))
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
}
export function userData(user) {
  if (!user) return { ID: 0, Role: 0, Name: "" };
  return {
    ID: user.id,
    Role: user.role,
    Name: user.name,
    Email: user.email_address || "",
    Bio: user.bio || "",
    UpdatedAt: user.updated_at,
    Title: [user.name, user.bio].filter(Boolean).join(" – "),
    Status: user.status,
    BotKey: `${user.id}-${user.bot_token}`,
    Administer: user.role === 1,
  };
}
export function roomData(room, user, directMembers) {
  const kind = (room.type || "Rooms::Open").split("::").pop().toLowerCase();
  const members =
    kind === "direct"
      ? (
          directMembers ??
          all(
            "SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.room_id=? ORDER BY u.name",
            room.id,
          )
        )
          .filter((u) => u.id !== user?.id)
          .map(({ member_room_id, ...rest }) => rest)
      : [];
  return {
    ID: room.id || 0,
    Name:
      kind === "direct"
        ? members.map((u) => u.name).join(", ")
        : room.name || "",
    Type: room.type,
    UpdatedAt: room.updated_at,
    CreatorID: room.creator_id,
    DOM: (prefix) => `${prefix}_rooms_${kind}_${room.id}`,
    Noun: kind === "direct" ? "ping" : "room",
    EditPath: `/rooms/${kind}s/${room.id}/edit`,
    Members: members.map(userData),
    Label: members.map((u) => u.name.split(" ")[0]).join(", "),
  };
}
export function messageData(messages) {
  if (!messages.length) return [];
  const ids = messages.map((m) => m.id),
    placeholders = ids.map(() => "?").join(",");
  const bodies = new Map(
    all(
      `SELECT record_id,body FROM action_text_rich_texts WHERE record_type='Message' AND name='body' AND record_id IN (${placeholders})`,
      ...ids,
    ).map((r) => [r.record_id, r.body || ""]),
  );
  const blobs = new Map(
    all(
      `SELECT a.record_id,b.* FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='Message' AND a.name='attachment' AND a.record_id IN (${placeholders})`,
      ...ids,
    ).map((r) => [r.record_id, r]),
  );
  const boosts = all(
    `SELECT b.*,u.name,u.bio,u.updated_at AS booster_updated_at FROM boosts b JOIN users u ON u.id=b.booster_id WHERE b.message_id IN (${placeholders}) ORDER BY b.created_at, b.id`,
    ...ids,
  );
  return messages.map((m) => {
    const blob = blobs.get(m.id);
    let body = renderBody(bodies.get(m.id) || "");
    let url = "";
    if (blob) {
      url = blobUrl(blob);
      const name = escape(blob.filename);
      if (
        (blob.content_type || "").startsWith("image/") ||
        blob.content_type === "application/pdf"
      )
        body = `<a href="${url}" data-lightbox-target="image" data-action="lightbox#open" data-lightbox-url-value="${url}?disposition=attachment"><img class="message__attachment" src="${representationUrl(blob)}" alt="${name}" loading="lazy"></a>`;
      else if ((blob.content_type || "").startsWith("video/"))
        body = `<video src="${url}" poster="${representationUrl(blob)}" controls class="message__attachment"></video>`;
      else body = `<a href="${url}?disposition=attachment">${name}</a>`;
    }
    return {
      ID: m.id,
      ClientID: m.client_message_id,
      CreatorID: m.creator_id,
      Creator:
        m.creator_name ||
        get("SELECT name FROM users WHERE id=?", m.creator_id)?.name,
      CreatorTitle: m.creator_name,
      CreatorUpdatedAt: m.creator_updated_at,
      RoomID: m.room_id,
      RoomName: m.room_name || "",
      CreatedAt: m.created_at,
      UpdatedAt: m.updated_at,
      HTML: safe('<div class="lexxy-content">' + body + "</div>"),
      AllEmoji:
        !!plainText(bodies.get(m.id)) &&
        !/[\p{L}\p{N}]/u.test(plainText(bodies.get(m.id))),
      Boosts: boosts
        .filter((b) => b.message_id === m.id)
        .map((b) => ({
          ID: b.id,
          MessageID: b.message_id,
          BoosterID: b.booster_id,
          Booster: b.name,
          BoosterTitle: b.name,
          BoosterUpdatedAt: b.booster_updated_at,
          Content: b.content,
        })),
      Attachment: blob ? { Filename: blob.filename } : null,
      DownloadURL: url ? url + "?disposition=attachment" : "",
      BlobURL: url,
      Permalink: `/rooms/${m.room_id}/@${m.id}`,
    };
  });
}
export const messageFragments = new FragmentCache(
  Number(process.env.CAMPFIRE_FRAGMENT_CACHE_MB || 32) * 1024 * 1024,
  (entry) => entry.text.length * 2 + entry.bytes.length,
);
const fragmentEntry = (text) => ({ text, bytes: Buffer.from(text, "utf8") });

// Runs produce() and returns the page it renders as UTF-8 chunks: template text, and the stored
// bytes of each message fragment printed. Other results of produce() are returned as they are.
export function renderChunks(produce) {
  const outer = spliced;
  const own = (spliced = []);
  let html;
  try {
    html = produce();
  } finally {
    spliced = outer;
  }
  if (typeof html !== "string") return html;
  const chunks = [];
  let pos = 0;
  for (let at; (at = html.indexOf(MARK, pos)) >= 0;) {
    const end = html.indexOf("\u0000", at + MARK.length);
    if (at > pos) chunks.push(Buffer.from(html.slice(pos, at), "utf8"));
    chunks.push(own[Number(html.slice(at + MARK.length, end))]);
    pos = end + 1;
  }
  if (pos < html.length) chunks.push(Buffer.from(html.slice(pos), "utf8"));
  return chunks;
}
// Changing any template must not serve HTML rendered by the previous templates.
const templateDigest = templateSources
  .reduce(
    (hash, [name, source]) => hash.update(`${name}\0${source}\0`),
    createHash("sha256"),
  )
  .digest("hex")
  .slice(0, 12);

const placeholders = (n) => Array(n).fill("?").join(",");
const sha1 = (value) => createHash("sha1").update(value).digest("base64");

// Rails keys on the message's updated_at alone. Writers that keep timestamps (replaceAttachment,
// other processes, the sqlite3 CLI) exist, so the key is a digest of every row value messageData()
// prints: the message and its creator and room columns, the whole body, the attachment blob, the
// blobs the body embeds, the boosts in display order, and origin because Permalink embeds the
// request host. Names of @mentioned users are not keyed, matching Rails, whose cached fragment
// also keeps the old mention text until the message changes.
export function messageCacheKeys(rows, origin = "") {
  if (!rows.length) return [];
  const ids = rows.map((m) => m.id);
  const content = all(
    `SELECT m.id,r.body,b.id AS blob_id,b.filename,b.content_type,(SELECT json_group_array(json_array(o.id,o.booster_id,o.updated_at,o.content,u.name,u.updated_at) ORDER BY o.created_at,o.id) FROM boosts o JOIN users u ON u.id=o.booster_id WHERE o.message_id=m.id) AS boosts FROM messages m LEFT JOIN action_text_rich_texts r ON r.record_type='Message' AND r.name='body' AND r.record_id=m.id LEFT JOIN active_storage_attachments a ON a.record_type='Message' AND a.name='attachment' AND a.record_id=m.id LEFT JOIN active_storage_blobs b ON b.id=a.blob_id WHERE m.id IN (${placeholders(ids.length)})`,
    ...ids,
  ).map((r) => ({ ...r, embeds: embeddedBlobIds(r.body || "") }));
  const embedIds = [...new Set(content.flatMap((r) => r.embeds))];
  const embeds = new Map(
    embedIds.length
      ? all(
          `SELECT id,filename,content_type FROM active_storage_blobs WHERE id IN (${placeholders(embedIds.length)})`,
          ...embedIds,
        ).map((b) => [b.id, [b.filename, b.content_type]])
      : [],
  );
  const versions = new Map(
    content.map((r) => [
      r.id,
      [
        r.body,
        r.blob_id,
        r.filename,
        r.content_type,
        r.embeds.map((id) => [id, embeds.get(id) ?? null]),
        r.boosts,
      ],
    ]),
  );
  return rows.map(
    (m) =>
      `message/${templateDigest}/${m.id}/${sha1(
        JSON.stringify([
          m.updated_at,
          m.created_at,
          m.client_message_id,
          m.creator_id,
          m.creator_name,
          m.creator_updated_at,
          m.room_id,
          m.room_name,
          versions.get(m.id) ?? null,
          origin,
        ]),
      )}`,
  );
}

export function cachedMessages(rows, keys = messageCacheKeys(rows)) {
  if (!rows.length) return [];
  const missing = rows.filter((_, i) => !messageFragments.has(keys[i]));
  const built = new Map(
    messageData(missing).map((data) => [data.ID, fragment("message", data)]),
  );
  return rows.map((m, i) => ({
    Fragment: new FragmentHtml(
      messageFragments.fetch(keys[i], () =>
        fragmentEntry(
          built.get(m.id) ?? fragment("message", messageData([m])[0]),
        ),
      ),
    ),
  }));
}
const translations = JSON.parse(
  readFileSync(new URL("./translations.json", import.meta.url)),
);
const reactions = [
  ["👍", "Thumbs up"],
  ["👏", "Clapping"],
  ["👋", "Waving hand"],
  ["💪", "Muscle"],
  ["❤️", "Red heart"],
  ["😂", "Face with tears of joy"],
  ["🎉", "Party popper"],
  ["🔥", "Fire"],
];
// Mirrors nunjucks for-loops: falsy values loop zero times, iterable objects are spread, and
// anything else (strings included, per UTF-16 unit) is walked by index up to its length.
function each(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "object" && Symbol.iterator in value)
    return Array.from(value);
  return Array.from({ length: value.length }, (_, i) => value[i]);
}
const partials = Object.create(null);
const helpers = {
  asset,
  avatar,
  epoch,
  iso,
  versionTime,
  len: (x) => x?.length || 0,
  get: (x, k) => x?.[k] || false,
  firstName: (s) => (s || "").split(" ")[0],
  lower: (s) => (s || "").toLowerCase(),
  stylesheets: () => safe(generated("stylesheets.html")),
  importmap: () => safe(generated("importmap.html")),
  printf: (fmt, ...args) => fmt.replace(/%[sd]/g, () => args.shift()),
  allEmoji: (s) => !!s && !/[\p{L}\p{N}]/u.test(s),
  qrpath: (s) => "/qr_code/" + Buffer.from(s).toString("base64url"),
  humanInvolvement: (s) =>
    ({
      everything: "Notifying about all messages",
      mentions: "Notifying about @ mentions",
      nothing: "Notifications are off",
      invisible: "Notifications are off and room invisible in sidebar",
    })[s] || "",
  nextInvolvement: (kind, v) => {
    const choices =
      kind === "Rooms::Direct"
        ? ["everything", "nothing"]
        : ["mentions", "everything", "nothing", "invisible"];
    return choices[(choices.indexOf(v) + 1) % choices.length];
  },
  reactions: () =>
    reactions.map(([Character, Title]) => ({ Character, Title })),
  agent: (s) => ({ Name: s, Platform: "", Browser: s }),
  helpMailto: (u) => safe(`href="mailto:${escape(u.Email)}"`),
  botCommand: (origin, room, key) =>
    `curl -d 'Hello!' ${origin}/rooms/${room}/${key}/messages`,
  translate: (key) =>
    safe(
      '<details class="position-relative" data-controller="popup"><summary class="btn"><img width="20" height="20" src="' +
        asset("globe.svg") +
        '"><span class="for-screen-reader">Translate</span></summary><dl>' +
        (translations[key] || [])
          .map(
            ([flag, text]) =>
              `<dt>${escape(flag)}</dt><dd>${escape(text)}</dd>`,
          )
          .join("") +
        "</dl></details>",
    ),
  each,
  partials,
};
const eta = new Eta({
  autoTrim: false,
  escapeFunction: escapeOutput,
  varName: "dot",
  functionHeader: `const { ${Object.keys(helpers).join(", ")} } = this.config.helpers;`,
  helpers,
});
for (const [name, source] of templateSources) {
  const template = eta.compile(source);
  partials[name] = (dot) => template.call(eta, dot);
}
export function fragment(name, data = {}) {
  const template = partials[name.replaceAll("-", "_")];
  if (!template) throw new Error(`Unknown template: ${name}`);
  return template(data);
}
export function render(req, screen, extra = {}) {
  const account = req.account ?? get("SELECT * FROM accounts LIMIT 1");
  let settings = {};
  try {
    settings = JSON.parse(account?.settings || "{}");
  } catch {}
  const Account = account
    ? {
        ID: account.id,
        Name: account.name,
        JoinCode: account.join_code,
        UpdatedAt: account.updated_at,
        HasLogo: !!get(
          "SELECT id FROM active_storage_attachments WHERE record_type='Account' AND record_id=? AND name='logo'",
          account.id,
        ),
        RestrictRooms: !!settings.restrict_room_creation_to_administrators,
        RestrictRoomCreation:
          !!settings.restrict_room_creation_to_administrators,
      }
    : {};
  const data = {
    User: userData(req.user),
    Account,
    Screen: screen,
    BodyClass:
      screen === "search"
        ? "sidebar searches"
        : ["room", "welcome"].includes(screen)
          ? "sidebar"
          : screen,
    Title: "Campfire",
    Frame: !!req.get?.("Turbo-Frame"),
    Origin: `${req.protocol || "http"}://${req.get?.("host") || "localhost"}`,
    Version: "once-campfire-express",
    VAPIDPublicKey: process.env.VAPID_PUBLIC_KEY || "",
    CustomStyles: safe(
      account?.custom_styles ? `<style>${account.custom_styles}</style>` : "",
    ),
    Messages: [],
    RecentSearches: [],
    RoomsStream: rails.signStream("rooms"),
    UserRoomsStream: req.user
      ? rails.signStream(
          Buffer.from(`gid://campfire/User/${req.user.id}`)
            .toString("base64")
            .replace(/=+$/, "") + ":rooms",
        )
      : "",
    CanCreateRooms: req.user?.role === 1 || !Account.RestrictRooms,
    Notice: "",
    Error: "",
    Reload: false,
    Chat: screen === "room",
    ReturnRoom: req.session?.last_room_id || "",
    Query: "",
    ...extra,
  };
  return fragment(screen, data);
}
