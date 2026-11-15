// Integration test for migration 051 — domain_events is append-only at the DB
// boundary. Verifies the BEFORE DELETE trigger's two invariants:
//   1. ad-hoc DELETE is blocked unless myapp.allow_event_prune is set;
//   2. a snapshotted event (referenced by content_node_versions) can never be
//      deleted, even with the GUC set;
//   3. an un-snapshotted node event IS deletable via the sanctioned GUC path.
// Direct SQL against a real DB (the trigger is the unit under test).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, q } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
const WS = "00000000-0000-0000-0000-00000000ae02";

async function mkNode(slug: string): Promise<string> {
  const r = await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
     VALUES ($1, 'content', 'manual', $2, $2, 'x') RETURNING id`,
    [WS, slug],
  );
  return r.rows[0]!.id;
}
async function mkEvent(targetId: string, payload: Record<string, unknown> = {}): Promise<string> {
  const r = await q<{ id: string }>(
    `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
     VALUES ($1, 'user', 'u1', 'NODE_UPDATED', 'node', $2, $3) RETURNING id`,
    [WS, targetId, JSON.stringify(payload)],
  );
  return r.rows[0]!.id;
}

describe.skipIf(!isTestDb)("domain_events append-only (051)", () => {
  let nid = "", snapshottedEv = "", looseEv = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (id, name, slug) VALUES ($1,'AppendOnly','append-only-ws') ON CONFLICT (id) DO NOTHING`, [WS]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [WS]);
    nid = await mkNode("ao-1");
    // Migration 052: an event is immortal iff it carries body_hash (it points to
    // retained content in the blob store). The loose event carries no body_hash.
    snapshottedEv = await mkEvent(nid, { title: "x", body_hash: "ao-blob-hash" });
    looseEv = await mkEvent(nid, {});
  });

  afterAll(async () => {
    // body_hash-bearing events are genuinely immortal (that is the guarantee), so
    // they cannot be deleted here — and because workspace_id is ON DELETE CASCADE,
    // deleting the workspace would cascade into them and the prevent-delete trigger
    // would abort it. So teardown only removes the node (no event cascade — events
    // reference target_id as plain text, not an FK); the test events + workspace
    // are harmless leftovers in onden_test, idempotent across runs.
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [WS]);
    await pool.end();
  });

  it("blocks ad-hoc DELETE without the prune GUC", async () => {
    await expect(q(`DELETE FROM domain_events WHERE id = $1`, [looseEv])).rejects.toThrow(/append-only/);
  });

  it("keeps a snapshotted event undeletable even WITH the GUC", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('myapp.allow_event_prune','on',true)");
      await expect(c.query(`DELETE FROM domain_events WHERE id = $1`, [snapshottedEv])).rejects.toThrow(/body_hash/);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("allows deleting an un-snapshotted node event via the GUC path", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('myapp.allow_event_prune','on',true)");
      const r = await c.query(`DELETE FROM domain_events WHERE id = $1`, [looseEv]);
      expect(r.rowCount).toBe(1);
      await c.query("ROLLBACK"); // keep the row for afterAll teardown
    } finally {
      c.release();
    }
  });
});
