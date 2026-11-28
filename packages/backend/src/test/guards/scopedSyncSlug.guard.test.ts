// Pin for docs/architecture/proposals/scoped-sync-2026-11-16.md §6 (the slug invariant).
// A scoped copy holds only some of the notes, so the slug it works out for a note (unique across the whole workspace) can differ from
// the full node's. That is only harmless while nothing replicated depends on the slug's value. What this file pins is the half that can be
// pinned: the slug a note HAS (content_nodes.slug) is not a unit of merge. Since own-node transport batch 5 (migration 235) the slug its WRITE chose is one
// (the unit `slug`, column written_slug), and every node works out the slug it shows from those units (spine/noteSlugs.ts settleReceivedSlugs): a scoped
// copy's own choice is a written slug like any other, settled where it meets another note's. That nothing replicated READS the shown value cannot be
// shown by one test (every reader would have to be scanned); step 1 of the proposal's order checks export, publish, the link index and search.
import { describe, expect, it } from "vitest";
import { UNIT_SOURCES } from "../../spine/stampedMerge/dbUnits.js";

describe("the slug a note has is not a unit of merge", () => {
  it("no stamped table maps a unit to the slug column; the notes' unit `slug` is the written slug", () => {
    for (const source of UNIT_SOURCES) {
      expect(Object.values(source.fields).flatMap((c) => c.split("+")), `${source.label}: a field maps to the slug column`).not.toContain("slug");
      if (source.label !== "content_nodes") expect(Object.keys(source.fields), `${source.label}: slug became a field`).not.toContain("slug");
    }
    expect(UNIT_SOURCES.find((s) => s.label === "content_nodes")!.fields.slug).toBe("written_slug");
  });
});
