// Guard: 文件內部連結不能壞；docs/research 與 docs/architecture 的文件須有狀態行。
// 邏輯在 scripts/check-md-links.mjs，`node scripts/check-md-links.mjs` 跑同一份。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("docs", () => {
  it("has no broken relative links and every research/architecture doc has a status line", () => {
    const r = spawnSync("node", ["scripts/check-md-links.mjs"], { cwd: root, encoding: "utf8" });
    expect(r.stdout, r.stdout).toMatch(/0 broken link\(s\), 0 missing status line\(s\)/);
    expect(r.status).toBe(0);
  }, 60_000);
});
