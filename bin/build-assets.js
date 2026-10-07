import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
const root = path.resolve(import.meta.dirname, ".."),
  reference = path.join(root, "reference"),
  sources = path.join(root, "assets/sources"),
  out = path.join(root, "assets/generated");
const escape = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) =>
      e.isDirectory()
        ? files(path.join(dir, e.name))
        : e.isFile() && !e.name.startsWith(".")
          ? [path.join(dir, e.name)]
          : [],
    );
}
const dirs = [
  path.join(root, "assets/overrides"),
  path.join(sources, "overrides"),
];
for (const line of fs
  .readFileSync(path.join(sources, "vendor/LOAD_PATH"), "utf8")
  .split("\n")
  .filter(Boolean)) {
  const i = line.indexOf(":");
  dirs.push(
    path.join(
      line.slice(0, i) === "reference"
        ? reference
        : path.join(sources, "vendor"),
      line.slice(i + 1),
    ),
  );
}
const assets = new Map();
for (const dir of dirs)
  for (const f of files(dir)) {
    const name = path.relative(dir, f);
    if (!assets.has(name)) assets.set(name, fs.readFileSync(f));
  }
const initializer = fs.readFileSync(
  path.join(reference, "config/initializers/assets.rb"),
  "utf8",
);
const version =
  initializer.match(
    /^\s*Rails\.application\.config\.assets\.version\s*=\s*["']([^"']*)/m,
  )?.[1] || "1";
const patterns = {
  css: /url\(\s*["']?(?!(?:#|%23|data:|http:|https:|\/\/))([^"'\s?#)]+)([#?][^"')]+)?\s*["']?\)/g,
  js: /RAILS_ASSET_URL\(\s*["']?(?!(?:#|%23|data|http|\/\/))([^"'\s?#)]+)([#?][^"')]+)?\s*["']?\)/g,
};
const kind = (n) => path.extname(n).slice(1),
  resolve = (n, url) =>
    url.startsWith("/")
      ? url.slice(1)
      : path.posix.normalize(path.posix.join(path.posix.dirname(n), url));
function references(name) {
  const result = [],
    pattern = patterns[kind(name)];
  if (!pattern) return result;
  function visit(current) {
    for (const m of assets
      .get(current)
      .toString("utf8")
      .matchAll(new RegExp(pattern))) {
      const found = resolve(current, m[1]);
      if (assets.has(found) && !result.includes(found)) {
        result.push(found);
        visit(found);
      }
    }
  }
  visit(name);
  return result;
}
const manifest = {};
for (const [name, data] of assets) {
  const hash = createHash("sha1").update(data);
  for (const ref of references(name)) hash.update(assets.get(ref));
  const digest = hash.update(version).digest("hex").slice(0, 8);
  const digested = /-[0-9a-zA-Z_-]{7,128}\.digested/.test(name)
    ? name
    : name.replace(/\.(\w+(?:\.map)?)$/, `-${digest}.$1`);
  manifest[name] = { digested_path: digested, integrity: null };
}
const precompressible = /\.(css|js|svg|json|txt|html|map|webmanifest)$/;
const url = (name) => "/assets/" + manifest[name].digested_path;
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "public/assets"), { recursive: true });
for (const file of files(path.join(reference, "public"))) {
  const rel = path.relative(path.join(reference, "public"), file);
  if (rel.split(path.sep).includes("assets")) continue;
  const dest = path.join(out, "public", rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
}
for (const [name, data] of assets) {
  let compiled = data;
  const pattern = patterns[kind(name)];
  if (pattern) {
    const text = data
      .toString("utf8")
      .replace(pattern, (whole, original, suffix = "") => {
        const found = resolve(name, original),
          value =
            '"' + (assets.has(found) ? url(found) + suffix : original) + '"';
        return kind(name) === "css" ? "url(" + value + ")" : value;
      })
      .replace(
        /(\/\/|\/\*)# sourceMappingURL=(.+\.map)(\s*?\*\/)?\s*?(?=\n?$)/g,
        (whole, prefix, original, end = "") => {
          const found = resolve(
            name,
            original.replace(/^(.+\/)?\/assets\//, ""),
          );
          return (
            prefix +
            (assets.has(found) ? "# sourceMappingURL=" + url(found) : "") +
            end
          );
        },
      );
    compiled = Buffer.from(text);
  }
  const dest = path.join(out, "public/assets", manifest[name].digested_path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, compiled);
  if (precompressible.test(dest) && compiled.length >= 1024) {
    fs.writeFileSync(dest + ".gz", zlib.gzipSync(compiled, { level: 9 }));
    fs.writeFileSync(
      dest + ".br",
      zlib.brotliCompressSync(compiled, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
      }),
    );
  }
}
const serialized = JSON.stringify(manifest);
fs.writeFileSync(path.join(out, "manifest.json"), serialized);
fs.writeFileSync(path.join(out, "public/assets/.manifest.json"), serialized);
const packages = new Map(),
  directories = [];
for (const raw of fs
  .readFileSync(path.join(reference, "config/importmap.rb"), "utf8")
  .split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const m = line.match(/^(pin|pin_all_from)\s+["']([^"']+)["'](.*)$/);
  if (!m) throw new Error("unsupported importmap: " + line);
  const opts = Object.fromEntries(
    [...m[3].matchAll(/(to|under):\s*["']([^"']*)["']/g)].map((x) => [
      x[1],
      x[2],
    ]),
  );
  const preload = !m[3].includes("preload: false");
  if (m[1] === "pin") packages.set(m[2], [opts.to || m[2] + ".js", preload]);
  else directories.push([m[2], opts, preload]);
}
for (const [name, opts, preload] of directories) {
  const dir = path.join(reference, name);
  for (const file of files(dir)) {
    if (![".js", ".jsm"].includes(path.extname(file))) continue;
    const filename = path.relative(dir, file),
      stem = filename.replace(/\.jsm?$/, "").replace(/(^|\/)index$/, "");
    const packageName = [opts.under, stem].filter(Boolean).join("/"),
      logical = [opts.to || opts.under, filename].filter(Boolean).join("/");
    packages.set(packageName, [logical, preload]);
  }
}
const imports = {},
  preloads = [];
for (const [name, [logical, preload]] of packages) {
  if (!manifest[logical]) continue;
  imports[name] = url(logical);
  if (preload && !preloads.includes(url(logical))) preloads.push(url(logical));
}
fs.writeFileSync(
  path.join(out, "importmap.html"),
  '<script type="importmap" data-turbo-track="reload">' +
    JSON.stringify({ imports }, null, 2) +
    "</script>\n" +
    preloads
      .map((p) => '<link rel="modulepreload" href="' + escape(p) + '">')
      .join("\n") +
    '\n<script type="module">import "application"</script>',
);
fs.writeFileSync(
  path.join(out, "stylesheets.html"),
  [...assets.keys()]
    .filter((p) => p.endsWith(".css"))
    .sort()
    .map(
      (p) =>
        '<link rel="stylesheet" href="' +
        url(p) +
        '" data-turbo-track="reload" />',
    )
    .join("\n"),
);
console.log(
  `Compiled ${assets.size} assets and ${Object.keys(imports).length} imports`,
);
