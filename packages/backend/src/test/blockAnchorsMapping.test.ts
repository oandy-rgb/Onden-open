// Block anchor mapping rules (services/blockAnchors/mapping.ts) — pure, no database.
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { moveAnchors, FIND_BUDGET, type AnchorState } from "../services/blockAnchors/mapping.js";
import { dice, findQuote, lineAlign, quoteAt } from "../services/blockAnchors/similarity.js";
import { deriveChangeSet, verifiedEditorChanges } from "../services/blockAnchors/changes.js";
import { blockSpanAt } from "../services/blockAnchors/store.js";

const P = ["第一段：二分搜尋要先排序，再比較中間值。", "第二段：雜湊表用鍵直接算出位置，碰撞要另外處理。", "第三段：圖的最短路徑可以用 Dijkstra，不能有負邊。"];
const DOC = P.join("\n\n");

function anchorOn(doc: string, para: number, id = "a1"): AnchorState {
  const start = doc.indexOf(P[para]!);
  const span = lineAlign(doc, { from: start, to: start + P[para]!.length });
  return { anchorId: id, span, quote: quoteAt(doc, span), status: "valid", candidate: null, recoveryPending: false };
}
const run = (a: AnchorState[], before: string | null, after: string, extra: Partial<Parameters<typeof moveAnchors>[1]> = {}) =>
  moveAnchors(a, { before, after, trusted: () => true, ...extra });
const textOf = (doc: string, m: { span: { from: number; to: number } }) => doc.slice(m.span.from, m.span.to);

describe("moving by position", () => {
  it("follows an insertion before the block", () => {
    const after = "新增的一行\n\n" + DOC;
    const [m] = run([anchorOn(DOC, 1)], DOC, after);
    expect(m!.status).toBe("valid");
    expect(textOf(after, m!)).toBe(P[1]);
    expect(m!.how).toBe("diff");
  });
  it("follows an edit inside the block and refreshes the quote", () => {
    const edited = P[1]!.replace("碰撞要另外處理", "碰撞用鏈結處理");
    const after = [P[0], edited, P[2]].join("\n\n");
    const [m] = run([anchorOn(DOC, 1)], DOC, after);
    expect(m!.status).toBe("valid");
    expect(textOf(after, m!)).toBe(edited);
    expect(m!.quote.text).toBe(edited);
  });
  it("a list marker and task box put in front of the block keep its start on the new list item", () => {
    const start = DOC.indexOf(P[1]!);
    for (const prefix of ["- ", "- [ ] ", "1. [ ] 15:00 "]) {
      const after = DOC.slice(0, start) + prefix + DOC.slice(start);
      const [m] = run([anchorOn(DOC, 1)], DOC, after, { editorChanges: ChangeSet.of({ from: start, insert: prefix }, DOC.length) });
      expect(m!.status).toBe("valid");
      expect(m!.span.from).toBe(start);
    }
    // Ordinary text typed in front still pushes the start past it.
    const [typed] = run([anchorOn(DOC, 1)], DOC, DOC.slice(0, start) + "新" + DOC.slice(start), { editorChanges: ChangeSet.of({ from: start, insert: "新" }, DOC.length) });
    expect(typed!.span.from).toBe(start + 1);
  });
  it("typing at the end of the block does not widen it", () => {
    const after = DOC.replace(P[1]!, P[1]! + "加的字");
    const [m] = run([anchorOn(DOC, 1)], DOC, after, { editorChanges: ChangeSet.of({ from: DOC.indexOf(P[1]!) + P[1]!.length, insert: "加的字" }, DOC.length) });
    expect(m!.how).toBe("unchanged");
    expect(textOf(after, m!)).toBe(P[1]);
  });
  it("uses the editor's own ChangeSet when it is given", () => {
    const after = "前" + DOC;
    const [m] = run([anchorOn(DOC, 1)], DOC, after, { editorChanges: ChangeSet.of({ from: 0, insert: "前" }, DOC.length) });
    expect(m!.how).toBe("editor");
    expect(textOf(after, m!)).toBe(P[1]);
  });
  it("unchanged text is reported unchanged", () => {
    const [m] = run([anchorOn(DOC, 0)], DOC, DOC + "\n\n尾巴");
    expect(m!.how).toBe("unchanged");
    expect(m!.changed).toBe(false);
  });
  it("a whole-block rewrite never keeps pointing at the new, unrelated text", () => {
    const after = [P[0], "完全不相干的另一個主題：今天午餐吃什麼，咖啡要不要加糖。", P[2]].join("\n\n");
    const [m] = run([anchorOn(DOC, 1)], DOC, after);
    expect(m!.status).not.toBe("valid");
  });
});

describe("finding by quote", () => {
  it("a moved block is found again (cut and pasted elsewhere in the note)", () => {
    const after = [P[1], P[0], P[2]].join("\n\n");
    const [m] = run([anchorOn(DOC, 1)], DOC, after);
    expect(m!.status).toBe("valid");
    expect(textOf(after, m!)).toBe(P[1]);
  });
  it("positions measured on another version are not trusted, the quote decides", () => {
    const after = "前言\n\n" + DOC;
    const [m] = run([anchorOn(DOC, 2)], DOC, after, { trusted: () => false });
    expect(m!.status).toBe("valid");
    expect(textOf(after, m!)).toBe(P[2]);
  });
  it("with no old text at all, the quote still finds it", () => {
    const [m] = run([anchorOn(DOC, 0)], null, "前言\n\n" + DOC);
    expect(textOf("前言\n\n" + DOC, m!)).toBe(P[0]);
  });
  it("two equally good matches: maybe, never valid", () => {
    const twin = P[1]!.replace("第二段", "第四段");
    const after = [P[0], twin, "中間隔一段別的內容在這裡", twin.replace("第四段", "第五段")].join("\n\n");
    const a = anchorOn(DOC, 1);
    a.quote = { text: twin.replace("第四段", "第三段"), prefix: "", suffix: "" };
    const [m] = run([a], DOC, after, { trusted: () => false });
    expect(m!.status).toBe("maybe");
    expect(m!.candidate).not.toBeNull();
  });
  it("a deleted block is lost, not pointed elsewhere; the original text is kept to retry", () => {
    const after = [P[0], P[2]].join("\n\n");
    const [m] = run([anchorOn(DOC, 1)], DOC, after);
    expect(m!.status).toBe("lost");
    expect(m!.quote.text).toBe(P[1]);
  });
  it("a lost anchor comes back when the text returns", () => {
    const gone = [P[0], P[2]].join("\n\n");
    const [lost] = run([anchorOn(DOC, 1)], DOC, gone);
    const [back] = run([lost!], gone, DOC);
    expect(back!.status).toBe("valid");
    expect(textOf(DOC, back!)).toBe(P[1]);
  });
  it("beyond the per-save budget the rest are marked pending and retried next time", () => {
    const many = Array.from({ length: FIND_BUDGET + 2 }, (_, i) => `獨一無二的第${i}條筆記內容：${"字".repeat(8 + i)}${i}`);
    const doc = many.join("\n\n");
    const anchors = many.map((t, i): AnchorState => {
      const from = doc.indexOf(t);
      const span = { from, to: from + t.length };
      return { anchorId: `m${i}`, span, quote: quoteAt(doc, span), status: "valid", candidate: null, recoveryPending: false };
    });
    const reversed = [...many].reverse().join("\n\n");
    const first = run(anchors, doc, reversed, { trusted: () => false });
    expect(first.filter((m) => m.recoveryPending)).toHaveLength(2);
    const second = run(first, reversed, reversed, { trusted: () => false });
    expect(second.every((m) => m.status === "valid" && !m.recoveryPending)).toBe(true);
  });
});

describe("paragraphs that differ by one character (position and order beat similarity)", () => {
  const LONG = "雜湊表用鍵直接算出位置，碰撞要另外處理，常見的做法有鏈結法與開放定址法，負載因子太高時要重新配置並重新雜湊。";
  const TWIN = [`${LONG}甲`, `${LONG}乙`];
  const DOC2 = ["前言", TWIN[0], TWIN[1], "結語"].join("\n\n");
  const on = (doc: string, text: string, id: string): AnchorState => {
    const start = doc.indexOf(text);
    const span = lineAlign(doc, { from: start, to: start + text.length });
    return { anchorId: id, span, quote: quoteAt(doc, span), status: "valid", candidate: null, recoveryPending: false };
  };
  const both = () => [on(DOC2, TWIN[0]!, "first"), on(DOC2, TWIN[1]!, "second")];

  it("deleting the first of two near-identical paragraphs does not move its anchor onto the second", () => {
    const after = ["前言", TWIN[1], "結語"].join("\n\n");
    const [first, second] = run(both(), DOC2, after);
    expect(first!.status).not.toBe("valid");
    expect(second!.status).toBe("valid");
    expect(textOf(after, second!)).toBe(TWIN[1]);
  });

  it("looked up by quote with no trusted position, each anchor takes its own paragraph (the exact one)", () => {
    const after = ["新的前言", TWIN[0], TWIN[1], "結語"].join("\n\n");
    const [first, second] = run(both(), DOC2, after, { trusted: () => false });
    expect(first!.status).toBe("valid");
    expect(textOf(after, first!)).toBe(TWIN[0]);
    expect(second!.status).toBe("valid");
    expect(textOf(after, second!)).toBe(TWIN[1]);
  });

  it("two anchors never end up valid on one block", () => {
    const after = ["前言", TWIN[0], "結語"].join("\n\n");
    const moved = run(both(), DOC2, after, { trusted: () => false });
    const valid = moved.filter((m) => m.status === "valid");
    expect(new Set(valid.map((m) => m.span.from)).size).toBe(valid.length);
    expect(valid.map((m) => m.anchorId)).toEqual(["first"]);
  });
});

describe("editor change sets are not taken on trust", () => {
  it("accepts a ChangeSet that turns before into after", () => {
    const cs = ChangeSet.of({ from: 0, insert: "X" }, DOC.length);
    expect(verifiedEditorChanges(cs.toJSON(), DOC, "X" + DOC)).not.toBeNull();
  });
  it("refuses one for another version, or garbage", () => {
    const cs = ChangeSet.of({ from: 0, insert: "X" }, DOC.length);
    expect(verifiedEditorChanges(cs.toJSON(), DOC, "Y" + DOC)).toBeNull();
    expect(verifiedEditorChanges(cs.toJSON(), DOC + "!", "X" + DOC + "!")).toBeNull();
    expect(verifiedEditorChanges({ nope: 1 }, DOC, DOC)).toBeNull();
  });
  it("a derived ChangeSet always reproduces the new text", () => {
    const after = DOC.replace("二分搜尋", "線性搜尋").replace(P[2]!, "") + "\n\n結尾";
    expect(deriveChangeSet(DOC, after).apply(Text.of(DOC.split("\n"))).toString()).toBe(after);
  });
});

describe("similarity", () => {
  it("dice is 1 for equal text ignoring whitespace and low for unrelated text", () => {
    expect(dice("a b\nc", "abc")).toBe(1);
    expect(dice(P[0]!, P[2]!)).toBeLessThan(0.3);
  });
  it("findQuote of an exact line is valid and unique", () => {
    expect(findQuote(quoteAt(DOC, lineAlign(DOC, { from: 0, to: 3 })), DOC).outcome).toBe("valid");
  });
});

describe("blockSpanAt", () => {
  it("is the run of non-blank lines around the offset; null on a blank line", () => {
    const doc = "a\nb\n\nc";
    expect(blockSpanAt(doc, 0)).toEqual({ from: 0, to: 3 });
    expect(blockSpanAt(doc, 2)).toEqual({ from: 0, to: 3 });
    expect(blockSpanAt(doc, 4)).toBeNull();
    expect(blockSpanAt(doc, 5)).toEqual({ from: 5, to: 6 });
  });
});

// 業主 2026-11-08: a paragraph cut in two keeps its anchor on the half with the `{…}` (else the first half).
// The editor applies the same rule (@onden/markdown splitAnchorSpan); here the server moves the anchor over the edit.
describe("a paragraph cut in two (Enter)", () => {
  const cutAt = (doc: string, at: number, insert = "\n\n") => ({ after: doc.slice(0, at) + insert + doc.slice(at), cs: ChangeSet.of({ from: at, insert }, doc.length) });
  const anchorAll = (doc: string): AnchorState => {
    const span = { from: 0, to: doc.length };
    return { anchorId: "a1", span, quote: quoteAt(doc, span), status: "valid", candidate: null, recoveryPending: false };
  };
  const body = "二分搜尋要先排序，再比較中間值，找到就回傳位置，找不到就回傳負一";

  it("the tag in the second half: the anchor moves to the second half", () => {
    const doc = `${body} {複習}`;
    const { after, cs } = cutAt(doc, 14);
    const [m] = run([anchorAll(doc)], doc, after, { editorChanges: cs });
    expect(m!.status).toBe("valid");
    expect(textOf(after, m!)).toBe(`${body.slice(14)} {複習}`);
    expect(m!.quote.text).toBe(textOf(after, m!));
  });
  it("the tag in the first half (cut after it): the anchor stays on the first half", () => {
    const doc = `${body} {複習}`;
    const { after, cs } = cutAt(doc, doc.length);
    const [m] = run([anchorAll(doc)], doc, after, { editorChanges: cs });
    expect(textOf(after, m!)).toBe(doc);
    expect(m!.how).toBe("unchanged");
  });
  it("no tag: the anchor stays on the first half (§5.3)", () => {
    const [m] = run([anchorAll(body)], body, cutAt(body, 14).after, { editorChanges: cutAt(body, 14).cs });
    expect(textOf(cutAt(body, 14).after, m!)).toBe(body.slice(0, 14));
  });
  it("derived from a plain text diff (no editor ChangeSet) it lands on the same half", () => {
    const doc = `${body} {複習}`;
    const { after } = cutAt(doc, 14);
    const [m] = run([anchorAll(doc)], doc, after);
    expect(textOf(after, m!)).toBe(`${body.slice(14)} {複習}`);
  });
  it("a span that held two paragraphs on purpose is not narrowed", () => {
    const doc = `${P[0]}\n\n${P[1]} {複習}`;
    const span = { from: 0, to: doc.length };
    const a: AnchorState = { anchorId: "a1", span, quote: quoteAt(doc, span), status: "valid", candidate: null, recoveryPending: false };
    const { after, cs } = cutAt(doc, P[0]!.length + 4);
    const [m] = run([a], doc, after, { editorChanges: cs });
    expect(textOf(after, m!)).toBe(after);
  });
});
