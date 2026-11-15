import { parseCount } from "../services/paging.js";
import { StatusError } from "../statusError.js";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ActorCtx } from "../types.js";
import {
  ActorAdminError, listActors, createActor, updateActor, removeActor, regenerateInvite,
  mintToken, listTokens, changeTokenAccess, revokeTokenOf, deleteToken, actorStats,
  type NewActor, type TokenInput,
} from "../services/actors.js";
import { readJsonBody } from "./params.js";

// Permission administration over HTTP: members (actors) and their bearer
// tokens. services/actors.ts owns every rule — the owner-only gate (run before
// any lookup), validation, existence checks and the audited mutate(); each
// handler here parses, calls, and answers. A refusal arrives as
// ActorAdminError with the exact status and body to send.

type Ctx = Context<{ Variables: { actor: ActorCtx | null } }>;
const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

async function answer(c: Ctx, run: () => Promise<unknown>, status: 200 | 201 = 200) {
  try {
    return c.json(await run() as object, status);
  } catch (e) {
    if (e instanceof ActorAdminError) return c.json(e.body, e.status);
    throw e;
  }
}
// Token bodies are optional: a missing one reads as {}; a malformed one is a 400.
const tokenBody = <T>(c: Ctx) => readJsonBody(c, { optional: true }) as Promise<T>;

router.get("/", (c) => answer(c, () => listActors(c.get("actor"))));
router.post("/", (c) => answer(c, () => createActor(c.get("actor"), () => readJsonBody(c) as Promise<NewActor>), 201));
router.patch("/:id", (c) => answer(c, () => updateActor(c.get("actor"), c.req.param("id"), () => readJsonBody(c) as Promise<{ name?: string }>)));
router.delete("/:id", (c) => answer(c, () => removeActor(c.get("actor"), c.req.param("id"))));
// A new one-time invite link for a person who has not signed in; the old one stops working.
router.post("/:id/invite", (c) => answer(c, () => regenerateInvite(c.get("actor"), c.req.param("id")), 201));

router.post("/:id/tokens", (c) => answer(c, async () => mintToken(c.get("actor"), c.req.param("id"), await tokenBody<TokenInput>(c)), 201));
router.get("/:id/tokens", (c) => answer(c, () => listTokens(c.get("actor"), c.req.param("id"))));
router.patch("/:id/tokens/:tokenId", (c) => answer(c, async () =>
  changeTokenAccess(c.get("actor"), c.req.param("id"), c.req.param("tokenId"), await tokenBody<TokenInput>(c))));
router.post("/:id/tokens/:tokenId/revoke", (c) => answer(c, () => revokeTokenOf(c.get("actor"), c.req.param("id"), c.req.param("tokenId"))));
router.delete("/:id/tokens/:tokenId", (c) => answer(c, () => deleteToken(c.get("actor"), c.req.param("id"), c.req.param("tokenId"))));
router.get("/:id/stats", (c) => {
  const days = parseCount(c.req.query("days"), { fallback: 30, max: 365 });
  if (days === null) throw new StatusError(400, "days must be 1–365");
  return answer(c, () => actorStats(c.get("actor"), c.req.param("id"), days));
});

export default router;
