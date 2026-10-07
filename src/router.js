// Collects routes in the (path, ...handlers) form the route modules use and registers them with
// Fastify. Fastify's router matches the URL; this keeps what it cannot know at routing time:
// the method from a form's _method field (read after body parsing) and next() falling through
// to the following route of the same shape in registration order (/rooms/:kind and
// /rooms/:roomId). Routes with the same shape but different parameter names share one
// Fastify route whose parameters are renamed per candidate.

const ALL = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const OVERRIDDEN = ["PUT", "PATCH", "DELETE"];

// "/rooms/:roomId/@:messageId" -> shape "/rooms/:p0/@:p1" and names [roomId, messageId];
// an optional "{*rest}" tail becomes two shapes, without it and with a "*" wildcard.
function shapes(pattern) {
  const names = [];
  const optional = /\{\/?\*(\w+)\}$/.exec(pattern);
  const base = optional ? pattern.slice(0, optional.index) : pattern;
  const shape = base.replace(/:(\w+)/g, (m, name) => {
    names.push(name);
    return ":p" + (names.length - 1);
  });
  if (!optional) return [{ shape, names }];
  return [
    { shape: shape.replace(/\/$/, "") || "/", names },
    {
      shape: shape.replace(/\/?$/, "/*"),
      names,
      wildcard: optional[1],
    },
  ];
}

async function runChain(chain, req, reply) {
  for (const fn of chain) {
    let advanced = false;
    let failure;
    const result = fn(req, reply, (error) => {
      advanced = true;
      failure = error;
    });
    // A Fastify reply is thenable and settles only when the response ends; awaiting it is unnecessary.
    if (result && result !== reply && typeof result.then === "function")
      await result;
    if (failure) throw failure;
    if (!advanced) return false;
  }
  return true;
}

export function routeTable(scope) {
  const groups = new Map();
  const add = (methods, paths, chain) => {
    for (const pattern of [].concat(paths))
      for (const { shape, names, wildcard } of shapes(pattern)) {
        let group = groups.get(shape);
        if (!group) groups.set(shape, (group = { shape, candidates: [] }));
        group.candidates.push({ methods, names, wildcard, chain });
      }
  };
  const routes = {
    register() {
      for (const group of groups.values()) register(scope, group);
    },
  };
  for (const method of ["get", "post", "put", "patch", "delete"])
    routes[method] = (paths, ...chain) =>
      add(
        method === "get" ? ["GET", "HEAD"] : [method.toUpperCase()],
        paths,
        chain,
      );
  routes.all = (paths, ...chain) => add(ALL, paths, chain);
  return routes;
}

function register(scope, { shape, candidates }) {
  const methods = new Set(candidates.flatMap((c) => c.methods));
  if (OVERRIDDEN.some((m) => methods.has(m))) methods.add("POST");
  scope.route({
    method: [...methods],
    url: shape,
    async handler(req, reply) {
      const matched = req.params;
      for (const candidate of candidates) {
        if (!candidate.methods.includes(req.method)) continue;
        const params = {};
        candidate.names.forEach((name, i) => (params[name] = matched["p" + i]));
        if (candidate.wildcard) params[candidate.wildcard] = matched["*"];
        req.params = params;
        if (!(await runChain(candidate.chain, req, reply))) return reply;
      }
      req.params = matched;
      return reply.callNotFound();
    },
  });
}
