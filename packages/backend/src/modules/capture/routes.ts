import { Hono } from "hono";
import { getWorkspaceId } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { requireActor } from "../../spine/mutate.js";
import { ensureInboxTag } from "./inboxTag.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

// POST /api/capture/inbox — the inbox's tag, made if this is the first capture
// that needs it. The client puts the id on the note it creates (POST /api/nodes
// `tag_ids`), so the note and the tag are one write and the note is never
// half-made. Idempotent: asking again answers the same tag.
router.post("/inbox", async (c) => {
  const tagId = await ensureInboxTag(requireActor(c.get("actor")), await getWorkspaceId());
  return c.json({ tag_id: tagId });
});

export default router;
