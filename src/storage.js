import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import express from "express";
import sharp from "sharp";
import { all, get, run, transaction, now, touch } from "./db.js";
import * as rails from "./rails.js";

const execute = promisify(execFile);
const staged = new AsyncLocalStorage();
export const filesPath = () =>
  path.resolve(
    process.env.FILES_PATH ||
      path.join(
        process.env.CAMPFIRE_STORAGE_PATH ||
          process.env.STORAGE_PATH ||
          "storage",
        "files",
      ),
  );
export function pathFor(key) {
  if (!/^[a-zA-Z0-9]{4,128}$/.test(key)) throw new Error("invalid storage key");
  return path.join(filesPath(), key.slice(0, 2), key.slice(2, 4), key);
}
const checksum = (raw) => crypto.createHash("md5").update(raw).digest("base64");
export function stagedFiles(fn) {
  if (staged.getStore()) return fn();
  const paths = [];
  const clean = (error) => {
    for (const file of paths) fs.rmSync(file, { force: true });
    throw error;
  };
  return staged.run(paths, () => {
    try {
      const result = fn();
      return result && typeof result.then === "function"
        ? result.catch(clean)
        : result;
    } catch (error) {
      return clean(error);
    }
  });
}
function write(key, raw) {
  const target = pathFor(key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, raw, { flag: "wx" });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  staged.getStore()?.push(target);
}
export function storeUpload(upload, recordType, recordId, name) {
  const raw = upload.buffer || upload.data;
  if (!Buffer.isBuffer(raw) || raw.length > 50 * 1024 * 1024)
    throw new Error("invalid upload");
  const key = crypto.randomBytes(14).toString("hex");
  return stagedFiles(() =>
    transaction(() => {
      write(key, raw);
      const id = Number(
        run(
          "INSERT INTO active_storage_blobs(key,filename,content_type,byte_size,checksum,metadata,service_name,created_at) VALUES(?,?,?,?,?,?,?,?)",
          key,
          path.basename(upload.originalname || upload.filename || "file"),
          upload.mimetype || upload.content_type || "application/octet-stream",
          raw.length,
          checksum(raw),
          "{}",
          "local",
          now(),
        ).lastInsertRowid,
      );
      run(
        "INSERT INTO active_storage_attachments(name,record_type,record_id,blob_id,created_at) VALUES(?,?,?,?,?)",
        name,
        recordType,
        recordId,
        id,
        now(),
      );
      touchRecord(recordType, recordId);
      return get("SELECT * FROM active_storage_blobs WHERE id=?", id);
    }),
  );
}
export function attachSigned(token, recordType, recordId, name, userId = null) {
  const id = rails.verifyId("ActiveStorage::Blob", token, "blob_id");
  const blob = get("SELECT * FROM active_storage_blobs WHERE id=?", id);
  if (!blob || !fs.existsSync(pathFor(blob.key)))
    throw new Error("upload missing");
  const owner = JSON.parse(blob.metadata || "{}").campfire_upload_user_id;
  if (owner && Number(owner) !== Number(userId))
    throw new Error("upload belongs to another user");
  if (userId != null && !authorizedBlob(blob, { id: userId }))
    throw new Error("attachment access denied");
  run(
    "INSERT INTO active_storage_attachments(name,record_type,record_id,blob_id,created_at) VALUES(?,?,?,?,?)",
    name,
    recordType,
    recordId,
    id,
    now(),
  );
  touchRecord(recordType, recordId);
  return blob;
}
// Like Rails' `belongs_to :record, touch: true`: rendered messages are cached by updated_at.
function touchRecord(recordType, recordId) {
  if (recordType === "Message") touch("messages", recordId);
}
export function removeAttachment(recordType, recordId, name) {
  const ids = all(
    "SELECT blob_id FROM active_storage_attachments WHERE record_type=? AND record_id=? AND name=?",
    recordType,
    recordId,
    name,
  ).map((r) => r.blob_id);
  run(
    "DELETE FROM active_storage_attachments WHERE record_type=? AND record_id=? AND name=?",
    recordType,
    recordId,
    name,
  );
  if (ids.length) touchRecord(recordType, recordId);
  return ids;
}
export function replaceAttachment(upload, recordType, recordId, name) {
  return stagedFiles(() =>
    transaction(() => {
      const old = removeAttachment(recordType, recordId, name);
      const blob = storeUpload(upload, recordType, recordId, name);
      return { ...blob, removedBlobIds: old };
    }),
  );
}
export function purgeBlob(id) {
  if (
    get("SELECT id FROM active_storage_attachments WHERE blob_id=? LIMIT 1", id)
  )
    return;
  const blob = get("SELECT * FROM active_storage_blobs WHERE id=?", id);
  if (!blob) return;
  const children = [];
  transaction(() => {
    for (const variant of all(
      "SELECT id FROM active_storage_variant_records WHERE blob_id=?",
      id,
    )) {
      children.push(
        ...all(
          "SELECT blob_id FROM active_storage_attachments WHERE record_type='ActiveStorage::VariantRecord' AND record_id=?",
          variant.id,
        ).map((r) => r.blob_id),
      );
      run(
        "DELETE FROM active_storage_attachments WHERE record_type='ActiveStorage::VariantRecord' AND record_id=?",
        variant.id,
      );
    }
    children.push(
      ...all(
        "SELECT blob_id FROM active_storage_attachments WHERE record_type='ActiveStorage::Blob' AND record_id=?",
        id,
      ).map((r) => r.blob_id),
    );
    run(
      "DELETE FROM active_storage_attachments WHERE record_type='ActiveStorage::Blob' AND record_id=?",
      id,
    );
    run("DELETE FROM active_storage_variant_records WHERE blob_id=?", id);
    run("DELETE FROM active_storage_blobs WHERE id=?", id);
  });
  fs.rmSync(pathFor(blob.key), { force: true });
  for (const child of children) purgeBlob(child);
}
export function blobUrl(blob) {
  return `/rails/active_storage/blobs/redirect/${rails.signedId("ActiveStorage::Blob", blob.id, "blob_id")}/${encodeURIComponent(blob.filename)}`;
}
export function representationUrl(blob, dimensions = [1200, 800], format) {
  const transforms = {
    format: format || path.extname(blob.filename).slice(1) || "png",
    resize_to_limit: dimensions,
  };
  return `/rails/active_storage/representations/redirect/${rails.signedId("ActiveStorage::Blob", blob.id, "blob_id")}/${rails.sign(transforms, "ActiveStorage", "variation")}/${encodeURIComponent(blob.filename)}`;
}
const binary = new Set([
  "text/html",
  "image/svg+xml",
  "application/postscript",
  "application/x-shockwave-flash",
  "text/xml",
  "application/xml",
  "application/xhtml+xml",
  "application/mathml+xml",
  "text/cache-manifest",
]);
const inline = new Set([
  "image/webp",
  "image/avif",
  "image/png",
  "image/gif",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
  "image/vnd.adobe.photoshop",
  "image/vnd.microsoft.icon",
  "application/pdf",
]);
export function servingAttributes(type, disposition = "inline") {
  type = (type || "application/octet-stream").split(";")[0].toLowerCase();
  return binary.has(type)
    ? ["application/octet-stream", "attachment"]
    : [
        type,
        inline.has(type) && disposition !== "attachment"
          ? "inline"
          : "attachment",
      ];
}
export function serve(req, res, file, type, filename, disposition = "inline") {
  if (!fs.existsSync(file)) return res.sendStatus(404);
  const size = fs.statSync(file).size;
  res.set({
    "Accept-Ranges": "bytes",
    "Content-Type": type,
    "Content-Disposition": `${disposition === "attachment" ? "attachment" : "inline"}; filename="${filename.replace(/[\r\n"\\]/g, "")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  let start = 0,
    end = size - 1;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2]))
      return res.status(416).set("Content-Range", `bytes */${size}`).end();
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size
    )
      return res.status(416).set("Content-Range", `bytes */${size}`).end();
    res.status(206).set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.set("Content-Length", String(Math.max(0, end - start + 1)));
  if (req.method === "HEAD" || size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on("error", (error) => res.destroy(error));
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
export function authorizedBlob(blob, user) {
  if (!user) return false;
  const attachments = all(
    "SELECT * FROM active_storage_attachments WHERE blob_id=?",
    blob.id,
  );
  if (!attachments.length) {
    const owner = JSON.parse(blob.metadata || "{}").campfire_upload_user_id;
    return owner == null || Number(owner) === Number(user.id);
  }
  return attachments.some((a) => {
    if (a.record_type === "User" || a.record_type === "Account") return true;
    let messageId = a.record_id;
    if (a.record_type === "ActionText::RichText")
      messageId = get(
        "SELECT record_id FROM action_text_rich_texts WHERE id=? AND record_type='Message'",
        a.record_id,
      )?.record_id;
    if (a.record_type !== "Message" && a.record_type !== "ActionText::RichText")
      return false;
    return !!get(
      "SELECT m.id FROM messages m JOIN memberships ms ON ms.room_id=m.room_id WHERE m.id=? AND ms.user_id=?",
      messageId,
      user.id,
    );
  });
}
export async function variant(blob, dimensions = [1200, 800], format) {
  if (
    !Array.isArray(dimensions) ||
    dimensions.length !== 2 ||
    dimensions.some((n) => !Number.isInteger(n) || n < 1 || n > 16384)
  )
    throw new Error("invalid dimensions");
  format ||= path.extname(blob.filename).slice(1).toLowerCase();
  if (format === "jpg") format = "jpeg";
  if (!["png", "jpeg", "webp", "gif", "tiff", "avif"].includes(format))
    format = "png";
  // Native variant records own generated files; digest is intentionally namespaced from Rails Marshal variants.
  const digest = crypto
    .createHash("sha1")
    .update(`express:${JSON.stringify([dimensions, format])}`)
    .digest("base64");
  const existing = get(
    "SELECT b.* FROM active_storage_variant_records v JOIN active_storage_attachments a ON a.record_type='ActiveStorage::VariantRecord' AND a.record_id=v.id AND a.name='image' JOIN active_storage_blobs b ON b.id=a.blob_id WHERE v.blob_id=? AND v.variation_digest=?",
    blob.id,
    digest,
  );
  if (existing && fs.existsSync(pathFor(existing.key))) return existing;
  const raw = await sharp(pathFor(blob.key), { limitInputPixels: 100_000_000 })
    .rotate()
    .resize(...dimensions, { fit: "inside", withoutEnlargement: true })
    .sharpen()
    .toFormat(format)
    .toBuffer();
  const metadata = await sharp(raw).metadata();
  return stagedFiles(() =>
    transaction(() => {
      const winner = get(
        "SELECT id FROM active_storage_variant_records WHERE blob_id=? AND variation_digest=?",
        blob.id,
        digest,
      );
      if (winner) {
        const result = get(
          "SELECT b.* FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='ActiveStorage::VariantRecord' AND a.record_id=?",
          winner.id,
        );
        if (result && fs.existsSync(pathFor(result.key))) return result;
      }
      const id =
        winner?.id ||
        Number(
          run(
            "INSERT INTO active_storage_variant_records(blob_id,variation_digest) VALUES(?,?)",
            blob.id,
            digest,
          ).lastInsertRowid,
        );
      const output = storeUpload(
        {
          buffer: raw,
          originalname: `${path.parse(blob.filename).name}.${format}`,
          mimetype: `image/${format}`,
        },
        "ActiveStorage::VariantRecord",
        id,
        "image",
      );
      run(
        "UPDATE active_storage_blobs SET metadata=? WHERE id=?",
        JSON.stringify({
          identified: true,
          analyzed: true,
          width: metadata.width,
          height: metadata.height,
        }),
        output.id,
      );
      return output;
    }),
  );
}
export async function analyze(blob) {
  let metadata = {
    ...JSON.parse(blob.metadata || "{}"),
    identified: true,
    analyzed: true,
  };
  if (
    /^image\/(png|jpeg|gif|tiff|webp|avif|heic|heif)$/.test(
      blob.content_type || "",
    )
  ) {
    const image = await sharp(pathFor(blob.key)).metadata();
    metadata = { ...metadata, width: image.width, height: image.height };
  } else if (/^(audio|video)\//.test(blob.content_type || "")) {
    const { stdout } = await execute(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        pathFor(blob.key),
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const probe = JSON.parse(stdout);
    metadata.duration = Number(probe.format?.duration || 0);
    const v = probe.streams?.find((s) => s.codec_type === "video");
    if (v)
      Object.assign(metadata, { width: v.width, height: v.height, angle: 0 });
  }
  run(
    "UPDATE active_storage_blobs SET metadata=? WHERE id=?",
    JSON.stringify(metadata),
    blob.id,
  );
  return metadata;
}
export async function preview(blob) {
  const existing = get(
    "SELECT b.* FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='ActiveStorage::Blob' AND a.record_id=? AND a.name='preview_image'",
    blob.id,
  );
  if (existing && fs.existsSync(pathFor(existing.key))) return existing;
  const root = path.join(
    process.env.CAMPFIRE_STORAGE_PATH || process.env.STORAGE_PATH || "storage",
    "tmp",
  );
  fs.mkdirSync(root, { recursive: true });
  const temp = fs.mkdtempSync(path.join(root, "preview-"));
  try {
    const out = path.join(temp, "preview.webp");
    if ((blob.content_type || "").startsWith("video/"))
      await execute(
        "ffmpeg",
        [
          "-nostdin",
          "-loglevel",
          "error",
          "-i",
          pathFor(blob.key),
          "-y",
          "-vframes",
          "1",
          "-vf",
          "thumbnail,scale=1200:800:force_original_aspect_ratio=decrease",
          out,
        ],
        { timeout: 60000, maxBuffer: 1024 * 1024 },
      );
    else if (blob.content_type === "application/pdf") {
      await execute(
        "pdftoppm",
        [
          "-f",
          "1",
          "-singlefile",
          "-png",
          "-scale-to",
          "1200",
          pathFor(blob.key),
          path.join(temp, "preview"),
        ],
        { timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      await sharp(path.join(temp, "preview.png")).webp().toFile(out);
    } else return null;
    return storeUpload(
      {
        buffer: fs.readFileSync(out),
        originalname: `${path.parse(blob.filename).name}.webp`,
        mimetype: "image/webp",
      },
      "ActiveStorage::Blob",
      blob.id,
      "preview_image",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
export async function processAttachment(blob) {
  await analyze(blob);
  if (
    /^image\/(png|jpeg|gif|tiff|webp|avif|heic|heif)$/.test(
      blob.content_type || "",
    )
  )
    return variant(blob);
  if (
    blob.content_type === "application/pdf" ||
    blob.content_type?.startsWith("video/")
  )
    return preview(blob);
}
export function registerStorage(app) {
  app.post("/rails/active_storage/direct_uploads", (req, res) => {
    if (!req.user) return res.sendStatus(401);
    try {
      const data = req.body.blob;
      if (
        !data ||
        !Number.isSafeInteger(data.byte_size) ||
        data.byte_size < 0 ||
        data.byte_size > 50 * 1024 * 1024 ||
        !/^.{1,255}$/.test(data.filename) ||
        !/^[A-Za-z0-9+/]{22}==$/.test(data.checksum)
      )
        return res.sendStatus(422);
      const key = crypto.randomBytes(14).toString("hex"),
        type = data.content_type || "application/octet-stream";
      const id = Number(
        run(
          "INSERT INTO active_storage_blobs(key,filename,content_type,byte_size,checksum,metadata,service_name,created_at) VALUES(?,?,?,?,?,?,?,?)",
          key,
          path.basename(data.filename),
          type,
          data.byte_size,
          data.checksum,
          JSON.stringify({
            ...data.metadata,
            campfire_upload_user_id: req.user.id,
          }),
          "local",
          now(),
        ).lastInsertRowid,
      );
      const token = rails.sign(
        {
          key,
          content_type: type,
          content_length: data.byte_size,
          checksum: data.checksum,
        },
        "ActiveStorage",
        "blob_token",
        new Date(Date.now() + 300000),
      );
      res.json({
        id,
        key,
        filename: path.basename(data.filename),
        content_type: type,
        byte_size: data.byte_size,
        checksum: data.checksum,
        signed_id: rails.signedId("ActiveStorage::Blob", id, "blob_id"),
        attachable_sgid: rails.sgid("ActiveStorage::Blob", id),
        direct_upload: {
          url: `${req.protocol}://${req.get("host")}/rails/active_storage/disk/${token}`,
          headers: { "Content-Type": type },
        },
      });
    } catch {
      res.sendStatus(422);
    }
  });
  app.put(
    "/rails/active_storage/disk/:token",
    express.raw({ type: () => true, limit: "50mb" }),
    (req, res) => {
      try {
        const data = rails.verify(
          req.params.token,
          "ActiveStorage",
          "blob_token",
        );
        if (
          !Buffer.isBuffer(req.body) ||
          req.body.length !== data.content_length ||
          checksum(req.body) !== data.checksum
        )
          return res.sendStatus(422);
        write(data.key, req.body);
        res.status(204).end();
      } catch {
        res.sendStatus(404);
      }
    },
  );
  app.get("/rails/active_storage/disk/:token/{*filename}", (req, res) => {
    try {
      const data = rails.verify(req.params.token, "ActiveStorage", "blob_key");
      serve(
        req,
        res,
        pathFor(data.key),
        ...servingAttributes(data.content_type, data.disposition).slice(0, 1),
        data.filename || "file",
        servingAttributes(data.content_type, data.disposition)[1],
      );
    } catch {
      res.sendStatus(404);
    }
  });
  for (const kind of ["redirect", "proxy"])
    app.get(
      `/rails/active_storage/blobs/${kind}/:token/:filename`,
      (req, res) => {
        if (!req.user) return res.sendStatus(401);
        try {
          const blob = get(
            "SELECT * FROM active_storage_blobs WHERE id=?",
            rails.verifyId("ActiveStorage::Blob", req.params.token, "blob_id"),
          );
          if (!blob) return res.sendStatus(404);
          if (!authorizedBlob(blob, req.user)) return res.sendStatus(403);
          const [type, disposition] = servingAttributes(
            blob.content_type,
            req.query.disposition,
          );
          serve(req, res, pathFor(blob.key), type, blob.filename, disposition);
        } catch {
          res.sendStatus(404);
        }
      },
    );
  for (const kind of ["redirect", "proxy"])
    app.get(
      `/rails/active_storage/representations/${kind}/:token/:variation/:filename`,
      async (req, res) => {
        if (!req.user) return res.sendStatus(401);
        try {
          const blob = get(
            "SELECT * FROM active_storage_blobs WHERE id=?",
            rails.verifyId("ActiveStorage::Blob", req.params.token, "blob_id"),
          );
          if (!blob) return res.sendStatus(404);
          if (!authorizedBlob(blob, req.user)) return res.sendStatus(403);
          const transforms = rails.verify(
            req.params.variation,
            "ActiveStorage",
            "variation",
          );
          if (
            !transforms ||
            Object.keys(transforms).some(
              (k) => !["format", "resize_to_limit"].includes(k),
            )
          )
            return res.sendStatus(404);
          const source =
            blob.content_type === "application/pdf" ||
            blob.content_type?.startsWith("video/")
              ? await preview(blob)
              : blob;
          const out = await variant(
            source,
            transforms.resize_to_limit || [1200, 800],
            transforms.format,
          );
          serve(req, res, pathFor(out.key), out.content_type, out.filename);
        } catch {
          res.sendStatus(404);
        }
      },
    );
}
