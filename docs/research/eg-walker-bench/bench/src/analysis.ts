// 合併結果比較與「同一句重疊」偵測。
//
// 偵測規則（建議給 Eg-walker 之上的衝突判斷用）：
//   1. 兩支各自對「共同版本 base」做了哪些改動，用 base 座標表示：
//        刪除 → base 區間 [x,y)；插入 → base 的一個間隙 p（落在 base 第 p-1 與第 p 個單位之間）。
//      這些資訊 Eg-walker 本來就有：佔位 run 就是 base，被切開的片段順序就是 base 順序，
//      每個刪除操作記得它刪了哪些 LV，每個插入 run 前面累計的佔位單位數就是它的間隙 p。
//   2. 把 base 切成句（sentences.ts）。刪除碰到的所有句，以及「落在句子內部（start<p<end）」的插入，
//      都算「這一支碰了這句」。插在句與句之間的邊界不算碰任何句（只是新增句子）。
//   3. 某一句被兩支都碰了 → 同一句重疊 → 依業主規則算衝突（保留後存的一份並標示）；
//      其餘（各改各的句子，即使同一行）可乾淨合併。
import { PH_BASE, type Ctx } from "./proto/engine.js";
import { sentenceIndexAt, sentenceSpans, type Span } from "./sentences.js";
import type { BodyConflict } from "../../../../../packages/backend/src/services/eventLog/bodyMerge.js";

export interface Touches {
  /** 刪除的 base 區間 */
  dels: Span[];
  /** 插入的 base 間隙 */
  inserts: number[];
}

export function touchSets(ctx: Ctx, rangeA: [number, number], rangeB: [number, number]): [Touches, Touches] {
  const sideOf = (lv: number): 0 | 1 => (lv >= rangeA[0] && lv < rangeA[1] ? 0 : 1);
  void rangeB;
  const t: [Touches, Touches] = [{ dels: [], inserts: [] }, { dels: [], inserts: [] }];
  let basePos = 0;
  for (const r of ctx.seq.iter()) {
    if (r.ph) basePos += r.len;
    else if (r.end === 0) t[sideOf(r.lv)].inserts.push(basePos);
  }
  for (const e of ctx.delT) {
    if (e.t >= PH_BASE) t[sideOf(e.d)].dels.push([e.t - PH_BASE, e.t - PH_BASE + e.n]);
  }
  return t;
}

/** 這一支碰到的句子集合。 */
export function touchedSentences(spans: Span[], t: Touches): Set<number> {
  const out = new Set<number>();
  for (const [x, y] of t.dels) {
    const lo = sentenceIndexAt(spans, x), hi = sentenceIndexAt(spans, y - 1);
    for (let i = Math.max(0, lo); i <= hi && i < spans.length; i++) out.add(i);
  }
  for (const p of t.inserts) {
    const i = sentenceIndexAt(spans, p);
    if (i >= 0 && spans[i]![0] < p) out.add(i); // 句內部（start<p<end）；p===start 是邊界，不算
  }
  return out;
}

export function overlapSentences(base: string, a: Touches, b: Touches): number[] {
  const spans = sentenceSpans(base);
  const ta = touchedSentences(spans, a), tb = touchedSentences(spans, b);
  return [...ta].filter((i) => tb.has(i)).sort((x, y) => x - y);
}

/** diff3 的衝突區在 base 裡的位置（依序在 base 裡找 conflict.base 的文字；空字串＝插入點衝突，無法定位）。 */
export function locateConflicts(base: string, conflicts: BodyConflict[]): Array<Span | null> {
  let from = 0;
  return conflicts.map((c) => {
    if (c.base.length === 0) return null;
    const at = base.indexOf(c.base, from);
    if (at < 0) return null;
    from = at + c.base.length;
    return [at, from] as Span;
  });
}

export interface SiteReport {
  /** 同一句重疊的句數（依業主規則應為衝突） */
  overlapSentences: number;
  /** diff3 的衝突區數 */
  diff3Conflicts: number;
  /** diff3 衝突區中，區內沒有任何「同一句重疊」的（行粒度造成的假衝突；Eg-walker 能乾淨合） */
  diff3FalseConflicts: number;
  /** 沒有位置資訊的 diff3 衝突（base 為空：同一點插入）*/
  diff3PointConflicts: number;
  /** 同一句重疊，但 diff3 沒有判衝突（默默合併了） */
  overlapNotFlaggedByDiff3: number;
}

export function compareSites(base: string, a: Touches, b: Touches, conflicts: BodyConflict[]): SiteReport {
  const spans = sentenceSpans(base);
  const ov = overlapSentences(base, a, b);
  const located = locateConflicts(base, conflicts);
  const covered = new Set<number>();
  let falseC = 0, point = 0;
  located.forEach((loc) => {
    if (!loc) { point++; return; }
    const lo = sentenceIndexAt(spans, loc[0]), hi = sentenceIndexAt(spans, loc[1] - 1);
    let has = false;
    for (let i = Math.max(0, lo); i <= hi && i < spans.length; i++) if (ov.includes(i)) { has = true; covered.add(i); }
    if (!has) falseC++;
  });
  return {
    overlapSentences: ov.length,
    diff3Conflicts: conflicts.length,
    diff3FalseConflicts: falseC,
    diff3PointConflicts: point,
    overlapNotFlaggedByDiff3: ov.filter((i) => !covered.has(i)).length,
  };
}
