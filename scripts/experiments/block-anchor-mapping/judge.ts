// 人工判讀：從「各做法意見不一」的受影響步驟抽 30 個，印出舊文字與各做法指到的新文字。
// 用法：tsx judge.ts print      → 印出 30 個案例（編號 1–30）
//       tsx judge.ts score      → 讀 manual-judgments.json（{ "1": ["oracle","M3"], ... } 每案寫「正確的選項」，空陣列 = 該段已不存在），
//                                  算參考答案本身的可靠度與各做法在這 30 例的正確數
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHistories, OUT } from "./history.ts";
import { classify, iou, IOU_OK, type Range } from "./lib.ts";
import type { Rec } from "./run-history.ts";

const here = dirname(fileURLToPath(import.meta.url));
const recs: Rec[] = JSON.parse(readFileSync(join(OUT, "history-records.json"), "utf8"));
const hist = new Map(loadHistories(30).map((h) => [h.path, h]));
const KEYS = ["M1a", "M1b", "M2", "M3"] as const;
const same = (a: Range | null, b: Range | null) => (!a && !b) || (!!a && !!b && iou(a, b) >= IOU_OK);

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
export function pickCases(): Rec[] {
  const pool = recs.filter((r) => r.touched && r.prevOracle && (["M1b", "M2", "M3"] as const).some((k) => !same(r.res[k], r.oracle)) && !/Anthropic|OpenAI|Claude|Gemini/.test(hist.get(r.file)!.versions[r.step - 1]!.text.slice(r.prevOracle.from, r.prevOracle.to) + hist.get(r.file)!.versions[r.step]!.text.slice(r.oracle?.from ?? 0, r.oracle?.to ?? 0)));
  const rand = rng(20261101);
  const byKind: Rec[][] = [pool.filter((r) => r.kind === "single"), pool.filter((r) => r.kind === "range")];
  const out: Rec[] = [];
  const shuffle = <T,>(a: T[]) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j]!, b[i]!]; } return b; };
  const seen = new Set<string>();
  for (const r of [...shuffle(byKind[0]!).slice(0, 40), ...shuffle(byKind[1]!).slice(0, 40)].sort(() => rand() - 0.5)) {
    const k = r.file + r.anchor + r.start; // 同一錨點不重複抽
    if (seen.has(k)) continue; seen.add(k); out.push(r);
    if (out.length === 30) break;
  }
  return out;
}
const clip = (s: string, n = 150) => { const t = s.replace(/\n/g, "⏎"); return t.length <= n ? t : t.slice(0, n / 2) + " … " + t.slice(-n / 2); };
export function candidates(r: Rec): Array<{ name: string; range: Range | null }> {
  return [{ name: "oracle", range: r.oracle }, ...KEYS.map((k) => ({ name: k, range: r.res[k] }))];
}

if (process.argv[2] === "print") {
  pickCases().forEach((r, i) => {
    const h = hist.get(r.file)!;
    const prev = h.versions[r.step - 1]!.text, next = h.versions[r.step]!.text;
    console.log(`\n#${i + 1} ${r.file} 步驟 ${r.step - r.start}（${r.kind === "single" ? "單段" : "範圍"}）  存活比例 ${(r.frac * 100).toFixed(0)}%`);
    console.log(`  舊: ${clip(prev.slice(r.prevOracle!.from, r.prevOracle!.to))}`);
    const groups: string[][] = []; const reps: Array<Range | null> = [];
    for (const c of candidates(r)) { const gi = reps.findIndex((x) => same(x, c.range) && (x === null) === (c.range === null)); if (gi >= 0) groups[gi]!.push(c.name); else { reps.push(c.range); groups.push([c.name]); } }
    groups.forEach((g, gi) => console.log(`  新[${g.join("+")}]: ${reps[gi] ? clip(next.slice(reps[gi]!.from, reps[gi]!.to)) : "（找不到）"}`));
  });
} else if (process.argv[2] === "score") {
  const judged: Record<string, string[]> = JSON.parse(readFileSync(join(here, "manual-judgments.json"), "utf8"));
  const tot: Record<string, { 指對: number; 指錯: number; 找不到: number }> = {};
  let n = 0;
  pickCases().forEach((r, i) => {
    const right = judged[String(i + 1)] ?? [];
    if (right[0] === "?") return; // 看不出答案的案例不計
    n++;
    for (const c of candidates(r)) {
      const t = (tot[c.name] ??= { 指對: 0, 指錯: 0, 找不到: 0 });
      if (right.length === 0) t[c.range === null ? "指對" : "指錯"]++;
      else if (c.range === null) t.找不到++;
      else t[right.includes(c.name) ? "指對" : "指錯"]++;
    }
  });
  console.log(`可判讀 ${n} 例：`); console.table(tot);
}
