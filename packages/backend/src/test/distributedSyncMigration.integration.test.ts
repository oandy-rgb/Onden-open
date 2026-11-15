// Distributed sync (beta): migration 173 on the fully migrated test database, and the engine running on the process's own
// database (db.ts) instead of a bare PGlite. Real Postgres in CI, PGlite in the cloud run (docs/architecture/portable-backend.md §6).
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { SyncNode } from "../distributedSync/node.js";
import type { SyncDb } from "../distributedSync/types.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const poolSyncDb: SyncDb = {
  async query<T>(sql: string, params?: unknown[]) { return (await q(sql, params)).rows as T[]; },
  transaction: (fn) => withTransaction(() => fn(poolSyncDb)),
};

describe.skipIf(!isTestDatabase())("distributed sync tables on the migrated database", () => {
  let node: SyncNode;
  beforeAll(async () => {
    await q("TRUNCATE ds_ops, ds_rejections, ds_peers, ds_node");
    node = await SyncNode.open(poolSyncDb, { nodeId: "solo", actors: ["alice"], directory: {}, now: () => Date.now() });
  });
  afterAll(async () => { await q("TRUNCATE ds_ops, ds_rejections, ds_peers, ds_node"); });

  it("exist, are recorded as migrated, and touch no existing table", async () => {
    const v = await q<{ version: string }>("SELECT version FROM schema_migrations WHERE version = '173_distributed_sync'");
    expect(v.rows).toHaveLength(1);
    const t = await q<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ds\\_%' ORDER BY 1");
    expect(t.rows.map((r) => r.table_name)).toEqual(["ds_capture_cursor", "ds_captured_events", "ds_node", "ds_ops", "ds_peers", "ds_projection_failures", "ds_rejections", "ds_unsupported"]);
    // No foreign key in or out: the sync tables stand alone.
    const fk = await q("SELECT 1 FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY' AND table_name LIKE 'ds\\_%'");
    expect(fk.rows).toHaveLength(0);
  });

  it("run a node on it: a space, a note and an edit; the log refuses rewriting", async () => {
    const r1 = await node.submit("alice", "s", { kind: "space.create", space: "s", name: "mine" });
    const r2 = await node.submit("alice", "s", { kind: "note.create", note: "n", noteKind: "content", title: "T", body: "a\n", parent: null });
    const r3 = await node.submit("alice", "s", { kind: "note.body", note: "n", before: "a\n", after: "a\nb\n" });
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, true]);
    expect((await node.world()).notes.get("n")!.body).toBe("a\nb\n");
    expect(await node.have()).toEqual({ solo: [[1, 3]] });
    await expect(q("DELETE FROM ds_ops")).rejects.toThrow(/append-only/);
  });
});
