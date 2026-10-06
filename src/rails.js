import {
  createHmac,
  pbkdf2Sync,
  timingSafeEqual,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

// Rails wire contracts are checked against independently generated golden vectors.
const keys = new Map();
let clock = () => new Date();
export function setClock(fn) {
  clock = fn || (() => new Date());
}
export const parseJSON = (text) =>
  JSON.parse(text, (k, v, context) =>
    typeof v === "number" &&
    Number.isInteger(v) &&
    !Number.isSafeInteger(v) &&
    /^-?\d+$/.test(context.source || "")
      ? BigInt(context.source)
      : v,
  );
export const stringify = (value) =>
  JSON.stringify(value, (k, v) =>
    typeof v === "bigint" ? JSON.rawJSON(v.toString()) : v,
  );
export const encode = (value) =>
  Buffer.from(
    stringify(value).replace(
      /[<>&]/g,
      (c) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[c],
    ),
  );
export const b64 = (value) => Buffer.from(value).toString("base64");
export function decode64(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) ||
    value.replace(/=+$/, "").length % 4 === 1
  )
    throw new Error("invalid base64");
  return Buffer.from(value, "base64");
}
const MEMO_LIMIT = 1000;
const cookieMemo = new Map();
const signMemo = new Map();
let memoSecret;
// Every memo is a pure function of its input and SECRET_KEY_BASE; drop them all when the secret changes.
function syncSecret(secret) {
  if (secret === memoSecret) return;
  memoSecret = secret;
  keys.clear();
  cookieMemo.clear();
  signMemo.clear();
}
function remember(memo, id, value) {
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value);
  memo.set(id, value);
}
function recall(memo, id) {
  const value = memo.get(id);
  if (value !== undefined) {
    memo.delete(id);
    memo.set(id, value);
  }
  return value;
}
function cloneValue(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(cloneValue);
  const copy = Object.getPrototypeOf(v) === null ? Object.create(null) : {};
  for (const k of Object.keys(v)) copy[k] = cloneValue(v[k]);
  return copy;
}
let observedExpiry = null;
function memoizedCookie(name, raw, compute) {
  syncSecret(process.env.SECRET_KEY_BASE);
  const id = name + "\u0000" + raw;
  const hit = recall(cookieMemo, id);
  if (hit) {
    if (hit.error) throw new Error(hit.error);
    if (hit.exp === null || hit.exp > clock().getTime())
      return cloneValue(hit.value);
    cookieMemo.delete(id);
  }
  observedExpiry = null;
  try {
    const value = compute();
    remember(cookieMemo, id, {
      value: cloneValue(value),
      exp: observedExpiry,
    });
    return value;
  } catch (e) {
    if (!/^expired/.test(e.message))
      remember(cookieMemo, id, { error: e.message });
    throw e;
  }
}
export function key(salt, length = 64) {
  const secret = process.env.SECRET_KEY_BASE;
  if (!secret) throw new Error("SECRET_KEY_BASE is required");
  syncSecret(secret);
  const id = salt + "\u0000" + length;
  let derived = keys.get(id);
  if (!derived) {
    if (keys.size >= 64) keys.clear();
    derived = pbkdf2Sync(secret, salt, 1000, length, "sha256");
    keys.set(id, derived);
  }
  return derived;
}
const mac = (data, salt, algorithm = "sha1") =>
  createHmac(algorithm, key(salt)).update(data).digest("hex");
export function equal(a, b) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
// Read only Marshal data primitives; never instantiate Ruby classes or execute code.
function marshal(raw) {
  let offset = 2,
    nodes = 0;
  const symbols = [],
    objects = [];
  const byte = () => {
    if (offset >= raw.length) throw new Error("truncated Marshal");
    return raw[offset++];
  };
  function integer() {
    let n = byte();
    if (n > 127) n -= 256;
    if (n === 0) return 0;
    if (n > 4) return n - 5;
    if (n < -4) return n + 5;
    const width = Math.abs(n);
    let value = n < 0 ? -1n : 0n;
    for (let i = 0; i < width; i++) {
      const mask = 255n << BigInt(i * 8);
      value = (value & ~mask) | (BigInt(byte()) << BigInt(i * 8));
    }
    return Number(value);
  }
  function bytes() {
    const length = integer();
    if (length < 0 || length > 1048576 || offset + length > raw.length)
      throw new Error("invalid Marshal length");
    const text = raw.subarray(offset, offset + length).toString("utf8");
    offset += length;
    return text;
  }
  function read(depth = 0) {
    if (depth > 32 || ++nodes > 10000)
      throw new Error("Marshal limits exceeded");
    const type = byte();
    if (type === 48) return null;
    if (type === 84) return true;
    if (type === 70) return false;
    if (type === 105) return integer();
    if (type === 34) {
      const value = bytes();
      objects.push(value);
      return value;
    }
    if (type === 58) {
      const value = bytes();
      symbols.push(value);
      return value;
    }
    if (type === 59) {
      const i = integer();
      if (i < 0 || i >= symbols.length) throw new Error("invalid symbol link");
      return symbols[i];
    }
    if (type === 64) {
      const i = integer();
      if (i < 0 || i >= objects.length) throw new Error("invalid object link");
      return objects[i];
    }
    if (type === 73) {
      const value = read(depth + 1),
        count = integer();
      if (count < 0 || count > 1000)
        throw new Error("invalid instance metadata");
      for (let i = 0; i < count; i++) {
        const k = read(depth + 1);
        if (!["E", "encoding"].includes(k))
          throw new Error("unsupported Marshal metadata");
        read(depth + 1);
      }
      return value;
    }
    if (type === 91) {
      const count = integer();
      if (count < 0 || count > 10000) throw new Error("invalid Marshal array");
      const value = [];
      objects.push(value);
      for (let i = 0; i < count; i++) value.push(read(depth + 1));
      return value;
    }
    if (type === 123) {
      const count = integer();
      if (count < 0 || count > 10000) throw new Error("invalid Marshal hash");
      const value = Object.create(null);
      objects.push(value);
      for (let i = 0; i < count; i++) {
        const k = read(depth + 1);
        if (
          typeof k !== "string" ||
          ["__proto__", "constructor", "prototype"].includes(k)
        )
          throw new Error("invalid Marshal key");
        value[k] = read(depth + 1);
      }
      return value;
    }
    if (type === 102) {
      const text = bytes();
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error("nonfinite Marshal float");
      objects.push(value);
      return value;
    }
    throw new Error("unsupported Marshal type");
  }
  return read();
}
function load(raw) {
  return raw[0] === 4 && raw[1] === 8
    ? marshal(raw)
    : parseJSON(raw.toString("utf8"));
}

export function unpack(raw, purpose = null) {
  const v = load(raw);
  if (v && typeof v === "object" && !Array.isArray(v) && "_rails" in v) {
    const m = v._rails;
    if (!m || typeof m !== "object" || (m.pur || "") !== (purpose || ""))
      throw new Error("invalid purpose");
    if (
      m.exp !== undefined &&
      m.exp !== null &&
      !(new Date(m.exp).getTime() > clock().getTime())
    )
      throw new Error("expired message");
    return "message" in m ? load(decode64(m.message)) : m.data;
  }
  if (purpose) throw new Error("missing purpose");
  return v;
}
export function sign(
  value,
  salt,
  purpose = null,
  expiry = null,
  algorithm = "sha1",
  urlsafe = false,
  padded = true,
  options = {},
) {
  const m = { data: value };
  if (expiry) m.exp = new Date(expiry).toISOString();
  if (purpose) m.pur = purpose;
  const envelope = purpose || expiry ? { _rails: m } : value;
  let payload = (
    options.plainJson ? Buffer.from(stringify(envelope)) : encode(envelope)
  ).toString(urlsafe ? "base64url" : "base64");
  if (urlsafe && padded) payload += "=".repeat((4 - (payload.length % 4)) % 4);
  if (!padded) payload = payload.replace(/=+$/, "");
  return payload + "--" + mac(payload, salt, algorithm);
}
export function verify(raw, salt, purpose = null, algorithm = "sha1") {
  if (typeof raw !== "string") throw new Error("invalid message");
  const i = raw.lastIndexOf("--");
  if (i < 0) throw new Error("invalid message");
  const payload = raw.slice(0, i),
    signature = raw.slice(i + 2);
  if (!equal(signature, mac(payload, salt, algorithm)))
    throw new Error("invalid signature");
  return unpack(decode64(payload), purpose);
}
function cookieEnvelope(name, value, expiry = null) {
  return encode({
    _rails: {
      message: b64(encode(value)),
      exp: expiry ? new Date(expiry).toISOString() : null,
      pur: "cookie." + name,
    },
  });
}
export function signCookie(name, value, expiry = null) {
  const p = b64(cookieEnvelope(name, value, expiry));
  return p + "--" + mac(p, "signed cookie");
}
function cookieValue(raw, name) {
  if (raw.toString().startsWith('{"_rails":{"message":"')) {
    const m = parseJSON(raw.toString())._rails;
    if (m.pur && m.pur !== "cookie." + name)
      throw new Error("invalid cookie purpose");
    if (m.exp) {
      const exp = new Date(m.exp).getTime();
      if (!(exp > clock().getTime())) throw new Error("expired cookie");
      observedExpiry = exp;
    }
    raw = decode64(m.message);
  }
  return parseJSON(raw.toString());
}
export const verifyCookie = (name, raw) =>
  typeof raw === "string"
    ? memoizedCookie(name, "v" + raw, () => verifyCookieUncached(name, raw))
    : verifyCookieUncached(name, raw);
function verifyCookieUncached(name, raw) {
  raw = decodeURIComponent(raw);
  const i = raw.lastIndexOf("--");
  if (i < 0) throw new Error("invalid cookie");
  const p = raw.slice(0, i);
  if (!equal(raw.slice(i + 2), mac(p, "signed cookie")))
    throw new Error("invalid cookie signature");
  return cookieValue(decode64(p), name);
}
export function encryptCookie(name, value, expiry = null, options = {}) {
  const nonce = options.nonce || randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      key("authenticated encrypted cookie", 32),
      nonce,
    );
  const data = Buffer.concat([
    cipher.update(cookieEnvelope(name, value, expiry)),
    cipher.final(),
  ]);
  return [data, nonce, cipher.getAuthTag()].map(b64).join("--");
}
export const decryptCookie = (name, raw) =>
  typeof raw === "string"
    ? memoizedCookie(name, "d" + raw, () => decryptCookieUncached(name, raw))
    : decryptCookieUncached(name, raw);
function decryptCookieUncached(name, raw) {
  const parts = decodeURIComponent(raw).split("--");
  if (parts.length !== 3) throw new Error("invalid cookie");
  const [data, nonce, tag] = parts.map(decode64);
  if (nonce.length !== 12 || tag.length !== 16)
    throw new Error("invalid cookie");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key("authenticated encrypted cookie", 32),
    nonce,
  );
  cipher.setAuthTag(tag);
  return cookieValue(
    Buffer.concat([cipher.update(data), cipher.final()]),
    name,
  );
}
function modelPurpose(model, purpose) {
  if (model.startsWith("Rooms::")) model = "Room";
  const underscored = model
    .replaceAll("::", "/")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return underscored + (purpose ? "/" + purpose : "");
}
export function signedId(model, id, purpose = "", expiry = null) {
  if (expiry) return signedIdUncached(model, id, purpose, expiry);
  syncSecret(process.env.SECRET_KEY_BASE);
  const memoKey = `${model}\u0000${typeof id}\u0000${id}\u0000${purpose}`;
  let value = recall(signMemo, memoKey);
  if (value === undefined) {
    value = signedIdUncached(model, id, purpose, expiry);
    remember(signMemo, memoKey, value);
  }
  return value;
}
function signedIdUncached(model, id, purpose, expiry) {
  return model === "ActiveStorage::Blob"
    ? sign(id, "ActiveStorage", purpose || "blob_id", expiry)
    : sign(
        id,
        "active_record/signed_id",
        modelPurpose(model, purpose),
        expiry,
        "sha256",
        true,
        false,
        { plainJson: true },
      );
}
export function verifyId(model, raw, purpose = "") {
  let value;
  if (model === "ActiveStorage::Blob")
    value = verify(raw, "ActiveStorage", purpose || "blob_id");
  else {
    const p = modelPurpose(model, purpose);
    try {
      value = verify(raw, "active_record/signed_id", p, "sha256");
    } catch {
      value = verify(raw, "active_record/signed_id", p, "sha1");
    }
  }
  if (
    !["string", "number", "bigint"].includes(typeof value) ||
    !/^[-+]?\d+$/.test(String(value))
  )
    throw new Error("invalid model id");
  const id = BigInt(value);
  return id > BigInt(Number.MAX_SAFE_INTEGER) ||
    id < BigInt(Number.MIN_SAFE_INTEGER)
    ? id
    : Number(id);
}
export const stream = (room) =>
  Buffer.from(`gid://campfire/${room.type}/${room.id}`).toString("base64url") +
  ":messages";
export function signStream(name) {
  syncSecret(process.env.SECRET_KEY_BASE);
  const memoKey = "stream\u0000" + name;
  let value = recall(signMemo, memoKey);
  if (value === undefined) {
    value = signStreamUncached(name);
    remember(signMemo, memoKey, value);
  }
  return value;
}
const signStreamUncached = (name) =>
  sign(
    name,
    "turbo/signed_stream_verifier_key",
    null,
    null,
    "sha256",
    false,
    true,
    { plainJson: true },
  );
export function verifyStream(raw) {
  const v = verify(raw, "turbo/signed_stream_verifier_key", null, "sha256");
  if (typeof v !== "string" && typeof v !== "number")
    throw new Error("invalid stream");
  return v;
}
export const sgid = (model, id) =>
  sign(
    `gid://campfire/${model}/${id}?expires_in`,
    "signed_global_ids",
    "attachable",
    null,
    "sha1",
    true,
  );
export function verifySgid(raw, purpose = "attachable") {
  let v;
  try {
    v = verify(raw, "signed_global_ids", purpose);
  } catch {
    v = verify(raw, "signed_global_ids");
    if (!v || typeof v !== "object" || v.purpose !== purpose)
      throw new Error("invalid GlobalID purpose");
    if (v.expires_at && !(new Date(v.expires_at) >= clock()))
      throw new Error("expired GlobalID");
    v = v.gid;
  }
  if (typeof v !== "string") throw new Error("invalid GlobalID");
  return v;
}
export function unverifiedUserGid(raw) {
  try {
    const envelope = JSON.parse(decode64(raw.slice(0, raw.lastIndexOf("--"))));
    const m = envelope._rails;
    if (!m || typeof m !== "object") return null;
    let v = m.data;
    if (v == null && m.message)
      v = decode64(m.message)
        .toString()
        .match(/gid:\/\/campfire\/[^/]+\/\d+/)?.[0];
    if (typeof v !== "string") return null;
    if (!v.startsWith("gid://")) v = decode64(v).toString();
    const url = new URL(v);
    return url.protocol === "gid:" &&
      url.hostname &&
      /^\/User\/\d+$/.test(url.pathname)
      ? Number(url.pathname.split("/").at(-1))
      : null;
  } catch {
    return null;
  }
}
export function maskCsrf(raw) {
  if (raw.length !== 32) throw new Error("invalid CSRF secret");
  const pad = randomBytes(32);
  return Buffer.concat([
    pad,
    Buffer.from(raw.map((x, i) => x ^ pad[i])),
  ]).toString("base64url");
}
export function validCsrf(raw, token, path = null, method = null) {
  try {
    if (raw.length !== 32) return false;
    let v = decode64(token);
    if (v.length === 32) return equal(v, raw);
    if (v.length === 64)
      v = Buffer.from(v.subarray(0, 32).map((x, i) => x ^ v[i + 32]));
    if (v.length !== 32) return false;
    const candidates = [
      raw,
      createHmac("sha256", raw).update("!real_csrf_token").digest(),
    ];
    if (path != null && method != null)
      candidates.push(
        createHmac("sha256", raw)
          .update(path.replace(/\/$/, "") + "#" + method.toLowerCase())
          .digest(),
      );
    return candidates.some((c) => equal(v, c));
  } catch {
    return false;
  }
}
