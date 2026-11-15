#!/usr/bin/env node
// 把舊結果裡「這次沒重跑的實作」（通常是很慢的參考實作）併進新結果；同時核對重跑實作的輸出雜湊沒變。
// 用法：node scripts/merge-results.mjs <舊.json> <新.json> <輸出.json> [保留的實作，預設 ref]
import { readFileSync, writeFileSync } from "node:fs";
const [oldF, newF, outF, keep = "ref"] = process.argv.slice(2);
const old = JSON.parse(readFileSync(oldF, "utf8")), nu = JSON.parse(readFileSync(newF, "utf8"));
const keepSet = new Set(keep.split(","));
const key = (r) => `${r.case ?? r.id}|${r.op}|${r.impl}`;
const oldBy = new Map(old.rows.map((r) => [key(r), r]));
let checked = 0, changed = 0;
for (const r of nu.rows) {
  const o = oldBy.get(key(r));
  if (o?.resultHash && r.resultHash) { checked++; if (o.resultHash !== r.resultHash) { changed++; console.log("輸出雜湊改變：", key(r)); } }
  if (o?.hash && r.hash) { checked++; if (o.hash !== r.hash) { changed++; console.log("輸出雜湊改變：", key(r)); } }
}
console.log(`核對 ${checked} 筆輸出雜湊，${changed} 筆不同`);
const keptOld = old.rows.filter((r) => keepSet.has(r.impl) || [...keepSet].some((k) => String(r.impl).includes(k)));
// 舊的 agree 列（含 ref）保留；新跑的 agree 列也保留
const rows = [...nu.rows.filter((r) => !keepSet.has(r.impl)), ...keptOld.filter((r) => !nu.rows.some((n) => key(n) === key(r)))];
writeFileSync(outF, JSON.stringify({ ...nu, rows, mergedFrom: oldF }, null, 1));
console.log(`寫入 ${outF}（${rows.length} 列）`);
