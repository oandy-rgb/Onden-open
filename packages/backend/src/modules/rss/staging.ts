// Writes to the RSS staging buffer (rss_staging, rss_seen): who has seen an
// item, the note an item was saved as, and a full-text body loaded in place.
// Buffer state — no domain event. Moved from routes.ts (depth audit D2); the
// routes gate each item for the caller before calling.

import { q } from "../../db.js";

/** Mark staging rows seen (or unseen again) for one person. Items whose
 *  source sits in a space with the shared-"seen" switch on (a lab's common
 *  reading list) are marked for everyone instead: the stream's own seen_at,
 *  with any personal marks on them cleared. */
export async function markSeen(stagingIds: string[], actorId: string, seen: boolean): Promise<void> {
  if (stagingIds.length === 0) return;
  const shared = (await q<{ id: string }>(
    `SELECT st.id FROM rss_staging st
       JOIN rss_subscriptions src ON src.id = st.subscription_id
       JOIN spaces sp ON sp.id = src.space_id AND (sp.capabilities->>'shared_seen') = 'true'
      WHERE st.id = ANY($1::uuid[])`, [stagingIds])).rows.map((r) => r.id);
  if (shared.length) {
    await q(`UPDATE rss_staging SET seen_at = ${seen ? "COALESCE(seen_at, now())" : "NULL"} WHERE id = ANY($1::uuid[])`, [shared]);
    await q(`DELETE FROM rss_seen WHERE staging_id = ANY($1::uuid[])`, [shared]);
    stagingIds = stagingIds.filter((id) => !shared.includes(id));
    if (stagingIds.length === 0) return;
  }
  await q(
    `INSERT INTO rss_seen (staging_id, actor_id, seen) SELECT unnest($1::uuid[]), $2, $3
     ON CONFLICT (staging_id, actor_id) DO UPDATE SET seen = EXCLUDED.seen, seen_at = now()`,
    [stagingIds, actorId, seen],
  );
}

/** Point a staging row at the note it was saved as (the save's tombstone-
 *  with-a-pointer; it is never cleared). */
export async function linkSavedNote(stagingId: string, workspaceId: string, nodeId: string): Promise<void> {
  await q(`UPDATE rss_staging SET saved_node_id = $3 WHERE id = $1 AND workspace_id = $2`, [stagingId, workspaceId, nodeId]);
}

/** Replace an unsaved item's body with the full article (載入全文). */
export async function replaceStagingBody(stagingId: string, workspaceId: string, body: string): Promise<void> {
  await q(
    `UPDATE rss_staging SET body = $3 WHERE id = $1 AND workspace_id = $2`,
    [stagingId, workspaceId, body],
  );
}
