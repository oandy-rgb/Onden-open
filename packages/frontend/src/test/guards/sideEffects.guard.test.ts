// @vitest-environment node
// Guard: package.json `sideEffects` lists the files whose import does something.
//
// Astro 7 bundles with Rolldown. It prunes the unused re-exports of a barrel (modules/tasks/index.ts,
// lib/ink/index.ts...) only when the files behind them are declared side-effect free, and a barrel's unused
// re-exports are what keep screens that load on use out of the boot JS (scripts/check-boot-bundle.mjs).
// The other way round, a file that registers something when imported but is not listed is dropped from a build
// where nothing uses its exports, and the app loses the registration without an error.
// So: every file with a top-level statement that runs on import (or that a bare `import "./x"` is there for) is listed, and every listed file still is one.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SRC, sourceFiles } from "./sources";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const listed: string[] = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).sideEffects;
const LISTED_FILES = listed.filter((entry) => entry.startsWith("./src/")).map((entry) => entry.slice("./src/".length));

/** The file a bare `import "./x"` reaches, relative to src/ (null for a package or a stylesheet). */
function bareImportTarget(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".") || /\.s?css$/.test(specifier)) return null;
  const base = join(dirname(file), specifier);
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].map((p) => relative(".", p)).find((p) => existsSync(join(SRC, p))) ?? null;
}

/** Statements that run when the module is imported: anything at the top level that is not a declaration (a bare call,
 *  an assignment, a `for` that registers each module, an `if`), or a declaration whose value is a register/install call. */
function runsOnImport(file: string): string | null {
  const hit = parse(file).statements.find((statement) => {
    if (ts.isExpressionStatement(statement)) return !ts.isStringLiteral(statement.expression);
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((d) => d.initializer && /^\s*(register|install|subscribe)[A-Z]\w*\s*\(/.test(d.initializer.getText()));
    return ts.isForStatement(statement) || ts.isForOfStatement(statement) || ts.isForInStatement(statement) || ts.isWhileStatement(statement)
      || ts.isIfStatement(statement) || ts.isTryStatement(statement) || ts.isBlock(statement) || ts.isSwitchStatement(statement);
  });
  return hit ? hit.getText().slice(0, 60) : null;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(join(SRC, file), "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Files a bare `import "./x"` of this file is there for: they must be listed too, or the import does nothing. */
function bareImports(file: string): string[] {
  return parse(file).statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause) return [];
    const target = bareImportTarget(file, (statement.moduleSpecifier as ts.StringLiteral).text);
    return target ? [target] : [];
  });
}

const files = sourceFiles(".").map((file) => relative(SRC, file)).filter((file) => !file.endsWith(".d.ts"));

describe("package.json sideEffects", () => {
  it("lists stylesheets, so importing one still loads it", () => {
    expect(listed).toEqual(expect.arrayContaining(["*.css", "*.scss"]));
  });

  it("lists every file that runs a statement when imported", () => {
    const missing = files.filter((file) => runsOnImport(file) && !LISTED_FILES.includes(file)).map((file) => `${file}: ${runsOnImport(file)}`);
    expect(missing, "add each file to `sideEffects` in packages/frontend/package.json, or move the statement into a function something calls").toEqual([]);
  });

  it("lists the file behind every bare `import \"./x\"`, which is an import for its effect", () => {
    const missing = files.flatMap((file) => bareImports(file).filter((target) => !LISTED_FILES.includes(target)).map((target) => `${file} imports ${target}`));
    expect(missing, "list the imported file in `sideEffects` (or import something from it)").toEqual([]);
  });

  it("lists only files that still do", () => {
    const imported = new Set(files.flatMap(bareImports));
    const stale = LISTED_FILES.filter((file) => !files.includes(file) || !(runsOnImport(file) || imported.has(file)));
    expect(stale, "remove each from `sideEffects`: the file is gone or no longer runs anything on import and nothing imports it for its effect").toEqual([]);
  });

  it("uses paths relative to the package, which is how Rolldown matches them", () => {
    expect(listed.filter((entry) => entry.startsWith("./") && !entry.startsWith("./src/"))).toEqual([]);
    expect(relative(PACKAGE_DIR, SRC)).toBe("src");
  });
});
