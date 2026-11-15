import { q } from "../db.js";
import { whiteboardShownSql } from "./boardStore.js";
import type { CanvasMembership } from "@onden/contract";
import { liveNodeSql, notTagNodeSql } from "../spine/nodeSql.js";

// Flatten canvas membership for the "Appears on canvases" backlink panel.
// Membership IS the node_positions table: a row whose surface is a live note
// that still shows its 白板 (boardStore whiteboardShownSql: the tab is not
// hidden). A tag's own board (surface = tag id) and the graph layout (surface
// is not a note id) are left out. The rows outlive the tab: hiding the 白板
// only stops listing them, showing it again brings the layout back. (The old flatten
// walked canvases.data.nodes JSONB looking for 'node_id' — but the frontend
// writes 'nodeId', so it matched nothing; deriving from the real placement
// table fixes the panel as a side effect.)
export async function getCanvasMemberships(
  workspaceId: string,
  visibleNodeIds: string[],
): Promise<CanvasMembership[]> {
  const res = await q<CanvasMembership>(
    `SELECT c.id AS canvas_id, c.title AS canvas_title, np.node_id::text AS node_id
       FROM node_positions np
       JOIN content_nodes c
         ON c.id::text = np.surface
        AND c.workspace_id = np.workspace_id
        AND ${notTagNodeSql("c")} AND ${liveNodeSql("c")}
        AND ${whiteboardShownSql("c")}
      WHERE np.workspace_id = $1
        AND np.node_id = ANY($2::uuid[])
        -- MB2: BOTH endpoints must be visible. The caller passes its
        -- returned/visible node set; a restricted CANVAS is absent from it,
        -- so its id+title must not ride out on a readable member node.
        AND c.id = ANY($2::uuid[])`,
    [workspaceId, visibleNodeIds],
  );
  return res.rows;
}

/** The sync delta's membership channel (D98): every membership whose note OR
 *  canvas is one of `scope` (the readable nodes the delta ships), with both
 *  ends in `readable` and the note live. The client treats the result as
 *  complete for `scope` (`replace_for`): a held membership touching a scoped
 *  id and absent here is gone — the note left the board, or one end is no
 *  longer readable. A layout change re-ships its canvas node (CANVAS_UPDATED
 *  targets it, services/sync/delta.ts), so a note dropped on a board or taken
 *  off it reaches other devices with the next delta; so does
 *  hiding or showing the board's 白板 tab (COLLECTION_VIEW_* targets the note). */
export async function canvasMembershipsTouching(
  workspaceId: string,
  scope: string[],
  readable: ReadonlySet<string>,
): Promise<CanvasMembership[]> {
  if (scope.length === 0) return [];
  const res = await q<CanvasMembership>(
    `SELECT c.id::text AS canvas_id, c.title AS canvas_title, np.node_id::text AS node_id
       FROM node_positions np
       JOIN content_nodes c
         ON c.id::text = np.surface
        AND c.workspace_id = np.workspace_id
        AND ${notTagNodeSql("c")} AND ${liveNodeSql("c")}
        AND ${whiteboardShownSql("c")}
       JOIN content_nodes n ON n.id = np.node_id AND ${liveNodeSql("n")}
      WHERE np.workspace_id = $1
        AND (np.node_id = ANY($2::uuid[]) OR c.id = ANY($2::uuid[]))`,
    [workspaceId, scope],
  );
  return res.rows.filter((row) => readable.has(row.canvas_id) && readable.has(row.node_id));
}
