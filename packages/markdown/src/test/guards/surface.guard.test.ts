// Guard: the width of @onden/markdown's root entry only shrinks (proposal:
// docs/architecture/proposals/markdown-surface-and-app-store-2026-11-14.md, part A).
//   markdown-root-export-names    names `import … from "@onden/markdown"` can reach (index.ts → `export *` core.ts → ~100 modules)
//   markdown-root-names-in-use    the distinct root names frontend and backend production code actually import
// Both are baselines in scripts/surface-baseline.json, counted today and only allowed to go down: delete an export nobody
// reads, or move a group behind a named subpath entry (package.json "exports") and the number drops; a new name on the
// root, or a new name pulled from it, fails. The cheap numbers, not the plan: the plan says which names go where.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { checkSurface } from "../../../../../scripts/surfaceLib.mjs";
import { FILES } from "./sources";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every name the root entry exports, `export *` resolved: values and types alike. */
function rootExportNames(): string[] {
  const entry = join(SRC, "index.ts");
  const program = ts.createProgram([entry], { noEmit: true, skipLibCheck: true, types: [], module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022 });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry)!);
  return moduleSymbol ? checker.getExportsOfModule(moduleSymbol).map((s) => s.name) : [];
}

/** Names a file takes from exactly "@onden/markdown" (not its subpath entries): imports and re-exports, `type` ones included. */
export function rootImportNames(path: string, text: string): string[] {
  if (!text.includes("@onden/markdown")) return [];
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names: string[] = [];
  for (const st of file.statements) {
    if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "@onden/markdown") continue;
    const clause = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : st.exportClause;
    if (!clause) names.push("*");
    else if (ts.isNamespaceImport(clause) || ts.isNamespaceExport(clause)) names.push("*");
    else for (const el of clause.elements) names.push((el.propertyName ?? el.name).text);
  }
  return names;
}

describe("@onden/markdown's root entry stays narrow", () => {
  const exported = rootExportNames();
  const inUse = new Set<string>();
  for (const f of FILES) if (/^(frontend|backend)\//.test(f.path)) for (const n of rootImportNames(f.path, f.text)) inUse.add(n);

  it("the numbers mean what they say", () => {
    expect(exported).toContain("ondenMarkdownCore");
    expect(exported).toContain("TASKS_MODULE_ID"); // through core.ts's re-export of sharedContract.ts
    expect(rootImportNames("x.ts", `import { a, type B as C } from "@onden/markdown";\nexport { d } from "@onden/markdown";\nimport { e } from "@onden/markdown/ink";`)).toEqual(["a", "B", "d"]);
    expect([...inUse].filter((n) => n !== "*" && !exported.includes(n)), "imported from the root but not exported by it").toEqual([]);
  });

  it("markdown-root-export-names", () => {
    const result = checkSurface("markdown-root-export-names", exported.length, "根入口匯出的名稱");
    for (const note of result.notes) console.info(note);
    expect(result.errors.join("\n")).toBe("");
  });

  it("markdown-root-names-in-use", () => {
    const result = checkSurface("markdown-root-names-in-use", inUse.size, "前後端正式程式從根入口取用的不同名稱");
    for (const note of result.notes) console.info(note);
    expect(result.errors.join("\n")).toBe("");
  });
});
