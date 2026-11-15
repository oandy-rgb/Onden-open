// Pointer (symlink-style) clones for the sidebar tree.
//
// A pointer is a lightweight `(parent_id, target_id)` row that makes the
// same note appear under another parent. The note's primary home is
// still content_nodes.parent_id; pointers are additional tree
// positions. Edit / open routes go through the target note, so editing
// "through" a pointer just opens its target.
//
// Endpoints kept minimal — list happens via bootstrap, create wants a
// JSON body, delete is parameterless. No update path; if a pointer is
// in the wrong place the user deletes and re-creates.

import { requireActor } from "../spine/mutate.js";
import { Hono } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import { type ActorCtx } from "../types.js";
import { canReadNode } from "../services/readPolicy.js";
import { createPointer, deletePointer } from "../services/pointers.js";
import { parseBody, uuidParam } from "./params.js";
import { StatusError } from "../statusError.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.post("/", async (c) => {
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  const { target_id, parent_id, sort_order, display_prefix } = await parseBody(c, z.object({
    target_id: z.string().uuid(),
    parent_id: z.string().uuid().nullable().optional(),
    sort_order: z.number().int().optional(),
    display_prefix: z.string().optional(),
  }));

  // Guard against self-loops: a note cannot point under itself or
  // descend its own subtree. The "under its own subtree" check is
  // intentionally not enforced — there is no recursive parent_id walk
  // in the substrate today and a pointer doesn't introduce a real
  // cycle (the target stays at its own parent_id). If render-time
  // walks ever recursively follow pointers, add a cycle guard there.
  if (parent_id && parent_id === target_id) {
    throw new StatusError(400, "cannot point a node under itself");
  }

  // Read gate on the TARGET: a pointer surfaces (and links to) the target note
  // under another parent, so creating one for a node the caller can't read would
  // both confirm the node's existence and clone it into a tree position the
  // scoped actor controls. The write `min: editor` check below only governs
  // mutating power, not visibility — a low-role human or a tag-scoped bearer
  // token (which both pass `editor`) could otherwise reference a read-restricted
  // node. 404 so the gate doesn't leak that target_id resolves to a real node.
  if (!(await canReadNode(actor, target_id))) {
    throw new StatusError(404, "target not found");
  }
  // Read gate on the PARENT too: a pointer's parent_id is the tree position it's
  // placed under — a second referenced node. Ungated, an actor could probe an
  // unreadable parent (201 vs FK error). 404 like the target gate.
  if (parent_id && !(await canReadNode(actor, parent_id))) {
    throw new StatusError(404, "parent not found");
  }

  try {
    const row = await createPointer(actor, workspaceId, {
      targetId: target_id, parentId: parent_id ?? null, sortOrder: sort_order, displayPrefix: display_prefix,
    });
    return c.json({ id: row.id, target_id, parent_id: parent_id ?? null }, 201);
  } catch (err) {
    // 23505 — unique_violation: a pointer already exists at this (parent, target)
    if ((err as { code?: string }).code === "23505") {
      throw new StatusError(409, "pointer already exists at this location");
    }
    throw err; // spine denials (401/403) map in the central onError handler
  }
});

router.delete("/:id", async (c) => {
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  const id = uuidParam(c, "id");

  await deletePointer(actor, workspaceId, id);
  return c.json({ ok: true });
});

export default router;
