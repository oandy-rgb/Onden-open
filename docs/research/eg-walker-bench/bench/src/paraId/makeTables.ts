// out/paraid-*.json → out/paraid-tables.md（報告用的表）。npx tsx src/paraId/makeTables.ts
import { readFileSync, writeFileSync } from "node:fs";
import type { Summary } from "./evaluate.js";

const rd = (f: string) => JSON.parse(readFileSync(`out/${f}`, "utf8"));
const ms = (x: number) => (x < 1 ? x.toFixed(3) : x < 100 ? x.toFixed(1) : x.toFixed(0));
const lines: string[] = ["# 認段落身分的合併原型：量測表格", "", "> 狀態：現行（由 makeTables.ts 從 paraid-*.json 產生，不手改）（最後確認 2026-11-15）。說明見 [報告](../../../body-merge-measurements-2026-11-15.md)。", ""];
const L = (s = "") => lines.push(s);

for (const mode of ["block", "line"] as const) {
  const a = rd(`paraid-a-${mode}.json`) as { seeds: number; sets: Record<string, Summary> };
  L(`### (a) 既有產生器，單位＝${mode === "block" ? "段落（空行分隔的區塊）" : "行（每行一段）"}，每格 ${a.seeds} 個種子`);
  L();
  L("| 情境 | 合併數 | 現行：有衝突的合併／衝突區 | 原型：有衝突的合併／衝突區 | 現行的衝突區被原型解掉（其中驗證發現掉字） | 原型新增的衝突區 | 現行 ms（中位數） | 原型 ms（中位數） | 錯誤 現行／原型 |");
  L("|---|---|---|---|---|---|---|---|---|");
  for (const [k, s] of Object.entries(a.sets)) {
    if (k === "__all") continue;
    L(`| ${k} | ${s.merges} | ${s.curConflict}／${s.curRegions} | ${s.proConflict}／${s.proRegions} | ${s.regionsRemoved}（${s.curRegions ? Math.round((100 * s.regionsRemoved) / s.curRegions) : 0}%；掉字 ${s.regionsRemovedBad}） | ${s.regionsAdded} | ${ms(s.curMsMedian)} | ${ms(s.proMsMedian)} | ${s.curWrong}／${s.proWrong} |`);
  }
  const t = a.sets.__all!;
  L(`| **合計** | ${t.merges} | ${t.curConflict}／${t.curRegions} | ${t.proConflict}／${t.proRegions} | **${t.regionsRemoved}（${Math.round((1000 * t.regionsRemoved) / t.curRegions) / 10}%；掉字 ${t.regionsRemovedBad}）** | ${t.regionsAdded} | ${ms(t.curMsMedian)} | ${ms(t.proMsMedian)} | ${t.curWrong}／${t.proWrong} |`);
  L();
}

const b = rd("paraid-b.json") as { n: number; kinds: Record<string, Summary> };
L(`### (b) 專挑認段落身分想解的情境，每種 ${b.n} 筆`);
L();
L("「理想」＝依業主規則該有的結果（該乾淨合就要乾淨且文字完全正確；該衝突就要判衝突）。");
L();
L("| 情境 | 現行判衝突 | 原型判衝突 | 理想達成 現行 | 理想達成 原型 | 理想達成 小版本 | 現行錯誤 | 原型錯誤 | 現行乾淨但原型衝突 | 現行 ms | 原型 ms |");
L("|---|---|---|---|---|---|---|---|---|---|---|");
for (const [k, s] of Object.entries(b.kinds)) {
  if (k === "__all") continue;
  L(`| ${k} | ${s.curConflict} | ${s.proConflict} | ${s.curIdeal} | ${s.proIdeal} | ${s.hybIdeal} | ${s.curWrong} | ${s.proWrong} | ${s.newlyConflict} | ${ms(s.curMsMedian)} | ${ms(s.proMsMedian)} |`);
}
const bt = b.kinds.__all!;
L(`| **合計** | ${bt.curConflict}／${bt.merges} | ${bt.proConflict} | ${bt.curIdeal} | ${bt.proIdeal} | ${bt.hybIdeal} | ${bt.curWrong} | ${bt.proWrong} | ${bt.newlyConflict} | ${ms(bt.curMsMedian)} | ${ms(bt.proMsMedian)} |`);
L();

const c = rd("paraid-c.json") as { sets: Record<string, Summary>; examples: Record<string, unknown[]> };
L("### (c) 既有測試的每一個 threeWayMergeBody 呼叫");
L();
L("| 來源 | 合併數 | 現行衝突 | 原型衝突 | 小版本衝突 | 原型乾淨、現行衝突 | 現行乾淨、原型衝突 | 兩邊都乾淨但結果不同（好／壞／待議／只差空行） | 錯誤 現行／原型／小版本 | 現行 ms | 原型 ms |");
L("|---|---|---|---|---|---|---|---|---|---|---|");
for (const [k, s] of Object.entries(c.sets)) {
  if (k === "__all") continue;
  L(`| ${k} | ${s.merges} | ${s.curConflict} | ${s.proConflict} | ${s.hybConflict} | ${s.newlyClean} | ${s.newlyConflict} | ${s.differentClean}（${s.better}／${s.worse}／${s.arguable}／${s.ws}） | ${s.curWrong}／${s.proWrong}／${s.hybWrong} | ${ms(s.curMsMedian)} | ${ms(s.proMsMedian)} |`);
}
const ct = c.sets.__all!;
L(`| **合計** | ${ct.merges} | ${ct.curConflict} | ${ct.proConflict} | ${ct.hybConflict} | ${ct.newlyClean} | ${ct.newlyConflict} | ${ct.differentClean}（${ct.better}／${ct.worse}／${ct.arguable}／${ct.ws}） | ${ct.curWrong}／${ct.proWrong}／${ct.hybWrong} | ${ms(ct.curMsMedian)} | ${ms(ct.proMsMedian)} |`);
writeFileSync("out/paraid-tables.md", lines.join("\n") + "\n");
console.log("out/paraid-tables.md", lines.length, "行");
