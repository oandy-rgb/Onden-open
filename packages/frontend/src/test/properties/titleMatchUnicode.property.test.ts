// Property: the one title matcher (lib/noteSearch matchTitle: [[ completion, the
// / menu, ⌘K, the sidebar) finds a title by any whole-character piece of it,
// ignoring case, full-width vs half-width forms and NFC vs NFD, and highlights
// without cutting a character in two. Generators: markdown/src/test/helpers/
// unicodeText.ts. Seed and run count from PROPS_SEED / PROPS_RUNS.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { matchTitle, rankByTitle } from "../../lib/noteSearch";
import { PROPS_RUNS, PROPS_SEED } from "../../../../markdown/src/test/helpers/propsConfig";
import { titleText, graphemesOf, hasLoneSurrogate, pieceOf, toFullwidth } from "../../../../markdown/src/test/helpers/unicodeText";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

/** …and back. */
const toHalfwidth = (text: string) => text.normalize("NFKC");

const base = fc.record({ title: titleText, from: fc.nat(30), length: fc.integer({ min: 1, max: 6 }) });

describe("matchTitle with Chinese and Unicode titles", () => {
  it("any whole-character piece of a title matches it, contiguously", () => {
    fc.assert(fc.property(base, ({ title, from, length }) => {
      const piece = pieceOf(title, from, length);
      fc.pre(piece !== "");
      const match = matchTitle(piece, title);
      expect(match, `${JSON.stringify(piece)} in ${JSON.stringify(title)}`).not.toBeNull();
      expect(match!.contiguous).toBe(true);
    }), fcOpts);
  });

  it("is blind to case, full-width forms and NFC / NFD", () => {
    fc.assert(fc.property(base, fc.constantFrom("upper", "lower", "fullwidth", "halfwidth", "nfd", "nfc"), ({ title, from, length }, how) => {
      const piece = pieceOf(title, from, length);
      fc.pre(piece !== "");
      const typed = { upper: piece.toUpperCase(), lower: piece.toLowerCase(), fullwidth: toFullwidth(piece), halfwidth: toHalfwidth(piece), nfd: piece.normalize("NFD"), nfc: piece.normalize("NFC") }[how];
      expect(matchTitle(typed, title), `${how}: ${JSON.stringify(typed)} in ${JSON.stringify(title)}`).not.toBeNull();
    }), fcOpts);
  });

  it("the title may be typed in any form too", () => {
    fc.assert(fc.property(base, fc.constantFrom("fullwidth", "nfd", "upper"), ({ title, from, length }, how) => {
      const piece = pieceOf(title, from, length);
      fc.pre(piece !== "");
      const shown = { fullwidth: toFullwidth(title), nfd: title.normalize("NFD"), upper: title.toUpperCase() }[how];
      expect(matchTitle(piece, shown), `${how}: ${JSON.stringify(piece)} in ${JSON.stringify(shown)}`).not.toBeNull();
    }), fcOpts);
  });

  it("highlight ranges are inside the title, in order, and never cut a character (no lone surrogate)", () => {
    fc.assert(fc.property(base, ({ title, from, length }) => {
      const piece = pieceOf(title, from, length);
      fc.pre(piece !== "");
      const match = matchTitle(piece, title)!;
      let last = 0;
      for (const [s, e] of match.ranges) {
        expect(s).toBeGreaterThanOrEqual(last);
        expect(e).toBeGreaterThan(s);
        expect(e).toBeLessThanOrEqual(title.length);
        expect(hasLoneSurrogate(title.slice(s, e)), `${JSON.stringify(title)} [${s},${e})`).toBe(false);
        last = e;
      }
    }), fcOpts);
  });

  it("a match never starts or ends inside a grapheme cluster", () => {
    fc.assert(fc.property(base, ({ title, from, length }) => {
      const piece = pieceOf(title, from, length);
      fc.pre(piece !== "");
      const bounds = new Set(graphemesOf(title).reduce<number[]>((ends, g) => [...ends, ends[ends.length - 1]! + g.length], [0]));
      for (const [s, e] of matchTitle(piece, title)!.ranges) {
        expect(bounds.has(s) && bounds.has(e), `${JSON.stringify(title)} [${s},${e})`).toBe(true);
      }
    }), fcOpts);
  });

  it("rankByTitle lists contiguous matches before scattered ones", () => {
    fc.assert(fc.property(fc.array(titleText, { minLength: 2, maxLength: 12 }), fc.nat(10), (titles, from) => {
      const piece = pieceOf(titles[0]!, from, 2);
      fc.pre(piece !== "");
      const ranked = rankByTitle(piece, titles.map((title) => ({ title })), (n) => n.title);
      const flags = ranked.map((r) => r.match.contiguous);
      expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    }), fcOpts);
  });

  it.each([
    ["Ａ", "A 計畫"], ["a", "Ａ 計畫"], ["１", "第1章"], ["1", "第１章"], ["（暫存", "_Inbox（暫存"], ["café", "Café 日記"],
  ])("%s finds %s", (typed, title) => {
    expect(matchTitle(typed, title)).not.toBeNull();
  });
});

describe("regressions", () => {
  // Found at PROPS_SEED=20261023: the source index was kept per code point while the folded text is per UTF-16 unit,
  // so a title with a character outside the BMP got the end of its range undefined.
  it("a title with 𠀀 (two UTF-16 units) is highlighted whole", () => {
    expect(matchTitle("𠀀", "𠀀")!.ranges).toEqual([[0, 2]]);
    expect(matchTitle("野", "𠮷野家")!.ranges).toEqual([[2, 3]]);
    expect(matchTitle("é", "e\u0301")!.ranges).toEqual([[0, 2]]);
    expect(matchTitle("👩", "👩\u200d👩\u200d👧")!.ranges).toEqual([[0, 8]]);
  });
});
