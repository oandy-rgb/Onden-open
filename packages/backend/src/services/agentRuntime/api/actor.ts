// The identity an api session acts under. Like a system job's actor
// (spine/systemJobs.ts) it exists in one place only: actorForRuntimeSession() is
// the sole function that makes it, and test/guards/aiRuntime.guard.test.ts fixes
// who may call it (the api runtime).
//
// It is an ordinary session token (agent_tokens.session_id), minted in-process and
// never shown to anyone, so everything downstream treats it like the runner's
// session token: the space reach (spine/spaceScope.ts), the tool grant, revocation
// when the session ends, and the reload under the event lock. What makes it an
// api actor is read from the session's ROW, not from this object: write_mode is
// 'suggest' (the database requires it for runtime='api'), and currentActor.ts copies
// that into tokenScope.writeMode on every reload even for an agent whose own
// setting is 'apply'. mutate() enforces it (toolScope.ts assertWriteModeAllows).
import type { ActorCtx } from "../../../types.js";
import { q } from "../../../db.js";
import { resolveCurrentActor } from "../../../spine/currentActor.js";
import { createToken } from "../../agentTokens.js";
import type { AgentSession } from "../../agentSessionStore.js";
import { toolsForRuntime } from "./tools.js";

export async function actorForRuntimeSession(session: AgentSession): Promise<ActorCtx> {
  if (session.runtime !== "api" || session.write_mode !== "suggest") {
    throw new Error("actorForRuntimeSession: not an api session in suggest mode");
  }
  await q(`UPDATE agent_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`, [session.id]);
  const token = await createToken(session.agent_actor_id, {
    name: `api session ${session.id}`,
    access: "write",
    allowedTools: toolsForRuntime().map((tool) => tool.name),
    expiresAt: session.deadline_at,
    issuedBy: session.initiator_id,
    sessionId: session.id,
  });
  return resolveCurrentActor({ id: session.agent_actor_id, tokenScope: { tokenId: token.id } }, session.workspace_id);
}
