import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
process.env.DATABASE_PATH = ":memory:";
process.env.SECRET_KEY_BASE = "native-session-integer-tests";
const { createApp } = await import("../src/app.js");
const rails = await import("../src/rails.js");
test("HTTP middleware preserves a large integer in a real encrypted Rails session", async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const cookie = rails.encryptCookie("_campfire_session", {
      custom_id: 9007199254740993n,
    });
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/first_run`,
      {
        headers: { cookie: "_campfire_session=" + encodeURIComponent(cookie) },
      },
    );
    assert.equal(response.status, 200);
    const raw = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("_campfire_session="))
      .split(";")[0]
      .slice("_campfire_session=".length);
    assert.equal(
      rails.decryptCookie("_campfire_session", raw).custom_id,
      9007199254740993n,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
