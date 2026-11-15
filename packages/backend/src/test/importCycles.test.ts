// The backend's runtime imports form no cycle, so a layer never depends on one
// above it: routes and modules sit on services, services on the spine and db.
// A cycle used to tie 52 files together through three upward imports (a
// service importing the module registry, two importing routes/media.ts for a
// constant, the read policy importing the publisher). Type-only imports are
// erased at build time and don't count.
//
// One pair is allowed: attaching a tag expands its template, and a template's
// children get tags attached — mutual recursion between two files.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = [["services/tagMembershipWrites", "services/templateExpander"]];

const isTest = (path: string) => /\.test\.ts$/.test(path) || path.startsWith(`test${sep}`);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !isTest(relative(SRC, path))) out.push(path);
  }
  return out;
}

const id = (path: string) => relative(SRC, path).split(sep).join("/").replace(/\.ts$/, "");

/** Runtime import edges: `import … from`, `export … from`, `import("…")`. */
function runtimeImports(file: string, known: Set<string>): string[] {
  const text = readFileSync(file, "utf8");
  const specs = [
    ...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+["'](\.[^"']+)["']/gm),
    ...text.matchAll(/^\s*import\s+["'](\.[^"']+)["']/gm),
    ...text.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/g),
  ].map((m) => m[1]);
  const targets: string[] = [];
  for (const spec of specs) {
    const base = resolve(dirname(file), spec).replace(/\.js$/, "");
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (known.has(candidate)) { targets.push(candidate); break; }
    }
  }
  return targets;
}

/** Strongly connected components with more than one file (Tarjan). */
function cycles(graph: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>(), found: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next); low.set(v, next++); stack.push(v); onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); component.push(w); } while (w !== v);
      if (component.length > 1) found.push(component.map(id).sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found;
}

describe("backend import graph", () => {
  it("has no runtime import cycle beyond the allowed recursion", () => {
    const files = sourceFiles(SRC);
    const known = new Set(files);
    const graph = new Map(files.map((file) => [file, runtimeImports(file, known)]));
    expect(cycles(graph).sort()).toEqual(ALLOWED);
  });

  // Removing a module must not break core's compile: only app.ts and the two host entries (server.ts, and the
  // browser worker with its snapshot builder: src/browser/worker.ts, prepareSnapshot.ts) may name modules/. A module reaches core through
  // registration (ModuleDefinition) and a core base class (statusError.ts).
  it("core never imports from modules/ (type-only imports included)", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !id(file).startsWith("modules/") && !["app", "server", "browser/worker", "browser/prepareSnapshot"].includes(id(file)))
      .filter((file) => /\bfrom\s+["'](?:\.\.?\/)+modules\//.test(readFileSync(file, "utf8")) || /\bimport\(\s*["'](?:\.\.?\/)+modules\//.test(readFileSync(file, "utf8")))
      .map(id);
    expect(offenders).toEqual([]);
  });
});
