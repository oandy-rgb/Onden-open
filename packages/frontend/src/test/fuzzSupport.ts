// Shared by the *.fuzz.test.ts files (run by `npm run test:fuzz`, see
// docs/agents/testing.md). One copy per package (markdown, backend, frontend):
// the packages do not import each other's test helpers.
//
// Replay a failure: `FUZZ_SEED=<seed> npm run test:fuzz`. The seed is printed
// at the top of every run and fast-check prints the shrunk counterexample.
// `FUZZ_LONG=1` (npm run test:fuzz:long) multiplies every run count.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";

export const FUZZ_LONG = process.env.FUZZ_LONG === "1";
export const FUZZ_SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) | 0 : Math.floor(Math.random() * 2 ** 31);
const LONG_FACTOR = 20;

// stderr: vitest hides nothing written there, and the seed is the one thing
// needed to replay a failed run.
process.stderr.write(`[fuzz] seed=${FUZZ_SEED} long=${FUZZ_LONG}\n`);

/** fast-check parameters: the run's seed and `runs` cases (×20 when long). */
export function fuzzParams(runs: number): fc.Parameters<unknown> {
  return { seed: FUZZ_SEED, numRuns: FUZZ_LONG ? runs * LONG_FACTOR : runs };
}

/** The named hostile seeds in fuzz-corpus/<file>.json (name → input).
 *  Every one is replayed as a fixed example and is the base the mutators below start from. */
export function loadCorpus(file: string): Record<string, string> {
  // The package directory (npm run sets it): jsdom's import.meta.url is not a file URL.
  const path = resolve(process.cwd(), "src/test/fuzz-corpus", `${file}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

// Fragments that are special somewhere in Onden's parsers. Not payloads: inert markers.
const FRAGMENTS = [
  "<", ">", "</", "<!--", "-->", "<![CDATA[", "]]>", "&#x", "&#", "&amp;", "&lt;", "&colon;", "&Tab;", "&NewLine;", "&", ";",
  "\"", "'", "`", "```", "~~~", "$$", "$", "[", "]", "[[", "]]", "![[", "(", ")", "{", "}", "|", "\\", "\\\\", "#", "##", "^", "^id",
  "*", "**", "_", "__", "-", "---", "+", ">", "> ", "- ", "1. ", "- [ ] ", "[!note]", ":", "::", "key:: v", "\n", "\r\n", "\r", "\t", " ", "\u00a0",
  "\u0000", "\u200b", "\u2028", "\ufeff", "\ud800", "\udc00", "\ud83d", "字", "😀", "é", "\u0301",
  "javascript:", "vbscript:", "data:text/html,", "data:image/png;base64,", "https://", "//", "http://", "mailto:",
  "onerror=", "onload=", "xlink:href=", "href=", "src=", "<svg", "<img ", "<iframe ", "<script", "<style", "<a ", "<!DOCTYPE", "<!ENTITY", "%00", "%3c",
  "../", "..\\", "/", "C:\\", "file:", "---\n", "\n---\n", "title: ", "tags: [",
];
const fragment = fc.constantFrom(...FRAGMENTS);

/** Token soup: random runs of the special fragments and a little plain text. */
export const soup: fc.Arbitrary<string> = fc
  .array(fc.oneof({ weight: 6, arbitrary: fragment }, { weight: 1, arbitrary: fc.string({ maxLength: 6 }) }), { maxLength: 80 })
  .map((parts) => parts.join(""));

/** Any string at all, including lone surrogates and NUL. */
export const anyString: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: "binary", maxLength: 400 }),
  fc.string({ unit: "grapheme", maxLength: 200 }),
  soup,
);

/** A corpus entry with 0–3 mutations: cut, repeat a slice, splice in fragments, swap a slice for soup. */
export function mutated(corpus: Record<string, string>): fc.Arbitrary<string> {
  const seeds = Object.values(corpus);
  const mutation = fc.oneof(
    fc.record({ kind: fc.constant("cut" as const), at: fc.nat(1000), len: fc.nat(60) }),
    fc.record({ kind: fc.constant("repeat" as const), at: fc.nat(1000), len: fc.integer({ min: 1, max: 40 }), times: fc.integer({ min: 2, max: 30 }) }),
    fc.record({ kind: fc.constant("insert" as const), at: fc.nat(1000), text: soup }),
    fc.record({ kind: fc.constant("swap" as const), at: fc.nat(1000), len: fc.nat(20), text: soup }),
  );
  return fc.tuple(fc.constantFrom(...seeds), fc.array(mutation, { maxLength: 3 })).map(([base, edits]) => {
    let s = base;
    for (const m of edits) {
      const at = s.length ? m.at % (s.length + 1) : 0;
      if (m.kind === "cut") s = s.slice(0, at) + s.slice(at + m.len);
      else if (m.kind === "repeat") s = s.slice(0, at) + s.slice(at, at + m.len).repeat(m.times) + s.slice(at);
      else if (m.kind === "insert") s = s.slice(0, at) + m.text + s.slice(at);
      else s = s.slice(0, at) + m.text + s.slice(at + m.len);
    }
    return s;
  });
}

/** Corpus mutations, token soup and raw strings, weighted toward the corpus. */
export function hostileInput(corpus: Record<string, string>): fc.Arbitrary<string> {
  return fc.oneof({ weight: 4, arbitrary: mutated(corpus) }, { weight: 3, arbitrary: soup }, { weight: 2, arbitrary: anyString });
}

/** Run `fn` and fail when it took longer than `baseMs + perKbMs × input KB`. */
export function expectWithinBudget(label: string, input: string, perKbMs: number, fn: () => void, baseMs = 250): void {
  const started = performance.now();
  fn();
  const took = performance.now() - started;
  const budget = baseMs + perKbMs * (input.length / 1024);
  if (took > budget) {
    throw new Error(`${label}: ${took.toFixed(0)} ms for ${input.length} chars, budget ${budget.toFixed(0)} ms`);
  }
}

/** A repeated unit at n and 4n: linear work grows ~4×, a quadratic parser ~16×.
 *  Passes when the full-size run is fast, or the best of a few pairs grows ≤ maxRatio×. */
export function expectLinearGrowth(label: string, unit: string, run: (text: string) => void, { n = 2000, fastMs = 60, maxRatio = 9, pairs = 3 } = {}): void {
  const small = unit.repeat(n);
  const big = unit.repeat(n * 4);
  run(small); // warm-up
  let best = Infinity;
  let fastestBig = Infinity;
  for (let i = 0; i < pairs; i++) {
    const a = performance.now(); run(small); const smallMs = performance.now() - a;
    const b = performance.now(); run(big); const bigMs = performance.now() - b;
    fastestBig = Math.min(fastestBig, bigMs);
    best = Math.min(best, bigMs / Math.max(smallMs, 0.5));
  }
  if (fastestBig > fastMs && best > maxRatio) {
    throw new Error(`${label}: ${JSON.stringify(unit.slice(0, 30))}×${n * 4} took ${fastestBig.toFixed(0)} ms, growth ${best.toFixed(1)}× for 4× input`);
  }
}
