// block_nodes.anchor_id: which anchor says where each block node is (migration 163).
//
// The feature data (task, review schedule, tags) hangs on block_nodes.id and never moves; the anchor is only the
// position, and it is the thing that follows the text when the note is edited. A row's `block_ref` IS its anchor's
// id (services/blockNodes.ts makes the row from the anchor at the block): this only gives a row that does not name
// its anchor yet — one made while an `^id` in the text was the identity — the anchor of that id, once the note has it
// (services/blockIdMigration.ts puts the anchors on). A paragraph that stood alone and came back is put on its anchor
// by the save that brought it back (bodySideEffects adoptAnchors).

import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import type { ActorCtx } from "../../types.js";
import { StatusError } from "../../statusError.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { assertAuthority } from "../../spine/authority.js";
import { ANCHOR_EVENTS, blockSpanAt, recordAnchorEvent, rehomeAnchor } from "./store.js";
import { sha256Hex } from "../../utils.js";

export async function linkBlockNodeAnchors(change: { workspaceId: string; noteId: string }): Promise<void> {
  const { workspaceId, noteId } = change;
  await db.updateTable("block_nodes as b").set((eb) => ({ anchor_id: eb.ref("b.block_ref") }))
    .where("b.workspace_id", "=", workspaceId).where("b.note_id", "=", noteId).where("b.detached_note_id", "is", null)
    .where(sql<boolean>`b.anchor_id IS DISTINCT FROM b.block_ref`)
    .where((eb) => eb.exists(eb.selectFrom("block_anchors as a").select("a.anchor_id")
      .whereRef("a.workspace_id", "=", "b.workspace_id").whereRef("a.anchor_id", "=", "b.block_ref").whereRef("a.note_id", "=", "b.note_id")))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("block_nodes as o").select("o.id")
      .whereRef("o.workspace_id", "=", "b.workspace_id").whereRef("o.anchor_id", "=", "b.block_ref").whereRef("o.id", "<>", "b.id"))))
    .execute();
}

/**
 * 「重新指定」: a paragraph whose anchor could not be found again points at the block at `at` (an offset into
 * the note as saved). The block node's row, task, schedule and links are untouched — only where it is changes.
 * The text must be what the person saw (`body_hash`): a note that changed since is refused (409), never guessed.
 */
export async function reassignBlockNodeAnchor(input: {
  actor: ActorCtx; workspaceId: string; noteId: string; blockNodeId: string; at: number; bodyHash: string;
}): Promise<void> {
  const { workspaceId, noteId, blockNodeId } = input;
  await withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    await assertAuthority(actor, { kind: "node", nodeId: noteId, op: "write_node" });
    const note = await db.selectFrom("content_nodes").select("markdown")
      .where("workspace_id", "=", workspaceId).where("id", "=", noteId).where("deleted_at", "is", null).where("node_type", "=", "content")
      .forShare().executeTakeFirst();
    const row = await db.selectFrom("block_nodes").select("anchor_id")
      .where("workspace_id", "=", workspaceId).where("note_id", "=", noteId).where("id", "=", blockNodeId)
      .where("hidden_at", "is", null).where("detached_note_id", "is", null).executeTakeFirst();
    if (!note || !row?.anchor_id) throw new StatusError(404, "paragraph not found");
    if (sha256Hex(note.markdown) !== input.bodyHash) throw new StatusError(409, "note_changed");
    const span = blockSpanAt(note.markdown, input.at);
    if (span === null) throw new StatusError(422, "no_paragraph_there");
    await rehomeAnchor(workspaceId, row.anchor_id, noteId, note.markdown, span);
    await recordAnchorEvent(workspaceId, noteId, ANCHOR_EVENTS.confirmed, row.anchor_id, { actor },
      { parentVersion: input.bodyHash, device: null, how: "confirmed" });
  });
}
