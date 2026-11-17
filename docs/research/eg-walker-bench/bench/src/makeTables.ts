// 把 out/*.json 整理成報告用的 Markdown 表格（輸出到 out/tables.md）。報告裡的數字都來自這支。
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
const rd = (f: string) => (existsSync(join(out, f)) ? JSON.parse(readFileSync(join(out, f), "utf8")) : null);
interface Row { case?: string; id?: string; op: string; impl: string; stats?: { medianMs: number; p95Ms: number; n: number; note?: string }; skipped?: string; kind?: string }
const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 100 ? `${ms.toFixed(0)} ms` : ms >= 10 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(2)} ms`);
const cell = (r?: Row) => (!r ? "—" : r.skipped || !r.stats ? "未跑" : `${fmt(r.stats.medianMs)} / ${fmt(r.stats.p95Ms)}${r.stats.n === 1 ? "*" : ""}`);
const IMPLS = ["diff3", "ref", "dt", "proto"] as const;
const NAMES: Record<string, string> = { diff3: "現行 diff3", ref: "參考實作", dt: "diamond-types", proto: "我們的原型" };
const SCEN = ["10KB-10", "10KB-100", "10KB-1000", "50KB-10", "50KB-100", "50KB-1000", "200KB-10", "200KB-100", "200KB-1000"];
const lines: string[] = ["# Eg-walker 測試台原始數字", "", "> 狀態：歷史紀錄（寫於 2026-11-01）（`src/makeTables.ts` 由 `bench/out/*.json` 自動產生；解讀見上一層的 report.md）", ""];
const p = (s = "") => lines.push(s);

function forkTable(title: string, rows: Row[], op: string) {
  p(`**${title}**（中位數 / p95；\\* 只量了一次）`); p();
  p(`| 情境 | ${IMPLS.map((i) => NAMES[i]).join(" | ")} |`); p(`| --- | ${IMPLS.map(() => "---").join(" | ")} |`);
  for (const s of SCEN) p(`| ${s} | ${IMPLS.map((i) => cell(rows.find((r) => (r.case ?? r.id) === s && r.op === op && r.impl === i && (r.kind ?? "fork") === "fork"))).join(" | ")} |`);
  p();
}
const node = rd("node.json");
if (node) {
  p(`## Node（${node.env.node}，${node.env.cpu}，校準 ${node.env.calibrationMs.toFixed(0)} ms）`); p();
  forkTable("(a) 只處理分岔那段", node.rows, "a");
  forkTable("(b) 整份歷史從頭重放", node.rows, "b");
  forkTable("(c) 載入既有文件＋套一筆遠端修改", node.rows, "c");
  p("**論文 trace，(b) 整份重放**"); p();
  p(`| trace | ${["ref", "dt", "proto"].map((i) => NAMES[i]).join(" | ")} | 結果對得上預期 |`); p("| --- | --- | --- | --- | --- |");
  for (const t of ["automerge-paper", "seph-blog1", "friendsforever", "clownschool", "node_nodecc", "git-makefile"]) {
    const ok = ["dt", "proto"].map((i) => node.rows.find((r: Row & { agreeWith?: { endContent: boolean } }) => r.case === t && r.op === "b-correct" && r.impl === i)?.agreeWith?.endContent);
    p(`| ${t} | ${["ref", "dt", "proto"].map((i) => cell(node.rows.find((r: Row) => r.case === t && r.op === "b" && r.impl === i))).join(" | ")} | dt ${ok[0] ? "✓" : "✗"} 原型 ${ok[1] ? "✓" : "✗"} |`);
  }
  p();
}
for (const f of ["browser-chromium-x4.json", "browser-chromium-x1.json", "browser-webkit-x1.json"]) {
  const b = rd(f);
  if (!b) continue;
  p(`## ${b.env.browser} ${b.env.version}，降速 ${b.env.throttle}×（校準 ${b.env.calibrationMs.toFixed(0)} ms）`); p();
  forkTable("(a) 只處理分岔那段", b.rows, "a");
  forkTable("(b) 整份歷史從頭重放", b.rows, "b");
  forkTable("(c) 載入既有文件＋套一筆遠端修改", b.rows, "c");
  p(`| trace (b) | ${["ref", "dt", "proto"].map((i) => NAMES[i]).join(" | ")} |`); p("| --- | --- | --- | --- |");
  for (const t of ["automerge-paper", "seph-blog1", "friendsforever", "clownschool", "node_nodecc", "git-makefile"]) p(`| ${t} | ${["ref", "dt", "proto"].map((i) => cell(b.rows.find((r: Row) => r.kind === "trace" && r.id === t && r.impl === i))).join(" | ")} |`);
  p();
}
const abl = rd("ablation.json");
if (abl) {
  p("## 優化各貢獻多少（Node，中位數 / p95）"); p();
  p("| 情境 | 操作 | V0 無優化 | V1 ＋run-length | V2 ＋分段陣列 | V3 ＋跳過線性（完整原型） |"); p("| --- | --- | --- | --- | --- | --- |");
  const keys = [...new Set(abl.map((r: { case: string; op: string }) => `${r.case}|${r.op}`))] as string[];
  for (const k of keys) { const [c, o] = k.split("|"); p(`| ${c} | ${o} | ${abl.filter((r: { case: string; op: string }) => r.case === c && r.op === o).map((r: Row & { case: string }) => cell({ ...r, impl: "x" })).join(" | ")} |`); }
  p();
}
const sz = rd("size.json");
if (sz) {
  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
  p("## 序列化後的歷史大小（base＋A＋B，原始 / gzip）"); p();
  p("| 情境 | 筆記本身（UTF-8） | 我們的原型 | diamond-types | 參考實作（JSON） |"); p("| --- | --- | --- | --- | --- |");
  for (const r of sz.forkHistory) p(`| ${r.case} | ${kb(r.baseUtf8)} | ${kb(r.proto.raw)} / ${kb(r.proto.gzip)} | ${kb(r.dt.raw)} / ${kb(r.dt.gzip)} | ${r.ref ? `${kb(r.ref.raw)} / ${kb(r.ref.gzip)}` : "—"} |`);
  p(); p("| trace | 單位操作數 | 最終文字 | 我們的原型 | diamond-types（.dt） | 參考實作（JSON） |"); p("| --- | --- | --- | --- | --- | --- |");
  for (const r of sz.traces) p(`| ${r.trace} | ${r.ops} | ${kb(r.endUtf8)} | ${kb(r.proto.raw)} / ${kb(r.proto.gzip)} | ${kb(r.dt.raw)} / ${kb(r.dt.gzip)} | ${r.ref ? `${kb(r.ref.raw)} / ${kb(r.ref.gzip)}` : "—"} |`);
  p(); p("## 打包後大小（minify，esm）"); p(); p("| 項目 | 原始 | gzip | brotli |"); p("| --- | --- | --- | --- |");
  for (const b of sz.bundles) p(`| ${b.name} | ${kb(b.raw)} | ${kb(b.gzip)} | ${kb(b.brotli)} |`);
  p();
}
const mem = rd("mem.json");
if (mem) {
  p("## 記憶體（Node，一個 case 一個程序）"); p(); p("| 情境 | 實作 | 操作期間 JS 堆積配置量 | 程序 RSS 峰值 |"); p("| --- | --- | --- | --- |");
  for (const r of mem) if (!r.skipped) p(`| ${r.spec} | ${NAMES[r.impl]} | ${(r.allocBytes / 1024 / 1024).toFixed(1)} MB | ${(r.rssPeakKB / 1024).toFixed(0)} MB |`);
  p();
}
writeFileSync(join(out, "tables.md"), lines.join("\n"));
console.log(lines.join("\n"));
