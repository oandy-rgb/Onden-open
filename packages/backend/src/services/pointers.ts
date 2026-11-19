// Sidebar pointers (note_pointers, depth audit D2): adding and removing one,
// each an audited mutate(). routes/pointers.ts keeps the read gates.

import { q } from "../db.js";
import { mutate } from "../spine/mutate.js";
import type { Authority } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { StatusError } from "../statusError.js";
import { appendOrderKey, assertOrderKey, respaceIfTooLong, translateLegacySortOrder } from "./orderKeys.js";
import { assertModuleTagEdge, assertParentKind } from "./parentKind.js";
import { isTag } from "@onden/markdown/contract";

/** Place `targetId` under `parentId` (null = top level). A pointer already at
 *  this (parent, target) throws the unique violation (code 23505). A parent of
 *  the wrong kind — a note pinned under a tag, or a tag under a note — throws
 *  ParentKindError (409 parent_kind_mismatch), as every other write of a new
 *  parent does (services/parentKind.ts): a note pinned under a tag was never
 *  shown, since tags are not in the notes tree (depth audit D101). Unlike a
 *  move, a pointer may sit in another space or under the target's own
 *  descendant: the target itself stays where it is. */
export async function createPointer(
  actor: ActorCtx, workspaceId: string,
  p: { targetId: string; parentId: string | null; orderKey?: string; legacySortOrder?: number; displayPrefix?: string },
): Promise<{ id: string }> {
  return mutate<{ id: string }>({
    actor,
    workspaceId,
    authority: pointerAuthority(p.parentId, p.targetId),
    event: {
      type: "POINTER_CREATED",
      targetType: "node",
      targetId: p.targetId,
      payload: { parent_id: p.parentId },
    },
    apply: async () => {
      // Under the event lock, in the event's transaction: a refusal commits
      // neither the row nor POINTER_CREATED.
      const target = (await q<{ node_type: string }>(
        `SELECT node_type FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, p.targetId],
      )).rows[0];
      if (target) {
        await assertParentKind(workspaceId, target.node_type, p.parentId);
        if (isTag(target)) await assertModuleTagEdge(workspaceId, { id: p.targetId }, p.parentId);
      }
      // The place among the parent's pointers: the key the caller chose, an older client's integer translated, or last.
      // A pointer's id is derived from (parent, target) by the database, so translation excludes no row of its own.
      let orderKey: string;
      if (p.orderKey !== undefined) { assertOrderKey(p.orderKey); orderKey = p.orderKey; }
      else if (p.legacySortOrder !== undefined) orderKey = await translateLegacySortOrder("note_pointers", workspaceId, p.parentId, "00000000-0000-0000-0000-000000000000", p.legacySortOrder);
      else orderKey = await appendOrderKey("note_pointers", workspaceId, p.parentId);
      const res = await q<{ id: string }>(
        `INSERT INTO note_pointers
           (workspace_id, parent_id, target_id, order_key, display_prefix)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [workspaceId, p.parentId, p.targetId, orderKey, p.displayPrefix ?? null],
      );
      await respaceIfTooLong("note_pointers", workspaceId, p.parentId, orderKey, { actor, nodeId: p.targetId });
      return res.rows[0]!;
    },
  });
}

/** Remove pointer `id`. Its target and parent (read here, before the write)
 *  attribute the event and decide the authority; the row is read again under
 *  the event lock, so a pointer removed or replaced in between answers 404
 *  "pointer not found" and commits nothing (no POINTER_DELETED for a pointer
 *  that was not there). */
export async function deletePointer(actor: ActorCtx, workspaceId: string, id: string): Promise<void> {
  const found = await q<{ target_id: string; parent_id: string | null }>(
    `SELECT target_id, parent_id FROM note_pointers WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  const existing = found.rows[0];
  if (!existing) throw new StatusError(404, "pointer not found");
  const { target_id: targetId, parent_id: parentId } = existing;
  await mutate({
    actor,
    workspaceId,
    authority: { kind: "irreversible", of: pointerAuthority(parentId, targetId) }, // no inverse (restoreContract.ts)
    event: { type: "POINTER_DELETED", targetType: "node", targetId, payload: { parent_id: parentId } },
    apply: async () => {
      const removed = await q(
        `DELETE FROM note_pointers WHERE workspace_id = $1 AND id = $2 AND target_id = $3 AND parent_id IS NOT DISTINCT FROM $4`,
        [workspaceId, id, targetId, parentId],
      );
      if (removed.rowCount === 0) throw new StatusError(404, "pointer not found");
    },
  });
}

/** A pointer is content placed under its parent, so adding or removing one
 *  needs write in the parent's space (a viewer, or someone removed from that
 *  space, cannot); a top-level pointer is a shortcut to its target and needs
 *  write on the target. */
function pointerAuthority(parentId: string | null, targetId: string): Authority {
  return { kind: "node", nodeId: parentId ?? targetId, op: "write_node" };
}
