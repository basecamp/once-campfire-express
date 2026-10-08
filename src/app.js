import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import fastifyCompress from "@fastify/compress";
import fastifyCookie from "@fastify/cookie";
import fastifyAccepts from "@fastify/accepts";
import qs from "qs";
import http from "node:http";
import path from "node:path";
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
import { finishBody } from "./gzip.js";
import { registerRoutes } from "./routes.js";
import { registerStorage } from "./storage.js";
import { registerPublic, healthCheck } from "./public.js";
import { cachedAssets, SECURITY_HEADERS } from "./static_responses.js";
import { registerOpengraph } from "./opengraph.js";
import { allowLogin } from "./rate_limit.js";
import { routeTable } from "./router.js";
import { beginPage, responseCache } from "./response_cache.js";

const BODY_LIMIT = 5 * 1024 * 1024;
const DISK_BODY_LIMIT = 100 * 1024 * 1024;

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
function loadSession(req) {
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
  req.sessionBefore = rails.stringify(req.session);
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
}
// Runs for every response that went through loadSession (errors and 404s included), as Rails
// writes the session cookie whatever the outcome.
function writeSessionCookies(req, reply) {
  if (req.sessionBefore === null) return;
  const maxAge = 20 * 365 * 86400;
  const options = {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge,
    expires: new Date(Date.now() + maxAge * 1000),
    path: "/",
  };
  if (rails.stringify(req.session) !== req.sessionBefore)
    reply.setCookie(
      "_campfire_session",
      rails.encryptCookie("_campfire_session", req.session, options.expires),
      options,
    );
  if (req.clearSessionToken)
    reply.clearCookie("session_token", {
      ...options,
      maxAge: undefined,
      expires: undefined,
    });
  else if (req.newSessionToken)
    reply.setCookie(
      "session_token",
      rails.signCookie("session_token", req.newSessionToken, options.expires),
      options,
    );
  if (req.lastRoom != null)
    reply.setCookie("last_room", String(req.lastRoom), {
      ...options,
      httpOnly: false,
    });
}
// Browser writes use fetch metadata; old token fields are accepted as inert input.
export function requestOriginAllowed(req) {
  if (["GET", "HEAD"].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== req.protocol + "://" + req.host)
    return false;
  const site = req.headers["sec-fetch-site"];
  if (site === "same-origin" || site === "same-site") return true;
  return site === undefined && !req.secure && !req.forceSsl;
}
const BOT_MESSAGES = /^\/rooms\/\d+\/[^/]+\/messages(?:\/|$)/;
function forbidden(req, reply) {
  if (getCached("SELECT id FROM bans WHERE ip_address=?", req.ip))
    return reply.sendStatus(403);
  if (req.authenticatedByBot && !BOT_MESSAGES.test(req.path))
    return reply.sendStatus(403);
  if (["GET", "HEAD"].includes(req.method)) return;
  if (req.authenticatedByBot && BOT_MESSAGES.test(req.path)) return;
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
      if (p && typeof p === "object" && p.key) return;
    } catch {}
  }
  if (!requestOriginAllowed(req)) return reply.sendStatus(422);
}
const mediaType = (req) =>
  (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
function tooLarge() {
  return Object.assign(new Error("request entity too large"), {
    statusCode: 413,
  });
}
// Mirrors the former raw/json/urlencoded/text parser stack: active storage disk uploads keep raw
// bytes, other unknown types leave the body unset.
function parseBody(req, buffer, done) {
  if (req.url.startsWith("/rails/active_storage/disk"))
    return done(null, buffer);
  if (buffer.length > BODY_LIMIT) return done(tooLarge());
  const type = mediaType(req);
  try {
    if (type === "application/json")
      return done(null, buffer.length ? JSON.parse(buffer.toString()) : {});
    if (type === "application/x-www-form-urlencoded")
      return done(
        null,
        qs.parse(buffer.toString(), { allowPrototypes: true, depth: Infinity }),
      );
    if (type === "text/plain") return done(null, buffer.toString());
  } catch (error) {
    error.statusCode = 400;
    return done(error);
  }
  done(null, undefined);
}
async function readMultipart(req) {
  if (!req.isMultipart()) return;
  const fields = Object.create(null);
  const files = [];
  for await (const part of req.parts()) {
    if (part.type === "file") {
      const buffer = await part.toBuffer();
      files.push({
        fieldname: part.fieldname,
        originalname: part.filename,
        encoding: part.encoding,
        mimetype: part.mimetype,
        buffer,
        size: buffer.length,
      });
    } else if (part.fieldname in fields)
      fields[part.fieldname] = [].concat(fields[part.fieldname], part.value);
    else fields[part.fieldname] = part.value;
  }
  req.body = qs.parse(fields, { allowPrototypes: false, depth: Infinity });
  req.uploads = files;
}
function overrideMethod(req) {
  const override = String(req.body?._method || "").toUpperCase();
  if (req.method === "POST" && ["PATCH", "PUT", "DELETE"].includes(override))
    req.raw.method = override;
}
const assetsRoot = () => path.resolve("assets/generated/public/assets");
const FORMAT = /\.(json|turbo_stream)(?=\?|$)/;
// Strips the Rails format suffix before routing, as the routes have none.
function rewriteUrl(raw) {
  const url = raw.url;
  if (
    url.startsWith("/rails/active_storage/") ||
    url.startsWith("/webmanifest") ||
    url.startsWith("/assets/")
  )
    return url;
  return url.replace(FORMAT, (m, format) => {
    raw.campfireFormat = format;
    return "";
  });
}
export function decorate(app) {
  app.decorateRequest("path", {
    getter() {
      const url = this.url;
      const query = url.indexOf("?");
      return query < 0 ? url : url.slice(0, query);
    },
  });
  app.decorateRequest("secure", {
    getter() {
      return this.protocol === "https";
    },
  });
  app.decorateRequest("format", {
    getter() {
      return this.raw.campfireFormat ?? null;
    },
  });
  for (const name of [
    "session",
    "sessionBefore",
    "currentSession",
    "user",
    "account",
    "uploads",
    "pageDeps",
    "pageEpoch",
    "lastRoom",
    "newSessionToken",
    "clearSessionToken",
  ])
    app.decorateRequest(name, null);
  app.decorateRequest("authenticatedByBot", false);
  app.decorateReply("sendStatus", function (code) {
    return this.code(code)
      .type("text/plain; charset=utf-8")
      .send(http.STATUS_CODES[code] ?? String(code));
  });
}
function errorHandler(error, req, reply) {
  const status = Number(error.status || error.statusCode) || 500;
  if (status >= 500) console.error(error.stack || error);
  reply
    .code(status)
    .type("text/html; charset=utf-8")
    .send(status >= 500 ? "Internal Server Error" : error.message);
}
// Returns a Fastify instance whose HTTP server (app.server) answers cached digested assets
// before Fastify builds its request/reply objects, which adds ~20% asset throughput.
export function createApp({ publicCache } = {}) {
  initialize();
  const assets = cachedAssets(assetsRoot(), publicCache);
  const app = Fastify({
    logger: false,
    trustProxy: process.env.TRUSTED_PROXIES
      ? process.env.TRUSTED_PROXIES.split(",").map((p) => p.trim())
      : false,
    bodyLimit: DISK_BODY_LIMIT,
    rewriteUrl,
    routerOptions: {
      ignoreTrailingSlash: true,
      caseSensitive: false,
      maxParamLength: 8192,
      querystringParser: (query) => qs.parse(query, { allowPrototypes: true }),
    },
    serverFactory: (handler) =>
      http.createServer((req, res) => {
        if (!assets.direct(req, res)) handler(req, res);
      }),
  });
  decorate(app);
  app.decorateRequest(
    "forceSsl",
    /^(?:true|1)$/i.test(process.env.FORCE_SSL || ""),
  );
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: DISK_BODY_LIMIT },
    parseBody,
  );
  app.register(fastifyAccepts);
  // Added before @fastify/cookie registers its onSend hook, which serializes what this one sets.
  app.addHook("onSend", (req, reply, payload, done) => {
    writeSessionCookies(req, reply);
    done(null, payload);
  });
  app.register(fastifyCookie, { hook: false });
  app.register(fastifyMultipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 20, fields: 1000 },
  });
  app.addHook("onRequest", (req, reply, done) => {
    if (assets.hook(req, reply)) {
      reply.hijack();
      return done();
    }
    reply.headers(SECURITY_HEADERS);
    done();
  });
  // Before compression: it settles ETag, 304 and spliced gzip for bodies the handlers send, and
  // @fastify/compress passes anything already encoded through untouched.
  app.addHook("onSend", (req, reply, payload, done) =>
    done(null, finishBody(req, reply, payload)),
  );
  app.register(fastifyCompress, { threshold: 1024, global: true });
  app.setErrorHandler(errorHandler);
  // Like Rails' health controller: no session cookie, ban check or last_active_at update.
  app.get("/up", healthCheck);
  app.register(fastifyStatic, {
    root: assetsRoot(),
    prefix: "/assets/",
    preCompressed: true,
    immutable: true,
    maxAge: "1y",
    dotfiles: "deny",
    decorateReply: false,
  });
  app.register(async (scope) => {
    scope.addHook("preValidation", async (req) => {
      await readMultipart(req);
      overrideMethod(req);
    });
    scope.addHook("preHandler", (req, reply, done) => {
      loadSession(req);
      if (forbidden(req, reply)) return;
      done();
    });
    scope.setErrorHandler(errorHandler);
    scope.setNotFoundHandler((req, reply) => reply.sendStatus(404));
    const routes = routeTable(scope);
    routes.post("/session", (req, res, next) =>
      allowLogin(req.ip)
        ? next()
        : res.status(429).send("Too many requests or unauthorized."),
    );
    registerStorage(routes);
    registerPublic(routes);
    registerOpengraph(routes);
    registerRoutes(routes);
    routes.register();
    await scope.register(fastifyStatic, {
      root: path.resolve("assets/generated/public"),
      dotfiles: "deny",
      decorateReply: false,
    });
  });
  return app;
}
// The http.Server for createApp(), ready to listen (Action Cable attaches its upgrade handler to it).
export async function createServer(options) {
  const app = createApp(options);
  await app.ready();
  return app.server;
}
