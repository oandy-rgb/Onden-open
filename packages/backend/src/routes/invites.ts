import { Hono } from "hono";
import type { ActorCtx } from "../types.js";
import { requireActor } from "../spine/mutate.js";

// POST /api/invites/claim {token} — called by the app right after sign-in /
// sign-up through an invite link (audit D110). The claim itself happens while
// the request's session is resolved (index.ts actor middleware →
// services/actors.ts actorForSession with the token), before any route runs:
// a refused link answers there (httpError.ts InviteError) and never makes a
// viewer. Reaching this handler means the login now acts as the invited
// member; the client reloads its bootstrap afterwards.
const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.post("/claim", (c) => {
  const actor = requireActor(c.get("actor"));
  return c.json({ actor: { id: actor.id, name: actor.name, type: actor.type } });
});

export default router;
