// Property: bold and italic next to CJK punctuation (`**「重點」**接著`,
// `這是**（注意）**字`) render as <strong> / <em> in the HTML of the exports and
// the published site (modules/website/publishing/htmlUtils.ts md2html), in the app's
// preview profile, and nowhere is a literal `*` left. The editor's live preview
// reads the same rule: frontend test/properties/cjkEmphasis.property.test.ts.
// Generators: markdown/src/test/helpers/unicodeText.ts. Seed and run count from
// PROPS_SEED / PROPS_RUNS. DB-free.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { ondenMarkdown } from "@onden/markdown/full";
import { md2html } from "../../modules/website/publishing/htmlUtils.js";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { plainWord, unicodeText } from "../../../../markdown/src/test/helpers/unicodeText.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

const app = ondenMarkdown({ profile: "app", math: false });
const appHtml = (text: string) => String(unified().use(remarkParse).use(app.remarkPlugins).use(remarkRehype, app.remarkRehypeOptions).use(app.rehypePlugins).use(rehypeStringify).processSync(app.prepare(text)));

const CJK_WORD = fc.array(fc.constantFrom(..."這是一個測試文字中的重點注意說明結果"), { minLength: 1, maxLength: 4 }).map((c) => c.join(""));
const PAIRS: Array<[string, string]> = [["「", "」"], ["（", "）"], ["『", "』"], ["【", "】"], ["《", "》"], ["“", "”"]];
const AFTER = fc.constantFrom("", "。", "，", "：", "！", "？", "、", "；");
const MARK = fc.constantFrom("*", "**");

/** `…這是**「好」**字。` — one emphasised span between ordinary Chinese, its edges CJK punctuation or letters. */
const sentence = fc.tuple(CJK_WORD, MARK, fc.option(fc.constantFrom(...PAIRS), { nil: null }), plainWord, AFTER, CJK_WORD).map(([lead, mark, pair, word, after, tail]) => {
  const inner = pair ? `${pair[0]}${word}${pair[1]}` : word;
  return { doc: `${lead}${mark}${inner}${mark}${after}${tail}`, strong: mark === "**", inner, lead, after, tail };
});

const count = (html: string, tag: string) => (html.match(new RegExp(`<${tag}>`, "g")) ?? []).length;
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

describe("emphasis next to CJK punctuation renders as emphasis in every profile", () => {
  it("exports and the published site (md2html)", () => {
    fc.assert(fc.property(sentence, ({ doc, strong, inner, lead, after, tail }) => {
      const html = md2html(doc);
      expect(count(html, strong ? "strong" : "em"), doc).toBe(1);
      expect(text(html)).toBe(`${lead}${inner}${after}${tail}`);
    }), fcOpts);
  });

  it("the app's preview profile gives the same", () => {
    fc.assert(fc.property(sentence, ({ doc, strong }) => {
      const html = appHtml(doc);
      expect(count(html, strong ? "strong" : "em"), doc).toBe(1);
      expect(html).not.toContain("*");
    }), fcOpts);
  });

  it.each([
    ["**「重點」**接著", "<strong>「重點」</strong>接著"],
    ["**重點**。", "<strong>重點</strong>。"],
    ["這是**粗體**字", "這是<strong>粗體</strong>字"],
    ["*斷言*：", "<em>斷言</em>："],
    ["**（注意）**字", "<strong>（注意）</strong>字"],
  ])("%s", (doc, expected) => {
    expect(md2html(doc)).toContain(expected);
    expect(appHtml(doc)).toContain(expected);
  });

  it("stays CommonMark where there is no CJK: 2 * 3 * 4 and a ** b are text", () => {
    expect(md2html("2 * 3 * 4")).not.toContain("<em>");
    expect(md2html("a ** b ** c")).not.toContain("<strong>");
  });

  // Markdown → published page: every visible character comes out, in order — CJK
  // extension characters, emoji sequences, combining marks, full-width forms,
  // and the zero-width characters and BOM (kept, as the text keeps them).
  it("the page's text holds every non-blank character of the note's text, in order", () => {
    fc.assert(fc.property(unicodeText({ minLength: 1, maxLength: 40 }).map((t) => t.replace(/[\r\n]/g, "")), (line) => {
      const blankless = (t: string) => t.replace(/[\s\u3000]/g, "");
      expect(blankless(text(md2html(line)))).toBe(blankless(line));
      expect(blankless(text(appHtml(line)))).toBe(blankless(line));
    }), fcOpts);
  });
});
