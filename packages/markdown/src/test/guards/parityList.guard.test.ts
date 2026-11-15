// 三宿主對照測試的「已知差異」清單（packages/frontend/e2e/parity、docs/agents/testing.md）只准減少：
// 它的檔名帶 baseline，所以 scripts/ratchet.mjs 與 ratchet.guard.test.ts 自動管它；這裡確認那個機制真的認得這份檔。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareGroups, jsonGroups, JSON_FILES } from "../../../../../scripts/ratchetLib.mjs";

const FILE = "scripts/parity-known-differences-baseline.json";
const text = readFileSync(join(import.meta.dirname, "../../../../..", FILE), "utf8");

describe("the three-host parity list is watched by the ratchet", () => {
  it("the file is one the ratchet reads, and every entry says where the design is written", () => {
    expect(JSON_FILES.some((re) => re.test(FILE))).toBe(true);
    const { differences } = JSON.parse(text) as { differences: Record<string, { step: string; host: string; reason: string; doc?: string; bug?: boolean }> };
    expect(Object.keys(differences).length).toBeGreaterThan(0);
    for (const [id, d] of Object.entries(differences)) {
      expect(d.step && d.host && d.reason, id).toBeTruthy();
      // 設計差異要指向文件段落；標為 bug 的改寫問題編號或說明。
      expect(d.bug ? d.reason : d.doc, `${id} 缺少依據`).toBeTruthy();
    }
    expect(jsonGroups(FILE, text).get(`${FILE}::differences`)?.size).toBeGreaterThan(0);
  });

  it("a new difference is refused; a removed one and a reworded reason are not", () => {
    const base = jsonGroups(FILE, text);
    const parsed = JSON.parse(text);
    const [firstId] = Object.keys(parsed.differences);
    const withNew = jsonGroups(FILE, JSON.stringify({ differences: { ...parsed.differences, "browser-new-one": { step: "x", host: "browser", paths: ["status"], reason: "r", doc: "d" } } }));
    expect(compareGroups(base, withNew).length).toBeGreaterThan(0);
    const { [firstId!]: _removed, ...rest } = parsed.differences;
    expect(compareGroups(base, jsonGroups(FILE, JSON.stringify({ differences: rest })))).toEqual([]);
    const reworded = { ...parsed.differences, [firstId!]: { ...parsed.differences[firstId!], reason: "改寫過的理由" } };
    expect(compareGroups(base, jsonGroups(FILE, JSON.stringify({ differences: reworded })))).toEqual([]);
  });
});
