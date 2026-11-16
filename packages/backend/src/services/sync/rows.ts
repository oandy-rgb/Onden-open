// Edge and pointer rows the sync channels ship, with the bootstrap's endpoint
// rules. Readability is filtered by the callers (delta.ts, membership.ts).

import { q } from "../../db.js";
import { notATaskNodeSql } from "../tasksStore.js";
import { edgeColumnsSql, pointerColumnsSql } from "../syncProjection.js";
import type { NodeEdge, NotePointer } from "@onden/contract";
import { liveNodeSql } from "../../spine/nodeSql.js";
import { SIBLING_ORDER_P } from "../orderKeys.js";

/** Live edges touching `ids`, with the bootstrap's endpoint rule: both ends
 *  alive and neither a task node (bootstrap only returns non-task nodes, so a
 *  delta must not ship edges a cold start never has). Readability is filtered
 *  by the caller. */
export async function edgeRowsTouching(workspaceId: string, ids: string[]): Promise<NodeEdge[]> {
  const { rows } = await q<NodeEdge>(
    `SELECT ${edgeColumnsSql("e")} FROM node_edges e
     JOIN content_nodes s ON s.id = e.source_node_id AND ${liveNodeSql("s")} AND ${notATaskNodeSql("s")}
     JOIN content_nodes t ON t.id = e.target_node_id AND ${liveNodeSql("t")} AND ${notATaskNodeSql("t")}
     WHERE e.workspace_id = $1
       AND (e.source_node_id = ANY($2::uuid[]) OR e.target_node_id = ANY($2::uuid[]))`,
    [workspaceId, ids],
  );
  return rows;
}


/** Pointers placed under or pointing at `ids`, matching the bootstrap's shape and
 *  endpoint rules: a live non-task target, and a live parent unless at the root. */
export async function pointerRowsTouching(workspaceId: string, ids: string[]): Promise<NotePointer[]> {
  const res = await q<NotePointer>(
    `SELECT ${pointerColumnsSql("p")}
     FROM note_pointers p
     JOIN content_nodes t ON t.id = p.target_id AND ${liveNodeSql("t")} AND ${notATaskNodeSql("t")}
     LEFT JOIN content_nodes pa ON pa.id = p.parent_id
     WHERE p.workspace_id = $1
       AND (p.parent_id IS NULL OR (${liveNodeSql("pa")} AND ${notATaskNodeSql("pa")}))
       AND (p.target_id = ANY($2::uuid[]) OR p.parent_id = ANY($2::uuid[]))
     ORDER BY ${SIBLING_ORDER_P}`,
    [workspaceId, ids],
  );
  return res.rows;
}

/** A pointer reveals both endpoints, so both must be readable (root has none). */
export function readablePointer(row: NotePointer, readableSet: Set<string>): boolean {
  return readableSet.has(row.target_id) && (row.parent_id === null || readableSet.has(row.parent_id));
}
