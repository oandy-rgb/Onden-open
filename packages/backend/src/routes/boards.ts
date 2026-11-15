import { BOARD_CARDS_PER_REQUEST_MAX, BOARD_SECTIONS_PER_REQUEST_MAX, NODE_TITLE_MAX } from "@onden/markdown";
import { Hono } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import { requireActor } from "../spine/mutate.js";
import { canReadNode } from "../services/readPolicy.js";
import { findBoardNode, isNoteBoard, readCards, readSections } from "../services/boardStore.js";
import { applyBoardChanges } from "../services/boardWrites.js";
import type { ActorCtx } from "../types.js";
import { parseBody, uuidParam } from "./params.js";
import { StatusError } from "../statusError.js";

// A board is the spatial layout of a surface node: any note (the whiteboard
// is a view of a note, migration 138), or a tag (class_tag node) whose members
// are laid out as cards — the tag's canvas lens. `kind` stays "canvas" for a
// note's board, as clients before 138 read it.
// Card placements live in node_positions (surface = the board node's id) and
// section frames in the board node's '_canvas_sections' attribute, exactly
// as /api/canvases has stored them since migration 057.
//
// Writes are CHANGES, not documents: a PATCH upserts or removes the cards and
// sections it names and leaves everything else alone. The whole-document
// PATCH /api/canvases/:id deleted every placement and re-inserted the
// client's copy, so a stale or offline copy erased cards another device had
// added (GAP-178) and undo rewound remote moves (GAP-180).
//
// Reads and writes only ever touch cards the caller can read: a hidden card
// is neither listed (its id and position would leak, GAP-256) nor movable or
// removable. The write is services/boardWrites.ts.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();


// A card whose nodeId is not a note id (an old client's temporary card) is
// skipped rather than failing the whole save, as /api/canvases always did.
const cardSchema = z.object({
  nodeId: z.string().max(200),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().nonnegative().nullable().optional(),
  height: z.number().finite().nonnegative().nullable().optional(),
  color: z.string().max(64).nullable().optional(),
  folded: z.boolean().optional(),
  subCanvasId: z.string().max(200).nullable().optional(),
});

const sectionSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(NODE_TITLE_MAX).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().nonnegative().optional(),
  height: z.number().finite().nonnegative().optional(),
  color: z.string().max(64).nullable().optional(),
}).passthrough();

const patchSchema = z.object({
  cards: z.object({
    upsert: z.array(cardSchema).max(BOARD_CARDS_PER_REQUEST_MAX).optional(),
    remove: z.array(z.string().max(200)).max(BOARD_CARDS_PER_REQUEST_MAX).optional(),
  }).optional(),
  sections: z.object({
    upsert: z.array(sectionSchema).max(BOARD_SECTIONS_PER_REQUEST_MAX).optional(),
    remove: z.array(z.string().min(1).max(200)).max(BOARD_SECTIONS_PER_REQUEST_MAX).optional(),
  }).optional(),
});


router.get("/:id", async (c) => {
  const id = uuidParam(c, "id");
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  const board = await findBoardNode(workspaceId, id);
  // Unreadable and missing answer alike, so a board's existence isn't disclosed.
  if (!board || !(await canReadNode(actor, id))) throw new StatusError(404, "not found");
  const [cards, sections] = await Promise.all([readCards(actor, workspaceId, id), readSections(id)]);
  return c.json({ id, kind: isNoteBoard(board) ? "canvas" : "tag", cards, sections });
});

router.patch("/:id", async (c) => {
  const id = uuidParam(c, "id");
  const body = await parseBody(c, patchSchema);
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  const board = await findBoardNode(workspaceId, id);
  if (!board || !(await canReadNode(actor, id))) throw new StatusError(404, "not found");

  const result = await applyBoardChanges(actor, workspaceId, board, {
    upsertCards: body.cards?.upsert ?? [],
    removeCards: body.cards?.remove ?? [],
    upsertSections: body.sections?.upsert ?? [],
    removeSections: body.sections?.remove ?? [],
  });
  return c.json(result);
});

export default router;
