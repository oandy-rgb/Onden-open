// 原型的優化各貢獻多少：npm run bench:ablation
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measure, type Stats } from "./harness.js";
import { SEED } from "./cases.js";
import { makeFork } from "./genFork.js";
import { TRACE_LIST, loadTrace } from "./traces.js";
import { buildOpLog, makeBranch, mergeIntoBranch, replay, type EngineOpts } from "./proto/engine.js";

const outFile = join(dirname(fileURLToPath(import.meta.url)), "..", "out", "ablation.json");
const gc = (globalThis as { gc?: () => void }).gc;

const VARIANTS: Array<[string, EngineOpts]> = [
  ["V0 無優化（等同參考實作的結構）", { rle: false, chunkMax: Infinity, skipLinear: false }],
  ["V1 ＋run-length", { rle: true, chunkMax: Infinity, skipLinear: false }],
  ["V2 ＋分段陣列", { rle: true, chunkMax: 64, skipLinear: false }],
  ["V3 ＋跳過線性歷史（完整原型）", { rle: true, chunkMax: 64, skipLinear: true }],
];

const rows: Array<{ case: string; op: string; variant: string; stats?: Stats; skipped?: string }> = [];
const log = (c: string, op: string, v: string, s?: Stats, skipped?: string) => {
  rows.push({ case: c, op, variant: v, stats: s, skipped });
  console.log(`${c} ${op} ${v}: ${s ? `中位數 ${s.medianMs.toFixed(2)} ms p95 ${s.p95Ms.toFixed(2)} ms n=${s.n}` : "跳過 " + skipped}`);
};

for (const [size, edits] of [[200, 100], [200, 1000], [50, 1000]] as const) {
  const sc = makeFork(size * 1024, edits, SEED);
  for (const [name, o] of VARIANTS) {
    const l = buildOpLog(sc.history, o.rle);
    const a = measure(() => { const br = makeBranch(sc.textA, [sc.rangeA[1] - 1]); return () => { mergeIntoBranch(br, l, undefined, o); return br.text.toString(); }; }, { gc });
    log(sc.id, "a", name, a.stats);
    const b = measure(() => () => replay(l, o), { gc });
    log(sc.id, "b", name, b.stats);
  }
}
for (const id of ["friendsforever", "clownschool", "git-makefile", "node_nodecc", "automerge-paper"]) {
  const tr = loadTrace(id);
  for (const [name, o] of VARIANTS) {
    if (!["friendsforever", "clownschool"].includes(id) && o.chunkMax === Infinity) { log(id, "b", name, undefined, "單一陣列對數十萬操作是 O(n²)，未跑"); continue; }
    const l = buildOpLog(tr.history, o.rle);
    const r = measure(() => () => replay(l, o), { gc, budgetMs: 3000, minIters: 5 });
    log(id, "b", name, r.stats);
  }
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(rows, null, 1));
console.log("寫入", outFile);
