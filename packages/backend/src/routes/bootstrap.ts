import { Hono } from "hono";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { buildBootstrap } from "../services/sync/index.js";
import { parseFlag } from "../services/paging.js";

// GET /api/bootstrap — the cold-start payload (services/sync/bootstrap.ts).
// ?bodies=none ships every node without its markdown (slim mode);
// ?nodes=none ships none of the per-node channels (a reopen's refresh of what
// the sync delta does not carry).
const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.get("/", async (c) => {
  const workspaceId = await getWorkspaceId();
  const bootstrapHeader = c.req.header("x-onden-bootstrap");
  const lean = bootstrapHeader === "lean" || bootstrapHeader === "lean2" ? bootstrapHeader : undefined;
  return c.json(await buildBootstrap(c.get("actor"), workspaceId, {
    slimBodies: parseFlag(c.req.query("bodies"), "none"),
    metaOnly: parseFlag(c.req.query("nodes"), "none"),
    // services/sync/bootstrap.ts: no attrs maps, no drawings (newer clients).
    // "lean2" = lean plus the compact node/attribute encoding (bootstrapWire.ts);
    // a client sending "lean" keeps the older format.
    lean: lean !== undefined,
    compact: lean === "lean2",
  }));
});

export default router;
