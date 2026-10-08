import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { parse } from "parse5";
import sanitizeHtml from "sanitize-html";

export function publicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0)
    );
  }
  if (!net.isIPv6(address)) return false;
  const ip = address.toLowerCase();
  // Permit global-unicast IPv6 only; mapped IPv4 and special-use ranges fail closed.
  return (
    /^[23]/.test(ip) &&
    !ip.startsWith("2001:db8:") &&
    !ip.startsWith("2001:0:") &&
    !ip.startsWith("2002:")
  );
}
export async function resolvePublic(url) {
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("invalid URL");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("private address");
  return { url: parsed, address: addresses[0] };
}
export function requestPinned(
  url,
  address,
  {
    method = "GET",
    headers = {},
    body = null,
    maxBytes = 1024 * 1024,
    timeout = 7000,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        headers,
        servername: url.hostname.replace(/^\[|\]$/g, ""),
        lookup: (_hostname, options, done) =>
          options.all
            ? done(null, [address])
            : done(null, address.address, address.family),
      },
      (response) => {
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("request timeout")),
      timeout,
    );
    timer.unref();
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}
export async function fetchMetadata(value) {
  let url = value;
  for (let redirects = 0; redirects < 4; redirects++) {
    const resolved = await resolvePublic(url);
    const response = await requestPinned(resolved.url, resolved.address, {
      headers: { "User-Agent": "Campfire", Accept: "text/html" },
      timeout: 5000,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.location, resolved.url).href;
      continue;
    }
    if (
      response.status !== 200 ||
      !response.headers["content-type"]?.includes("text/html")
    )
      throw new Error("no metadata");
    const doc = parse(response.body.toString("utf8"));
    const metadata = {};
    let title = "";
    function walk(node) {
      if (node.tagName === "meta") {
        const attrs = Object.fromEntries(
          node.attrs.map((a) => [a.name, a.value]),
        );
        if (attrs.property || attrs.name)
          metadata[attrs.property || attrs.name] = attrs.content || "";
      }
      if (node.tagName === "title")
        title = (node.childNodes || []).map((n) => n.value || "").join("");
      for (const child of node.childNodes || []) walk(child);
    }
    walk(doc);
    const plain = (s) =>
      sanitizeHtml(s || "", { allowedTags: [], allowedAttributes: {} });
    const result = {
      url: resolved.url.href,
      title: plain(metadata["og:title"] || title),
      description: plain(metadata["og:description"] || metadata.description),
      image: metadata["og:image"]
        ? new URL(metadata["og:image"], resolved.url).href
        : "",
    };
    if (result.image) {
      const image = new URL(result.image);
      if (
        !["http:", "https:"].includes(image.protocol) ||
        image.username ||
        image.password
      )
        result.image = "";
    }
    return result;
  }
  throw new Error("too many redirects");
}
export function registerOpengraph(app) {
  app.post("/unfurl_link", async (req, res) => {
    if (!req.user) return res.sendStatus(401);
    try {
      const data = await fetchMetadata(req.body.url);
      return data.title && data.description
        ? res.json(data)
        : res.status(204).end();
    } catch {
      return res.status(204).end();
    }
  });
}
