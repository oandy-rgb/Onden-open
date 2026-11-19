import { Hono } from "hono";
import { z } from "zod";
import type { ActorCtx } from "../types.js";
import { requireActor } from "../spine/actor.js";
import { getWorkspaceId } from "../services/workspaceId.js";
import { StatusError } from "../statusError.js";
import { pushPublicKey } from "../services/webPush.js";
import { removeSubscription, saveSubscription } from "../services/pushSubscriptions.js";
import { parseBody } from "./params.js";

// Lock-screen reminders (modules/tasks/pushReminders.ts). Not offered at all
// (404) while the server has no VAPID keys. A person manages only their own devices.
//
//   GET    /api/push/key             → { public_key }
//   POST   /api/push/subscriptions   { endpoint, p256dh, auth }  → { ok }
//   DELETE /api/push/subscriptions   { endpoint }                → { ok } (also when it was not there)

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

/** Devices belong to people: an agent or system actor has none. */
function requireHuman(actor: ActorCtx): void {
  if (actor.type !== "human") throw new StatusError(403, "push_humans_only");
}

function requirePushOffered(): string {
  const key = pushPublicKey();
  if (!key) throw new StatusError(404, "push_not_configured");
  return key;
}

router.get("/key", (c) => {
  requireActor(c.get("actor"));
  return c.json({ public_key: requirePushOffered() });
});

const Subscription = z.object({
  endpoint: z.string().url().max(2048),
  p256dh: z.string().min(1).max(256),
  auth: z.string().min(1).max(128),
});
router.post("/subscriptions", async (c) => {
  const actor = requireActor(c.get("actor"));
  requireHuman(actor); // first: a session or a token is answered by the rule, whether or not this server offers push
  requirePushOffered();
  const body = await parseBody(c, Subscription);
  await saveSubscription(actor, await getWorkspaceId(), body, c.req.header("user-agent") ?? null);
  return c.json({ ok: true });
});

router.delete("/subscriptions", async (c) => {
  const actor = requireActor(c.get("actor"));
  requireHuman(actor); // as the POST: a session never subscribes, so it has nothing here to take off (PR #1856 round 5)
  requirePushOffered();
  const body = await parseBody(c, z.object({ endpoint: z.string().max(2048) }));
  await removeSubscription(actor, body.endpoint);
  return c.json({ ok: true });
});

export default router;
