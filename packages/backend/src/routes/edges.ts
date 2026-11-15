// Edge (typed link) routes — extracted from index.ts so the boundary handlers
// live in a mountable router (testable via the read-authz harness) and fall
// under the require-read-gate lint like every other node-referencing route.
//
// Authority model (the reference for cross-node references): creating/removing
// an outgoing link is a WRITE on its source node (authority write_node on the
// source), AND — for create — the TARGET must be readable (canReadNode), so a
// writer can't probe / reference a read-restricted node by uuid. Both checks are
// in services/edgeWrites.ts.

import { Hono } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import { requireActor } from "../spine/mutate.js";
import { createEdge, deleteEdge } from "../services/edgeWrites.js";
import { isRegisteredEdgeType } from "../services/edgeManifest.js";
import type { ActorCtx } from "../types.js";
import { parseBody, uuidParam } from "./params.js";
import { log } from "../logger.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.post("/", async (c) => {
  const workspaceId = await getWorkspaceId();
  // edge_type is open-ended on purpose — see TYPED-EDGE SUBSTRATE header in
  // db/schema.sql. The DB CHECK was dropped in migration 024 so plugin /
  // TagPack-shipped relations can land without core changes. We keep status
  // narrow since it has actual server semantics (visibility + lifecycle).
  const input = await parseBody(c, z.object({
    id: z.string().uuid().optional(),
    source_node_id: z.string().uuid(),
    target_node_id: z.string().uuid(),
    edge_type: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, "lower_snake_case"),
    status: z.enum(["active", "suggested", "rejected"]).default("active"),
  }));
  // Drift signal: writes against an edge_type the instance doesn't know about.
  // We accept it (plugins may register dynamically and we don't want false
  // negatives), but the log makes typos / forgotten registrations visible.
  if (!isRegisteredEdgeType(input.edge_type)) {
    log.warn("edges", `write against unregistered edge_type: ${input.edge_type}`);
  }
  const actor = requireActor(c.get("actor"));
  // The target must be readable as well as the source writable: services/edgeWrites.ts createEdge checks both.
  const row = await createEdge(actor, workspaceId, input);
  return c.json(row, 201);
});

router.delete("/:id", async (c) => {
  const id = uuidParam(c, "id");
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  await deleteEdge(actor, workspaceId, id);
  return c.json({ deleted: true });
});

export default router;
