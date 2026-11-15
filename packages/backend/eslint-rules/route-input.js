// Onden custom rule: route-input
//
// A route reads its request through routes/params.ts (parseBody, readJsonBody,
// uuidParam, uuidQuery, parseBigintId): one place decides what a malformed id,
// query or body is, so the same bad input is always the same 400. Reading
// `c.req.json()` directly is how a broken body got swallowed into `{}` and ran
// with defaults, and a raw `c.req.param()` is how a bad id reached Postgres as a 500.
//
// Flags `<x>.req.json | text | param | query | queries | parseBody | formData`
// (called, passed on, or destructured) and handing the request itself to
// another function (`helper(c.req)`), in routes/** and modules/*/routes.ts
// except routes/params.ts. The request is followed through the BINDING, not the
// name: `const req = c.req`, `const { req } = c`, `({ req }) => …`, `r = c.req`
// and `const { json } = c.req` all count, while an unrelated `req` elsewhere in
// the file does not. `c.req["json"]` is the same as `c.req.json`.
//
// BASELINE (route-input-exceptions.json, counts per file, ratchet-checked: only
// shrinks): a file may keep up to its count while it is migrated; more than that
// reports every use in the file. A file that is not listed may have none.
import { readFileSync } from "node:fs";

const PROPS = new Set(["json", "text", "param", "query", "queries", "parseBody", "formData"]);

const baseline = JSON.parse(readFileSync(new URL("./route-input-exceptions.json", import.meta.url), "utf8")).counts;

/** Whether `rel` (a path relative to backend/src) is a route file this rule covers. */
export function isCoveredRouteFile(rel) {
  return rel !== "routes/params.ts" && (/^routes\/.+\.ts$/.test(rel) || /^modules\/[^/]+\/routes\.ts$/.test(rel));
}

/** Property name of a member access (`.json` or `["json"]`), else null. */
function propName(node) {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : null;
  return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Routes read request input through routes/params.ts, not c.req.json/param/query." },
    schema: [],
  },
  create(context) {
    const filename = (context.filename || context.getFilename()).replace(/\\/g, "/");
    const m = /[\\/]backend[\\/]src[\\/](.+\.ts)$/.exec(filename);
    if (!m) return {};
    const rel = m[1];
    if (rel.endsWith(".test.ts") || !isCoveredRouteFile(rel)) return {};
    const allowed = baseline[rel] ?? 0;
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** The variable an identifier refers to (nearest enclosing scope that declares it). */
    const variableOf = (id) => {
      for (let scope = sourceCode.getScope(id); scope; scope = scope.upper) {
        const v = scope.set.get(id.name);
        if (v) return v;
      }
      return null;
    };

    const reqVars = new Set(); // variables that hold the request
    const bindings = []; // [variable | null, expression, ObjectPattern | null]: `const r = <expr>`, `r = <expr>`, `const { json } = <expr>`
    const accesses = []; // [reported node, what, the object it reads from]
    const isReq = (node) =>
      (node.type === "MemberExpression" && propName(node) === "req") ||
      (node.type === "Identifier" && reqVars.has(variableOf(node)));
    const keyName = (p) => (p.type === "Property" && !p.computed && p.key.type === "Identifier" ? p.key.name : null);

    /** `{ req }` / `{ req: r }` in a parameter or declaration holds the request. `declNode` owns the declared variables. */
    const bindRequestFrom = (pattern, declNode) => {
      if (pattern.type !== "ObjectPattern") return;
      for (const p of pattern.properties) {
        if (keyName(p) !== "req") continue;
        const target = p.value.type === "AssignmentPattern" ? p.value.left : p.value;
        if (target.type !== "Identifier") continue;
        for (const v of sourceCode.getDeclaredVariables(declNode)) if (v.name === target.name) reqVars.add(v);
      }
    };
    const fn = (node) => { for (const param of node.params) bindRequestFrom(param, node); };

    return {
      FunctionDeclaration: fn,
      FunctionExpression: fn,
      ArrowFunctionExpression: fn,
      VariableDeclarator(node) {
        if (!node.init) return;
        if (node.id.type === "ObjectPattern") {
          bindRequestFrom(node.id, node);
          bindings.push([null, node.init, node.id]);
        } else if (node.id.type === "Identifier") {
          const [v] = sourceCode.getDeclaredVariables(node);
          if (v) bindings.push([v, node.init, null]);
        }
      },
      AssignmentExpression(node) {
        if (node.left.type === "Identifier") bindings.push([variableOf(node.left), node.right, null]);
      },
      MemberExpression(node) {
        const name = propName(node);
        if (name && PROPS.has(name)) accesses.push([node, name, node.object]);
      },
      CallExpression(node) {
        for (const arg of node.arguments) accesses.push([arg, "the request passed on", arg]);
      },
      NewExpression(node) {
        for (const arg of node.arguments) accesses.push([arg, "the request passed on", arg]);
      },
      "Program:exit"() {
        // Aliases of aliases: settle which variables hold the request before judging any use.
        for (let changed = true; changed;) {
          changed = false;
          for (const [v, init] of bindings) if (v && !reqVars.has(v) && isReq(init)) { reqVars.add(v); changed = true; }
        }
        const found = accesses.filter(([, , object]) => isReq(object)).map(([node, what]) => [node, what]);
        // `const { json } = <request>`: a method taken off the request by destructuring.
        for (const [, init, pattern] of bindings) {
          if (!pattern || !isReq(init)) continue;
          for (const p of pattern.properties) if (PROPS.has(keyName(p))) found.push([p, keyName(p)]);
        }
        if (found.length <= allowed) return;
        for (const [node, what] of found) {
          context.report({
            node,
            message:
              `${rel} reads the request directly (${what}; ${found.length} uses, ${allowed} allowed while it migrates). ` +
              `Use routes/params.ts: parseBody / readJsonBody for the body, uuidParam / uuidQuery / parseBigintId for ids. ` +
              `See eslint-rules/route-input.js.`,
          });
        }
      },
    };
  },
};
