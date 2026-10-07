import Fastify from "fastify";
import fastifyAccepts from "@fastify/accepts";
import { finishBody } from "../src/gzip.js";
import { decorate } from "../src/app.js";

// A bare Fastify app with app.js's request/reply decorations and its onSend body step (ETag,
// 304, spliced gzip).
export async function listenApp(setup, { finish = true } = {}) {
  const app = Fastify({ routerOptions: { maxParamLength: 8192 } });
  decorate(app);
  app.register(fastifyAccepts);
  if (finish)
    app.addHook("onSend", (req, reply, payload, done) =>
      done(null, finishBody(req, reply, payload)),
    );
  setup(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return app.server;
}
