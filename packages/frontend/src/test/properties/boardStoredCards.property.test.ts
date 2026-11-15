// Which cards on a board can be taken off it (lib/boardLayout splitStoredCards).
//
// A board that follows its sub-notes draws cards from the tree that are not stored; taking one "off" saves
// nothing, so the board names them and says how they go away (scan 08 #6) instead of staying silent.
//   1 every asked id is exactly one of stored / from the tree, in the order asked
//   2 a stored card is never reported as from the tree, so it can always be removed
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/boardStoredCards.property.test.ts

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { splitStoredCards } from "../../lib/boardLayout";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const id = fc.integer({ min: 0, max: 15 }).map((n) => `n${n}`);

describe("splitStoredCards", () => {
  it("partitions the asked ids into stored and tree-drawn", () => {
    fc.assert(fc.property(fc.uniqueArray(id), fc.uniqueArray(id), (storedIds, asked) => {
      const split = splitStoredCards(storedIds.map((nodeId) => ({ nodeId })), asked);
      expect([...split.stored, ...split.fromTree].sort()).toEqual([...asked].sort());
      for (const nodeId of split.stored) expect(storedIds).toContain(nodeId);
      for (const nodeId of split.fromTree) expect(storedIds).not.toContain(nodeId);
    }), { seed: PROPS_SEED, numRuns: PROPS_RUNS });
  });

  it("scan 08 #6: a card only the tree draws is reported, not silently skipped", () => {
    expect(splitStoredCards([{ nodeId: "a" }], ["a", "child"])).toEqual({ stored: ["a"], fromTree: ["child"] });
    expect(splitStoredCards([], ["child"])).toEqual({ stored: [], fromTree: ["child"] });
  });
});
