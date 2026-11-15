// Every parser the app runs over a note's text (rendering previews, link and
// tag lists, word counts, citations, published-site helpers) must stay roughly
// linear: one pasted pathological body otherwise freezes the tab for seconds
// (the backend twin: packages/backend/src/test/bodyParsersLinear.test.ts).
// Each shape below made a regex with an unbounded run rescan to the end.

import { describe, it, expect } from "vitest";
import { stripTrailing, trimLineSpaces } from "../lib/textScan";
import { wikilinkBodies, replaceWikilinks, snippetAround, extractBlock, noteSummary, blankInkRegionSyntax } from "@onden/markdown";
import { stripHashtagMarks, isHashtagOnlyLine } from "../lib/hashtags";
import { wordStats } from "../lib/wordStats";
import { feedSummary } from "../lib/siteFeed";
import { extractTOC } from "../components/templates/publishedCore";
import { findBacklinkSnippet } from "../lib/backlinks";
import { noteExportFilename } from "../lib/noteExport";
import type { ContentNode } from "../lib/api";
import { appendBlock } from "../components/MarkdownEditor";
import { detectPopupTrigger } from "../lib/editorCompletion";
import { evalFilter } from "../lib/basesEval";
import { unified } from "unified";
import { bestRatio, timed, CEILING_MS, FAST_MS, MAX_RATIO } from "../../../markdown/src/linearTiming.testing";
import remarkParse from "remark-parse";
import { ondenMarkdown } from "@onden/markdown/full";

// Linear means a body four times as long takes about four times as long; a
// quadratic parser takes sixteen (the timing helper is shared with the backend
// twin). Cases fast enough at the full size pass without the comparison.
const N = 32_000;

// Long multi-line paragraphs: micromark merged a paragraph's data runs with
// one splice each (quadratic; gfm's autolink literal splits every line into
// runs), fixed by patches/micromark+4.0.2.patch. Shared with the parse below.
const paragraphs: Record<string, (n: number) => string> = {
  "key lines": (n) => "k: v\n".repeat(n / 5),
  "prose lines": (n) => "Some words go here, and more.\n".repeat(n / 30),
  "autolink lines": (n) => "see https://example.com/a 中文www.b.org localhost:5199 x@y.z\n".repeat(n / 60),
  "crlf lines": (n) => "a www.c.d 中\r\n".repeat(n / 13),
  // The run blocks.ts names for BLOCK_PARSE_MAX: one data run per `![a](`.
  "unclosed image run": (n) => "![a](".repeat(n / 5),
};

const bodies: Record<string, (n: number) => string> = {
  "open brackets": (n) => "[[".repeat(n),
  "unclosed link": (n) => "[[" + "a".repeat(n),
  "bracket at-signs": (n) => "[@".repeat(n),
  "unclosed md links": (n) => "[a".repeat(n),
  "unclosed images": (n) => "![a](".repeat(n / 2),
  "embeds": (n) => "![[".repeat(n),
  // A quoted area's `|ink=…` (inkRegion.ts): one at the end of a long line, an embed that never closes, and many bars.
  "long line then a region embed": (n) => "![[" + "a".repeat(n) + "|ink=p@1,2,3,4]]",
  "unclosed embed with text": (n) => "![[" + "a b ".repeat(n / 4),
  "region embed bars": (n) => "![[a" + "|ink=p@1,2,3,4".repeat(n / 14),
  "hashes": (n) => " #a".repeat(n),
  "hash run": (n) => "#" + "a".repeat(n) + "!",
  "spaces": (n) => " ".repeat(2 * n) + "x",
  "space lines": (n) => (" ".repeat(200) + "\n").repeat(n / 100),
  "dots": (n) => ".".repeat(2 * n) + "x",
  "carets": (n) => " ^".repeat(n) + "x",
  "backticks": (n) => "`a".repeat(n),
  "fences": (n) => "```\n".repeat(n / 4),
  "headings": (n) => "## a\n".repeat(n / 4),
  // D44b: a Bases comparison reads keys in the attribute key grammar.
  "cjk key run": (n) => "作".repeat(n) + " =",
  "cjk comparisons": (n) => '作者 == "王" '.repeat(n / 11),
  // D58: marks are word characters in every grammar.
  "mark hash run": (n) => " #क" + "ि".repeat(n) + "!",
  "mark key run": (n) => "क" + "ी".repeat(n) + " =",
  "nfd links": (n) => "[[Cafe\u0301".repeat(n / 7),
  // D59: every block kind an anchor can start at (extractBlock reads anchors; a `^a` in the text is plain text now).
  "anchored items": (n) => "- item ^a\n".repeat(n / 10),
  "standalone ids": (n) => "- x\n\n^a\n\n".repeat(n / 10),
  // D62: extractTOC reads headingAnchors.
  "marked headings": (n) => "## h {t} ^a\n".repeat(n / 12),
  "setext underline": (n) => "a\n" + "-".repeat(n - 8) + "x",
  "heading links": (n) => "## " + "[[a".repeat(n / 3 - 4),
  ...paragraphs,
  // D76: search snippets fold every character (surrogates, combining marks).
  "emoji run": (n) => "😀".repeat(n),
  "combining marks": (n) => "e\u0301".repeat(n),
};
const node = (markdown: string) => ({ id: "n", title: "T", slug: "t", markdown }) as ContentNode;
// headingAnchors (under extractTOC) keeps its last result: a space every
// other call makes each run parse.
let tocRuns = 0;
const parsers: Record<string, (body: string) => unknown> = {
  wikilinkBodies, replaceWikilinks: (b) => replaceWikilinks(b, (x) => x),
  stripTrailing: (b) => stripTrailing(b, ". "), trimLineSpaces,
  stripHashtagMarks, isHashtagOnlyLine,
  wordStats, feedSummary: (b) => feedSummary({ markdown: b, title: "T" }),
  extractBlock: (b) => extractBlock(b, "abc", [{ id: "abc", from: 0, to: Math.min(b.length, 5) }]), noteSummary: (b) => noteSummary(b, { title: "T", maxLen: 200 }), blankInkRegionSyntax: (b) => blankInkRegionSyntax(b),
  extractTOC: (b) => extractTOC(b + " ".repeat(tocRuns++ % 2)),
  findBacklinkSnippet: (b) => findBacklinkSnippet(node(b), node("")),
  noteExportFilename: (b) => noteExportFilename(b, "md"),
  appendBlock: (b) => appendBlock(b, "x"), detectPopupTrigger: (b) => detectPopupTrigger(b),
  // A Bases filter leaf is one line of a note's ```base block.
  // D76: the search snippet (offline index, sidebar, published site); a hit
  // near the start and a term that never occurs.
  snippetAround: (b) => snippetAround(b, ["a", "😀", "é"]), snippetAroundMiss: (b) => snippetAround(b, ["aaaaaaab", "zz"]),
  evalFilter: (b) => evalFilter({ id: "n", title: "T", markdown: "", node_type: "content", frontmatter: {} }, { kind: "leaf", expr: b }),
};

describe("body parsers stay linear on pathological bodies", () => {
  for (const [parser, parse] of Object.entries(parsers)) {
    it(parser, () => {
      for (const [shape, bodyOf] of Object.entries(bodies)) {
        const big = bodyOf(N), small = bodyOf(N / 4);
        const label = `${parser} on ${shape} (${big.length} chars)`;
        // A busy CPU only slows a run, so one fast run proves the case fast; a
        // slow one may be the load (or the first, unoptimised run) and is
        // looked at again in the pairs.
        if (timed(() => parse(big)) < FAST_MS) continue;
        const { ratio, smallMs, bigMs, fastestBigMs } = bestRatio(() => parse(small), () => parse(big));
        if (fastestBigMs < FAST_MS) continue;
        expect(fastestBigMs, `${label}: ${fastestBigMs.toFixed(0)} ms`).toBeLessThan(CEILING_MS);
        expect(ratio, `${label}: ${smallMs.toFixed(1)} → ${bigMs.toFixed(1)} ms for 4× the length`).toBeLessThan(MAX_RATIO);
      }
    }, 120_000);
  }
});

// The preview's Markdown parse (remark + the app's plugins, gfm included) on
// long paragraphs, at 128k chars: block nodes are capped at BLOCK_PARSE_MAX
// (32k) but the preview reads the whole note.
describe("the Markdown parse stays linear on long paragraphs", () => {
  const md = ondenMarkdown({ profile: "app", wikilinkHref: () => "#" });
  const processor = unified().use(remarkParse).use(md.remarkPlugins);
  const parse = (body: string) => processor.runSync(processor.parse(md.prepare(body)));
  for (const [shape, bodyOf] of Object.entries(paragraphs)) {
    it(shape, () => {
      const big = bodyOf(4 * N), small = bodyOf(N);
      const { ratio, smallMs, bigMs, fastestBigMs } = bestRatio(() => parse(small), () => parse(big));
      const label = `parse on ${shape} (${big.length} chars)`;
      expect(fastestBigMs, `${label}: ${fastestBigMs.toFixed(0)} ms`).toBeLessThan(CEILING_MS);
      expect(ratio, `${label}: ${smallMs.toFixed(0)} → ${bigMs.toFixed(0)} ms for 4× the length`).toBeLessThan(MAX_RATIO);
    }, 120_000);
  }
});
