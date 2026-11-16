// The metamorphic runner (helpers/metamorphic.ts) and the corpus the search relations use (helpers/searchMetamorphic.ts):
// the runner must fail on a broken relation, on a skip reason nobody stated, on one reason over its share and on too few
// compared inputs — otherwise a biased generator could hide behind the total — and the generator must keep what its
// header promises (a fragment of ≥ 3 graphemes taken from a note, no query syntax, fewer notes than the result limit,
// every class of the one-grapheme step present).

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { metamorphic, SKIP } from "../helpers/metamorphic.js";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { GRAPHEME_CLASSES, classOf, graphemesOf, isPlainText, prefixCases, QUERY_SYNTAX } from "../helpers/searchMetamorphic.js";

const numbers = fc.integer({ min: 0, max: 99 });

describe("metamorphic runner", () => {
  it("runs setup once per input and hands the relation that same world", async () => {
    const worlds: object[] = [];
    const seen: object[] = [];
    const report = await metamorphic({
      name: "once", source: numbers, minCompared: 1, skipShare: {},
      setup: () => { const world = {}; worlds.push(world); return world; },
      relation: (world) => { seen.push(world); return null; },
    });
    expect(worlds).toHaveLength(report.runs);
    expect(seen).toEqual(worlds);
  });

  it("fails on a broken relation, shrinks it, and names the replay line", async () => {
    const failure = await metamorphic({
      name: "broken", source: numbers, minCompared: 0, skipShare: {},
      setup: (n) => n, relation: (_world, n) => (n >= 7 ? `${n} is too big` : null),
    }).then(() => null, (error: Error) => error);
    expect(failure?.message).toContain("Counterexample: [7]");
    expect(failure?.message).toContain(`replay: PROPS_SEED=${PROPS_SEED} PROPS_RUNS=${PROPS_RUNS}`);
  });

  it("fails on a skip reason the spec does not state", async () => {
    await expect(metamorphic({
      name: "unstated", source: numbers, minCompared: 0, skipShare: { "stated": 1 },
      setup: (n) => n, relation: () => SKIP("another reason"),
    })).rejects.toThrow(/does not state/);
  });

  it("fails when ONE reason accounts for more than its own share, however small the total of skips looks", async () => {
    await expect(metamorphic({
      name: "biased", source: numbers, minCompared: 0, skipShare: { "common": 0.1, "rare": 1 },
      setup: (n) => n, relation: (_world, n) => (n % 2 === 0 ? SKIP("common") : null),
    })).rejects.toThrow(/"common"[\s\S]*more than the 10%/);
  });

  it("fails when too few inputs compared", async () => {
    await expect(metamorphic({
      name: "few", source: numbers, minCompared: 0.9, skipShare: { "skipped": 1 },
      setup: (n) => n, relation: (_world, n) => (n % 2 === 0 ? SKIP("skipped") : null),
    })).rejects.toThrow(/only \d+ of \d+ runs compared/);
  });

  it("counts skips per reason and compares the rest", async () => {
    const report = await metamorphic({
      name: "counted", source: numbers, minCompared: 0.1, skipShare: { "even": 1, "multiple of five": 1 },
      setup: (n) => n, relation: (_world, n) => (n % 2 === 0 ? SKIP("even") : n % 5 === 0 ? SKIP("multiple of five") : null),
    });
    expect(report.compared + Object.values(report.skipped).reduce((a, b) => a + b, 0)).toBe(report.runs);
    expect(Object.keys(report.skipped).sort()).toEqual(["even", "multiple of five"]);
  });
});

describe("the search corpus", () => {
  const cases = fc.sample(prefixCases(), { seed: PROPS_SEED, numRuns: Math.max(PROPS_RUNS, 300) });

  it("takes a fragment of at least 3 graphemes from the title or body of one note, with no query syntax in it", () => {
    for (const input of cases) {
      expect(input.fragment.length).toBeGreaterThanOrEqual(3);
      expect(input.fragment.every((piece) => graphemesOf(piece).length === 1)).toBe(true);
      const fragment = input.fragment.join("");
      expect(isPlainText(input.fragment)).toBe(true);
      expect(QUERY_SYNTAX.test(fragment)).toBe(false);
      expect(input.notes[input.home.note]![input.home.field], JSON.stringify(input)).toContain(fragment);
    }
  });

  it("keeps fewer notes than the result limit (30), so the limit cannot truncate", () => {
    expect(Math.max(...cases.map((input) => input.notes.length))).toBeLessThan(30);
  });

  it("stores titles as the server does (NFC) and never empty", () => {
    for (const input of cases) for (const note of input.notes) {
      expect(note.title).toBe(note.title.normalize("NFC"));
      expect(note.title.length).toBeGreaterThan(0);
    }
  });

  it("has a swap grapheme of another class than the fragment's first one, absent from the corpus", () => {
    for (const input of cases) {
      expect(classOf(input.swap)).not.toBe(classOf(input.fragment[0]!));
      expect(input.notes.some((note) => note.title.includes(input.swap) || note.body.includes(input.swap))).toBe(false);
    }
  });

  it("covers every class of the one-grapheme step, with both 1- and 2-unit lengths", () => {
    const first = new Set(cases.map((input) => classOf(input.fragment[0]!)));
    for (const name of GRAPHEME_CLASSES) expect(first.has(name), `no case starts with a ${name} grapheme`).toBe(true);
    const lengths = new Set(cases.map((input) => input.fragment[0]!.length));
    expect(lengths.has(1)).toBe(true);
    expect(lengths.has(2)).toBe(true);
  });
});
