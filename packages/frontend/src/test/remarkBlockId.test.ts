// Unit tests for the remark-blockId plugin: which blocks it tags from the note's anchors, and the `{tag}` it hides.
// The text carries no `^id` any more (段落錨點批 3): a `^word` is text like any other and is never hidden.

import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { remarkBlockId } from "@onden/markdown";

function process(md: string): string {
  return String(unified().use(remarkParse).use(remarkBlockId).use(remarkStringify).processSync(md));
}

function html(md: string, anchors: Array<{ id: string; from: number; to: number }>): string {
  return String(unified().use(remarkParse).use(remarkBlockId, { anchors }).use(remarkRehype).use(rehypeStringify).processSync(md));
}

describe("remarkBlockId: a `^word` is plain text", () => {
  it("is kept at the end of a paragraph and on a line of its own", () => {
    expect(process("Some paragraph here. ^intro\n")).toBe("Some paragraph here. ^intro\n");
    expect(process("- list a\n- list b\n\n^items\n\nNext block.\n")).toContain("^items");
  });

  it("leaves paragraphs without marks untouched", () => {
    const md = "Plain paragraph with no marker.\n";
    expect(process(md)).toBe(md);
  });
});

describe("remarkBlockId: tagging from anchors", () => {
  it("tags the block an anchor starts at, and only that one", () => {
    const md = "first\n\nsecond\n";
    expect(html(md, [{ id: "b2", from: 7, to: 13 }])).toBe('<p>first</p>\n<p data-block-id="b2">second</p>');
  });

  it("without anchors nothing is tagged", () => {
    expect(html("first\n\nsecond\n", [])).not.toContain("data-block-id");
  });
});

describe("remarkBlockId: the {tag} mark", () => {
  it("cuts a block's {tag} mark and leaves escaped or key: value braces", () => {
    expect(process("- [ ] 編譯器作業 {task}\n")).not.toContain("{task}");
    expect(process("work {a}\n")).toBe("work\n");
    expect(process("keep {k: v}\n")).toContain("{k: v}");
  });

  it("cuts the mark and keeps a trailing `^word` as text", () => {
    expect(process("work {a} ^id1\n")).toContain("^id1");
  });
});
