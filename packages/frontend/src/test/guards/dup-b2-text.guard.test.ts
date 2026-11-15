// Frontend half of the 2026-10-30 "markdown text" dedupe batch (render A3, A7; the Markdown-text rules
// are packages/markdown/src/test/guards/dup-b2-text.guard.test.ts). Allow-lists: one owner may do the
// thing, any other file that does it fails; an exception says why, and a stale one fails too.
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { findImports, findUses, SRC, sourceFiles } from "./sources";

type Exceptions = Record<string, string>;

function check(hits: string[], exceptions: Exceptions, what: string) {
  const files = new Set(hits.map((h) => h.split(/[:\s]/)[0]));
  expect(hits.filter((h) => !(h.split(/[:\s]/)[0]! in exceptions)), what).toEqual([]);
  expect(Object.keys(exceptions).filter((f) => !files.has(f)), "these exceptions no longer need to be listed").toEqual([]);
}

describe("the allow-list check itself", () => {
  it("fails on a file nobody listed, and on a stale exception", () => {
    expect(() => check(["stray.tsx:3"], {}, "x")).toThrow();
    expect(() => check([], { "gone.tsx": "old" }, "x")).toThrow();
    expect(() => check(["listed.tsx:3"], { "listed.tsx": "why" }, "x")).not.toThrow();
  });
});

const rel = (file: string) => relative(SRC, file);
const files = sourceFiles(".");

// ── A3. MarkdownRenderer is drawn through a named surface ────────────────────
// Which links resolve, whether math and diagrams draw, which profile — each screen used to pick
// those props again by hand. components/markdownSurfaces.tsx names the surfaces; the published
// pages (siteFrame/siteMarkdown) are the other surface, with their own profile.
const RENDERER_OWNERS = ["components/markdownSurfaces.tsx", "components/siteFrame/siteMarkdown.tsx"];
// ratchet:list RENDERER_KEPT
const RENDERER_KEPT: Exceptions = {
  "components/CardNode.tsx": "the whiteboard card (diagrams off, links resolved on click); in-flight PR on this file — becomes a CardPreview surface after it lands",
};

describe("MarkdownRenderer is imported only by the surfaces file", () => {
  it("no other component imports it", () => {
    const hits = findImports(files, /(?:^|\/)MarkdownRenderer$/).filter((h) => !RENDERER_OWNERS.some((o) => h.startsWith(`${o} `)));
    check(hits.map((h) => h.split(" ")[0]!), RENDERER_KEPT, "draw the note through components/markdownSurfaces.tsx (NotePreview, ReviewCard, ReaderArticle, makeMarkdownRenderer)");
  });

  it("sees an import it should not allow", () => {
    expect(findImports([], /x/)).toEqual([]);
    const sample = 'import MarkdownRenderer from "../components/MarkdownRenderer";';
    expect(/(?:^|\/)MarkdownRenderer$/.test(sample.match(/from\s+"([^"]+)"/)![1]!)).toBe(true);
  });
});

// ── A7. A highlighted match is drawn by SnippetText ──────────────────────────
// Ranges are half-open [start, end) everywhere (matchTitle, the server's snippets, the backlink's
// link span), drawn by SnippetText; HighlightedText's closed ranges are gone.
const MARK_OWNERS = ["components/SnippetText.tsx", "components/siteFrame/SiteFrames.tsx", "components/siteFrame/SiteWidgets.tsx"];
// ratchet:list MARK_KEPT
const MARK_KEPT: Exceptions = {
  "lib/siteSearch.ts": "turns Pagefind's own `<mark>` excerpt into parts (reads the tag, draws nothing)",
  "lib/editorFormat.ts": "the Highlight formatting button writes `<mark>` into the note's Markdown",
};

describe("a <mark> element is rendered only by SnippetText (and the published site frames)", () => {
  it("no other file draws one", () => {
    const hits = findUses(files, /<mark\b/, MARK_OWNERS.map((o) => o));
    check(hits, MARK_KEPT, "show the match with <SnippetText snippet={{ text, ranges }} /> (ranges are half-open)");
  });

  it("sees a violation", () => {
    expect(/<mark\b/.test('<mark className="x">{text}</mark>')).toBe(true);
  });
});

describe("the removed HighlightedText stays removed", () => {
  it("nothing mentions it", () => {
    expect(findUses(files, /\bHighlightedText\b/)).toEqual([]);
    expect(files.map(rel)).not.toContain("components/HighlightedText.tsx");
  });
});
