// Real database. q() refuses core-table writes outside a transaction; the
// report-only observer sees writes in a transaction that never took the event lock.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { observeCoreWritesWithoutEventLock, q, withTransaction } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { seedQ } from "./helpers/seedQ.js";

const NO_SUCH = "00000000-0000-4000-8000-000000000000";
const touch = () => q("UPDATE content_nodes SET title = title WHERE id = $1", [NO_SUCH]);

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("core writes need a transaction", () => {
  afterEach(() => observeCoreWritesWithoutEventLock(null));

  it("refuses a core-table write outside a transaction, with the way out in the message", async () => {
    await expect(touch()).rejects.toThrow(/mutate\(\) or withEventTransaction\(\)/);
    await expect(q("DELETE FROM node_tags WHERE node_id = $1", [NO_SUCH])).rejects.toThrow(/node_tags/);
  });

  it("allows reads, other tables and fixture writes (seedQ)", async () => {
    await q("SELECT id FROM content_nodes WHERE id = $1", [NO_SUCH]);
    await q("UPDATE workspaces SET name = name WHERE id = $1", [NO_SUCH]);
    await seedQ("UPDATE content_nodes SET title = title WHERE id = $1", [NO_SUCH]);
    await withTransaction(touch);
  });

  it("reports a write in a plain transaction, not one under the event lock", async () => {
    const seen: string[] = [];
    observeCoreWritesWithoutEventLock((table) => seen.push(table));
    await withTransaction(touch);
    expect(seen).toEqual(["content_nodes"]);
    await withEventTransaction(randomUUID(), touch);
    expect(seen).toEqual(["content_nodes"]);
    await withTransaction(touch); // the lock does not leak to the next transaction on a reused connection
    expect(seen).toEqual(["content_nodes", "content_nodes"]);
  });
  it("watches the tables that carry a stamp trigger without refusing a fixture's write to them", async () => {
    const seen: string[] = [];
    observeCoreWritesWithoutEventLock((table) => seen.push(table));
    for (const table of ["note_pointers", "node_positions", "block_node_tags"]) {
      await q(`DELETE FROM ${table} WHERE ${table === "block_node_tags" ? "block_node_id" : table === "node_positions" ? "node_id" : "id"} = $1`, [NO_SUCH]); // outside a transaction: allowed
      await withTransaction(() => q(`DELETE FROM ${table} WHERE ${table === "block_node_tags" ? "block_node_id" : table === "node_positions" ? "node_id" : "id"} = $1`, [NO_SUCH]));
    }
    expect(seen).toEqual(["note_pointers", "node_positions", "block_node_tags"]);
  });
  it("also watches spaces, space members and workspace settings (migration 199)", async () => {
    const seen: string[] = [];
    observeCoreWritesWithoutEventLock((table) => seen.push(table));
    const where: Record<string, string> = { spaces: "id", space_members: "space_id", workspaces: "id" };
    for (const table of ["spaces", "space_members", "workspaces"]) {
      await q(`DELETE FROM ${table} WHERE ${where[table]} = $1`, [NO_SUCH]); // outside a transaction: allowed
      await withTransaction(() => q(`DELETE FROM ${table} WHERE ${where[table]} = $1`, [NO_SUCH]));
    }
    expect(seen).toEqual(["spaces", "space_members", "workspaces"]);
  });
});
