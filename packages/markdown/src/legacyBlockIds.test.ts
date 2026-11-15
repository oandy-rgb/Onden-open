import { describe, expect, it } from "vitest";
import { hasLegacyIds, legacyIdShift, parseBlocks, stripLegacyIds, type LegacyIdConversion } from "./index";

const strip = (md: string): LegacyIdConversion => {
  const out = stripLegacyIds(md);
  if ("refused" in out) throw new Error(`refused: ${out.refused}`);
  return out;
};

describe("stripLegacyIds", () => {
  it("takes a line-end id out and anchors the same id at the block's start", () => {
    const out = strip("# 標題 ^h1\n\n第一段 {複習} ^aa11\n");
    expect(out.markdown).toBe("# 標題\n\n第一段 {複習}\n");
    expect(out.anchors.map((a) => [a.id, a.kind, out.markdown.slice(a.from, a.from + 3)])).toEqual([["h1", "heading", "# 標"], ["aa11", "paragraph", "第一段"]]);
    const anchors = out.anchors.map((a) => ({ id: a.id, from: a.from }));
    expect(parseBlocks(out.markdown, anchors).map((b) => b.ref)).toEqual(["aa11"]);
  });

  it("takes an id alone on its line (after a quote, list, table) with the blank line above it", () => {
    const out = strip("> 引文\n\n^q1\n\n- a\n- b\n\n^l1\n\n結尾 ^z9\n");
    expect(out.markdown).toBe("> 引文\n\n- a\n- b\n\n結尾\n");
    expect(out.anchors.map((a) => [a.id, a.kind])).toEqual([["q1", "quote"], ["l1", "list"], ["z9", "paragraph"]]);
  });

  it("takes `> ^id` off the last line of a quote", () => {
    const out = strip("> 引文 {考點}\n> ^q2\n\n後面\n");
    expect(out.markdown).toBe("> 引文 {考點}\n\n後面\n");
    expect(parseBlocks(out.markdown, [{ id: "q2", from: 0 }])[0]!.ref).toBe("q2");
  });

  it("handles list items, nested ones included, and keeps the others' offsets right", () => {
    const md = "- 一 {task} ^t1\n  - 二 {task} ^t2\n- 三 ^t3\n";
    const out = strip(md);
    expect(out.markdown).toBe("- 一 {task}\n  - 二 {task}\n- 三\n");
    const anchors = out.anchors.map((a) => ({ id: a.id, from: a.from }));
    expect(parseBlocks(out.markdown, anchors).map((b) => b.ref)).toEqual(["t1", "t2"]);
  });

  it("flags a repeated id instead of anchoring both", () => {
    const out = strip("甲 {a} ^dup\n\n乙 {a} ^dup\n");
    expect(out.anchors.map((a) => [a.id, a.repeat])).toEqual([["dup", false], ["dup", true]]);
  });

  it("drops an orphan id (it anchored nothing)", () => {
    expect(strip("第一段 ^a1\n\n^orphan\n\n結尾").markdown).toBe("第一段\n\n結尾");
  });

  it("leaves a body with no id alone, and ids in code stay text", () => {
    expect(strip("沒有 {標籤}\n").anchors).toEqual([]);
    const code = "```\n字 ^x1\n```\n";
    expect(strip(code)).toEqual({ markdown: code, anchors: [] });
    expect(hasLegacyIds(code)).toBe(false);
    expect(hasLegacyIds("字 ^x1")).toBe(true);
  });

  it("refuses a hashtag block (it only exists through its `^id`) instead of changing what the note means", () => {
    expect(stripLegacyIds("想法 #idea ^b1\n")).toEqual({ refused: "not_the_same_blocks" });
  });

  it("refuses a body too long to read", () => {
    expect(stripLegacyIds(`${"字".repeat(40_000)} ^a1`)).toEqual({ refused: "too_long" });
  });

  it("is idempotent", () => {
    const once = strip("甲 {a} ^a1\n\n> 引\n\n^q1\n");
    expect(strip(once.markdown)).toEqual({ markdown: once.markdown, anchors: [] });
  });
});

describe("legacyIdShift", () => {
  it("moves a place in the text with the marks to the same text without them", () => {
    const md = "第一段 ^aa11\n\n- [ ] 做事 {task}\n\n引用\n\n^bb22\n\n結尾\n";
    const out = strip(md);
    const at = legacyIdShift(md);
    for (const piece of ["第一段", "- [ ] 做事 {task}", "引用", "結尾"]) {
      const from = md.indexOf(piece);
      expect(out.markdown.slice(at(from), at(from + piece.length)), piece).toBe(piece);
    }
    expect(at(md.length)).toBe(out.markdown.length);
  });

  it("is the identity for a body with no mark", () => {
    const at = legacyIdShift("段落\n\n另一段\n");
    expect([0, 3, 9].map(at)).toEqual([0, 3, 9]);
  });
});

describe("writeLegacyIds (the way back)", () => {
  it("round-trips every shape: strip(write(x)) gives x back", async () => {
    const { writeLegacyIds } = await import("./index");
    for (const md of [
      "# 標題 ^h1\n\n第一段 {複習} ^aa11\n",
      "> 引文\n\n^q1\n\n- a\n- b\n\n^l1\n\n結尾 ^z9\n",
      "- 一 {task} ^t1\n  - 二 {task} ^t2\n- 三 ^t3\n",
    ]) {
      const stripped = strip(md);
      const anchors = stripped.anchors.map((a) => ({ id: a.id, from: a.from, to: a.to }));
      const back = writeLegacyIds(stripped.markdown, anchors);
      expect(back.skipped).toEqual([]);
      expect(strip(back.markdown).markdown).toBe(stripped.markdown);
      expect(strip(back.markdown).anchors.map((a) => a.id).sort()).toEqual(anchors.map((a) => a.id).sort());
    }
  });
  it("skips an anchor that no block starts at", async () => {
    const { writeLegacyIds } = await import("./index");
    expect(writeLegacyIds("字\n", [{ id: "zz", from: 99, to: 100 }])).toEqual({ markdown: "字\n", written: [], skipped: ["zz"] });
  });
});
