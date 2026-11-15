// 以語法掃描列出一個 TypeScript 檔「自己宣告或轉出」的名稱（不解析 `export *`）。
// 清單守門用它確認 entry 的匯出真的存在，不必載入整個程式。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { repoRoot as root } from "./paths.mjs";

const require = createRequire(join(root, "package.json"));
const ts = require("typescript");

/** @returns {{ values: string[], types: string[], star: string[] }} 值匯出、型別匯出、`export * from` 的來源 */
export function exportsOf(file) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const values = new Set();
  const types = new Set();
  const star = [];
  const hasExport = (n) => n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (n) => n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  for (const st of src.statements) {
    if (ts.isExportDeclaration(st)) {
      if (!st.exportClause) { if (st.moduleSpecifier) star.push(st.moduleSpecifier.text); continue; }
      if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) (st.isTypeOnly || el.isTypeOnly ? types : values).add(el.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(st)) { values.add("default"); continue; }
    if (!hasExport(st)) continue;
    if (isDefault(st)) { values.add("default"); continue; }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) values.add(d.name.text);
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
      types.add(st.name.text);
    } else if (st.name) {
      values.add(st.name.text);
    }
  }
  return { values: [...values], types: [...types], star };
}
