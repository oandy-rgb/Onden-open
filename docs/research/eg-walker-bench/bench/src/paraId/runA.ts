// (a) 既有產生器 genFork.ts（和報告同一組種子 SEED+0..4）：npx tsx src/paraId/runA.ts [種子數]
import { writeFileSync, mkdirSync } from "node:fs";
import { SEED } from "../cases.js";
import { EDIT_COUNTS, SIZES, makeFork } from "../genFork.js";
import { classify, runBoth, summarize, excerptDiff, type Case, type Row } from "./evaluate.js";

const SEEDS = Number(process.argv[2] ?? 5);
const MODE = (process.argv[3] ?? "block") as "block" | "line";
const out: Record<string, unknown> = {};
const all: Row[] = [];
const examples: unknown[] = [];
for (const size of SIZES) for (const edits of EDIT_COUNTS) {
  const key = `${Math.round(size / 1024)}KB-${edits}`;
  const rows: Row[] = [];
  for (let k = 0; k < SEEDS; k++) {
    const sc = makeFork(size, edits, SEED + k);
    const c: Case = { id: `${key}#${k}`, base: sc.base, incoming: sc.textB, current: sc.textA, tag: key };
    const r = runBoth(c, MODE);
    const row = classify(c, r);
    rows.push(row);
    if (row.newlyClean && examples.length < 400) {
      // 例子：現行衝突、原型乾淨的第一個區域附近
      examples.push({ id: c.id, kinds: r.pro.kinds, base: c.base.length });
    }
  }
  all.push(...rows);
  const s = summarize(rows);
  out[key] = s;
  console.log(key.padEnd(10), `合併 ${s.merges}  現行衝突 ${s.curConflict}（${s.curRegions} 區）  原型衝突 ${s.proConflict}（${s.proRegions} 區，現行區被解掉 ${s.regionsRemoved}（其中驗證掉字 ${s.regionsRemovedBad}）、新增 ${s.regionsAdded}）  小版 ${s.hybConflict}（${s.hybRegions} 區）  原型乾淨/現行衝突 ${s.newlyClean}  現行乾淨/原型衝突 ${s.newlyConflict}  不同乾淨 ${s.differentClean}(好${s.better}/壞${s.worse}/待議${s.arguable}/空白${s.ws})  錯誤 現行${s.curWrong} 原型${s.proWrong} 小版${s.hybWrong}  fallback ${s.fellBack}  ms 現行 ${s.curMsMedian.toFixed(2)} 原型 ${s.proMsMedian.toFixed(2)} 小版 ${s.hybMsMedian.toFixed(2)}`);
}
out.__all = summarize(all);
console.log("總計", JSON.stringify(out.__all));
mkdirSync("out", { recursive: true });
writeFileSync(`out/paraid-a-${MODE}.json`, JSON.stringify({ seeds: SEEDS, sets: out }, null, 1));
void excerptDiff;
