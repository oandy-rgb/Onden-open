import { Hono } from "hono";
import type { ActorCtx } from "../types.js";

// Edge type manifest (moved from index.ts, depth audit D10), mounted at /api
// ahead of the routers whose paths it shares (/api/edges).
const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

// Edge type manifest. `node_edges.edge_type` is an open-ended string; this endpoint exposes the
// registered types (built-ins + plugin-added) so frontends can render
// per-type UI (graph colours, sidebar icons, edge browsers) without
// hardcoding the taxonomy. See services/edgeManifest.ts.
router.get("/edges/manifest", async (c) => {
  const { listEdgeTypeManifest } = await import("../services/edgeManifest.js");
  return c.json(listEdgeTypeManifest());
});

export default router;
