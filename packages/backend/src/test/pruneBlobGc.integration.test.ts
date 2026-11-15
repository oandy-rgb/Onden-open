// Regression for the orphan-blob GC reachability bug (blind-audit #1).
//
// maintenance/prune.ts Phase 2 GCs blobs not referenced by any event. It used to
// check ONLY payload.body_hash, so a blob referenced solely via value_ref — ink /
// large attribute values, which ride events as payload.value_ref AND as
// tx_meta.prev_field_values.value_ref (the inverse the restore path reads back) —
// was deleted as an orphan, silently breaking ink undo/restore (resolved to null).
//
// Runs the exact reachability predicate against a real DB inside a ROLLED-BACK
// transaction so it never deletes real blobs in the shared onden_test. The unit
// test (prune.test.ts) locks the production query string to this same predicate.

import { describe, it, expect } from "vitest";
import { pool } from "../db.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("orphan blob GC reachability (072 blind-audit #1)", () => {
  it("keeps body_hash / value_ref / inverse-value_ref blobs; deletes only true orphans", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const WS = "00000000-0000-0000-0000-0000000b10bc";
      await c.query(`INSERT INTO workspaces (id,name,slug) VALUES ($1,'BlobGc','blob-gc-ws') ON CONFLICT (id) DO NOTHING`, [WS]);

      for (const h of ["bg-body", "bg-valref", "bg-inverse", "bg-orphan"]) {
        await c.query(`INSERT INTO blobs (hash, content, size_bytes) VALUES ($1,$2,$3) ON CONFLICT (hash) DO NOTHING`, [h, "x", 1]);
      }

      // body_hash reference (markdown body); value_ref reference (ink attribute set);
      // inverse value_ref reference (tx_meta.prev_field_values, the restore source).
      // bg-orphan is referenced by nothing.
      await c.query(
        `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta) VALUES
           ($1,'user','u','NODE_UPDATED','node','n', jsonb_build_object('body_hash','bg-body'), '{}'::jsonb),
           ($1,'user','u','ATTRIBUTE_SET','node','n', jsonb_build_object('key','ink_data','value_ref','bg-valref'), '{}'::jsonb),
           ($1,'user','u','ATTRIBUTE_SET','node','n', jsonb_build_object('key','ink_data','value','x'),
              jsonb_build_object('prev_field_values', jsonb_build_object('value_ref','bg-inverse')))`,
        [WS],
      );

      // The production reachability predicate (prune.ts Phase 2), scoped to this
      // test's blobs so it touches nothing else; the whole tx rolls back anyway.
      const del = await c.query<{ hash: string }>(
        `DELETE FROM blobs b
          WHERE b.hash LIKE 'bg-%'
            AND NOT EXISTS (
              SELECT 1 FROM domain_events e
               WHERE e.payload->>'body_hash' = b.hash
                  OR e.payload->>'value_ref' = b.hash
                  OR e.tx_meta->'prev_field_values'->>'value_ref' = b.hash
            )
          RETURNING hash`,
      );
      expect(del.rows.map((r) => r.hash)).toEqual(["bg-orphan"]); // only the true orphan
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});
