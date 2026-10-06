import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as r from "../src/rails.js";
const v = r.parseJSON(
  readFileSync(
    new URL("../compat/rails_compat.json", import.meta.url),
  ).toString(),
);
beforeEach(() => {
  process.env.SECRET_KEY_BASE = v.secret_key_base;
  r.setClock(() => new Date(v.now));
});
afterEach(() => r.setClock());
const check = (examples, fn, field = "expected") => {
  for (const e of examples) {
    r.setClock(() => new Date(e.now || v.now));
    let actual = null;
    try {
      actual = fn(e);
    } catch {}
    assert.deepEqual(actual, e[field], e.case || r.stringify(e));
  }
};
test("Rails PBKDF2 keys", () => {
  for (const e of v.key_generator)
    assert.equal(r.key(e.salt, e.length).toString("hex"), e.key_hex);
});
test("Rails signed cookie generation", () => {
  for (const e of v.signed_cookies.generate)
    assert.equal(r.signCookie(e.name, e.value, e.expires_at), e.raw);
});
test("Rails signed cookie verification", () =>
  check(v.signed_cookies.verify, (e) => r.verifyCookie(e.name, e.raw)));
test("Rails encrypted cookie generation", () => {
  for (const e of v.encrypted_cookies.generate)
    assert.equal(
      r.encryptCookie(e.name, e.value, e.expires_at, {
        nonce: r.decode64(decodeURIComponent(e.raw).split("--")[1]),
      }),
      e.raw,
    );
});
test("Rails encrypted cookie verification", () =>
  check(v.encrypted_cookies.verify, (e) => r.decryptCookie(e.name, e.raw)));
test("Rails signed ID generation", () => {
  for (const e of v.signed_ids.generate)
    assert.equal(
      r.signedId(e.model, e.id, e.purpose, e.expires_at),
      e.signed_id,
    );
});
test("Rails signed ID verification", () =>
  check(
    v.signed_ids.verify.map((e) => ({
      ...e,
      expected:
        e.expected === null
          ? null
          : BigInt(e.expected) > BigInt(Number.MAX_SAFE_INTEGER)
            ? BigInt(e.expected)
            : Number(e.expected),
    })),
    (e) => r.verifyId(e.model, e.signed_id, e.purpose),
  ));
test("Rails SGID generation", () => {
  for (const e of v.sgids.generate)
    assert.equal(
      r.sign(
        e.data,
        "signed_global_ids",
        e.purpose,
        e.expires_at,
        "sha1",
        true,
      ),
      e.sgid,
    );
});
test("Rails SGID verification", () =>
  check(v.sgids.verify, (e) => r.verifySgid(e.sgid, e.purpose)));
test("Rails app verifier generation", () => {
  for (const e of v.app_verifiers.generate)
    assert.equal(
      r.sign(r.parseJSON(e.data_json), e.name, e.purpose, e.expires_at),
      e.message,
    );
});
test("Rails app verifier verification", () =>
  check(
    v.app_verifiers.verify.map((e) => ({
      ...e,
      expected: e.expected_json === null ? null : r.parseJSON(e.expected_json),
    })),
    (e) => r.verify(e.message, e.name, e.purpose),
  ));
test("Rails Turbo stream generation", () => {
  for (const e of v.turbo_stream_names.generate)
    assert.equal(r.signStream(e.stream_name), e.signed);
});
test("Rails Turbo stream verification", () =>
  check(v.turbo_stream_names.verify, (e) => r.verifyStream(e.signed)));
test("Rails 189 masked/unmasked/per-form CSRF validity vectors", () => {
  const raw = r.decode64(v.csrf.session_token);
  for (const e of v.csrf.validity)
    assert.equal(
      r.validCsrf(raw, e.token, e.path, e.method),
      e.expected,
      e.case,
    );
});
test("Rails installed sessions", () => {
  assert.deepEqual(
    r.decryptCookie("_campfire_session", v.session.session_cookie_raw),
    v.session.session,
  );
  assert.equal(
    r.verifyCookie("session_token", v.session.session_token_raw),
    v.session.session_token_value,
  );
});
test("Only user mentions retain identity across signing-key rotation", () => {
  for (const e of v.unverified_sgids) {
    const expected =
      e.case === "missing user"
        ? 999
        : typeof e.expected === "string" && e.expected.includes("/User/")
          ? Number(e.expected.split("/").at(-1))
          : null;
    assert.equal(r.unverifiedUserGid(e.sgid || e.raw), expected, e.case);
  }
});
test("Signing key cache respects rotated installation secrets", () => {
  const token = r.signedId("User", 42, "avatar");
  process.env.SECRET_KEY_BASE = "different-installation";
  assert.throws(() => r.verifyId("User", token, "avatar"));
});
test("Bounded data-only Marshal decoder reads independent Ruby storage transformations", () => {
  for (const e of JSON.parse(
    readFileSync(new URL("../compat/marshal.json", import.meta.url)),
  ))
    assert.deepEqual(
      JSON.parse(JSON.stringify(r.unpack(r.decode64(e.marshal)))),
      e.expected,
    );
  assert.throws(() => r.unpack(Buffer.from([4, 8, 111])));
  assert.throws(() => r.unpack(Buffer.from([4, 8, 91, 255])));
});
test("Encrypted Rails sessions preserve custom integer values beyond JavaScript safe precision", () => {
  const value = { session_id: "native-test", custom_id: 9007199254740993n };
  const token = r.encryptCookie("_campfire_session", value);
  assert.deepEqual(r.decryptCookie("_campfire_session", token), value);
  assert.equal(
    r.stringify(r.decryptCookie("_campfire_session", token)),
    r.stringify(value),
  );
});

test("cookie memo returns equal values as independent copies", () => {
  const cookie = r.encryptCookie("_campfire_session", {
    a: { b: [1, 2] },
    n: 9007199254740993n,
  });
  const first = r.decryptCookie("_campfire_session", cookie);
  first.a.b.push(3);
  first.x = 1;
  const second = r.decryptCookie("_campfire_session", cookie);
  assert.deepEqual(second, { a: { b: [1, 2] }, n: 9007199254740993n });
  assert.notEqual(first, second);
  const signed = r.signCookie("session_token", "tok");
  assert.equal(r.verifyCookie("session_token", signed), "tok");
  assert.equal(r.verifyCookie("session_token", signed), "tok");
});

test("memoised cookies still reject tampering, wrong purpose and expiry", () => {
  const cookie = r.encryptCookie("_campfire_session", { a: 1 });
  r.decryptCookie("_campfire_session", cookie);
  const tampered = cookie.replace(/^./, (c) => (c === "A" ? "B" : "A"));
  assert.throws(() => r.decryptCookie("_campfire_session", tampered));
  assert.throws(() => r.decryptCookie("_campfire_session", tampered));
  assert.throws(() => r.decryptCookie("other", cookie));
  const signed = r.signCookie("session_token", "tok");
  assert.throws(() => r.verifyCookie("session_token", signed + "0"));
  const expiring = r.signCookie(
    "session_token",
    "tok",
    new Date(new Date(v.now).getTime() + 60000),
  );
  assert.equal(r.verifyCookie("session_token", expiring), "tok");
  r.setClock(() => new Date(new Date(v.now).getTime() + 120000));
  try {
    assert.throws(() => r.verifyCookie("session_token", expiring));
  } finally {
    r.setClock(() => new Date(v.now));
  }
});

test("signing memo is stable and follows SECRET_KEY_BASE", () => {
  const id = r.signedId("User", 7, "avatar");
  assert.equal(r.signedId("User", 7, "avatar"), id);
  assert.notEqual(r.signedId("User", "7", "avatar"), id);
  const stream = r.signStream("room:1");
  assert.equal(r.signStream("room:1"), stream);
  const secret = process.env.SECRET_KEY_BASE;
  process.env.SECRET_KEY_BASE = secret + "-other";
  try {
    assert.notEqual(r.signedId("User", 7, "avatar"), id);
    assert.notEqual(r.signStream("room:1"), stream);
  } finally {
    process.env.SECRET_KEY_BASE = secret;
  }
  assert.equal(r.signedId("User", 7, "avatar"), id);
});
