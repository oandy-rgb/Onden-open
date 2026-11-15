// Random notes against the pages of the 「簡報」 view (modules/slides/slides.ts parseDeck, pages.ts pagesOf / partsOf /
// layoutOfPage, exportPptx/deckSpec.ts + fonts.ts). The Markdown of the note is the only source; the pages are cut
// from it each time it is read, so every property here is about that cut:
//
//   1  nothing is lost or doubled: each page is what the generator put in it; every word shown reaches exactly one page
//   2  code never cuts: `---` and `## ` inside ``` / ~~~ fences are text; frontmatter is not a page
//   3  stable: the same text cuts the same; adding a paragraph to a page changes no page count and no other page's key
//   4  `page.key`: unique within a deck, anchors win over words, a title edit keeps an anchored key
//   5  layoutOfPage: always one of the twelve layouts, whatever `layouts` holds (bad ids, `__proto__`, `constructor`)
//   6  partsOf / autoLayout: never throw; paragraphs are speaker notes unless the page has nothing else
//   7  LF or CRLF: same pages
//   8  PPTX export without a DOM: numbers finite and non-negative, font lists well formed
//
// The generator (test/helpers/slidesDeckGen.ts) is shared: the tests of page edits build their decks from it.
// The cases at the end are fixed ones the properties once found; the properties now cover them too.
//
// Replay a failure:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/slidesPages

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseDeck } from "../../modules/slides/slides";
import { withPageLayout } from "@onden/markdown";
import { autoLayoutOf, LAYOUT_IDS, layoutOfPage, layoutSource, layoutsByPageKey, pagesOf, partsOf, type Page } from "../../modules/slides/pages";
import { analyzeSlide, plainWords, slideBlockText } from "../../modules/slides/analyze";
import { buildDeckSpec } from "../../modules/slides/exportPptx/deckSpec";
import { fontFile, FONT_CHOICES, substitutions } from "../../modules/slides/exportPptx/fonts";
import type { MeasuredItem, MeasuredSlide, FontKind, Run } from "../../modules/slides/exportPptx/measured";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { asCrlf, deckDoc, hiddenWords, numberWords, pageMd, shownWords, solid, type DeckDoc } from "../helpers/slidesDeckGen";

const cfg = { numRuns: PROPS_RUNS, seed: PROPS_SEED };

const nonBlank = (pages: readonly string[]) => pages.filter((p) => p.trim() !== "");
const lf = (text: string) => text.replace(/\r\n/g, "\n");
/** What a reader sees of a page, as words: heading, the lines of the page, the speaker's notes. */
function shownText(page: Page): string {
  const { heading, statement, subtitle, body } = page.parts;
  return [heading, statement && plainWords(statement), subtitle && plainWords(subtitle), ...body.map(slideBlockText), plainWords(page.notes)].filter(Boolean).join("\n");
}

describe("1 nothing is lost or doubled", { timeout: 120_000 }, () => {
  it("parseDeck gives each page exactly as built (whitespace aside), in order", () => {
    fc.assert(
      fc.property(deckDoc({ legacyIds: true }), (doc) => {
        const slides = parseDeck(doc.render()).slides;
        const want = doc.mode === "empty" ? [""] : nonBlank(doc.pagesMd);
        expect(slides.map((s) => solid(s.markdown))).toEqual(want.map(solid));
        // the same as one run of characters: none dropped, none twice
        expect(solid(slides.map((s) => s.markdown).join(""))).toBe(solid(want.join("")));
      }),
      cfg,
    );
  });

  it("every word a page shows reaches exactly one page of pagesOf; no hidden word does", () => {
    fc.assert(
      fc.property(deckDoc(), (doc) => {
        const text = doc.render();
        const pages = pagesOf(text);
        const want = doc.mode === "empty" ? [] : nonBlank(doc.pagesMd).map(shownWords);
        expect(pages.map((p) => shownWords(shownText(p)).sort())).toEqual(doc.mode === "empty" ? [[]] : want.map((w) => [...w].sort()));
        expect(hiddenWords(pages.map(shownText).join("\n")).filter((w) => !doc.pagesMd.join("\n").includes(w))).toEqual([]);
        // frontmatter words are in no page at all
        const front = hiddenWords(doc.front);
        for (const page of pages) for (const w of front) expect(shownText(page)).not.toContain(w);
      }),
      cfg,
    );
  });
});

describe("2 code and frontmatter do not cut", { timeout: 120_000 }, () => {
  const HAZARD = ["---", "---  ", "## x", "## ", "# x", "***", "", "  ---", "- ---", "> ---"];
  const FENCES: [string, string][] = [["```", "```"], ["~~~", "~~~"], ["````", "````"], ["```ts", "```"], ["~~~~~", "~~~~~"]];

  it("a note with one code block of cutting-looking lines is one page (or its own ## cuts only)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...FENCES), fc.array(fc.constantFrom(...HAZARD), { minLength: 1, maxLength: 8 }), fc.constantFrom("", "---\ntitle: x\n---\n\n"), (fence, lines, front) => {
        const text = `${front}intro\n\n${fence[0]}\n${lines.join("\n")}\n${fence[1]}\n\noutro`;
        const slides = parseDeck(text).slides;
        expect(slides).toHaveLength(1);
        expect(solid(slides[0]!.markdown)).toBe(solid(text.slice(front.length)));
        expect(pagesOf(text)).toHaveLength(1);
      }),
      cfg,
    );
  });

  it("an unclosed fence runs to the end: what follows is code, not pages", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("---", "## x", "", "text"), { minLength: 0, maxLength: 8 }), (lines) => {
        const text = `intro\n\n\`\`\`\n${lines.join("\n")}`;
        expect(parseDeck(text).slides).toHaveLength(1);
      }),
      cfg,
    );
  });

  it("frontmatter is never a page: the pages are the same with it and without it", () => {
    fc.assert(
      fc.property(deckDoc(), (doc) => {
        const cut = (text: string) => parseDeck(text).slides.map((s) => solid(s.markdown));
        expect(cut(doc.render())).toEqual(cut(doc.render(doc.pagesMd, false)));
      }),
      cfg,
    );
  });
});

describe("3 stable", { timeout: 120_000 }, () => {
  it("the same text cuts the same way twice", () => {
    fc.assert(
      fc.property(deckDoc(), (doc) => {
        const text = doc.render();
        expect(parseDeck(text)).toEqual(parseDeck(text));
        expect(JSON.stringify(pagesOf(text))).toBe(JSON.stringify(pagesOf(text)));
      }),
      cfg,
    );
  });

  it("a paragraph added inside a page: same page count, other pages keep their key; a titled page keeps its own", () => {
    fc.assert(
      fc.property(deckDoc(), fc.nat(), (doc, pick) => {
        const at = nonBlankIndexes(doc)[pick % Math.max(1, nonBlankIndexes(doc).length)];
        fc.pre(at !== undefined && doc.mode !== "empty");
        const before = pagesOf(doc.render());
        const edited = doc.pagesMd.map((p, i) => (i === at ? `${p}\n\nadded paragraph w99999z` : p));
        const after = pagesOf(doc.render(edited));
        expect(after).toHaveLength(before.length);
        const index = nonBlankIndexes(doc).indexOf(at!);
        before.forEach((page, i) => {
          if (i !== index) expect(after[i]!.key).toBe(page.key);
          else if (/^(\^|h:)/.test(page.key)) expect(after[i]!.key).toBe(page.key);
        });
      }),
      cfg,
    );
  });
});

const nonBlankIndexes = (doc: DeckDoc): number[] => doc.pagesMd.flatMap((p, i) => (p.trim() ? [i] : []));

describe("4 page.key", { timeout: 120_000 }, () => {
  const KEY = /^(\^[A-Za-z0-9-]+|h:.+|p:.+|n:\d+)(~\d+)?$/s;

  it("keys are unique in a deck and well formed", () => {
    fc.assert(
      fc.property(deckDoc(), (doc) => {
        const keys = pagesOf(doc.render()).map((p) => p.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const key of keys) expect(key).toMatch(KEY);
      }),
      cfg,
    );
  });

  it("pages with the same content stay unique (`~2`, `~3` … tell them apart)", () => {
    fc.assert(
      fc.property(fc.array(pageMd({ h2: true }).map((p) => numberWords([p])[0]!), { minLength: 1, maxLength: 3 }), fc.integer({ min: 2, max: 5 }), (distinct, copies) => {
        const pages = distinct.flatMap((p) => Array.from({ length: copies }, () => p));
        const text = pages.join("\n\n---\n\n");
        const keys = pagesOf(text).map((p) => p.key);
        fc.pre(parseDeck(text).slides.length === pages.length); // (a page that is only `[n]` lines would be the source list)
        expect(new Set(keys).size).toBe(keys.length);
        // copies of one titled page share a base key; only the order tells them apart (`~2`, `~3` …)
        distinct.forEach((_, d) => {
          const own = keys.slice(d * copies, (d + 1) * copies).map((key) => key.replace(/~\d+$/, ""));
          if (/^[hp]:/.test(own[0]!)) expect(new Set(own).size).toBe(1);
        });
      }),
      cfg,
    );
  });

  it("the key is the heading's anchor when it has one, else its words; an edit of the title keeps an anchored key", () => {
    fc.assert(
      fc.property(deckDoc(), fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }), (doc, flags) => {
        fc.pre(doc.mode !== "empty");
        const text = doc.render();
        const slides = parseDeck(text).slides;
        const plain = pagesOf(text);
        const anchorsFor = (source: string) => {
          let cursor = 0;
          return parseDeck(source).slides.flatMap((slide, i) => {
            const line = analyzeSlide(slide.markdown).find((b) => b.kind === "heading")?.markdown;
            const found = source.indexOf(slide.markdown, cursor);
            if (found >= 0) cursor = found + slide.markdown.length;
            return line && found >= 0 && flags[i] ? [{ id: `id-${i}`, from: found + slide.markdown.indexOf(line), to: found + slide.markdown.indexOf(line) + line.length }] : [];
          });
        };
        const anchors = anchorsFor(text);
        const anchored = pagesOf(text, anchors);
        expect(anchored).toHaveLength(slides.length);
        anchored.forEach((page, i) => {
          const anchor = anchors.find((a) => a.id === `id-${i}`);
          if (anchor) expect(page.key).toBe(`^id-${i}`);
          // (a page's `~n` counts only the pages before it that are keyed by words, so an anchor above it can lower it)
          else expect(page.key.replace(/~\d+$/, "")).toBe(plain[i]!.key.replace(/~\d+$/, ""));
        });
        // the title changes, the anchor is read again at the same heading: same key
        const retitled = text.replace(/^(#{1,6}) /m, "$1 renamed ");
        const again = pagesOf(retitled, anchorsFor(retitled));
        again.forEach((page, i) => { if (anchors.some((a) => a.id === `id-${i}`)) expect(page.key).toBe(anchored[i]!.key); });
      }),
      { ...cfg, numRuns: Math.min(PROPS_RUNS, 300) }, // each run cuts the note four times
    );
  });
});

describe("5 layoutOfPage", { timeout: 120_000 }, () => {
  const NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "", "cover", "COVER", " cover", "nope", ...LAYOUT_IDS];
  const layoutId = fc.constantFrom(...LAYOUT_IDS);
  const fakePage = (key: string, autoLayout: (typeof LAYOUT_IDS)[number]): Page => ({ key, parts: { heading: null, headingId: null, statement: null, subtitle: null, body: [] }, notes: "", cites: [], autoLayout });
  /** `layouts` as `slides_data` carries it after JSON: `__proto__` is an own key there. */
  const layoutsOf = (entries: [string, unknown][]) => JSON.parse(`{${entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`) as Record<string, string>;

  it("answers one of the twelve layouts for any key and any layouts, and never throws", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...NAMES), fc.string({ maxLength: 12 })),
        layoutId,
        fc.array(fc.tuple(fc.oneof(fc.constantFrom(...NAMES), fc.string({ maxLength: 8 })), fc.oneof(fc.constantFrom(...NAMES), fc.string({ maxLength: 8 }), fc.integer(), fc.constant(null), fc.object({ maxDepth: 1 }))), { maxLength: 8 }),
        fc.boolean(),
        (key, auto, entries, plainObject) => {
          const layouts = plainObject ? Object.fromEntries(entries.filter(([k]) => k !== "__proto__")) as Record<string, string> : layoutsOf(entries);
          const got = layoutOfPage(fakePage(key, auto), layouts);
          expect(LAYOUT_IDS).toContain(got);
          // a chosen layout that is a layout wins; anything else falls back to the page's own
          const own = Object.hasOwn(layouts, key) ? layouts[key] : undefined;
          expect(got).toBe(typeof own === "string" && (LAYOUT_IDS as readonly string[]).includes(own) ? own : auto);
        },
      ),
      cfg,
    );
  });

  it("for the pages of a random deck too, with their own keys chosen", () => {
    fc.assert(
      fc.property(deckDoc(), fc.array(fc.constantFrom(...NAMES), { minLength: 12, maxLength: 12 }), (doc, picks) => {
        const pages = pagesOf(doc.render());
        const layouts = Object.fromEntries(pages.map((p, i) => [p.key, picks[i]!]));
        pages.forEach((page, i) => expect(layoutOfPage(page, layouts)).toBe((LAYOUT_IDS as readonly string[]).includes(picks[i]!) ? picks[i] : page.autoLayout));
      }),
      cfg,
    );
  });
});

describe("6 partsOf and the automatic layout", { timeout: 120_000 }, () => {
  /** Any text at all, made of the pieces that trip a reader of Markdown. */
  const PIECES = ["---", "## ", "# ", "```", "~~~", "$$", "> ", "- ", "- [ ] ", "1. ", "| a | b |", "|---|", "![", "](", "[[", "]]", "^abc", " ^id", "\r\n", "\n", "\n\n", "  ", "*", "**", "~~", "`", "<b>", "\u0000", "中文", "😀", "👨‍👩‍👧", "e\u0301", "\u200b", "[1] x", "[^1]", "2024 ", "90% "];
  const noise = fc.oneof(fc.string({ maxLength: 60 }), fc.string({ unit: "binary", maxLength: 30 }), fc.array(fc.constantFrom(...PIECES), { maxLength: 24 }).map((p) => p.join("")));

  it("never throw, whatever the text and the page's place", () => {
    fc.assert(
      fc.property(noise, fc.integer({ min: 0, max: 30 }), (text, index) => {
        const { parts, notes } = partsOf(text, index);
        expect(typeof notes).toBe("string");
        expect(LAYOUT_IDS).toContain(autoLayoutOf(parts, index));
        for (const page of pagesOf(text)) {
          expect(LAYOUT_IDS).toContain(page.autoLayout);
          expect(page.key.length).toBeGreaterThan(0);
        }
        expect(pagesOf(text).length).toBeGreaterThan(0);
      }),
      cfg,
    );
  });

  it("a page's paragraphs are speaker notes unless nothing else is on it; its lists, quotes, code and pictures are on the page", () => {
    fc.assert(
      fc.property(deckDoc(), (doc) => {
        for (const [i, slide] of parseDeck(doc.render()).slides.entries()) {
          const blocks = analyzeSlide(slide.markdown);
          const headingAt = blocks.findIndex((b) => b.kind === "heading");
          const rest = blocks.filter((_, k) => k !== headingAt);
          const paragraphs = rest.filter((b) => b.kind === "paragraph");
          const shown = rest.filter((b) => b.kind !== "paragraph");
          const { parts, notes } = partsOf(slide.markdown, i);
          expect(parts.heading).toBe(headingAt >= 0 ? blocks[headingAt]!.heading!.text : null);
          if (shown.length > 0) {
            expect(parts.body.map((b) => b.markdown)).toEqual(shown.map((b) => b.markdown));
            expect(notes).toBe(paragraphs.map((b) => b.markdown).join("\n\n"));
            expect(parts.statement).toBeNull();
            expect(parts.subtitle).toBeNull();
          } else if (paragraphs.length === 0) {
            expect(parts.body).toEqual([]);
            expect(notes).toBe("");
            expect(parts.statement ?? parts.subtitle).toBeNull();
          } else {
            // nothing but paragraphs (and maybe a heading): the first one stays on the page, the rest are notes
            const first = paragraphs[0]!;
            const onPage = [parts.statement, parts.subtitle, ...parts.body.map((b) => b.markdown)].filter(Boolean);
            expect(onPage).toEqual([first.markdown]);
            expect(notes).toBe(paragraphs.slice(1).map((b) => b.markdown).join("\n\n"));
          }
        }
      }),
      cfg,
    );
  });

  it("a page with a single short paragraph is a big statement; a first page with a heading and one line is a cover", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("中文", "word", "😀", "數據"), { minLength: 1, maxLength: 8 }).map((w) => w.join(" ")), fc.integer({ min: 0, max: 5 }), (line, index) => {
        const { parts } = partsOf(line, index);
        expect(parts.statement).toBe(line);
        expect(parts.body).toEqual([]);
        expect(autoLayoutOf(parts, index)).toBe("section");
        const titled = partsOf(`# Title\n\n${line}`, 0);
        expect(titled.parts.statement).toBeNull();
        expect(titled.parts.subtitle).toBe(line);
        expect(autoLayoutOf(titled.parts, 0)).toBe("cover");
      }),
      cfg,
    );
  });

  it("the words of a heading and the key carry no Markdown marks", () => {
    const MARKS = /\*\*|~~|`|\[\[|\]\]|\]\(|^#/;
    fc.assert(
      fc.property(deckDoc({ legacyIds: false }), (doc) => {
        for (const page of pagesOf(doc.render())) {
          if (page.parts.heading !== null) expect(page.parts.heading).not.toMatch(MARKS);
          if (!page.key.startsWith("n:")) expect(page.key).not.toMatch(/\*\*|~~|`|\[\[|\]\(/);
          for (const block of page.parts.body) expect(slideBlockText(block)).not.toMatch(/\*\*|~~|\[\[|\]\(/);
        }
      }),
      cfg,
    );
  });
});

describe("7 LF or CRLF", { timeout: 120_000 }, () => {
  it("the same pages, word for word", () => {
    fc.assert(
      fc.property(deckDoc({ legacyIds: true }), (doc) => {
        const text = doc.render();
        const crlf = asCrlf(text);
        expect(parseDeck(crlf).slides.map((s) => lf(s.markdown))).toEqual(parseDeck(text).slides.map((s) => s.markdown));
        expect(pagesOf(crlf).map((p) => shownText(p))).toEqual(pagesOf(text).map((p) => shownText(p)));
        expect(pagesOf(crlf).map((p) => [p.key, p.autoLayout, lf(p.notes)])).toEqual(pagesOf(text).map((p) => [p.key, p.autoLayout, p.notes]));
      }),
      cfg,
    );
  });
});

describe("8 PPTX export without a DOM", { timeout: 120_000 }, () => {
  const KINDS: FontKind[] = ["sans", "serif", "kai"];
  const num = fc.double({ min: 0, max: 4000, noNaN: true });
  const hex = fc.stringMatching(/^[0-9a-fA-F]{6}$/);
  const box = fc.record({ x: num, y: num, w: num, h: num });
  const run: fc.Arbitrary<Run> = fc.record({ text: fc.string({ maxLength: 8 }) }, { requiredKeys: ["text"] }).chain((base) =>
    fc.record({ bold: fc.boolean(), italic: fc.boolean(), strike: fc.boolean(), mono: fc.boolean(), color: fc.option(hex, { nil: undefined }), link: fc.option(fc.constant("https://example.com"), { nil: undefined }) }, { requiredKeys: [] }).map((extra) => ({ ...base, ...extra })));
  const item: fc.Arbitrary<MeasuredItem> = fc.oneof(
    fc.record({ kind: fc.constant("text" as const), role: fc.constantFrom("title" as const, "body" as const, "other" as const), box, paragraphs: fc.array(fc.record({ runs: fc.array(run, { maxLength: 3 }), list: fc.option(fc.record({ level: fc.nat(3), numbered: fc.boolean() }), { nil: undefined }), spaceBeforePx: num, spaceAfterPx: num }), { maxLength: 4 }), font: fc.constantFrom(...KINDS), sizePx: num, lineHeightPx: num, color: hex, bold: fc.boolean(), align: fc.constantFrom("left" as const, "center" as const, "right" as const), indentPx: num }),
    fc.record({ kind: fc.constant("code" as const), box, lines: fc.array(fc.array(run, { maxLength: 3 }), { maxLength: 4 }), sizePx: num, lineHeightPx: num, color: hex, fill: fc.option(hex, { nil: null }), line: fc.option(hex, { nil: null }), paddingPx: num }),
    fc.record({ kind: fc.constant("shape" as const), box, fill: fc.option(hex, { nil: null }), fillAlpha: fc.double({ min: 0, max: 1, noNaN: true }), line: fc.option(hex, { nil: null }), lineWidthPx: num, radiusPx: num }),
    fc.record({ kind: fc.constant("picture" as const), why: fc.constantFrom("image" as const, "math" as const, "diagram" as const), box, alt: fc.string({ maxLength: 6 }), data: fc.option(fc.constant("data:image/png;base64,AAAA"), { nil: null }) }),
  );
  const slide: fc.Arbitrary<MeasuredSlide> = fc.record({ background: hex, contentBottom: num, inlineFormulas: fc.nat(3), items: fc.array(item, { maxLength: 6 }) });

  const isFiniteNonNegative = (value: unknown, path = ""): string[] => {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? [] : [`${path}=${value}`];
    if (Array.isArray(value)) return value.flatMap((v, i) => isFiniteNonNegative(v, `${path}[${i}]`));
    if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => (k === "indentLevel" || typeof v === "string" ? [] : isFiniteNonNegative(v, `${path}.${k}`)));
    return [];
  };

  it("buildDeckSpec: frames, sizes and spacing are finite and non-negative; one spec per slide; layout names are unique", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ measured: slide, notes: fc.string({ maxLength: 20 }) }), { maxLength: 6 }),
        fc.constantFrom(...FONT_CHOICES),
        fc.record({ background: hex, text: hex, headingFont: fc.constantFrom(...KINDS), bodyFont: fc.constantFrom(...KINDS), titleSizePx: num, bodySizePx: num, titleBold: fc.boolean() }),
        (slides, font, look) => {
          const spec = buildDeckSpec({ look, slides, font });
          expect(spec.slides).toHaveLength(slides.length);
          expect(isFiniteNonNegative({ master: spec.master, layouts: spec.layouts, slides: spec.slides.map((s) => s.elements.map((e) => ({ ...e, options: undefined, runs: undefined }))) })).toEqual([]);
          const names = spec.layouts.map((l) => l.name);
          expect(new Set(names).size).toBe(names.length);
          for (const s of spec.slides) expect(names).toContain(s.layout);
          for (const [i, s] of slides.entries()) expect(spec.slides[i]!.elements).toHaveLength(s.measured.items.length);
        },
      ),
      cfg,
    );
  });

  it("font names: every set names every face; a replacement list has no empty or self-replacing line and no repeated face", () => {
    fc.assert(
      fc.property(fc.constantFrom(...FONT_CHOICES), fc.array(fc.constantFrom(...KINDS), { maxLength: 6 }), (choice, kinds) => {
        for (const kind of KINDS) expect(fontFile(kind, choice).trim()).not.toBe("");
        const lines = substitutions(kinds, choice);
        if (choice === "keep") expect(lines).toEqual([]);
        for (const { from, to } of lines) { expect(from.trim()).not.toBe(""); expect(to.trim()).not.toBe(""); expect(from).not.toBe(to); }
        expect(new Set(lines.map((l) => l.from)).size).toBe(lines.length);
        expect(lines.length).toBeLessThanOrEqual(new Set(kinds).size);
      }),
      cfg,
    );
  });
});

// ---- Fixed cases of what the properties once found ----

describe("cases found by these properties", () => {
  it("`---` or `## ` inside a $$ block does not cut the page", () => {
    expect(parseDeck("intro\n\n$$\nx\n\n---\n\ny\n$$\n\nend").slides).toHaveLength(1);
    expect(parseDeck("$$\n## x\n$$\n\nz\n\n## b\n\nq").slides).toHaveLength(2); // only the real `## b` cuts
  });

  it("empty frontmatter keeps what follows it", () => {
    expect(parseDeck("---\n---\n\nA\n\n---\n\nB").slides.map((s) => s.markdown)).toEqual(["A", "B"]);
  });

  it("a deck that begins with a `---` line keeps its first page", () => {
    expect(parseDeck("---\n\nA\n\n---\n\nB").slides.map((s) => s.markdown)).toEqual(["A", "B"]);
    // a block of settings is still frontmatter
    expect(parseDeck("---\ntitle: T\n---\n\nA\n\n---\n\nB").slides.map((s) => s.markdown)).toEqual(["A", "B"]);
  });

  it("pages never share a key, even when a heading reads like a suffixed one", () => {
    const keys = pagesOf("# a\n\n---\n\n# a\n\n---\n\n# a~2").map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    const reversed = pagesOf("# a~2\n\n---\n\n# a\n\n---\n\n# a").map((p) => p.key);
    expect(new Set(reversed).size).toBe(reversed.length);
  });

  it("on a page without a heading, adding a speaker-notes paragraph keeps the key", () => {
    const before = pagesOf("- item a\n- item b")[0]!.key;
    const after = pagesOf("- item a\n- item b\n\nnote para")[0]!.key;
    expect(after).toBe(before);
  });

  it("a layout chosen under the old key of such a page still counts", () => {
    const page = pagesOf("note para\n\n- item a\n- item b")[0]!;
    expect(page.key).toBe("p:note para");
    expect(page.legacyKey).toBeUndefined(); // a lone paragraph first: both orders agree
    const odd = pagesOf("- item a\n- item b\n\nnote para")[0]!;
    expect(odd.legacyKey).toBe("p:note para");
    expect(layoutOfPage(odd, { "p:note para": "text" })).toBe("text");
    expect(layoutOfPage(odd, { "p:note para": "text", [odd.key]: "cover" })).toBe("cover");
  });

  it("a normal deck's keys do not change", () => {
    const pages = pagesOf("# One\n\n---\n\n# Two\n\n- a\n- b\n\n---\n\nbig words");
    expect(pages.map((p) => p.key)).toEqual(["h:one", "h:two", "p:big words"]);
    expect(pages.every((p) => p.legacyKey === undefined)).toBe(true);
  });

  it("a leading block that holds a heading, a list or text is the first page, even with a `Key: value` line in it", () => {
    expect(parseDeck("---\n# 標題\n\nAgenda: three things\n\n---\n# P2").slides.map((x) => x.markdown)).toEqual(["# 標題\n\nAgenda: three things", "# P2"]);
    // right under a text line the closing `---` is a setext underline (the rule of every page cut): one page, nothing lost
    expect(parseDeck("---\n# 標題\n\nAgenda: three things\n---\n# P2").slides.map((x) => x.markdown)).toEqual(["# 標題\n\nAgenda: three things\n---\n# P2"]);
    expect(parseDeck("---\n- a\n- b\n---\n\nB").slides.map((x) => x.markdown)).toEqual(["- a\n- b", "B"]);
    expect(parseDeck("---\naliases:\n- x\ntitle: T\n---\n\nA\n\n---\n\nB").slides.map((x) => x.markdown)).toEqual(["A", "B"]); // real settings
  });

  it("a `---` right under the end of a $$ block is a page break", () => {
    expect(parseDeck("# P1\n\n$$\nx\n$$\n---\n# P2").slides.map((x) => x.markdown)).toEqual(["# P1\n\n$$\nx\n$$", "# P2"]);
    expect(parseDeck("```\nx\n```\n---\nB").slides).toHaveLength(2); // as for a code fence
  });

  it("a write starts from layouts moved to the new keys, so another page's entry is neither read nor removed", () => {
    const md = "- item a\n- item b\n\nnote para";
    const page = pagesOf(md)[0]!;
    const stored = { "p:note para": "text" };
    expect(layoutSource(page, stored)).toEqual({ key: "p:note para", value: "text" });
    const data = (layouts: Record<string, string>) => ({ v: 1 as const, theme: "site" as const, layouts });
    expect(withPageLayout(data(layoutsByPageKey([page], stored)), page.key, "bullets").layouts).toEqual({ [page.key]: "bullets" });
    expect(withPageLayout(data(layoutsByPageKey([page], stored)), page.key, null).layouts).toEqual({});
    // two pages whose old and new keys collide: the first page's X survives a write on the second
    const pages = pagesOf("- a\n\nhello\n\n---\n\nhello");
    const both = { "p:hello": "quote", "p:hello~2": "stat" };
    expect(layoutsByPageKey(pages, both)).toEqual({ "p:a": "quote", "p:hello": "stat" });
    expect(withPageLayout(data(layoutsByPageKey(pages, both)), "p:hello", "text").layouts).toEqual({ "p:a": "quote", "p:hello": "text" });
    expect(withPageLayout(data(layoutsByPageKey(pages, both)), "p:hello", null).layouts).toEqual({ "p:a": "quote" });
    // entries no page reads stay
    expect(layoutsByPageKey(pages, { gone: "quote" })).toEqual({ gone: "quote" });
  });

  it("a stored old key is read by the page it was the key of, not by a page whose new key is the same text", () => {
    const pages = pagesOf("- a\n\nhello\n\n---\n\nhello");
    expect(pages.map((p) => [p.key, p.legacyKey])).toEqual([["p:a", "p:hello"], ["p:hello", "p:hello~2"]]);
    const layouts = { "p:hello": "quote", "p:hello~2": "stat" };
    expect(pages.map((p) => layoutOfPage(p, layouts))).toEqual(["quote", "stat"]);
    // choices already under the new keys win and are read as they are
    expect(pages.map((p) => layoutOfPage(p, { "p:a": "text", "p:hello": "stat" }))).toEqual(["text", "stat"]);
  });
});

// ---- Known limits: what parseDeck still cuts wrongly (the generator keeps away from these) ----
// Each `it.fails` turns red the day the cut is fixed; then it becomes a plain `it` and the generator may produce the case.

describe("known limits of the page cut (it.fails) and the quote cases that already hold", () => {
  it.fails("a `---` inside an HTML comment is not a page break", () => {
    expect(parseDeck("intro\n\n<!--\n\n---\n\n-->\n\nend").slides).toHaveLength(1);
  });

  it.fails("an indented `    ---` (code) is not a page break", () => {
    expect(parseDeck("A\n\n    ---\n\nB").slides).toHaveLength(1);
  });

  it("a code block inside a quote does not cut the page at its `---`", () => {
    expect(parseDeck("> ```\n>\n> ---\n>\n> ```\n\nend").slides).toHaveLength(1);
  });

  it.fails("a code block inside a list item does not cut the page at its `---`", () => {
    expect(parseDeck("- ```\n\n  ---\n\n  ```\n\nend").slides).toHaveLength(1);
  });

  it("a `$$` block inside a quote does not cut the page at its `---`", () => {
    expect(parseDeck("> $$\n>\n> ---\n>\n> $$\n\nend").slides).toHaveLength(1);
  });
});
