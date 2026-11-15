// Property: the tags the merge picker offers (lib/tagTree canMergeTagInto) are exactly the ones the server accepts as a
// target (backend services/tagMerge.ts assertMergeTarget + reserved/view-module refusals): never the tag itself, a tag under
// it at any depth, a module tag or a system tag; every other tag is offered. Random forests, any pick of source.
// Seed and run count from PROPS_SEED / PROPS_RUNS.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../../../../markdown/src/test/helpers/propsConfig";
import { canMergeTagInto } from "../../lib/tagTree";

type T = { id: string; parent_id: string | null; schema_module?: string | null; reserved_key?: string | null };
const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

/** Tag i has a parent among the tags before it (a forest, no cycles), and may be a module or system tag. */
const forest = fc.array(fc.record({ parent: fc.option(fc.nat(), { nil: null }), module: fc.boolean(), reserved: fc.boolean() }), { minLength: 1, maxLength: 12 })
  .map((rows): T[] => rows.map((row, i) => ({
    id: `t${i}`,
    parent_id: i === 0 || row.parent === null ? null : `t${row.parent % i}`,
    ...(row.module ? { schema_module: "review" } : {}),
    ...(row.reserved ? { reserved_key: "task" } : {}),
  })));

const under = (tags: T[], id: string, ancestor: string): boolean => {
  for (let at: string | null = id; at; at = tags.find((t) => t.id === at)?.parent_id ?? null) if (at === ancestor) return true;
  return false;
};

describe("merge targets the picker offers", () => {
  it("is every tag except the source, the tags under it, module tags and system tags", () => {
    fc.assert(fc.property(forest, fc.nat(), (tags, pick) => {
      const source = tags[pick % tags.length]!;
      for (const target of tags) {
        const refused = target.id === source.id || under(tags, target.id, source.id) || !!target.schema_module || !!target.reserved_key;
        expect(canMergeTagInto(tags, source.id, target.id), `${source.id} into ${target.id}`).toBe(!refused);
      }
    }), fcOpts);
  });

  // Fixed case (scan 06 M3, situation 1): #書 has #書/小說; merging #書 into #書/小說 is not offered, a sibling is.
  it("does not offer a sub-tag of the tag being merged (the book case)", () => {
    const tags: T[] = [{ id: "book", parent_id: null }, { id: "novel", parent_id: "book" }, { id: "other", parent_id: null }];
    expect(canMergeTagInto(tags, "book", "novel")).toBe(false);
    expect(canMergeTagInto(tags, "book", "other")).toBe(true);
    expect(canMergeTagInto(tags, "novel", "book")).toBe(true); // the other way round is fine: a sub-tag may fold into its parent
  });
});
