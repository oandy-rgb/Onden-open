// The scheduled run's report (scripts/ciScheduledReport.mjs) must not say false things: a red night is never silent, a
// known E2E red is called removable only when the log shows it passing, the skips a kind never starts are not news, and
// nothing but test names, seeds and the link goes into the comment.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compose, postsToIssue, readJobLog } from "../../../../../scripts/ciScheduledReport.mjs";

const known = { "[chromium] › fullstack/a.spec.ts › old red": "known", "[chromium] › fullstack/b.spec.ts › fixed since": "known" };
const job = (name: string, conclusion: string, databaseId = 1) => ({ name, conclusion, databaseId });
const at = (text: string) => `2026-11-22T10:00:00.0000000Z ${text}`;
const e2eLog = [
  at("  ✓   3 [chromium] › fullstack/b.spec.ts:10:5 › fixed since (2.1s)"),
  at("  1) [chromium] › fullstack/a.spec.ts:4:5 › old red ────────"),
  at("  2) [chromium] › fullstack/c.spec.ts:9:5 › new red (retry #1)"),
].join("\n");
const unitLog = [at("[fuzz] seed=1234 long=false"), at("\x1b[41m FAIL \x1b[49m src/x.fuzz.test.ts > pipeline > keeps text"), at("secret words of a note")].join("\n");
const base = { kind: "daily", sha: "0123456789abcdef", url: "https://example.test/run/1", known };

describe("the scheduled report", () => {
  it("reads failing tests, passing E2E tests and seeds from a job log, whichever way the colour codes come", () => {
    const e2e = readJobLog(e2eLog);
    expect([...e2e.failed]).toEqual(["[chromium] › fullstack/a.spec.ts › old red", "[chromium] › fullstack/c.spec.ts › new red"]);
    expect([...e2e.passed]).toEqual(["[chromium] › fullstack/b.spec.ts › fixed since"]);
    const unit = readJobLog(unitLog.replace(/\x1b/g, "^["));
    expect([...unit.failed]).toEqual(["src/x.fuzz.test.ts › pipeline > keeps text"]);
    expect([...unit.seeds]).toEqual(["FUZZ_SEED=1234"]);
  });

  it("a red night lists the new reds and the seeds, counts the known ones, and never copies other log text", () => {
    const logs: Record<number, string> = { 1: unitLog, 2: e2eLog };
    const text = compose({ ...base, jobs: [job("Scheduled — fuzz · Astro head · parity tool", "failure", 1), job("Full-stack E2E (chromium 1/4)", "failure", 2), job("Scheduled weekly — bench", "skipped", 3)], readLog: (j: { databaseId: number }) => logs[j.databaseId] ?? null });
    expect(text).toContain("`src/x.fuzz.test.ts › pipeline > keeps text`");
    expect(text).toContain("`[chromium] › fullstack/c.spec.ts › new red`");
    expect(text).not.toContain("`[chromium] › fullstack/a.spec.ts › old red`");
    expect(text).toContain("新的紅 1 個；已知的紅 1 個");
    expect(text).toContain("`FUZZ_SEED=1234`");
    expect(text).not.toContain("secret words");
    expect(text).not.toContain("不該略過"); // a weekly job on a daily night is expected to be skipped
  });

  it("a known red is removable only when seen passing; a log that cannot be read is said, not taken as green", () => {
    const noProof = compose({ ...base, jobs: [job("Full-stack E2E (chromium 1/4)", "failure", 2)], readLog: () => null });
    expect(noProof).toContain("紀錄讀不到");
    expect(noProof).not.toContain("可以從已知清單刪掉");
    const withProof = compose({ ...base, jobs: [job("Full-stack E2E (chromium 1/4)", "failure", 2)], readLog: () => e2eLog });
    expect(withProof).toContain("可以從已知清單刪掉的：\n  - `[chromium] › fullstack/b.spec.ts › fixed since`");
    const diedEarly = compose({ ...base, jobs: [job("Full-stack E2E (chromium 1/4)", "failure", 2)], readLog: () => at("docker build failed") });
    expect(diedEarly).not.toContain("可以從已知清單刪掉");
  });

  it("a job the kind should have run but skipped is named; the comment stays under GitHub's limit", () => {
    const text = compose({ ...base, jobs: [job("Scheduled — browser version (…)", "skipped")], readLog: () => null });
    expect(text).toContain("不該略過卻沒有跑的工作：Scheduled — browser version (…)");
    const many = Array.from({ length: 3000 }, (_, i) => at(`  ${i + 1}) [chromium] › fullstack/x${i}.spec.ts:1:1 › ${"long title ".repeat(10)}${i}`)).join("\n");
    const jobs = Array.from({ length: 40 }, (_, i) => job(`Full-stack E2E (${i})`, "failure", i));
    expect(compose({ ...base, jobs, readLog: () => many }).length).toBeLessThanOrEqual(60_100);
  });

  it("names the layout audit's new violations, the pages it could not open and a failed selftest case", () => {
    const log = [
      at("版面檢查：7 個寬度 × 27 個畫面 × 11 條規則，59 筆違規（基準內 16，基準外 43），耗時 598 秒"),
      at("審核本身的問題：canvas @ 900：畫面打不開（locator.waitFor: Timeout 60000ms exceeded.）"),
      at("新違規 R7 note-long @ pixel5"),
      at("  元素：section.note-meta > button.note-history-link 「剛剛修改，打開這篇筆記的歷史」"),
      at("新違規 R7 note-long @ pixel5"),
      at("新違規 R1 split-note-note @ 1920"),
      at("PASS  R6 沒有橫向捲軸（不該報，報了 0 筆）"),
      at("FAIL  R11 並排窗格裡的字超出窗格右緣（被切掉）（應該報，報了 0 筆）"),
    ].join("\n");
    expect([...readJobLog(log).failed]).toEqual([
      "layout-audit › 打不開：canvas @ 900",
      "layout-audit › R7 note-long @ pixel5",
      "layout-audit › R1 split-note-note @ 1920",
      "layout-audit selftest › R11 並排窗格裡的字超出窗格右緣（被切掉）",
    ]);
    const text = compose({ ...base, jobs: [job("Scheduled — browser version (pages)", "failure")], readLog: () => log });
    expect(text).not.toContain("沒有讀到測試名稱");
    expect(text).not.toContain("剛剛修改"); // the element's words stay in the log
  });

  it("names every browser script run-all.mjs marks FAILED, also the ones whose names have spaces", () => {
    const log = [at("chromium       passed"), at("webkit         FAILED"), at("refused save chromium FAILED"), at("dayWalk 1280   FAILED"), at("dayWalk 1280 --prefix /onden/ FAILED"), at("dayWalk tablet-landscape passed")].join("\n");
    expect([...readJobLog(log).failed]).toEqual(["browser-app › webkit", "browser-app › refused save chromium", "browser-app › dayWalk 1280", "browser-app › dayWalk 1280 --prefix /onden/"]);
  });

  it("says which branch ran; only main's report goes to the issue", () => {
    expect(compose({ ...base, branch: "acc-69-webkit", jobs: [], readLog: () => null })).toContain("· acc-69-webkit `0123456789`".slice(0, 26));
    expect(postsToIssue("main")).toBe(true);
    expect(postsToIssue("acc-69-webkit")).toBe(false);
  });

  // The report reads the jobs that have finished when it starts; a job it does not wait for can still be running then
  // and be left out (restore-scripts was, until 2026-11-23). So it waits for every other job in ci.yml.
  it("waits for every other job in ci.yml", () => {
    const yml = readFileSync(join(__dirname, "../../../../../.github/workflows/ci.yml"), "utf8");
    const jobs = yml.slice(yml.indexOf("\njobs:\n")).match(/^ {2}([a-z0-9-]+):$/gm)!.map((l) => l.trim().slice(0, -1));
    const needs = /^ {2}scheduled-report:\n(?:.*\n)*? {4}needs: \[([^\]]*)\]/m.exec(yml)![1].split(",").map((s) => s.trim());
    expect(jobs.length).toBeGreaterThan(10);
    expect(jobs.filter((j) => j !== "scheduled-report" && !needs.includes(j))).toEqual([]);
  });
});
