// Guard: 正式出貨套件的安全公告只准減少。邏輯在 scripts/audit.mjs，guard lane 的 `npm run audit:check` 拿真的
// `npm audit` 報告跑；這裡只驗比對本身（不連網）。
import { describe, expect, it } from "vitest";
import { advisories, compare } from "../../../../../scripts/audit.mjs";

const report = {
  vulnerabilities: {
    astro: { via: [{ name: "astro", severity: "critical", title: "XSS", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }] },
    // A package flagged only through another one names it, not an advisory: not counted twice.
    "@astrojs/node": { via: ["astro"] },
    tar: { via: [{ name: "tar", severity: "high", title: "crash", url: "https://github.com/advisories/GHSA-dddd-eeee-ffff" }] },
  },
};

describe("dependency advisories only go down", () => {
  it("reads one entry per advisory, by its GHSA id, most severe first", () => {
    expect([...advisories(report)]).toEqual([
      ["GHSA-aaaa-bbbb-cccc", "critical astro — XSS"],
      ["GHSA-dddd-eeee-ffff", "high tar — crash"],
    ]);
  });

  it("refuses a new advisory and asks for a fixed one to be dropped, even when the count stays the same", () => {
    const { added, gone } = compare(advisories(report), { "GHSA-aaaa-bbbb-cccc": "", "GHSA-zzzz-zzzz-zzzz": "" });
    expect(added.map(([id]) => id)).toEqual(["GHSA-dddd-eeee-ffff"]);
    expect(gone).toEqual(["GHSA-zzzz-zzzz-zzzz"]);
  });
});
