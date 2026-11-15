import { Hono } from "hono";
import { getWorkspaceId } from "../../db.js";
import { listImportSources } from "./shared/identity.js";
import { requireActor } from "../../spine/mutate.js";
import type { ActorCtx } from "../../types.js";
import { importObsidian, obsidianImportSchema } from "./obsidian/import.js";
import { parseBody } from "../../routes/params.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.get("/sources", async c => {
  const actor = requireActor(c.get("actor"));
  return c.json({sources:await listImportSources(actor,await getWorkspaceId())});
});

// POST /api/import/obsidian — a batch of vault files (modules/importers/obsidian/import.ts).
router.post("/obsidian", async (c) => c.json(await importObsidian(c.get("actor"), async () => parseBody(c, obsidianImportSchema))));

export default router;
