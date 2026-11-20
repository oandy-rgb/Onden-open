#!/usr/bin/env node
// 相依套件的安全公告只准減少：把 `npm audit --omit=dev`（正式出貨的套件）找到的公告，和 scripts/audit-baseline.json
// 列的公告比對（業主 2026-11-20：「要自動更新 寫對應守門」）。
//   npm run audit:check            多了基準檔沒有的公告 → 1；基準檔列著、已經不存在的公告 → 1（請刪掉，讓基準往下走）
//   npm run audit:check -- --write 依現況重寫基準檔（只刪不加：加新公告會被 ratchet 擋下，除非 commit 有 ratchet-override）
// 以公告編號（GHSA）比對而不是數量：修掉一個、同時多一個，數量不變，但這裡會擋。
// 新公告是外面公布的，不是這次改動造成的，所以它可能讓不相干的 PR 變紅：那就是要先處理它（升級，或由業主在 commit
// 寫 ratchet-override 暫時收下）。Dependabot（.github/dependabot.yml）每週開升級 PR。
// 查不到公告資料庫（離線、npm 出錯）時以 2 結束並說明，不當作通過。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), "audit-baseline.json");
const ORDER = ["critical", "high", "moderate", "low", "info"];

/** npm audit 的報告 → Map(GHSA 編號 → 「嚴重度 套件 — 標題」)。 */
export function advisories(report) {
  const found = new Map();
  for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || !via.url) continue;
      const id = /GHSA-[\w-]+/.exec(via.url)?.[0] ?? via.url;
      if (!found.has(id)) found.set(id, `${via.severity} ${via.name ?? name} — ${via.title}`);
    }
  }
  return new Map([...found].sort(([a, x], [b, y]) => ORDER.indexOf(x.split(" ")[0]) - ORDER.indexOf(y.split(" ")[0]) || a.localeCompare(b)));
}

/** 現況和基準比：多出來的（擋）、已經消失的（請刪）。 */
export function compare(actual, baseline) {
  return {
    added: [...actual].filter(([id]) => !(id in baseline)),
    gone: Object.keys(baseline).filter((id) => !actual.has(id)),
  };
}

function runAudit() {
  let out;
  try {
    out = execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = e.stdout; // 有公告時 npm audit 以非 0 結束，報告照樣在 stdout
  }
  const report = JSON.parse(out || "{}");
  if (report.error || !report.metadata) throw new Error(report.error?.summary ?? "npm audit 沒有回報告");
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let actual;
  try {
    actual = advisories(runAudit());
  } catch (e) {
    console.error(`audit:check 查不到公告資料庫：${e.message}`);
    process.exit(2);
  }
  if (process.argv.includes("--write")) {
    writeFileSync(BASELINE, JSON.stringify({ advisories: Object.fromEntries(actual) }, null, 2) + "\n");
    console.log(`audit-baseline.json 已寫入 ${actual.size} 則公告。`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")).advisories;
  const { added, gone } = compare(actual, baseline);
  if (added.length === 0 && gone.length === 0) {
    console.log(`audit:check 通過：${actual.size} 則公告，都已列在基準檔。`);
    process.exit(0);
  }
  if (added.length) {
    console.error(`正式出貨的套件多了 ${added.length} 則安全公告（npm audit --omit=dev）：`);
    for (const [id, what] of added) console.error(`  ${id}  ${what}`);
    console.error("請升級修掉；真的暫時修不了，由業主同意後在 commit 寫 `ratchet-override: <原因>`，再跑 npm run audit:check -- --write。");
  }
  if (gone.length) {
    console.error(`基準檔還列著 ${gone.length} 則已經不存在的公告，請跑 npm run audit:check -- --write 把它們刪掉：`);
    for (const id of gone) console.error(`  ${id}`);
  }
  process.exit(1);
}
