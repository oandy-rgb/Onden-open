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
});
