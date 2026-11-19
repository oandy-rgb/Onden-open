// A board's layout changes (PATCH /api/boards/:id, depth audit D2): the cards
// and sections a change names are upserted or removed, everything else is
// left alone, as one audited mutate(). Storage stays in boardStore.ts; this
// is the operation. Moved verbatim from routes/boards.ts.

import { isUuid } from "@onden/markdown";
import type { BoardCardPatch, BoardSectionPatch } from "@onden/contract";
import { mergeSections } from "./boardSections.js";
import { q } from "../db.js";
import { db } from "../dbKysely.js";
import { sql } from "kysely";
import { mutate } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import {
  isNoteBoard, readSections, boardCardNotesAmong, patchNodePosition, writeSections, setNodePosition,
  type BoardNode, type BoardSection, type Position,
} from "./boardStore.js";

/** A drag sends a position per drop; one event per burst is enough (below). */
export const GRAPH_POSITION_EVENT_WINDOW_MS = 5_000;

/** A hand-placed position on the global graph (PUT /api/nodes/:id/position). The position is shared data (every
 *  member's graph shows it), so it is a written event like a board card's position (CANVAS_UPDATED), not an
 *  unrecorded layout write. Rapid moves of one card (by anyone) keep their FIRST event (the head) and no further
 *  event while its position was last written under GRAPH_POSITION_EVENT_WINDOW_MS ago: the tail is the stored position itself
 *  (node_positions, and the structure log keeps its previous value), so the history shows a drag as one entry
 *  instead of one per drop. (The burst is read from the card's own position row, written a moment ago by anyone, not from
 *  the event log.) A retry after a lost reply (same Idempotency-Key) is acknowledged, not applied again:
 *  applied again it would put an old position over a newer one another device saved in between. */
export async function moveGraphPosition(
  actor: ActorCtx, workspaceId: string, nodeId: string, pos: Position & { surface: "graph" },
): Promise<void> {
  const recent = await db.selectFrom("node_positions").select("node_id")
    .where("node_id", "=", nodeId).where("surface", "=", pos.surface)
    .where("updated_at", ">", sql<Date>`now() - make_interval(secs => ${GRAPH_POSITION_EVENT_WINDOW_MS / 1000})`).executeTakeFirst();
  // One path: the same authority and the same suggest-mode gate whether or not this move is written to the history;
  // the only difference is the event itself.
  const type = "GRAPH_POSITION_UPDATED";
  await mutate({
    actor, workspaceId,
    authority: { kind: "node", nodeId, op: "write_node" },
    ...(recent
      ? { gateAs: type }
      : { event: { type, targetType: "node", targetId: nodeId, payload: { fields: ["graph_position"], x: pos.x, y: pos.y } } }),
    apply: async () => { await setNodePosition(workspaceId, nodeId, pos.surface, pos); },
  });
}


export type BoardChanges = {
  upsertCards: BoardCardPatch[];
  removeCards: string[];
  upsertSections: BoardSectionPatch[];
  removeSections: string[];
};

/** Apply one change to board `board` (found and readable — the caller's
 *  check). Only cards of notes the actor can read (trashed ones too) are placed or removed; a non-note
 *  card id (an old client's temporary card) is skipped. */
export async function applyBoardChanges(
  actor: ActorCtx, workspaceId: string, board: BoardNode,
  { upsertCards, removeCards, upsertSections, removeSections }: BoardChanges,
): Promise<{ id: string; cards: number; removed: number }> {
  const id = board.id;
  const isCanvas = isNoteBoard(board);
  return mutate({
    actor,
    workspaceId,
    // Arranging a note's board is a write on that note, in its space. A tag's board
    // is one shared arrangement of the tag's members, not part of the tag
    // definition (the owner's): anyone who may create content may arrange it,
    // and only cards they can read are placed or removed (below).
    authority: isCanvas ? { kind: "node", nodeId: id, op: "write_node" } : { kind: "any_space_write" },
    event: {
      type: isCanvas ? "CANVAS_UPDATED" : "BOARD_UPDATED",
      targetType: isCanvas ? "canvas" : "node",
      targetId: id,
      payload: {
        fields: ["layout"],
        cards: { upserted: upsertCards.length, removed: removeCards.length },
        sections: { upserted: upsertSections.length, removed: removeSections.length },
      },
    },
    apply: async () => {
      // boardCardNotesAmong drops non-note ids along with unreadable notes
      // (a trashed note's card is kept: it returns with the note).
      const readable = await boardCardNotesAmong(actor, workspaceId, [
        ...upsertCards.map((card) => card.nodeId),
        ...removeCards,
      ].filter((nodeId) => isUuid(nodeId)));
      // Entries for the same card apply in order, field by field: a later entry wins only
      // for the fields it names.
      const cards = new Map<string, BoardCardPatch>();
      for (const card of upsertCards) {
        if (!readable.has(card.nodeId)) continue;
        const named = Object.fromEntries(Object.entries(card).filter(([, v]) => v !== undefined));
        cards.set(card.nodeId, { ...cards.get(card.nodeId), ...named } as BoardCardPatch);
      }
      for (const card of cards.values()) {
        await patchNodePosition(workspaceId, card.nodeId, id, {
          ...card,
          ...(card.subCanvasId !== undefined ? { subCanvasId: card.subCanvasId && isUuid(card.subCanvasId) ? card.subCanvasId : null } : {}),
        });
      }
      const removable = removeCards.filter((nodeId) => readable.has(nodeId) && !cards.has(nodeId));
      if (removable.length > 0) {
        await q(
          `DELETE FROM node_positions WHERE workspace_id = $1 AND surface = $2 AND node_id = ANY($3::uuid[])`,
          [workspaceId, id, removable],
        );
      }

      if (upsertSections.length > 0 || removeSections.length > 0) {
        // mutate() holds the workspace write lock, so no other write interleaves between this read and the write.
        const merged = mergeSections(await readSections(id), upsertSections, removeSections);
        await writeSections(workspaceId, id, merged);
      }

      // A note's board lists by updated_at; a tag's own row is left alone so laying
      // out its members doesn't look like an edit of the tag.
      if (isCanvas) {
        await q(`UPDATE content_nodes SET updated_at = now() WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
      }
      return { id, cards: cards.size, removed: removable.length };
    },
  });
}
