import { describe, expect, it } from "vitest";
import { embedEditable, extractBlock, extractSection } from "./index";
import { anchored } from "./test/helpers/anchored.js";

// A block's id is an anchor row, not text: notes are written with `^id` marks and turned into text + anchors first.
const block = (legacy: string, id: string): string | null => { const a = anchored(legacy); return extractBlock(a.markdown, id, a.anchors); };

describe("extractBlock", () => {
  it("returns a paragraph by its anchor", () => {
    expect(block("Intro\n\nThe point. ^pt\n\nAfter", "pt")).toBe("The point.");
  });

  it("returns a list item with its nested items", () => {
    const md = "- one\n- two ^b1\n  - child a\n  - child b\n- three";
    expect(block(md, "b1")).toBe("- two\n  - child a\n  - child b");
  });

  it("dedents a nested list item", () => {
    const md = "- top\n  - inner ^in\n    - leaf\n- next";
    expect(block(md, "in")).toBe("- inner\n  - leaf");
  });

  it("returns a quote", () => {
    expect(block("> a wise line\n> second line\n\n^q1\n\nafter", "q1")).toBe("> a wise line\n> second line");
    expect(block("> only line\n> ^q2\n", "q2")).toBe("> only line");
  });

  it("returns a heading with its section", () => {
    const md = "# Top\n\n## Part ^pp\n\nbody\n\n### Sub\n\nmore\n\n## Next\n\nno";
    expect(block(md, "pp")).toBe("## Part\n\nbody\n\n### Sub\n\nmore");
  });

  it("reads CJK text", () => {
    expect(block("前言\n\n這是重點。 ^zh-1\n\n結尾", "zh-1")).toBe("這是重點。");
  });

  it("is null for a missing id", () => {
    expect(block("text ^a\n", "b")).toBeNull();
    expect(extractBlock("", "a", [])).toBeNull();
  });

  it("a `^id` in the text is not an anchor", () => {
    expect(extractBlock("text ^a\n", "a", [])).toBeNull();
  });

  it("an anchor in code names no block", () => {
    const md = "```\nfake line\n```\n\nreal\n";
    expect(extractBlock(md, "code", [{ id: "code", from: 4, to: 13 }])).toBeNull();
    expect(extractBlock(md, "real", [{ id: "real", from: md.indexOf("real"), to: md.indexOf("real") + 4 }])).toBe("real");
  });

  it("an anchor the text has moved away from names no block (it does not read another one)", () => {
    const md = "inserted line\n\nbody text\n";
    expect(extractBlock(md, "f", [{ id: "f", from: 5, to: 15 }])).toBeNull();
  });

  it("is not thrown off by frontmatter (anchors are offsets into the whole text)", () => {
    expect(block("---\ntitle: x\n---\n\nbody text ^f1\n", "f1")).toBe("body text");
  });

  it("takes the first block when an id repeats", () => {
    const md = "first\n\nsecond\n";
    expect(extractBlock(md, "d", [{ id: "d", from: 0, to: 5 }, { id: "d", from: 7, to: 13 }])).toBe("first");
  });
});

describe("extractSection", () => {
  const md = "# Title\n\nintro\n\n## Goals\n\ng1\n\n### Detail\n\nd1\n\n## Other\n\no1\n";

  it("runs from the heading to the next of the same or higher level", () => {
    expect(extractSection(md, "Goals")).toBe("## Goals\n\ng1\n\n### Detail\n\nd1");
    expect(extractSection(md, "Detail")).toBe("### Detail\n\nd1");
  });

  it("runs to the end for the last section, and a top heading covers the rest", () => {
    expect(extractSection(md, "Other")).toBe("## Other\n\no1");
    expect(extractSection(md, "Title")).toBe(md.trimEnd());
  });

  it("matches case-insensitively and by duplicate id", () => {
    expect(extractSection(md, "goals")).toContain("g1");
    expect(extractSection("## A\n\nx\n\n## A\n\ny\n", "a-1")).toBe("## A\n\ny");
  });

  it("reads CJK headings", () => {
    expect(extractSection("# 筆記\n\n## 目標\n\n內容\n\n## 其他\n\n略", "目標")).toBe("## 目標\n\n內容");
  });

  it("is null for a missing heading", () => {
    expect(extractSection(md, "Nope")).toBeNull();
    expect(extractSection(md, "  ")).toBeNull();
  });

  it("ignores headings in code fences", () => {
    const text = "## Real\n\n```\n## Fake\n```\n\nafter";
    expect(extractSection(text, "Fake")).toBeNull();
    expect(extractSection(text, "Real")).toBe(text);
  });
});

describe("embedEditable", () => {
  const a = anchored("Intro\n\nThe key idea. ^key\n\n- item ^it\n  - child\n\n## Goals\n\ngoal text\n\n## Next\n\nlater");
  const md = a.markdown;
  const edit = (target: Parameters<typeof embedEditable>[1], to: string, source = md, anchors = a.anchors) => embedEditable(source, target, anchors)!.apply(to);

  it("opens on what the embed shows", () => {
    expect(embedEditable(md, { blockId: "key" }, a.anchors)?.text).toBe("The key idea.");
    expect(embedEditable(md, { blockId: "it" }, a.anchors)?.text).toBe("- item\n  - child");
    expect(embedEditable(md, { heading: "Goals" })?.text).toBe("## Goals\n\ngoal text");
    expect(embedEditable(md, { blockId: "nope" }, a.anchors)).toBeNull();
    expect(embedEditable(md, { blockId: "key" })).toBeNull(); // no anchors: no block has an id
    expect(embedEditable(md, { heading: "Nope" })).toBeNull();
  });

  it("writes a block back in place, leaving the rest of the note alone", () => {
    expect(edit({ blockId: "key" }, "A better idea.")).toBe(md.replace("The key idea.", "A better idea."));
    expect(edit({ blockId: "it" }, "- item two\n  - child\n  - more")).toBe(md.replace("- item\n  - child", "- item two\n  - child\n  - more"));
  });

  it("an edit that splits the block leaves the anchor's start on the first piece", () => {
    const out = edit({ blockId: "key" }, "First.\n\nSecond.");
    expect(out).toContain("First.\n\nSecond.\n\n- item");
    const key = a.anchors.find((x) => x.id === "key")!;
    expect(out.slice(key.from, key.from + 6)).toBe("First.");
  });

  it("re-indents a nested item and ignores an edit that empties the block", () => {
    const nested = anchored("- top\n  - inner ^in\n    - deep\n");
    expect(embedEditable(nested.markdown, { blockId: "in" }, nested.anchors)?.text).toBe("- inner\n  - deep");
    expect(edit({ blockId: "in" }, "- inner2\n  - deep2", nested.markdown, nested.anchors)).toBe("- top\n  - inner2\n    - deep2\n");
    expect(edit({ blockId: "key" }, "  \n")).toBe(md);
  });

  it("writes a heading's section and a whole note back, keeping frontmatter", () => {
    expect(edit({ heading: "Goals" }, "## Goals\n\nnew goal")).toBe(md.replace("## Goals\n\ngoal text", "## Goals\n\nnew goal"));
    const withFront = "---\ntitle: x\n---\nbody\n";
    expect(embedEditable(withFront, {})?.text).toBe("body");
    expect(edit({}, "changed", withFront)).toBe("---\ntitle: x\n---\nchanged\n");
  });

  it("a list's anchor: an edit rewrites the whole list", () => {
    const list = anchored("- a\n- b\n\n^lst\n");
    expect(list.markdown).toBe("- a\n- b\n");
    expect(edit({ blockId: "lst" }, "- a\n- b\n- c", list.markdown, list.anchors)).toBe("- a\n- b\n- c\n");
  });
});
