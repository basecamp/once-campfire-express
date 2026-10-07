import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { get } from "./db.js";
import * as rails from "./rails.js";
import { publicResponses } from "./static_responses.js";
import {
  variant,
  pathFor,
  serve,
  serveBytes,
  removeAttachment,
  purgeBlob,
} from "./storage.js";

const colors = [
  "#AF2E1B",
  "#CC6324",
  "#3B4B59",
  "#BFA07A",
  "#ED8008",
  "#ED3F1C",
  "#BF1B1B",
  "#736B1E",
  "#D07B53",
  "#736356",
  "#AD1D1D",
  "#BF7C2A",
  "#C09C6F",
  "#698F9C",
  "#7C956B",
  "#5D618F",
  "#3B3633",
  "#67695E",
];
function crc32(value) {
  let c = -1;
  for (const byte of Buffer.from(value)) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ -1) >>> 0;
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function attachment(type, id, name) {
  return get(
    "SELECT b.* FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type=? AND a.record_id=? AND a.name=?",
    type,
    id,
    name,
  );
}
function cache(req, res, etag) {
  res.set({
    ETag: etag,
    "Cache-Control": "public, max-age=1800, stale-while-revalidate=604800",
  });
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return true;
  }
  return false;
}
async function buildAvatar(user, blob) {
  if (blob) {
    const out = await variant(blob, [512, 512], "webp");
    return {
      body: await fs.promises.readFile(pathFor(out.key)),
      filename: out.filename,
    };
  }
  if (user.role === 2)
    return {
      svg: true,
      body: fs.readFileSync(
        "reference/app/assets/images/default-bot-avatar.svg",
      ),
    };
  const initials = Array.from(user.name.matchAll(/(?:^|\s)(\S)/gu))
    .map((m) => m[1])
    .join("");
  const svg = fs
    .readFileSync("reference/app/views/users/avatars/show.svg.erb", "utf8")
    .replace(
      "<%= avatar_background_color(@user) %>",
      colors[crc32(String(user.id)) % colors.length],
    )
    .replace("<%= @user.initials %>", escape(initials))
    .replace(
      /<%=raw .*? %>/g,
      initials.length >= 3
        ? 'textLength="85%" lengthAdjust="spacingAndGlyphs"'
        : "",
    );
  // A string body keeps res.send's "; charset=utf-8"; the bot file is sent as a Buffer without it.
  return { svg: true, body: svg };
}
function sendAvatar(req, res, avatar) {
  if (avatar.svg) return res.type("image/svg+xml").send(avatar.body);
  serveBytes(req, res, avatar.body, "image/webp", avatar.filename);
}
export const healthCheck = (req, res) =>
  req.accepts(["html", "json"]) === "json"
    ? res.json({ status: "ok" })
    : res
        .type("html")
        .send(
          '<!doctype html><html><body style="background-color: green"></body></html>',
        );
export function registerPublic(app) {
  app.get("/users/:userId/avatar", async (req, res) => {
    try {
      const user = get(
        "SELECT * FROM users WHERE id=?",
        rails.verifyId("User", req.params.userId, "avatar"),
      );
      if (!user) return res.sendStatus(404);
      const blob = attachment("User", user.id, "avatar");
      const etag = `"${crypto
        .createHash("sha256")
        .update(JSON.stringify([user.id, user.name, user.updated_at, blob?.id]))
        .digest("hex")}"`;
      if (cache(req, res, etag)) return;
      // The ETag covers every input of the body, so an entry under it never goes stale.
      const cached = publicResponses.get("avatar:" + etag);
      if (cached) return sendAvatar(req, res, cached);
      const built = await buildAvatar(user, blob);
      publicResponses.fetch("avatar:" + etag, () => built);
      sendAvatar(req, res, built);
    } catch {
      res.sendStatus(404);
    }
  });
  app.delete("/users/me/avatar", (req, res) => {
    if (!req.user) return res.sendStatus(401);
    for (const id of removeAttachment("User", req.user.id, "avatar"))
      purgeBlob(id);
    res.redirect("/users/me/profile");
  });
  app.get("/account/logo", async (req, res) => {
    try {
      const account = get("SELECT * FROM accounts LIMIT 1");
      const blob = account && attachment("Account", account.id, "logo");
      if (blob) {
        const out = await variant(
          blob,
          req.query.size === "small" ? [192, 192] : [512, 512],
          "png",
        );
        return serve(req, res, pathFor(out.key), "image/png", out.filename);
      }
      const filename =
        req.query.size === "small" ? "app-icon-192.png" : "app-icon.png";
      res
        .type("png")
        .send(
          fs.readFileSync(
            path.join("reference/app/assets/images/logos", filename),
          ),
        );
    } catch {
      res.sendStatus(404);
    }
  });
  app.delete("/account/logo", (req, res) => {
    if (!req.user || req.user.role !== 1) return res.sendStatus(403);
    const account = get("SELECT * FROM accounts LIMIT 1");
    if (account)
      for (const id of removeAttachment("Account", account.id, "logo"))
        purgeBlob(id);
    res.redirect("/account/edit");
  });
  app.get(["/webmanifest", "/webmanifest.json"], (req, res) => {
    const account = get("SELECT name FROM accounts LIMIT 1");
    res.type("application/manifest+json").json({
      name: account?.name || "Campfire",
      icons: [
        {
          src: "/account/logo?size=small",
          type: "image/png",
          sizes: "192x192",
        },
        { src: "/account/logo", type: "image/png", sizes: "512x512" },
        {
          src: "/account/logo",
          type: "image/png",
          sizes: "512x512",
          purpose: "maskable",
        },
      ],
      start_url: "/",
      display: "standalone",
      scope: "/",
      description: "A chat app from the makers of Basecamp and HEY.",
      categories: ["social", "business", "productivity"],
      theme_color: "#ffffff",
      background_color: "#ffffff",
      shortcuts: [
        { name: "New chat room", url: "/rooms/opens/new" },
        { name: "My profile", url: "/users/me/profile" },
      ],
    });
  });
  app.get(["/service-worker", "/service-worker.js"], (req, res) =>
    res
      .type("application/javascript")
      .send(fs.readFileSync("reference/app/views/pwa/service_worker.js")),
  );
  app.get("/qr_code/:id", async (req, res) => {
    try {
      const raw = rails.decode64(req.params.id);
      const value = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      if (value.length > 4096) return res.sendStatus(422);
      res.type("png").send(await QRCode.toBuffer(value));
    } catch {
      res.sendStatus(404);
    }
  });
}
