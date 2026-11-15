// 我們的 TS 原型：以 eg-walker-reference 為底（因果圖與圖形走訪沿用它的 causal-graph.ts），
// 只加兩個優化：
//  (a) run-length：連續插入／刪除合成一段（OpSpan、Run），
//  (b) 跳過沒有分岔的線性歷史：只在 critical version 之間重放（replay），
//      合併時只從最近共同祖先起算（mergeIntoBranch，共同祖先之前的文件用一個佔位 run 代替）。
// 另外把線性掃描換成分段陣列（seq.ts）。位置單位是 UTF-16 code unit。
//
// 演算法語意與參考實作逐步對應（Fugue 版 rightParent、integrate 掃描、curState/endState）；
// src/test/fuzz.test.ts 以隨機並行歷史與參考實作交叉比對結果。
import * as cgLib from "../vendor/eg-walker-reference/causal-graph.js";
import type { CausalGraph, LV, LVRange } from "../vendor/eg-walker-reference/causal-graph.js";
import { TextBuf } from "../textBuf.js";
import type { History } from "../types.js";
import { NYI, NO_CHUNK, Seq, curWidth, endWidth, type Cursor, type Run } from "./seq.js";

export interface OpSpan {
  lv: number;
  len: number;
  ins: boolean;
  /** 插入：第一個字元的位置（之後逐字右移）；刪除：每次都刪這個位置 */
  pos: number;
  text?: string;
}

export interface OpLog {
  cg: CausalGraph;
  /** 依 lv 排序、無縫涵蓋 [0, 總操作數) */
  spans: OpSpan[];
  /** 各 agent 下一個 seq（接續加入交易用） */
  nextSeq: Record<string, number>;
}

export interface EngineOpts {
  /** false＝每個單位操作一個 span／run（用來量 run-length 的貢獻） */
  rle: boolean;
  /** 序列分段大小；Infinity＝單一陣列 */
  chunkMax: number;
  /** replay 時跳過沒有分岔的線性歷史 */
  skipLinear: boolean;
}
export const DEFAULT_OPTS: EngineOpts = { rle: true, chunkMax: 64, skipLinear: true };

// ---- 建立 oplog ----

export function buildOpLog(h: History, rle = true): OpLog {
  const log: OpLog = { cg: cgLib.createCG(), spans: [], nextSeq: {} };
  appendTxns(log, h.txns, rle);
  return log;
}

/** 把交易接到 oplog 後面（LV 必須接續）。遠端修改抵達時就是這個。 */
export function appendTxns(log: OpLog, txns: History["txns"], rle = true): void {
  const { cg, spans } = log;
  for (const t of txns) {
    const units = t.ops.reduce((n, o) => n + (o[1] > 0 ? o[1] : o[2].length), 0);
    const nextSeq = log.nextSeq;
    const s0 = nextSeq[t.agent] ?? 0;
    cgLib.add(cg, t.agent, s0, s0 + units, t.parents);
    nextSeq[t.agent] = s0 + units;
    let lv = t.start;
    let prev: OpSpan | undefined;
    for (const [pos, del, ins] of t.ops) {
      if (del > 0) {
        if (rle) {
          if (prev && !prev.ins && prev.pos === pos) prev.len += del;
          else spans.push((prev = { lv, len: del, ins: false, pos }));
        } else {
          for (let i = 0; i < del; i++) spans.push({ lv: lv + i, len: 1, ins: false, pos });
          prev = undefined;
        }
        lv += del;
      } else {
        if (rle) {
          if (prev && prev.ins && prev.pos + prev.len === pos) {
            prev.len += ins.length;
            prev.text += ins;
          } else spans.push((prev = { lv, len: ins.length, ins: true, pos, text: ins }));
        } else {
          for (let i = 0; i < ins.length; i++) spans.push({ lv: lv + i, len: 1, ins: true, pos: pos + i, text: ins[i]! });
          prev = undefined;
        }
        lv += ins.length;
      }
    }
  }
}

export const opCount = (log: OpLog): number => cgLib.nextLV(log.cg);

function spanIndexAt(spans: OpSpan[], lv: number): number {
  let lo = 0, hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid]!.lv <= lv) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 走訪 [from,to) 涵蓋的 span 片段。 */
function forEachPiece(log: OpLog, from: number, to: number, fn: (sp: OpSpan, a: number, b: number) => void): void {
  const spans = log.spans;
  for (let i = spanIndexAt(spans, from); i < spans.length; i++) {
    const sp = spans[i]!;
    if (sp.lv >= to) break;
    const a = Math.max(from, sp.lv);
    const b = Math.min(to, sp.lv + sp.len);
    if (a < b) fn(sp, a, b);
  }
}

// ---- 合併脈絡 ----

// 佔位 run 的 LV 起點，遠大於任何真實 LV；刻意留在 31 位元 Smi 範圍內，欄位才不會被 V8 升級成 double 盒子
export const PH_BASE = 2 ** 29;
const BIG = 2 ** 29;

interface DelTarget { d: number; t: number; n: number }

export class Ctx {
  seq: Seq;
  delT: DelTarget[] = [];
  curVersion: LV[];
  constructor(
    readonly log: OpLog,
    readonly snapshot: TextBuf | null,
    readonly opts: EngineOpts,
    readonly placeholderLen: number | null,
    curVersion: LV[],
  ) {
    this.seq = new Seq(opts.chunkMax);
    this.curVersion = curVersion;
    if (placeholderLen !== null && placeholderLen > 0) {
      this.seq.pushInitial({ lv: PH_BASE, len: placeholderLen, cur: 0, end: 0, oL: -1, rP: -1, ph: true, delBy: -1, chunk: NO_CHUNK });
    }
  }
}

function addDelTarget(ctx: Ctx, d: number, t: number, n: number): void {
  const a = ctx.delT;
  const last = a[a.length - 1];
  if (!last || last.d + last.n <= d) {
    if (last && last.d + last.n === d && last.t + last.n === t) last.n += n;
    else a.push({ d, t, n });
    return;
  }
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]!.d < d) lo = mid + 1;
    else hi = mid;
  }
  a.splice(lo, 0, { d, t, n });
}

function delTargetsOf(ctx: Ctx, a: number, b: number, fn: (t0: number, t1: number) => void): void {
  const arr = ctx.delT;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid]!.d <= a) lo = mid;
    else hi = mid - 1;
  }
  for (let i = lo; i < arr.length; i++) {
    const e = arr[i]!;
    if (e.d >= b) break;
    const x = Math.max(a, e.d), y = Math.min(b, e.d + e.n);
    if (x < y) fn(e.t + (x - e.d), e.t + (y - e.d));
  }
}

/** 回溯（dir=-1）或前進（dir=+1）[s,e) 範圍的操作。 */
function shift(ctx: Ctx, s: number, e: number, dir: -1 | 1): void {
  forEachPiece(ctx.log, s, e, (sp, a, b) => {
    if (sp.ins) {
      for (const r of ctx.seq.runsCovering(a, b)) ctx.seq.setCur(r, r.cur + dir);
    } else {
      delTargetsOf(ctx, a, b, (t0, t1) => {
        for (const r of ctx.seq.runsCovering(t0, t1)) ctx.seq.setCur(r, r.cur + dir);
      });
    }
  });
}

type Key = [number, number, number];
const MINK: Key = [-1, 0, 0];
const MAXK: Key = [Infinity, 0, 0];
function keyOfLv(ctx: Ctx, lv: number): Key {
  if (lv === -1) return MINK;
  const r = ctx.seq.runAt(lv);
  const [ci, ri] = ctx.seq.indexOfRun(r);
  return [ci, ri, lv - r.lv];
}
function cmpKey(a: Key, b: Key): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** 並行插入落在同一處時決定順序（Fugue／YjsMod 的掃描）；沒有並行就立刻返回。 */
function integrate(ctx: Ctx, lv: number, oL: number, rP: number, cur: Cursor): void {
  const seq = ctx.seq;
  const first = seq.peek(cur);
  if (!first || first.cur !== NYI) return;
  const left = seq.prev(cur);
  const leftKey: Key = left ? keyOfLv(ctx, left.lv + left.len - 1) : MINK;
  const rightKey: Key = rP === -1 ? MAXK : keyOfLv(ctx, rP);
  let scanning = false;
  const scan: Cursor = { ci: cur.ci, ri: cur.ri, endPos: cur.endPos };
  for (;;) {
    const other = seq.peek(scan);
    if (!other || other.cur !== NYI) break;
    const c = cmpKey(other.oL === -1 ? MINK : keyOfLv(ctx, other.oL), leftKey);
    if (c < 0) break;
    if (c === 0) {
      const r = cmpKey(other.rP === -1 ? MAXK : keyOfLv(ctx, other.rP), rightKey);
      if (r === 0 && cgLib.lvCmp(ctx.log.cg, lv, other.lv) < 0) break;
      scanning = r < 0;
    }
    scan.endPos += endWidth(other);
    scan.ri++;
    if (!scanning) {
      cur.ci = scan.ci;
      cur.ri = scan.ri;
      cur.endPos = scan.endPos;
    }
  }
}

function applyInsert(ctx: Ctx, lv: number, len: number, pos: number, text: string): void {
  const seq = ctx.seq;
  const cur = seq.findByCurPos(pos);
  const prev = pos === 0 ? undefined : seq.prev(cur);
  const oL = prev ? prev.lv + prev.len - 1 : -1;
  let rP = -1;
  {
    const scan: Cursor = { ci: cur.ci, ri: cur.ri, endPos: 0 };
    for (;;) {
      const nx = seq.peek(scan);
      if (!nx) break;
      if (nx.cur !== NYI) {
        rP = nx.oL === oL ? nx.lv : -1;
        break;
      }
      scan.ri++;
    }
  }
  integrate(ctx, lv, oL, rP, cur);
  const before = seq.prev(cur);
  if (
    ctx.opts.rle && before && rP === -1 && !before.ph && before.cur === 0 && before.end === 0 &&
    before.lv + before.len === lv && oL === before.lv + before.len - 1 && cur.ri > 0 && before.chunk === seq.chunks[cur.ci]
  ) {
    seq.grow(before, len);
  } else {
    const nr: Run = { lv, len, cur: 0, end: 0, oL, rP, ph: false, delBy: -1, chunk: NO_CHUNK };
    seq.insertRun(cur, nr);
    seq.fix(nr.chunk);
  }
  ctx.snapshot?.insert(cur.endPos, text);
}

function applyDelete(ctx: Ctx, lv: number, len: number, pos: number): void {
  const seq = ctx.seq;
  let left = len;
  let at = lv;
  while (left > 0) {
    const c = seq.findByCurPos(pos);
    let r = seq.peek(c);
    while (r && r.cur !== 0) {
      c.endPos += endWidth(r);
      c.ri++;
      r = seq.peek(c);
    }
    if (!r) throw new Error("刪除位置超出文件");
    const take = Math.min(left, r.len);
    if (take < r.len) { seq.split(r, take); seq.fix(r.chunk); }
    const visibleAtEnd = r.end === 0;
    seq.setCur(r, 1);
    seq.setEnd(r, 1);
    r.delBy = at;
    if (visibleAtEnd) ctx.snapshot?.delete(c.endPos, take);
    addDelTarget(ctx, at, r.lv, take);
    at += take;
    left -= take;
  }
}

function applyRange(ctx: Ctx, from: number, to: number): void {
  forEachPiece(ctx.log, from, to, (sp, a, b) => {
    if (sp.ins) {
      const off = a - sp.lv;
      applyInsert(ctx, a, b - a, sp.pos + off, sp.text!.slice(off, off + (b - a)));
    } else applyDelete(ctx, a, b - a, sp.pos);
  });
  ctx.seq.rebalance();
}

/** 依 LV 順序走訪 [from,to)，必要時回溯／前進，再套用。 */
export function traverse(ctx: Ctx, from: number, to: number): void {
  const cg = ctx.log.cg;
  for (const e of cgLib.iterVersionsBetween(cg, from, to)) {
    const cv = ctx.curVersion;
    const same = cv.length === e.parents.length && cv.every((v, i) => v === e.parents[i]);
    if (!same) {
      const { aOnly, bOnly } = cgLib.diff(cg, cv, e.parents);
      for (const [s, t] of aOnly) shift(ctx, s, t, -1);
      for (const [s, t] of bOnly) shift(ctx, s, t, 1);
      ctx.seq.rebalance();
    }
    applyRange(ctx, e.version, e.vEnd);
    ctx.curVersion = [e.vEnd - 1];
  }
}

// ---- 線性區段：直接套用，不建任何 CRDT 狀態 ----

function applyLinear(log: OpLog, text: TextBuf, from: number, to: number): void {
  forEachPiece(log, from, to, (sp, a, b) => {
    if (sp.ins) {
      const off = a - sp.lv;
      text.insert(sp.pos + off, sp.text!.slice(off, off + (b - a)));
    } else text.delete(sp.pos, b - a);
  });
}

/**
 * critical version：該處之前的所有操作都是它的祖先，之後的所有操作也都以它為祖先。
 * 回傳每個「條目邊界」LV（含 0 與總數）中是 critical 的那些，由小到大。
 */
export function criticalBoundaries(cg: CausalGraph): number[] {
  const es = cg.entries;
  const n = es.length;
  // sufMin[i]＝條目 i 之後（含）所有條目的最小父版本（無父＝-1）
  const sufMin = new Array<number>(n + 1);
  sufMin[n] = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    const ps = es[i]!.parents;
    let m = ps.length === 0 ? -1 : Infinity;
    for (const p of ps) if (p < m) m = p;
    sufMin[i] = Math.min(sufMin[i + 1]!, m);
  }
  const out: number[] = [0];
  let frontier: LV[] = [];
  for (let i = 0; i < n; i++) {
    const e = es[i]!;
    frontier = cgLib.advanceFrontier(frontier, e.vEnd - 1, e.parents);
    // 邊界 b＝e.vEnd：前綴的 frontier 是 [b-1]，且之後的條目父版本都 >= b-1
    if (frontier.length === 1 && frontier[0] === e.vEnd - 1 && sufMin[i + 1]! >= e.vEnd - 1) out.push(e.vEnd);
  }
  return out;
}

export interface ReplayStats { segmentsLinear: number; segmentsConcurrent: number; opsLinear: number; opsConcurrent: number }

/** 整份歷史從頭重放成文字。 */
export function replay(log: OpLog, opts: EngineOpts = DEFAULT_OPTS, stats?: ReplayStats): string {
  const total = opCount(log);
  const text = new TextBuf();
  if (!opts.skipLinear) {
    const ctx = new Ctx(log, text, opts, null, []);
    traverse(ctx, 0, total);
    return text.toString();
  }
  const bounds = criticalBoundaries(log.cg);
  if (bounds[bounds.length - 1] !== total) bounds.push(total);
  let i = 0;
  while (i < bounds.length - 1) {
    const from = bounds[i]!, to = bounds[i + 1]!;
    if (segmentIsLinear(log, from, to)) {
      applyLinear(log, text, from, to);
      if (stats) { stats.segmentsLinear++; stats.opsLinear += to - from; }
    } else {
      const ctx = new Ctx(log, text, opts, text.length, from === 0 ? [] : [from - 1]);
      traverse(ctx, from, to);
      if (stats) { stats.segmentsConcurrent++; stats.opsConcurrent += to - from; }
    }
    i++;
  }
  return text.toString();
}

/** [from,to) 內每個條目都只以前一個操作為父（或 from 處以 from-1 為父）。 */
function segmentIsLinear(log: OpLog, from: number, to: number): boolean {
  let prevLast = from - 1;
  for (const e of cgLib.iterVersionsBetween(log.cg, from, to)) {
    const ps = e.parents;
    if (prevLast < 0 ? ps.length !== 0 : ps.length !== 1 || ps[0] !== prevLast) return false;
    prevLast = e.vEnd - 1;
  }
  return true;
}

// ---- 把遠端修改合進已經載入的文件（我們真正的用法） ----

export interface Branch { text: TextBuf; version: LV[] }

export interface MergeInfo { mode: "noop" | "linear" | "crdt"; conflictOps: number; newOps: number; ctx?: Ctx }

export function mergeIntoBranch(branch: Branch, log: OpLog, mergeVersion: LV[] = log.cg.heads, opts: EngineOpts = DEFAULT_OPTS, keepCtx = false): MergeInfo {
  const newOps: LVRange[] = [];
  const conflictOps: LVRange[] = [];
  const common = cgLib.findConflicting(log.cg, branch.version, mergeVersion, (span, flag) => {
    const target = flag === cgLib.DiffFlag.B ? newOps : conflictOps;
    const last = target[target.length - 1];
    if (last && last[0] === span[1]) last[0] = span[0];
    else target.push([span[0], span[1]]);
  });
  newOps.reverse();
  conflictOps.reverse();
  const count = (rs: LVRange[]) => rs.reduce((n, r) => n + r[1] - r[0], 0);
  if (newOps.length === 0) return { mode: "noop", conflictOps: 0, newOps: 0 };

  if (conflictOps.length === 0 && opts.skipLinear && rangesAreLinear(log, branch.version, newOps)) {
    for (const [s, e] of newOps) applyLinear(log, branch.text, s, e);
    branch.version = cgLib.findDominators(log.cg, [...branch.version, ...mergeVersion]);
    return { mode: "linear", conflictOps: 0, newOps: count(newOps) };
  }

  // 共同祖先處的文件長度未知，用一個超大佔位 run 代表（只在被碰到的位置才會被切開）。
  const ctx = new Ctx(log, null, opts, BIG, common);
  for (const [s, e] of conflictOps) traverse(ctx, s, e);
  const ctx2 = new Ctx(log, branch.text, opts, null, ctx.curVersion);
  // 沿用同一份序列與刪除對應，但從這裡開始才寫入文字
  ctx2.seq = ctx.seq;
  ctx2.delT = ctx.delT;
  for (const [s, e] of newOps) traverse(ctx2, s, e);
  branch.version = cgLib.findDominators(log.cg, [...branch.version, ...mergeVersion]);
  return { mode: "crdt", conflictOps: count(conflictOps), newOps: count(newOps), ctx: keepCtx ? ctx2 : undefined };
}

function rangesAreLinear(log: OpLog, version: LV[], ranges: LVRange[]): boolean {
  let prev = version;
  for (const [s, e] of ranges) {
    for (const en of cgLib.iterVersionsBetween(log.cg, s, e)) {
      const ps = en.parents;
      if (ps.length !== prev.length || !ps.every((v, i) => v === prev[i])) return false;
      prev = [en.vEnd - 1];
    }
  }
  return true;
}

export function makeBranch(text: string, version: LV[]): Branch {
  return { text: TextBuf.from(text), version };
}

export { Seq, NYI, curWidth, endWidth };
export type { Run, CausalGraph };
