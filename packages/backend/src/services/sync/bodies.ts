// Note bodies for the offline copy (depth audit D8, moved from routes/sync.ts).

import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { readableNodeIdSet, restrictRowsToScope } from "../readPolicy.js";
import { notATaskNodeSql } from "../tasksStore.js";
import { withActorReadSnapshot } from "../actorReadSnapshot.js";
import { SyncRequestTooLarge } from "./membership.js";
import { liveNodeSql } from "../../spine/nodeSql.js";

// Offline copy for large workspaces: a slim session downloads note bodies in
// the background into the device's local database (never the in-memory store),
// so notes it never opened can still be read offline. Read-gated like every
// node read; deleted, unreadable and task nodes are simply absent.
export const MAX_BODY_IDS = 200;

/** Bodies of the readable, live, non-task notes among `ids` (others are
 *  absent). Throws SyncRequestTooLarge above MAX_BODY_IDS — checked before
 *  the actor is re-read, as the route always did; no ids answer at once. */
export async function bodiesFor(authenticated: ActorCtx | null, workspaceId: string, ids: string[]): Promise<{ bodies: Array<{ id: string; markdown: string; updated_at: string }> }> {
  if (ids.length > MAX_BODY_IDS) throw new SyncRequestTooLarge(MAX_BODY_IDS);
  if (ids.length === 0) return { bodies: [] };
  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    const readableSet = await readableNodeIdSet(actor, workspaceId);
    const res = await q<{ id: string; markdown: string; updated_at: string }>(
      `SELECT n.id, n.markdown, n.updated_at
       FROM content_nodes n
       WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[]) AND ${liveNodeSql("n")}
         AND ${notATaskNodeSql("n")}`,
      [workspaceId, ids],
    );
    return { bodies: restrictRowsToScope(res.rows, (r) => r.id, readableSet) };
  });
}
