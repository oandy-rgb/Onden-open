// Detectors for the backend allowlist guards (allowlist.guard.test.ts): pure functions of source text,
// TypeScript AST only, so allowlistRules.guard.test.ts can feed each one a violating and a legal sample.
import { dirname, join, normalize } from "node:path";
import ts from "typescript";

export function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

const walk = (root: ts.Node, visit: (node: ts.Node) => void) => {
  const go = (node: ts.Node) => { visit(node); ts.forEachChild(node, go); };
  go(root);
};

const lineOf = (file: ts.SourceFile, node: ts.Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

/** `process.env` reads (`process.env.X`, `process.env["X"]`, `const { X } = process.env`), as 1-based lines. */
export function processEnvLines(path: string, source: string): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  walk(file, (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isIdentifier(node.expression) && node.expression.text === "process") lines.push(lineOf(file, node));
  });
  return lines;
}
export const processEnvUses = (path: string, source: string): number => processEnvLines(path, source).length;

/** Calls of `setInterval(...)`, bare or through `globalThis`/`global`/`timers`, as 1-based lines. */
export function setIntervalLines(path: string, source: string): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === "setInterval") lines.push(lineOf(file, node));
    else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "setInterval" && ts.isIdentifier(callee.expression) && ["globalThis", "global"].includes(callee.expression.text)) lines.push(lineOf(file, node));
  });
  return lines;
}
export const setIntervalUses = (path: string, source: string): number => setIntervalLines(path, source).length;

/** `console.<anything>` uses, as 1-based lines. */
export function consoleLines(path: string, source: string): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  walk(file, (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "console") lines.push(lineOf(file, node));
  });
  return lines;
}
export const consoleUses = (path: string, source: string): number => consoleLines(path, source).length;

/** SQL run straight from a route file: `<db>.query(...)` on any plain identifier (`pool`, `client`, `db`, `tx`…)
 *  and calls of the `q(...)` helper from db.ts, as 1-based lines. `c.req.query(...)` is a request parameter read,
 *  not SQL: its receiver is a property access, not an identifier. */
export function routeSqlLines(path: string, source: string): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "query" && ts.isIdentifier(callee.expression)) lines.push(lineOf(file, node));
    else if (ts.isIdentifier(callee) && callee.text === "q") lines.push(lineOf(file, node));
  });
  return lines;
}
/** Hand-written SQL anywhere in app code: the same calls routeSqlLines finds, counted per file against a baseline that only shrinks (be-raw-sql). */
export const rawSqlLines = routeSqlLines;
export const routeSqlUses = (path: string, source: string): number => routeSqlLines(path, source).length;

/** Relative import specifiers (static, dynamic `import()` and `export … from`), resolved against `fromFile`
 *  to a path under src/ without extension: `routes/nodes.ts` + `../services/x.js` → `services/x`. */
export function relativeImportSites(fromFile: string, source: string): { target: string; line: number }[] {
  const sites: { target: string; line: number }[] = [];
  const file = parse(fromFile, source);
  const add = (spec: string, node: ts.Node) => {
    if (!spec.startsWith(".")) return;
    sites.push({ target: normalize(join(dirname(fromFile), spec)).replace(/\\/g, "/").replace(/\.(js|ts)$/, ""), line: lineOf(file, node) });
  };
  walk(file, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text, node);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text, node);
  });
  return sites;
}
export const relativeImportTargets = (fromFile: string, source: string): string[] => relativeImportSites(fromFile, source).map((site) => site.target);

/** Lines that name a module by string: `import … from "x"`, `export … from "x"`, `import("x")`, `require("x")`. */
function moduleSpecifierLines(path: string, source: string, matches: (specifier: string) => boolean): number[] {
  const file = parse(path, source);
  const lines: number[] = [];
  walk(file, (node) => {
    let literal: ts.Expression | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) literal = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.arguments.length > 0 && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) literal = node.arguments[0];
    if (literal && ts.isStringLiteralLike(literal) && matches(literal.text)) lines.push(lineOf(file, literal));
  });
  return lines;
}

/** `node:async_hooks` (AsyncLocalStorage): request context goes through requestContext.ts. */
export const asyncHooksLines = (path: string, source: string): number[] => moduleSpecifierLines(path, source, (s) => s === "node:async_hooks" || s === "async_hooks");
/** The `pg` driver: only db.ts decides which database engine answers. */
export const pgDriverLines = (path: string, source: string): number[] => moduleSpecifierLines(path, source, (s) => s === "pg" || s.startsWith("pg/"));

// ---- SQL text assembled with ${} ----------------------------------------------------------------------------
// Every first argument of q(...) / <db>.query(...) must be built only from things that cannot carry user input:
//   (1) literals and ALL_CAPS constants (a module-level name for a table, column list or fixed SQL fragment),
//   (2) calls of a registered fragment helper (owners.ts SQL_FRAGMENT_HELPERS) or of sqlInt() for a number,
//   (3) a local name whose every assignment is one of these (so `const scope = readableScopeSql(...)` is fine,
//       a function parameter or a value taken from a request is not),
//   plus `.length`, ternaries / `+` / `.join("sep")` over such parts. Anything else is returned as a site.
// Values always go through $n parameters; the SQL text itself is never data.

const isConstName = (name: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(name);
const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) ? unwrap(e.expression) : e;

const returnsOf = (fn: ts.FunctionLikeDeclaration): ts.Expression[] => {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const found: ts.Expression[] = [];
  const scan = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return; // a nested function's returns are its own
    if (ts.isReturnStatement(n) && n.expression) found.push(n.expression);
    ts.forEachChild(n, scan);
  };
  scan(fn.body);
  return found;
};

/** How a callee is named in the helper list: `name`, or `name().method` for a method of a factory's result. */
const calleeKey = (callee: ts.Expression): string => {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) {
    const base = unwrap(callee.expression);
    if (ts.isCallExpression(base) && ts.isIdentifier(base.expression)) return `${base.expression.text}().${callee.name.text}`;
  }
  return "";
};

interface NameSources { exprs: ts.Expression[]; opaque: boolean; fn?: ts.FunctionLikeDeclaration }
type Names = (name: string, from: ts.Node) => NameSources | undefined;

/** The nearest node whose braces a declaration lives in: a function (its parameters), a block, a `for` statement. */
const scopeOf = (decl: ts.Node): ts.Node => {
  for (let n: ts.Node | undefined = decl.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isBlock(n) || ts.isSourceFile(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isCatchClause(n) || ts.isCaseBlock(n)) return n;
  }
  return decl.getSourceFile();
};

/** Per scope: every expression a local name can hold (initializers, assignments, pushed array items); `opaque`
 *  when it can also come from outside (parameter, destructuring of a call result, loop variable, catch). A use
 *  is resolved to the nearest enclosing declaration, so `dir` in one function is not `dir` in another. */
function nameSources(file: ts.SourceFile, helpers: ReadonlySet<string>): Names {
  const scopes = new Map<ts.Node, Map<string, NameSources>>();
  const declare = (scope: ts.Node, name: string): NameSources => {
    let m = scopes.get(scope);
    if (!m) scopes.set(scope, (m = new Map()));
    let s = m.get(name);
    if (!s) m.set(name, (s = { exprs: [], opaque: false }));
    return s;
  };
  const lookup: Names = (name, from) => {
    for (let n: ts.Node | undefined = from; n; n = n.parent) {
      const found = scopes.get(n)?.get(name);
      if (found) return found;
    }
    return undefined;
  };
  const eachName = (b: ts.BindingName, visit: (id: ts.Identifier) => void) => {
    if (ts.isIdentifier(b)) visit(b);
    else for (const el of b.elements) if (!ts.isOmittedExpression(el)) eachName(el.name, visit);
  };
  const passedOn: { name: string; from: ts.Node }[] = [];
  walk(file, (node) => {
    if (ts.isVariableDeclaration(node)) {
      const loop = ts.isVariableDeclarationList(node.parent) && (ts.isForOfStatement(node.parent.parent) || ts.isForInStatement(node.parent.parent)) ? node.parent.parent : undefined;
      const scope = loop ?? scopeOf(node.parent.parent ?? node);
      const init = node.initializer && unwrap(node.initializer);
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isIdentifier(node.name)) declare(scope, node.name.text).fn = init;
      // `const { table, col } = TABLE[kind]`: each piece is a part of the initializer, as safe as the whole
      else if (!loop && ts.isIdentifier(node.name) && !init) declare(scope, node.name.text); // `let x;`: its assignments decide
      else if (!loop && init) eachName(node.name, (id) => declare(scope, id.text).exprs.push(init));
      else eachName(node.name, (id) => { declare(scope, id.text).opaque = true; });
    } else if (ts.isFunctionDeclaration(node) && node.name) declare(scopeOf(node), node.name.text).fn = node;
    else if (ts.isParameter(node)) eachName(node.name, (id) => { declare(scopeOf(node), id.text).opaque = true; });
    else if (ts.isCatchClause(node) && node.variableDeclaration) eachName(node.variableDeclaration.name, (id) => { declare(node, id.text).opaque = true; });
  });
  // second pass, once every declaration is known: assignments, appended items, arrays handed away
  walk(file, (node) => {
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
      lookup(node.left.text, node)?.exprs.push(node.right);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && ["push", "unshift"].includes(node.expression.name.text)) {
      const target = lookup(node.expression.expression.text, node);
      for (const arg of node.arguments) target?.exprs.push(ts.isSpreadElement(arg) ? arg.expression : arg);
    } else if (ts.isCallExpression(node) && !helpers.has(calleeKey(node.expression)) && !(ts.isPropertyAccessExpression(node.expression) && ["join", "map", "filter", "includes", "some", "every", "slice", "concat", "indexOf"].includes(node.expression.name.text))) {
      for (const arg of node.arguments) if (ts.isIdentifier(arg)) passedOn.push({ name: arg.text, from: node }); // handed to code that may append to it
    }
  });
  // an array of SQL pieces handed to an unregistered function can grow there, out of sight
  for (const { name, from } of passedOn) {
    const known = lookup(name, from);
    if (known?.exprs.some((x) => ts.isArrayLiteralExpression(unwrap(x)))) known.opaque = true;
  }
  return lookup;
}

/** The SQL-text expressions in `source` that are not one of the allowed forms, as `{ line, text }`.
 *  `helpers` are the callee names allowed to return SQL text (owners.ts SQL_FRAGMENT_HELPERS). */
export function sqlInterpolationSites(path: string, source: string, helpers: ReadonlySet<string>): { line: number; text: string }[] {
  const file = parse(path, source);
  const names = nameSources(file, helpers);
  const sites: { line: number; text: string }[] = [];
  const resolving = new Set<unknown>();
  let env: ReadonlyMap<NameSources, boolean> = new Map(); // parameters of the local function being judged

  /** The object literals a name or ternary can be, or null when it can be anything else too. */
  const objectLiterals = (expr: ts.Expression, seen: Set<unknown>): ts.ObjectLiteralExpression[] | null => {
    const e = unwrap(expr);
    if (ts.isObjectLiteralExpression(e)) return [e];
    if (ts.isConditionalExpression(e)) {
      const a = objectLiterals(e.whenTrue, seen), b = objectLiterals(e.whenFalse, seen);
      return a && b ? [...a, ...b] : null;
    }
    if (ts.isIdentifier(e)) {
      const known = names(e.text, e);
      if (!known || env.has(known) || known.opaque || known.exprs.length === 0 || seen.has(known)) return null;
      seen.add(known);
      const parts = known.exprs.map((x) => objectLiterals(x, seen));
      return parts.every((x) => x) ? parts.flatMap((x) => x!) : null;
    }
    return null;
  };

  const isSafe = (expr: ts.Expression): boolean => {
    const e = unwrap(expr);
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isPrefixUnaryExpression(e)) return ts.isNumericLiteral(e.operand);
    if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => isSafe(s.expression));
    if (ts.isConditionalExpression(e)) return isSafe(e.whenTrue) && isSafe(e.whenFalse);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      const ok = op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.AsteriskToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken;
      return ok && isSafe(e.left) && isSafe(e.right);
    }
    if (ts.isArrayLiteralExpression(e)) return e.elements.every((el) => isSafe(ts.isSpreadElement(el) ? el.expression : el));
    if (ts.isIdentifier(e)) {
      if (e.text === "undefined") return true;
      const known = names(e.text, e);
      if (!known) return isConstName(e.text); // imported (or global): only a constant-looking name
      if (env.has(known)) return env.get(known)!;
      if (known.opaque) return false;
      if (resolving.has(known)) return true; // self-reference (x += …): the other sources decide
      resolving.add(known);
      const ok = known.exprs.every(isSafe);
      resolving.delete(known);
      return ok;
    }
    // a part of something safe is safe (`TABLE[kind].col`, `built.sql`); `.length` is a number
    if (ts.isPropertyAccessExpression(e) && e.name.text !== "length") {
      // `source.sql` where `source = cond ? { value, sql: … } : { value, sql: … }`: only the named property counts
      const objects = objectLiterals(e.expression, new Set());
      if (objects) return objects.every((o) => o.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === e.name.text && isSafe(p.initializer)));
    }
    if (ts.isPropertyAccessExpression(e)) return e.name.text === "length" || isSafe(e.expression);
    if (ts.isElementAccessExpression(e)) return isSafe(e.expression);
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.every((p) => (ts.isPropertyAssignment(p) && isSafe(p.initializer)) || (ts.isShorthandPropertyAssignment(p) && isSafe(p.name)) || (ts.isSpreadAssignment(p) && isSafe(p.expression)));
    }
    if (ts.isCallExpression(e)) {
      const callee = e.expression;
      if (helpers.has(calleeKey(callee))) return e.arguments.every((a) => !ts.isTemplateExpression(unwrap(a)) || isSafe(a)); // SQL built into an argument is still SQL text
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "push") return true; // the new array length: a $n placeholder index
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Math" && ["max", "min"].includes(callee.name.text)) return e.arguments.every((a) => isSafe(a));
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "map" && e.arguments.length === 1) {
        const fn = unwrap(e.arguments[0]!); // `rows.map((r) => `($${…})`)`: judged by what the callback returns
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) return returnsOf(fn).every(isSafe);
      }
      if (ts.isIdentifier(callee)) {
        const fn = names(callee.text, callee)?.fn; // a function declared in this file: judged by what it returns, its parameters being as safe as the arguments
        if (fn && !resolving.has(fn)) {
          const bound = new Map<NameSources, boolean>();
          fn.parameters.forEach((p, i) => {
            const param = ts.isIdentifier(p.name) ? names(p.name.text, p.name) : undefined;
            const arg = e.arguments[i];
            if (param) bound.set(param, arg ? isSafe(arg) : p.initializer ? isSafe(p.initializer) : true);
          });
          const outer = env;
          env = bound;
          resolving.add(fn);
          const ok = returnsOf(fn).every(isSafe);
          resolving.delete(fn);
          env = outer;
          return ok;
        }
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "join" && e.arguments.length === 1 && ts.isStringLiteralLike(e.arguments[0]!)) return isSafe(callee.expression);
      return false;
    }
    return false;
  };

  // report the smallest unsafe part so the line points at the offending ${}
  const report = (expr: ts.Expression) => {
    const e = unwrap(expr);
    if (isSafe(e)) return;
    if (ts.isTemplateExpression(e)) { for (const s of e.templateSpans) report(s.expression); return; }
    if (ts.isConditionalExpression(e)) { report(e.whenTrue); report(e.whenFalse); return; }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) { report(e.left); report(e.right); return; }
    if (ts.isCallExpression(e) && helpers.has(calleeKey(e.expression))) { for (const a of e.arguments) if (ts.isTemplateExpression(unwrap(a))) report(a); return; }
    sites.push({ line: lineOf(file, e), text: e.getText(file) });
  };

  walk(file, (node) => {
    if (!ts.isCallExpression(node) || !node.arguments[0]) return;
    const callee = node.expression;
    const isQuery = (ts.isIdentifier(callee) && callee.text === "q") ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === "query" && ts.isIdentifier(callee.expression));
    if (!isQuery) return;
    const arg = unwrap(node.arguments[0]);
    // q(sql, …): the variable's own definition is what gets checked
    if (ts.isIdentifier(arg) && !isConstName(arg.text) && names(arg.text, arg)) {
      const known = names(arg.text, arg)!;
      if (known.opaque) sites.push({ line: lineOf(file, arg), text: arg.text });
      else known.exprs.forEach(report);
    } else report(arg);
  });
  return sites;
}
