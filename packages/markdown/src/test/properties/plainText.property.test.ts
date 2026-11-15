// Property tests for the plain reading of inline Markdown. plainInline itself
// is private to paragraphs.ts; its public entry is paragraphSample (a
// paragraph as one line to show). DB-free; seed and run count from
// PROPS_SEED / PROPS_RUNS.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { paragraphSample } from "../../index.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
const BIG = 100_000; // no truncation

// Words without any Markdown mark: Latin, digits, CJK, emoji (surrogate
// pairs), accents, zero-width characters inside the word.
const wordPart = fc.constantFrom("a", "Z", "7", "字", "測", "日本", "한", "😀", "👩‍👩‍👧", "🇹🇼", "é", "́", "​", "‍");
const word = fc.array(wordPart, { minLength: 1, maxLength: 4 }).map((p) => p.join(""))
  .filter((w) => w.trim() === w && w.replace(/[​‍́]/g, "") !== "");

// One inline token and the words it must read as.
const token = word.chain((w) => fc.constantFrom<[string, string]>(
  [w, w], [`**${w}**`, w], [`__${w}__`, w], [`*${w}*`, w], [`_${w}_`, w], [`~~${w}~~`, w], [`==${w}==`, w],
  [`\`${w}\``, w], [`[${w}](https://example.com/a_b)`, w], [`![${w}](img.png)`, w],
  [`[[note|${w}]]`, w], [`![[note|${w}]]`, w], [`[[${w}]]`, w],
));
const line = fc.array(token, { minLength: 1, maxLength: 6 });

describe("paragraphSample reads inline Markdown as words", () => {
  it("every marked token reads as its words, in order, nothing eaten", () => {
    fc.assert(fc.property(line, (tokens) => {
      expect(paragraphSample(tokens.map(([src]) => src).join(" "), BIG)).toBe(tokens.map(([, words]) => words).join(" "));
    }), fcOpts);
  });

  it("the result keeps no Markdown mark", () => {
    fc.assert(fc.property(line, (tokens) => {
      const out = paragraphSample(tokens.map(([src]) => src).join(" "), BIG)!;
      expect(out).not.toMatch(/\*\*|__|~~|==|`|\[\[|\]\]|\]\(|!\[/);
    }), fcOpts);
  });

  it("reading twice is reading once", () => {
    fc.assert(fc.property(line, (tokens) => {
      const once = paragraphSample(tokens.map(([src]) => src).join(" "), BIG)!;
      expect(paragraphSample(once, BIG)).toBe(once);
    }), fcOpts);
  });

  it("a marked line and a heading / list / quote / task / `^id` dressing of it read the same", () => {
    fc.assert(fc.property(line, fc.constantFrom("", "# ", "### ", "- ", "* ", "1. ", "> ", "- [ ] ", "- [x] "), fc.constantFrom("", " ^abc", " ^a-1"), (tokens, lead, tail) => {
      const text = tokens.map(([src]) => src).join(" ");
      expect(paragraphSample(`${lead}${text}${tail}`, BIG)).toBe(paragraphSample(text, BIG));
    }), fcOpts);
  });
});

describe("paragraphSample on arbitrary text", () => {
  // Hostile: every mark, unbalanced, with CJK / emoji / blanks / CRLF.
  const atom = fc.constantFrom(
    "*", "**", "_", "__", "~~", "==", "`", "[", "]", "(", ")", "![", "[[", "]]", "|", "^", "#", "- ", "> ", "$", "\\", "<", ">",
    "a", "B", "1", " ", "  ", "\t", "\n", "\r\n", "字", "測", "😀", "👩‍👩‍👧", "​", "́", "http://x/y_z",
  );
  const chaos = fc.array(atom, { maxLength: 40 }).map((a) => a.join(""));

  it("never throws, and never adds a character: the result is a subsequence of the input (blanks aside: lines are joined by one space)", () => {
    const isSubsequence = (small: string, big: string): boolean => {
      let i = 0;
      for (const ch of big) if (i < small.length && small.startsWith(ch, i)) i += ch.length;
      return i === small.length;
    };
    fc.assert(fc.property(chaos, (text) => {
      const out = paragraphSample(text, BIG);
      if (out === null) return;
      expect(isSubsequence(out.replace(/\s/g, ""), text.replace(/\s/g, ""))).toBe(true);
    }), fcOpts);
  });

  it("the cut result is at most `max` characters and a prefix of the full one", () => {
    fc.assert(fc.property(chaos, fc.integer({ min: 1, max: 30 }), (text, max) => {
      const full = paragraphSample(text, BIG);
      const cut = paragraphSample(text, max);
      expect(cut === null).toBe(full === null);
      if (full === null || cut === null) return;
      expect([...cut].length).toBeLessThanOrEqual(max);
      const head = cut.endsWith("…") && cut !== full ? cut.slice(0, -1) : cut;
      expect(full.startsWith(head)).toBe(true);
    }), fcOpts);
  });
});

// An indented marker is stripped like the same marker at the line start (LINE_MARKER
// tolerates leading blanks), so reading a sample a second time never strips more.
describe("indented block marks", () => {
  it("a marker after indentation reads like the same marker at the line start", () => {
    fc.assert(fc.property(line, fc.constantFrom("- ", "* ", "1. ", "# ", "> ", "- [ ] "), fc.constantFrom(" ", "  ", "    "), (tokens, mark, indent) => {
      const text = tokens.map(([src]) => src).join(" ");
      expect(paragraphSample(`${indent}${mark}${text}`, BIG)).toBe(paragraphSample(`${mark}${text}`, BIG));
    }), fcOpts);
  });

  it("reading a sample again returns it unchanged", () => {
    fc.assert(fc.property(fc.constantFrom(" *", " -", " >", " #", " - a", " # a"), (text) => {
      const once = paragraphSample(text, BIG);
      if (once !== null) expect(paragraphSample(once, BIG)).toBe(once);
    }), fcOpts);
  });
});
