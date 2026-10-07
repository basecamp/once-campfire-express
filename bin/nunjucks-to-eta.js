// One-off migration tool: converts every macro of the former nunjucks templates/pages.html into
// templates/eta/<macro>.eta, keeping the rendered bytes identical. Kept so the conversion can be
// reviewed and repeated. nunjucks is no longer a dependency, so to rerun it:
//   git show <rev>:templates/pages.html > tmp/pages.html
//   npm install --no-save nunjucks@3.2.4
//   node bin/nunjucks-to-eta.js tmp/pages.html templates/eta
// It walks the nunjucks AST (nunjucks.parser) and supports only the subset pages.html used;
// anything else throws instead of being converted approximately.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [source = "templates/pages.html", outDir = "templates/eta"] =
  process.argv.slice(2);
const { default: nunjucks } = await import("nunjucks");

// Must match the helpers object in src/rendering.js.
const GLOBALS = new Set([
  "asset",
  "avatar",
  "epoch",
  "iso",
  "versionTime",
  "len",
  "get",
  "firstName",
  "lower",
  "stylesheets",
  "importmap",
  "printf",
  "allEmoji",
  "qrpath",
  "humanInvolvement",
  "nextInvolvement",
  "reactions",
  "agent",
  "helpMailto",
  "botCommand",
  "translate",
]);
// Names the generated code or Eta's compiled function already declare.
const RESERVED = new Set([
  ...GLOBALS,
  "each",
  "partials",
  "dot",
  "options",
  "include",
  "includeAsync",
  "layout",
  "output",
  "capture",
  "captureAsync",
  "block",
  "blockAsync",
]);
// In push_subscriptions, `{% set agent = agent(...) %}` shadowed the global helper, so nunjucks
// threw on the second subscription. The Eta template uses a distinct local name instead.
const RENAMES = { push_subscriptions: { agent: "userAgent" } };
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const root = nunjucks.parser.parse(readFileSync(source, "utf8"), [], {});
const macros = root.children.filter((node) => node.typename === "Macro");
const macroNames = new Set(macros.map((macro) => macro.name.value));

class Converter {
  constructor(name) {
    this.name = name;
    this.renames = RENAMES[name] || {};
    this.frames = [];
  }
  fail(message) {
    throw new Error(`${this.name}: ${message}`);
  }
  pushFrame(nodes, bindings) {
    const pending = new Map();
    for (const node of nodes)
      if (node.typename === "Set") {
        const name = node.targets[0].value;
        if (!this.renames[name])
          pending.set(name, (pending.get(name) || 0) + 1);
      }
    this.frames.push({ bindings: new Map(bindings), pending, sets: new Set() });
  }
  lookup(name) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i];
      if (frame.bindings.has(name)) return frame.bindings.get(name);
      // A JS const read before its declaration throws, while nunjucks would fall back to
      // the outer value, so refuse templates that rely on that.
      if (frame.pending.has(name)) this.fail(`'${name}' is read before set`);
    }
  }
  bind(name, alias = name) {
    if (RESERVED.has(alias))
      this.fail(`local '${alias}' collides with a helper`);
    this.frames.at(-1).bindings.set(name, alias);
    return alias;
  }

  expression(node) {
    switch (node.typename) {
      case "Literal":
        return node.value === undefined
          ? "undefined"
          : JSON.stringify(node.value);
      case "Symbol": {
        const local = this.lookup(node.value);
        if (local) return local;
        if (node.value === "loop") this.fail("loop used outside for");
        if (GLOBALS.has(node.value)) return node.value;
        if (macroNames.has(node.value))
          this.fail(`macro ${node.value} used as a value`);
        return this.fail(`unknown symbol ${node.value}`);
      }
      case "LookupVal": {
        if (node.target.typename === "Symbol" && node.target.value === "loop")
          return this.loopValue(node.val);
        return this.target(node.target) + "?." + this.key(node.val);
      }
      case "FunCall": {
        const args = node.args.children.map((arg) => {
          if (arg.typename === "KeywordArgs")
            this.fail("keyword arguments are unsupported");
          return this.expression(arg);
        });
        return `${this.callee(node.name)}(${args.join(", ")})`;
      }
      case "Group":
        return (
          "(" +
          node.children.map((child) => this.expression(child)).join(", ") +
          ")"
        );
      case "Compare":
        return (
          this.expression(node.expr) +
          node.ops
            .map((op) => {
              if (!["==", "!=", "<", ">", "<=", ">="].includes(op.type))
                this.fail(`compare ${op.type}`);
              return ` ${op.type} ${this.expression(op.expr)}`;
            })
            .join("")
        );
      case "Or":
        return `(${this.expression(node.left)} || ${this.expression(node.right)})`;
      case "And":
        return `(${this.expression(node.left)} && ${this.expression(node.right)})`;
      case "Not":
        return "!" + this.target(node.target);
      default:
        return this.fail(`unsupported expression ${node.typename}`);
    }
  }
  key(node) {
    if (node.typename === "Literal" && typeof node.value === "string")
      return IDENTIFIER.test(node.value)
        ? node.value
        : `[${JSON.stringify(node.value)}]`;
    return `[${this.expression(node)}]`;
  }
  target(node) {
    const code = this.expression(node);
    return ["Or", "And", "Not", "Compare"].includes(node.typename)
      ? `(${code})`
      : code;
  }
  // nunjucks throws when the callee is missing, even if its owner is undefined. A plain member
  // call does that; the parentheses stop an optional chain on the owner from short-circuiting it.
  callee(node) {
    if (node.typename === "Symbol") return this.expression(node);
    if (node.typename !== "LookupVal") this.fail(`call on ${node.typename}`);
    const owner = this.target(node.target);
    const key = this.key(node.val);
    const member = key.startsWith("[") ? key : "." + key;
    return (owner.includes("?.") ? `(${owner})` : owner) + member;
  }
  loopValue(val) {
    const index = this.frames.findLast((frame) => frame.loopIndex)?.loopIndex;
    if (!index) this.fail("loop used outside for");
    const values = {
      index0: index,
      index: `(${index} + 1)`,
      first: `(${index} === 0)`,
    };
    return values[val.value] ?? this.fail(`loop.${val.value} unsupported`);
  }
  usesLoop(node) {
    if (!node || typeof node !== "object") return false;
    if (node.typename === "For") return false;
    if (
      node.typename === "LookupVal" &&
      node.target.typename === "Symbol" &&
      node.target.value === "loop"
    )
      return true;
    return Object.values(node).some((value) =>
      Array.isArray(value)
        ? value.some((child) => this.usesLoop(child))
        : this.usesLoop(value),
    );
  }

  statements(list) {
    return list.children.map((node) => this.statement(node)).join("");
  }
  statement(node) {
    switch (node.typename) {
      case "Output":
        return node.children.map((child) => this.output(child)).join("");
      case "If":
        return this.ifStatement(node, "<% if (") + "<% } %>";
      case "For":
        return this.forStatement(node);
      case "Set":
        return this.setStatement(node);
      default:
        return this.fail(`unsupported statement ${node.typename}`);
    }
  }
  output(node) {
    if (node.typename === "TemplateData") {
      if (node.value.includes("<%") || node.value.includes("%>"))
        this.fail("template text contains an Eta delimiter");
      return node.value;
    }
    if (
      node.typename === "FunCall" &&
      node.name.typename === "Symbol" &&
      macroNames.has(node.name.value) &&
      !this.lookup(node.name.value)
    ) {
      if (node.args.children.length !== 1)
        this.fail(`macro ${node.name.value} needs exactly one argument`);
      return `<%~ partials.${node.name.value}(${this.expression(node.args.children[0])}) %>`;
    }
    return `<%= ${this.expression(node)} %>`;
  }
  ifStatement(node, opening) {
    const cond =
      node.cond.typename === "Group" && node.cond.children.length === 1
        ? node.cond.children[0]
        : node.cond;
    let code = `${opening}${this.expression(cond)}) { %>${this.branch(node.body)}`;
    if (node.else_?.typename === "If")
      code += this.ifStatement(node.else_, "<% } else if (");
    else if (node.else_) code += `<% } else { %>${this.branch(node.else_)}`;
    return code;
  }
  // nunjucks keeps a set inside an if visible after the if, a JS block does not. Reading such a
  // name after the branch then fails as an unknown symbol, so the narrower scope is safe.
  branch(list) {
    this.pushFrame(list.children, []);
    const code = this.statements(list);
    this.frames.pop();
    return code;
  }
  forStatement(node) {
    if (node.name.typename !== "Symbol")
      this.fail("only single-name for loops are supported");
    if (node.else_) this.fail("for-else is unsupported");
    const iterable = this.expression(node.arr);
    const name = node.name.value;
    const withIndex = this.usesLoop(node.body);
    this.pushFrame(node.body.children, []);
    const item = this.bind(name);
    let head = `const ${item} of each(${iterable})`;
    if (withIndex) {
      const index = this.bind(`loop.${name}`, `${name}Index`);
      this.frames.at(-1).loopIndex = index;
      head = `const [${index}, ${item}] of each(${iterable}).entries()`;
    }
    const body = this.statements(node.body);
    this.frames.pop();
    return `<% for (${head}) { %>${body}<% } %>`;
  }
  setStatement(node) {
    if (node.targets.length !== 1 || !node.value)
      this.fail("only single-target set is supported");
    const name = node.targets[0].value;
    const frame = this.frames.at(-1);
    const value = this.expression(node.value);
    if (frame.sets.has(name))
      return `<% ${frame.bindings.get(name)} = ${value} %>`;
    if (frame.bindings.has(name))
      this.fail(`set ${name} reassigns a loop variable`);
    for (const outer of this.frames.slice(0, -1))
      if (outer.bindings.has(name))
        this.fail(`set ${name} would assign an outer variable in nunjucks`);
    const keyword = frame.pending.get(name) > 1 ? "let" : "const";
    const alias = this.bind(name, this.renames[name]);
    frame.sets.add(name);
    return `<% ${keyword} ${alias} = ${value} %>`;
  }
  convert(macro) {
    const params = macro.args.children.map((arg) => arg.value);
    if (params.length !== 1 || params[0] !== "dot")
      this.fail("macros must take exactly (dot)");
    this.pushFrame(macro.body.children, [["dot", "dot"]]);
    return this.statements(macro.body);
  }
}

for (const node of root.children)
  if (
    node.typename !== "Macro" &&
    !(
      node.typename === "Output" &&
      node.children.every(
        (child) => child.typename === "TemplateData" && !child.value.trim(),
      )
    )
  )
    throw new Error(`unexpected top-level ${node.typename}`);

mkdirSync(outDir, { recursive: true });
for (const macro of macros) {
  const name = macro.name.value;
  writeFileSync(
    join(outDir, name + ".eta"),
    new Converter(name).convert(macro),
  );
}
console.log(`converted ${macros.length} macros into ${outDir}`);
