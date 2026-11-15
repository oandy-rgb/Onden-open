import { describe, expect, it } from "vitest";
import { listLinkTargets, LINK_TARGET_LABEL_MAX } from "./linkTargets.js";
import { BLOCK_PARSE_MAX } from "./blocks.js";
import { anchored } from "./test/helpers/anchored.js";

// The `[[Note#` list: what a note offers to link to, in document order.

const brief = (md: string) => listLinkTargets(md).map((t) => t.kind === "heading" ? `h${t.depth} ${t.text}` : `${t.blockKind === "listItem" ? "li" : "p"} ${t.ref ?? "-"} ${t.text}`);

describe("listLinkTargets", () => {
  it("lists headings, paragraphs and list items in document order", () => {
    expect(brief("# Title\n\nIntro text.\n\n## Part\n\n- one\n- two\n\nLast.")).toEqual([
      "h1 Title", "p - Intro text.", "h2 Part", "li - one", "li - two", "p - Last.",
    ]);
  });

  it("reads setext headings", () => {
    expect(brief("Big\n===\n\nsmall\n---\n\nbody")).toEqual(["h1 Big", "h2 small", "p - body"]);
  });

  it("gives a block the id of the anchor that starts at it, tagged or not", () => {
    const { markdown, anchors } = anchored("A claim ^c1\n\n- item {x} ^i1\n- other\n\nPlain");
    expect(markdown).toBe("A claim\n\n- item {x}\n- other\n\nPlain");
    expect(listLinkTargets(markdown, anchors).map((t) => t.kind === "block" ? `${t.blockKind === "listItem" ? "li" : "p"} ${t.ref ?? "-"} ${t.text}` : t.text))
      .toEqual(["p c1 A claim", "li i1 item", "li - other", "p - Plain"]);
    expect(brief(markdown)).toEqual(["p - A claim", "li - item", "li - other", "p - Plain"]); // without anchors: no ref
  });

  it("a block after a typed-in-front edit keeps its id when the anchor moved with it, and has none when it did not", () => {
    const md = "new line\n\nA claim";
    const at = md.indexOf("A claim");
    expect(listLinkTargets(md, [{ id: "c1", from: at, to: md.length }]).map((t) => t.kind === "block" ? t.ref : "h")).toEqual([null, "c1"]);
    expect(listLinkTargets(md, [{ id: "c1", from: 0, to: 7 }]).map((t) => t.kind === "block" ? t.ref : "h")).toEqual(["c1", null]);
  });

  it("reads tasks without their box, and nested items", () => {
    expect(brief("- [ ] buy milk\n- [x] done\n  - child")).toEqual(["li - buy milk", "li - done", "li - child"]);
  });

  it("lists the paragraphs of a quote and a callout without its marker", () => {
    expect(brief("> quoted words\n\n> [!note] Heads up\n> body")).toEqual(["p - quoted words", "p - Heads up body"]);
  });

  it("leaves out code, tables, math, HTML and hidden attribute lines", () => {
    const md = ["```", "# not a heading", "code line", "```", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "$$", "x", "$$", "", "<div>x</div>", "", "status:: done", "", "real"].join("\n");
    expect(brief(md)).toEqual(["p - real"]);
  });

  it("skips a paragraph that is only an ^id", () => {
    expect(brief("- a list\n\n^l1\n\ntext")).toEqual(["li - a list", "p - text"]);
  });

  it("reads CJK text and cuts the label by character, not by byte", () => {
    const long = "這".repeat(80);
    const [target] = listLinkTargets(`## 標題\n\n${long}`).filter((t) => t.kind === "block");
    expect(target).toMatchObject({ kind: "block", text: long });
    expect(Array.from(target!.kind === "block" ? target!.label : "")).toHaveLength(LINK_TARGET_LABEL_MAX + 1);
    expect(brief("## 標題\n\n短句。")).toEqual(["h2 標題", "p - 短句。"]);
  });

  it("strips formatting and link syntax from the text", () => {
    expect(brief("**bold** and [a link](https://x.y) with [[Other|alias]] and `code`")).toEqual(["p - bold and a link with alias and code"]);
  });

  it("gives offsets in the whole note, frontmatter included, and where an id goes", () => {
    const md = "---\ntitle: x\n---\n# Head\n\nfirst line\ncontinued";
    const [head, para] = listLinkTargets(md);
    expect(head).toMatchObject({ kind: "heading", start: md.indexOf("# Head") });
    expect(para).toMatchObject({ kind: "block", start: md.indexOf("first"), insertAt: md.length });
    const [item] = listLinkTargets("- a\n  more\n- b").filter((t) => t.kind === "block");
    expect(item).toMatchObject({ insertAt: "- a\n  more".length });
  });

  it("is empty for a note over the parse cap", () => {
    expect(listLinkTargets("x".repeat(BLOCK_PARSE_MAX + 1))).toEqual([]);
  });
});
