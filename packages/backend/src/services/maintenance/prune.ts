// Orphan-blob garbage collection (ER5.6 phase 2) — an operator's manual run.
//
// Deleting notes for good is services/nodeTrash.ts purgeDeleted, one note at a
// time from History, and nothing else hard-deletes a note
// (test/nodeLifecycleOwner.test.ts). The retention sweep that lived here
// (pruneSoftDeleted, purgeTrashed: every deleted note older than N days, each
// with a NODE_PURGED event that kept its title) is gone with the trash: a
// deleted note stays until someone deletes it for good, and nothing purges in
// bulk. A purge deletes the blobs only its notes used itself; this sweep only
// tidies blobs nothing references, from writes that never committed.
//
// In the events->hash->blobs model (migration 053 retired
// content_node_versions), a blob is reachable iff some event carries its hash
// — as payload.body_hash (markdown bodies), payload.value_ref (ink / large
// attribute values), tx_meta.prev_field_values.value_ref (the inverse value
// the restore path reads back), or a drawing conflict's
// incoming_/overridden_value_ref (services/purgedContent.ts lists the same
// five). An unreferenced blob younger than BLOB_GC_GRACE stays: putBlob runs
// before the event that references it commits (services/blobs.ts).

import { BLOB_GC_GRACE } from "../blobs.js";
import { pool } from "../../db.js";

/** Delete every blob no event references and nobody put within
 *  BLOB_GC_GRACE. Idempotent. Returns how many went and their bytes. */
export async function collectOrphanBlobs(): Promise<{ blobs: number; blobBytesFreed: number }> {
  const orphanResult = await pool.query<{ freed_bytes: string; count: string }>(
    `WITH orphans AS (
       DELETE FROM blobs b
       WHERE b.created_at < now() - interval '${BLOB_GC_GRACE}'
         AND NOT EXISTS (
         SELECT 1 FROM domain_events e
          WHERE e.payload->>'body_hash' = b.hash
             OR e.payload->>'value_ref' = b.hash
             OR e.tx_meta->'prev_field_values'->>'value_ref' = b.hash
             -- a drawing conflict's two values (services/attributeWrites.ts)
             OR e.payload->>'incoming_value_ref' = b.hash
             OR e.payload->>'overridden_value_ref' = b.hash
       )
       RETURNING size_bytes
     )
     SELECT COUNT(*)::text AS count, COALESCE(SUM(size_bytes), 0)::text AS freed_bytes
       FROM orphans`,
  );
  return {
    blobs: parseInt(orphanResult.rows[0]?.count ?? "0", 10),
    blobBytesFreed: parseInt(orphanResult.rows[0]?.freed_bytes ?? "0", 10),
  };
}
