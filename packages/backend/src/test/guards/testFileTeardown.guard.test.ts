// A test file shares ONE pool, server or clock between all its top-level describes. Ending that resource in a hook of ONE
// describe breaks the others when they run after it (the shuffle puts them in any order): their queries fail on a closed
// pool, and an `it.fails` there "passes" on the pool error. The end belongs in a file-level afterAll.
// A resource a describe made for itself (a scratch pool, a server it started) may be ended in that describe's own hook.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const TEST_ROOT = join(import.meta.dirname, "..");

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : testFiles(path);
    return /\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const isCall = (node: ts.Node, name: string): node is ts.CallExpression =>
  ts.isCallExpression(node) && (
    (ts.isIdentifier(node.expression) && node.expression.text === name)
    // describe.skipIf(x)("…", fn), describe.each(…)(…), describe.concurrent(…)
    || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === name)
    || (ts.isCallExpression(node.expression) && isCall(node.expression, name)));

/** A call that ends something every describe of the file may be using: `pool.end()`, `server.close()`, `vi.useRealTimers()`,
 *  a clock put back to real time. Only the names that are shared by convention; a local `scratch.end()` is not one. */
function endsSharedResource(node: ts.Node): string | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const receiver = node.expression.expression;
  const method = node.expression.name.text;
  const name = ts.isIdentifier(receiver) ? receiver.text : "";
  if (name === "pool" && method === "end") return "pool.end()";
  if (/^(server|httpServer|app)$/.test(name) && method === "close") return `${name}.close()`;
  if (name === "vi" && /^useRealTimers$/.test(method)) return `vi.${method}()`;
  return null;
}

export function describeLevelEnds(file: string): { top: number; ends: string[] } {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let top = 0;
  const ends: string[] = [];
  const visit = (node: ts.Node, insideDescribe: boolean) => {
    if (isCall(node, "describe")) {
      if (!insideDescribe) top++;
      ts.forEachChild(node, (child) => visit(child, true));
      return;
    }
    if (insideDescribe && (isCall(node, "afterAll") || isCall(node, "afterEach"))) {
      const hook = node;
      const found: string[] = [];
      const scan = (n: ts.Node) => { const hit = endsSharedResource(n); if (hit) found.push(hit); ts.forEachChild(n, scan); };
      scan(hook);
      for (const hit of found) ends.push(`${hit} at line ${source.getLineAndCharacterOfPosition(hook.getStart()).line + 1}`);
    }
    ts.forEachChild(node, (child) => visit(child, insideDescribe));
  };
  visit(source, false);
  return { top, ends };
}

describe("a test file ends a shared resource only at file level", () => {
  it("no file with more than one top-level describe ends its pool, server or clock inside one of them", () => {
    const offenders = testFiles(TEST_ROOT).flatMap((file) => {
      const { top, ends } = describeLevelEnds(file);
      return top > 1 && ends.length > 0 ? [`${relative(TEST_ROOT, file).split(sep).join("/")}: ${ends.join(", ")}`] : [];
    });
    expect(offenders, "move the end into a file-level afterAll (see viewQuery.property.integration.test.ts)").toEqual([]);
  });

  it("the check sees the shape it is there for", () => {
    const probe = join(import.meta.dirname, "__teardownProbe.ts");
    // describeLevelEnds reads a path, so the probe is written next to this file and removed at once.
    writeFileSync(probe, `describe("a", () => { afterAll(async () => { await pool.end(); }); });\ndescribe.skipIf(x)("b", () => { it("t", () => {}); });\nafterAll(() => vi.useRealTimers());`);
    try {
      expect(describeLevelEnds(probe)).toEqual({ top: 2, ends: ["pool.end() at line 1"] });
    } finally { rmSync(probe); }
  });
});
