// Taken-down notes stay off the site until the next publish (owner
// 2026-11-14). The served site is the latest snapshot minus what the live
// workspace no longer allows; without a record, a note that left (「不發布」,
// trashed, its space switched off) and then qualified again would be served
// again from the OLD snapshot's text, unseen by the owner. So every change that
// may remove something (the website module's hooks, which already call
// requestSiteRebuild inside the writing transaction) first records the
// snapshot's notes that the published set no longer holds, as `taken_down` in
// that snapshot's payload. The record lives and dies with the snapshot: the
// next publish stores a new snapshot built from the notes allowed then, so
// every returning note is in it and nothing needs clearing. No new table.

import { sql } from "kysely";
import { db } from "../../../dbKysely.js";
import { publishedNodeIds } from "./publishedSet.js";
import { latestSnapshotPayload, latestSnapshotRow } from "./latestSnapshot.js";
import { withCurrentIds, withFormerIds } from "../../../services/idRewrites.js";

/** Add to the latest snapshot's `taken_down` every note it carries that the
 *  published set no longer holds. Call in the transaction of the change. */
export async function recordTakedowns(workspaceId: string): Promise<void> {
  // (a snapshot made before migration 201 names a note whose id it changed by the old one: that note is still allowed, not gone)
  const allowed = [...(await withFormerIds(workspaceId, await publishedNodeIds(workspaceId)))];
  const latest = (await sql<{ id: string; gone: string[] }>`
    SELECT p.id, ARRAY(
              SELECT n->>'id' FROM jsonb_array_elements(coalesce(p.payload->'nodes', '[]'::jsonb)) n
               WHERE NOT (n->>'id' = ANY(${allowed}::text[]))
                 AND NOT (coalesce(p.payload->'taken_down', '[]'::jsonb) @> to_jsonb(n->>'id'))) AS gone
       FROM ${latestSnapshotRow(workspaceId)} p`.execute(db)).rows[0];
  if (!latest || latest.gone.length === 0) return;
  await sql`UPDATE publish_snapshots
               SET payload = jsonb_set(payload, '{taken_down}', coalesce(payload->'taken_down', '[]'::jsonb) || to_jsonb(${latest.gone}::text[]))
             WHERE id = ${latest.id}`.execute(db);
}

/** The notes the latest snapshot carries that were taken down since it was
 *  stored: they wait for the next publish even if they qualify again. */
export async function takenDownSinceLastPublish(workspaceId: string): Promise<Set<string>> {
  const r = await sql<{ id: string }>`
    SELECT jsonb_array_elements_text(coalesce(payload->'taken_down', '[]'::jsonb)) AS id
      FROM (SELECT ${latestSnapshotPayload(workspaceId)} AS payload) l`.execute(db);
  // (a record made before migration 201 names a note by its old id: it is taken down under the new one too)
  return withCurrentIds(workspaceId, new Set(r.rows.map((row) => row.id)));
}

/** The notes the served site may show now: the published set minus those
 *  taken down since the last publish. What every reader-facing surface (the
 *  served snapshot, the media gate) filters the snapshot by; a NEW snapshot
 *  (the publish, its preview) is built from publishedNodeIds, so returning
 *  notes come back with it. */
export async function servedNodeIds(workspaceId: string): Promise<Set<string>> {
  const [allowed, taken] = await Promise.all([publishedNodeIds(workspaceId), takenDownSinceLastPublish(workspaceId)]);
  for (const id of taken) allowed.delete(id);
  return allowed;
}
