import sanitizeHtml from "sanitize-html";
import { parseFragment } from "parse5";
import { get, all, run, now } from "./db.js";
import { blobUrl, representationUrl, authorizedBlob } from "./storage.js";
import { verifySgid, unverifiedUserGid } from "./rails.js";
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function sanitize(body = "") {
  return sanitizeHtml(canonicalize(String(body)), {
    allowedTags: [
      "a",
      "abbr",
      "b",
      "blockquote",
      "br",
      "caption",
      "code",
      "dd",
      "del",
      "div",
      "dl",
      "dt",
      "em",
      "figcaption",
      "figure",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "i",
      "img",
      "li",
      "mark",
      "ol",
      "p",
      "pre",
      "s",
      "small",
      "span",
      "strong",
      "sub",
      "sup",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tfoot",
      "tr",
      "u",
      "ul",
      "time",
      "action-text-attachment",
      "actiontext-opengraph-embed",
    ],
    allowedAttributes: {
      "*": ["class", "dir", "lang", "data-language"],
      a: ["href", "title"],
      img: ["src", "alt", "width", "height"],
      "action-text-attachment": [
        "sgid",
        "content-type",
        "content",
        "url",
        "href",
        "filename",
        "filesize",
        "width",
        "height",
        "presentation",
        "caption",
      ],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowProtocolRelative: false,
  });
}
export function canonicalize(body = "") {
  return String(body).replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, (html) => {
    const node = parseFragment(html).childNodes[0];
    const attrs = Object.fromEntries(
      (node?.attrs || []).map((a) => [a.name, a.value]),
    );
    if (!attrs["data-trix-attachment"]) return html;
    let values = {};
    for (const name of ["data-trix-attachment", "data-trix-attributes"])
      try {
        values = { ...values, ...JSON.parse(attrs[name] || "{}") };
      } catch {}
    values["content-type"] = values.contentType || "";
    delete values.contentType;
    return (
      "<action-text-attachment " +
      Object.entries(values)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k}="${escape(v)}"`)
        .join(" ") +
      "></action-text-attachment>"
    );
  });
}
const ATTACHMENT =
  /<action-text-attachment\b([^>]*)>(?:[\s\S]*?<\/action-text-attachment>)?/g;
const nodeAttributes = (node) =>
  Object.fromEntries((node?.attrs || []).map((a) => [a.name, a.value]));
const attachmentAttributes = (html) =>
  nodeAttributes(parseFragment(html).childNodes[0]);
function blobId(sgid) {
  try {
    const id = verifySgid(sgid || "").match(
      /^gid:\/\/campfire\/ActiveStorage::Blob\/(\d+)(?:\?|$)/,
    )?.[1];
    return id ? Number(id) : null;
  } catch {
    return null;
  }
}
export function attachedBlob(attrs) {
  const id = blobId(attrs.sgid);
  return id ? get("SELECT * FROM active_storage_blobs WHERE id=?", id) : null;
}
const plainTree = (body) =>
  parseFragment(
    canonicalize(body)
      .replace(/^[ \t\n\v\f\r\0]+|[ \t\n\v\f\r\0]+$/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/\0/g, ""),
  );
// renderBody finds attachments in the sanitized HTML and plainText in its own parse of the
// canonical body; the parsers disagree on malformed markup, so the sgids come from both. Parsing
// is pure, so it is memoized per body, but verification runs every time because sgids expire.
const sgidsByBody = new Map();
function attachmentSgids(body) {
  let sgids = sgidsByBody.get(body);
  if (sgids) return sgids;
  const found = new Set();
  for (const [html] of sanitize(body).matchAll(ATTACHMENT))
    found.add(attachmentAttributes(html).sgid);
  (function collect(node) {
    if (node.tagName === "action-text-attachment")
      found.add(nodeAttributes(node).sgid);
    for (const child of node.childNodes || []) collect(child);
  })(plainTree(body));
  if (sgidsByBody.size >= 256) sgidsByBody.clear();
  sgidsByBody.set(body, (sgids = [...found]));
  return sgids;
}
// Ids of every blob that renderBody or plainText may read for this body.
export function embeddedBlobIds(body = "") {
  // Bare action-text-attachment tags and trix figures (data-trix-attachment) both say "attachment".
  if (!body.includes("attachment")) return [];
  return [...new Set(attachmentSgids(body).map(blobId).filter(Boolean))];
}
export function plainText(body = "") {
  function visit(node) {
    if (node.nodeName === "#text") return node.value.replace(/[\r\n]+$/, "");
    const tag = node.tagName,
      attrs = Object.fromEntries(
        (node.attrs || []).map((a) => [a.name, a.value]),
      );
    if (["script", "style", "unsupported"].includes(tag)) return "";
    if (tag === "action-text-attachment") {
      const id = unverifiedUserGid(attrs.sgid || ""),
        user = id && get("SELECT name FROM users WHERE id=?", Number(id));
      if (user) return "@" + user.name;
      const blob = attachedBlob(attrs);
      if (blob) return attrs.caption || "[" + blob.filename + "]";
      const kind = (attrs["content-type"] || "").split("/")[0];
      return ["image", "video", "audio"].includes(kind)
        ? "[" + kind[0].toUpperCase() + kind.slice(1) + "]"
        : "";
    }
    const text = (node.childNodes || []).map(visit).join(""),
      trimmed = text.replace(/[\r\n]+$/, "");
    const ancestors = [];
    for (let p = node.parentNode; p; p = p.parentNode)
      if (["ul", "ol"].includes(p.tagName)) ancestors.push(p.tagName);
    if (["p", "h1"].includes(tag)) return trimmed + "\n\n";
    if (["ul", "ol"].includes(tag))
      return (ancestors.length ? "\n" : "") + trimmed + "\n\n";
    if (tag === "br") return "\n";
    if (tag === "div") return trimmed + "\n";
    if (tag === "figcaption") return "[" + trimmed + "]";
    if (tag === "blockquote") {
      const text = trimmed + "\n\n",
        content = text.trim();
      return content ? text.replace(content, "“" + content + "”") : "“”";
    }
    if (tag === "li") {
      const siblings = (node.parentNode?.childNodes || []).filter(
        (n) => n.nodeName !== "#text",
      );
      const bullet =
        ancestors[0] === "ol" ? String(siblings.indexOf(node) + 1) + "." : "•";
      return (
        "  ".repeat(Math.max(0, ancestors.length - 1)) +
        bullet +
        " " +
        trimmed +
        "\n"
      );
    }
    return text;
  }
  return visit(plainTree(body)).replace(/[\r\n]+$/, "");
}
export function mentionIds(body) {
  // reference/lib/rails_ext/action_text_attachables.rb retains User mentions across key rotation.
  const ids = new Set();
  for (const match of String(body).matchAll(
    /<action-text-attachment\b[^>]*\bsgid=["']([^"']+)/g,
  )) {
    const id = unverifiedUserGid(match[1]);
    if (id && get("SELECT id FROM users WHERE id=?", Number(id)))
      ids.add(Number(id));
  }
  return ids;
}
export function reconcileEmbeds(richId, body, userId = null) {
  const ids = new Set();
  const tree = parseFragment(body);
  function collect(node) {
    if (node.tagName === "action-text-attachment") {
      const blob = attachedBlob(
        Object.fromEntries(node.attrs.map((a) => [a.name, a.value])),
      );
      if (blob) {
        if (userId !== null && !authorizedBlob(blob, { id: userId }))
          throw Object.assign(
            new Error("Attachment room membership required"),
            { status: 422 },
          );
        const owner = JSON.parse(blob.metadata || "{}").campfire_upload_user_id;
        if (owner && userId !== null && owner !== userId)
          throw Object.assign(new Error("Upload belongs to another user"), {
            status: 422,
          });
        ids.add(blob.id);
      }
    }
    for (const child of node.childNodes || []) collect(child);
  }
  collect(tree);
  const obsolete = all(
    "SELECT blob_id FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=? AND name='embeds'",
    richId,
  ).filter((a) => !ids.has(a.blob_id));
  for (const row of obsolete)
    run(
      "DELETE FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=? AND blob_id=?",
      richId,
      row.blob_id,
    );
  for (const id of ids)
    run(
      "INSERT OR IGNORE INTO active_storage_attachments(record_type,record_id,name,blob_id,created_at) VALUES('ActionText::RichText',?,'embeds',?,?)",
      richId,
      id,
      now(),
    );
  return obsolete.map((a) => a.blob_id);
}
export function renderBody(body) {
  return sanitize(body).replace(ATTACHMENT, (full, attrs) => {
    const token = attrs.match(/\bsgid=["']([^"']+)/)?.[1];
    try {
      const id = unverifiedUserGid(token);
      const user = id && get("SELECT * FROM users WHERE id=?", Number(id));
      if (user)
        return `<span class="mention" data-user-id="${user.id}"><a href="/users/${user.id}">${escape(user.name)}</a></span>`;
    } catch {}
    const attributes = attachmentAttributes(full),
      blob = attachedBlob(attributes);
    if (blob) {
      const url = blobUrl(blob),
        filename = escape(blob.filename);
      if ((blob.content_type || "").startsWith("image/"))
        return `<figure class="attachment attachment--preview"><a href="${url}"><img src="${representationUrl(blob)}" alt="${filename}"></a>${attributes.caption ? "<figcaption>" + escape(attributes.caption) + "</figcaption>" : ""}</figure>`;
      return `<a href="${url}?disposition=attachment">${filename}</a>`;
    }
    return "";
  });
}

export function messagePlainText(messageId, body = "") {
  return (
    plainText(body) ||
    get(
      "SELECT b.filename FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='Message' AND a.record_id=? AND a.name='attachment'",
      messageId,
    )?.filename ||
    ""
  );
}
