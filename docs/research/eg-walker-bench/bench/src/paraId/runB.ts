// (b) 專挑認段落身分想解的情境：npx tsx src/paraId/runB.ts [每種情境筆數]
import { writeFileSync, mkdirSync } from "node:fs";
import { classify, runBoth, summarize, show, excerptDiff, type Case, type Row } from "./evaluate.js";
import { KIND_NAMES, genScenario } from "./scenarios.js";

const N = Number(process.argv[2] ?? 200);
const out: Record<string, unknown> = {};
const all: Row[] = [];
const examples: Record<string, unknown[]> = {};
for (const kind of KIND_NAMES) {
  const rows: Row[] = [];
  for (let seed = 1; seed <= N; seed++) {
    const s = genScenario(kind, seed);
    const c: Case = { id: `${kind}#${seed}`, base: s.base, incoming: s.incoming, current: s.current, tag: kind, expect: { kind: s.expect, text: s.expected } };
    const r = runBoth(c);
    const row = classify(c, r);
    rows.push(row);
    if ((row.newlyClean || row.diff || row.proWrong || row.newlyConflict) && (examples[kind] ??= []).length < 3)
      examples[kind]!.push({ id: c.id, cur: r.cur.clean ? excerptDiff(c.base, r.cur.merged) : "衝突", pro: r.pro.clean ? excerptDiff(c.base, r.pro.merged) : `衝突 ${r.pro.kinds}`, expected: s.expected ? excerptDiff(c.base, s.expected) : null, diff: row.diff, proWrong: row.proWrong, problems: r.pro.problems });
  }
  all.push(...rows);
  out[kind] = summarize(rows);
  const s = out[kind] as ReturnType<typeof summarize>;
  console.log(kind.padEnd(38), `現行衝突 ${s.curConflict}/${s.merges}  原型衝突 ${s.proConflict}  理想達成 現行 ${s.curIdeal} 原型 ${s.proIdeal} 小版 ${s.hybIdeal}(衝突${s.hybConflict})  不同乾淨 ${s.differentClean}(好${s.better}/壞${s.worse}/待議${s.arguable}/空白${s.ws})  錯誤 現行${s.curWrong} 原型${s.proWrong}  新衝突 ${s.newlyConflict}  ms ${s.curMsMedian.toFixed(3)}/${s.proMsMedian.toFixed(3)}`);
}
out.__all = summarize(all);
console.log("總計", JSON.stringify(out.__all));
mkdirSync("out", { recursive: true });
writeFileSync("out/paraid-b.json", JSON.stringify({ n: N, kinds: out, examples }, null, 1));
