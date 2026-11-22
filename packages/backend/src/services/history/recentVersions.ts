// The "recently changed" feed across the workspace. Derived from the event log:
// each version of a note's text (note_versions). (The CoW
// content_node_versions table + trigger were retired in migration 053.)

import { pool } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { type PageInput, pageOf, pageSql } from "../paging.js";
import { EDIT_VERSION_SQL, bodyEventSql } from "./bodyEvents.js";
import { keepVersionStatisticsCurrent } from "./storedVersions.js";
import { readableNotesSql } from "./readableNotes.js";
import type { Page } from "@onden/contract";

/** One page of recent versions of the notes `actor` may read, newest first.
 *  This feed exposes every node's title/slug, so it is bounded by the combined
 *  read set (role/tag policy ∩ token and matter scope). The clause is pushed
 *  into SQL BEFORE the LIMIT: filtering a fetched page in JS let restricted
 *  versions use up the page and return short or empty lists. */
export async function recentVersions(actor: ActorCtx, workspaceId: string, page: PageInput): Promise<Page<{ node_id: string }>> {
  keepVersionStatisticsCurrent();
  const params: unknown[] = [workspaceId];
  const readable = await readableNotesSql(actor, workspaceId, "n", params);
  // A note's or board's versions come from the version tables; a tag's description and a system note have none yet and keep reading their saves.
  // `tie` orders the saves of one instant: the event number, or the version's place in its transaction.
  const result = await pool.query<{ node_id: string }>(
    `SELECT s.id, s.node_id, s.title, s.changed_at, s.on_another_device, n.title AS current_title, n.slug
     FROM (
       SELECT v.version_key AS id, v.note_id::text AS node_id, v.title, v.at::timestamptz AS changed_at, v.ordinal::bigint AS tie, (v.recorded_by IS DISTINCT FROM (SELECT node_id FROM sync_node WHERE singleton)) AS on_another_device
         FROM note_versions v JOIN blobs b ON b.hash = v.content_hash
        WHERE v.workspace_id = $1 AND v.unit = 'body' AND ${EDIT_VERSION_SQL}
       UNION ALL
       SELECT e.id::text, e.target_id, (e.payload->>'title'), e.created_at, e.id, false
         FROM domain_events e JOIN content_nodes en ON en.id::text = e.target_id
        WHERE e.workspace_id = $1 AND ${bodyEventSql("e")} AND NOT note_version_in_scope(en.node_type, en.source_type)
     ) s
     JOIN content_nodes n ON n.id::text = s.node_id
     WHERE ${readable}
     ORDER BY s.changed_at DESC, s.tie DESC, s.id DESC
     ${pageSql(page, params)}`,
    params,
  );
  return pageOf(result.rows, page);
}
