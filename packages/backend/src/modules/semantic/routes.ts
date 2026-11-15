import type { ModuleApp } from "../types.js";
import { getWorkspaceId } from "../../db.js";
import { requireActor } from "../../spine/mutate.js";
import { assertAuthority } from "../../spine/authority.js";
import { refreshSuggestedLinks, semanticSearchNodes } from "../../services/embeddings.js";
import { z } from "zod";
import { parseQuery } from "../../routes/params.js";
import { workspaceHasModule } from "../../services/workspaceModules.js";
import { SEMANTIC_MODULE, indexProgress } from "./indexing.js";

/** Meaning matches farther than this are not offered to a person searching (cosine distance; 0 is identical). */
const MEANING_MAX_DISTANCE = 0.25;
const MEANING_LIMIT = 5;

export function registerSemanticRoutes(app: ModuleApp): void {
  // Recompute + persist this node's semantic link suggestions (status='suggested'
  // edges the canvas renders). Human-triggered (e.g. a "find related" action).
  // Confirming a suggestion is the existing POST /api/edges with status='active'.
  app.post("/api/nodes/:id/suggested-links", async (c) => {
    const workspaceId = await getWorkspaceId();
    const id = c.req.param("id");
    const actor = requireActor(c.get("actor"));
    // Writing suggestions is a write on the source node.
    await assertAuthority(actor, { kind: "node", nodeId: id, op: "write_node" });
    const suggestions = await refreshSuggestedLinks(workspaceId, id, { actor });
    return c.json({ suggestions });
  });

  // How many of the reader's notes are ready, for the module's settings.
  app.get("/api/semantic/status", async (c) => {
    const workspaceId = await getWorkspaceId();
    return c.json(await indexProgress(workspaceId, requireActor(c.get("actor"))));
  });

  // Notes whose meaning is near the query, among those the reader may read (semanticSearchNodes
  // pushes the read policy into its query). The one search (lib/data/noteSearch) asks here after
  // its exact matches; a hit too far away is not worth showing.
  app.get("/api/semantic/search", async (c) => {
    const workspaceId = await getWorkspaceId();
    const actor = requireActor(c.get("actor"));
    const text = parseQuery(c, z.object({ q: z.string().default("") })).q.trim();
    // Off: no meaning matches (reads of a module's own data stay open, but there is nothing to offer).
    if (text.length < 2 || !(await workspaceHasModule(workspaceId, SEMANTIC_MODULE))) return c.json([]);
    const hits = await semanticSearchNodes(workspaceId, text, { actor, limit: MEANING_LIMIT });
    return c.json(hits.filter((hit) => hit.distance <= MEANING_MAX_DISTANCE));
  });
}
