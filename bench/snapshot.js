// Fetches hot routes as a logged-in user and stores bodies without CSRF tags and fields, so two
// implementations (or two commits, including ones from before Sec-Fetch-Site replaced tokens)
// can be compared byte for byte.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: {
    base: { type: "string" },
    labels: { type: "string" },
    out: { type: "string" },
    compare: { type: "string", multiple: true },
  },
  allowPositionals: true,
});

// The server's own origin appears in the HTML, so runs on different ports must still compare equal.
const normalize = (html, base = "") =>
  (base ? html.replaceAll(base, "http://snapshot.test") : html)
    .replaceAll(
      /<meta name="csrf-param" content="authenticity_token"><meta name="csrf-token" content="[^"]*">/g,
      "",
    )
    .replaceAll(
      /<input type="hidden" name="authenticity_token" value="[^"]*">/g,
      "",
    );

if (values.compare) {
  const [a, b = positionals[0]] = values.compare;
  let failed = false;
  for (const name of readdirSync(a)) {
    const left = normalize(readFileSync(join(a, name), "utf8"));
    const right = normalize(readFileSync(join(b, name), "utf8"));
    if (left !== right) {
      failed = true;
      const at = [...left].findIndex((c, i) => c !== right[i]);
      console.log(
        `DIFF ${name} at ${at}:\n- ${left.slice(at - 80, at + 80)}\n+ ${right.slice(at - 80, at + 80)}`,
      );
    }
  }
  console.log(failed ? "snapshots differ" : "snapshots identical");
  process.exit(failed ? 1 : 0);
}

const labels = JSON.parse(readFileSync(values.labels, "utf8"));
const base = values.base;
const jar = new Map();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const remember = (response) => {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
};
const fetchPage = async (path, init = {}) => {
  const response = await fetch(base + path, {
    redirect: "manual",
    ...init,
    headers: {
      Cookie: cookie(),
      "Sec-Fetch-Site": "same-origin",
      Origin: base,
      ...init.headers,
    },
  });
  remember(response);
  return response;
};

const signIn = await fetchPage("/session/new");
const token =
  (await signIn.text()).match(/name="csrf-token" content="([^"]*)"/)?.[1] ?? "";
const login = await fetchPage("/session", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    email_address: labels["emails.david"],
    password: labels["passwords.all"],
    authenticity_token: token,
  }),
});
if (login.status !== 302) throw new Error(`login failed: ${login.status}`);

const room = labels["rooms.watercooler"];
const routes = {
  room_show: `/rooms/${room}`,
  room_hq: `/rooms/${labels["rooms.hq"]}`,
  messages_page: `/rooms/${room}/messages?before=${labels["messages.busy_060"]}`,
  sidebar: "/users/me/sidebar",
  search: "/searches?q=coffee",
  permalink: `/rooms/${room}/@${labels["messages.busy_060"]}`,
};
mkdirSync(values.out, { recursive: true });
for (const [name, path] of Object.entries(routes)) {
  const response = await fetchPage(path);
  if (response.status !== 200)
    throw new Error(`${name}: HTTP ${response.status}`);
  const body = normalize(await response.text(), base);
  writeFileSync(join(values.out, `${name}.html`), body);
  console.log(
    name,
    createHash("sha256").update(body).digest("hex").slice(0, 16),
    body.length,
  );
}
