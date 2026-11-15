import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { attributeLines, standaloneAttributeLines } from "./index.js";
import { ondenMarkdown } from "./full.js";

function html(markdown: string): string {
  const md = ondenMarkdown({ profile: "published" });
  return String(unified().use(remarkParse).use(md.remarkPlugins).use(remarkRehype, md.remarkRehypeOptions)
    .use(md.rehypePlugins).use(rehypeStringify).processSync(md.prepare(markdown)));
}

describe("attributeLines — one grammar for the index and the renderer", () => {
  it("reads the three forms with their lines", () => {
    expect(attributeLines("status:: doing\nSee [author:: Roy] #p=high\n")).toEqual([
      { line: 1, form: "line", key: "status", value: "doing" },
      { line: 2, form: "bracket", key: "author", value: "Roy" },
      { line: 2, form: "hashtag", key: "p", value: "high" },
    ]);
  });

  it("#key=value reads only keys in the attribute key grammar (D44b)", () => {
    expect(attributeLines("#作者=王 #_x=1 #a-1=b #2024=x #-y=1 x#k=v")).toEqual([
      { line: 1, form: "hashtag", key: "作者", value: "王" },
      { line: 1, form: "hashtag", key: "_x", value: "1" },
      { line: 1, form: "hashtag", key: "a-1", value: "b" },
    ]);
  });

  it("skips ``` and ~~~ fences, closing only on the same character and length", () => {
    const md = [
      "a:: 1",
      "~~~",
      "b:: in-tilde",
      "```",
      "c:: still-in-tilde",
      "~~~",
      "````js",
      "d:: in-backtick",
      "```",
      "e:: still-in-backtick",
      "````",
      "f:: 6",
    ].join("\n");
    expect(attributeLines(md).map((a) => a.key)).toEqual(["a", "f"]);
  });

  it("an unclosed fence runs to the end", () => {
    expect(attributeLines("~~~\nx:: 1\n")).toEqual([]);
  });

  it("the standalone form starts in the first column and needs the space", () => {
    expect(attributeLines("text due:: x\n  due:: x\nfoo::bar\n> due:: x")).toEqual([]);
  });

  it("numbers lines at \\r\\n and \\r too", () => {
    expect([...standaloneAttributeLines("x\r\na:: 1\rb:: 2")]).toEqual([2, 3]);
  });
});

describe("remarkInlineAttrs — hides only the attribute lines", () => {
  it("keeps the prose line joined to an attribute line's paragraph", () => {
    const out = html("Intro.\n\ndue:: 2026-10-20\nCall the lawyer about the contract.\n\nEnd.");
    expect(out).not.toContain("due::");
    expect(out).toContain("<p>Call the lawyer about the contract.</p>");
    expect(out).toContain("Intro.");
    expect(out).toContain("End.");
  });

  it("hides an attribute line in the middle of a paragraph", () => {
    const out = html("First line.\nstatus:: doing\nLast line.");
    expect(out).not.toContain("status::");
    expect(out).toMatch(/<p>First line\.(<br>)?\nLast line\.<\/p>/);
  });

  it("still hides a standalone attribute paragraph whole", () => {
    const out = html("status:: done\npriority:: high\n\nBody.");
    expect(out).not.toContain("::");
    expect(out).not.toContain("<p></p>");
    expect(out).toContain("<p>Body.</p>");
  });

  it("hides a value with markup and keeps the next line", () => {
    const out = html("due:: **soon** [x](https://e.x)\nKeep me.");
    expect(out).not.toContain("due::");
    expect(out).not.toContain("soon");
    expect(out).toContain("<p>Keep me.</p>");
  });

  it("keeps hard breaks around a hidden line coherent", () => {
    const out = html("a  \ndue:: x  \nb");
    expect(out).not.toContain("due::");
    expect(out).toMatch(/<p>a<br>\s*b<\/p>/);
  });

  it("hides a lazy continuation line in a list item", () => {
    const out = html("- item\ndue:: x\n");
    expect(out).not.toContain("due::");
    expect(out).toContain("item");
  });

  it("leaves ~~~ and ``` blocks, quoted and indented lines as they are", () => {
    const out = html("~~~\nstatus:: in-code\n~~~\n\n```\np:: q\n```\n\n> quoted:: kept\n\n- item\n  indented:: kept");
    expect(out).toContain("status:: in-code");
    expect(out).toContain("p:: q");
    expect(out).toContain("quoted:: kept");
    expect(out).toContain("indented:: kept");
  });

  it("hides an attribute line that CommonMark reads as a setext heading", () => {
    const out = html("Intro.\n\ndue:: x\nTitle\n---\n\nBody.");
    expect(out).not.toContain("due::");
    expect(out).toContain('<h2 id="user-content-title">Title</h2>');
  });

  it("keeps bracketed and hashtag forms visible", () => {
    const out = html("Reading [author:: Roy] on REST #p=high.");
    expect(out).toContain("[author:: Roy]");
    expect(out).toContain("#p=high");
  });

  it("hides exactly the lines the index reads as standalone", () => {
    const md = "x\ndue:: 1\n~~~text\nno:: two\n~~~\ny\nalso:: 3\nz";
    expect([...standaloneAttributeLines(md)]).toEqual([2, 7]);
    const out = html(md);
    expect(out).not.toContain("due::");
    expect(out).not.toContain("also::");
    expect(out).toContain("no:: two");
    for (const word of ["x", "y", "z"]) expect(out).toContain(word);
  });
});
