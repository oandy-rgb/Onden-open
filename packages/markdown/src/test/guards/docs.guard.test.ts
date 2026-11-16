// Guard: 文件說的，程式還這樣說嗎：連結、狀態行、程式碼引用、涵蓋、數字（規則：docs/agents/docs-freshness.md）。
// 邏輯在 scripts/check-md-links.mjs，`node scripts/check-md-links.mjs` 跑同一份；檢查器自己的測試在 docsFreshness.guard.test.ts。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("docs", () => {
  it("has no broken links, stale code references, status-line problems, bad 涵蓋 lines or stale numbers", () => {
    const r = spawnSync("node", ["scripts/check-md-links.mjs"], { cwd: root, encoding: "utf8" });
    expect(r.stdout, r.stdout).toMatch(/, 0 broken link\(s\), 0 status line problem\(s\), 0 stale code reference\(s\), 0 coverage problem\(s\), 0 stale number\(s\), 0 exception list problem\(s\)/);
    expect(r.status).toBe(0);
  }, 60_000);
});
