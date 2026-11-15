// 合併結果比較：npm run bench:compare
// 手寫例子逐個列出 diff3 與 Eg-walker 的結果；合成情境統計「diff3 假衝突」「同一句重疊」等。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { threeWayMergeBody } from "../../../../../packages/backend/src/services/eventLog/bodyMerge.js";
import { DEFAULT_OPTS, buildOpLog, makeBranch, mergeIntoBranch } from "./proto/engine.js";
import { compareSites, overlapSentences, touchSets, type SiteReport } from "./analysis.js";
import { EXAMPLES, exampleTexts } from "./examples.js";
import { EDIT_COUNTS, SIZES, makeFork } from "./genFork.js";
import type { ForkScenario } from "./types.js";
import { SEED } from "./cases.js";

const outFile = join(dirname(fileURLToPath(import.meta.url)), "..", "out", "compare.json");

function runOne(base: string, a: string, b: string, hist: ForkScenario["history"], rangeA: [number, number], rangeB: [number, number]) {
  const d3 = threeWayMergeBody(base, b, a);
  const log = buildOpLog(hist);
  const br = makeBranch(a, [rangeA[1] - 1]);
  const info = mergeIntoBranch(br, log, undefined, DEFAULT_OPTS, true);
  const egw = br.text.toString();
  const [ta, tb] = touchSets(info.ctx!, rangeA, rangeB);
  return { d3, egw, ta, tb, overlap: overlapSentences(base, ta, tb) };
}

const examples = EXAMPLES.map((ex) => {
  const t = exampleTexts(ex);
  const r = runOne(ex.base, t.a, t.b, t.history, t.rangeA, t.rangeB);
  const show = (s: string) => s.replace(/\n/g, "⏎");
  console.log(`\n${ex.id} ${ex.title}`);
  console.log(`  base  ${show(ex.base)}`);
  console.log(`  A     ${show(t.a)}`);
  console.log(`  B     ${show(t.b)}`);
  console.log(`  diff3 ${r.d3.clean ? "乾淨" : `衝突 ${r.d3.conflicts.length} 處`}  ${show(r.d3.merged)}`);
  console.log(`  EGW   ${show(r.egw)}`);
  console.log(`  同一句重疊：${r.overlap.length} 句 ${r.overlap.length ? "→ 依規則應衝突" : "→ 可乾淨合"}`);
  return {
    id: ex.id, title: ex.title, base: ex.base, a: t.a, b: t.b,
    diff3: { clean: r.d3.clean, conflicts: r.d3.conflicts.length, merged: r.d3.merged },
    egw: r.egw, overlapSentences: r.overlap.length,
  };
});

interface Agg extends SiteReport { scenarios: number; equalWhenSafe: number; safeCases: number; edits: number }
const stats: Record<string, Agg> = {};
const SEEDS = 5;
for (const size of SIZES) for (const edits of EDIT_COUNTS) {
  const key = `${Math.round(size / 1024)}KB-${edits}`;
  const agg: Agg = { overlapSentences: 0, diff3Conflicts: 0, diff3FalseConflicts: 0, diff3PointConflicts: 0, overlapNotFlaggedByDiff3: 0, scenarios: 0, equalWhenSafe: 0, safeCases: 0, edits };
  for (let k = 0; k < SEEDS; k++) {
    const sc = makeFork(size, edits, SEED + k);
    const r = runOne(sc.base, sc.textA, sc.textB, sc.history, sc.rangeA, sc.rangeB);
    const rep = compareSites(sc.base, r.ta, r.tb, r.d3.conflicts);
    for (const f of Object.keys(rep) as Array<keyof SiteReport>) agg[f] += rep[f];
    agg.scenarios++;
    if (r.d3.clean && rep.overlapSentences === 0) { agg.safeCases++; if (r.d3.merged === r.egw) agg.equalWhenSafe++; }
  }
  stats[key] = agg;
  console.log(key, JSON.stringify(agg));
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ examples, stats, seeds: SEEDS }, null, 1));
console.log("寫入", outFile);
