// Which writes plan each statement for the tables as they are (db.ts withBulkWrites, planThisTransactionForTablesAsTheyAre; issue #2001), told
// by the database itself (`SHOW plan_cache_mode` inside the write), not by cost: planning reads no rows, so a row count cannot tell an ordinary save
// that replans from one that does not. And two large writes at once: each analyzes the tables it fills (analyzeTablesOfLargeWrite), and ANALYZE
// holds its lock until the transaction ends, so the second must skip a table the first holds, not wait for it.
// Its own database (openNode), not the shared test database: the world's people and invitations are unique per database, and another file there
// builds the same world (placeIsOneWriteMigration: actors_pending_invite_email_uq, public CI run 45300444583).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeTablesOfLargeWrite, q, withBulkWrites, withTransaction } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { buildSourceWorld, openNode, type SourceWorld } from "./helpers/stampedWorld.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const planning = async () => (await q<{ plan_cache_mode: string }>(`SHOW plan_cache_mode`)).rows[0]!.plan_cache_mode;

/** A note made through createNote; `seen` gets plan_cache_mode as it is inside the note's own write. */
async function noteSeeing(world: SourceWorld, seen: string[]): Promise<void> {
  await createNote({ actor: world.owner, workspaceId: world.ws, id: randomUUID(), title: "Seen", markdown: "seen", spaceId: world.spaceA,
    event: { uiContext: "test.note" }, within: async () => { seen.push(await planning()); } });
}

describe.skipIf(!isTestDatabase())("which writes plan each statement for the tables as they are", () => {
  let world: SourceWorld;
  let node: RealNode;
  // opened in beforeAll, not while the file is collected: a skipped describe's body still runs, and openNode refuses without a *_test database
  beforeAll(async () => { node = await openNode("large-writes"); world = await buildSourceWorld(node); }, 300_000);
  afterAll(async () => { await node?.close().catch(() => undefined); });

  it("an ordinary save keeps the cached plans; a declared large write and a transaction past 100 versions plan each statement; the next transaction does not", async () => {
    await onNode(node, async () => {
      const ordinary: string[] = [], declared: string[] = [], pastHundred: string[] = [], after: string[] = [];
      await noteSeeing(world, ordinary);
      await withBulkWrites(() => noteSeeing(world, declared));
      await withTransaction(() => withEventTransaction(world.ws, async () => {
        for (let i = 0; i < 100; i++) await createNote({ actor: world.owner, workspaceId: world.ws, id: randomUUID(), title: `Many ${i}`, markdown: `many ${i}`, spaceId: world.spaceA, event: { uiContext: "test.import" } });
        pastHundred.push(await planning());
      }));
      await noteSeeing(world, after);
      expect({ ordinary, declared, pastHundred, after }).toEqual({ ordinary: ["auto"], declared: ["force_custom_plan"], pastHundred: ["force_custom_plan"], after: ["auto"] });
    });
  }, 300_000);

  it.skipIf(needsSecondConnection)("a second large write does not wait for the first one's ANALYZE: it skips the tables the first holds until it ends", async () => {
    await onNode(node, async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let analyzed!: () => void;
      const firstHolds = new Promise<void>((resolve) => { analyzed = resolve; });
      const first = withTransaction(async () => { await analyzeTablesOfLargeWrite(); analyzed(); await held; });
      await firstHolds;
      const second = withTransaction(() => analyzeTablesOfLargeWrite()).then(() => "done" as const);
      const answer = await Promise.race([second, new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 5_000))]);
      release();
      await first;
      await second;
      expect(answer).toBe("done");
    });
  }, 60_000);
});
