import test from "node:test";
import assert from "node:assert/strict";
const { requestOriginAllowed } = await import("../src/app.js");

test("fetch metadata method, origin, site and TLS matrix ignores token input", () => {
  for (const method of [
    "GET",
    "HEAD",
    "POST",
    "PATCH",
    "PUT",
    "DELETE",
    "OPTIONS",
    "TRACE",
  ]) {
    for (const [headers, allowed] of [
      [{}, true],
      [{ "sec-fetch-site": "same-origin" }, true],
      [{ "sec-fetch-site": "same-site" }, true],
      [
        { "sec-fetch-site": "same-origin", origin: "http://campfire.test" },
        true,
      ],
      [{ "sec-fetch-site": "cross-site" }, false],
      [{ "sec-fetch-site": "none" }, false],
      [{ "sec-fetch-site": "" }, false],
      [{ "sec-fetch-site": "SAME-ORIGIN" }, false],
      [{ "sec-fetch-site": "unknown" }, false],
      [{ "sec-fetch-site": "same-origin", origin: "null" }, false],
      [
        { "sec-fetch-site": "same-site", origin: "http://attacker.test" },
        false,
      ],
      [{ "sec-fetch-site": "same-origin", origin: "" }, false],
    ]) {
      const req = {
        method,
        headers,
        protocol: "http",
        host: "campfire.test",
        secure: false,
        forceSsl: false,
        body: { authenticity_token: "old-token" },
      };
      assert.equal(
        requestOriginAllowed(req),
        ["GET", "HEAD"].includes(method) || allowed,
        method + JSON.stringify(headers),
      );
    }
  }
  const req = {
    method: "POST",
    headers: {},
    protocol: "https",
    host: "campfire.test:8443",
    secure: true,
    forceSsl: false,
  };
  assert.equal(requestOriginAllowed(req), false);
  req.headers = {
    "sec-fetch-site": "same-origin",
    origin: "https://campfire.test:8443",
  };
  assert.equal(requestOriginAllowed(req), true);
  req.headers.origin = "https://campfire.test";
  assert.equal(requestOriginAllowed(req), false);
  req.protocol = "http";
  req.secure = false;
  req.headers = {};
  req.forceSsl = true;
  assert.equal(requestOriginAllowed(req), false);
  req.headers["sec-fetch-site"] = "same-site";
  assert.equal(requestOriginAllowed(req), true);
});
