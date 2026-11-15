// 單點錨點（只存區塊開頭）的搬移成績，補 docs/research/block-anchor-mapping-2026-11-01.md 沒量的那一格
// （設計文件 §14 第 12 項）。方法與該報告相同：真實文件歷史、同樣的挑段與參考答案、同樣的分類，只換錨點的形狀。
//
//   M3s   帶起訖的錨點（報告的 M3：起點 assoc 1、終點 assoc -1），對照組。
//   P3    單點、編輯器精確搬：只搬「區塊開頭」這一個點（mapPos assoc 1, TrackDel），搬到哪就取那裡的區塊
//         （一串不含空行的行），區塊文字與原文太不像（<0.5）就改用原文找回。
//   P2    單點、伺服器逐行差異：只追開頭那一行，其餘同 P3。
//   P3 與 P2 各用兩種標準判讀：「整個區塊」（結果範圍與參考答案比，IoU ≥ 0.8，與報告同一標準）與「只看開頭」
//   （結果的開頭落在參考答案開頭的同一行；單點錨點當身分用時只需要這個，範圍由排版即時算）。
//   PROD  產品程式本身（packages/backend/src/services/blockAnchors/mapping.ts 的 moveAnchors），錨點帶起訖。
//
// 範圍錨點不在這裡：單點錨點只指一個區塊。依賴同資料夾的 lib.ts／history.ts（PR #1174 的實驗腳本）。
//   npm run build -w @onden/markdown && npx tsx scripts/experiments/block-anchor-mapping/single-point.ts
import { ChangeSet, MapMode } from "@codemirror/state";
import { diffArrays } from "diff";
import { loadHistories } from "./history.ts";
import {
  DEFAULTS, Oracle, classify, dice, eligible, fuzzyFind, isWrong, lineAlign, lineOf, lineTable, m3Init, m3Step, quoteAt, segment,
  diffByLinesThenChars, type Cls, type Quote, type Range, type Seg,
} from "./lib.ts";
import { moveAnchors, type AnchorState } from "../../../packages/backend/src/services/blockAnchors/mapping.ts";
import { blockSpanAt } from "../../../packages/backend/src/services/blockAnchors/store.ts";
import { quoteAt as prodQuoteAt } from "../../../packages/backend/src/services/blockAnchors/similarity.ts";

// ---- 與 run-history.ts 相同的挑段（它沒有匯出；單段與範圍一起挑，單段才不會和範圍重疊） ----
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
type Pick = { kind: "single" | "range"; range: Range };
function pickAnchors(text: string, seed: number): Pick[] {
  const segs = segment(text).filter((s: Seg) => eligible(text, s));
  const rand = rng(seed);
  const used = new Set<number>();
  const picks: Pick[] = [];
  const free = (i: number) => !used.has(i) && !used.has(i - 1) && !used.has(i + 1);
  for (let n = 0; n < 3; n++) {
    const len = 2 + Math.floor(rand() * 2);
    const cand = Array.from({ length: Math.max(0, segs.length - len + 1) }, (_, i) => i).filter((i) => Array.from({ length: len }, (_, k) => i + k).every(free));
    if (!cand.length) break;
    const i = cand[Math.floor(rand() * cand.length)]!;
    for (let k = 0; k < len; k++) used.add(i + k);
    picks.push({ kind: "range", range: lineAlign(text, { from: segs[i]!.from, to: segs[i + len - 1]!.to }) });
  }
  for (let n = 0; n < 6; n++) {
    const cand = segs.map((_, i) => i).filter(free);
    if (!cand.length) break;
    const i = cand[Math.floor(rand() * cand.length)]!;
    used.add(i);
    picks.push({ kind: "single", range: lineAlign(text, { from: segs[i]!.from, to: segs[i]!.to }) });
  }
  return picks;
}

// ---- 單點錨點 ----
type Point = { at: number; q: Quote; lost: boolean };
const KEEP = DEFAULTS.keep;

/** 那個點所在的區塊（一串不含空行的行）；點落在空行就取下一個有字的行。 */
function blockAround(text: string, at: number): Range | null {
  const here = blockSpanAt(text, Math.min(at, text.length));
  if (here) return here;
  const next = text.slice(at).search(/\S/);
  return next < 0 ? null : blockSpanAt(text, at + next);
}

/** 搬完之後的共同尾巴：取那裡的區塊、與原文比，太不像就找回。 */
function settle(p: Point, newText: string, movedAt: number | null): Range | null {
  if (!p.lost && movedAt !== null) {
    const block = blockAround(newText, movedAt);
    if (block && dice(p.q.text, newText.slice(block.from, block.to)) >= KEEP) {
      p.at = block.from; p.q = quoteAt(newText, block); return block;
    }
  }
  const found = fuzzyFind(p.q, newText, DEFAULTS.find);
  if (!found) { p.lost = true; return null; }
  p.at = found.from; p.q = quoteAt(newText, found); p.lost = false;
  return found;
}

function p3Step(p: Point, oldText: string, newText: string, cs: ChangeSet): Range | null {
  return settle(p, newText, p.lost ? null : cs.mapPos(p.at, 1, MapMode.TrackDel));
}

function p2Step(p: Point, oldText: string, newText: string): Range | null {
  if (p.lost) return settle(p, newText, null);
  const oldL = oldText.split("\n"), newL = newText.split("\n");
  const map = new Int32Array(oldL.length).fill(-1);
  let oi = 0, ni = 0;
  for (const part of diffArrays(oldL, newL)) {
    const c = part.count ?? 0;
    if (!part.added && !part.removed) { for (let i = 0; i < c; i++) map[oi + i] = ni + i; oi += c; ni += c; } else if (part.removed) oi += c; else ni += c;
  }
  const oldLine = lineOf(lineTable(oldText).starts, p.at);
  const mapped = map[oldLine]!;
  return settle(p, newText, mapped < 0 ? null : lineTable(newText).starts[mapped]!);
}

// ---- 跑 ----
type Row = Record<"M3s" | "P3" | "P2" | "PROD" | "P3start" | "P2start", Cls>;
const METHODS = ["M3s", "P3", "P2", "PROD", "P3start", "P2start"] as const;
const NAMES: Record<string, string> = {
  M3s: "M3s 起訖錨點（報告的 M3）", P3: "P3 單點・整個區塊", P2: "P2 單點・整個區塊", PROD: "PROD 產品程式（起訖）",
  P3start: "P3 單點・只看開頭", P2start: "P2 單點・只看開頭",
};
/** 只看開頭：結果的開頭和參考答案的開頭在同一行（答案已不存在時，結果也要是「沒有」）。 */
function startClass(result: Range | null, truth: Range | null, text: string): Cls {
  if (!truth) return result ? "wrong-elsewhere" : "correct";
  if (!result) return "lost";
  const starts = lineTable(text).starts;
  return lineOf(starts, result.from) === lineOf(starts, truth.from) ? "correct" : "wrong-elsewhere";
}
let startDisagree = 0;
const rows: Array<{ touched: boolean; cls: Row }> = [];
const chains = new Map<string, Row[]>();
let chainCount = 0;
const started = Date.now();

for (const h of loadHistories(30)) {
  const texts = h.versions.map((v) => v.text);
  const first = texts.findIndex((t) => segment(t).filter((s: Seg) => eligible(t, s)).length >= 10);
  const starts = new Set<number>();
  if (first >= 0) starts.add(first);
  starts.add(Math.floor(texts.length / 2));
  for (const start of starts) {
    if (texts.length - start < 4) continue;
    const t0 = texts[start]!;
    // 挑段要把範圍一起算，單段的位置才和報告一致；單點只用單段。
    const singles = pickAnchors(t0, hash(h.path) + start).filter((p) => p.kind === "single");
    for (const pick of singles) {
      chainCount++;
      const oracle = new Oracle(t0, pick.range);
      const m3 = m3Init(t0, pick.range);
      const p3: Point = { at: pick.range.from, q: quoteAt(t0, pick.range), lost: false };
      const p2: Point = { at: pick.range.from, q: quoteAt(t0, pick.range), lost: false };
      // 單點的區塊由排版算：開頭那個點算出的區塊，一開始就和挑的段落一樣嗎？（清單項目、標題常常不一樣）
      const atStart = blockAround(t0, pick.range.from);
      if (!atStart || Math.abs(atStart.to - pick.range.to) > 0 || atStart.from !== pick.range.from) startDisagree++;
      let prod: AnchorState = { anchorId: "x", span: pick.range, quote: prodQuoteAt(t0, pick.range), status: "valid", candidate: null, recoveryPending: false };
      const chain: Row[] = [];
      for (let k = start + 1; k < Math.min(texts.length, start + 1 + 60); k++) {
        const prev = texts[k - 1]!, next = texts[k]!;
        if (oracle.goneSteps > 3) break;
        const { touched } = oracle.step(prev, next);
        const truth = oracle.range;
        const cs = ChangeSet.of(diffByLinesThenChars(prev, next), prev.length);
        const r3s = m3Step(m3, prev, next, DEFAULTS, cs);
        const rp3 = p3Step(p3, prev, next, cs);
        const rp2 = p2Step(p2, prev, next);
        const moved = moveAnchors([prod], { before: prev, after: next, editorChanges: null, trusted: () => true })[0]!;
        prod = moved;
        const rprod = moved.status === "valid" ? moved.span : null;
        const cls: Row = {
          M3s: classify(r3s, truth), P3: classify(rp3, truth), P2: classify(rp2, truth), PROD: classify(rprod, truth),
          P3start: startClass(rp3, truth, next), P2start: startClass(rp2, truth, next),
        };
        rows.push({ touched, cls }); chain.push(cls);
      }
      chains.set(`${h.path}|${start}|${pick.range.from}`, chain);
    }
  }
}

const pct = (a: number, n: number) => (n ? `${((100 * a) / n).toFixed(1)}%` : "—");
function cell(pick: (r: (typeof rows)[number]) => boolean, m: (typeof METHODS)[number]): string {
  const sel = rows.filter(pick);
  const ok = sel.filter((r) => r.cls[m] === "correct").length, wrong = sel.filter((r) => isWrong(r.cls[m])).length, lost = sel.filter((r) => r.cls[m] === "lost").length;
  return `${ok}（${pct(ok, sel.length)}）／${wrong}（${pct(wrong, sel.length)}）／${lost}（${pct(lost, sel.length)}）`;
}
console.log(`鏈數 ${chainCount}、步驟 ${rows.length}、${((Date.now() - started) / 1000).toFixed(0)} 秒`);
console.log(`挑的單段中，開頭那個點算出的區塊一開始就和挑的段落不同：${startDisagree}／${chainCount}（標題、清單項目、緊鄰的行）`);
console.log("\n| 範圍 | 樣本 | " + METHODS.map((m) => NAMES[m]).join(" | ") + " |\n|---|---|---|---|---|---|---|---|");
for (const [name, pick] of [["單段・全部步驟", () => true], ["單段・被修改碰到的步驟", (r: (typeof rows)[number]) => r.touched]] as const) {
  console.log(`| ${name} | ${rows.filter(pick).length} | ${METHODS.map((m) => cell(pick, m)).join(" | ")} |`);
}
console.log("\n整條鏈（全程沒指錯的鏈數／最後一步找不到的鏈數，共 " + chains.size + " 條）：");
for (const m of METHODS) {
  const all = [...chains.values()].filter((c) => c.length);
  const clean = all.filter((c) => !c.some((r) => isWrong(r[m]))).length;
  const lostAtEnd = all.filter((c) => c[c.length - 1]![m] === "lost").length;
  console.log(`  ${NAMES[m]}：${clean}／${lostAtEnd}（${all.length} 條有步驟的鏈）`);
}
// 單點與起訖的差別在哪：兩者結果不同的步驟
const diff = rows.filter((r) => r.cls.P3 !== r.cls.M3s);
console.log(`\nP3 與 M3s 結果不同的步驟：${diff.length}（P3 對 M3s 錯 ${diff.filter((r) => r.cls.P3 === "correct" && r.cls.M3s !== "correct").length}、P3 錯 M3s 對 ${diff.filter((r) => r.cls.M3s === "correct" && r.cls.P3 !== "correct").length}）`);
