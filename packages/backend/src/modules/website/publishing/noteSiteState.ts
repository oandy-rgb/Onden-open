// Where one note stands on the published site, for the note's own Share menu:
// is it there, and would a publish change what readers see of it. Built from
// the same pieces as the publish preview (the latest snapshot, the candidate's
// frozen notes, siteDiff's reader view), for one note instead of the site.

import { q } from "../../../db.js";
import { candidateNote } from "./snapshot.js";
import { noteViewChanged, type PayloadEdge, type PayloadNode } from "./siteDiff.js";
import type { ActorCtx } from "../../../types.js";

export type NoteSiteState = "not_on_site" | "outdated" | "current";

/** The latest snapshot's copy of `nodeId` with the ids of its pages and the
 *  edges the note is an end of, cut down in the database (the payload of a
 *  large site is tens of MB). Null: the latest snapshot does not carry the note. */
async function storedNote(workspaceId: string, nodeId: string) {
  const row = (await q<{ node: PayloadNode | null; ids: string[]; edges: PayloadEdge[] }>(
    `WITH latest AS (SELECT payload FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1)
     SELECT (SELECT n FROM jsonb_array_elements(coalesce(l.payload->'nodes', '[]'::jsonb)) n WHERE n->>'id' = $2 AND NOT (coalesce(l.payload->'taken_down', '[]'::jsonb) @> to_jsonb($2::text)) LIMIT 1) AS node,
            ARRAY(SELECT n->>'id' FROM jsonb_array_elements(coalesce(l.payload->'nodes', '[]'::jsonb)) n) AS ids,
            ARRAY(SELECT e FROM jsonb_array_elements(coalesce(l.payload->'edges', '[]'::jsonb)) e
                   WHERE e->>'source_node_id' = $2 OR e->>'target_node_id' = $2) AS edges
       FROM latest l`,
    [workspaceId, nodeId],
  )).rows[0];
  return row?.node ? { node: row.node, ids: new Set(row.ids), edges: row.edges } : null;
}

/** `not_on_site`: readers can't open the note now (not in the served site:
 *  never published, marked after the last Publish, or taken down since — even if it qualifies again: it returns with the next Publish, takenDown.ts).
 *  `outdated`: it is there, and a publish would show them something different.
 *  `current`: the site has the note as a publish would make it. `actor`
 *  evaluates the note's query blocks, as the publish would. */
export async function noteSiteState(workspaceId: string, nodeId: string, actor: ActorCtx | null): Promise<NoteSiteState> {
  // On the site now means in the snapshot AND still published (candidateNote
  // is null for a note outside the published set).
  const stored = await storedNote(workspaceId, nodeId);
  if (!stored) return "not_on_site";
  const next = await candidateNote(workspaceId, nodeId, actor);
  if (!next) return "not_on_site";
  return noteViewChanged(stored, next) ? "outdated" : "current";
}
