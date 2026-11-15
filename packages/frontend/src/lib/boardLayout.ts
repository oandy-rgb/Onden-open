import { BOARD_CARDS_PER_REQUEST_MAX, BOARD_SECTIONS_PER_REQUEST_MAX } from "@onden/markdown";
import type { BoardCardPatch, BoardSectionPatch } from "@onden/contract";
import type { CanvasData, CanvasNodeEntry, CanvasSection, ContentNode } from "./api";
import { nodeHasTag, listsAsNote } from "./nodeTags";
import { APPEND_GRID, DEFAULT_CARD_H, DEFAULT_CARD_W } from "./cardGeometry";

// A board is the card layout of a canvas node or of a tag (the tag's canvas
// lens). Saves send what changed between two layouts, never the whole board,
// so a stale copy cannot erase cards or sections another device added
// (GAP-178) and an undo only rewinds the cards it touched (GAP-180). A card
// is sent as the fields that changed, so a move from an old copy leaves the
// colour and size another device set.

export type BoardChanges = {
  cards?: { upsert?: BoardCardPatch[]; remove?: string[] };
  sections?: { upsert?: BoardSectionPatch[]; remove?: string[] };
};

/** The fields of `card` that differ from `old`, in wire form (absent = unchanged, null = cleared).
 *  A card the server may not have yet (`old` missing) is sent whole. Moving sends x and y together so
 *  a card another device removed is placed again where this one put it. */
function cardPatch(old: CanvasNodeEntry | undefined, card: CanvasNodeEntry): BoardCardPatch | null {
  const patch: BoardCardPatch = { nodeId: card.nodeId };
  const moved = !old || old.x !== card.x || old.y !== card.y;
  if (moved) { patch.x = card.x; patch.y = card.y; }
  for (const key of ["width", "height", "color", "subCanvasId"] as const) {
    if ((old?.[key] ?? null) !== (card[key] ?? null)) Object.assign(patch, { [key]: card[key] ?? null });
  }
  if (!!old?.folded !== !!card.folded) patch.folded = !!card.folded;
  return Object.keys(patch).length > 1 ? patch : null;
}

/** The fields of `section` that differ from `old`, as for a card (absent = unchanged, null colour = cleared). A frame the
 *  server may not have yet (`old` missing) is sent whole. Moving sends x and y together, resizing width and height
 *  together, so each pair stays consistent when another device changed the other pair or the name meanwhile. */
function sectionPatch(old: CanvasSection | undefined, section: CanvasSection): BoardSectionPatch | null {
  if (!old) return { id: section.id, title: section.title, x: section.x, y: section.y, width: section.width, height: section.height, ...(section.color ? { color: section.color } : {}) };
  const patch: BoardSectionPatch = { id: section.id };
  if (old.title !== section.title) patch.title = section.title;
  if (old.x !== section.x || old.y !== section.y) { patch.x = section.x; patch.y = section.y; }
  if (old.width !== section.width || old.height !== section.height) { patch.width = section.width; patch.height = section.height; }
  if ((old.color ?? null) !== (section.color ?? null)) patch.color = section.color ?? null;
  return Object.keys(patch).length > 1 ? patch : null;
}

/** The edits that turn `before` into `after`. A card without a finite position
 *  is not sent: the server could not store it anyway. */
export function diffBoard(before: CanvasData | undefined, after: CanvasData): BoardChanges {
  const oldCards = new Map((before?.nodes ?? []).map((card) => [card.nodeId, card]));
  const newCards = new Map(after.nodes.map((card) => [card.nodeId, card]));
  const upsertCards = [...newCards.values()].flatMap((card) => {
    if (!Number.isFinite(card.x) || !Number.isFinite(card.y)) return [];
    const patch = cardPatch(oldCards.get(card.nodeId), card);
    return patch ? [patch] : [];
  });
  const removeCards = [...oldCards.keys()].filter((id) => !newCards.has(id));

  const changes: BoardChanges = {};
  if (upsertCards.length || removeCards.length) {
    changes.cards = {
      ...(upsertCards.length ? { upsert: upsertCards } : {}),
      ...(removeCards.length ? { remove: removeCards } : {}),
    };
  }

  // An absent sections list means "not part of this layout", not "none".
  if (after.sections !== undefined) {
    const oldSections = new Map((before?.sections ?? []).map((s) => [s.id, s]));
    const newSections = new Map(after.sections.map((s) => [s.id, s]));
    const upsertSections = [...newSections.values()].flatMap((s) => {
      const patch = sectionPatch(oldSections.get(s.id), s);
      return patch ? [patch] : [];
    });
    const removeSections = [...oldSections.keys()].filter((id) => !newSections.has(id));
    if (upsertSections.length || removeSections.length) {
      changes.sections = {
        ...(upsertSections.length ? { upsert: upsertSections } : {}),
        ...(removeSections.length ? { remove: removeSections } : {}),
      };
    }
  }
  return changes;
}

/** The change as requests the server accepts (its per-request caps): the lists are cut into runs of
 *  at most the cap, run i of every list travelling together. Send them one after another, in order. */
export function splitBoardChanges(changes: BoardChanges): BoardChanges[] {
  const cap = { cards: BOARD_CARDS_PER_REQUEST_MAX, sections: BOARD_SECTIONS_PER_REQUEST_MAX };
  const lists = changes as Record<keyof typeof cap, Record<"upsert" | "remove", unknown[] | undefined> | undefined>;
  const kinds = Object.keys(cap) as (keyof typeof cap)[];
  const edits = ["upsert", "remove"] as const;
  const runs = Math.max(1, ...kinds.flatMap((k) => edits.map((e) => Math.ceil((lists[k]?.[e]?.length ?? 0) / cap[k]))));
  return Array.from({ length: runs }, (_, i) => {
    const part: Record<string, Record<string, unknown[]>> = {};
    for (const k of kinds) for (const e of edits) {
      const run = lists[k]?.[e]?.slice(i * cap[k], (i + 1) * cap[k]);
      if (run?.length) (part[k] ??= {})[e] = run;
    }
    return part as BoardChanges;
  });
}

/** Which of `ids` the board stores as cards, and which only the sub-note tree draws (a board that follows
 *  its sub-notes). Only stored cards can be taken off the board; the tree ones go with the setting. */
export function splitStoredCards(stored: readonly { nodeId: string }[], ids: readonly string[]): { stored: string[]; fromTree: string[] } {
  const have = new Set(stored.map((card) => card.nodeId));
  return { stored: ids.filter((id) => have.has(id)), fromTree: ids.filter((id) => !have.has(id)) };
}

export function isEmptyBoardChange(changes: BoardChanges): boolean {
  return !changes.cards && !changes.sections;
}

/** Notes a tag's board shows: the notes carrying the tag DIRECTLY. Not the
 *  tag page's members (lib/nodeTags.ts tagMembers, which adds child tags and
 *  extenders): the board adds and removes this tag itself, and could not
 *  take a child tag's note off it. */
export function tagBoardMemberIds(nodes: ContentNode[], tagId: string): string[] {
  return nodes
    .filter((n) => listsAsNote(n) && nodeHasTag(n, tagId))
    .map((n) => n.id);
}


/** A tag board's layout for its current members: stored cards of notes that
 *  still carry the tag keep their place; members never placed are lined up in
 *  a grid under the placed cards. Placements of notes that left the tag stay
 *  on the server (re-tagging restores them) but are not shown. */
export function materializeTagBoard(stored: CanvasData, memberIds: string[]): CanvasData {
  const members = new Set(memberIds);
  const kept = stored.nodes.filter((card) => members.has(card.nodeId));
  const placed = new Set(kept.map((card) => card.nodeId));
  const missing = memberIds.filter((id) => !placed.has(id));
  if (missing.length === 0 && kept.length === stored.nodes.length) return stored;
  const left = kept.length ? Math.min(...kept.map((card) => card.x)) : 100;
  const below = kept.length
    ? Math.max(...kept.map((card) => card.y + (card.height ?? DEFAULT_CARD_H))) + 80
    : 100;
  const added = missing.map((nodeId, i) => ({
    nodeId,
    x: Math.round(left + (i % APPEND_GRID.cols) * (DEFAULT_CARD_W + APPEND_GRID.gapX)),
    y: Math.round(below + Math.floor(i / APPEND_GRID.cols) * (DEFAULT_CARD_H + APPEND_GRID.gapY)),
  }));
  return { ...stored, nodes: [...kept, ...added] };
}

/** The space a board lives in: what a note made on it must be created in, so everybody who sees the
 *  board can see its new cards (an existing note placed on it goes through lib/boardCardAudience).
 *  Null for a tag's board and when unknown: the usual default applies. */
export function boardSpaceId(nodes: readonly ContentNode[], boardId: string | null | undefined): string | null {
  return (boardId ? nodes.find((node) => node.id === boardId)?.space_id : null) ?? null;
}
