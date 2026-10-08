import express from "express";
import compression from "compression";
import { splicedGzip } from "./gzip.js";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as rails from "./rails.js";
import {
  get,
  getCached,
  run,
  now,
  initialize,
  validateQueryCacheForTurn,
} from "./db.js";
import { registerRoutes } from "./routes.js";
import { registerStorage } from "./storage.js";
import { registerPublic, healthCheck } from "./public.js";
import { cachedAssets, SECURITY_HEADERS } from "./static_responses.js";
import { registerOpengraph } from "./opengraph.js";
import { allowLogin } from "./rate_limit.js";
import { beginPage, responseCache } from "./response_cache.js";

export function parseCookies(header = "") {
  const result = Object.create(null);
  for (const item of header.split(";")) {
    const i = item.indexOf("=");
    if (i < 0) continue;
    const k = item.slice(0, i).trim();
    try {
      result[k] = decodeURIComponent(item.slice(i + 1).trim());
    } catch {}
  }
  return result;
}
export function authenticateCookies(header, cookies = parseCookies(header)) {
  try {
    const token = rails.verifyCookie("session_token", cookies.session_token);
    return getCached(
      "SELECT s.*,u.name,u.role,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.status=0",
      token,
    );
  } catch {
    return null;
  }
}
function sessionMiddleware(req, res, next) {
  if (responseCache.budget && ["GET", "HEAD"].includes(req.method))
    beginPage(req);
  validateQueryCacheForTurn();
  req.cookies = parseCookies(req.headers.cookie);
  req.session = {};
  try {
    const session = rails.decryptCookie(
      "_campfire_session",
      req.cookies._campfire_session,
    );
    if (session && typeof session === "object" && !Array.isArray(session))
      req.session = session;
  } catch {}
  const before = rails.stringify(req.session);
  req.session.session_id ||= randomBytes(16).toString("hex");
  req.currentSession = authenticateCookies(req.headers.cookie, req.cookies);
  req.user = req.currentSession
    ? getCached("SELECT * FROM users WHERE id=?", req.currentSession.user_id)
    : null;
  req.account = getCached("SELECT * FROM accounts ORDER BY id LIMIT 1");
  req.authenticatedByBot = false;
  const botMatch = req.path.match(/^\/rooms\/\d+\/([^/]+)\/messages(?:\/|$)/);
  const botKey = req.query.bot_key || botMatch?.[1];
  if (!req.user && botKey) {
    const m = String(botKey)
      .trim()
      .match(/^(\d+)-(.+)$/);
    if (m) {
      req.user = get(
        "SELECT * FROM users WHERE id=? AND bot_token=? AND status=0 AND role=2",
        Number(m[1]),
        m[2],
      );
      req.authenticatedByBot = Boolean(req.user);
    }
  }
  if (
    req.currentSession &&
    new Date(
      req.currentSession.last_active_at.replace(" ", "T") + "Z",
    ).getTime() <
      Date.now() - 3600000
  )
    run(
      "UPDATE sessions SET last_active_at=?,updated_at=?,user_agent=?,ip_address=? WHERE id=?",
      now(),
      now(),
      req.headers["user-agent"] || "",
      req.ip,
      req.currentSession.id,
    );
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const options = {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: 20 * 365 * 86400 * 1000,
      path: "/",
    };
    const expiry = new Date(Date.now() + options.maxAge);
    if (rails.stringify(req.session) !== before)
      res.cookie(
        "_campfire_session",
        rails.encryptCookie("_campfire_session", req.session, expiry),
        options,
      );
    if (req.clearSessionToken)
      res.clearCookie("session_token", { ...options, maxAge: undefined });
    else if (req.newSessionToken)
      res.cookie(
        "session_token",
        rails.signCookie("session_token", req.newSessionToken, expiry),
        options,
      );
    if (req.lastRoom !== undefined)
      res.cookie("last_room", String(req.lastRoom), {
        ...options,
        httpOnly: false,
      });
    return writeHead.apply(this, args);
  };
  next();
}
function multipartFields(req, res, next) {
  if (req.is("multipart/form-data")) {
    for (const [name, value] of Object.entries(req.body || {})) {
      const parts = name.match(/[^\[\]]+/g) || [];
      if (
        parts.length < 2 ||
        parts.some((p) => ["__proto__", "constructor", "prototype"].includes(p))
      )
        continue;
      let target = req.body;
      for (const p of parts.slice(0, -1))
        target = target[p] ||= Object.create(null);
      target[parts.at(-1)] = value;
    }
  }
  next();
}
const assetsRoot = () => path.resolve("assets/generated/public/assets");
function precompressedAssets() {
  const root = assetsRoot();
  const files = new Set(
    fs.existsSync(root)
      ? fs
          .readdirSync(root, { recursive: true })
          .map((f) => f.split(path.sep).join("/"))
      : [],
  );
  const extensions = { br: ".br", gzip: ".gz" };
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let name;
    try {
      name = decodeURIComponent(req.path).slice(1);
    } catch {
      return next();
    }
    if (!files.has(name)) return next();
    const encoding = req.acceptsEncodings(["br", "gzip"]);
    const variant = encoding && name + extensions[encoding];
    if (!variant || !files.has(variant)) return next();
    res.type(path.extname(name));
    res.set({
      "Content-Encoding": encoding,
      Vary: "Accept-Encoding",
    });
    res.sendFile(
      variant,
      { root: assetsRoot(), immutable: true, maxAge: "1y", dotfiles: "deny" },
      (error) => error && next(error),
    );
  };
}
// Browser writes use fetch metadata; old token fields are accepted as inert input.
export function requestOriginAllowed(req) {
  if (["GET", "HEAD"].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (
    origin !== undefined &&
    origin !== req.protocol + "://" + (req.host ?? req.get("host"))
  )
    return false;
  const site = req.headers["sec-fetch-site"];
  if (site === "same-origin" || site === "same-site") return true;
  return site === undefined && !req.secure && !req.app.get("force ssl");
}
export function createApp({ publicCache } = {}) {
  initialize();
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "extended");
  app.set("force ssl", /^(?:true|1)$/i.test(process.env.FORCE_SSL || ""));
  if (process.env.TRUSTED_PROXIES)
    app.set("trust proxy", process.env.TRUSTED_PROXIES.split(","));
  const assets = cachedAssets(assetsRoot(), publicCache);
  // Answering before Express decorates req/res and walks its router adds ~20% asset throughput.
  const handle = app.handle;
  app.handle = function (req, res, callback) {
    if (!assets.direct(req, res)) handle.call(this, req, res, callback);
  };
  app.use(assets);
  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });
  app.use(splicedGzip());
  app.use(compression({ threshold: 1024, level: 6 }));
  // Like Rails' health controller: no session cookie, ban check or last_active_at update. Matches
  // exactly what "/up" matched after the format-stripping rewrite below.
  app.get(/^\/[uU][pP]\/?(?:\.json|\.turbo_stream)?$/, healthCheck);
  app.use("/assets", precompressedAssets());
  app.use(
    "/assets",
    express.static(assetsRoot(), {
      immutable: true,
      maxAge: "1y",
      dotfiles: "deny",
    }),
  );
  app.use((req, res, next) => {
    if (
      !req.path.startsWith("/rails/active_storage/") &&
      !req.path.startsWith("/webmanifest")
    )
      req.url = req.url.replace(
        /\.(json|turbo_stream)(?=\?|$)/,
        (m, format) => {
          req.format = format;
          return "";
        },
      );
    next();
  });
  app.use(
    "/rails/active_storage/disk",
    express.raw({ type: () => true, limit: "100mb" }),
  );
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true, limit: "5mb" }));
  app.use((req, res, next) => {
    if (req.is("multipart/form-data"))
      multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 100 * 1024 * 1024, files: 20, fields: 1000 },
      }).any()(req, res, next);
    else next();
  });
  app.use(express.text({ type: "text/plain", limit: "5mb" }));
  app.use(multipartFields);
  app.use((req, res, next) => {
    if (
      req.method === "POST" &&
      ["PATCH", "PUT", "DELETE"].includes(
        String(req.body?._method || "").toUpperCase(),
      )
    )
      req.method = req.body._method.toUpperCase();
    next();
  });
  app.use(sessionMiddleware);
  app.use((req, res, next) => {
    if (getCached("SELECT id FROM bans WHERE ip_address=?", req.ip))
      return res.sendStatus(403);
    if (
      req.authenticatedByBot &&
      !/^\/rooms\/\d+\/[^/]+\/messages(?:\/|$)/.test(req.path)
    )
      return res.sendStatus(403);
    if (["GET", "HEAD"].includes(req.method)) return next();
    if (
      req.authenticatedByBot &&
      /^\/rooms\/\d+\/[^/]+\/messages(?:\/|$)/.test(req.path)
    )
      return next();
    if (
      req.method === "PUT" &&
      req.path.startsWith("/rails/active_storage/disk/")
    ) {
      try {
        const p = rails.verify(
          req.path.split("/").at(-1),
          "ActiveStorage",
          "blob_token",
        );
        if (p && typeof p === "object" && p.key) return next();
      } catch {}
    }
    if (requestOriginAllowed(req)) return next();
    res.sendStatus(422);
  });
  app.post("/session", (req, res, next) =>
    allowLogin(req.ip)
      ? next()
      : res.status(429).send("Too many requests or unauthorized."),
  );
  registerStorage(app);
  registerPublic(app);
  registerOpengraph(app);
  registerRoutes(app);
  app.use(
    express.static(path.resolve("assets/generated/public"), {
      dotfiles: "deny",
    }),
  );
  app.use((req, res) => res.sendStatus(404));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number(error.status) || 500;
    if (status >= 500) console.error(error.stack || error);
    res
      .status(status)
      .send(status >= 500 ? "Internal Server Error" : error.message);
  });
  return app;
}
