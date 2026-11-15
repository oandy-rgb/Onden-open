// Random frame patches through the server's merge (services/boardSections mergeSections), no database.
//
// A board's frames are patched by the fields a change names (like a card), so two devices editing different
// fields of one frame both keep their edit. Whatever the stored frames and the patches are:
//   1 a field no patch names is exactly as stored; a field a patch names ends as the last patch said
//   2 a frame not stored is created only from a patch with all of x, y, width, height; never half a frame
//   3 a removed id is absent whatever else was sent for it, and no other frame is touched
//   4 frames keep their stored order; new ones follow in the order sent
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/boardSectionMerge.property.test.ts

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { BoardSectionPatch } from "@onden/contract";
import { mergeSections } from "../../services/boardSections.js";
import type { BoardSection } from "../../services/boardStore.js";
import { check } from "../helpers/propsConfig.js";

const id = fc.integer({ min: 0, max: 5 }).map((n) => `s${n}`);
const num = fc.integer({ min: -500, max: 2000 });
const patch: fc.Arbitrary<BoardSectionPatch> = fc.record({
  id,
  title: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  x: fc.option(num, { nil: undefined }), y: fc.option(num, { nil: undefined }),
  width: fc.option(num.map(Math.abs), { nil: undefined }), height: fc.option(num.map(Math.abs), { nil: undefined }),
  color: fc.option(fc.option(fc.constantFrom("#112233", "#445566"), { nil: null }), { nil: undefined }),
}, { requiredKeys: ["id"] });
const stored = fc.uniqueArray(fc.record({ id, x: num, y: num, width: num.map(Math.abs), height: num.map(Math.abs), title: fc.string({ maxLength: 8 }) }), { selector: (s) => s.id, maxLength: 5 });

describe("frame patches merge field by field", () => {
  it("keeps what no patch names, applies what it names, creates only whole frames", () => {
    check(fc.property(stored, fc.array(patch, { maxLength: 8 }), fc.array(id, { maxLength: 2 }), (before, patches, removed) => {
      const after = mergeSections(before, patches, removed);
      const byId = new Map(after.map((s) => [s.id, s]));
      expect(byId.size).toBe(after.length);
      for (const gone of removed) expect(byId.has(gone)).toBe(false);
      for (const old of before) {
        if (removed.includes(old.id)) continue;
        const now = byId.get(old.id)!;
        const named = patches.filter((p) => p.id === old.id);
        for (const key of ["x", "y", "width", "height", "title"] as const) {
          const last = named.map((p) => p[key]).filter((v) => v !== undefined).at(-1);
          expect(now[key]).toEqual(last ?? old[key]);
        }
        const colors = named.map((p) => p.color).filter((v) => v !== undefined);
        if (colors.length) expect(now.color ?? null).toEqual(colors.at(-1));
      }
      for (const now of after) {
        if (before.some((old) => old.id === now.id)) continue;
        for (const key of ["x", "y", "width", "height"] as const) expect(typeof now[key]).toBe("number");
      }
      // Stored order is kept.
      const keptOrder = before.filter((old) => byId.has(old.id)).map((old) => old.id);
      expect(after.slice(0, keptOrder.length).map((s) => s.id)).toEqual(keptOrder);
    }));
  });

  it("scan 08 #4: a rename keeps the size another device set, and a patch for a vanished frame creates nothing", () => {
    const frame: BoardSection = { id: "f", x: 0, y: 0, width: 700, height: 500, title: "Group" };
    expect(mergeSections([frame], [{ id: "f", title: "Renamed" }], [])).toEqual([{ ...frame, title: "Renamed" }]);
    expect(mergeSections([], [{ id: "f", title: "Renamed" }], [])).toEqual([]);
    expect(mergeSections([frame], [{ id: "f", color: "#112233" }], [])[0]!.color).toBe("#112233");
    expect(mergeSections([{ ...frame, color: "#112233" }], [{ id: "f", color: null }], [])[0]).not.toHaveProperty("color");
  });
});
