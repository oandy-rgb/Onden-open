import { describe, expect, it } from "vitest";
import { threeWayMergeBody } from "../services/eventLog/bodyMerge.js";

// Two writers add something at the same point (incoming = the later save,
// current = the server body). Found while reviewing the AI suggestion path:
// two separate paragraphs came out touching ("x\ny": one paragraph).

/** Merge both ways: a clean merge must not depend on which side is which. */
const merge = (base: string, incoming: string, current: string) => {
  const r = threeWayMergeBody(base, incoming, current);
  const back = threeWayMergeBody(base, current, incoming);
  expect(back.clean).toBe(r.clean);
  if (r.clean) expect(back.merged).toBe(r.merged);
  return r;
};
const paragraphs = (text: string) => text.split(/(?:\r?\n){2,}/);

describe("two paragraphs added at one point stay two paragraphs", () => {
  it("between two paragraphs", () => {
    expect(merge("a\n\nb\n", "a\n\nx\n\nb\n", "a\n\ny\n\nb\n").merged).toBe("a\n\nx\n\ny\n\nb\n");
  });

  it("after a list, a heading and a code block", () => {
    expect(merge("- a\n\nb\n", "- a\n\nx\n\nb\n", "- a\n\ny\n\nb\n").merged).toBe("- a\n\nx\n\ny\n\nb\n");
    expect(merge("# H\n\nb\n", "# H\n\nx\n\nb\n", "# H\n\ny\n\nb\n").merged).toBe("# H\n\nx\n\ny\n\nb\n");
    expect(merge("```\nc\n```\n\nb\n", "```\nc\n```\n\nx\n\nb\n", "```\nc\n```\n\ny\n\nb\n").merged)
      .toBe("```\nc\n```\n\nx\n\ny\n\nb\n");
  });

  it("two code blocks are not cut into one by their shared fences", () => {
    expect(merge("a\n\nb\n", "a\n\n```\nx\n```\n\nb\n", "a\n\n```\ny\n```\n\nb\n").merged)
      .toBe("a\n\n```\nx\n```\n\n```\ny\n```\n\nb\n");
  });

  it("at the end of the note, with and without a final newline", () => {
    expect(merge("a\n", "a\n\nx\n", "a\n\ny\n").merged).toBe("a\n\nx\n\ny\n");
    expect(merge("a", "a\n\nx", "a\n\ny").merged).toBe("a\n\nx\n\ny");
  });

  it("at the start of the note", () => {
    expect(merge("b\n", "x\n\nb\n", "y\n\nb\n").merged).toBe("x\n\ny\n\nb\n");
  });

  it("uses the note's own line ending", () => {
    expect(merge("a\r\n\r\nb\r\n", "a\r\n\r\nx\r\n\r\nb\r\n", "a\r\n\r\ny\r\n\r\nb\r\n").merged)
      .toBe("a\r\n\r\nx\r\n\r\ny\r\n\r\nb\r\n");
  });

  it("whichever way round, the order is the same (code-unit order of the text)", () => {
    expect(merge("a\n\nb\n", "a\n\ny\n\nb\n", "a\n\nx\n\nb\n").merged).toBe("a\n\nx\n\ny\n\nb\n");
  });

  it("multi-line paragraphs", () => {
    const r = merge("a\n\nb\n", "a\n\np1\nx2\n\nb\n", "a\n\nq1\ny2\n\nb\n");
    expect(paragraphs(r.merged)).toEqual(["a", "p1\nx2", "q1\ny2", "b\n"]);
  });

  it("lines that continue a list or paragraph (no blank around them) stay one block", () => {
    expect(merge("- a\n\nb\n", "- a\n- x\n\nb\n", "- a\n- y\n\nb\n").merged).toBe("- a\n- x\n- y\n\nb\n");
    expect(merge("a\n\nb\n", "a\n\nx\nb\n", "a\n\ny\nb\n").merged).toBe("a\n\nx\ny\nb\n");
  });
});

describe("typing that continues the other side's typing is not a conflict", () => {
  it("one side's text contains the other's, glued onto a word", () => {
    expect(merge("cat\n", "cats are\n", "cats\n")).toMatchObject({ clean: true, merged: "cats are\n" });
    expect(merge("今天\n", "今天天氣很好\n", "今天天氣\n")).toMatchObject({ clean: true, merged: "今天天氣很好\n" });
    expect(merge("cat sat\n", "cats sat\n", "cats sat down\n")).toMatchObject({ clean: true, merged: "cats sat down\n" });
  });

  it("the same addition on both sides, with another one next to it", () => {
    expect(merge("hello\n", "hellos\n", "hellos!\n")).toMatchObject({ clean: true, merged: "hellos!\n" });
  });

  it("a code block that one side continues is one block, not two", () => {
    expect(merge("a\n\nb\n", "a\n\n```js\nx\n```\n\nb\n", "a\n\n```js\nx\ny\n```\n\nb\n").merged)
      .toBe("a\n\n```js\nx\ny\n```\n\nb\n");
    expect(merge("a\n", "a\n\n```\ncode\n", "a\n\n```\n").merged).toBe("a\n\n```\ncode\n");
  });

  it("a long unclosed fence followed by shared lines merges in linear time", () => {
    const shared = Array.from({ length: 8000 }, (_, i) => `line ${i}\n`).join("");
    const t0 = performance.now();
    threeWayMergeBody("a\n", `a\n\n\`\`\`\nx\n${shared}`, `a\n\n\`\`\`\ny\n${shared}`);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

// Unchanged here (see docs/architecture/proposals/body-merge-same-line-2026-11-13.md): typing inside one line.
describe("two additions in one line still both land", () => {
  it("separate tokens, additions to different words, and glued letters", () => {
    expect(merge("ab cd\n", "abX cd\n", "ab Ycd\n").merged).toBe("abX Ycd\n");
    expect(merge("第二段 beta\n", "第二段 beta [B]\n", "第二段 beta [A]\n").merged).toBe("第二段 beta [A] [B]\n");
    expect(merge("一行", "一行B", "一行A").merged).toBe("一行AB");
  });
});
