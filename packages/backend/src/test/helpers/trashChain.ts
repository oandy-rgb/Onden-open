// The judgement of "deleted together" that main made before history batch 5 (docs/architecture/proposals/history-replication-2026-11-22.md §7):
// the notes whose own delete is chained (triggered_by) to the delete that holds `nodeId`, in delete order. It reads this node's event log,
// which another node does not have; services/nodeTrash.ts restorePlan no longer uses it. Kept here only as the reference the tests compare the
// new judgement with on ONE node (trashGroups.integration.test.ts, properties/deletedTogether.property.integration.test.ts), and word for
// word the query migration 230 builds its groups from.
import { randomUUID } from "node:crypto";
import { q } from "../../db.js";
import { restorePlan } from "../../services/nodeTrash.js";

export async function chainedTogether(workspaceId: string, nodeId: string): Promise<string[]> {
  return (await q<{ id: string }>(
    `SELECT n.id::text FROM content_nodes root
       JOIN domain_events e ON e.triggered_by_event_id = root.deleted_by_event_id
                           AND e.event_type = 'NODE_DELETED'
       JOIN content_nodes n ON n.deleted_by_event_id = e.id AND n.workspace_id = root.workspace_id
      WHERE root.workspace_id = $1 AND root.id = $2 AND root.deleted_at IS NOT NULL
        AND n.deleted_at IS NOT NULL AND n.id <> root.id
      ORDER BY e.id`,
    [workspaceId, nodeId],
  )).rows.map((row) => row.id);
}

/** What restorePlan says comes back with the deleted `id` (the new judgement), as ids. */
export const togetherIds = async (workspaceId: string, id: string): Promise<string[]> => (await restorePlan(workspaceId, id)).subtree.map((row) => row.id);

/** Whether each of `ids` is in the trash. */
export const trashedStates = async (ids: string[]): Promise<Record<string, boolean>> => Object.fromEntries((await q<{ id: string; deleted: boolean }>(
  `SELECT id::text, deleted_at IS NOT NULL AS deleted FROM content_nodes WHERE id = ANY($1::uuid[])`, [ids])).rows.map((row) => [row.id, row.deleted]));

/** A note made through the route, as a person makes one (a unique title: a slug must stay unique in its space). */
export const routeNote = (call: (method: string, path: string, body?: unknown) => Promise<any>, space: string, title: string, parent?: string): Promise<string> =>
  call("POST", "/api/nodes", { id: randomUUID(), title: `${title} ${randomUUID().slice(0, 6)}`, markdown: title, space_id: space, ...(parent ? { parent_id: parent } : {}) })
    .then((r: { id: string }) => r.id);
