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
import { pictureSourceIds, publishedNodeIds } from "./publishedSet.js";
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
       FROM publish_snapshots p WHERE p.workspace_id = ${workspaceId} ORDER BY p.created_at DESC LIMIT 1`.execute(db)).rows[0];
  if (!latest) return;
  if (latest.gone.length > 0) {
    await sql`UPDATE publish_snapshots
                 SET payload = jsonb_set(payload, '{taken_down}', coalesce(payload->'taken_down', '[]'::jsonb) || to_jsonb(${latest.gone}::text[]))
               WHERE id = ${latest.id}`.execute(db);
  }
  await recordPictureTakedowns(latest.id, workspaceId);
}

/** The drawings whose pictures the snapshot `snapshotId` carries
 *  (drawingEmbeds.ts: `pictures` on the notes that embed them), and those of
 *  them already recorded as taken down. */
async function snapshotPictureSources(snapshotId: string): Promise<{ sources: string[]; gone: Set<string> }> {
  const row = (await sql<{ sources: string[]; gone: string[] }>`
    SELECT ARRAY(SELECT DISTINCT s #>> '{}' FROM jsonb_path_query(p.payload, '$.nodes[*].pictures[*].source_node_id') s) AS sources,
           ARRAY(SELECT t->>'source_node_id' FROM jsonb_array_elements(coalesce(p.payload->'pictures_taken_down', '[]'::jsonb)) t) AS gone
      FROM publish_snapshots p WHERE p.id = ${snapshotId}`.execute(db)).rows[0];
  return { sources: row?.sources ?? [], gone: new Set(row?.gone ?? []) };
}

/** The same rule for the pictures of embedded drawings: a drawing whose
 *  picture the snapshot carries and that may no longer lend it
 *  (publishedSet.pictureSourceIds: marked 「不發布」, trashed, moved to someone
 *  else's personal space) is recorded in `pictures_taken_down`, so putting it
 *  back does not serve the old picture before the next publish. Its own list,
 *  not `taken_down`: a drawing can leave the site as a page and still lend its
 *  picture. Each entry names the drawing as `source_node_id`, so a permanent
 *  delete takes the entry with it (purgedContent.withoutNodes). */
async function recordPictureTakedowns(snapshotId: string, workspaceId: string): Promise<void> {
  const { sources, gone } = await snapshotPictureSources(snapshotId);
  if (sources.length === 0) return;
  const allowed = await pictureSourceIds(workspaceId, sources);
  const newlyGone = sources.filter((id) => !allowed.has(id) && !gone.has(id));
  if (newlyGone.length === 0) return;
  const entries = JSON.stringify(newlyGone.map((id) => ({ source_node_id: id })));
  await sql`UPDATE publish_snapshots
               SET payload = jsonb_set(payload, '{pictures_taken_down}', coalesce(payload->'pictures_taken_down', '[]'::jsonb) || ${entries}::jsonb)
             WHERE id = ${snapshotId}`.execute(db);
}

/** The drawings among `sources` whose pictures the served site shows now:
 *  those that may lend it (publishedSet.pictureSourceIds) and were not taken
 *  down since the snapshot (`takenDown`: its `pictures_taken_down`). */
export async function servedPictureSources(workspaceId: string, sources: readonly string[], takenDown: unknown): Promise<Set<string>> {
  const gone = new Set((Array.isArray(takenDown) ? takenDown : [])
    .map((entry) => (entry as { source_node_id?: unknown } | null)?.source_node_id)
    .filter((id): id is string => typeof id === "string"));
  return pictureSourceIds(workspaceId, sources.filter((id) => !gone.has(id)));
}

/** The notes the latest snapshot carries that were taken down since it was
 *  stored: they wait for the next publish even if they qualify again. */
export async function takenDownSinceLastPublish(workspaceId: string): Promise<Set<string>> {
  const r = await sql<{ id: string }>`
    SELECT jsonb_array_elements_text(coalesce(payload->'taken_down', '[]'::jsonb)) AS id
      FROM (SELECT payload FROM publish_snapshots WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC LIMIT 1) l`.execute(db);
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
