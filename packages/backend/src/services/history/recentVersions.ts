// The "recently changed" feed across the workspace. Derived from the event log:
// each body-changing event (carrying body_hash) is a version. (The CoW
// content_node_versions table + trigger were retired in migration 053.)

import { pool } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { type PageInput, pageOf, pageSql } from "../paging.js";
import { bodyEventSql } from "./bodyEvents.js";
import { readableNotesSql } from "./readableNotes.js";
import type { Page } from "@onden/contract";

/** One page of recent versions of the notes `actor` may read, newest first.
 *  This feed exposes every node's title/slug, so it is bounded by the combined
 *  read set (role/tag policy ∩ token and matter scope). The clause is pushed
 *  into SQL BEFORE the LIMIT: filtering a fetched page in JS let restricted
 *  versions use up the page and return short or empty lists. */
export async function recentVersions(actor: ActorCtx, workspaceId: string, page: PageInput): Promise<Page<{ node_id: string }>> {
  const params: unknown[] = [workspaceId];
  const readable = await readableNotesSql(actor, workspaceId, "n", params);
  const result = await pool.query<{ node_id: string }>(
    `SELECT e.id, e.target_id AS node_id, (e.payload->>'title') AS title,
            e.created_at AS changed_at, n.title AS current_title, n.slug
     FROM domain_events e
     JOIN content_nodes n ON n.id::text = e.target_id
     WHERE e.workspace_id = $1
       AND ${bodyEventSql("e")}
       AND ${readable}
     ORDER BY e.created_at DESC, e.id DESC
     ${pageSql(page, params)}`,
    params,
  );
  return pageOf(result.rows, page);
}
