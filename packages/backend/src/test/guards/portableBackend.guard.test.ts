// Guards for the parts of the backend a non-Node host (desktop shell, browser worker) relies on.
// Catalog entries be-app, be-db, be-migration-source, be-node-builtin, be-text-search name this file.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sources = (dir = SRC): string[] => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  if (statSync(full).isDirectory()) return name === "test" || name === "vendor" ? [] : sources(full);
  return name.endsWith(".ts") ? [full] : [];
});
const rel = (file: string) => relative(SRC, file);
const read = (file: string) => readFileSync(join(SRC, file), "utf8");
const ast = (file: string) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);

describe("app.ts is assembly only", () => {
  it("has no top-level await, no listening port, no migration, no background job", () => {
    const file = ast("app.ts");
    const topLevelAwait: string[] = [];
    const visit = (node: ts.Node, insideFunction: boolean) => {
      const fn = ts.isFunctionLike(node);
      if (ts.isAwaitExpression(node) && !insideFunction) topLevelAwait.push(node.getText());
      ts.forEachChild(node, (child) => visit(child, insideFunction || fn));
    };
    visit(file, false);
    expect(topLevelAwait).toEqual([]);
    const text = read("app.ts");
    for (const bootOnly of ["@hono/node-server", "migrate(", "startPeriodicJob", "startOutboxReconciler", "startDispatcherCatchup", "startModuleBackground", ".listen("]) {
      expect(text, `app.ts must not contain ${bootOnly}: boot belongs in server.ts`).not.toContain(bootOnly);
    }
  });

  it("nothing imports server.ts or the old index.ts; server.ts is the only user of @hono/node-server", () => {
    for (const file of sources()) {
      const text = readFileSync(file, "utf8");
      // Resolved, not matched by name: a module's own "../index.js" is modules/index.ts, which is fine.
      const named = [...text.matchAll(/from "(\.\.?\/[^"]*)"/g)].map((m) => join(dirname(file), m[1])).filter((path) => path === join(SRC, "server.js") || path === join(SRC, "index.js"));
      expect(named, rel(file)).toEqual([]);
      if (rel(file) !== "server.ts") expect(text, rel(file)).not.toContain("@hono/node-server");
    }
  });
});

describe("Node-only modules stay behind their entries", () => {
  it("only nodeBuiltins.ts reaches for process.getBuiltinModule", () => {
    const users = sources().filter((f) => readFileSync(f, "utf8").includes("getBuiltinModule")).map(rel).sort();
    expect(users).toEqual(["nodeBuiltins.ts"]);
  });

  it("db.ts does not import node: modules statically: migration SQL comes through dbMigrations.ts", () => {
    expect(read("db.ts")).not.toMatch(/from "node:|require\("node:/);
  });
});

describe("search SQL lives in services/textSearch.ts", () => {
  it("no other source uses pgroonga's operator or functions", () => {
    const offenders = sources().filter((f) => rel(f) !== "services/textSearch.ts").filter((f) => /&@~|pgroonga_(score|query_extract_keywords|snippet_html)/.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });
});
