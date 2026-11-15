import { describe, expect, it } from "vitest";
import { blockCardSides, blockNeighbours, CLOZE_GAP, type BlockCardSides } from "./blockCard.js";
import { anchored } from "./test/helpers/anchored.js";

/** The card of the block with id `ref` in a note written with `^id` marks (turned into anchors first). */
const sides = (legacy: string, ref: string): BlockCardSides | null => { const a = anchored(legacy); return blockCardSides(a.markdown, ref, a.anchors); };

describe("blockCardSides (B3)", () => {
  it("a list item asks; its nested items answer", () => {
    const md = "- 二分搜尋的時間複雜度？ {複習} ^q1\n  - O(log n)\n  - 每次砍半\n- other\n";
    expect(sides(md, "q1")).toEqual({ front: "二分搜尋的時間複雜度？", back: "- O(log n)\n- 每次砍半" });
  });

  it("a cloze hides the marked words on the front and bolds them on the back", () => {
    const md = "二分搜尋的時間複雜度是 ==O(log n)== {複習} ^c1\n";
    expect(sides(md, "c1")).toEqual({
      front: `二分搜尋的時間複雜度是 ${CLOZE_GAP}`, back: "二分搜尋的時間複雜度是 **O(log n)**",
    });
  });

  it("a heading asks; its section answers", () => {
    const md = "## FSRS 是什麼 {複習} ^h1\n\n一種排程演算法。\n\n## Next\n";
    expect(sides(md, "h1")).toEqual({ front: "FSRS 是什麼", back: "一種排程演算法。" });
  });

  it("a one-line paragraph is a front with no back; a task box is not shown", () => {
    expect(sides("記得喝水 {複習} ^p1\n", "p1")).toEqual({ front: "記得喝水", back: "" });
    expect(sides("- [ ] 背單字 {複習} ^t1\n", "t1")).toEqual({ front: "背單字", back: "" });
  });

  it("null when the note has no block node with that id", () => {
    expect(sides("plain ^x1\n", "x1")).toBeNull();
    expect(blockCardSides("a {複習}\n", "p1", [])).toBeNull(); // no anchor starts at the block
    expect(sides("a {複習} ^p1\n", "zz")).toBeNull();
  });
});

describe("blockNeighbours", () => {
  const near = (legacy: string, ref: string) => { const a = anchored(legacy); return blockNeighbours(a.markdown, ref, a.anchors); };

  it("the paragraphs before and after, as plain prose without their marks", () => {
    expect(near("# 標題\n\n**先備**知識。 {筆記}\n\n問題？ {複習} ^p1\n\n接著看 [[例子]]。\n", "p1"))
      .toEqual({ before: "先備知識。", after: "接著看 例子。" });
  });

  it("nothing before the first paragraph or after the last", () => {
    expect(near("問題？ {複習} ^p1\n", "p1")).toEqual({ before: null, after: null });
  });

  it("a list item's own nested lines are not what comes after", () => {
    expect(near("- 前一項\n- 問題？ {複習} ^q1\n  - 答案\n- 後一項\n", "q1")).toEqual({ before: "前一項", after: "後一項" });
  });

  it("a long neighbour is cut, and a missing block is null", () => {
    const before = near(`${"長".repeat(500)}\n\n問題？ {複習} ^p1\n`, "p1")!.before!;
    expect(before).toHaveLength(400);
    expect(before.endsWith("…")).toBe(true);
    expect(near("a ^x\n", "zz")).toBeNull();
  });
});
