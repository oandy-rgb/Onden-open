// Guard: 隨機測試怎麼處理「已知問題」只有一種做法（#1881 審查第 6 項）。
// 已知問題＝已經找到、還沒修的缺陷。隨機屬性把它的觸發情境排除，否則每個新種子都會再撞到它、把別人的 PR 弄紅；
// 排除用同一個開關 `INCLUDE_KNOWN`（前端叫 `INCLUDE_KNOWN_CASES`：dup:names 不准兩個套件同名；helpers/propsConfig.ts，`PROPS_INCLUDE_KNOWN=1` 放回），
// 而且排除的那個檔至少有一個 `it.fails` 釘著它：修好時 `it.fails` 變紅，提醒刪掉排除。
// 排除了卻沒有 `it.fails` ＝ 已知問題只剩一句註解，沒人會發現它修好了。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PACKAGES, TEST_FILES } from "./testSources";

const SWITCH_HOME = /^(frontend|backend)\/src\/test\/helpers\/propsConfig\.ts$/;

/** Names read as `process.env.<NAME>` / `process.env["NAME"]` that look like a switch for known cases. */
export function knownSwitchReads(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
    const target = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression.getText(file) : "";
    if (name && target === "process.env" && /KNOWN|INCLUDE_/.test(name)) names.push(name);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** Does the file take the shared switch, and does it pin something with `it.fails`? */
export const usesSharedSwitch = (text: string) => /import\s*\{[^}]*\bINCLUDE_KNOWN(?:_CASES)?\b[^}]*\}\s*from\s*["'][^"']*propsConfig/.test(text);
export const pinsWithItFails = (text: string) =>
  /\bit\.fails\s*\(|\bit\.fails\.each\b/.test(text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n"));

describe("known defects in random tests", () => {
  const read = (p: string) => readFileSync(join(PACKAGES, p), "utf8");

  it("one switch: no test reads its own environment variable for known cases", () => {
    const own = TEST_FILES.filter((p) => !SWITCH_HOME.test(p)).flatMap((p) => knownSwitchReads(p, read(p)).map((n) => `${p}: ${n}`));
    expect(own, "已知問題的開關只有 propsConfig 的 INCLUDE_KNOWN／INCLUDE_KNOWN_CASES（PROPS_INCLUDE_KNOWN=1）").toEqual([]);
  });

  it("a file that leaves a known case out of its random run pins it with an it.fails", () => {
    const unpinned = TEST_FILES.filter((p) => usesSharedSwitch(read(p)) && !pinsWithItFails(read(p)));
    expect(unpinned, "排除已知問題的檔案要有 it.fails（字面反例）；已修好就刪掉排除").toEqual([]);
  });

  it("the shared switch is exported where both packages read it", () => {
    for (const p of ["frontend/src/test/helpers/propsConfig.ts", "backend/src/test/helpers/propsConfig.ts"]) {
      expect(read(p)).toMatch(/export const INCLUDE_KNOWN(?:_CASES)? = process\.env\.PROPS_INCLUDE_KNOWN === "1"/);
    }
  });
});

describe("the detector", () => {
  it("sees a private switch but not the shared one", () => {
    expect(knownSwitchReads("x.ts", 'const A = process.env.REVIEW_PROPS_KNOWN === "1"; const B = process.env["SIM_INCLUDE_KNOWN"];')).toEqual(["REVIEW_PROPS_KNOWN", "SIM_INCLUDE_KNOWN"]);
    expect(knownSwitchReads("x.ts", "const A = process.env.PROPS_RUNS;")).toEqual([]);
  });
  it("tells a file that pins from one that does not", () => {
    expect(usesSharedSwitch('import { INCLUDE_KNOWN, PROPS_RUNS } from "../helpers/propsConfig.js";')).toBe(true);
    expect(usesSharedSwitch('import { PROPS_RUNS } from "../helpers/propsConfig.js";')).toBe(false);
    expect(pinsWithItFails('it.fails("x", async () => {});')).toBe(true);
    expect(pinsWithItFails("// it.fails when the fix lands")).toBe(false);
  });
});
