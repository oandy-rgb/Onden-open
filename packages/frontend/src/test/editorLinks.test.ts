import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { linkRanges } from "../lib/editorLinks";

function ranges(doc: string) {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, doc.length, 5000);
  return linkRanges(state).map((r) => [r.kind, doc.slice(r.from, r.to)]);
}

describe("editor link styling follows the preview", () => {
  it("a lone [text] is plain text, brackets included", () => {
    expect(ranges("圖片輸入的部分[感覺能去掉]")).toEqual([["literal", "[感覺能去掉]"]]);
  });

  it("[text](url) styles the text as a link", () => {
    expect(ranges("看 [原文](https://example.com) 吧")).toEqual([["link", "原文"]]);
  });

  it("[text][ref] is a link", () => {
    expect(ranges("見 [論文][p1]\n\n[p1]: https://example.com")).toContainEqual(["link", "論文"]);
  });

  it("[[note]] is a wikilink: title linked, all four brackets marks", () => {
    expect(ranges("參考 [[相關筆記]] 吧")).toEqual([["mark", "["], ["link", "相關筆記"], ["mark", "]"]]);
  });

  it("a bare URL is a link", () => {
    expect(ranges("網址 https://example.com/x 在此")).toEqual([["link", "https://example.com/x"]]);
  });
});
