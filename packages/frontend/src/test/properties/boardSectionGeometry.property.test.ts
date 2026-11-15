// Random cards and fold settings through the group frame (lib/sectionCarry).
//
// A card's height on the board is the board's display settings (a card's own choice, else the board
// default), not the old stored `folded` flag. Whatever the settings and cards are:
//   1 a frame drawn around any cards by boundingSectionRect carries every one of them
//   2 the frame is as tall as the cards are drawn: folding cards shrinks it, never grows it
//   3 a card whose drawn rectangle lies inside a frame is carried by it
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/boardSectionGeometry.property.test.ts

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { CanvasNodeEntry, CanvasSection } from "../../lib/api";
import { boundingSectionRect, canvasCardSize, cardsInSection } from "../../lib/sectionCarry";
import type { CardDisplaySettings } from "../../lib/cardDisplay";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const cards = fc.array(
  fc.record({
    x: fc.integer({ min: -2000, max: 2000 }),
    y: fc.integer({ min: -2000, max: 2000 }),
    width: fc.option(fc.integer({ min: 120, max: 600 }), { nil: undefined }),
    height: fc.option(fc.integer({ min: 60, max: 600 }), { nil: undefined }),
  }),
  { minLength: 1, maxLength: 12 },
).map((list) => list.map((c, i): CanvasNodeEntry => ({ nodeId: `c${i}`, ...c })));

const display = fc.record({
  cardDefault: fc.constantFrom<CardDisplaySettings["cardDefault"]>("folded", "expanded", undefined),
  foldedIds: fc.subarray(["c0", "c1", "c2", "c3", "c4"]),
  expandedIds: fc.subarray(["c0", "c1", "c2", "c3", "c4"]),
}) as fc.Arbitrary<CardDisplaySettings>;

const run = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

describe("group frame geometry follows how cards are drawn", () => {
  it("a frame made around cards carries all of them", () => {
    fc.assert(fc.property(cards, display, (list, settings) => {
      const frame = boundingSectionRect(list, settings);
      const section: CanvasSection = { id: "s", title: "g", ...frame };
      expect(cardsInSection(section, list, settings).map((c) => c.nodeId)).toEqual(list.map((c) => c.nodeId));
    }), run);
  });

  it("folding every card never makes the frame taller", () => {
    fc.assert(fc.property(cards, display, (list, settings) => {
      const folded = boundingSectionRect(list, { ...settings, cardDefault: "folded", expandedIds: [] });
      const open = boundingSectionRect(list, { ...settings, cardDefault: "expanded", foldedIds: [] });
      expect(folded.height).toBeLessThanOrEqual(open.height);
    }), run);
  });

  it("a card drawn wholly inside a frame is carried by it", () => {
    fc.assert(fc.property(cards, display, (list, settings) => {
      const [first, ...rest] = list;
      const { w, h } = canvasCardSize(first, settings);
      const section: CanvasSection = { id: "s", title: "g", x: first.x - 5, y: first.y - 5, width: w + 10, height: h + 10 };
      expect(cardsInSection(section, [first, ...rest], settings).map((c) => c.nodeId)).toContain(first.nodeId);
    }), run);
  });

  it("scan 08 #8: a card folded by the board default stays in a group framed around it", () => {
    const card = { nodeId: "c", x: 0, y: 0 };
    const settings: CardDisplaySettings = { cardDefault: "folded" };
    const frame = boundingSectionRect([card], settings);
    expect(cardsInSection({ id: "s", title: "g", ...frame }, [card], settings)).toHaveLength(1);
  });
});
