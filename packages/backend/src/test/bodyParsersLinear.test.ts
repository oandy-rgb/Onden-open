// Every parser that runs over a note's body inside its write (wikilinks,
// inline and frontmatter attributes, block ids), on every list
// (the excerpt) or for the published site (redaction) must stay roughly
// linear: a pasted pathological body otherwise blocks the event loop for every
// user while the write holds its transaction (a citation regex once took 87 s
// on 24 KB, before that parser was removed). Each case is a shape that makes nested quantifiers backtrack.

import { describe, it, expect } from "vitest";
import { extractWikilinks, extractAttributes, extractFrontmatterAttributes } from "../utils.js";
import { inertUnpublishedWikilinks } from "../modules/website/publishing/redaction.js";
import { parseSearchQuery } from "@onden/markdown";
import { parseBlocks, parseLegacyBlocks, legacyBlockAnchors, headingAnchors, noteSummary, snippetAround } from "@onden/markdown";
import { ondenMarkdown } from "@onden/markdown/full";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { bestRatio, timed, CEILING_MS, FAST_MS, MAX_RATIO } from "../../../markdown/src/linearTiming.testing.js";

// Linear means a body four times as long takes about four times as long; a
// quadratic parser takes sixteen (the timing helper is shared with the frontend
// twin). Cases fast enough at the full size pass without the comparison.
const N = 32_000;

// Long multi-line paragraphs: micromark merged a paragraph's data runs with
// one splice each (quadratic; gfm's autolink literal splits every line into
// runs), fixed by patches/micromark+4.0.2.patch. The trailing `{t}` makes
// parseBlocks parse them. Shared with the export parse below.
const paragraphs: Record<string, (n: number) => string> = {
  "key lines": (n) => "k: v\n".repeat(n / 5) + "x {t}",
  "prose lines": (n) => "Some words go here, and more.\n".repeat(n / 30) + "x {t}",
  "autolink lines": (n) => "see https://example.com/a 中文www.b.org localhost:5199 x@y.z\n".repeat(n / 60) + "x {t}",
  "crlf lines": (n) => "a www.c.d 中\r\n".repeat(n / 13) + "x {t}",
  // The run blocks.ts names for BLOCK_PARSE_MAX: one data run per `![a](`.
  "unclosed image run": (n) => "![a](".repeat(n / 5) + " {t}",
};

const bodies: Record<string, (n: number) => string> = {
  "open brackets": (n) => "[[".repeat(n),
  "unclosed link": (n) => "[[" + "a".repeat(n),
  "bracket at-signs": (n) => "[@".repeat(n),
  "hash equals": (n) => "#a=".repeat(n),
  "spaced hash": (n) => " #k".repeat(n),
  "inline attr": (n) => "k:: ".repeat(n),
  "bracket attr": (n) => "[k:: " + "v".repeat(n),
  "bracket attr run": (n) => "[k:: v ".repeat(n / 7),
  "tilde fences": (n) => "~~~\nk:: v\n".repeat(n / 10),
  // D44: keys are any letters now; a long key run without its `::` / `:`.
  "cjk inline attr": (n) => "作者:: ".repeat(n / 2),
  "cjk key run": (n) => "作".repeat(n) + ": x",
  "cjk bracket keys": (n) => ("[" + "作".repeat(40)).repeat(n / 41),
  "cjk bracket attr": (n) => "[作者:: " + "值".repeat(n),
  "cjk frontmatter": (n) => "---\n" + "作者: 王\n".repeat(n / 6) + "作".repeat(n),
  "cjk frontmatter key": (n) => "---\n" + "作".repeat(n) + "\n---\n",
  // D44b: `#key=value` and search `key:value` read the same key grammar.
  "hash digit equals": (n) => " #1=".repeat(n / 4),
  "cjk hash equals": (n) => " #作者=王".repeat(n / 6),
  "cjk hash key run": (n) => " #" + "作".repeat(n) + "!",
  "cjk search attrs": (n) => "作者:王 ".repeat(n / 5),
  "cjk search urls": (n) => "作者://".repeat(n / 5),
  // D58: marks are word characters; runs of them (and NFD text) in each grammar.
  "mark key run": (n) => "क" + "ी".repeat(n) + ": x",
  "mark hash run": (n) => " #क" + "ि".repeat(n) + "!",
  "mark inline attrs": (n) => "कीमत:: ".repeat(n / 6),
  "nfd links": (n) => "[[Cafe\u0301".repeat(n / 7),
  "colons": (n) => ":".repeat(2 * n),
  "carets": (n) => " ^".repeat(n) + "x",
  "block id run": (n) => "text ^" + "a".repeat(n),
  "frontmatter": (n) => "---\n" + "k: v\n".repeat(n / 4) + "x".repeat(n),
  "fences": (n) => "```\n".repeat(n / 4),
  "unclosed md links": (n) => "[a".repeat(n),
  "unclosed images": (n) => "![a](".repeat(n / 2),
  "embeds": (n) => "![[".repeat(n),
  // Block nodes' `{…}` / `^id` at block ends.
  "brace run": (n) => "x " + "{".repeat(n) + "}",
  "tagged lines": (n) => "line {t}\n\n".repeat(n / 10),
  "deep list": (n) => Array.from({ length: n / 40 }, (_, i) => `${"  ".repeat(i % 12)}- item {t}`).join("\n"),
  "caret runs": (n) => "x " + "^".repeat(n) + "a",
  "nested quotes": (n) => "> ".repeat(n / 16) + "x {t}",
  "nested callouts": (n) => Array.from({ length: n / 64 }, (_, i) => `${"> ".repeat(i % 40)}[!note] T {c}`).join("\n"),
  // D59: every block kind's legacy `^id` (legacyBlockAnchors; 切換前舊資料的讀法).
  "anchored items": (n) => "- item ^a\n".repeat(n / 10),
  "anchored headings": (n) => "## h ^a\n".repeat(n / 8),
  "standalone ids": (n) => "- x\n\n^a\n\n".repeat(n / 10),
  // D62: heading anchors (text up to the markers, de-duplicated ids).
  "marked headings": (n) => "## h {t} ^a\n".repeat(n / 12),
  "setext underline": (n) => "a\n" + "-".repeat(n - 8) + "x",
  "heading links": (n) => "## " + "[[a".repeat(n / 3 - 4),
  ...paragraphs,
  // D76: search snippets fold every character (surrogates, combining marks).
  "emoji run": (n) => "😀".repeat(n),
  "combining marks": (n) => "e\u0301".repeat(n),
};
// headingAnchors keeps its last result: a space every other call makes each
// run parse.
let headingRuns = 0;
const parsers: Record<string, (body: string) => unknown> = {
  extractWikilinks, extractAttributes, extractFrontmatterAttributes, legacyBlockAnchors,
  parseBlocks, parseLegacyBlocks,
  noteSummary: (body) => noteSummary(body, { maxLen: 280 }), redaction: (body) => inertUnpublishedWikilinks(body, [], "(private)"),
  parseSearchQuery, // a pasted note is a query too
  // D76: /api/nodes/search builds each hit's snippet over the whole body.
  snippetAround: (body) => snippetAround(body, ["a", "😀", "é"]), snippetAroundMiss: (body) => snippetAround(body, ["aaaaaaab", "zz"]),
  headingAnchors: (body) => headingAnchors(body + " ".repeat(headingRuns++ % 2)), // md2html's [[Page#Heading]]
};

describe("body parsers stay linear on pathological bodies", () => {
  for (const [parser, parse] of Object.entries(parsers)) {
    it(parser, () => {
      for (const [shape, bodyOf] of Object.entries(bodies)) {
        const big = bodyOf(N), small = bodyOf(N / 4);
        const label = `${parser} on ${shape} (${big.length} chars)`;
        if (timed(() => parse(big)) < FAST_MS) continue;
        const { ratio, smallMs, bigMs, fastestBigMs } = bestRatio(() => parse(small), () => parse(big));
        if (fastestBigMs < FAST_MS) continue;
        expect(fastestBigMs, `${label}: ${fastestBigMs.toFixed(0)} ms`).toBeLessThan(CEILING_MS);
        expect(ratio, `${label}: ${smallMs.toFixed(1)} → ${bigMs.toFixed(1)} ms for 4× the length`).toBeLessThan(MAX_RATIO);
      }
    }, 120_000);
  }
});

// The exports' Markdown parse (remark + the published profile's plugins, gfm
// included; md2html's first half) on long paragraphs, at 128k chars: block
// nodes are capped at BLOCK_PARSE_MAX (32k) but an export reads the whole
// note. The rehype half is left out: at 128k its run times swing with GC.
describe("the Markdown parse stays linear on long paragraphs", () => {
  const md = ondenMarkdown({ profile: "published", wikilinkHref: () => "#" });
  const processor = unified().use(remarkParse).use(md.remarkPlugins);
  const parse = (body: string) => processor.runSync(processor.parse(md.prepare(body)));
  for (const [shape, bodyOf] of Object.entries(paragraphs)) {
    it(shape, () => {
      const big = bodyOf(4 * N), small = bodyOf(N);
      const label = `parse on ${shape} (${big.length} chars)`;
      const { ratio, smallMs, bigMs, fastestBigMs } = bestRatio(() => parse(small), () => parse(big));
      expect(fastestBigMs, `${label}: ${fastestBigMs.toFixed(0)} ms`).toBeLessThan(CEILING_MS);
      expect(ratio, `${label}: ${smallMs.toFixed(0)} → ${bigMs.toFixed(0)} ms for 4× the length`).toBeLessThan(MAX_RATIO);
    }, 120_000);
  }
});
