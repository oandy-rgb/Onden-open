// Guard: 隨機測試的種子不得寫死（業主 2026-11-18：「種子都隨機」）。
// 掃所有套件的測試檔與 e2e 腳本（語法樹，不比對文字）。固定的種子只准出現在「一定要跑的回歸案例」，
// 那要另外加新的種子（見 docs/agents/testing.md「重現」）。fc.sample 與當測試資料用的固定種子
// （`pdfInkSim({ seed: 21 })` 這種）不是隨機測試，不抓。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PACKAGES, TEST_FILES as FILES } from "./testSources";

const SEED_NAME = /seed$/i;
/** Functions that build a random stream from the number they get. */
const GENERATOR_FACTORY = /^(seeded|random|makeRng|rng|mulberry32)$/;
/** Calls whose options object takes the seed of a randomized run. */
const RUNNER = /^(assert|check|checkAsync|asyncProperty|property)$/;

const isNumber = (node: ts.Node): boolean =>
  ts.isNumericLiteral(node) ||
  (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) ||
  (ts.isParenthesizedExpression(node) && isNumber(node.expression));

/** Does `node` end in a literal number the seed falls back to (`x`, `x ?? 1`, `Number(env ?? 1)`)? */
function literalSeed(node: ts.Node): boolean {
  if (isNumber(node)) return true;
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return literalSeed(node.right);
    return false;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Number") return node.arguments.some(literalSeed);
  if (ts.isParenthesizedExpression(node)) return literalSeed(node.expression);
  return false;
}

const calleeName = (call: ts.CallExpression): string =>
  ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "";

/** Line numbers of seeds fixed in source: a variable, loop counter or runner option named *seed*, or a generator built from a literal. */
export function fixedSeedLines(path: string, text: string): number[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, /\.(mjs|js)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const lines: number[] = [];
  const hit = (node: ts.Node) => lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && SEED_NAME.test(node.name.text) && node.initializer && literalSeed(node.initializer)) hit(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && SEED_NAME.test(node.left.text) && literalSeed(node.right)) hit(node);
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (GENERATOR_FACTORY.test(name) && node.arguments[0] && isNumber(node.arguments[0])) hit(node);
      if (RUNNER.test(name)) {
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue;
          for (const prop of arg.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "seed" && literalSeed(prop.initializer)) hit(prop);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

const UNJUDGED = "尚未判斷是隨機測試（要改成每次新種子）還是固定的測試資料（要改名說明）";

// ratchet:list FIXED_SEED_STILL_OPEN
/** Files that still fix a seed and have not been dealt with: path → why. Only shrinks. */
const FIXED_SEED_STILL_OPEN: Record<string, string> = {
  "backend/src/test/distributedSyncScenarios.test.ts": UNJUDGED,
  "backend/src/test/functionRefsMigration.integration.test.ts": UNJUDGED,
  "backend/src/test/helpers/distSim/realCluster.ts": UNJUDGED,
  "backend/src/test/helpers/pdfInkEnvelope.ts": UNJUDGED,
  "backend/src/test/helpers/stampedBundleWorker.ts": UNJUDGED,
  "backend/src/test/nodeRenewal.integration.test.ts": UNJUDGED,
  "backend/src/test/orderKeyAgreement.integration.test.ts": UNJUDGED,
  "backend/src/test/properties/inkChunks.property.test.ts": UNJUDGED,
  "backend/src/test/stampedMergeAlgebra.test.ts": UNJUDGED,
  "backend/src/test/stampedRows.test.ts": UNJUDGED,
  "frontend/src/test/childOrder.test.ts": UNJUDGED,
  "frontend/src/test/measure/pdfInkSave.measure.test.ts": UNJUDGED,
  "frontend/src/test/pdfInkSaveBudget.test.ts": UNJUDGED,
  "frontend/src/test/pdfPageUnits.test.ts": UNJUDGED,
  "frontend/src/test/textScan.test.ts": UNJUDGED,
  "markdown/src/micromarkLinear.test.ts": UNJUDGED,
  "markdown/src/orderKey.test.ts": UNJUDGED,
  "markdown/src/snippet.test.ts": UNJUDGED,
  "site/src/designHostile.test.ts": UNJUDGED,
  "site/src/palette.test.ts": UNJUDGED,
};

describe("randomized tests take a fresh seed every run", () => {
  it("no test or e2e script fixes a seed in source", () => {
    const found = FILES.filter((p) => !(p in FIXED_SEED_STILL_OPEN)).flatMap((p) =>
      fixedSeedLines(p, readFileSync(join(PACKAGES, p), "utf8")).map((line) => `${p}:${line}`));
    expect(found, "寫死種子：改用 propsConfig 的 PROPS_SEED（e2e 腳本用 `SEED ?? Math.random()` 並印出）；固定案例另列為回歸案例").toEqual([]);
  });

  it("every exception still fixes a seed", () => {
    const stale = Object.keys(FIXED_SEED_STILL_OPEN).filter((p) => !FILES.includes(p) || fixedSeedLines(p, readFileSync(join(PACKAGES, p), "utf8")).length === 0);
    expect(stale, "已經不寫死種子了：從 FIXED_SEED_STILL_OPEN 刪掉").toEqual([]);
  });
});

describe("the detector", () => {
  const lines = (src: string) => fixedSeedLines("x.test.ts", src);
  it("catches the spellings that slipped through the old regex", () => {
    expect(lines("const SEED = Number(process.env.SEED ?? 20261115);")).toEqual([1]);
    expect(lines("const seed = Number(process.env.S ?? PROPS_SEED);\nconst a = 1;")).toEqual([]);
    expect(lines("let seed = 7;")).toEqual([1]);
    expect(lines("for (let seed = 1; seed <= 5; seed++) {}")).toEqual([1]);
    expect(lines("const next = random(20261014);")).toEqual([1]);
    expect(lines("const rnd = seeded(20261116);")).toEqual([1]);
    expect(lines("fc.assert(p, { seed: 20261023, numRuns: 5 });")).toEqual([1]);
    expect(lines("seed = 3;")).toEqual([1]);
  });
  it("leaves fresh seeds, fc.sample and fixed test data alone", () => {
    expect(lines("const SEED = Number(process.env.SEED ?? Math.floor(Math.random() * 1e9));")).toEqual([]);
    expect(lines("fc.sample(arb, { seed: 1, numRuns: 5 });")).toEqual([]);
    expect(lines("const sim = pdfInkSim({ seed: 21 });")).toEqual([]);
    expect(lines("const next = random(PROPS_SEED);")).toEqual([]);
  });
  it("reads .mjs scripts", () => {
    expect(fixedSeedLines("e.mjs", "const SEED = Number(process.env.SEED ?? 5);")).toEqual([1]);
  });
});
