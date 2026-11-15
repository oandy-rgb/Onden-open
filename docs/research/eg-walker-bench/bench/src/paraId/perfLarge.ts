// 大文件（約 1 萬行）時，補救層在衝突時多花多少：npx tsx src/paraId/perfLarge.ts
import { threeWayMergeBody } from "../../../../../../packages/backend/src/services/eventLog/bodyMerge.js";
import { mergeBody } from "../../../../../../packages/backend/src/services/eventLog/bodyMergeMoves.js";

const N = 5000; // 段落數；每段兩行（內文一行＋空行）→ 1 萬行
const para = (i: number) => `第${i}段：這是第${i}段的內容，包含一些只有這一段才有的字 ${(i * 7919) % 10007}，再加上一句話。`;
const paras = Array.from({ length: N }, (_, i) => para(i));
const join = (p: string[]) => p.join("\n\n") + "\n";
const base = join(paras);
const move = (p: string[], from: number, to: number) => { const q = [...p]; const [x] = q.splice(from, 1); q.splice(to, 0, x!); return q; };
const edit = (p: string[], i: number, mark: string) => p.map((x, k) => (k === i ? x.replace("再加上", `${mark}再加上`) : x));
const rep = (f: () => unknown, n = 15) => { const ts: number[] = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return ts[Math.floor(n / 2)]!; };

const cases: Array<[string, string, string]> = [
  ["一邊搬動、另一邊改它（行級衝突 → 補救成功）", join(move(paras, 100, 4000)), join(edit(paras, 100, "（改）"))],
  ["兩邊改同一句（行級衝突 → 補救也衝突，退回）", join(edit(paras, 2500, "（我）").map((x, k) => k === 2500 ? x.replace("內容", "我的版本") : x)), join(paras.map((x, k) => k === 2500 ? x.replace("內容", "他的版本") : x))],
  ["兩邊把同一段搬到不同地方（行級乾淨 → 檢出衝突）", join(move(paras, 100, 4000)), join(move(paras, 100, 200))],
  ["兩邊各改不同段（行級乾淨，不到補救層）", join(edit(paras, 100, "（我）")), join(edit(paras, 4000, "（他）"))],
  ["兩邊各搬不同段（行級乾淨，要看有沒有搬同一段）", join(move(paras, 100, 4000)), join(move(paras, 300, 200))],
];
console.log(`文件 ${base.split("\n").length} 行；各取 15 次的中位數（ms）`);
console.log("| 情境 | 行級合併 | mergeBody | 多花 | 結果 |\n|---|---|---|---|---|");
for (const [name, inc, cur] of cases) {
  const a = rep(() => threeWayMergeBody(base, inc, cur)), b = rep(() => mergeBody(base, inc, cur));
  const l = threeWayMergeBody(base, inc, cur), m = mergeBody(base, inc, cur);
  console.log(`| ${name} | ${a.toFixed(1)} | ${b.toFixed(1)} | ${(b - a).toFixed(1)} | 行級${l.clean ? "乾淨" : "衝突"} → ${m.clean ? "乾淨" : "衝突"} |`);
}
