import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { mathMarkdown } from "../lib/editorMathSyntax";
import fixture from "../../../markdown/src/fixtures/math.json";

function stateOf(doc: string) {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [mathMarkdown] })] });
  return state;
}

function nodes(doc: string): Array<{ name: string; text: string }> {
  const state = stateOf(doc);
  const out: Array<{ name: string; text: string }> = [];
  ensureSyntaxTree(state, doc.length, 5000)!.iterate({
    enter: (n) => { out.push({ name: n.name, text: doc.slice(n.from, n.to) }); },
  });
  return out;
}

const mathSpans = (doc: string) =>
  nodes(doc).filter((n) => n.name === "InlineMath" || n.name === "BlockMath").map((n) => n.text);

describe("editor math grammar agrees with remark-math (shared fixture)", () => {
  for (const c of fixture) {
    it(c.name, () => expect(mathSpans(c.markdown)).toEqual(c.math));
  }
});

describe("nothing inside a formula is markdown", () => {
  const inside = (doc: string) => {
    const names = nodes(doc).map((n) => n.name);
    return names.filter((n) => ["Emphasis", "StrongEmphasis", "InlineCode", "Link", "EmphasisMark"].includes(n));
  };

  it("the reported note has no emphasis between the two formulas", () => {
    const doc = fixture[0].markdown;
    expect(inside(doc)).toEqual([]);
  });

  it("underscores and asterisks stay inside", () => {
    expect(inside("$a_1 * b_2$ and $c * d$")).toEqual([]);
  });

  it("emphasis outside a formula still works", () => {
    expect(inside("*em* and $x*y$ and **strong**")).toEqual(["Emphasis", "EmphasisMark", "EmphasisMark", "StrongEmphasis", "EmphasisMark", "EmphasisMark"]);
  });

  it("a block formula keeps its lines out of code, lists and headings", () => {
    const names = nodes("$$\n# not a heading\n- not a list\n`x`\n$$").map((n) => n.name);
    expect(names).not.toContain("ATXHeading1");
    expect(names).not.toContain("BulletList");
    expect(names).not.toContain("InlineCode");
  });

  it("marks are the dollar runs", () => {
    const marks = nodes("$$a$$ and\n\n$$\nb\n$$").filter((n) => n.name.endsWith("Mark") && n.name.includes("Math")).map((n) => n.text);
    expect(marks).toEqual(["$$", "$$", "$$", "$$"]);
  });
});

describe("other markdown still parses next to math", () => {
  it("wikilinks, task lines and headings", () => {
    const doc = "# Title $x$\n\n- [ ] do $y_1$ and [[Note]]\n\n[a](https://example.com)";
    const names = nodes(doc).map((n) => n.name);
    expect(names).toContain("ATXHeading1");
    expect(names).toContain("Task");
    expect(names).toContain("Link");
    expect(mathSpans(doc)).toEqual(["$x$", "$y_1$"]);
  });
});
