// (c) 既有測試的每一個 threeWayMergeBody 呼叫（由 record/ 的 vitest 設定錄下來）：
//   npx tsx src/paraId/runC.ts <錄下來的 jsonl>...
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { classify, runBoth, summarize, show, type Case, type Row } from "./evaluate.js";

const files = process.argv.slice(2);
const groups: Record<string, { cases: Case[]; rows: Row[]; ex: Array<Record<string, unknown>> }> = {};
const group = (f: string) => f.startsWith("test/properties/") ? "性質測試 " + f.split("/").pop()!.replace(".property.test.ts", "") : f.includes("syncSimulator") ? "同步模擬器" : "單元測試 " + f.split("/").pop()!.replace(".test.ts", "").replace(".integration", "");
for (const file of files) for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(line) as { file: string; base: string; incoming: string; current: string };
  const g = (groups[group(r.file)] ??= { cases: [], rows: [], ex: [] });
  g.cases.push({ id: `${r.file}#${g.cases.length}`, base: r.base, incoming: r.incoming, current: r.current, tag: group(r.file) });
}
const out: Record<string, unknown> = {};
const all: Row[] = [];
const examples: Record<string, unknown[]> = {};
for (const [name, g] of Object.entries(groups)) {
  for (const c of g.cases) {
    // 這些測試的輸入有的相同（現行合併直接回傳一邊）；仍一併計入，因為它們是既有的保證
    const r = runBoth(c);
    const row = classify(c, r);
    g.rows.push(row);
    const interesting = row.newlyClean ? "newlyClean" : row.newlyConflict ? "newlyConflict" : row.diff && row.diff !== "ws" ? "diff-" + row.diff : row.proWrong && !row.curWrong ? "proWrong" : null;
    if (interesting) (examples[`${name}|${interesting}`] ??= []).push({ base: show(c.base, 160), incoming: show(c.incoming, 160), current: show(c.current, 160), cur: r.cur.clean ? show(r.cur.merged, 160) : `衝突 ${r.cur.conflicts}`, pro: r.pro.clean ? show(r.pro.merged, 160) : `衝突 ${r.pro.kinds}`, problems: r.pro.problems });
  }
  all.push(...g.rows);
  const s = summarize(g.rows);
  out[name] = s;
  console.log(name.padEnd(46), `合併 ${s.merges}  現行衝突 ${s.curConflict}  原型衝突 ${s.proConflict}  小版衝突 ${s.hybConflict}  原型乾淨/現行衝突 ${s.newlyClean}  現行乾淨/原型衝突 ${s.newlyConflict}  不同乾淨 ${s.differentClean}(好${s.better}/壞${s.worse}/待議${s.arguable}/空白${s.ws})  錯誤 現行${s.curWrong} 原型${s.proWrong}  ms ${s.curMsMedian.toFixed(3)}/${s.proMsMedian.toFixed(3)}`);
}
out.__all = summarize(all);
console.log("總計", JSON.stringify(out.__all));
mkdirSync("out", { recursive: true });
writeFileSync("out/paraid-c.json", JSON.stringify({ sets: out, examples: Object.fromEntries(Object.entries(examples).map(([k, v]) => [k, v.slice(0, 8).concat([{ total: v.length }])])) }, null, 1));
