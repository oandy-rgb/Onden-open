// Property tests for text patches (textPatch.ts): applying the patch made
// between two texts gives the second one back. DB-free; seed and run count
// from PROPS_SEED / PROPS_RUNS.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { applyPatch, makePatch } from "../../index.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
const piece = fc.constantFrom("a", "b", "\n", " ", "中", "文", "😀", "😁", "é", "## ", "x".repeat(300), "line\n".repeat(120));
const text = fc.array(piece, { maxLength: 40 }).map((parts) => parts.join(""));
// A second text that shares most of its content with the first.
const edited = (base: string) => fc.array(fc.record({ at: fc.nat(), del: fc.nat(30), ins: text }), { maxLength: 4 }).map((edits) => {
  let value = base;
  for (const { at, del, ins } of edits) {
    const position = value.length === 0 ? 0 : at % (value.length + 1);
    value = value.slice(0, position) + ins.slice(0, 60) + value.slice(position + del);
  }
  return value;
});

describe("makePatch / applyPatch", () => {
  it("applyPatch(base, makePatch(base, next)) === next", () => {
    fc.assert(fc.property(text, text, (base, next) => {
      expect(applyPatch(base, makePatch(base, next))).toBe(next);
    }), fcOpts);
  });

  it("holds for edits of the base, and the hunks never carry the unchanged ends", () => {
    fc.assert(fc.property(text.chain((base) => fc.tuple(fc.constant(base), edited(base))), ([base, next]) => {
      const patch = makePatch(base, next);
      expect(applyPatch(base, patch)).toBe(next);
      const carried = patch.hunks.reduce((sum, h) => sum + h.ins.length, 0);
      expect(carried).toBeLessThanOrEqual(next.length);
    }), fcOpts);
  });

  // A drawing's JSON is one line: objects (strokes, records) side by side with no line to anchor a split on.
  const jsonObjects = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `{"id":"s${from + i}","points":[[${i},1.5,0.5],[${i + 1},2.5,0.5]],"size":2}`);
  const drawing = (sections: string[][]) => `{"pages":{${sections.map((s, i) => `"${i}":[${s.join(",")}]`).join(",")}},"tail":{"x":1}}`;

  it("holds for one-line JSON where objects were added in several places, and sends only the added objects", () => {
    fc.assert(fc.property(
      fc.integer({ min: 60, max: 120 }), fc.array(fc.nat(7), { minLength: 1, maxLength: 4 }),
      (perSection, places) => {
        const base = Array.from({ length: 8 }, (_, i) => jsonObjects(perSection, i * 1000));
        const next = base.map((section, i) => (places.includes(i) ? [...section, ...jsonObjects(1, 90_000 + i)] : section));
        const [a, b] = [drawing(base), drawing(next)];
        const patch = makePatch(a, b);
        expect(applyPatch(a, patch)).toBe(b);
        const carried = patch.hunks.reduce((sum, h) => sum + h.ins.length, 0);
        // What is sent stays close to the added objects, not the text between the places.
        expect(carried).toBeLessThan(places.length * 400 + 200);
      },
    ), { ...fcOpts, numRuns: Math.min(PROPS_RUNS, 60) });
  });
});
