// 失敗原因與錨點整條鏈（從起始版本到最後一版）的結果；並印出典型例子。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadHistories, OUT } from "./history.ts";
import { classify, type Cls } from "./lib.ts";
import type { Rec } from "./run-history.ts";
const recs: Rec[] = JSON.parse(readFileSync(join(OUT, "history-records.json"), "utf8"));
const hist = new Map(loadHistories(30).map((h) => [h.path, h]));
const M = ["M1a", "M1b", "M2", "M3"] as const;
const chains = new Map<string, Rec[]>();
for (const r of recs) { const k = `${r.file}|${r.start}|${r.anchor}`; (chains.get(k) ?? chains.set(k, []).get(k)!).push(r); }
console.log("鏈數", chains.size, "（單段", [...chains.values()].filter((c) => c[0]!.kind === "single").length, "／範圍", [...chains.values()].filter((c) => c[0]!.kind === "range").length, "）");
const clip = (s: string, n = 110) => { const t = s.replace(/\n/g, "⏎"); return t.length <= n ? t : t.slice(0, n / 2) + "…" + t.slice(-n / 2); };
console.log("\n## 整條鏈：從不指錯 / 曾指錯 / 最後一步結果");
for (const kind of ["single", "range"] as const) for (const m of M) {
  let never = 0, ever = 0, n = 0; const fin: Record<string, number> = { correct: 0, lost: 0, wrong: 0 };
  for (const c of chains.values()) if (c[0]!.kind === kind) {
    n++; const cls = c.map((r) => classify(r.res[m], r.oracle));
    cls.some((x) => x.startsWith("wrong")) ? ever++ : never++;
    const l = cls[cls.length - 1]!; fin[l.startsWith("wrong") ? "wrong" : l]++;
  }
  console.log(`${kind} ${m}: 鏈 ${n}，全程沒指錯 ${never}，曾指錯 ${ever}；最後一步 指對 ${fin.correct} 指錯 ${fin.wrong} 找不到 ${fin.lost}`);
}
console.log("\n## 首次丟失時，該段當步是否被修改觸及（oracle 仍認為存在的鏈）");
for (const m of M) {
  let touched = 0, untouched = 0;
  for (const c of chains.values()) { for (const r of c) { if (r.res[m] === null && r.oracle) { r.touched ? touched++ : untouched++; break; } if (classify(r.res[m], r.oracle) === "lost") break; } }
  console.log(`${m}: 丟失當步有被修改 ${touched}，沒被修改 ${untouched}`);
}
console.log("\n## 文內記號被合併弄壞內文（清掉記號後與真實下一版不同）的步驟數");
for (const k of ["M1a", "M1b"] as const) console.log(k, recs.filter((r) => r.mergeBroken[k]).length, "/", recs.length);
console.log("\n## 指錯類型（步驟數）");
for (const m of M) { const t: Record<string, number> = {}; for (const r of recs) { const c = classify(r.res[m], r.oracle); if (c.startsWith("wrong")) t[c] = (t[c] ?? 0) + 1; } console.log(m, JSON.stringify(t)); }
console.log("\n## 典型例子（每種做法最多 3 個指錯）");
for (const m of M) {
  let shown = 0;
  for (const r of recs) {
    const c = classify(r.res[m], r.oracle);
    if (c !== (process.env.CLS ?? "wrong-partial-over") || !r.res[m]) continue;
    const h = hist.get(r.file)!; const next = h.versions[r.step]!.text; const prev = h.versions[r.step - 1]!.text;
    const txt = prev + next; if (/Anthropic|OpenAI|anthropic\.com/.test(txt.slice(r.prevOracle?.from ?? 0, r.prevOracle?.to ?? 0) + next.slice(r.res[m]!.from, r.res[m]!.to))) continue;
    console.log(`\n[${m}] ${r.file} ${c}\n  舊：${clip(prev.slice(r.prevOracle!.from, r.prevOracle!.to))}\n  答案：${(r.oracle ? clip(next.slice(r.oracle.from, r.oracle.to)) : "（已不存在）")}\n  做法：${clip(next.slice(r.res[m]!.from, r.res[m]!.to))}`);
    if (++shown >= 5) break;
  }
}
