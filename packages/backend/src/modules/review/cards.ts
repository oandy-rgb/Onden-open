import { randomUUID } from "node:crypto";
import { getWorkspaceId } from "../../db.js";
import { db } from "../../dbKysely.js";
import { requireActor, mutate } from "../../spine/mutate.js";
import { assertAuthority } from "../../spine/authority.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { canReadNode } from "../../services/readPolicy.js";
import { deleteOwnRef, insertOwnRef, ownRefId } from "../../services/functionRefs.js";
import type { ReviewCardChange } from "@onden/contract";
import type { ActorCtx } from "../../types.js";
import { ReviewError } from "./service.js";
import { isNote } from "@onden/markdown/contract";

// Making a whole note a review card, or not: the note's own function reference (function_refs, function 'review'). A tag does
// not make cards any more (migration 195). A paragraph becomes a card by the review word in its `{…}` (seam.ts), which a note
// save turns into the same kind of reference on the paragraph.
//
// This is a change to the shared note, so it is an event (FUNCTION_REF_ADDED / REMOVED on the note, undone from History like the
// function changes of a tag) and needs the right to edit the note. Everyone's schedules (review_states) stay when a note stops
// being a card, so turning it on again resumes them.

export const REVIEW_FUNCTION_ID = "review";

/** Whether the note is a review card. ReviewError 404 when the actor cannot read it. */
export async function noteIsCard(identity: ActorCtx | null, noteId: string): Promise<boolean> {
  const actor = requireActor(identity);
  const workspaceId = await getWorkspaceId();
  const note = await db.selectFrom("content_nodes").select("id").where("id", "=", noteId).where("workspace_id", "=", workspaceId).where("deleted_at", "is", null).executeTakeFirst();
  if (!note || !(await canReadNode(actor, noteId))) throw new ReviewError(404, "node not found");
  return (await ownRefId({ kind: "node", id: noteId }, REVIEW_FUNCTION_ID)) !== null;
}

/** Make the note a review card (`on`) or stop. Answers whether anything changed. ReviewError 404 when the note cannot be read,
 *  409 when it is not a visible content note; an actor who may not edit it is refused like any edit. */
export async function setNoteCard(identity: ActorCtx | null, noteId: string, on: boolean): Promise<ReviewCardChange> {
  const authenticated = requireActor(identity);
  const workspaceId = await getWorkspaceId();
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    const note = await db.selectFrom("content_nodes").select(["node_type", "hidden"]).where("id", "=", noteId).where("workspace_id", "=", workspaceId)
      .where("deleted_at", "is", null).forUpdate().executeTakeFirst();
    if (!note || !(await canReadNode(actor, noteId))) throw new ReviewError(404, "node not found");
    if (!isNote(note) || note.hidden) throw new ReviewError(409, "only content notes can be reviewed");
    // The right to edit is asked before the answer "nothing to change": a reader may not learn the note's card state by trying.
    await assertAuthority(actor, { kind: "node", nodeId: noteId, op: "write_node" });
    const holder = { kind: "node" as const, id: noteId };
    const existing = await ownRefId(holder, REVIEW_FUNCTION_ID);
    if ((existing !== null) === on) return { note_id: noteId, card: on, changed: false };
    const refId = existing ?? randomUUID();
    await mutate({
      actor, workspaceId, authority: { kind: "node", nodeId: noteId, op: "write_node" },
      event: {
        type: on ? "FUNCTION_REF_ADDED" : "FUNCTION_REF_REMOVED", targetType: "node", targetId: noteId,
        payload: { ref_id: refId, function_id: REVIEW_FUNCTION_ID, instance: "", config: {} },
        txMeta: { inverse_op: on ? "function_ref.removed" : "function_ref.added", ui_context: "review.card" },
      },
      apply: async () => {
        if (on) await insertOwnRef(workspaceId, holder, REVIEW_FUNCTION_ID, { by: actor, id: refId });
        else await deleteOwnRef(holder, REVIEW_FUNCTION_ID);
      },
    });
    return { note_id: noteId, card: on, changed: true };
  });
}
