// Promote an inbox item into the graph (POST /api/nodes/:id/promote, moved
// from routes/nodes.ts, depth audit D2): it stops being hidden.

import { withViews } from "./functionRefs.js";
import { pool, q } from "../db.js";
import { mutate, requireActor } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";

/** Un-hide node `id` (write_node on it; NODE_PROMOTED, a visibility change)
 *  and return its row. Null when no node has that id — checked before the
 *  actor is required, as the route always did. */
export async function promoteNode(authenticated: ActorCtx | null, workspaceId: string, id: string): Promise<Record<string, unknown> | null> {
  const exists = await pool.query(`SELECT id FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, id]);
  if (!exists.rows[0]) return null;
  const actor = requireActor(authenticated);
  return mutate<Record<string, unknown>>({
    actor,
    workspaceId,
    authority: { kind: "node", nodeId: id, op: "write_node" },
    visibilityChanged: [id],
    event: { type: "NODE_PROMOTED", targetType: "node", targetId: id, payload: {} },
    apply: async () => {
      const result = await q<Record<string, unknown>>(
        `UPDATE content_nodes SET hidden = false, updated_at = now()
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [workspaceId, id],
      );
      return result.rows[0] ? await withViews(workspaceId, result.rows[0] as { id: string; node_type: string }) : result.rows[0];
    },
  });
}
