// Property tests: every cut of a user's text lands between grapheme clusters
// and leaves no lone surrogate (no "�"). Generators: helpers/unicodeText.ts.
// Seed and run count from PROPS_SEED / PROPS_RUNS.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { unicodeText, titleText, graphemesOf, hasLoneSurrogate } from "../helpers/unicodeText.js";
import { clampNoteTitle, cutToBytes, cutToGraphemes, cutToUnits, ellipsize, noteSummary, plainExcerpt, snippetAround, snippetPlainText, paragraphSample, graphemeCount } from "../../index.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

/** `part` is a prefix of `whole` that ends between grapheme clusters. */
function isGraphemePrefix(part: string, whole: string): boolean {
  if (!whole.startsWith(part)) return false;
  const cut = graphemesOf(whole).reduce<number[]>((ends, g) => [...ends, (ends.at(-1) ?? 0) + g.length], [0]);
  return cut.includes(part.length);
}

describe("clampNoteTitle", () => {
  it("is a grapheme-aligned prefix, within the cap, never a lone surrogate", () => {
    fc.assert(fc.property(unicodeText({ maxLength: 60 }), fc.integer({ min: 1, max: 40 }), (text, max) => {
      const out = clampNoteTitle(text, max);
      expect(hasLoneSurrogate(out)).toBe(false);
      expect(out.length).toBeLessThanOrEqual(Math.max(max, text.length <= max ? text.length : 0));
      expect(isGraphemePrefix(out, text) || out === text.slice(0, out.length).trimEnd()).toBe(true);
      expect(isGraphemePrefix(out.trimEnd(), text) || out === "").toBe(true);
    }), fcOpts);
  });
});

describe("noteSummary", () => {
  it("never cuts inside a grapheme cluster", () => {
    fc.assert(fc.property(unicodeText({ maxLength: 80 }), fc.integer({ min: 1, max: 30 }), (text, maxLen) => {
      const out = noteSummary(text, { maxLen });
      expect(hasLoneSurrogate(out)).toBe(false);
      if (!out.endsWith("…")) return;
      const head = out.slice(0, -1);
      const plain = noteSummary(text, { maxLen: 1_000_000 });
      expect(isGraphemePrefix(head, plain)).toBe(true);
    }), fcOpts);
  });
});

describe("plainExcerpt", () => {
  it("never cuts inside a grapheme cluster", () => {
    fc.assert(fc.property(unicodeText({ maxLength: 80 }), fc.integer({ min: 1, max: 30 }), (text, max) => {
      const out = plainExcerpt(text, max);
      expect(hasLoneSurrogate(out)).toBe(false);
      if (!out.endsWith("…")) return;
      expect(isGraphemePrefix(out.slice(0, -1).trimEnd(), text)).toBe(true);
    }), fcOpts);
  });
});

describe("paragraphSample", () => {
  it("never cuts inside a grapheme cluster and stays within max code points", () => {
    fc.assert(fc.property(unicodeText({ maxLength: 60 }), fc.integer({ min: 1, max: 30 }), (text, max) => {
      const out = paragraphSample(`x ${text}`, max);
      if (out === null) return;
      expect(hasLoneSurrogate(out)).toBe(false);
      expect([...out].length).toBeLessThanOrEqual(max);
      if (!out.endsWith("…")) return;
      const full = paragraphSample(`x ${text}`, 1_000_000)!;
      expect(isGraphemePrefix(out.slice(0, -1), full)).toBe(true);
    }), fcOpts);
  });
});

describe("snippetAround", () => {
  it("the window edges fall between grapheme clusters and the ranges cover the term", () => {
    fc.assert(fc.property(unicodeText({ maxLength: 150 }), titleText, unicodeText({ maxLength: 150 }), fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 30 }), (a, term, b, before, after) => {
      const sn = snippetAround(`${a}${term}${b}`, [term], { before, after });
      if (!sn) return;
      expect(hasLoneSurrogate(sn.text)).toBe(false);
      const body = sn.text.replace(/^…/, "").replace(/…$/, "");
      const plain = snippetPlainText(`${a}${term}${b}`);
      const bounds = new Set(graphemesOf(plain).reduce<number[]>((ends, g) => [...ends, ends[ends.length - 1]! + g.length], [0]));
      let aligned = false;
      for (let at = plain.indexOf(body); at !== -1; at = plain.indexOf(body, at + 1)) {
        if (bounds.has(at) && bounds.has(at + body.length)) aligned = true;
      }
      expect(aligned, `window ${JSON.stringify(body)} of ${JSON.stringify(plain)}`).toBe(true);
      for (const [s, e] of sn.ranges) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(e).toBeLessThanOrEqual(sn.text.length);
        expect(hasLoneSurrogate(sn.text.slice(s, e))).toBe(false);
      }
    }), fcOpts);
  });
});

describe("snippetAround (nightly findings)", () => {
  // Nightly 2026-10-28, PROPS_SEED=1028726334 PROPS_RUNS=2000: a term that starts with a combining
  // mark begins inside the cluster before it (family emoji + U+0301), and the window edge is put
  // there, splitting the cluster. Likely cause: the window is cut at the match start without
  // widening to the previous grapheme boundary.
  it("FINDING nightly: the window does not start inside a cluster when the term starts with a combining mark", () => {
    const family = "\u{1F469}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}";
    const term = "\u0301\u7684";
    const sn = snippetAround(`${family}${term}`, [term], { before: 1, after: 1 });
    const body = sn!.text.replace(/^…/, "").replace(/…$/, "");
    const plain = snippetPlainText(`${family}${term}`);
    const bounds = new Set(graphemesOf(plain).reduce<number[]>((ends, g) => [...ends, ends[ends.length - 1]! + g.length], [0]));
    const at = plain.indexOf(body);
    expect(bounds.has(at) && bounds.has(at + body.length)).toBe(true);
  });
});

describe("graphemes.ts: the safe cuts", () => {
  it("cutToUnits: longest grapheme-aligned prefix within the cap", () => {
    fc.assert(fc.property(unicodeText({ maxLength: 60 }), fc.integer({ min: 0, max: 50 }), (text, max) => {
      const out = cutToUnits(text, max);
      expect(out.length).toBeLessThanOrEqual(Math.max(max, text.length <= max ? text.length : 0));
      expect(isGraphemePrefix(out, text)).toBe(true);
      expect(hasLoneSurrogate(out)).toBe(false);
      // longest: the next cluster would not fit
      const next = graphemesOf(text).slice(graphemesOf(out).length)[0];
      if (next !== undefined) expect(out.length + next.length).toBeGreaterThan(max);
    }), fcOpts);
  });

  it("cutToGraphemes: exactly the first n clusters", () => {
    fc.assert(fc.property(unicodeText({ maxLength: 60 }), fc.integer({ min: 0, max: 30 }), (text, n) => {
      const out = cutToGraphemes(text, n);
      expect(graphemesOf(out)).toEqual(graphemesOf(text).slice(0, n));
      expect(graphemeCount(out)).toBe(Math.min(n, graphemeCount(text)));
    }), fcOpts);
  });

  it("cutToBytes: within the UTF-8 cap, grapheme-aligned, longest", () => {
    fc.assert(fc.property(unicodeText({ maxLength: 60 }), fc.integer({ min: 0, max: 120 }), (text, max) => {
      const out = cutToBytes(text, max);
      const bytes = (t: string) => new TextEncoder().encode(t).length;
      expect(bytes(out)).toBeLessThanOrEqual(Math.max(max, bytes(text) <= max ? bytes(text) : 0));
      expect(isGraphemePrefix(out, text)).toBe(true);
      const next = graphemesOf(text).slice(graphemesOf(out).length)[0];
      if (next !== undefined) expect(bytes(out) + bytes(next)).toBeGreaterThan(max);
    }), fcOpts);
  });

  it("ellipsize: within the cap with the mark counted, a grapheme prefix of the text, text unchanged when it fits", () => {
    fc.assert(fc.property(unicodeText({ maxLength: 60 }), fc.integer({ min: 1, max: 40 }), (text, max) => {
      const out = ellipsize(text, max);
      if (text.length <= max) { expect(out).toBe(text); return; }
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.endsWith("…")).toBe(true);
      expect(isGraphemePrefix(out.slice(0, -1), text)).toBe(true);
    }), fcOpts);
  });
});

// Counterexamples the properties found (PROPS_SEED=20261023), kept as fixed cases.
describe("regressions found by the properties", () => {
  it("a title cut keeps a letter with its combining accent and a family emoji whole", () => {
    expect(clampNoteTitle("的\u0301", 1)).toBe("");
    expect(clampNoteTitle("字👩‍👩‍👧‍👦", 5)).toBe("字");
    expect(clampNoteTitle("字👩‍👩‍👧‍👦", 12)).toBe("字👩‍👩‍👧‍👦");
    expect(clampNoteTitle("x".repeat(600)).length).toBe(500);
  });
  it("a summary of a ZWJ family and a flag is never cut inside them", () => {
    expect(noteSummary("👩‍👩‍👧‍👦", { maxLen: 2 })).toBe("…");
    expect(noteSummary("🇹🇼🇹🇼🇹🇼", { maxLen: 9 })).toBe("🇹🇼🇹🇼…");
    expect(noteSummary("🇹🇼🇹🇼🇹🇼", { maxLen: 7 })).toBe("🇹🇼…");
  });
  it("an excerpt counts a cluster as one character", () => {
    expect(plainExcerpt("𠀀的的é", 4)).toBe("𠀀的的é");
    expect(plainExcerpt("👩‍👩‍👧‍👦abc", 2)).toBe("👩‍👩‍👧‍👦a…");
  });
  it("a snippet window does not start or end inside a family emoji", () => {
    const sn = snippetAround("的「👩‍👩‍👧‍👦", ["的「👩"], { before: 1, after: 1 })!;
    expect(sn.text).not.toMatch(/👩$|^👩(?!‍)/);
    expect(hasLoneSurrogate(sn.text)).toBe(false);
  });
});
