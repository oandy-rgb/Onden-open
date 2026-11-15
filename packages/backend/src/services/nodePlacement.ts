import { q } from "../db.js";
import { assertAuthority } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { canReadNode } from "./readPolicy.js";
import { liveNodeSql } from "../spine/nodeSql.js";

/** The one rule for putting a node under `parentId` — creating it there,
 *  moving it there, importing into it, saving an RSS article under its source,
 *  or an agent nesting a note: the parent must be a live node of this workspace
 *  that the actor can both READ and WRITE.
 *
 *    await withEventTransaction(ws, async () => {
 *      const actor = await resolveCurrentActor(authenticated, ws);
 *      if (!(await canPlaceUnder(actor, ws, parentId))) return notFound();
 *      ...
 *    });
 *
 *  Call inside the event lock with the CURRENT actor, so a role or policy
 *  change cannot slip between the check and the write. Returns false when the
 *  parent is absent, deleted or unreadable: callers answer as for any unreadable
 *  reference (404), never revealing whether it exists. Throws AuthorityError /
 *  ScopeError (403) when the parent is readable but not writable. */
export async function canPlaceUnder(actor: ActorCtx, workspaceId: string, parentId: string): Promise<boolean> {
  const live = await q(
    `SELECT 1 FROM content_nodes WHERE id = $1 AND workspace_id = $2 AND ${liveNodeSql()}`,
    [parentId, workspaceId],
  );
  if (!live.rows[0] || !(await canReadNode(actor, parentId))) return false;
  await assertAuthority(actor, { kind: "node", nodeId: parentId, op: "write_node" });
  return true;
}
