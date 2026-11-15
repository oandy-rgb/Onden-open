import { describe, expect, it } from "vitest";
import { anchored } from "./test/helpers/anchored.js";
import { addBlockTag, blockTagSlot, blockTagSlotsIn, parseBlocks } from "./blocks.js";

const at = (md: string, needle: string) => md.indexOf(needle) + 1;

describe("blockTagSlot / addBlockTag (B2b)", () => {
  it("writes {tag} at the end of a paragraph, and parseBlocks reads it back", () => {
    const md = "Intro.\n\nBinary search halves the range.\n";
    const out = addBlockTag(md, at(md, "halves"), "考點")!;
    expect(out).toBe("Intro.\n\nBinary search halves the range. {考點}\n");
    expect(parseBlocks(out)).toMatchObject([{ kind: "paragraph", tags: ["考點"] }]);
  });

  it("tags the list item the caret is in, not its parent item", () => {
    const md = "- parent\n  - child line\n- other\n";
    const out = addBlockTag(md, at(md, "child"), "複習")!;
    expect(out).toBe("- parent\n  - child line {複習}\n- other\n");
  });

  it("a task line keeps its checkbox and gets the tag at the end", () => {
    const md = "- [ ] 寫下三個習慣\n";
    expect(addBlockTag(md, 3, "作業")).toBe("- [ ] 寫下三個習慣 {作業}\n");
  });

  it("adds to an existing {…}; a `^id` in the text is plain text, not a place to write before", () => {
    const md = "- item {a}\n";
    expect(addBlockTag(md, 2, "b")).toBe("- item {a, b}\n");
    const plain = "text ^ab12\n";
    expect(addBlockTag(plain, 1, "x")).toBe("text ^ab12 {x}\n");
    // The line no longer ends with the braces, so they are not the block's tags.
    expect(addBlockTag("- item {a} ^k3f9\n", 2, "b")).toBe("- item {a} ^k3f9 {b}\n");
  });

  it("a name it already has (any case) changes nothing", () => {
    const md = "text {Course}\n";
    expect(addBlockTag(md, 1, "course")).toBe(md);
  });

  it("a heading's tag goes on the heading line; a paragraph under it is its own block", () => {
    const md = "## Week 1\n\nBody text.\n";
    expect(addBlockTag(md, at(md, "Week"), "課程")).toBe("## Week 1 {課程}\n\nBody text.\n");
    expect(addBlockTag(md, at(md, "Body"), "課程")).toBe("## Week 1\n\nBody text. {課程}\n");
  });

  it("a quote takes its tag on the first line", () => {
    const md = "> first line\n> second line\n";
    expect(addBlockTag(md, at(md, "second"), "q")).toBe("> first line {q}\n> second line\n");
  });

  it("no block in code, a table or a blank line", () => {
    const md = "```\ncode\n```\n\n| a |\n|---|\n| b |\n";
    expect(blockTagSlot(md, at(md, "code"))).toBeNull();
    expect(blockTagSlot(md, at(md, "| b"))).toBeNull();
  });

  it("literal braces in code are not a tag slot", () => {
    const md = "use `{x}`\n";
    expect(blockTagSlot(md, 1)).toMatchObject({ braces: null, tags: [] });
    expect(addBlockTag(md, 1, "t")).toBe("use `{x}` {t}\n");
  });
});

describe("ParsedBlock.checkbox (B4)", () => {
  it("a task list item reports its box and where the mark sits", () => {
    const marked = anchored("- [ ] 寫作業 {task} ^t1\n  - [x] 第一題 {task} ^t2\n- 普通 {a} ^p1\n");
    const md = marked.markdown;
    const blocks = parseBlocks(md, marked.anchors);
    const byRef = new Map(blocks.map((b) => [b.ref, b]));
    expect(byRef.get("t1")!.checkbox).toEqual({ checked: false, at: md.indexOf("[ ]") + 1 });
    expect(byRef.get("t2")!.checkbox).toEqual({ checked: true, at: md.indexOf("[x]") + 1 });
    expect(byRef.get("p1")!.checkbox).toBeNull();
    expect(md[byRef.get("t2")!.checkbox!.at]).toBe("x");
  });
});

describe("blockTagSlotsIn (加標籤 on a selection)", () => {
  const range = (md: string, from: string, to = from) => blockTagSlotsIn(md, md.indexOf(from), md.indexOf(to) + to.length);
  const starts = (md: string, from: string, to = from) => range(md, from, to).map((slot) => md.slice(slot.start, slot.start + 5));

  it("finds each paragraph the selection touches, in order, ends cut in the middle included", () => {
    const md = "one two\n\nthree four\n\nfive six\n\nseven\n";
    expect(starts(md, "two", "five")).toEqual(["one t", "three", "five "]);
  });

  it("a selection inside one paragraph finds just that paragraph", () => {
    const md = "one\n\ntwo words here\n";
    expect(starts(md, "words")).toEqual(["two w"]);
  });

  it("takes list items by their own first line, nested items on their own", () => {
    const md = "- parent\n  - child a\n  - child b\n- other\n";
    expect(starts(md, "child a", "child b")).toEqual(["- chi", "- chi"]);
    expect(starts(md, "parent", "other")).toHaveLength(4);
  });

  it("a heading counts by its line, not by its section; the paragraphs under it are their own", () => {
    const md = "# Title\n\nunder it\n\n## Next\n\nlater\n";
    expect(starts(md, "under it")).toEqual(["under"]);
    expect(starts(md, "Title", "under it")).toEqual(["# Tit", "under"]);
  });

  it("a quote is one block, tagged on its first paragraph", () => {
    const md = "> quoted words\n> more\n\nafter\n";
    expect(range(md, "more", "after").map((slot) => slot.kind)).toEqual(["quote", "paragraph"]);
  });

  it("finds nothing in code, a table or front matter", () => {
    expect(blockTagSlotsIn("```\ncode here\n```\n", 5, 9)).toEqual([]);
    expect(blockTagSlotsIn("---\ntitle: x\n---\n\nbody\n", 4, 22).map((s) => s.kind)).toEqual(["paragraph"]);
    expect(blockTagSlotsIn("---\ntitle: x\n---\n", 4, 12)).toEqual([]);
  });

  it("each slot tags like blockTagSlot: the same block, the same tags already there", () => {
    const md = "first {a}\n\nsecond\n";
    const [one, two] = range(md, "first", "second");
    expect(one).toEqual(blockTagSlot(md, one!.start));
    expect(two).toEqual(blockTagSlot(md, two!.start));
    expect(one!.tags).toEqual(["a"]);
  });
});
