// Fuzz: the text parsers that run over every note body: block nodes (blocks.ts),
// frontmatter, attribute values, wikilinks, mentions, citations, snippets and
// the ink codec. Invariants: never throw, finish within a budget per KB, offsets
// stay inside the text, and where the repo has a serializer, write(read(x)) is a
// fixed point. Replay: FUZZ_SEED=<seed> npm run test:fuzz.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  parseBlocks, parseLegacyBlocks, legacyBlockAnchors, anchoredBlocks, mayHaveBlocks, addBlockTag, blockTagSlot, blocksParsable, BLOCK_PARSE_MAX,
} from "../blocks.js";
import { stripLegacyIds, hasLegacyIds, writeLegacyIds } from "../legacyBlockIds.js";
import { readFrontmatter, writeFrontmatter, stripFrontmatter, parseFrontmatter, frontmatterLength, fieldList, fieldValue } from "../frontmatter.js";
import {
  attributeValues, encodeValues, isListValue, normalize, inferFromValue, inferFieldType, freeFormType, toCalendarDate, calendarDayOf, isCalendarDate,
  compareAttribute, serializeValue, parseValue, storedNumber,
} from "../attributeValue.js";
import { scanWikilinks, replaceWikilinks, splitWikilink, wikilinkNames } from "../text.js";
import { drawnWikilinks } from "../wikilinkSpans.js";
import { findMentions } from "../mentions.js";
import { snippetAround, snippetPlainText, queryTerms } from "../snippet.js";
import { noteSummary } from "../summary.js";
import { decodeInk, encodeInk, mergeInk, type InkDocument } from "../ink.js";
import { inkToSvg } from "../inkSvg.js";
import { anyString, expectLinearGrowth, expectWithinBudget, fuzzParams, hostileInput, loadCorpus, soup } from "./fuzzSupport.js";
import { svgHazards } from "./htmlHazards.js";

const corpus = loadCorpus("markdown");
const text = hostileInput(corpus);
const PER_KB_MS = 300;

const inBudget = (label: string, input: string, fn: () => void) => expectWithinBudget(label, input, PER_KB_MS, fn, 150);

describe("block nodes", () => {
  it("parse, anchors and tag edits never throw and keep offsets inside the text", () => {
    fc.assert(fc.property(text, fc.nat(2000), (md, at) => {
      inBudget("blocks", md, () => {
        const offset = md.length ? at % (md.length + 1) : 0;
        const anchors = [{ id: "f1", from: offset, to: Math.min(md.length, offset + 5) }, { id: "f2", from: 0, to: md.length }];
        for (const blocks of [parseBlocks(md), parseBlocks(md, anchors), parseLegacyBlocks(md)]) {
          for (const b of blocks) {
            expect(b.start).toBeGreaterThanOrEqual(0);
            expect(b.end).toBeLessThanOrEqual(md.length);
            expect(b.start).toBeLessThanOrEqual(b.end);
            for (const span of [b.marks.tags, b.marks.ref]) if (span) expect(span.from >= 0 && span.from <= span.to && span.to <= md.length).toBe(true);
            if (b.parent !== null) expect(b.parent).toBeLessThan(blocks.length);
          }
        }
        for (const b of parseBlocks(md)) expect(b.ref).toBeNull(); // the text's own `^id`s are not read
        for (const a of anchoredBlocks(md, anchors)) expect(a.start >= 0 && a.start <= a.end && a.end <= md.length).toBe(true);
        for (const a of legacyBlockAnchors(md)) expect(a.mark.to).toBeLessThanOrEqual(md.length);
        mayHaveBlocks(md);
        const slot = blockTagSlot(md, offset);
        if (slot) expect(slot.insertAt).toBeLessThanOrEqual(md.length);
        const edited = addBlockTag(md, offset, "fuzz");
        expect(edited === null || typeof edited === "string").toBe(true);
      });
    }), fuzzParams(150));
  });

  it("stripLegacyIds never throws; what it accepts carries no id any more and strips to itself", () => {
    fc.assert(fc.property(text, (md) => {
      fc.pre(md.length <= BLOCK_PARSE_MAX);
      const out = stripLegacyIds(md);
      if ("refused" in out) return;
      expect(hasLegacyIds(out.markdown)).toBe(false);
      expect(stripLegacyIds(out.markdown)).toEqual({ markdown: out.markdown, anchors: [] });
      for (const a of out.anchors) expect(a.from >= 0 && a.from <= a.to && a.to <= out.markdown.length).toBe(true);
      const written = writeLegacyIds(out.markdown, out.anchors.filter((x) => !x.repeat));
      expect(typeof written.markdown).toBe("string");
    }), fuzzParams(100));
  });

  it("corpus seeds: blocks parse", () => {
    for (const [name, md] of Object.entries(corpus)) {
      if (!blocksParsable(md)) continue;
      inBudget(name, md, () => { parseBlocks(md); parseLegacyBlocks(md); legacyBlockAnchors(md); });
    }
  });

  it("repeated shapes grow linearly", () => {
    // Bodies up to BLOCK_PARSE_MAX (32 000 chars) are parsed.
    for (const unit of ["- a ^id\n", "{a} ", "> ^i\n", "## h ^id\n", "a {b, c: d} ^e\n\n", "a {b}\n\n", "- [ ] x {t}\n  ", "^a ", "}"]) {
      expectLinearGrowth(`blocks ${JSON.stringify(unit)}`, unit, (t) => { const body = t.slice(0, BLOCK_PARSE_MAX); parseBlocks(body); parseLegacyBlocks(body); legacyBlockAnchors(body); }, { n: 1500, fastMs: 40 });
    }
  });
});

describe("frontmatter and attribute values", () => {
  it("frontmatter readers never throw", () => {
    fc.assert(fc.property(text, (md) => {
      inBudget("frontmatter", md, () => {
        const fm = readFrontmatter(md);
        parseFrontmatter(md);
        expect(stripFrontmatter(md).length).toBeLessThanOrEqual(md.length);
        expect(frontmatterLength(md)).toBeLessThanOrEqual(md.length);
        if (fm) { fieldList(fm.entries, "tags"); fieldValue(fm.entries, "title"); }
      });
    }), fuzzParams(300));
  });

  it("write(read(x)) is a fixed point: reading what was written and writing it again changes nothing", () => {
    // Frontmatter-shaped input, so the block is found far more often than in free text.
    const block = fc.tuple(soup, soup, fc.constantFrom("\n", "\r\n")).map(([a, b, nl]) => `---${nl}${a}${nl}${b}${nl}---${nl}body`);
    fc.assert(fc.property(fc.oneof(block, text), (md) => {
      const fm = readFrontmatter(md);
      fc.pre(fm !== null);
      // A CR that is not part of a CRLF is not kept (a line's CR before LF is read as a line end): cosmetic, left out.
      fc.pre(!/\r(?!\n)/.test(md));
      // An empty block ("---\n---") has no entries and is not written back: not a fixed point by design.
      fc.pre(fm!.entries.length > 0);
      const once = writeFrontmatter(fm!.entries) + fm!.body;
      const reread = readFrontmatter(once);
      expect(reread).not.toBeNull();
      // The first write may normalise line ends (a CR before CRLF); the second must not change anything.
      expect(writeFrontmatter(reread!.entries) + reread!.body).toBe(once);
      expect(reread!.entries.map((e) => e.key)).toEqual(fm!.entries.map((e) => e.key));
    }), fuzzParams(300));
  });

  it("attributeValues(encodeValues(xs)) is xs, for any strings", () => {
    fc.assert(fc.property(fc.array(anyString, { maxLength: 6 }), (xs) => {
      expect(attributeValues(encodeValues(xs))).toEqual(xs);
    }), fuzzParams(400));
  });

  it("value helpers never throw on any string", () => {
    fc.assert(fc.property(anyString, anyString, (a, b) => {
      isListValue(a); attributeValues(a); inferFieldType(a); freeFormType(a); inferFromValue(a); isCalendarDate(a); toCalendarDate(a); calendarDayOf(a);
      storedNumber(a); serializeValue(a);
      for (const type of ["text", "number", "date", "bool", "node_ref", b]) {
        parseValue(a, type); normalize(a, type);
      }
      for (const op of ["==", "!=", ">", ">=", "<", "<="] as const) compareAttribute(a, op, b, "text");
    }), fuzzParams(400));
  });
});

describe("links, mentions, citations, snippets", () => {
  it("wikilink, mention and snippet scanners never throw and stay in budget", () => {
    fc.assert(fc.property(text, anyString, (md, query) => {
      inBudget("scanners", md, () => {
        for (const m of scanWikilinks(md)) { splitWikilink(m.body); wikilinkNames(m.body); }
        replaceWikilinks(md, () => "x");
        drawnWikilinks(md);
        findMentions(md);
        snippetPlainText(md);
        snippetAround(md, queryTerms(query));
        noteSummary(md, { title: query.slice(0, 20), maxLen: 120 });
      });
    }), fuzzParams(120));
  });

  it("repeated shapes grow linearly", () => {
    for (const unit of ["[[a]] ", "@", "@a.", "[@a", "[-@a; ", "#a/", "![[", "]] ", "[[a|", "[[a#^", "&amp;"]) {
      expectLinearGrowth(`scanners ${JSON.stringify(unit)}`, unit, (t) => {
        scanWikilinks(t); findMentions(t); snippetPlainText(t); snippetAround(t, ["a"]); noteSummary(t, { title: "t", maxLen: 120 });
      }, { n: 3000, fastMs: 40 });
    }
    // drawnWikilinks on a run of "[[a" is quadratic: a finding, see markdownPipeline.fuzz.test.ts.
  });
});

describe("ink codec and ink SVG", () => {
  const hostileString = fc.oneof(soup, fc.string({ unit: "binary", maxLength: 40 }), fc.constantFrom("red", "#fff", "rgb(1,2,3)", '" onload="x', "url(https://tracker.invalid/a)", "javascript:x", "</svg><script>x</script>"));
  const num = fc.oneof(fc.double({ noNaN: false }), fc.integer(), fc.constantFrom(NaN, Infinity, -Infinity, 1e308, -1e308, 5e-324, 0, -0));
  const point = fc.oneof(fc.tuple(num, num), fc.tuple(num, num, num), fc.constant(null), fc.constantFrom("x", [], [1]));
  const stroke = fc.record({ id: hostileString, points: fc.array(point, { maxLength: 12 }), color: hostileString, size: num, toolId: hostileString });
  const shape = fc.record({ id: hostileString, kind: fc.oneof(fc.constantFrom("rectangle", "circle", "arrow"), hostileString), start: fc.oneof(fc.tuple(num, num), fc.constant(null)), end: fc.oneof(fc.tuple(num, num), fc.constant(null)), color: hostileString, size: num });
  const doc = fc.record({
    version: fc.constant(1 as const), strokes: fc.array(stroke, { maxLength: 6 }), erased: fc.constant({}), page: fc.record({ width: num }),
    shapes: fc.array(shape, { maxLength: 4 }),
  });

  it("decodeInk, mergeInk never throw on any string; inkToSvg output is inert", () => {
    fc.assert(fc.property(anyString, anyString, anyString, (a, b, c) => {
      decodeInk(a);
      mergeInk(a, b, c);
      const svg = inkToSvg(a);
      if (svg) expect(svgHazards(svg)).toEqual([]);
    }), fuzzParams(300));
  });

  it("a hostile drawing renders to an inert SVG (colors, ids and numbers cannot add markup)", () => {
    fc.assert(fc.property(doc, (d) => {
      fc.pre(!d.strokes.some((st) => st.id in Object.prototype)); // the finding below
      // Through the stored form, as every reader gets a drawing (decodeInk keeps
      // only well-formed strokes; a typed caller's in-memory document is its own contract).
      const svg = inkToSvg(encodeInk(d as unknown as InkDocument));
      if (svg === null) return;
      expect(svgHazards(svg)).toEqual([]);
      expect(svg.startsWith("<svg ")).toBe(true);
    }), fuzzParams(300));
  });

  it.fails("FINDING a stroke whose id is an Object.prototype name (`__proto__`, `constructor`) makes inkToSvg throw", () => {
    // ink_data `{"version":1,"strokes":[{"id":"__proto__","points":[[0,0],[5,5]],"color":"red","size":4,"toolId":"pen"}],"erased":{},"page":{"width":1000}}`
    // is valid JSON that decodeInk accepts; the eraser lookup `erased[id]` then finds Object.prototype and
    // `TypeError: intervals is not iterable` escapes. Rendering the drawing (published page, export) fails
    // instead of drawing the stroke. Stroke ids are written by the app, but ink_data also arrives from imports and sync.
    for (const id of ["__proto__", "constructor", "toString"]) {
      const ink = JSON.stringify({ version: 1, strokes: [{ id, points: [[0, 0], [5, 5], [9, 2]], color: "red", size: 4, toolId: "pen" }], erased: {}, page: { width: 1000 } });
      expect(() => inkToSvg(ink), id).not.toThrow();
    }
  });

  it("encodeInk(decodeInk(x)) is a fixed point", () => {
    fc.assert(fc.property(doc, (d) => {
      const first = decodeInk(encodeInk(d as unknown as InkDocument));
      if (first.kind === "none") return;
      const again = decodeInk(encodeInk(first.doc));
      expect(again).toEqual(first);
    }), fuzzParams(300));
  });
});
