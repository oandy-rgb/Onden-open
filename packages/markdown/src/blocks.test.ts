// The block-node grammar (docs/architecture/block-nodes.md), case by case.
// A block's identity is an anchor (block_anchors), not text: fixtures written as `text ^id` go through `anchored()`.

import { describe, expect, it } from "vitest";
import { parseBlocks, parseLegacyBlocks, legacyBlockAnchors, blocksParsable, mayHaveBlocks, blockTagSlot, BLOCK_PARSE_MAX } from "./blocks.js";
import { anchored } from "./test/helpers/anchored.js";

const read = (legacy: string) => { const a = anchored(legacy); return parseBlocks(a.markdown, a.anchors); };
const brief = (legacy: string) => read(legacy).map((b) => ({ kind: b.kind, ref: b.ref, tags: b.tags, parent: b.parent, label: b.label }));

describe("parseBlocks", () => {
  it("finds {tags} at the end of a paragraph, list item, heading and quote", () => {
    expect(brief([
      "A paragraph {重要, 考點} ^p1",
      "",
      "- 二分搜尋 {重要} ^a1",
      "",
      "## 搜尋 {考點} ^s1",
      "",
      "> [!quote] 作者的主要論點 {摘錄}",
      "> 第一段",
      "",
      "^q1",
    ].join("\n"))).toEqual([
      { kind: "paragraph", ref: "p1", tags: ["重要", "考點"], parent: null, label: "A paragraph" },
      { kind: "listItem", ref: "a1", tags: ["重要"], parent: null, label: "二分搜尋" },
      { kind: "heading", ref: "s1", tags: ["考點"], parent: null, label: "搜尋" },
      { kind: "quote", ref: "q1", tags: ["摘錄"], parent: 2, label: "作者的主要論點" },
    ]);
  });

  it("nests by structure: heading > item > sub-item, skipping untagged levels", () => {
    const md = [
      "## 搜尋 {考點} ^s1",
      "- 二分搜尋 {重要} ^a1",
      "  - plain middle",
      "    - 邊界要用 lo <= hi {易錯} ^a2",
      "## Next",
      "after {x} ^n1",
    ].join("\n");
    const blocks = read(md);
    expect(blocks.map((b) => [b.ref, b.parent === null ? null : blocks[b.parent]!.ref])).toEqual([
      ["s1", null], ["a1", "s1"], ["a2", "a1"], ["n1", null],
    ]);
  });

  it("a heading's scope ends at the next heading of the same or a higher level", () => {
    const md = "# A {a} ^h1\n## B {b} ^h2\npara {p} ^p1\n# C\nlast {l} ^p2";
    const blocks = read(md);
    const parentOf = (ref: string) => { const b = blocks.find((x) => x.ref === ref)!; return b.parent === null ? null : blocks[b.parent]!.ref; };
    expect(parentOf("h2")).toBe("h1");
    expect(parentOf("p1")).toBe("h2");
    expect(parentOf("p2")).toBe(null);
  });

  it("only a {…} at the very end counts; code, math, links and mid-sentence braces don't", () => {
    expect(parseBlocks("set {a, b} is small")).toEqual([]);
    expect(parseBlocks("code `{x}`")).toEqual([]);
    expect(parseBlocks("math $\\{a\\}$")).toEqual([]);
    expect(parseBlocks("```\nfenced {x}\n```")).toEqual([]);
    expect(parseBlocks("[label {x}](https://a.test)")).toEqual([]);
    expect(parseBlocks("empty {}")).toEqual([]);
    expect(parseBlocks("**bold {x}**")).toEqual([]); // the brace isn't the line's end
    expect(brief("in **bold** {x}")[0]?.tags).toEqual(["x"]);
  });

  it("tag lists are comma-separated; `key: value` entries aren't tags", () => {
    expect(parseBlocks("p {重要, 狀態: 草稿, 重要}")[0]!.tags).toEqual(["重要"]);
  });

  it("a block's ref comes only from the anchor that starts at it; a block no anchor starts at has none", () => {
    const md = "first {a}\n\nsecond {b}\n\nthird {c}";
    const at = (s: string) => md.indexOf(s);
    expect(parseBlocks(md).map((b) => b.ref)).toEqual([null, null, null]);
    expect(parseBlocks(md, [{ id: "bb", from: at("second") }, { id: "aa", from: at("first") }]).map((b) => b.ref)).toEqual(["aa", "bb", null]);
    // An anchor in the middle of a block (the text moved under it) names no block.
    expect(parseBlocks(md, [{ id: "mid", from: at("second") + 2 }]).map((b) => b.ref)).toEqual([null, null, null]);
  });

  it("an anchor at a list item's indentation still reaches the item", () => {
    const md = "- a {t}\n  - b {t}";
    expect(parseBlocks(md, [{ id: "b1", from: md.indexOf("  - b") }]).map((b) => b.ref)).toEqual([null, "b1"]);
  });

  it("the same block keeps its anchor when text is typed before it, once the anchor moves with the text", () => {
    const before = "intro\n\npoint {重要}";
    const anchors = [{ id: "pt", from: before.indexOf("point") }];
    expect(parseBlocks(before, anchors)[0]!.ref).toBe("pt");
    const after = "a longer intro\n\npoint {重要}";
    expect(parseBlocks(after, [{ id: "pt", from: after.indexOf("point") }])[0]!.ref).toBe("pt");
    // Left where it was, the stale offset no longer starts any block.
    expect(parseBlocks(after, anchors)[0]!.ref).toBeNull();
  });

  it("a `^id` in the text is plain text: it gives no ref, makes no block and does not end the tag line", () => {
    expect(parseBlocks("Just an anchor ^k3f9")).toEqual([]);
    expect(parseBlocks("Some #重要 text ^k3f9")).toEqual([]);
    expect(parseBlocks("#tag but no id")).toEqual([]);
    expect(parseBlocks("text {重要} ^k3f9")).toEqual([]); // the line no longer ends with `}`
    expect(parseBlocks("text ^k3f9 {重要}")[0]).toMatchObject({ ref: null, tags: ["重要"] });
    expect(parseBlocks("tagged {重要}\n\nnote ^k3f9", [{ id: "x", from: 0 }])[0]!.ref).toBe("x");
  });

  it("labels come from the first line, without markers and tags", () => {
    expect(brief("- [ ] 寫作業三 {作業}")[0]!.label).toBe("寫作業三");
    expect(brief("first line\nsecond line {t}")[0]!.label).toBe("first line");
    expect(brief("1. ordered {t}")[0]!.label).toBe("ordered");
  });

  it("frontmatter is not read as a block", () => {
    expect(brief("---\ntitle: {x}\n---\nbody {t} ^b1").map((b) => b.ref)).toEqual(["b1"]);
  });

  it("escaped braces are text; a #tag is no tag without the old id", () => {
    expect(parseBlocks("literal \\{t\\}")).toEqual([]);
    expect(parseBlocks("see `#foo` and #bar")).toEqual([]);
  });

  it("setext headings are headings", () => {
    const [h, p] = read("Title {t} ^h1\n=====\n\nbody {b} ^p1\n\nNext\n---");
    expect(h).toMatchObject({ kind: "heading", ref: "h1", label: "Title", tags: ["t"] });
    expect(p).toMatchObject({ kind: "paragraph", ref: "p1" });
  });

  it("a callout nested in a list item or a quote is one block, whatever container it sits in", () => {
    for (const md of [
      "- item\n  > [!note] T {c}\n  > body",
      "> outer\n>\n> > [!note] T {c}\n> > body",
      "1. item\n   > [!tip] T {c}\n   > body",
    ]) {
      const blocks = parseBlocks(md);
      expect(blocks.map((b) => b.kind), md).toEqual(["quote"]);
      expect(blocks[0]!.tags, md).toEqual(["c"]);
    }
  });

  it("a quote takes the anchor that starts at its first line", () => {
    const md = "> [!note] T {c}\n> body";
    expect(parseBlocks(md, [{ id: "q1", from: 0 }])[0]!.ref).toBe("q1");
  });

  it("2,000 nested quotes don't overflow the stack", () => {
    const deep = "> ".repeat(2000) + "x {t}";
    expect(() => parseBlocks(deep)).not.toThrow();
  });

  it("a body over BLOCK_PARSE_MAX is not read (callers keep what they have)", () => {
    const long = "x".repeat(BLOCK_PARSE_MAX) + "\n\np {t}";
    expect(blocksParsable(long)).toBe(false);
    expect(parseBlocks(long, [{ id: "z", from: 0 }])).toEqual([]);
  });
});

describe("parseLegacyBlocks (the old text marks, for the migration)", () => {
  it("reads `^id` as the ref; Obsidian's `#tag ^id` is a block node and an ^id alone is just an anchor", () => {
    const [b] = parseLegacyBlocks("Some #重要 text ^k3f9");
    expect(b).toMatchObject({ ref: "k3f9", tags: ["重要"], tagSource: "hashtags" });
    expect(parseLegacyBlocks("Just an anchor ^k3f9")).toEqual([]);
    expect(parseLegacyBlocks("#tag but no id")).toEqual([]);
    expect(parseLegacyBlocks("see `#foo` here ^a1")).toEqual([]);
    expect(parseLegacyBlocks("see `#foo` and #bar ^a1")[0]!.tags).toEqual(["bar"]);
  });

  it("a ^id before the {…} is not an id (it must come last)", () => {
    expect(parseLegacyBlocks("text ^k3f9 {重要}")[0]).toMatchObject({ ref: null, tags: ["重要"] });
  });

  it("a quote's id on its own line after it, or on its last line, counts", () => {
    expect(parseLegacyBlocks("> [!note] T {c}\n> body\n> ^q1")[0]!.ref).toBe("q1");
    expect(parseLegacyBlocks("> [!note] T {c}\n> body\n>\n> ^q2")[0]!.ref).toBe("q2");
    expect(parseLegacyBlocks("> [!quote] 論點 {摘錄}\n> 第一段\n\n^q3")[0]!.ref).toBe("q3");
  });

  it("legacyBlockAnchors lists every written id, tagged or not", () => {
    expect(legacyBlockAnchors("a ^one\n\nb {t} ^two\n\n- c\n\n^three").map((a) => a.id)).toEqual(["one", "two", "three"]);
    expect(legacyBlockAnchors("a ^one\n\nb ^two").map((a) => a.id)).toEqual(["one", "two"]);
  });
});

describe("marks (where the editor shows chips)", () => {
  const marked = (md: string) => parseBlocks(md).map((b) => ({ tags: b.marks.tags ? md.slice(b.marks.tags.from, b.marks.tags.to) : null, ref: b.marks.ref }));

  it("spans the {…} on the tag line, and nothing for an id", () => {
    expect(marked([
      "A paragraph {重要, 考點}",
      "",
      "- 二分搜尋 {重要}",
      "",
      "## 搜尋 {考點} ",
    ].join("\n"))).toEqual([
      { tags: "{重要, 考點}", ref: null },
      { tags: "{重要}", ref: null },
      { tags: "{考點}", ref: null },
    ]);
  });

  it("legacy blocks also span the ^id mark, on the tag line or after a quote", () => {
    const md = "A paragraph {重要, 考點} ^p1\n\n> [!quote] 論點 {摘錄}\n> 第一段\n\n^q1\n\n> [!quote] 論點 {摘錄}\n> 第一段\n> ^q2";
    expect(parseLegacyBlocks(md).map((b) => b.marks.ref && md.slice(b.marks.ref.from, b.marks.ref.to))).toEqual(["^p1", "^q1", "^q2"]);
  });

  it("has no tag span for Obsidian's #tag ^id form", () => {
    expect(parseLegacyBlocks("Some #重要 text ^o1").map((b) => b.marks.tags)).toEqual([null]);
  });
});

// A body that starts with a blank line: an image pasted into an empty note is
// `\n![…](…)\n`. lastIndexOf("\n", -1) searches from 0 and found that first
// newline, so the backwards line walk never reached line 0 and the editor
// (and the save on the server) spun forever.
describe("a body that starts with a blank line", () => {
  const image = "\n![Screenshot_2026-10-20](/api/media/0801f39ce7c9b843595756a8a3c6c0c8.webp)\n";

  it("finishes and finds nothing in a body without blocks", () => {
    expect(mayHaveBlocks(image)).toBe(false);
    expect(parseBlocks(image)).toEqual([]);
    expect(legacyBlockAnchors(image)).toEqual([]);
    expect(mayHaveBlocks("\n")).toBe(false);
  });

  it("still reads the blocks after it", () => {
    const md = "\n\n重點 {重要}\n";
    expect(mayHaveBlocks(md)).toBe(true);
    expect(brief(md)).toEqual([{ kind: "paragraph", ref: null, tags: ["重要"], parent: null, label: "重點" }]);
    expect(parseBlocks(md, [{ id: "k1", from: 2 }]).map((b) => b.ref)).toEqual(["k1"]);
    expect(legacyBlockAnchors("\n\n重點 {重要} ^k1\n").map((a) => a.id)).toEqual(["k1"]);
    expect(blockTagSlot(md, md.indexOf("}"))?.tags).toEqual(["重要"]);
  });
});
