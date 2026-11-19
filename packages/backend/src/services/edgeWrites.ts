// Typed links (node_edges, depth audit D2): creating and removing one, each a
// write on its source node; creating one also needs the target to be readable.

import { q } from "../db.js";
import { mutate } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { canReadNode } from "./readPolicy.js";
import { CodedStatusError, StatusError } from "../statusError.js";

export type EdgeRow = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  status: string;
  /** "manual" for every edge created here (the column default). */
  origin: string;
};

export type NewEdge = {
  id?: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  status: "active" | "suggested" | "rejected";
};

/** Create the link, or update the status of the same (source, target, type)
 *  link. EDGE_CREATED carries `input` as given. */
export async function createEdge(actor: ActorCtx, workspaceId: string, input: NewEdge): Promise<EdgeRow> {
  // The TARGET must be readable too: write_node on the source alone would let anyone with a writable source point
  // an edge at ANY uuid, leaking the existence of (and a reference to) a note they may not read. 404, not 403, so the
  // answer never confirms a hidden note exists (a target that does not exist is caught by the foreign key). Checked
  // here, not in the route, so every caller gets it — a tool that wraps this service included.
  if (!(await canReadNode(actor, input.target_node_id))) throw new StatusError(404, "target not found");
  // Creating an outgoing link is a write on its source node. timing:"after"
  // because the edge id is DB-decided (the upsert may return an existing row).
  return mutate<EdgeRow>({
    actor,
    workspaceId,
    authority: { kind: "node", nodeId: input.source_node_id, op: "write_node" },
    timing: "after",
    event: { type: "EDGE_CREATED", targetType: "edge", targetId: (r) => r.id, payload: input },
    apply: async () => {
      const result = await q<EdgeRow>(
        `INSERT INTO node_edges (id, workspace_id, source_node_id, target_node_id, edge_type, status)
         VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, source_node_id, target_node_id, edge_type, origin)
         DO UPDATE SET status = EXCLUDED.status
         RETURNING *`,
        [input.id ?? null, workspaceId, input.source_node_id, input.target_node_id, input.edge_type, input.status],
      );
      return result.rows[0];
    },
  });
}

/** A derived edge is active and made by the server from content — origin
 *  "wikilink" (a `[[link]]`, services/wikilinkEdges.ts), or any other non-"manual" origin.
 *  Its note's next save re-derives it, so removing it alone would only make
 *  it come back with a new id. The frontend's lib/edgeRoles.ts reads the same
 *  rule (edgeRole "derived"; canDelete / canRetype false). As SQL over
 *  node_edges `e`. */
const DERIVED_EDGE_SQL = (e: string) => `(${e}.status = 'active' AND ${e}.origin <> 'manual')`;

/** Refusal to remove or retype a derived edge. 409 derived_edge. */
export class DerivedEdgeError extends CodedStatusError {
  constructor() {
    super(409, "derived_edge", "This arrow comes from the note's text (a [[link]]). Edit the note to change or remove it.");
  }
}

/** Remove link `id`. Its source (read here, before the write) decides the
 *  authority; the link is read again under the event lock, so one removed or
 *  replaced in between answers 404 "edge not found" and commits nothing (no
 *  EDGE_DELETED for a link that was not there). A manual arrow or a suggestion
 *  (dismissed) may go; a derived edge throws DerivedEdgeError and nothing
 *  changes (no row removed, no event). A retype is a delete and a create, so it
 *  is refused here too. */
export async function deleteEdge(actor: ActorCtx, workspaceId: string, id: string): Promise<void> {
  const found = await q<{ source_node_id: string }>(
    "SELECT source_node_id FROM node_edges WHERE workspace_id = $1 AND id = $2",
    [workspaceId, id],
  );
  const sourceNodeId = found.rows[0]?.source_node_id;
  if (!sourceNodeId) throw new StatusError(404, "edge not found");
  await mutate({
    actor,
    workspaceId,
    // Removing an outgoing link is a write on its source node. Also emits
    // EDGE_DELETED, which the sync delta layer already listens for but never
    // received before (the old handler deleted silently).
    authority: { kind: "node", nodeId: sourceNodeId, op: "write_node" },
    event: { type: "EDGE_DELETED", targetType: "edge", targetId: id },
    apply: async () => {
      // The authority above was judged on the source read before the lock: the
      // link must still be that source's, or a concurrent delete (or a delete
      // and re-create of the same id under another source) would pass it.
      const current = await q<{ source_node_id: string; derived: boolean }>(
        `SELECT e.source_node_id, ${DERIVED_EDGE_SQL("e")} AS derived
           FROM node_edges e WHERE e.workspace_id = $1 AND e.id = $2 FOR UPDATE`,
        [workspaceId, id],
      );
      if (current.rows[0]?.source_node_id !== sourceNodeId) throw new StatusError(404, "edge not found");
      // Checked under the source's write authority, so a reader who may not
      // write the source learns nothing about the edge from a 409.
      if (current.rows[0].derived) throw new DerivedEdgeError();
      await q("DELETE FROM node_edges WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
    },
  });
}
