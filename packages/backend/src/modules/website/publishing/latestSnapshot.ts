// The one place the latest publish snapshot is read for a question about its
// notes, so "which snapshot is the site" and "what was taken down since" are
// written once (the whole-site read, servedSite.loadServedSite, cuts the same
// snapshot down to the served notes itself). Guarded by
// test/guards/publishSnapshotReads.guard.test.ts.

import { sql, type RawBuilder } from "kysely";
import { db } from "../../../dbKysely.js";
import type { PayloadEdge, PayloadNode } from "./siteDiff.js";

/** The latest snapshot of `workspaceId` as a one-row source (`id`, `payload`; no row when never published):
 *  `FROM ${latestSnapshotRow(ws)} p`. */
export function latestSnapshotRow(workspaceId: string): RawBuilder<unknown> {
  return sql`(SELECT id, payload FROM publish_snapshots WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC LIMIT 1)`;
}

/** Its payload alone, as a scalar. */
export function latestSnapshotPayload(workspaceId: string): RawBuilder<unknown> {
  return sql`(SELECT payload FROM ${latestSnapshotRow(workspaceId)} l)`;
}

/** The latest snapshot's copy of `nodeId` with the ids of its pages and the
 *  edges the note is an end of, cut down in the database (the payload of a
 *  large site is tens of MB). Null: the latest snapshot does not carry the
 *  note, or it was taken down since (takenDown.ts). What a note's address
 *  (servedSite.publishedUrlFor) and its site status (noteSiteState) both read. */
export async function storedNote(workspaceId: string, nodeId: string) {
  const row = (await sql<{ node: PayloadNode | null; ids: string[]; edges: PayloadEdge[] }>`
    WITH latest AS (SELECT ${latestSnapshotPayload(workspaceId)} AS payload)
    SELECT (SELECT n FROM jsonb_array_elements(coalesce(l.payload->'nodes', '[]'::jsonb)) n
             WHERE n->>'id' = ${nodeId} AND NOT (coalesce(l.payload->'taken_down', '[]'::jsonb) @> to_jsonb(${nodeId}::text)) LIMIT 1) AS node,
           ARRAY(SELECT n->>'id' FROM jsonb_array_elements(coalesce(l.payload->'nodes', '[]'::jsonb)) n) AS ids,
           ARRAY(SELECT e FROM jsonb_array_elements(coalesce(l.payload->'edges', '[]'::jsonb)) e
                  WHERE e->>'source_node_id' = ${nodeId} OR e->>'target_node_id' = ${nodeId}) AS edges
      FROM latest l`.execute(db)).rows[0];
  return row?.node ? { node: row.node, ids: new Set(row.ids), edges: row.edges } : null;
}
