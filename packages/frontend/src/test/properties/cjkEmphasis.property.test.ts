// Property: the editor's live preview and the Markdown pipeline (preview pane,
// published site, exports) find the SAME bold and italic spans in text with CJK
// punctuation next to the marks (`**「重點」**接著`). CommonMark's flanking rule
// breaks these; both layers use the CJK-friendly rule (packages/markdown
// cjkEmphasis.ts). Generators: markdown/src/test/helpers/unicodeText.ts.
// Seed and run count from PROPS_SEED / PROPS_RUNS.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { ondenMarkdownCore } from "@onden/markdown";
import { cjkEmphasis } from "../../lib/editorCjkEmphasis";
import { PROPS_RUNS, PROPS_SEED } from "../../../../markdown/src/test/helpers/propsConfig";
import { plainWord, fullwidthPunct } from "../../../../markdown/src/test/helpers/unicodeText";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

type Span = { kind: "em" | "strong"; from: number; to: number };

/** Emphasis spans as the editor's syntax tree has them. */
function editorSpans(doc: string): Span[] {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [cjkEmphasis] })] });
  const tree = syntaxTree(state);
  const out: Span[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === "Emphasis") out.push({ kind: "em", from: node.from, to: node.to });
      else if (node.name === "StrongEmphasis") out.push({ kind: "strong", from: node.from, to: node.to });
    },
  });
  return out.sort((a, b) => a.from - b.from || b.to - a.to);
}

/** The same, from the pipeline's parser (remark with the plugins of the preview and the site). */
function parserSpans(doc: string): Span[] {
  const md = ondenMarkdownCore({ profile: "published", math: false });
  const tree = unified().use(remarkParse).use(md.remarkPlugins).parse(doc);
  const out: Span[] = [];
  const walk = (n: { type: string; children?: unknown[]; position?: { start: { offset?: number }; end: { offset?: number } } }) => {
    if ((n.type === "emphasis" || n.type === "strong") && n.position) {
      out.push({ kind: n.type === "emphasis" ? "em" : "strong", from: n.position.start.offset!, to: n.position.end.offset! });
    }
    for (const child of (n.children ?? []) as (typeof n)[]) walk(child);
  };
  walk(tree as never);
  return out.sort((a, b) => a.from - b.from || b.to - a.to);
}

const PUNCT_BEFORE = fc.oneof({ weight: 3, arbitrary: fullwidthPunct }, { weight: 1, arbitrary: fc.constantFrom("(", "\"", ".", ",") }, { weight: 3, arbitrary: fc.constant("") });
const MARK = fc.constantFrom("**", "*", "**", "*");
const ANY_MARK = fc.constantFrom("**", "*", "**", "*", "__", "_");

/** A sentence of words, with marked words whose edges are punctuation or letters. */
const sentence = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: plainWord },
    { weight: 4, arbitrary: fc.tuple(ANY_MARK, PUNCT_BEFORE, plainWord, PUNCT_BEFORE).map(([m, a, w, b]) => `${m}${a}${w}${b}${m}`) },
    { weight: 2, arbitrary: fullwidthPunct },
    { weight: 1, arbitrary: fc.constant(" ") },
  ),
  { minLength: 1, maxLength: 6 },
).map((p) => p.join(""));

describe("emphasis next to CJK punctuation: editor and pipeline agree", () => {
  it("find the same bold and italic spans", () => {
    fc.assert(fc.property(sentence, (doc) => {
      expect(editorSpans(doc), JSON.stringify(doc)).toEqual(parserSpans(doc));
    }), fcOpts);
  });

  it("a marked word whose edges are CJK punctuation and which is followed by a letter is emphasis", () => {
    fc.assert(fc.property(fc.constantFrom("「", "（", "『", "【", "《"), plainWord, fc.constantFrom("」", "）", "』", "】", "》", "。", "，", "："), plainWord, MARK, (open, word, close, after, mark) => {
      const pair: Record<string, string> = { "「": "」", "（": "）", "『": "』", "【": "】", "《": "》" };
      const doc = `${mark}${open}${word}${pair[open]}${mark}${after}${close}`;
      expect(parserSpans(doc).length, `parser: ${doc}`).toBe(1);
      expect(editorSpans(doc).length, `editor: ${doc}`).toBe(1);
    }), fcOpts);
  });

  it.each([
    ["**「重點」**接著", 1], ["**重點**。", 1], ["這是**粗體**字", 1], ["*斷言*：", 1], ["他說**「好」**，然後", 1],
    ["**（注意）**字", 1], ["（**注意**）", 1], ["2 * 3 * 4", 0], ["a ** b", 0],
  ])("%s has %i emphasis span(s) in both layers", (doc, count) => {
    expect(parserSpans(doc)).toHaveLength(count);
    expect(editorSpans(doc)).toHaveLength(count);
  });
});
