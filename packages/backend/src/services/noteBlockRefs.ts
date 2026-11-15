// The anchor ids each note holds, as an index (migration 143) for the
// block-link fallback (blockRefLookup.ts). The note's text is the source;
// this follows it on every body write, in the writing transaction, through
// the two places a body is derived from (bodySideEffects.applyBodyChange,
// newNoteDerived.finishNewNote) — the same two that call syncBlockNodes.

import { q } from "../db.js";
import { noteAnchorRanges } from "./blockAnchors/index.js";

/** The note's rows equal the ids of its valid anchors (a block's identity is its anchor: services/blockAnchors).
 *  Call after the note's anchors moved and its block nodes were synced. */
export async function syncNoteBlockRefs(workspaceId: string, noteId: string, _markdown: string): Promise<void> {
  const ids = (await noteAnchorRanges(workspaceId, noteId)).map((a) => a.id);
  await q(
    `DELETE FROM note_block_refs WHERE note_id = $1 AND NOT (block_ref = ANY($2::text[]))`, [noteId, ids],
  );
  if (ids.length === 0) return;
  await q(
    `INSERT INTO note_block_refs (workspace_id, note_id, block_ref)
     SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`, [workspaceId, noteId, ids],
  );
}
