// The one list of columns derived on each node (spine/snapshotTables.ts DERIVED_PER_NODE_COLUMNS, declared in snapshotTables.json `derived`) may name only
// columns that do not replicate, and only in a way a check knows: a replicated column on it would make every check of "two nodes hold the same" quiet about
// that column. spine/stampedMerge/dbUnits.ts refuses such a list when it loads, so the backend (and every test) does not start. Proved here by loading the
// module again with a wrong list in place of the real one, one kind of mistake at a time; the real list loads (the control).
// SAFETY: no database; each load is a fresh module graph with snapshotTables.js replaced.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DerivedColumns } from "../spine/snapshotTables.js";

/** Load dbUnits.ts with `list` as the one list (`undefined`: the real one). */
async function loadWith(list: DerivedColumns | undefined): Promise<unknown> {
  vi.resetModules();
  vi.doMock("../spine/snapshotTables.js", async (importOriginal) => {
    const real = await importOriginal<typeof import("../spine/snapshotTables.js")>();
    return list === undefined ? real : { ...real, DERIVED_PER_NODE_COLUMNS: list };
  });
  return import("../spine/stampedMerge/dbUnits.js");
}

afterEach(() => { vi.doUnmock("../spine/snapshotTables.js"); vi.resetModules(); });

describe("the list of columns derived on each node is checked when the backend loads", () => {
  it("the real list loads (control)", async () => {
    await expect(loadWith(undefined)).resolves.toBeDefined();
  });
  const wrong: [string, DerivedColumns, RegExp][] = [
    ["a unit's column", { node_attributes: { value: "left out" } }, /node_attributes\.value is replicated/],
    ["a key column", { node_positions: { surface: "set or not" } }, /node_positions\.surface is replicated/],
    ["one column of a unit of two", { node_positions: { y: "left out" } }, /node_positions\.y is replicated/],
    ["a JSON column whose keys travel", { function_refs: { config: "left out" } }, /function_refs\.config is replicated/],
    ["the workspace", { block_nodes: { workspace_id: "left out" } }, /block_nodes\.workspace_id is replicated/],
    ["a table whose rows do not travel", { outbox: { updated_at: "left out" } }, /outbox is not a table whose rows travel/],
    ["a way of comparing that is not one", { block_nodes: { hidden_at: "ignored" as never } }, /block_nodes\.hidden_at: "ignored" is not a way/],
  ];
  for (const [what, list, message] of wrong) {
    it(`refused: ${what}`, async () => {
      await expect(loadWith(list)).rejects.toThrow(message);
    });
  }
});
