// 三種段落錨點做法 + 參考答案（oracle）+ 分類。實驗用，不屬產品程式。
import { unified } from "unified";
import remarkParse from "remark-parse";
import { diffArrays, diffChars } from "diff";
import DiffMatchPatch from "diff-match-patch";
import { ChangeSet, MapMode } from "@codemirror/state";
import { blockAnchors } from "@onden/markdown";
import { threeWayMergeBody } from "../../../packages/backend/src/services/eventLog/bodyMerge.js";

export type Range = { from: number; to: number };
export type Params = { keep: number; find: number };
export const DEFAULTS: Params = { keep: 0.5, find: 0.8 };
export const GONE_CUT = 0.5; // 參考答案：原字元存活比例低於此值 = 這段已不存在

// ---------- 文字與行 ----------
export function lineTable(text: string) {
  const lines = text.split("\n");
  const starts: number[] = [];
  let p = 0;
  for (const l of lines) { starts.push(p); p += l.length + 1; }
  return { lines, starts };
}
export function lineOf(starts: number[], pos: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}
/** 把範圍擴成整行（所有做法的起始範圍都是整行，才可互相比較）。 */
export function lineAlign(text: string, r: Range): Range {
  const { lines, starts } = lineTable(text);
  const a = lineOf(starts, r.from), b = lineOf(starts, Math.max(r.from, r.to - 1));
  return { from: starts[a]!, to: starts[b]! + lines[b]!.length };
}

// ---------- 切段（只用來在起始版本選定要錨定的段落） ----------
export type Seg = { kind: "paragraph" | "heading" | "listItem"; from: number; to: number; indent: number };
const memo = <T>(fn: (t: string) => T) => {
  const cache = new Map<string, T>();
  return (t: string): T => {
    if (cache.has(t)) return cache.get(t)!;
    const v = fn(t); cache.set(t, v);
    if (cache.size > 6) cache.delete(cache.keys().next().value!);
    return v;
  };
};
export const segment = memo(segmentRaw);
const anchorsOf = memo((t: string) => blockAnchors(t));
function segmentRaw(text: string): Seg[] {
  const tree: any = unified().use(remarkParse).parse(text);
  const out: Seg[] = [];
  const lineStartOf = (o: number) => text.lastIndexOf("\n", o - 1) + 1;
  const walk = (node: any, inItem: boolean) => {
    for (const c of node.children ?? []) {
      if (c.type === "heading") out.push({ kind: "heading", from: c.position.start.offset, to: c.position.end.offset, indent: 0 });
      else if (c.type === "paragraph") {
        const from = c.position.start.offset;
        out.push({ kind: inItem ? "listItem" : "paragraph", from, to: c.position.end.offset, indent: inItem ? from - lineStartOf(from) : 0 });
      } else if (c.type === "list" || c.type === "listItem") walk(c, c.type === "listItem" || inItem);
    }
  };
  walk(tree, false);
  return out.sort((a, b) => a.from - b.from);
}
function eligible(text: string, s: Seg): boolean {
  const t = text.slice(s.from, s.to);
  return t.length >= 12 && !t.includes("<!--") && !/\^[a-z0-9]{4,}/.test(t);
}

// ---------- 相似度與模糊找回 ----------
const norm = (s: string) => s.replace(/\s+/g, "");
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}
/** 字元二連詞的 Dice 係數（0..1）。 */
export function dice(a0: string, b0: string): number {
  const a = norm(a0), b = norm(b0);
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ma = bigrams(a), mb = bigrams(b);
  let hit = 0;
  for (const [g, n] of ma) hit += Math.min(n, mb.get(g) ?? 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

export type Quote = { text: string; prefix: string; suffix: string };
export function quoteAt(text: string, r: Range): Quote {
  const { lines, starts } = lineTable(text);
  const a = lineOf(starts, r.from), b = lineOf(starts, Math.max(r.from, r.to - 1));
  return { text: text.slice(r.from, r.to), prefix: lines[a - 1] ?? "", suffix: lines[b + 1] ?? "" };
}

/** 在整篇找最像 quote 的連續行；有並列且無法用前後文分辨就回 null（不亂指）。 */
export function fuzzyFind(q: Quote, text: string, find: number): Range | null {
  const { lines, starts } = lineTable(text);
  const k = q.text.split("\n").length;
  const scored: Array<{ i: number; kk: number; score: number; ctx: number }> = [];
  for (const kk of new Set([k, Math.max(1, k - 1), k + 1])) {
    for (let i = 0; i + kk <= lines.length; i++) {
      const w = lines.slice(i, i + kk).join("\n");
      if (!w.trim()) continue;
      const lenRatio = Math.min(w.length, q.text.length) / Math.max(w.length, q.text.length);
      if (lenRatio < find * 0.5) continue; // 長度差太多不可能到門檻
      const score = dice(q.text, w);
      if (score < find) continue;
      const ctx = (q.prefix.trim() && lines[i - 1] === q.prefix ? 1 : 0) + (q.suffix.trim() && lines[i + kk] === q.suffix ? 1 : 0);
      scored.push({ i, kk, score, ctx });
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || b.ctx - a.ctx);
  const best = scored[0]!;
  const rivals = scored.filter((c) => c !== best && !(c.i === best.i) && c.score >= best.score - 0.01 && c.ctx >= best.ctx && !(c.i < best.i + best.kk && best.i < c.i + c.kk));
  if (rivals.length) return null;
  return { from: starts[best.i]!, to: starts[best.i + best.kk - 1]! + lines[best.i + best.kk - 1]!.length };
}

// ---------- 參考答案：逐字元一路追蹤 ----------
const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 0;
export type CharOps = Array<{ a: number; b: number }>; // 舊文字被改的區間 [a,b)（插入時 a==b）
let lastMap: { a: string; b: string; v: ReturnType<typeof dmpMapRaw> } | null = null;
function dmpMap(oldText: string, newText: string) {
  if (lastMap?.a === oldText && lastMap.b === newText) return lastMap.v;
  const v = dmpMapRaw(oldText, newText); lastMap = { a: oldText, b: newText, v }; return v;
}
function dmpMapRaw(oldText: string, newText: string) {
  const diffs = dmp.diff_main(oldText, newText, false);
  dmp.diff_cleanupSemantic(diffs);
  const map = new Int32Array(oldText.length).fill(-1); // 舊位置 → 新位置（被刪 = -1）
  const ops: CharOps = [];
  let o = 0, n = 0;
  for (const [t, s] of diffs) {
    if (t === 0) { for (let i = 0; i < s.length; i++) map[o + i] = n + i; o += s.length; n += s.length; }
    else if (t === -1) { ops.push({ a: o, b: o + s.length }); o += s.length; }
    else { ops.push({ a: o, b: o }); n += s.length; }
  }
  return { map, ops };
}
export class Oracle {
  alive: number[]; origLen: number; range: Range | null; goneSteps = 0;
  constructor(text: string, r: Range) {
    this.alive = []; for (let i = r.from; i < r.to; i++) this.alive.push(i);
    this.origLen = r.to - r.from; this.range = r;
  }
  /** 回傳 { touched, frac }；this.range 為 null = 已不存在。 */
  step(oldText: string, newText: string): { touched: boolean; frac: number } {
    const prev = this.range;
    const { map, ops } = dmpMap(oldText, newText);
    this.alive = this.alive.map((p) => map[p]!).filter((p) => p >= 0);
    const frac = this.alive.length / this.origLen;
    const touched = prev ? ops.some((op) => op.a <= prev.to && op.b >= prev.from) : false;
    if (this.range === null || frac < GONE_CUT || !this.alive.length) { this.range = null; this.goneSteps++; }
    else this.range = { from: this.alive[0]!, to: this.alive[this.alive.length - 1]! + 1 };
    return { touched, frac };
  }
}

// ---------- M2：伺服器逐行差異搬移 + 原文模糊找回 ----------
export type LineAnchor = { s: number; e: number; q: Quote; lost: boolean };
export function m2Init(text: string, r: Range): LineAnchor {
  const { starts } = lineTable(text);
  const s = lineOf(starts, r.from), e = lineOf(starts, Math.max(r.from, r.to - 1)) + 1;
  return { s, e, q: quoteAt(text, r), lost: false };
}
function rangeOfLines(text: string, s: number, e: number): Range {
  const { lines, starts } = lineTable(text);
  return { from: starts[s]!, to: starts[e - 1]! + lines[e - 1]!.length };
}
export function m2Step(a: LineAnchor, oldText: string, newText: string, P: Params): Range | null {
  const oldL = oldText.split("\n"), newL = newText.split("\n");
  if (!a.lost) {
    const parts = diffArrays(oldL, newL);
    const map = new Int32Array(oldL.length).fill(-1);
    const hunks: Array<{ oF: number; oT: number; nF: number; nT: number }> = [];
    let oi = 0, ni = 0, cur: (typeof hunks)[number] | null = null;
    for (const p of parts) {
      const c = p.count ?? 0;
      if (!p.added && !p.removed) { cur = null; for (let i = 0; i < c; i++) map[oi + i] = ni + i; oi += c; ni += c; continue; }
      cur ??= (hunks.push({ oF: oi, oT: oi, nF: ni, nT: ni }), hunks[hunks.length - 1]!);
      if (p.removed) { oi += c; cur.oT = oi; } else { ni += c; cur.nT = ni; }
    }
    const inc: number[] = [];
    for (let k = a.s; k < a.e; k++) if (map[k]! >= 0) inc.push(map[k]!);
    for (const h of hunks) {
      const rem = h.oT - h.oF;
      if (rem > 0) {
        const overlap = Math.max(0, Math.min(h.oT, a.e) - Math.max(h.oF, a.s));
        if (overlap > 0 && overlap * 2 >= rem) for (let i = h.nF; i < h.nT; i++) inc.push(i);
      } else if (a.s < h.oF && h.oF < a.e) for (let i = h.nF; i < h.nT; i++) inc.push(i); // 範圍內部的插入；邊界上的不納入
    }
    if (inc.length) {
      const s = Math.min(...inc), e = Math.max(...inc) + 1;
      const r = rangeOfLines(newText, s, e);
      if (dice(a.q.text, newText.slice(r.from, r.to)) >= P.keep) {
        a.s = s; a.e = e; a.q = quoteAt(newText, r); return r;
      }
    }
  }
  const r = fuzzyFind(a.q, newText, P.find);
  if (!r) { a.lost = true; return null; }
  const m = m2Init(newText, r); a.s = m.s; a.e = m.e; a.q = m.q; a.lost = false;
  return r;
}

// ---------- M3：字元差異 → ChangeSet.mapPos(TrackDel)；失敗走模糊找回 ----------
export type CharAnchor = { from: number; to: number; q: Quote; lost: boolean; trackDelHits: number };
export function m3Init(text: string, r: Range): CharAnchor { return { ...r, q: quoteAt(text, r), lost: false, trackDelHits: 0 }; }
/** 模擬編輯器：字元差異，間隔 <4 字元的相等片段併入前後的修改（一次手動修改通常是連續的取代）。 */
export function diffToChanges(oldText: string, newText: string): Array<{ from: number; to: number; insert: string }> {
  const parts = diffChars(oldText, newText);
  const ops: Array<{ from: number; to: number; insert: string }> = [];
  let o = 0, cur: (typeof ops)[number] | null = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!, len = p.value.length;
    if (!p.added && !p.removed) {
      if (cur && len < 4 && i + 1 < parts.length) { cur.insert += p.value; cur.to = o + len; } else cur = null;
      o += len; continue;
    }
    if (!cur) { cur = { from: o, to: o, insert: "" }; ops.push(cur); }
    if (p.removed) { o += len; cur.to = o; } else cur.insert += p.value;
  }
  return ops;
}
/** 先逐行差異找出改過的區塊，區塊內再做字元差異（整篇直接做字元差異在大筆記上太慢）。 */
export function diffByLinesThenChars(a: string, b: string): Array<{ from: number; to: number; insert: string }> {
  const split = (t: string) => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const parts = diffArrays(split(a), split(b));
  const ops: Array<{ from: number; to: number; insert: string }> = [];
  let ao = 0, bo = 0, ha = -1, hb = -1;
  const close = () => {
    if (ha < 0) return;
    const oldH = a.slice(ha, ao), newH = b.slice(hb, bo);
    if (oldH.length * newH.length > 4e6) ops.push({ from: ha, to: ao, insert: newH });
    else for (const c of diffToChanges(oldH, newH)) ops.push({ from: c.from + ha, to: c.to + ha, insert: c.insert });
    ha = -1;
  };
  for (const p of parts) {
    const len = p.value.reduce((n: number, l: string) => n + l.length, 0);
    if (!p.added && !p.removed) { close(); ao += len; bo += len; continue; }
    if (ha < 0) { ha = ao; hb = bo; }
    if (p.removed) ao += len; else bo += len;
  }
  close();
  return ops;
}
let lastCs: { a: string; b: string; v: ChangeSet } | null = null;
function changeSetOf(a: string, b: string): ChangeSet {
  if (lastCs?.a === a && lastCs.b === b) return lastCs.v;
  const v = ChangeSet.of(diffByLinesThenChars(a, b), a.length); lastCs = { a, b, v }; return v;
}
export function m3Step(a: CharAnchor, oldText: string, newText: string, P: Params, exact?: ChangeSet): Range | null {
  if (!a.lost) {
    const cs = exact ?? changeSetOf(oldText, newText);
    const from = cs.mapPos(a.from, 1, MapMode.TrackDel);
    const to = cs.mapPos(a.to, -1, MapMode.TrackDel);
    if (from === null || to === null) a.trackDelHits++;
    else if (to > from) { a.from = from; a.to = to; a.q = quoteAt(newText, { from, to }); return { from, to }; }
  }
  const r = fuzzyFind(a.q, newText, P.find);
  if (!r) { a.lost = true; return null; }
  a.from = r.from; a.to = r.to; a.q = quoteAt(newText, r); a.lost = false;
  return r;
}

// ---------- M1：記號寫在正文 ----------
export type Form = "eol" | "next";
export type M1Anchor = { id: string; kind: "single" | "range" };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const markerRe = (id: string, form: Form) =>
  new RegExp(form === "eol" ? `[ ]\\^${esc(id)}(?![A-Za-z0-9_-])` : `\\n[ \\t]*<!-- \\^${esc(id)} -->`, "g");
export const markerText = (id: string, form: Form, indent: number) => (form === "eol" ? ` ^${id}` : `\n${" ".repeat(indent)}<!-- ^${id} -->`);

/** 在起始文字替每個選定的段落（含範圍的頭尾）加記號。 */
export function m1Mark(text: string, marks: Array<{ id: string; seg: Seg }>, form: Form): string {
  let out = text;
  for (const m of [...marks].sort((a, b) => b.seg.to - a.seg.to)) out = out.slice(0, m.seg.to) + markerText(m.id, form, m.seg.indent) + out.slice(m.seg.to);
  return out;
}
export type M1Reading = { clean: string; pos: Map<string, number>; dup: Set<string> };
export function m1Read(marked: string, ids: string[], form: Form): M1Reading {
  const hits: Array<{ id: string; from: number; to: number }> = [];
  const dup = new Set<string>();
  for (const id of ids) {
    let n = 0;
    for (const m of marked.matchAll(markerRe(id, form))) { hits.push({ id, from: m.index!, to: m.index! + m[0].length }); n++; }
    if (n > 1) dup.add(id);
  }
  hits.sort((a, b) => a.from - b.from);
  let clean = "", last = 0, removed = 0;
  const pos = new Map<string, number>();
  for (const h of hits) {
    if (h.from < last) continue;
    clean += marked.slice(last, h.from); last = h.to;
    if (!pos.has(h.id)) pos.set(h.id, h.from - removed);
    removed += h.to - h.from;
  }
  clean += marked.slice(last);
  return { clean, pos, dup };
}
/** 記號現在指到哪一段（行對齊的範圍）；null = 找不到。eol 另需 @onden/markdown 的 blockAnchors 認得這個 id。 */
export function m1Locate(marked: string, a: M1Anchor, form: Form, ids: string[]): { range: Range | null; clean: string; dup: boolean } {
  const rd = m1Read(marked, ids, form);
  const segOf = (id: string): Seg | null => {
    const e = rd.pos.get(id);
    if (e === undefined) return null;
    if (form === "eol" && !anchorsOf(marked).some((x) => x.id === id)) return null;
    const segs = segment(rd.clean);
    return segs.find((s) => s.to === e) ?? (form === "eol" ? segs.find((s) => s.from < e && e <= s.to) ?? null : null);
  };
  const ends = a.kind === "single" ? [a.id] : [a.id + "a", a.id + "b"];
  const found = ends.map(segOf);
  const dup = ends.some((i) => rd.dup.has(i));
  if (found.some((f) => !f)) return { range: null, clean: rd.clean, dup };
  const from = found[0]!.from, to = found[found.length - 1]!.to;
  if (to <= from) return { range: null, clean: rd.clean, dup };
  return { range: lineAlign(rd.clean, { from, to }), clean: rd.clean, dup };
}
export function m1Step(marked: string, prevRaw: string, nextRaw: string) {
  const r = threeWayMergeBody(prevRaw, nextRaw, marked);
  return { marked: r.merged, clean: r.clean, conflicts: r.conflicts.length };
}

// ---------- 分類 ----------
export function iou(a: Range, b: Range): number {
  const inter = Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
  const uni = Math.max(a.to, b.to) - Math.min(a.from, b.from);
  return uni === 0 ? 1 : inter / uni;
}
export type Cls = "correct" | "lost" | "wrong-elsewhere" | "wrong-partial-over" | "wrong-partial-under";
export const IOU_OK = 0.8;
export function classify(result: Range | null, truth: Range | null): Cls {
  if (!truth) return result ? "wrong-elsewhere" : "correct";
  if (!result) return "lost";
  const v = iou(result, truth);
  if (v >= IOU_OK) return "correct";
  if (v === 0) return "wrong-elsewhere";
  return result.to - result.from > truth.to - truth.from ? "wrong-partial-over" : "wrong-partial-under";
}
export const isWrong = (c: Cls) => c.startsWith("wrong");

export { eligible };
