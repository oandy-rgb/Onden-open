// The RSS reading list (GET /api/rss/items, no bodies; the reader fetches one
// article at a time). Continuation-paged: ordered by COALESCE(published_at,
// fetched_at) DESC, cursor = "<ts>~<id>" of the last row. IRON LAW: scoped to
// readable source ids in SQL.

import { personalDataOwnerId } from "../../spine/authority.js";
import { isUuid } from "@onden/markdown";
import { pool, q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { notMutedSql } from "./mutes.js";
import { hideUnreadableSaves, stagingCols, type StagingRow } from "./items.js";
import type { SourceVoice } from "./sources.js";
import { readableSourceIds } from "./subscriptions.js";

export type ItemListRequest = { sourceId?: string; /** Only the feeds of this voice (「聲音」: the people). */ voice?: SourceVoice; limit: number; cursor?: string };
export type ItemList = { rows: StagingRow[]; nextCursor: string | null } | { badCursor: true };

export async function listStagedItems(actor: ActorCtx | null, workspaceId: string, req: ItemListRequest): Promise<ItemList> {
  let sourceIds = await readableSourceIds(actor, workspaceId, req.voice);
  if (req.sourceId) sourceIds = sourceIds.filter((id) => id === req.sourceId);
  if (sourceIds.length === 0) return { rows: [], nextCursor: null };

  const params: unknown[] = [workspaceId, sourceIds, actor ? personalDataOwnerId(actor) : ""];
  let cursorClause = "";
  if (req.cursor) {
    const sep = req.cursor.lastIndexOf("~");
    const ts = sep > 0 ? req.cursor.slice(0, sep) : "";
    const id = sep > 0 ? req.cursor.slice(sep + 1) : "";
    if (Number.isNaN(Date.parse(ts)) || !isUuid(id)) return { badCursor: true };
    params.push(ts, id);
    cursorClause = ` AND (COALESCE(published_at, fetched_at), id) < ($4::timestamptz, $5::uuid)`;
  }

  const r = await pool.query<StagingRow>(
    `SELECT ${stagingCols("$3")} FROM rss_staging
      WHERE workspace_id = $1 AND subscription_id = ANY($2::uuid[])
        AND tombstoned_at IS NULL AND ${notMutedSql("$3")}${cursorClause}
      ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
      LIMIT $${params.push(req.limit + 1)}`,
    params,
  );
  const rows = actor ? await hideUnreadableSaves(actor, workspaceId, r.rows.slice(0, req.limit)) : r.rows.slice(0, req.limit);
  const last = rows[rows.length - 1];
  const nextCursor = r.rows.length > req.limit && last
    ? `${new Date(last.published_at ?? last.fetched_at).toISOString()}~${last.id}`
    : null;
  return { rows, nextCursor };
}
