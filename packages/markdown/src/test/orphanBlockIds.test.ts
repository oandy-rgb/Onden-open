import { describe, expect, it } from "vitest";
import { legacyOrphanIds, parseBlocks, stripLegacyIds } from "../index";

// The orphan reading is the migration's: an `^id` alone in a paragraph that anchors nothing is dropped with the other marks.
const marks = (md: string) => legacyOrphanIds(md).map((s) => md.slice(s.from, s.to));

describe("legacyOrphanIds", () => {
  it("finds an id alone in a paragraph that anchors nothing", () => {
    expect(marks("第一段 ^a1\n\n^b49b6a\n\n結尾")).toEqual(["^b49b6a"]);
    expect(marks("# 標題\n\n^zz9\n")).toEqual(["^zz9"]);
  });

  it("keeps the standalone ids after a list, table or quote", () => {
    expect(marks("- a\n- b\n\n^l1")).toEqual([]);
    expect(marks("| a | b |\n| - | - |\n| 1 | 2 |\n\n^t1")).toEqual([]);
    expect(marks("> 引用\n\n^q1")).toEqual([]);
    expect(marks("> 引用\n> ^q2")).toEqual([]);
  });

  it("ignores ids in code and ids that end a line of text", () => {
    expect(marks("```\n^x1\n```\n\n字 ^ok1")).toEqual([]);
  });
});

describe("stripLegacyIds and a deleted block", () => {
  it("drops an orphan id with its line, and anchors only the blocks that are still there", () => {
    const out = stripLegacyIds("第一 {重要} ^aa11\n\n^bb22\n");
    expect("refused" in out).toBe(false);
    if ("refused" in out) return;
    expect(out.markdown).toBe("第一 {重要}\n");
    expect(out.anchors.map((a) => a.id)).toEqual(["aa11"]);
    expect(parseBlocks(out.markdown, out.anchors).map((b) => b.ref)).toEqual(["aa11"]);
  });
});
