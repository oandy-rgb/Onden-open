import { Hono } from "hono";
import { getWorkspaceId } from "../services/workspaceId.js";
import { requireActor } from "../spine/mutate.js";
import { pageQueryOf, parsePage } from "../services/paging.js";
import { recentVersions } from "../services/history/index.js";
import type { ActorCtx } from "../types.js";

type Env = { Variables: { actor: ActorCtx | null } };

const router = new Hono<Env>();

// Recent version history across the workspace — a "recently changed" feed
// (services/history/recentVersions.ts).
// Answers a Page ({ rows, next }, services/paging.ts); `?offset=` pages on.
router.get("/recent", async (c) => {
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  // services/paging.ts: `?limit=abc` is a 400, not `LIMIT 'NaN'` (D66).
  const page = parsePage(pageQueryOf(c), { default: 100, max: 200 });
  return c.json(await recentVersions(actor, workspaceId, page));
});

export default router;
