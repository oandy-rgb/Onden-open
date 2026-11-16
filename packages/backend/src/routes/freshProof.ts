import { Hono } from "hono";
import { z } from "zod";
import { requireActor } from "../spine/mutate.js";
import { FRESH_PROOF_PURPOSES, issueFreshProof } from "../services/freshProof.js";
import type { ActorCtx } from "../types.js";
import { parseBody } from "./params.js";

// POST /api/fresh-proof: a person presents their password again (or, for the browser version's one local person, whose password is public by design,
// an acknowledgement) and gets a ticket good for 2 minutes and one use, for one named purpose. services/freshProof.ts says what the server can and
// cannot check, and how a guarded route spends the ticket. The ticket is in the answer body, never in a URL or a log.

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

const body = z.object({
  purpose: z.enum(FRESH_PROOF_PURPOSES),
  evidence: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("password"), password: z.string().min(1).max(1024) }).strict(),
    z.object({ kind: z.literal("acknowledgement") }).strict(),
  ]),
}).strict();

router.post("/", async (c) => {
  const input = await parseBody(c, body);
  const { ticket, expiresInSeconds } = await issueFreshProof(requireActor(c.get("actor")), input.purpose, input.evidence);
  c.header("Cache-Control", "no-store");
  return c.json({ ticket, expires_in_seconds: expiresInSeconds });
});

export default router;
