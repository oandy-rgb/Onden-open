// Single-note reads that the /api/nodes/:id/* routes answer verbatim. Each one checks canReadNode itself and
// answers null for a note the actor cannot read — the same as a missing one, so the route's 404 is no existence probe.
import { pool } from "../db.js";
import type { ActorCtx } from "../types.js";
import { shownAuthorKind, shownAuthorName } from "./authorName.js";
import { actorKindOf } from "./history/index.js";
import { canReadNode } from "./readPolicy.js";
import type { ServerNode } from "@onden/contract";
import { nodeRowColumnsSql, nodeEventMetaJoinSql } from "./nodeRowProjection.js";
import { STATE_VERSION_SQL, bodyEventSql } from "./history/index.js";
import { hasVersionList } from "../spine/noteVersions.js";
import { AUTHOR_REF, VERSION_ORDER_DESC, authorColumns, listBodyVersionHeads } from "./history/index.js";
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { INK_KIND_ATTR, type InkKind } from "@onden/markdown/ink";
import { liveNodeSql } from "../spine/nodeSql.js";
import { readInkValues } from "./inkChunks.js";

/** Saved versions of one of a note's drawings (newest 50): the versions of its drawing unit, one row per version (a save that only repeated the drawing has none). */
export async function listInkVersionRows(actor: ActorCtx, workspaceId: string, nodeId: string, kind: InkKind) {
  if (!(await canReadNode(actor, nodeId))) return null;
  const unit = INK_KIND_ATTR[kind];
  const rows = (await sql<{ id: string; value_ref: string; changed_at: Date; actor_name: string | null; row_type: string | null; author_kind: string }>`
    SELECT v.version_key AS id, v.content_hash AS value_ref, v.at::timestamptz AS changed_at, a.name AS actor_name, a.type AS row_type, v.author_kind
      FROM note_versions v LEFT JOIN actors a ON a.id::text = ${AUTHOR_REF}
     WHERE v.note_id = ${nodeId}::uuid AND v.workspace_id = ${workspaceId}::uuid AND v.unit = ${unit} AND ${sql.raw(STATE_VERSION_SQL)} AND v.kind <> 'removed'
     ORDER BY ${VERSION_ORDER_DESC} LIMIT 50`.execute(db)).rows;
  // The drawing of each version: a `blobs` row or the note's chunks (inkChunks.ts).
  const texts = await readInkValues(workspaceId, nodeId, rows.map((r) => r.value_ref));
  return rows.map(({ value_ref, author_kind, row_type, ...row }) => {
    const { actor_type, author_row_type: kindRow } = authorColumns(author_kind);
    const author_row_type = row_type ?? kindRow;
    return { ...row, actor_type, actor_name: shownAuthorName(author_row_type, row.actor_name), actor_kind: shownAuthorKind(author_row_type, actorKindOf(actor_type)), ink_data: texts.get(value_ref) };
  });
}

/** Lightweight body-save history of a note (newest 50): its versions (a system note: its saves). */
export async function listBodyHistoryRows(actor: ActorCtx, workspaceId: string, nodeId: string) {
  if (!(await canReadNode(actor, nodeId))) return null;
  if (await hasVersionList(workspaceId, nodeId)) {
    return await listBodyVersionHeads(workspaceId, nodeId, 50);
  }
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
