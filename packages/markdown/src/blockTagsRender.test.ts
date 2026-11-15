// Block `{tag}` marks in the rendered page (remarkBlockId): cut from the
// text by the same reading as blocks.ts, the block tagged data-block-tags.
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { ondenMarkdown } from "./full.js";

function html(markdown: string, blockAnchors: Array<{ id: string; from: number; to: number }> = []): string {
  const md = ondenMarkdown({ profile: "published", blockAnchors });
  return String(unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions)
    .use(md.rehypePlugins).use(rehypeStringify).processSync(md.prepare(markdown)));
}

describe("block {tag} marks in rendered output", () => {
  it("hides a task line's tag and tags the list item", () => {
    const out = html("- [ ] 編譯器作業 {task}\n");
    expect(out).not.toContain("{task}");
    expect(out).toContain('data-block-tags="task"');
    expect(out).toContain("編譯器作業");
    expect(out).not.toMatch(/編譯器作業\s+</);
  });

  it("hides the tags of a heading, a quote and a paragraph", () => {
    const out = html("## Title {a}\n\n> quoted {b}\n\nplain {c, d}\n");
    expect(out).not.toMatch(/\{[a-d, ]+\}/);
    expect(out).toContain('data-block-tags="a"');
    expect(out).toContain('data-block-tags="b"');
    expect(out).toContain('data-block-tags="c,d"');
  });

  it("hides the `{a, b}` and tags the block with its anchor's id", () => {
    const body = "para {a, b}\n";
    const out = html(body, [{ id: "pid", from: 0, to: body.length }]);
    expect(out).not.toContain("{a, b}");
    expect(out).toContain('data-block-tags="a,b"');
    expect(out).toContain('data-block-id="pid"');
    expect(html(body)).not.toContain("data-block-id");
  });

  it("a `^id` typed in the text is shown as text and makes the line no longer end with its tags", () => {
    const out = html("para {a, b} ^pid\n");
    expect(out).toContain("para {a, b} ^pid");
    expect(out).not.toContain("data-block-tags");
    expect(out).not.toContain("data-block-id");
  });

  it("keeps escaped, code, empty and key: value braces as written", () => {
    expect(html("keep \\{t\\}\n")).toContain("{t}");
    expect(html("run `x {t}`\n")).toContain("x {t}");
    expect(html("empty {}\n")).toContain("{}");
    expect(html("attr {k: v}\n")).toContain("{k: v}");
    expect(html("keep \\{t\\}\n")).not.toContain("data-block-tags");
    expect(html("attr {k: v}\n")).not.toContain("data-block-tags");
  });
});
