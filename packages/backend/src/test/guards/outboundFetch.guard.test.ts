// Every route that can make this server reach out to the network asks spine/authority.ts assertMayReachOut first (a temporary session never makes
// the server reach out; PR #1856 review rounds 3–5), or asks something that refuses a session before it (requirePerson, mutatePersonal), or is
// named below with why it does not need to. Derived from the code, any HTTP method:
//   1. what reaches out (the roots): safeFetch (services/safeFetch.ts, the one gate for the app's own fetches) and the global fetch; a GitHub
//      client (`new Octokit…`: the backup push and the site push); `sendNotification` on the `web-push` import (a push notification); the dynamic import of
//      @huggingface/transformers (services/embedder.ts: it downloads the model on first use); better-auth's handler (`auth.handler`: a social
//      sign-in exchanges its code with the provider);
//   2. what reaches out LATER: `drainOutbox(…)` (it runs queued work at once, in the same request's async context), and `enqueueEffect` of a
//      kind whose `perform` reaches out — the kinds are derived from every `{ kind, perform }` object (an outbox effect's definition); a kind
//      that cannot be read as a string counts as reaching;
//   3. a function "reaches out" when it calls one, or calls (by name) a function that does; it is "guarded" when, BEFORE its first reaching call
//      in the text, it calls a guard (assertMayReachOut, requirePerson, requireHuman, mutatePersonal) or a function on WRAPPERS (each with what it
//      asks), at its own top level and unconditionally — not under an if, a ?:, &&/||/??, a loop, a switch, a try or catch, or in a callback —;
//      or every function it calls that reaches out is guarded and it reaches no root directly (round 6: no "holds a guard somewhere deep inside",
//      no authority literal);
//   4. every route handler (`<x>.get|post|put|patch|delete|all("/path", …)`, `<x>.on([…], "/path", …)`, `<x>.use("/path"?, …)` in src/) that
//      reaches out must be guarded or listed. A handler passed by name is followed; one passed as `obj.prop`, or a route whose path is not a
//      string, is reported (UNREAD) — never skipped.
// Calls are resolved by name through imports across src/; a method on an object (`x.f(…)`) is not followed, except the roots above, so a fetch
// reached only through an object's method would be missed (none is today: every outbound helper is a plain function). The behaviour is tested
// in sessionNoOutboundFetch.integration.test.ts.
// NOT roots, on purpose: a module's node hooks (spine/nodeHooks.ts) that queue a site rebuild after a write — reached through the module
// registry (a method), they push the OWNER's site to the owner's configured destination, as the git backup does; proposal §2d says so.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..");

/** Route handlers that reach out and do not ask first: each says why a temporary session never gets them to reach out. Only shrinks. */
// ratchet:list outbound-fetch-unguarded
const UNGUARDED: Record<string, string> = {
  "ALL / (routes/mcpProtocol.ts)": "the MCP surface (/api/mcp): app.ts refuses a temporary session there before any route runs (403 session_scope)",
  "POST /:id/claim (routes/mcpSessions.ts)": "an AI runner's pull (/api/mcp/sessions): app.ts refuses a temporary session on /api/mcp before any route runs",
  "ON /api/auth/* (app.ts)": "better-auth's sign-in (a social provider's code exchange, to the provider the owner configured): a sign-in, answered to whoever opens the page; a temporary session's credential is a bearer, never a sign-in, and gives it nothing there",
};

/** Outbox effects that reach out only to a destination the owner set up (never an address a request names), so queueing one is not the request
 *  reaching out: a temporary session's write may queue them (proposal §2d: what it writes reaches the owner's backup and site). Only shrinks. */
// ratchet:list outbound-owner-destinations
const OWNER_DESTINATIONS: Record<string, string> = {
  github_backup: "the owner's backup repository, set in the settings by a person (services/githubBackup.ts)",
  pages_push: "the owner's GitHub Pages repository, set in the publish settings by a person (website/publishing/githubPages.ts)",
  site_rebuild: "rebuilds the owner's site and pushes it to that same repository",
  site_bundle: "crawls this server's own frontend to store the site's copy",
  embed: "the embedding model, fixed in code (embedder.ts LOCAL_MODEL), downloaded once",
  embed_backfill: "the same model",
  agent_session_run: "the AI provider of the person's own key; queued only by starting an AI, which refuses a session (aiSessionStart)",
};

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" || e.name === "browser" ? [] : sourceFiles(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts") ? [path] : [];
  });
}

const FETCHES = new Set(["safeFetch", "fetch"]);
const GUARDS = new Set(["assertMayReachOut", "requirePerson", "requireHuman", "mutatePersonal"]);
/** Functions that refuse a temporary session at their start, so calling one (at the top of a handler, unconditionally, before the reach) counts as
 *  asking. Each says what it asks. Only shrinks; a new one is read by a person (round 6: a transitive "holds a guard somewhere" let any service
 *  call count, since the attribute writer holds a conditional requirePerson deep inside). */
// ratchet:list outbound-fetch-wrappers
const WRAPPERS: Record<string, string> = {
  "modules/rss/subscriptions.ts#changeSource": "a person's own feed: answers 404 or runs the change inside mutatePersonal (own_personal: refused to a session); the refresh drains only what the change queued",
  "modules/external_calendars/routes.ts#person": "requirePerson(actor, \"external_calendars\") then the current actor",
  "modules/website/routes.ts#siteAdmin": "assertAuthority principal_admin (the workspace owner; a session's actor never is)",
};
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "on", "use"]);
const ROUTER_OBJECT = /^(app|router|hono|r|api|sub|routes?)$|router$|app$/i;
const TRANSFORMERS = "@huggingface/transformers";

/** A function, as `<file>#<name>`; an outbox effect's perform as `effect:<kind>`. */
type Key = string;
type Call = { pos: number; to: Key | "root" | "later" | { effect: string | null; candidates: string[] } };
type Body = { calls: Call[]; guards: Array<{ pos: number; via: Key | "guard" }> };

/** `import { a as b } from "./x.js"` → b ↦ x.ts#a; `export { a } from "./x.js"` / `export * from` followed (one hop is enough here: barrels re-export). */
function resolveModule(from: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(from, "..", spec).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) if (known.has(candidate)) return candidate;
  return null;
}

function analyse(files: Array<{ file: string; text: string }>) {
  const known = new Set(files.map((f) => f.file));
  const sources = new Map(files.map(({ file, text }) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)]));
  const scope = new Map<string, Map<string, Key>>();
  /** per file: names bound to the `web-push` import, and to ./auth.js's `auth` */
  const rootObjects = new Map<string, Set<string>>();
  const reexport = new Map<Key, Key>();
  const starExports = new Map<string, string[]>();
  /** `const NAME = "text"` anywhere: an effect kind written as a constant */
  const strings = new Map<string, string>();
  for (const [file, source] of sources) {
    const names = new Map<string, Key>();
    const roots = new Set<string>();
    for (const st of source.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        const clause = st.importClause;
        if (spec === "web-push" && clause?.name) roots.add(clause.name.text);
        const target = resolveModule(file, spec, known);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if (target) names.set(el.name.text, `${target}#${(el.propertyName ?? el.name).text}`);
            if (target?.endsWith("/auth.ts") && (el.propertyName ?? el.name).text === "auth") roots.add(el.name.text);
          }
        }
      }
      if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const target = resolveModule(file, st.moduleSpecifier.text, known);
        if (!target) continue;
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) reexport.set(`${file}#${el.name.text}`, `${target}#${(el.propertyName ?? el.name).text}`);
        } else starExports.set(file, [...(starExports.get(file) ?? []), target]);
      }
    }
    const visitStrings = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteral(n.initializer)) strings.set(n.name.text, n.initializer.text);
      ts.forEachChild(n, visitStrings);
    };
    visitStrings(source);
    scope.set(file, names);
    rootObjects.set(file, roots);
  }
  const textOf = (e: ts.Expression | undefined): string | null =>
    !e ? null : ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : ts.isIdentifier(e) ? strings.get(e.text) ?? null : null;
  const kindOf = (o: ts.ObjectLiteralExpression): ts.Expression | undefined =>
    (o.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "kind") as ts.PropertyAssignment | undefined)?.initializer;

  const bodies = new Map<Key, Body[]>();
  const handlers: Array<{ route: string; body: Body }> = [];
  const unread: string[] = [];
  const canonical = (key: Key, depth = 0): Key => {
    if (depth > 5 || bodies.has(key)) return key;
    const r = reexport.get(key);
    if (r) return canonical(r, depth + 1);
    const [file, name] = key.split("#") as [string, string];
    for (const target of starExports.get(file) ?? []) { const k = canonical(`${target}#${name}`, depth + 1); if (bodies.has(k)) return k; }
    return key;
  };
  /** The string literals of a function: what a kind held in a variable can be (`const kinds = ["a", "b"]`, a parameter typed `"a" | "b"`). */
  const literalsIn = (node: ts.Node): string[] => {
    const out: string[] = [];
    const walk = (n: ts.Node) => { if (ts.isStringLiteral(n)) out.push(n.text); ts.forEachChild(n, walk); };
    walk(node);
    return out;
  };
  /** Runs whenever the function runs: not under a condition, a loop, a catch, or a callback (the guard must be met before the reach, every time). */
  const unconditional = (n: ts.Node, root: ts.Node): boolean => {
    for (let p = n.parent; p && p !== root; p = p.parent) {
      // a try block too: what throws before the guard is caught, and the code after the try runs without it having been met
      if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || ts.isSwitchStatement(p) || ts.isCaseClause(p) || ts.isCatchClause(p) || ts.isTryStatement(p)
        || ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)
        || ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) return false;
      if (ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) return false;
    }
    return true;
  };
  const wrapperKeys = new Set(Object.keys(WRAPPERS));
  const bodyOf = (file: string, node: ts.Node): Body => {
    const body: Body = { calls: [], guards: [] };
    const names = scope.get(file)!;
    const roots = rootObjects.get(file)!;
    const keyOfName = (name: string): Key => names.get(name) ?? `${file}#${name}`;
    const visit = (n: ts.Node) => {
      const pos = n.getStart();
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const name = n.expression.text;
        if (GUARDS.has(name)) { if (unconditional(n, node)) body.guards.push({ pos, via: "guard" }); }
        else if (FETCHES.has(name)) body.calls.push({ pos, to: "root" });
        else if (name === "drainOutbox") body.calls.push({ pos, to: "later" });
        else if (name === "enqueueEffect") {
          const arg = n.arguments[0];
          body.calls.push({ pos, to: { effect: arg && ts.isObjectLiteralExpression(arg) ? textOf(kindOf(arg)) : null, candidates: literalsIn(node) } });
        } else {
          const to = keyOfName(name);
          body.calls.push({ pos, to });
          if (wrapperKeys.has(relative(SRC, to)) && unconditional(n, node)) body.guards.push({ pos, via: to });
        }
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && roots.has(n.expression.expression.text)
        && ["sendNotification", "handler"].includes(n.expression.name.text)) {
        body.calls.push({ pos, to: "root" });
      }
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && /^Octokit/.test(n.expression.text)) body.calls.push({ pos, to: "root" });
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = n.arguments[0];
        if (arg && (textOf(arg) === TRANSFORMERS)) body.calls.push({ pos, to: "root" });
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return body;
  };
  for (const [file, source] of sources) {
    const add = (name: Key, node: ts.Node) => bodies.set(name, [...(bodies.get(name) ?? []), bodyOf(file, node)]);
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) add(`${file}#${n.name.text}`, n.body);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) add(`${file}#${n.name.text}`, n.initializer);
      // an outbox effect's definition: `{ kind: "x", perform: … }`
      if (ts.isObjectLiteralExpression(n)) {
        const perform = n.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && ts.isIdentifier(p.name) && p.name.text === "perform");
        const kind = textOf(kindOf(n));
        if (perform && kind) add(`effect:${kind}`, ts.isPropertyAssignment(perform) ? perform.initializer : perform);
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ROUTE_METHODS.has(n.expression.name.text) && n.arguments.length >= 1) {
        const method = n.expression.name.text;
        const object = n.expression.expression;
        const objectName = ts.isIdentifier(object) ? object.text : "";
        const pathAt = method === "on" ? 1 : 0;
        const pathArg = n.arguments[pathAt];
        const routerLike = ROUTER_OBJECT.test(objectName);
        // a path in a template (`${prefix}/resume`) is followed with its text as written
        const literal = pathArg && ts.isStringLiteral(pathArg) && pathArg.text.startsWith("/") ? pathArg.text
          : pathArg && ts.isTemplateExpression(pathArg) && routerLike ? pathArg.getText(source) : null;
        const where = `(${relative(SRC, file)})`;
        if (literal === null) {
          // a route whose path is not a string: reported, not skipped (a `use` with only middleware is a route for every path)
          if (method === "use" && routerLike && n.arguments.every((a) => !ts.isStringLiteral(a))) {
            for (const arg of n.arguments) handlerOf("USE *", where, arg);
          } else if (routerLike && n.arguments.length >= 2 && method !== "use") unread.push(`${method.toUpperCase()} ${pathArg?.getText(source) ?? "?"} ${where}`);
        } else if (n.arguments.length >= pathAt + 2) {
          for (const arg of n.arguments.slice(pathAt + 1)) handlerOf(`${method.toUpperCase()} ${literal}`, where, arg);
        }
      }
      ts.forEachChild(n, visit);
    };
    const handlerOf = (route: string, where: string, arg: ts.Expression) => {
      const label = `${route} ${where}`;
      if (ts.isIdentifier(arg)) {
        // passed by name: followed
        handlers.push({ route: label, body: { calls: [{ pos: 0, to: scope.get(file)!.get(arg.text) ?? `${file}#${arg.text}` }], guards: [] } });
      } else if (ts.isPropertyAccessExpression(arg)) unread.push(`${label}: handler ${arg.getText(source)}`);
      else handlers.push({ route: label, body: bodyOf(file, arg) });
    };
    visit(source);
  }
  const memoReach = new Map<Key, boolean>();
  const reachesTo = (to: Call["to"], seen: Set<Key>): boolean => {
    if (to === "root" || to === "later") return true;
    if (typeof to === "object") {
      // a kind in a variable: the effect kinds among the function's literals (none known: counts as reaching)
      const kinds = to.effect !== null ? [to.effect] : to.candidates.filter((k) => bodies.has(`effect:${k}`));
      if (kinds.length === 0) return true;
      return kinds.some((k) => !(k in OWNER_DESTINATIONS) && reachesKey(`effect:${k}`, seen));
    }
    return reachesKey(to, seen);
  };
  const reachesKey = (key: Key, seen: Set<Key>): boolean => {
    const k = canonical(key);
    if (memoReach.has(k)) return memoReach.get(k)!;
    if (seen.has(k)) return false;
    const result = (bodies.get(k) ?? []).some((b) => reachesBody(b, new Set([...seen, k])));
    if (seen.size === 0) memoReach.set(k, result);
    return result;
  };
  const reachesBody = (b: Body, seen: Set<Key>): boolean => b.calls.some((c) => reachesTo(c.to, seen));
  /** Guarded: a guard (or a call to a function that is guarded and reaches, i.e. asks before reaching) before the first reaching call;
   *  else every reaching call goes to a guarded function and none is a root. */
  const guardedKey = (key: Key, seen: Set<Key>): boolean => {
    const k = canonical(key);
    if (seen.has(k)) return true; // a cycle adds no fetch of its own
    return (bodies.get(k) ?? []).every((b) => guardedBody(b, new Set([...seen, k])));
  };
  const guardedBody = (b: Body, seen: Set<Key>): boolean => {
    const reaching = b.calls.filter((c) => reachesTo(c.to, new Set()));
    if (reaching.length === 0) return true;
    const first = Math.min(...reaching.map((c) => c.pos));
    if (b.guards.some((g) => g.pos < first)) return true;
    return reaching.every((c) => typeof c.to === "string" && c.to !== "root" && c.to !== "later" && guardedKey(c.to, seen));
  };
  const reaching = handlers.filter((h) => reachesBody(h.body, new Set()));
  return {
    reaching: [...new Set(reaching.map((h) => h.route))].sort(),
    unguarded: [...new Set(reaching.filter((h) => !guardedBody(h.body, new Set())).map((h) => h.route))].sort(),
    unread: [...new Set(unread)].sort(),
  };
}

/** Routes the analysis cannot read (a path that is not a string, a handler passed as `obj.prop`): each says why it does not reach out. Only shrinks. */
// ratchet:list outbound-fetch-unread
const UNREAD: Record<string, string> = {};

describe("outbound fetches: every route that can make this server reach out asks assertMayReachOut first (or a session refusal before it), or says why not", () => {
  const files = sourceFiles().map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const { reaching, unguarded, unread } = analyse(files);

  it("finds the routes that reach out (control: the ones sessionNoOutboundFetch tests are among them, and the outbox ones)", () => {
    for (const route of ["POST /preview (routes/bookmark.ts)", "POST /subscribe (modules/rss/routes.ts)", "POST /items/:id/fulltext (modules/rss/routes.ts)",
      "GET /items/:id/link (modules/rss/routes.ts)", "POST /sources/:id/refresh (modules/rss/routes.ts)", "POST /opml (modules/rss/routes.ts)"]) expect(reaching, route).toContain(route);
  });

  it("each of them asks first, or is listed with why", () => {
    expect(unguarded, "a route can make the server reach out without assertMayReachOut before it: call it first, or list it in UNGUARDED with why a session never gets it to").toEqual(Object.keys(UNGUARDED).sort());
  });

  it("no route is left unread: a path that is not a string, or a handler passed as obj.prop, is followed or listed", () => {
    expect(unread).toEqual(Object.keys(UNREAD).sort());
  });

  it("self-test: a GET handler that fetches through a helper is found, and is guarded only once the helper (or it) asks BEFORE the fetch", () => {
    const file = join(SRC, "routes", "fixture.ts");
    const one = (text: string) => analyse([{ file, text }]);
    expect(one(`async function load(u) { return safeFetch(u); }\nrouter.get("/x", async (c) => c.json(await load(c.req.query("u"))));`).unguarded).toEqual(["GET /x (routes/fixture.ts)"]);
    expect(one(`async function load(a, u) { assertMayReachOut(a); return safeFetch(u); }\nrouter.get("/x", async (c) => c.json(await load(1, "u")));`))
      .toEqual({ reaching: ["GET /x (routes/fixture.ts)"], unguarded: [], unread: [] });
    // fetch, then ask: red
    expect(one(`router.post("/x", async (c) => { await safeFetch("u"); assertMayReachOut(c); });`).unguarded).toEqual(["POST /x (routes/fixture.ts)"]);
    // a handler passed by name is followed
    expect(one(`async function h(c) { return safeFetch("u"); }\nrouter.post("/x", h);`).unguarded).toEqual(["POST /x (routes/fixture.ts)"]);
    // drainOutbox, an effect kind whose perform reaches out, a GitHub client: all reach out
    expect(one(`router.post("/x", async () => { void drainOutbox("w"); });`).reaching).toEqual(["POST /x (routes/fixture.ts)"]);
    expect(one(`const e = { kind: "far", perform: async () => { await fetch("u"); } };\nconst near = { kind: "near", perform: async () => {} };\nrouter.post("/x", async () => { await enqueueEffect({ kind: "far" }); });\nrouter.post("/y", async () => { await enqueueEffect({ kind: "near" }); });`).reaching)
      .toEqual(["POST /x (routes/fixture.ts)"]);
    expect(one(`router.post("/x", async () => { new Octokit({}); });`).reaching).toEqual(["POST /x (routes/fixture.ts)"]);
    // a route whose path is not a string, or a handler as obj.prop: unread
    expect(one(`router.post(PATH, async () => {});\nrouter.get("/y", handlers.y);`).unread).toEqual(["GET /y (routes/fixture.ts): handler handlers.y", "POST PATH (routes/fixture.ts)"]);
    // requirePerson / mutatePersonal before the reach count as asking (they refuse a session)
    expect(one(`router.post("/x", async (c) => { requirePerson(c, "x"); void drainOutbox("w"); });`).unguarded).toEqual([]);
    // round 6: only a guard met every time counts. A service call that holds a guard deep inside, under a condition, does not; nor does an
    // authority literal; nor a guard in a branch or a callback
    expect(one(`function save(a, k) { if (k === "x") requirePerson(a, "x"); }\nrouter.post("/x", async (c) => { await save(c, "y"); await safeFetch("u"); });`).unguarded).toEqual(["POST /x (routes/fixture.ts)"]);
    expect(one(`router.post("/x", async (c) => { await mutate({ authority: { kind: "principal_admin" } }); void drainOutbox("w"); });`).unguarded).toEqual(["POST /x (routes/fixture.ts)"]);
    expect(one(`router.post("/x", async (c) => { if (c.flag) assertMayReachOut(c); await safeFetch("u"); });`).unguarded).toEqual(["POST /x (routes/fixture.ts)"]);
    expect(one(`router.post("/x", async (c) => { [1].forEach(() => assertMayReachOut(c)); await safeFetch("u"); });`).unguarded).toEqual(["POST /x (routes/fixture.ts)"]);
    expect(one(`router.post("/x", async (c) => { try { assertMayReachOut(c); } catch {} await safeFetch("u"); });`).unguarded).toEqual(["POST /x (routes/fixture.ts)"]);
    // a function on the reasoned list counts at its call (a fixture file of the same name stands for it)
    const listed = join(SRC, "modules", "website", "routes.ts");
    expect(analyse([{ file: listed, text: `async function siteAdmin(a) {}\nrouter.post("/x", async (c) => { await siteAdmin(c); void drainOutbox("w"); });` }]).unguarded).toEqual([]);
  });
});
