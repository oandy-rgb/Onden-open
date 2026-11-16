// Pin for docs/architecture/proposals/scoped-sync-2026-11-16.md §6 (the slug invariant).
// A scoped copy holds only some of the notes, so the slug it works out for a note (unique across the whole workspace) can differ from
// the full node's. That is only harmless while nothing replicated depends on the slug's value. What this file pins is the half that can be
// pinned: slug is not a unit of merge (no stamp of its own, no entry in UNIT_SOURCES). That nothing replicated READS the value cannot be
// shown by one test (every reader would have to be scanned); step 1 of the proposal's order checks export, publish, the link index and search.
import { describe, expect, it } from "vitest";
import { UNIT_SOURCES } from "../../spine/stampedMerge/dbUnits.js";

describe("slug is not a unit of merge", () => {
  it("no stamped table lists slug among its unit fields or its columns", () => {
    for (const source of UNIT_SOURCES) {
      expect(Object.keys(source.fields), `${source.label}: slug became a field`).not.toContain("slug");
      expect(Object.values(source.fields), `${source.label}: a field maps to the slug column`).not.toContain("slug");
    }
  });
});
