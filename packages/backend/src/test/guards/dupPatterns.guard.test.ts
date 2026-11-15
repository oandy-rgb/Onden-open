// Allow-list guards from docs/research/dup-patterns-2026-10-30-be.md: each
// rule names the one file that may do the job; any other file fails. Rule
// numbers (R1…) match the report.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}
const files = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));
type Src = { file: string; text: string };

const outside = (list: Src[], pattern: RegExp, owners: string[]) =>
  list.filter((f) => !owners.includes(f.file) && pattern.test(f.text)).map((f) => f.file);

// Comments are blanked (newlines kept) so a mention in prose never counts as code.
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

// R1: every exported async permission/assert predicate is awaited, returned or
// collected by Promise.all — never used as a condition, `const ok = canX()` or
// `.filter(id => canX(id))`, where a pending Promise is always truthy.
const PREDICATE_NAME = /export\s+async\s+function\s+((?:can|is|has|assert|ensure)\w*)/g;
const BOOLEAN_ASYNC = /export\s+async\s+function\s+(\w+)\s*(?:<[^>]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*:\s*Promise<boolean>/g;
const asyncPredicateNames = (list: Src[]) => {
  const names = new Set<string>();
  for (const f of list) {
    const text = stripComments(f.text);
    for (const re of [PREDICATE_NAME, BOOLEAN_ASYNC]) for (const m of text.matchAll(re)) names.add(m[1]);
  }
  return names;
};
const PREDICATE_NAMES = asyncPredicateNames(files);
const SYNC_CONTEXT = /\.(?:filter|some|every|find|findIndex|sort)\(/;
const closingParen = (text: string, open: number) => {
  for (let depth = 0, i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return text.length;
};
const unawaitedPredicates = (list: Src[], names: Set<string> = PREDICATE_NAMES) =>
  list.flatMap((f) => {
    const text = stripComments(f.text);
    return [...names].flatMap((name) =>
      [...text.matchAll(new RegExp(`(?<![\\w.$])${name}\\s*(?:<[^>]*>)?\\(`, "g"))].flatMap((m) => {
        const before = text.slice(0, m.index);
        if (/function\s+$/.test(before)) return []; // the definition
        const tail = before.trimEnd();
        if (/\b(?:await|return)$/.test(tail)) return [];
        // A `return a ? canX() : null` or `return !m.x || canX()` hands the promise to the caller; `!canX()` never does.
        const stmt = before.slice(Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}")) + 1);
        if (/^\s*return\b/.test(stmt) && !tail.endsWith("!")) return [];
        // `() => canX()` returns the promise; the same arrow inside .filter/.some/.find is a bug.
        const recent = tail.slice(-400);
        if (/=>$/.test(tail) && !SYNC_CONTEXT.test(recent.slice(-200))) return [];
        // `canX(...).catch(...)` / `.then(...)` consumes the promise.
        if (/^\s*\.(?:catch|then|finally)\b/.test(text.slice(closingParen(text, m.index! + m[0].length - 1) + 1))) return [];
        // Inside Promise.all(...map(x => canX(x))) the promises are collected.
        const all = recent.lastIndexOf("Promise.all");
        if (all >= 0 && /(?:=>|[(,[])$/.test(tail) && !SYNC_CONTEXT.test(recent.slice(all))) return [];
        return [`${f.file}:${lineOf(text, m.index!)} ${name}`];
      }));
  });

// R2: every LIKE/ILIKE argument is a literal pattern or a placeholder whose
// value went through escapeLike/containsPattern. Checked per occurrence, on
// code only: a `%` spliced in SQL (`LIKE '%' || $1 || '%'`) leaves the user's
// own % and _ as wildcards, so it never passes.
const LIKE_OWNERS = ["utils.ts"];
// harness/scope.ts: terms come from retrievalTerms, which only keeps letters, digits and "-".
// ratchet:list LIKE_EXCEPTIONS
const LIKE_EXCEPTIONS = ["services/harness/scope.ts"];
const ESCAPED = /\b(?:escapeLike|containsPattern)\b/;
const likeWithoutEscape = (list: Src[]) =>
  list.filter((f) => !LIKE_OWNERS.includes(f.file) && !LIKE_EXCEPTIONS.includes(f.file)).flatMap((f) => {
    const text = stripComments(f.text);
    return [...text.matchAll(/\bI?LIKE\b/gi)].flatMap((m) => {
      const rest = text.slice(m.index! + m[0].length);
      const arg = /^\s*('(?:[^']|'')*'|\$\{[^}]*\}|\$\d+|ANY\s*\(|\(|[a-z_][\w.]*)(\s*\|\|)?/i.exec(rest);
      if (!arg) return [];
      const at = `${f.file}:${lineOf(text, m.index!)}`;
      if (arg[2]) return [`${at} spliced pattern`];
      if (arg[1].startsWith("'")) return []; // a fixed literal pattern
      if (/^[a-z_]/i.test(arg[1]) && !/^\s*[a-z_][\w.]*\s*(?:\)|,|\n|$)/i.test(rest.slice(0, 60))) return []; // prose, not SQL
      const window = text.slice(0, m.index!).split("\n").slice(-25).join("\n");
      return ESCAPED.test(window) ? [] : [`${at} ${arg[1]}`];
    });
  });

// R3 / R6.
const DISPOSITION = /content-disposition/i;
// Any response helper answering with a literal 401: either quote style, extra fields, c.text(...), a Response init.
const HAND_WRITTEN_401 = /\b(?:json|text|body|Response)\(\s*[^;]*?(?:,\s*401\s*[,)]|status:\s*401\b)/;
// app.ts: a middleware that runs before any route, so requireActor has no handler to throw into.
// routes/mcpProtocol.ts: the MCP endpoint answers in JSON-RPC, which the central error handler does not speak.
const UNAUTHORIZED_OWNERS = ["app.ts", "routes/mcpProtocol.ts"];

describe("one owner per job (dup-patterns be)", () => {
  it("R1: async permission predicates are awaited in conditions", () => {
    expect(unawaitedPredicates(files)).toEqual([]);
  });
  it("R1 self-check: every unawaited form is caught, awaited forms pass", () => {
    const names = new Set(["canSeeTag", "assertWritable"]);
    const bad = (code: string) => unawaitedPredicates([{ file: "x.ts", text: code }], names);
    expect(bad("if (!exists || !canSeeTag(actor, id)) throw 1;")).toHaveLength(1);
    expect(bad("if (a &&\n  canSeeTag(actor, id)) x();")).toHaveLength(1);
    expect(bad("const ok = canSeeTag(actor, id);")).toHaveLength(1);
    expect(bad("ids.filter((id) => canSeeTag(actor, id));")).toHaveLength(1);
    expect(bad("assertWritable(actor);")).toHaveLength(1);
    expect(bad("if (!(await canSeeTag(actor, id))) throw 1;")).toEqual([]);
    expect(bad("return canSeeTag(actor, id);")).toEqual([]);
    expect(bad("await Promise.all(ids.map((id) => canSeeTag(actor, id)));")).toEqual([]);
    expect(bad("// canSeeTag(actor, id) in prose")).toEqual([]);
    expect(bad("const a = () => canSeeTag(actor, id);")).toEqual([]);
    expect(bad("return !m.x || canSeeTag(actor, id);")).toEqual([]);
    expect(bad("return !canSeeTag(actor, id);")).toHaveLength(1);
    expect(bad("void canSeeTag(actor, id).catch(log);")).toEqual([]);
  });
  it("R1: the names come from the source, not a hand-kept list", () => {
    expect(PREDICATE_NAMES.has("canReadNode")).toBe(true);
    expect(asyncPredicateNames([{ file: "x.ts", text: "export async function lookup(a: string,\n b: number): Promise<boolean> {}" }]).has("lookup")).toBe(true);
  });

  it("R2: LIKE/ILIKE patterns built from parameters go through utils.ts escapeLike", () => {
    expect(likeWithoutEscape(files)).toEqual([]);
  });
  it("R2 self-check: unescaped, spliced and lower-case forms are caught", () => {
    const bad = (code: string) => likeWithoutEscape([{ file: "x.ts", text: code }]);
    expect(bad("WHERE title ILIKE $2")).toHaveLength(1);
    expect(bad("WHERE title ilike $2")).toHaveLength(1);
    expect(bad("WHERE title LIKE '%' || $1 || '%'")).toHaveLength(1);
    expect(bad("WHERE title LIKE $1 || '%'")).toHaveLength(1);
    expect(bad("// escapeLike is great\nWHERE title ILIKE $2")).toHaveLength(1);
    expect(bad("params.push(containsPattern(q));\nWHERE title ILIKE $2")).toEqual([]);
    expect(bad("WHERE key NOT LIKE '\\\\_%'")).toEqual([]);
  });
  it("R2: escapeLike is defined once", () => {
    expect(files.filter((f) => /function escapeLike\b|const escapeLike\b/.test(f.text)).map((f) => f.file)).toEqual(["utils.ts"]);
  });

  it("R3: Content-Disposition is written by downloadHeaders.ts only", () => {
    expect(outside(files, DISPOSITION, ["downloadHeaders.ts"])).toEqual([]);
  });
  it("R3 self-check: a hand-written header is caught", () => {
    expect(outside([{ file: "x.ts", text: 'c.header("content-disposition", "attachment")' }], DISPOSITION, [])).toEqual(["x.ts"]);
  });

  it("R6: 401 for a missing actor is thrown by requireActor, not hand-written", () => {
    expect(outside(files, HAND_WRITTEN_401, UNAUTHORIZED_OWNERS)).toEqual([]);
  });
  it("R6 self-check: single quotes, extra fields and c.text are caught", () => {
    const bad = (code: string) => outside([{ file: "x.ts", text: code }], HAND_WRITTEN_401, []);
    expect(bad('return c.json({ error: "unauthorized" }, 401);')).toEqual(["x.ts"]);
    expect(bad("return c.json({ error: 'unauthorized' }, 401);")).toEqual(["x.ts"]);
    expect(bad('return c.json({ error: "unauthorized", hint: "login" }, 401);')).toEqual(["x.ts"]);
    expect(bad('return c.text("no", 401);')).toEqual(["x.ts"]);
    expect(bad('return new Response("no", { status: 401 });')).toEqual(["x.ts"]);
    expect(bad('return c.json({ error: "forbidden" }, 403);')).toEqual([]);
  });
});
