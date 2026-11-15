// 合成「從共同版本分兩支、各自改 N 處」的情境。固定種子可重現。
// 編輯先以「取代 base[s,e) 為 ins」的形式在 base 座標規劃（同一支內互不重疊），再隨機排定套用順序，
// 換算成逐步套用的 [位置, 刪除長度, 插入文字]（UTF-16）——這就是編輯器實際送出的樣子。
import { makeRng, type Rng } from "./prng.js";
import { genNote, genPhrase, genSentence } from "./genNote.js";
import { lineSpans, sentenceIndexAt, sentenceSpans, type Span } from "./sentences.js";
import { TextBuf } from "./textBuf.js";
import type { ForkScenario, PatchOp, Txn } from "./types.js";

export interface BaseOp { s: number; e: number; ins: string; kind: string }
type Side = 0 | 1; // 0=A 1=B

const TOKEN_RE = /[A-Za-z0-9_'-]+|[一-鿿]{1,3}|[^\sA-Za-z0-9_'一-鿿]/gu;

function tokensIn(base: string, [s, e]: Span): Span[] {
  const out: Span[] = [];
  const seg = base.slice(s, e);
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(seg); m; m = TOKEN_RE.exec(seg)) out.push([s + m.index, s + m.index + m[0].length]);
  return out;
}

/** 這一支已排定的編輯（依 s 排序）。 */
class OpSet {
  ops: BaseOp[] = [];
  private lowerBound(s: number): number {
    let lo = 0, hi = this.ops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ops[mid]!.s < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  fits(s: number, e: number): boolean {
    const i = this.lowerBound(s);
    const prev = this.ops[i - 1];
    if (prev && prev.e > s) return false; // 前一個的範圍蓋到 s（插入點 s 落在其內部）
    if (e === s) {
      // 插入點：不可在別人範圍內部（prev 已查；後面 s 起算的不算內部）
      return true;
    }
    for (let j = i; j < this.ops.length; j++) {
      const o = this.ops[j]!;
      if (o.s >= e) break;
      if (o.s === s && o.e === o.s) continue; // 同點的插入放在範圍之前
      return false;
    }
    return true;
  }
  add(o: BaseOp): void {
    let i = this.lowerBound(o.s);
    // 同一點多個插入：維持加入順序；範圍編輯排在同點插入之後
    while (i < this.ops.length && this.ops[i]!.s === o.s && this.ops[i]!.e === o.s) i++;
    this.ops.splice(i, 0, o);
  }
}

function build(base: string, sides: [OpSet, OpSet], rng: Rng): { patches: [PatchOp[], PatchOp[]]; texts: [string, string] } {
  const patches: [PatchOp[], PatchOp[]] = [[], []];
  const texts: [string, string] = ["", ""];
  for (const side of [0, 1] as const) {
    const ops = sides[side].ops;
    // 直接結果：由後往前取代
    let direct = base;
    for (let i = ops.length - 1; i >= 0; i--) direct = direct.slice(0, ops[i]!.s) + ops[i]!.ins + direct.slice(ops[i]!.e);
    texts[side] = direct;
    // 隨機套用順序
    const order = ops.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = rng.int(i + 1); [order[i], order[j]] = [order[j]!, order[i]!]; }
    const applied: Array<{ op: BaseOp; rank: number }> = [];
    for (const idx of order) {
      const o = ops[idx]!;
      let pos = o.s;
      for (const { op: a, rank } of applied) {
        // 同一點的插入：排在前面（rank 小）的先出現在文字裡，所以只有它會推動這個編輯
        if (a.s < o.s || (a.s === o.s && a.e === a.s && rank < idx)) pos += a.ins.length - (a.e - a.s);
      }
      if (o.e > o.s) patches[side].push([pos, o.e - o.s, ""]);
      if (o.ins.length > 0) patches[side].push([pos, 0, o.ins]);
      applied.push({ op: o, rank: idx });
    }
  }
  return { patches, texts };
}

export function makeFork(sizeBytes: number, edits: number, seed: number): ForkScenario {
  const rng = makeRng(seed * 1000003 + sizeBytes + edits * 7);
  const base = genNote(sizeBytes, rng);
  const sents = sentenceSpans(base);
  const lines = lineSpans(base);
  const owner = new Uint8Array(sents.length); // bit0=A bit1=B
  const sets: [OpSet, OpSet] = [new OpSet(), new OpSet()];
  const kinds: Record<string, number> = {};
  const count = (k: string) => { kinds[k] = (kinds[k] ?? 0) + 1; };
  const bit = (s: Side) => (s === 0 ? 1 : 2);

  const mark = (s: Side, a: number, b: number) => {
    const lo = sentenceIndexAt(sents, Math.max(0, a - (b === a ? 1 : 0)));
    const hi = sentenceIndexAt(sents, Math.max(0, b - 1));
    for (let i = Math.max(0, lo); i <= hi && i < sents.length; i++) owner[i]! |= bit(s);
  };
  const place = (side: Side, o: BaseOp): boolean => {
    if (!sets[side].fits(o.s, o.e)) return false;
    sets[side].add(o);
    mark(side, o.s, o.e);
    return true;
  };
  const ownerOk = (side: Side, i: number) => (owner[i]! & bit((1 - side) as Side)) === 0;

  // ---- 共用位置（兩支都碰）----
  const shared = Math.min(Math.round(edits * 0.1), Math.floor(sents.length / 4));
  const sharedKinds = ["同行不同句", "同句不同詞", "同一詞改不同字", "同處各插一句", "一邊刪句一邊改句"] as const;
  let sharedDone = 0;
  for (let n = 0; n < shared * 6 && sharedDone < shared; n++) {
    const kind = sharedKinds[sharedDone % sharedKinds.length]!;
    const i = rng.int(sents.length);
    if (owner[i]! !== 0) continue;
    const ss = sents[i]!;
    const toks = tokensIn(base, ss);
    if (toks.length < 5) continue;
    let a: BaseOp, b: BaseOp;
    if (kind === "同行不同句") {
      const li = lines.findIndex(([s, e]) => ss[0] >= s && ss[1] <= e);
      const j = i + 1;
      if (li < 0 || j >= sents.length || owner[j]! !== 0 || sents[j]![1] > lines[li]![1] || sents[j]![0] < lines[li]![0]) continue;
      const t2 = tokensIn(base, sents[j]!);
      if (t2.length < 3) continue;
      const x = toks[1 + rng.int(toks.length - 2)]!, y = t2[1 + rng.int(t2.length - 2)]!;
      a = { s: x[0], e: x[1], ins: genPhrase(rng), kind };
      b = { s: y[0], e: y[1], ins: genPhrase(rng), kind };
      owner[j]! |= 3;
    } else if (kind === "同句不同詞") {
      const t1 = 1 + rng.int(Math.floor(toks.length / 2) - 1), t2 = Math.floor(toks.length / 2) + 1 + rng.int(Math.floor(toks.length / 2) - 2);
      a = { s: toks[t1]![0], e: toks[t1]![1], ins: genPhrase(rng), kind };
      b = { s: toks[t2]![0], e: toks[t2]![1], ins: genPhrase(rng), kind };
    } else if (kind === "同一詞改不同字") {
      const t = toks[1 + rng.int(toks.length - 2)]!;
      a = { s: t[0], e: t[1], ins: genPhrase(rng), kind };
      b = { s: t[0], e: t[1], ins: genPhrase(rng), kind };
    } else if (kind === "同處各插一句") {
      const p = ss[1];
      a = { s: p, e: p, ins: genSentence(rng), kind };
      b = { s: p, e: p, ins: genSentence(rng), kind };
    } else {
      const t = toks[1 + rng.int(toks.length - 2)]!;
      a = { s: ss[0], e: ss[1], ins: "", kind };
      b = { s: t[0], e: t[1], ins: genPhrase(rng), kind };
    }
    if (!sets[0].fits(a.s, a.e) || !sets[1].fits(b.s, b.e)) continue;
    sets[0].add(a); sets[1].add(b);
    owner[i]! |= 3;
    count(kind); count(kind);
    sharedDone++;
  }

  // ---- 各自的獨立編輯 ----
  const kindsOf: Array<[string, number]> = [["插入詞", 0.28], ["刪除一段", 0.15], ["改一個詞", 0.2], ["加一句", 0.15], ["刪一句", 0.08], ["搬段落", 0.14]];
  const pickKind = () => { let r = rng.next(); for (const [k, w] of kindsOf) { if ((r -= w) < 0) return k; } return "插入詞"; };
  for (const side of [0, 1] as const) {
    let have = sets[side].ops.length;
    const sharedMine = have;
    let moves = 0;
    let guard = 0;
    while (have - moves < edits && guard++ < edits * 60) {
      void sharedMine;
      const kind = pickKind();
      const i = rng.int(sents.length);
      if (!ownerOk(side, i)) continue;
      const ss = sents[i]!;
      const toks = tokensIn(base, ss);
      const ok = (o: BaseOp): boolean => {
        // 跨支：這個編輯碰到的句子不可被對方碰過
        const lo = sentenceIndexAt(sents, Math.max(0, o.s - (o.e === o.s ? 1 : 0))), hi = sentenceIndexAt(sents, Math.max(0, o.e - 1));
        for (let k = Math.max(0, lo); k <= hi && k < sents.length; k++) if (!ownerOk(side, k)) return false;
        return place(side, o);
      };
      if (kind === "搬段落") {
        const [ls, le] = lines[rng.int(lines.length)]!;
        if (le - ls > 500 || le - ls < 4) continue;
        const dst = lines[rng.int(lines.length)]![0];
        if (dst >= ls && dst <= le) continue;
        const text = base.slice(ls, le);
        if (!sets[side].fits(ls, le) || !sets[side].fits(dst, dst)) continue;
        let blocked = false;
        for (let k = sentenceIndexAt(sents, ls); k >= 0 && k < sents.length && sents[k]![0] < le; k++) if (!ownerOk(side, k)) blocked = true;
        if (blocked) continue;
        place(side, { s: ls, e: le, ins: "", kind });
        place(side, { s: dst, e: dst, ins: text, kind });
        count(kind);
        have += 2; moves++;
        continue;
      }
      let o: BaseOp;
      if (kind === "加一句") o = { s: ss[1], e: ss[1], ins: genSentence(rng), kind };
      else if (kind === "刪一句") o = { s: ss[0], e: ss[1], ins: "", kind };
      else if (toks.length < 3) continue;
      else {
        const t = toks[1 + rng.int(toks.length - 2)]!;
        if (kind === "插入詞") o = { s: t[1], e: t[1], ins: genPhrase(rng), kind };
        else if (kind === "刪除一段") { const t2 = toks[Math.min(toks.length - 1, toks.indexOf(t) + rng.int(3))]!; o = { s: t[0], e: t2[1], ins: "", kind }; }
        else o = { s: t[0], e: t[1], ins: genPhrase(rng), kind };
      }
      if (ok(o)) { count(kind); have++; }
    }
  }

  const { patches, texts } = build(base, sets, rng);
  // 驗證：逐步套用的結果必須等於直接取代的結果
  for (const side of [0, 1] as const) {
    const buf = TextBuf.from(base);
    for (const [p, d, s] of patches[side]) { if (d > 0) buf.delete(p, d); else buf.insert(p, s); }
    if (buf.toString() !== texts[side]) throw new Error(`情境產生器自我檢查失敗（side ${side}）`);
  }

  const baseLen = base.length;
  const units = (ps: PatchOp[]) => ps.reduce((n, o) => n + (o[1] > 0 ? o[1] : o[2].length), 0);
  const uA = units(patches[0]), uB = units(patches[1]);
  const txns: Txn[] = [
    { agent: "base", start: 0, parents: [], ops: [[0, 0, base]] },
    { agent: "A", start: baseLen, parents: [baseLen - 1], ops: patches[0] },
    { agent: "B", start: baseLen + uA, parents: [baseLen - 1], ops: patches[1] },
  ];
  return {
    id: `${Math.round(sizeBytes / 1024)}KB-${edits}`,
    sizeBytes, edits, seed, base, textA: texts[0], textB: texts[1],
    history: { txns },
    baseHead: baseLen - 1,
    rangeA: [baseLen, baseLen + uA],
    rangeB: [baseLen + uA, baseLen + uA + uB],
    kinds,
  };
}

export const SIZES = [10 * 1024, 50 * 1024, 200 * 1024] as const;
export const EDIT_COUNTS = [10, 100, 1000] as const;

/** 情境 (c)：本機已有 base＋A，遠端送來一筆修改，它的父版本是 A 的倒數第 10 筆之前（與最後 10 筆並行）。 */
export interface RemoteEdit {
  txn: Txn;
  /** 遠端那一筆修改所依據的文字 */
  parentText: string;
  /** 遠端修改完的文字（＝遠端傳來的「incoming」） */
  remoteText: string;
  /** 本機歷史（base＋A）＋遠端那筆 */
  historyWithRemote: { txns: Txn[] };
  historyLocal: { txns: Txn[] };
}

export function makeRemote(sc: ForkScenario): RemoteEdit {
  const rng = makeRng(sc.seed * 7919 + sc.edits);
  const aOps = sc.history.txns[1]!.ops;
  const k = Math.max(0, aOps.length - 10);
  const buf = TextBuf.from(sc.base);
  let cum = 0;
  for (let i = 0; i < k; i++) {
    const [p, d, s] = aOps[i]!;
    if (d > 0) { buf.delete(p, d); cum += d; } else { buf.insert(p, s); cum += s.length; }
  }
  const parentText = buf.toString();
  const parentLv = k === 0 ? sc.baseHead : sc.rangeA[0] + cum - 1;
  const ls = lineSpans(parentText);
  const at = ls[rng.int(ls.length)]![0];
  const phrase = genSentence(rng);
  const remoteText = parentText.slice(0, at) + phrase + parentText.slice(at);
  const txn: Txn = { agent: "R", start: sc.rangeA[1], parents: [parentLv], ops: [[at, 0, phrase]] };
  const local = sc.history.txns.slice(0, 2);
  return { txn, parentText, remoteText, historyLocal: { txns: local }, historyWithRemote: { txns: [...local, txn] } };
}
