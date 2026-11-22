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
// five) — or some version names it (note_versions.content_hash, migration 220;
// purgedContent.ts asks the same). An unreferenced blob younger than BLOB_GC_GRACE stays: putBlob runs
// before the event that references it commits (services/blobs.ts).

import { BLOB_GC_GRACE } from "../blobs.js";
import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { hashesOf } from "../inkChunks.js";
import { pool } from "../../db.js";

/** Delete every blob no event references and nobody put within
 *  BLOB_GC_GRACE. Idempotent. Returns how many went and their bytes. A drawing stored as chunks (inkChunks.ts) is
 *  swept the same way: its manifest when no event names it, then the chunks no manifest of the note uses. */
export async function collectOrphanBlobs(): Promise<{ blobs: number; blobBytesFreed: number; inkManifests: number; inkChunks: number; inkChunkBytesFreed: number }> {
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
         -- and no version names it: a version received from another node, or a root's baseline, has no event here (migration 220)
         AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.content_hash = b.hash)
       RETURNING size_bytes
     )
     SELECT COUNT(*)::text AS count, COALESCE(SUM(size_bytes), 0)::text AS freed_bytes
       FROM orphans`,
  );
  // A drawing stored as chunks (inkChunks.ts): its manifest goes when no event names the value (the places an event can name
  // one are listed above), then the chunks of those notes that no remaining manifest of the note uses.
  const goneManifests = await sql<{ node_id: string }>`
    DELETE FROM ink_manifests m
     WHERE m.created_at < now() - ${BLOB_GC_GRACE}::interval
       AND NOT EXISTS (SELECT 1 FROM domain_events e
                        WHERE e.payload->>'value_ref' = m.hash
                           OR e.tx_meta->'prev_field_values'->>'value_ref' = m.hash
                           OR e.payload->>'incoming_value_ref' = m.hash
                           OR e.payload->>'overridden_value_ref' = m.hash)
       AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = m.node_id AND v.content_hash = m.hash)
    RETURNING m.node_id`.execute(db);
  let inkChunks = 0, inkChunkBytesFreed = 0;
  for (const nodeId of new Set(goneManifests.rows.map((r) => r.node_id))) {
    const live = await db.selectFrom("ink_manifests").select("chunks").where("node_id", "=", nodeId).execute();
    const keep = [...new Set(live.flatMap((r) => hashesOf(r.chunks)))];
    const removed = await sql<{ size_bytes: number }>`
      DELETE FROM ink_chunks c WHERE c.node_id = ${nodeId} AND c.created_at < now() - ${BLOB_GC_GRACE}::interval AND c.hash <> ALL(${keep}::text[])
      RETURNING c.size_bytes`.execute(db);
    inkChunks += removed.rows.length;
    inkChunkBytesFreed += removed.rows.reduce((sum, r) => sum + Number(r.size_bytes), 0);
  }
  return {
    blobs: parseInt(orphanResult.rows[0]?.count ?? "0", 10),
    blobBytesFreed: parseInt(orphanResult.rows[0]?.freed_bytes ?? "0", 10),
    inkManifests: goneManifests.rows.length, inkChunks, inkChunkBytesFreed,
  };
}
