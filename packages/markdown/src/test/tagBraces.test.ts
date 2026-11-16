// A `{…}` at a line's end is a block's tags only when it holds nothing but tag entries (text.ts isTagList).
// Found on the owner's tablet, 2026-11-17: Lex rules typed as ordinary paragraphs — `^[ \\t]+ { indent(); ECHO; }` —
// became the tags "indent(); ECHO;" and "return c >= 'A' && c <= 'Z';". Every reader of the trailing braces asks the
// one rule (guards/tagBraces.guard.test.ts), so they cannot disagree on whether the braces are tags or words.
import { describe, expect, it } from "vitest";
import { addBlockTag, blockTagSlot, parseBlocks } from "../blocks.js";
import { withoutLineTrailers } from "../blockId.js";
import { isTagList, isTagNameShape } from "../text.js";
import { planBlockExpand } from "../blockChild.js";

const tagsOf = (markdown: string): string[][] => parseBlocks(markdown).map((block) => block.tags);

describe("which `{…}` are tags", () => {
  it.each([
    ["task", true],
    ["考點, 複習", true],
    ["my tag", true],
    ["讀書（小說）", true],
    ["50%", true],
    ["what next?", true],
    ["C++", true],
    ["Q&A", true],
    ["v1.2", true],
    ["a, ", true],
    ["priority: high", true],
    ["", true],
    // program text
    [" indent(); ECHO; ", false],
    [" return c >= 'A' && c <= 'Z'; ", false],
    [" /* 丟掉行首原本的空白 */ ", false],
    ["x = 1", false],
    ["a[0]", false],
    ['"quoted"', false],
    ["a | b", false],
    ["$x", false],
    ["task, f()", false],
    ["area/work", false],
    ["it's", false],
    ["C#", false],
    ["key: f()", false],
  ])("{%s} → %s", (inner, expected) => {
    expect(isTagList(inner)).toBe(expected);
  });

  it("the owner's notes: Lex rules written as paragraphs carry no tags", () => {
    expect(tagsOf("^[ \\t]+ { /* 丟掉行首原本的空白 */ }\n^[ \\t]+    { indent(); ECHO; }")).toEqual([]);
    expect(tagsOf("[A-Z]      { return c >= 'A' && c <= 'Z'; }")).toEqual([]);
    expect(tagsOf("- item { f(x); }")).toEqual([]);
    expect(tagsOf("## Heading { a = b }")).toEqual([]);
  });

  it("ordinary tag braces still are tags", () => {
    expect(tagsOf("買牛奶 {task}")).toEqual([["task"]]);
    expect(tagsOf("一段話 {考點, 複習}")).toEqual([["考點", "複習"]]);
    expect(tagsOf("- item {my tag}")).toEqual([["my tag"]]);
    expect(tagsOf("## 標題 {讀書（小說）}")).toEqual([["讀書（小說）"]]);
  });

  it("one entry of program text makes the whole `{…}` text: no half-read tag list", () => {
    expect(tagsOf("line {task, f()}")).toEqual([]);
  });

  it("the tag slot the editor writes into does not open program braces: a new tag gets its own `{…}`", () => {
    const line = "^[ \\t]+ { indent(); ECHO; }";
    expect(blockTagSlot(line, 0)?.braces).toBeNull();
    const tagged = addBlockTag(line, 0, "考點")!;
    expect(tagged.startsWith(line)).toBe(true);
    expect(tagsOf(tagged)).toEqual([["考點"]]);
  });

  it("a name the grammar cannot hold is refused, not written as text", () => {
    expect(addBlockTag("一段話", 0, "f(x);")).toBeNull();
    expect(addBlockTag("一段話", 0, "Q&A")).toBe("一段話 {Q&A}");
  });

  it("a tag name is valid exactly when a `{…}` can hold it: the name rule and the brace rule are one", () => {
    for (const name of ["研究", "reading list", "C++", "Q&A", "讀書（小說）"]) {
      expect(isTagNameShape(name), name).toBe(true);
      expect(tagsOf(`一段話 {${name}}`), name).toEqual([[name]]);
    }
    for (const name of ["a/b", "C#", "x, y", "key:value", "f(x)", "it's", "a = b", " padded", ""]) expect(isTagNameShape(name), name).toBe(false);
  });

  it("turning a child note back into a paragraph refuses a tag it could not write, instead of dropping it", () => {
    const embed = { indent: "" } as Parameters<typeof planBlockExpand>[1];
    expect(planBlockExpand("x", embed, "一段話", { tags: ["f(x)"] })).toEqual({ refused: "child_tag_not_writable" });
  });

  it("text shown small keeps program braces and drops tag braces", () => {
    expect(withoutLineTrailers("買牛奶 {task}")).toBe("買牛奶");
    expect(withoutLineTrailers("^[ \\t]+ { indent(); ECHO; }")).toBe("^[ \\t]+ { indent(); ECHO; }");
  });
});
