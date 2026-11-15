// Whiteboard rows for routes/canvases.ts: which canvases exist and which of
// them a reader may see. The route parses, calls these and answers.

import { pool } from "../db.js";
import type { ActorCtx } from "../types.js";
import { whiteboardNoteSql } from "./boardStore.js";
import { canReadNode, readableScopeSql } from "./readPolicy.js";
import { liveNodeSql } from "../spine/nodeSql.js";

export type CanvasRow = { id: string; title: string; created_at: string; updated_at: string };

/** The canvases `actor` may read, newest edit first. A canvas IS a node (mig
 *  057), so the listing is bounded by the caller's combined read set (role/tag
 *  policy ∩ bearer-token tag scope): a restricted canvas does not even appear. */
export async function listReadableCanvases(actor: ActorCtx | null, workspaceId: string): Promise<CanvasRow[]> {
  const params: unknown[] = [workspaceId];
  const scope = readableScopeSql(actor, "n", params);
  const result = await pool.query<CanvasRow>(
    `SELECT n.id, n.title, n.created_at, n.updated_at FROM content_nodes n
      WHERE n.workspace_id = $1 AND ${whiteboardNoteSql("n")} AND ${liveNodeSql("n")} AND ${scope}
      ORDER BY n.updated_at DESC`,
    params,
  );
  return result.rows;
}

/** Whether live canvas `id` exists. For writes, which assert their own authority
 *  afterwards; nothing of the row is served. */
export async function canvasExists(workspaceId: string, id: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM content_nodes
      WHERE id = $1 AND workspace_id = $2 AND ${liveNodeSql()} AND ${whiteboardNoteSql("content_nodes")}`,
    [id, workspaceId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Canvas `id`, or null when it is missing or `actor` cannot read it: an
 *  unreadable canvas is indistinguishable from a missing one. */
export async function readCanvas(actor: ActorCtx, workspaceId: string, id: string): Promise<CanvasRow | null> {
  const r = await pool.query<CanvasRow>(
    `SELECT id, title, created_at, updated_at FROM content_nodes
      WHERE id = $1 AND workspace_id = $2 AND ${liveNodeSql()} AND ${whiteboardNoteSql("content_nodes")}`,
    [id, workspaceId],
  );
  const row = r.rows[0];
  if (!row || !(await canReadNode(actor, id))) return null;
  return row;
}
