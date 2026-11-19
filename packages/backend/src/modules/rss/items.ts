// RSS staging rows as the routes and the save read them (moved from
// routes.ts, depth audit D13): the row shape, the caller's per-person "seen",
// the live-save pointer, and the read gate for one item.

import { personalDataOwnerId } from "../../spine/authority.js";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { readableAmong } from "../../services/readPolicy.js";
import { canReadSource } from "./sources.js";
import { liveNodeSql } from "../../spine/nodeSql.js";

export type StagingRow = {
  id: string;
  subscription_id: string;
  guid: string;
  title: string;
  url: string | null;
  published_at: string | null;
  body: string;
  fetched_at: string;
  seen_at: string | null;
  saved_node_id: string | null;
  tombstoned_at: string | null;
  /** Seen by the CALLER (stagingCols). */
  seen: boolean;
};

// "Seen" is per person (rss_seen, migration 092): one person skimming past an
// item does not hide it from the rest of the lab. rss_staging.seen_at stays the
// stream's own lifecycle (pre-seen backfill, auto-aging) and is the default
// when the person has not marked the item either way.
export function seenSql(actorParam: string): string {
  return `COALESCE((SELECT rs.seen FROM rss_seen rs WHERE rs.staging_id = rss_staging.id AND rs.actor_id = ${actorParam}),
                   rss_staging.seen_at IS NOT NULL)`;
}

/** The saved note, while it is live. A save whose note went to the trash
 *  reads as unsaved (the article can be saved again), and comes back by
 *  itself when the note is restored: the pointer is never cleared. */
export const LIVE_SAVED_SQL = `CASE WHEN EXISTS (SELECT 1 FROM content_nodes sn
    WHERE sn.id = rss_staging.saved_node_id AND ${liveNodeSql("sn")}) THEN rss_staging.saved_node_id END`;

/** Staging columns plus the caller's `seen`; `actorParam` is the SQL
 *  placeholder holding the caller's actor id. */
export function stagingCols(actorParam: string): string {
  return `id, subscription_id, guid, title, url, published_at, body, fetched_at, seen_at, ${LIVE_SAVED_SQL} AS saved_node_id, tombstoned_at,
          ${seenSql(actorParam)} AS seen`;
}

/** `saved_node_id` for a reader: the saved note only if they can read it. The pointer is one per article,
 *  shared by every reader of the source, so a note saved into someone's private space must not hand its id
 *  to the others (they see the article as unsaved, and saving it makes their own note). Returns copies. */
export async function hideUnreadableSaves<T extends { saved_node_id: string | null }>(actor: ActorCtx, workspaceId: string, rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.flatMap((row) => row.saved_node_id ? [row.saved_node_id] : []))];
  if (ids.length === 0) return rows;
  const readable = await readableAmong(actor, workspaceId, ids);
  return rows.map((row) => row.saved_node_id && !readable.has(row.saved_node_id) ? { ...row, saved_node_id: null } : row);
}

export type GatedItem =
  | { ok: true; row: StagingRow }
  | { ok: false; status: 404 | 410; error: string };

/** Readable-gated single staging row: gated THROUGH its subscription (404
 *  outside the read set — no existence leak); 410 for a tombstoned row (aged
 *  out). */
export async function gateItem(actor: ActorCtx, workspaceId: string, id: string): Promise<GatedItem> {
  const r = await q<StagingRow>(
    `SELECT ${stagingCols("$3")} FROM rss_staging WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId, personalDataOwnerId(actor)],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, status: 404, error: "item not found" };
  if (!(await canReadSource(actor, workspaceId, row.subscription_id))) return { ok: false, status: 404, error: "item not found" };
  if (row.tombstoned_at) return { ok: false, status: 410, error: "article aged out of the stream" };
  const [visible] = await hideUnreadableSaves(actor, workspaceId, [row]);
  return { ok: true, row: visible! };
}
