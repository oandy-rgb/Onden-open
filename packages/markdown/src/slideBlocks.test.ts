import { describe, expect, it } from "vitest";
import { topBlocks } from "./slideBlocks";

const read = (md: string) => topBlocks(md).map((b) => ({ kind: b.kind, text: md.slice(b.from, b.to) }));

describe("topBlocks: the app's own reading of a note's top-level blocks", () => {
  it("reads tables with no outer pipes, indented code, callouts and `***` as the renderer does", () => {
    expect(read("a | b\n-|-\n1 | 2").map((b) => b.kind)).toEqual(["table"]);
    expect(read("    code").map((b) => b.kind)).toEqual(["code"]);
    expect(read("> [!note] Title\n> body").map((b) => b.kind)).toEqual(["quote"]);
    expect(read("a\n\n***\n\nb").map((b) => b.kind)).toEqual(["paragraph", "rule", "paragraph"]);
  });

  it("a list right under a paragraph line is its own block", () => {
    expect(read("intro\n- a\n- b").map((b) => b.kind)).toEqual(["paragraph", "list"]);
  });

  it("a heading has the words the app reads (no marks); a setext heading spans its underline", () => {
    const md = "## **Plan** {a}\n\nTitle\n=====";
    const [first, second] = topBlocks(md);
    expect(first!.heading).toMatchObject({ depth: 2, text: "Plan" });
    expect(md.slice(second!.from, second!.to)).toBe("Title\n=====");
    expect(second!.heading?.text).toBe("Title");
  });

  it("list items start at their words: no bullet, and no task box even when the words open with emphasis", () => {
    const md = "- [ ] **bold** one\n- [x] two\n  - nested\n- plain";
    const [list] = topBlocks(md);
    expect(list!.items!.map((i) => md.slice(i.from, i.to))).toEqual(["**bold** one", "two\n  - nested", "plain"]);
    expect(list!.items!.map((i) => i.checked)).toEqual([false, true, null]);
  });

  it("a paragraph made only of pictures is an image, one made only of whole-line embeds is an embed, a mix is an embed", () => {
    expect(read("![a](a.png) ![b](b.png)").map((b) => b.kind)).toEqual(["image"]);
    expect(read("![[手寫]]").map((b) => b.kind)).toEqual(["embed"]);
    expect(read("![[Note#Part]]\n![[Other|label]]").map((b) => b.kind)).toEqual(["embed"]);
    expect(read("![a](a.png)\n![[x]]").map((b) => b.kind)).toEqual(["embed"]);
  });

  it("anything with other words in it stays a paragraph", () => {
    expect(read("see ![[Note]] here").map((b) => b.kind)).toEqual(["paragraph"]);
    expect(read("text ![a](a.png)").map((b) => b.kind)).toEqual(["paragraph"]);
  });

  it("math blocks are math", () => {
    expect(read("$$\nx^2\n$$").map((b) => b.kind)).toEqual(["math"]);
  });
});
