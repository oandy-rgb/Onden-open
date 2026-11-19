// Single-note reads that the /api/nodes/:id/* routes answer verbatim. Each one checks canReadNode itself and
// answers null for a note the actor cannot read — the same as a missing one, so the route's 404 is no existence probe.
import { pool } from "../db.js";
import type { ActorCtx } from "../types.js";
import { shownAuthorKind, shownAuthorName } from "./authorName.js";
import { actorKindOf } from "./history/index.js";
import { canReadNode } from "./readPolicy.js";
import type { ServerNode } from "@onden/contract";
import { nodeRowColumnsSql, nodeEventMetaJoinSql } from "./nodeRowProjection.js";
import { bodyEventSql, inkEventSql } from "./history/index.js";
import type { InkKind } from "@onden/markdown/ink";
import { liveNodeSql } from "../spine/nodeSql.js";
import { readInkValues } from "./inkChunks.js";

/** Saved versions of one of a note's drawings (newest 50). Older saves stored the value inline, hence the COALESCE. */
export async function listInkVersionRows(actor: ActorCtx, workspaceId: string, nodeId: string, kind: InkKind) {
  if (!(await canReadNode(actor, nodeId))) return null;
  const result = await pool.query<{ id: string; ink_data: string | null; value_ref: string | null; changed_at: string; actor_name: string | null; author_row_type: string | null; actor_type: string }>(
    `SELECT e.id, e.payload->>'value' AS ink_data, e.payload->>'value_ref' AS value_ref,
            e.created_at AS changed_at, a.name AS actor_name, a.type AS author_row_type, e.actor_type
       FROM domain_events e
  LEFT JOIN actors a ON a.id::text = e.actor_id
      WHERE e.target_id = $1 AND e.workspace_id = $2
        AND e.event_type = 'ATTRIBUTE_SET'
        AND ${inkEventSql("e", kind)}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 50`,
    [nodeId, workspaceId],
  );
  // The drawing of each save: a `blobs` row or the note's chunks (inkChunks.ts).
  const texts = await readInkValues(workspaceId, nodeId, result.rows.flatMap((r) => (r.value_ref ? [r.value_ref] : [])));
  return result.rows.map(({ value_ref, author_row_type, ...row }) => ({ ...row, actor_name: shownAuthorName(author_row_type, row.actor_name), actor_kind: shownAuthorKind(author_row_type, actorKindOf(row.actor_type)), ink_data: (value_ref ? texts.get(value_ref) : undefined) ?? row.ink_data }));
}

/** Lightweight body-save history of a note (newest 50), derived from the event log. */
export async function listBodyHistoryRows(actor: ActorCtx, workspaceId: string, nodeId: string) {
  if (!(await canReadNode(actor, nodeId))) return null;
  const result = await pool.query(
    `SELECT e.id, (e.payload->>'title') AS title, e.created_at AS changed_at
     FROM domain_events e
     WHERE e.target_id = $1 AND e.workspace_id = $2
       AND ${bodyEventSql("e")}
     ORDER BY e.created_at DESC, e.id DESC LIMIT 50`,
    [nodeId, workspaceId],
  );
  return result.rows;
}

/** Title, slug and markdown of a live note, or null when absent, trashed or unreadable. */
export async function getNoteForExport(actor: ActorCtx, workspaceId: string, nodeId: string) {
  if (!(await canReadNode(actor, nodeId))) return null;
  const row = await pool.query<{ title: string; slug: string; markdown: string }>(
    `SELECT title, slug, markdown FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`,
    [workspaceId, nodeId],
  );
  return row.rows[0] ?? null;
}

/** The store-shaped row of a live note (nodeRowProjection), or null when absent, trashed or unreadable. */
export async function getLiveNodeRow(actor: ActorCtx, workspaceId: string, nodeId: string) {
  if (!(await canReadNode(actor, nodeId))) return null;
  const result = await pool.query<ServerNode>(
    `SELECT ${nodeRowColumnsSql("n")}
     FROM content_nodes n
     ${nodeEventMetaJoinSql("n")}
     WHERE n.workspace_id = $1 AND n.id = $2 AND ${liveNodeSql("n")}`,
    [workspaceId, nodeId],
  );
  return result.rows[0] ?? null;
}

/** A note's own attributes; `keys` null = every key. */
export async function listNodeAttributeRows(actor: ActorCtx, workspaceId: string, nodeId: string, keys: string[] | null) {
  if (!(await canReadNode(actor, nodeId))) return null;
  const result = await pool.query(
    `SELECT key, value, value_type, is_inheritable, source
     FROM node_attributes
     WHERE workspace_id = $1 AND node_id = $2
       AND ($3::text[] IS NULL OR key = ANY($3::text[]))
     ORDER BY source ASC, key ASC`,
    [workspaceId, nodeId, keys],
  );
  return result.rows;
}
