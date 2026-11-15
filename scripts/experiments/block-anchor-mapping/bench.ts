// 每次存檔對整篇做差異的成本：不同大小的筆記，小修改與大改。單位毫秒（中位數）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffArrays, diffChars } from "diff";
import DiffMatchPatch from "diff-match-patch";
import { ChangeSet, MapMode } from "@codemirror/state";
import { blockAnchors } from "@onden/markdown";
import { threeWayMergeBody } from "../../../packages/backend/src/services/eventLog/bodyMerge.js";
import { diffByLinesThenChars, fuzzyFind, quoteAt, lineTable } from "./lib.ts";

const root = join(import.meta.dirname, "../../..");
const src = readFileSync(join(root, "docs/research/full-feature-audit.md"), "utf8");
const med = (f: () => unknown, n = 5) => { const t: number[] = []; for (let i = 0; i < n; i++) { const s = performance.now(); f(); t.push(performance.now() - s); } t.sort((a, b) => a - b); return t[n >> 1]!; };
const dmpDefault = new DiffMatchPatch(); // 預設 1 秒逾時（產品現有 diffRuns 也是）
const sizes = [5_000, 20_000, 80_000, 175_000, 700_000];
const doc = (n: number) => { let t = ""; while (t.length < n) t += src; return t.slice(0, n); };

console.log("| 筆記大小 | 修改 | 逐行差異 | 字元差異（jsdiff） | 字元差異（dmp，1 秒逾時） | 逐行再字元差異→ChangeSet | mapPos×500 | 三方合併 | 模糊找回（整篇） | 讀文內記號（blockAnchors） |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const n of sizes) {
  const a = doc(n);
  const mid = Math.floor(a.length / 2);
  const small = a.slice(0, mid) + "（新增的一句話）" + a.slice(mid + 3, 10 + mid) + "改" + a.slice(mid + 11);
  const big = a.split("\n").map((l, i) => (i % 3 === 0 && l.length > 8 ? l.slice(4) + "改寫" : l)).join("\n"); // 約三分之一的行被改
  const anchors = Array.from({ length: 500 }, (_, i) => Math.floor((i / 500) * a.length));
  const lines = lineTable(a).lines.length;
  for (const [label, b] of [["小改（2 處）", small], ["大改（1/3 的行）", big]] as const) {
    const lineMs = med(() => diffArrays(a.split("\n"), b.split("\n")), 3);
    const charMs = n > 200_000 && label.startsWith("大") ? NaN : med(() => diffChars(a, b), 3);
    const dmpMs = med(() => dmpDefault.diff_main(a, b, false), 3);
    const csMs = med(() => ChangeSet.of(diffByLinesThenChars(a, b), a.length), 3);
    const cs = ChangeSet.of(diffByLinesThenChars(a, b), a.length);
    const mapMs = med(() => { for (const p of anchors) cs.mapPos(p, 1, MapMode.TrackDel); });
    const other = a.slice(0, 100) + "（另一台裝置）" + a.slice(100); // current：別台裝置先存了一處修改
    const mergeMs = med(() => threeWayMergeBody(a, b, other), 3);
    const q = quoteAt(b, { from: mid, to: mid + 200 });
    const fuzzyMs = med(() => fuzzyFind({ ...q, text: q.text.replace(/\n/g, " ") }, a, 0.8), 3);
    let k = 0;
    const marked = a.replace(/\n\n/g, () => ` ^b${k++}\n\n`); // 每個空行前都有記號
    const anchorMs = med(() => blockAnchors(marked), 3);
    const f = (x: number) => (Number.isNaN(x) ? "—" : x < 10 ? x.toFixed(1) : Math.round(x).toString());
    console.log(`| ${(n / 1000).toFixed(0)}k 字（${lines} 行） | ${label} | ${f(lineMs)} | ${f(charMs)} | ${f(dmpMs)} | ${f(csMs)} | ${f(mapMs)} | ${f(mergeMs)} | ${f(fuzzyMs)} | ${f(anchorMs)} |`);
  }
}
