// Anchor path: does the state an anchor ends in depend only on the text before and after, or also on HOW the text got
// there (one save or many, with or without the editor's ChangeSet, which order)?  Pure — services/blockAnchors/mapping.ts.
//
// Owner finding 2026-11-16: 「錨點的狀態取決於存檔分批，這和分散式同步要求的確定性互相衝突。」
// Proposal: docs/architecture/proposals/anchors-deterministic-2026-11-16.md. NO product code changes here.
//
// `it.fails` = the two paths DIFFER today, one line says which rule makes them differ (the assertion states what a
// path-independent design would give; fixing the product flips it, and vitest then asks for the `.fails` to be removed).
// plain `it` = the two paths already agree.
// Compared: span, status, candidate, quote (text/prefix/suffix), recoveryPending (helpers/anchorPath.ts).

import { describe, expect, it } from "vitest";
import { FIND_BUDGET } from "../services/blockAnchors/mapping.js";
import { anchorOn, csOf, diffStates, recoveryPass, save, walk, withoutLostSpan } from "./helpers/anchorPath.js";

const P = [
  "二分搜尋要先排序，再比較中間值，找不到就縮小範圍。",
  "雜湊表用鍵直接算出位置，碰撞要另外處理，例如鏈結法。",
  "圖的最短路徑可以用 Dijkstra，但是邊的權重不能是負數。",
  "動態規劃要先找出子問題，再記下答案避免重算。",
  "堆積可以快速取出最大值，插入和刪除都是對數時間。",
  "排序演算法裡快速排序平均最快，但最壞情況很慢。",
  "字串比對可以用 KMP，先建立失敗函式再掃描文字。",
  "平衡二元樹靠旋轉維持高度，查詢時間才穩定。",
];
const doc = (ps: string[]) => ps.join("\n\n");
const anchorsOf = (d: string, ps: string[]) => ps.map((p, i) => anchorOn(d, p, `a${i}`));
const same = (a: ReturnType<typeof walk>, b: ReturnType<typeof walk>) => { expect(diffStates(a, b)).toEqual([]); expect(a).toEqual(b); };

// A paragraph rewritten a little at a time: every step still resembles the previous one, the last does not resemble the first.
const REWRITE = [
  P[1]!,
  "雜湊表用鍵直接算出位置，碰撞要另外處理，可以用鏈結。",
  "雜湊表用鍵直接算出位置，碰撞用開放定址，可以用鏈結。",
  "雜湊表用鍵直接算出位置，碰撞用開放定址，探測要小心。",
  "散列表用鍵直接算出位置，碰撞用開放定址，探測要小心。",
  "散列表把鍵算成位置，碰撞用開放定址，探測要小心。",
  "散列表把鍵算成位置，碰撞以開放定址法解決，探測宜小心。",
];
const rewriteDocs = REWRITE.map((r) => doc(P.map((p, i) => (i === 1 ? r : p))));

describe("anchor path (a): one save vs the same edit in many saves", () => {
  it.fails("anchor path: a paragraph rewritten in six small saves stays valid, in one save it is lost — mapping.ts KEEP_MOVED is checked against the quote refreshed by the previous save", () => {
    const start = anchorsOf(rewriteDocs[0]!, P);
    same(walk(start, rewriteDocs), walk(start, [rewriteDocs[0]!, rewriteDocs.at(-1)!]));
  });
  it("anchor path: the anchors of the paragraphs that were not touched agree either way", () => {
    const start = anchorsOf(rewriteDocs[0]!, P);
    const many = walk(start, rewriteDocs), one = walk(start, [rewriteDocs[0]!, rewriteDocs.at(-1)!]);
    expect(many.filter((a) => a.anchorId !== "a1")).toEqual(one.filter((a) => a.anchorId !== "a1"));
  });
});

describe("anchor path (b): the editor's ChangeSet vs a derived diff", () => {
  const ten = "好好好好好好好好好好";
  const d1 = doc(["前", ten, "後"]);
  const at = d1.indexOf(ten);
  it.fails("anchor path: one character typed in front of a block of the same character — the editor's ChangeSet keeps the block after it, the line/char diff puts the insertion at the other end (mapping.ts changes(): editorChanges ?? deriveChangeSet)", () => {
    const d2 = d1.slice(0, at) + "好" + d1.slice(at);
    const start = [anchorOn(d1, ten, "b")];
    same(save(start, d1, d2, csOf(d1, { from: at, insert: "好" })), save(start, d1, d2));
  });
  it("anchor path: typing at the end of the block agrees", () => {
    const e = at + ten.length, d2 = d1.slice(0, e) + "好" + d1.slice(e);
    const start = [anchorOn(d1, ten, "b")];
    same(save(start, d1, d2, csOf(d1, { from: e, insert: "好" })), save(start, d1, d2));
  });
  it("anchor path: text inserted before the block, and an edit inside it, agree", () => {
    const d = doc(P.slice(0, 3)), start = anchorsOf(d, P.slice(0, 3));
    const before = "新增的一行\n\n" + d;
    same(save(start, d, before, csOf(d, { from: 0, insert: "新增的一行\n\n" })), save(start, d, before));
    const inside = d.replace("碰撞要另外處理", "碰撞用鏈結處理");
    const from = d.indexOf("要另外處理");
    same(save(start, d, inside, csOf(d, { from, to: from + 3, insert: "用鏈結" })), save(start, d, inside));
  });
  it("anchor path: a paragraph cut in two by Enter agrees (cutParagraphAt exists to make the two routes equal)", () => {
    const d = doc(P.slice(0, 3)), start = anchorsOf(d, P.slice(0, 3));
    const cut = d.indexOf("再比較中間值");
    const after = d.slice(0, cut) + "\n\n" + d.slice(cut);
    same(save(start, d, after, csOf(d, { from: cut, insert: "\n\n" })), save(start, d, after));
  });
});

describe("anchor path (c): more anchors needing a lookup than FIND_BUDGET", () => {
  const d0 = doc(P), start = anchorsOf(d0, P);
  const reversed = doc([...P].reverse());
  // the same reversal as a bubble sort: each save moves one paragraph one step, so at most one lookup per save
  function bubble() {
    let cur = [...P], anchors = start, prev = d0;
    for (let i = 0; i < cur.length; i++) {
      for (let j = 0; j < cur.length - 1 - i; j++) {
        const n = [...cur]; [n[j], n[j + 1]] = [n[j + 1]!, n[j]!];
        const nd = doc(n);
        anchors = save(anchors, prev, nd); prev = nd; cur = n;
      }
    }
    expect(prev).toBe(reversed);
    return anchors;
  }
  it("anchor path: the fixture really needs more than FIND_BUDGET lookups in one save", () => {
    expect(P.length).toBeGreaterThan(FIND_BUDGET + 1);
    expect(save(start, d0, reversed).filter((a) => a.recoveryPending).length).toBeGreaterThan(0);
  });
  it.fails("anchor path: reversing eight paragraphs in one save leaves some maybe+pending until the pass; moved one step at a time every one is valid at once — mapping.ts FIND_BUDGET", () => {
    same(save(start, d0, reversed), bubble());
  });
  it("anchor path: after the recovery pass the one-save result agrees with the many-save result", () => {
    same(recoveryPass(save(start, d0, reversed), reversed), bubble());
  });
  it.fails("anchor path: a pending anchor whose paragraph is then rewritten — with the pass run in between it is lost at the new place, without it the next save finds it elsewhere (when the pass runs changes the stored state; recover.ts / mapping.ts lookup uses the current body)", () => {
    const rewritten = reversed.replace(P[7]!, "AVL 樹與紅黑樹都靠旋轉；查詢最壞也是對數時間。");
    const s1 = save(start, d0, reversed);
    same(save(s1, reversed, rewritten), save(recoveryPass(s1, reversed), reversed, rewritten));
  });
});

describe("anchor path (d): a body that arrives already merged vs the writer's own sequence", () => {
  // From the receiving node's view: its anchors are at the OLD body, the next body it gets is the other node's final text
  // (merged or not), never the writer's intermediate saves.
  it.fails("anchor path: the writer's six saves vs the body jumping to the final text — same cause as (a), the second node cannot reproduce the first node's state", () => {
    const start = anchorsOf(rewriteDocs[0]!, P);
    const writer = walk(start, rewriteDocs);
    const otherNode = save(start, rewriteDocs[0]!, rewriteDocs.at(-1)!);
    same(otherNode, writer);
  });
  it("anchor path: a paragraph deleted in one save and typed back unchanged in a later one ends where a body that never changed would", () => {
    const d = doc(P), start = anchorsOf(d, P);
    const without = doc(P.filter((_, i) => i !== 3));
    same(walk(start, [d, without, d]), walk(start, [d, d]));
  });
  it("anchor path: two edits in two different paragraphs arriving as one merged body agree with the two saves", () => {
    const d0 = doc(P), start = anchorsOf(d0, P);
    const e1 = doc(P.map((p, i) => (i === 1 ? p + "再補一句說明。" : p)));
    const e2 = doc(P.map((p, i) => (i === 1 ? p + "再補一句說明。" : i === 5 ? "新：" + p : p)));
    same(walk(start, [d0, e1, e2]), walk(start, [d0, e2]));
  });
});

describe("anchor path (e): two orders of the same two edits", () => {
  const a = "快速排序先選一個基準值，", b = "再把比它小的放左邊、比它大的放右邊，", c = "最後對兩邊遞迴處理直到只剩一個元素。";
  const para = a + b + c;
  const X = "合併排序先切成兩半並且各自排序好，接著把兩個結果合併成一個有序序列，" + c; // rewrites the first two sentences
  const Y = a + b + "最後對兩邊遞迴處理，直到每一塊都只剩一個元素為止。"; // rewrites the last
  const XY = "合併排序先切成兩半並且各自排序好，接著把兩個結果合併成一個有序序列，最後對兩邊遞迴處理，直到每一塊都只剩一個元素為止。";
  const wrap = (m: string) => doc(["前言", m, "後記"]);
  it.fails("anchor path: two edits to different sentences of one paragraph — X then Y ends lost, Y then X ends valid (each save compares with the quote the previous save refreshed)", () => {
    const base = wrap(para), start = [anchorOn(base, para, "e")];
    same(walk(start, [base, wrap(X), wrap(XY)]), walk(start, [base, wrap(Y), wrap(XY)]));
  });
  it("anchor path: two edits to two different paragraphs agree in either order", () => {
    const d0 = doc(P), start = anchorsOf(d0, P);
    const up = (ps: string[], i: number, t: string) => ps.map((p, k) => (k === i ? t : p));
    const E1 = "二分搜尋要先排序，再比較中間值，找不到就縮小範圍，最後回傳位置。", E2 = "圖的最短路徑可以用 Dijkstra，邊的權重不能是負數，否則改用 Bellman-Ford。";
    const afterBoth = up(up(P, 0, E1), 2, E2);
    same(walk(start, [d0, doc(up(P, 0, E1)), doc(afterBoth)]), walk(start, [d0, doc(up(P, 2, E2)), doc(afterBoth)]));
  });
  it.fails("anchor path: an edit that loses one paragraph and an unrelated edit before it — in either order the lost anchor's stored span differs (it is where the anchor last stood; mapping.ts lookup branch copies `...a`)", () => {
    const d0 = doc(P), start = anchorsOf(d0, P);
    const lostEdit = P[3]!.replace(/.*/, "完全不同的內容：樹狀結構與遞迴走訪，先序、中序、後序三種順序各有用途。");
    const upstream = P[0]! + "多加了幾個字。";
    const withEdits = (a: boolean, b: boolean) => doc(P.map((p, i) => (i === 0 && a ? upstream : i === 3 && b ? lostEdit : p)));
    const lostFirst = walk(start, [d0, withEdits(false, true), withEdits(true, true)]);
    const shiftFirst = walk(start, [d0, withEdits(true, false), withEdits(true, true)]);
    same(lostFirst, shiftFirst);
  });
  it("anchor path: the same two edits agree in status, candidate, quote and pending flag (the lost anchor's span aside)", () => {
    const d0 = doc(P), start = anchorsOf(d0, P);
    const lostEdit = "完全不同的內容：樹狀結構與遞迴走訪，先序、中序、後序三種順序各有用途。";
    const withEdits = (a: boolean, b: boolean) => doc(P.map((p, i) => (i === 0 && a ? P[0]! + "多加了幾個字。" : i === 3 && b ? lostEdit : p)));
    const x = walk(start, [d0, withEdits(false, true), withEdits(true, true)]);
    const y = walk(start, [d0, withEdits(true, false), withEdits(true, true)]);
    expect(withoutLostSpan(x)).toEqual(withoutLostSpan(y));
  });
});
