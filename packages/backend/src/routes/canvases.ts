import { NODE_TITLE_MAX } from "@onden/markdown";
import { Hono } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import { requireActor } from "../spine/mutate.js";
import { updateCanvas } from "../services/canvasNodes.js";
import { addWhiteboardTab, readCards, readSections } from "../services/boardStore.js";
import { canvasExists, listReadableCanvases, readCanvas, type CanvasRow } from "../services/canvasReads.js";
import type { ActorCtx } from "../types.js";
import { trashNode, NodeTrashError } from "../services/nodeTrash.js";
import { randomUUID } from "node:crypto";
import { createNote } from "../services/noteCreate.js";
import { parseBody, uuidParam } from "./params.js";
import { StatusError } from "../statusError.js";

// The whiteboard is a view of a note (migration 138): a "canvas" here is a
// note that has a whiteboard tab (a saved view of layout "canvas", see
// services/noteViews.ts), or is still of the retired node_type 'canvas'. Card
// layout lives on node_positions (surface = the note's id) and sections on the
// note's '_canvas_sections' attribute. These routes keep the historical
// /api/canvases API shape — {id, title, data:{nodes, sections}} — for clients
// from before 138, which are still open for days; new clients read and write
// the layout through /api/boards/:id and create one with POST here.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

// Input schemas. passthrough(): older clients send extra keys we never read.
const createCanvasSchema = z.object({
  title: z.string().min(1).max(NODE_TITLE_MAX).optional(),
  // Offline-parity: a client-minted canvas (= node) id so an offline create is
  // optimistic + reconciles by id. Absent → server mints.
  id: z.string().uuid().optional(),
  // A top-level canvas's space; default the creator's personal space.
  space_id: z.string().uuid().optional(),
}).passthrough();

// The layout is written through PATCH /api/boards/:id (changes, not a whole
// document). A `data` here is an old client's whole-document save: replayed
// from a stale offline queue it would delete every placement and re-insert
// its own, so it is refused (410) instead of applied.
const patchCanvasSchema = z.object({
  title: z.string().min(1).max(NODE_TITLE_MAX).optional(),
  data: z.unknown().optional(),
}).passthrough();

router.get("/", async (c) => c.json(await listReadableCanvases(c.get("actor"), await getWorkspaceId())));

router.post("/", async (c) => {
  // An empty body still creates a default canvas; a malformed one, or a
  // present-but-wrong-typed title, is a 400.
  const { title = "Untitled Canvas", id: clientId, space_id } = await parseBody(c, createCanvasSchema, { optional: true });
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  // A new canvas is a plain note with a whiteboard tab that it opens on
  // (migration 138), created like any note (services/noteCreate.ts) in the
  // creator's space; the tab is written in the same transaction.
  const id = clientId ?? randomUUID();
  const { node } = await createNote({
    actor, workspaceId, id, title, spaceId: space_id,
    event: { type: "CANVAS_CREATED", targetType: "canvas", uiContext: "canvas.create" },
    within: ({ nodeId }) => addWhiteboardTab(nodeId),
  });
  const row: CanvasRow = {
    id: node.id as string, title: node.title as string,
    created_at: node.created_at as CanvasRow["created_at"], updated_at: node.updated_at as CanvasRow["updated_at"],
  };
  return c.json(row, 201);
});

router.get("/:id", async (c) => {
  const workspaceId = await getWorkspaceId();
  const id = uuidParam(c, "id");
  // 404 for missing and unreadable alike — don't confirm existence to an actor
  // who can't read it.
  const actor = requireActor(c.get("actor"));
  const node = await readCanvas(actor, workspaceId, id);
  if (!node) throw new StatusError(404, "not found");
  // Only cards the caller can read: a hidden note's id and position must not
  // ride out on a readable board (GAP-256).
  const [nodes, sections] = await Promise.all([
    readCards(actor, workspaceId, id),
    readSections(id),
  ]);
  return c.json({
    ...node,
    data: { nodes, ...(sections.length > 0 ? { sections } : {}) },
  });
});

router.patch("/:id", async (c) => {
  const id = uuidParam(c, "id");
  const body = await parseBody(c, patchCanvasSchema);
  if (body.data !== undefined) {
    return c.json({ error: "gone", detail: "a canvas layout is saved with PATCH /api/boards/:id; reload to get the current app" }, 410);
  }
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  if (!(await canvasExists(workspaceId, id))) throw new StatusError(404, "not found");
  const row = await updateCanvas(actor, workspaceId, id, { title: body.title, fields: Object.keys(body) });
  return c.json(row);
});

router.delete("/:id", async (c) => {
  const id = uuidParam(c, "id");
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  if (!(await canvasExists(workspaceId, id))) return c.json({ ok: true }); // idempotent: already gone
  // A canvas is a node (mig 057): it goes to the trash like any note
  // (services/nodeTrash.ts): one NODE_DELETED with its subtree, undoable from
  // history, and a published board leaves the site once it commits. The
  // tombstone keeps layout and sections, so an undelete brings the board back.
  try {
    await trashNode(actor, workspaceId, id, { uiContext: "canvas.delete" });
  } catch (error) {
    if (!(error instanceof NodeTrashError && error.status === 404)) throw error;
  }
  return c.json({ ok: true });
});

export default router;
