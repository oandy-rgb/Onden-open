// Walks over the content tree (content_nodes.parent_id) — the one place that
// walks it, so every caller gets the same cycle safety and the same meaning
// for "live", "root" and "depth".
//
// Both walks return ids only; the caller already holds (or still has to make)
// the read or write decision for what it does with them. Nothing here applies
// read policy: a subtree id list is not something to serve as-is.
//
// Cycle safety. parent_id is single-valued, so the nodes reachable DOWNWARD
// from a root form a tree unless the walk comes back to the root itself (the
// root is the only node not entered through its own parent). Refusing to
// re-enter the root therefore bounds every subtree walk even when bad data
// holds a parent_id cycle. The upward walk dedups on (id, parent_id), which
// ends at the first repeated node.
//
// It also holds the one set of rules for giving a node a new parent
// (assertReparent): every path that moves a node — a PATCH, a tag merge's
// child moves, an undo — asks it, so they cannot drift apart again (depth
// audit D102). The writes stay with their owners (test/reparentOwner.test.ts).

import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { canPlaceUnder } from "./nodePlacement.js";
import { assertModuleTagEdge, assertParentKind } from "./parentKind.js";
import { assertTagNameAvailable } from "./tagHierarchy.js";
import { assertFieldChangeAllowed } from "./tagFields.js";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

import { liveNodeSql, notTagNodeSql } from "../spine/nodeSql.js";
export type SubtreeOptions = {
  /** "live": trashed nodes are left out, and so is everything below them.
   *  "all": trashed nodes are walked too (a space move takes them along). */
  lifecycle: "live" | "all";
  /** Put the root itself first in the result. Default false: descendants only. */
  includeRoot?: boolean;
  /** Do not enter tag definitions (class_tag) or anything below them. Tags
   *  are global and never move with a note. Default false. */
  skipTagDefinitions?: boolean;
  /** Only nodes at most this many levels below the root. Default unbounded
   *  (the walk still ends: see the cycle note above). */
  maxDepth?: number;
};

/** Ids of the subtree under `rootId`, nearest first (by depth, then id; the
 *  root first when included).
 *
 *  The root goes through the same filters as its descendants: a root outside
 *  the workspace, trashed under `lifecycle: "live"`, or a tag definition under
 *  `skipTagDefinitions` gives []. A caller that trashes the root should walk
 *  BEFORE stamping it.
 *
 *  Example: everything that leaves with a note when it moves space —
 *    subtreeIds(ws, noteId, { lifecycle: "all", includeRoot: true, skipTagDefinitions: true }) */
export async function subtreeIds(workspaceId: string, rootId: string, opts: SubtreeOptions): Promise<string[]> {
  const params: unknown[] = [workspaceId, rootId];
  const filters = (alias: string): string => [
    opts.lifecycle === "live" ? `AND ${liveNodeSql(alias)}` : "",
    opts.skipTagDefinitions ? `AND ${notTagNodeSql(alias)}` : "",
  ].join(" ");
  let depthBound = "";
  if (opts.maxDepth !== undefined) {
    params.push(opts.maxDepth);
    depthBound = `AND s.depth < $${params.length}`;
  }
  const r = await q<{ id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT r.id, 0 AS depth FROM content_nodes r
        WHERE r.workspace_id = $1 AND r.id = $2 ${filters("r")}
       UNION ALL
       SELECT c.id, s.depth + 1 FROM content_nodes c
         JOIN subtree s ON c.parent_id = s.id
        WHERE c.workspace_id = $1 AND c.id <> $2 ${filters("c")} ${depthBound}
     )
     SELECT id::text FROM subtree ${opts.includeRoot ? "" : "WHERE depth > 0"} ORDER BY subtree.depth, subtree.id`,
    params,
  );
  return r.rows.map((row) => row.id);
}

/** Ids above `nodeId`, nearest (its parent) first, trashed or not; [] for a
 *  root or a node outside the workspace. Ends at the first repeated node when
 *  bad data holds a parent_id cycle. */
export async function ancestorIds(workspaceId: string, nodeId: string): Promise<string[]> {
  const r = await q<{ id: string }>(
    `WITH RECURSIVE up AS (
       SELECT c.parent_id AS id, ARRAY[c.id] AS path FROM content_nodes c
        WHERE c.workspace_id = $1 AND c.id = $2 AND c.parent_id IS NOT NULL
       UNION ALL
       SELECT n.parent_id, up.path || n.id FROM up
         JOIN content_nodes n ON n.id = up.id AND n.workspace_id = $1
        WHERE n.parent_id IS NOT NULL AND NOT n.parent_id = ANY(up.path || n.id)
     )
     SELECT up.id::text FROM up
       JOIN content_nodes p ON p.id = up.id AND p.workspace_id = $1
      ORDER BY cardinality(up.path)`,
    [workspaceId, nodeId],
  );
  return r.rows.map((row) => row.id);
}

/** Would giving `nodeId` the parent `newParentId` create a parent_id cycle?
 *  True when the new parent is the node itself or one of its descendants,
 *  trashed or not (a trashed descendant can come back). Callers check this
 *  only when the parent actually changes to a non-null value. */
export async function wouldCreateParentCycle(workspaceId: string, nodeId: string, newParentId: string): Promise<boolean> {
  const r = await q(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id FROM content_nodes WHERE workspace_id = $1 AND id = $2
       UNION
       SELECT n.id, n.parent_id FROM content_nodes n
         JOIN ancestors a ON n.id = a.parent_id AND n.workspace_id = $1
     )
     SELECT 1 FROM ancestors WHERE id = $3 LIMIT 1`,
    [workspaceId, newParentId, nodeId],
  );
  return r.rows.length > 0;
}

/** A reparent refused by a rule of the tree itself. The other refusals keep
 *  their own errors: ParentKindError (409 parent_kind_mismatch),
 *  TagNameConflictError (409 tag_name_conflict), FieldNameClashError (409
 *  field_name_inherited) and the authority errors (403). */
export class ReparentError extends Error {
  constructor(
    readonly code: "parent_not_found" | "parent_cycle" | "parent_in_other_space",
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ReparentError";
  }
}

/** The node being moved, as stored now — except `title`, the name it will
 *  have (a tag renamed in the same save is judged under its new name). */
export type ReparentNode = { id: string; node_type: string; title: string; parent_id: string | null };

/** Every rule for giving `node` the parent `nextParentId` (null: the root).
 *  The one gate for every path that moves a node: nodeUpdate (PATCH, agent),
 *  tagMerge (#source's child tags) and eventRestore (undoing a move). Only a
 *  CHANGED parent is judged, so a row that already breaks a rule keeps
 *  saving. In order:
 *    1. placement — the new parent is a live node the actor can read (else
 *       ReparentError parent_not_found, 404, no existence probe) and write
 *       (else the authority error, 403): services/nodePlacement.ts;
 *    2. space — a note stays in its parent's space; a parent in another
 *       space is a space move (POST /api/spaces/move): parent_in_other_space;
 *    3. kind — the tag tree and the note tree are separate (parentKind.ts);
 *    4. cycle — never under itself or its own descendant: parent_cycle;
 *    5. tag name — a tag's name is free under its new parent;
 *    6. field clash — a tag does not come to declare a field its new
 *       ancestors already give (D93; only clashes the move creates).
 *  Call under the event lock with the current actor, before writing.
 *
 *    await assertReparent(ws, { id, node_type, title, parent_id }, nextParentId, actor) */
export async function assertReparent(
  workspaceId: string, node: ReparentNode, nextParentId: string | null, actor: ActorCtx,
): Promise<void> {
  if (nextParentId === (node.parent_id ?? null)) return;
  const isTag = node.node_type === TAG_NODE_TYPE;
  if (nextParentId !== null) {
    if (nextParentId === node.id) throw new ReparentError("parent_cycle", 400, "cannot move a node under its own descendant");
    if (!(await canPlaceUnder(actor, workspaceId, nextParentId))) throw new ReparentError("parent_not_found", 404, "parent not found");
    const spaces = (await q<{ mine: string | null; theirs: string | null; parent_type: string }>(
      `SELECT n.space_id::text AS mine, p.space_id::text AS theirs, p.node_type AS parent_type
         FROM content_nodes n, content_nodes p WHERE n.id = $1 AND p.id = $2`,
      [node.id, nextParentId],
    )).rows[0];
    // Tags are global: neither end of a tag move has a space to keep.
    if (spaces && !isTag && spaces.parent_type !== TAG_NODE_TYPE && spaces.mine !== spaces.theirs) {
      throw new ReparentError("parent_in_other_space", 409, "parent_in_other_space");
    }
    await assertParentKind(workspaceId, node.node_type, nextParentId);
    if (isTag) await assertModuleTagEdge(workspaceId, { id: node.id }, nextParentId);
    if (await wouldCreateParentCycle(workspaceId, node.id, nextParentId)) {
      throw new ReparentError("parent_cycle", 400, "cannot move a node under its own descendant");
    }
  }
  if (isTag) {
    await assertTagNameAvailable(workspaceId, node.id, { title: node.title, parentId: nextParentId });
    await assertFieldChangeAllowed(workspaceId, new Map([[node.id, { parent_id: nextParentId }]]));
  }
}
