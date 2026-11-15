// 讀 out/history-records.json 與合成情境，輸出報告用的表格（markdown）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./history.ts";
import { classify, GONE_CUT, type Cls } from "./lib.ts";
import { runSynthetic } from "./run-synthetic.ts";
import type { Rec } from "./run-history.ts";

export const METHODS = ["M1a", "M1b", "M2", "M3"] as const;
export const NAMES: Record<string, string> = { M1a: "M1a 行尾 ` ^id`", M1b: "M1b 下一行註解", M2: "M2 伺服器差異搬移", M3: "M3 編輯器精確＋補救" };
type Tally = Record<Cls, number> & { n: number };
const zero = (): Tally => ({ n: 0, correct: 0, lost: 0, "wrong-elsewhere": 0, "wrong-partial-over": 0, "wrong-partial-under": 0 });
const pct = (a: number, n: number) => (n ? `${((100 * a) / n).toFixed(1)}%` : "—");
export const wrongOf = (t: Tally) => t["wrong-elsewhere"] + t["wrong-partial-over"] + t["wrong-partial-under"];
export const cell = (t: Tally) => `${t.correct}（${pct(t.correct, t.n)}）／${wrongOf(t)}（${pct(wrongOf(t), t.n)}）／${t.lost}（${pct(t.lost, t.n)}）`;

export function tally(recs: Rec[], pick: (r: Rec) => boolean, m: (typeof METHODS)[number], truthOf = (r: Rec) => r.oracle): Tally {
  const t = zero();
  for (const r of recs) if (pick(r)) { t[classify(r.res[m], truthOf(r))]++; t.n++; }
  return t;
}
/** 參考答案換一個「已不存在」的存活門檻時，用 frac 重算（frac 是原字元存活比例）。 */
export function truthWithCut(cut: number) { return (r: Rec) => (r.frac < cut ? null : r.oracle); }

if (process.argv[1]?.endsWith("summarize.ts")) {
  const recs: Rec[] = JSON.parse(readFileSync(join(OUT, "history-records.json"), "utf8"));
  const lines: string[] = [];
  const row = (name: string, pick: (r: Rec) => boolean) => lines.push(`| ${name} | ${recs.filter(pick).length} | ${METHODS.map((m) => cell(tally(recs, pick, m))).join(" | ")} |`);
  lines.push("| 範圍 | 樣本 | " + METHODS.map((m) => NAMES[m]).join(" | ") + " |", "|---|---|---|---|---|---|");
  for (const [kn, kp] of [["單段", (r: Rec) => r.kind === "single"], ["範圍", (r: Rec) => r.kind === "range"]] as const) {
    row(`${kn}・全部步驟`, (r) => kp(r));
    row(`${kn}・錨點被修改觸及的步驟`, (r) => kp(r) && r.touched);
  }
  console.log(lines.join("\n"));
  // 參考答案「已不存在」的存活門檻敏感度（全部步驟、單段＋範圍合計）
  console.log("\n| 存活門檻 | " + METHODS.map((m) => NAMES[m]).join(" | ") + " |\n|---|---|---|---|---|");
  for (const cut of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const truth = (r: Rec) => (r.frac < cut ? null : r.oracle);
    console.log(`| ${cut} | ${METHODS.map((m) => cell(tally(recs, () => true, m, truth))).join(" | ")} |`);
  }
  const fb = (k: "M1a" | "M1b") => recs.filter((r) => r.mergeBroken[k]).length;
  console.log(`\n文內記號合併後清掉記號與真實下一版不同：M1a ${fb("M1a")}／M1b ${fb("M1b")}／${recs.length} 步`);
  const syn = runSynthetic();
  console.log("\n## 合成情境（每格：指對／指錯／找不到 的案例數）");
  const groups = new Map<string, Map<string, Record<string, [number, number, number]>>>();
  for (const r of syn) {
    const g = groups.get(r.scenario) ?? new Map(); groups.set(r.scenario, g);
    const e = g.get(r.kind) ?? {}; g.set(r.kind, e);
    for (const m of METHODS) { const t = (e[m] ??= [0, 0, 0]); const c = r.cls[m]; t[c === "correct" ? 0 : c === "lost" ? 2 : 1]++; }
  }
  console.log("| 情境 | 錨點 | 案例數 | " + METHODS.map((m) => NAMES[m]).join(" | ") + " |\n|---|---|---|---|---|---|---|");
  const tot: Record<string, Record<string, [number, number, number]>> = { 單段: {}, 範圍: {} };
  for (const [sc, g] of groups) for (const [k, e] of g) {
    console.log(`| ${sc} | ${k} | ${syn.filter((r) => r.scenario === sc && r.kind === k).length} | ${METHODS.map((m) => e[m]!.join("／")).join(" | ")} |`);
    for (const m of METHODS) { const t = (tot[k]![m] ??= [0, 0, 0]); e[m]!.forEach((v, i) => (t[i] += v)); }
  }
  for (const k of ["單段", "範圍"]) console.log(`| **合計** | ${k} | ${syn.filter((r) => r.kind === k).length} | ${METHODS.map((m) => tot[k]![m]!.join("／")).join(" | ")} |`);
  writeFileSync(join(OUT, "synthetic-records.json"), JSON.stringify(syn));
}
