// The anchors a save had no budget to look up (mapping.ts FIND_BUDGET) are looked up here, off the save's
// path: an outbox intent per note (proposal §4.4: "走既有 outbox／系統工作，不新增各自提交的流程").
//
// The intent is written in the same transaction as the save's anchor rows, so it exists exactly when the rows
// say "pending". Performing it reads the note's CURRENT body under the workspace event lock (the one saves
// hold), so a body that changed meanwhile is simply the new input: nothing here remembers the old one. A pass
// finds at most FIND_BUDGET anchors, like a save; passes repeat until none is pending. At-least-once is safe:
// a pass over anchors that are already settled changes nothing.

import { db } from "../../dbKysely.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { registerOutboxEffect, requireString } from "../outbox.js";
import { ANCHOR_RECOVER_EFFECT } from "./recoverIntent.js";
import { moveAnchorsForBodyChange } from "./store.js";

/** A note with more pending anchors than this many passes can settle goes back to the outbox (retried later). */
const MAX_PASSES = 40;

/** One pass over `noteId`: how many anchors are still pending after it (0 for a note that is gone). */
export async function recoverAnchorsOnce(workspaceId: string, noteId: string): Promise<number> {
  return withEventTransaction(workspaceId, async () => {
    const note = await db.selectFrom("content_nodes").select("markdown").where("workspace_id", "=", workspaceId).where("id", "=", noteId).executeTakeFirst();
    if (!note) return 0;
    // before: null — nothing is trusted by position; each pending anchor is found by its quoted text.
    return (await moveAnchorsForBodyChange({ workspaceId, noteId, before: null, after: note.markdown })).pending;
  });
}

export async function recoverAnchors(workspaceId: string, noteId: string): Promise<void> {
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (await recoverAnchorsOnce(workspaceId, noteId) === 0) return;
  }
  throw new Error("anchors of a long note are still being looked up");
}

registerOutboxEffect({
  kind: ANCHOR_RECOVER_EFFECT,
  parse: (payload) => ({ workspaceId: requireString(payload, "workspace_id"), noteId: requireString(payload, "note_id") }),
  perform: ({ workspaceId, noteId }) => recoverAnchors(workspaceId, noteId),
});
