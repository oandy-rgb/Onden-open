// 測試輔助只准一個入口（docs/research/dup-patterns-2026-10-30-render.md T1、T5、S3）。
// 允許清單：這些事只有主人檔案能做，其他 e2e 檔案出現就失敗。
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "../../../../../scripts/lib/paths.mjs";
import { TEST_HELPER_DIRS } from "../../../../../scripts/dupLib.mjs";

const E2E = join(repoRoot, "packages/frontend/e2e/fullstack");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : tsFiles(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}
const e2eFiles = tsFiles(E2E).map((path) => ({ file: relative(E2E, path), text: readFileSync(path, "utf8") }));

/** e2e 檔案（不含 owners）中符合 pattern 的 `file:line`。 */
function outside(pattern: RegExp, owners: readonly string[]): string[] {
  return e2eFiles
    .filter((f) => !owners.includes(f.file))
    .flatMap((f) => f.text.split("\n").flatMap((line, i) => (pattern.test(line) ? [`${f.file}:${i + 1}`] : [])));
}

// 例外（附原因）；只准減少。
const E2E_BASE_OWNERS = [
  "helpers.ts", // 唯一定義 BASE／H
  "global-setup.ts", // 在 spec 之前跑，不能 import 帶 playwright test 的 helpers
] as const;
const E2E_BASE_PATTERN = /process\.env\.E2E_BASE|^const (?:BASE|H)\s*=/;
const PSQL_PATTERN = /\bpsql\b.*\s-U\s|"psql"/;

describe("e2e 測試輔助只有一個入口", () => {
  it("E2E_BASE 與 BASE／H 只在 helpers.ts（與 global-setup.ts）定義", () => {
    expect(outside(E2E_BASE_PATTERN, E2E_BASE_OWNERS)).toEqual([]);
  });

  it("直接對 e2e 資料庫下 SQL 只走 helpers.ts 的 psql()", () => {
    expect(outside(PSQL_PATTERN, ["helpers.ts"])).toEqual([]);
  });

  it("守門自我驗證：違規寫法會被抓到", () => {
    expect(E2E_BASE_PATTERN.test('const BASE = process.env.E2E_BASE || "http://localhost:5099";')).toBe(true);
    expect(E2E_BASE_PATTERN.test('const H = { headers: { origin: BASE } };')).toBe(true);
    expect(E2E_BASE_PATTERN.test("  const horizon = 1;")).toBe(false);
    expect(PSQL_PATTERN.test('execFileSync("docker", ["exec", c, "psql", "-U", "onden"])')).toBe(true);
    expect(PSQL_PATTERN.test("const db = psql;")).toBe(false);
  });
});

describe("dup:names 也掃測試輔助", () => {
  it("掃描範圍包含後端、前端、e2e 的輔助資料夾，且都存在", () => {
    expect(TEST_HELPER_DIRS).toEqual(expect.arrayContaining([
      "packages/backend/src/test/helpers",
      "packages/frontend/src/test",
      "packages/frontend/e2e",
    ]));
    for (const dir of TEST_HELPER_DIRS) expect(existsSync(join(repoRoot, dir)), dir).toBe(true);
  });
});
