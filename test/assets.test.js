import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
process.env.DATABASE_PATH = ":memory:";
process.env.SECRET_KEY_BASE = "assets-tests";
const dir = "assets/generated/public/assets";
if (!fs.existsSync("assets/generated/manifest.json"))
  execFileSync(process.execPath, ["bin/build-assets.js"], { stdio: "ignore" });
const { createApp } = await import("../src/app.js");
const css = fs
  .readdirSync(dir)
  .find((f) => f.endsWith(".css") && fs.existsSync(`${dir}/${f}.br`));
const original = fs.readFileSync(`${dir}/${css}`);
let server, base;
before(async () => {
  server = createServer(createApp());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  return () => new Promise((r) => server.close(r));
});
const get = (url, encoding) =>
  fetch(base + url, {
    headers: encoding ? { "accept-encoding": encoding } : {},
    decompress: false,
  });

test("build writes gzip and brotli variants for compressible assets", () => {
  assert.ok(css, "a precompressed css asset exists");
  assert.deepEqual(
    zlib.gunzipSync(fs.readFileSync(`${dir}/${css}.gz`)),
    original,
  );
  assert.deepEqual(
    zlib.brotliDecompressSync(fs.readFileSync(`${dir}/${css}.br`)),
    original,
  );
  assert.ok(
    !fs.readdirSync(dir).some((f) => /\.(png|woff2)\.(gz|br)$/.test(f)),
  );
});

for (const [encoding, decode] of [
  ["br", zlib.brotliDecompressSync],
  ["gzip", zlib.gunzipSync],
]) {
  test(`serves precompressed ${encoding}`, async () => {
    const res = await get(`/assets/${css}`, encoding);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-encoding"), encoding);
    assert.match(res.headers.get("content-type"), /^text\/css/);
    assert.equal(
      res.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.match(res.headers.get("vary"), /Accept-Encoding/);
    assert.ok(res.headers.get("etag"));
    assert.deepEqual(decode(Buffer.from(await res.arrayBuffer())), original);
  });
}

test("serves identity bytes without Accept-Encoding", async () => {
  const res = await get(`/assets/${css}`, "identity");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), null);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), original);
});

test("path traversal is not served", async () => {
  for (const url of ["/assets/..%2f..%2fpackage.json", `/assets/..%2f${css}`]) {
    const res = await get(url, "br");
    assert.notEqual(res.headers.get("content-encoding"), "br");
    assert.ok(!(await res.text()).includes('"name"'));
  }
});
