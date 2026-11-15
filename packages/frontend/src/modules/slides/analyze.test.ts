import { describe, expect, it } from "vitest";
import { analyzeSlide, slideBlockText, itemText, listItems } from "./analyze";

const kinds = (md: string) => analyzeSlide(md).map((block) => block.kind);

describe("a slide's blocks are the ones the app reads", () => {
  it("reads a table without outer pipes, indented code and a callout as the renderer does", () => {
    expect(kinds("a | b\n-|-\n1 | 2")).toEqual(["table"]);
    expect(kinds("    indented code")).toEqual(["code"]);
    expect(kinds("> [!note] Title\n> body")).toEqual(["quote"]);
  });

  it("`***` is a rule, not text", () => {
    expect(kinds("one\n\n***\n\ntwo")).toEqual(["paragraph", "paragraph"]);
  });

  it("a list under a paragraph line, and a list in a quote, are found by the tree", () => {
    expect(kinds("intro\n- a\n- b")).toEqual(["paragraph", "list"]);
    expect(kinds("> - a\n> - b")).toEqual(["quote"]);
  });

  it("a heading's words have no marks; a `^abc123` at the end is text now (the id is an anchor, not in the text)", () => {
    expect(analyzeSlide("## **Plan** [[Note]]")[0]!.heading).toEqual({ level: 2, text: "Plan Note" });
    expect(analyzeSlide("## Plan ^abc123")[0]!.heading?.text).toBe("Plan ^abc123");
  });

  it("a setext heading is one block whose markdown is its words", () => {
    const [heading] = analyzeSlide("Title\n=====");
    expect(heading.heading?.text).toBe("Title");
    expect(heading.markdown).toBe("Title");
  });
});

describe("pictures and embeds", () => {
  it("one or several pictures in a line are an image block", () => {
    expect(kinds("![a](a.png) ![b](b.png)")).toEqual(["image"]);
  });

  it("whole-line embeds (a drawing, a note, a task list) are embed blocks, several lines included", () => {
    expect(kinds("![[手寫]]")).toEqual(["embed"]);
    expect(kinds("![[Note#Part]]\n![[Other]]")).toEqual(["embed"]);
    expect(kinds("![a](a.png)\n![[Note]]")).toEqual(["embed"]);
  });

  it("an embed inside a sentence is text", () => {
    expect(kinds("see ![[Note]] here")).toEqual(["paragraph"]);
  });
});

describe("a list's items as plain words", () => {
  const [list] = analyzeSlide("- [ ] **bold** [[Link|label]] \n- [x] done\n  - nested\n- 2024. a year");

  it("drops the bullet and the task box, and keeps a nested list inside its item", () => {
    expect(listItems(list)).toEqual(["**bold** [[Link|label]]", "done\n  - nested", "2024. a year"]);
  });

  it("reads each item without marks or links' syntax; the item's own words are not mistaken for a mark", () => {
    expect(listItems(list).map(itemText)).toEqual(["bold label", "done nested", "2024. a year"]);
    expect(slideBlockText(list)).toBe("bold label\ndone nested\n2024. a year");
  });
});
