// The outbox intent for anchors a save had no budget to look up. Apart from recover.ts (which performs it and reads
// the anchors back through store.ts) so that store.ts, which writes the intent, does not import its own reader.

import { enqueueEffect } from "../outbox.js";

/** One intent per note (dedup key), so a note with many pending anchors is one job. */
export const ANCHOR_RECOVER_EFFECT = "block_anchor_recover";
export function enqueueAnchorRecovery(workspaceId: string, noteId: string, triggeredByEventId?: string): Promise<string> {
  return enqueueEffect({
    workspaceId, kind: ANCHOR_RECOVER_EFFECT, dedupKey: `${ANCHOR_RECOVER_EFFECT}:${noteId}`,
    payload: { workspace_id: workspaceId, note_id: noteId }, triggeredByEventId,
  });
}

