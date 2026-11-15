// How long does an undo with `cascade: true` hold the workspace event lock?
//
// restoreEvent opens ONE transaction (spine/mutate.ts runRestore →
// withEventTransaction), takes the workspace's event-append advisory lock
// first, and keeps it until the last descendant is undone and the transaction
// commits. Every other writer in that workspace waits on the same lock, so the
// lock hold time IS the time the cascade takes. This test measures that with a
// single connection (PGlite has no second connection): the wall time of one
// cascade restore over N descendants (N = 10 / 100 / 1000), printed as a table.
// It asserts only that every descendant was undone and that the cost stays
// roughly linear — a coarse guard against a quadratic regression, not a speed
// promise (CI machines differ). Default sizes 10 and 100 keep the suite fast; CASCADE_COST_NS=10,100,1000 measures 1000 too (~9 s on PGlite).

import { beforeAll, describe, expect, it, vi } from "vitest";
import { q, event, withTransaction } from "../db.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const isTestDb = isTestDatabase();
const actor: ActorCtx = { id: "cascade-cost-admin", name: "Cascade cost admin", role: "admin", type: "human" };
let workspaceId = "";

vi.mock("../db.js", async (original) => ({
  ...await original<typeof import("../db.js")>(),
  getWorkspaceId: async () => workspaceId,
}));

const SIZES = (process.env.CASCADE_COST_NS ?? "10,100").split(",").map(Number);

async function importLikeChain(n: number) {
  const rootNode = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, title, slug, markdown, source_type, node_type)
     VALUES ($1, 'Imported title', gen_random_uuid()::text, '', 'manual', 'content') RETURNING id`,
    [workspaceId],
  )).rows[0]!.id;
  const children = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, title, slug, markdown, source_type, node_type)
     SELECT $1, 'child ' || g, gen_random_uuid()::text, '', 'manual', 'content' FROM generate_series(1, $2::int) g RETURNING id`,
    [workspaceId, n],
  )).rows.map((r) => r.id);
  let rootEvent = "";
  await withTransaction(async () => {
    rootEvent = await event(workspaceId, "NODE_UPDATED", "node", rootNode,
      { title: "Imported title" }, "user", actor.id, { txMeta: { prev_field_values: { title: "Before import" } } });
    for (const id of children) {
      await event(workspaceId, "NODE_CREATED", "node", id, {}, "user", actor.id, { triggeredBy: rootEvent });
    }
  });
  return { rootNode, children, rootEvent };
}

describe.skipIf(!isTestDb)("cascade restore cost (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Cascade cost', gen_random_uuid()::text) RETURNING id`,
    )).rows[0]!.id;
    Object.assign(actor, await persistActor(workspaceId, actor));
  });

  it("undoes N descendants in one transaction and reports the time it holds the workspace lock", async () => {
    const rows: string[] = [];
    const perEvent: number[] = [];
    for (const n of SIZES) {
      const chain = await importLikeChain(n);
      const started = performance.now();
      const result = await restoreEvent(chain.rootEvent, { actor, workspaceId, cascade: true });
      const ms = performance.now() - started;
      expect(result).toMatchObject({ restored: true });
      const trashed = (await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM content_nodes WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL`, [chain.children],
      )).rows[0]!.n;
      expect(trashed).toBe(n);
      perEvent.push(ms / n);
      rows.push(`N=${String(n).padStart(4)}  ${ms.toFixed(0).padStart(7)} ms  ${(ms / n).toFixed(2)} ms/event`);
    }
    console.log(`cascade restore (lock held for the whole transaction):\n${rows.join("\n")}`);
    // Linear, not quadratic: the per-event cost at the largest size stays within 5x of the smallest.
    if (perEvent.length > 1) expect(perEvent.at(-1)!).toBeLessThan(perEvent[0]! * 5 + 5);
  }, 600_000);
});
