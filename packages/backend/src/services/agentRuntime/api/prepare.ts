// What every api session needs before its first paid call, checked in one place:
// the role is still there and switched on, the api runtime is still available for it
// (key, model, cap, space), and the session's identity and key are ready.
import { loadService } from "../../aiCredentials.js";
import { loadRunner, type AgentSession } from "../../agentSessionStore.js";
import type { ActorCtx } from "../../../types.js";
import { actorForRuntimeSession } from "./actor.js";
import { apiAvailability } from "./limits.js";
import { protocolClient, type ProtocolClient } from "./protocols/index.js";
import type { Prices } from "./usage.js";

/** A stop with a short fail code (agent_sessions.fail_code). */
export class Stop extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function prepareApiRun(session: AgentSession): Promise<{ role: NonNullable<Awaited<ReturnType<typeof loadRunner>>>; model: string; actor: ActorCtx; client: ProtocolClient; prices: Prices | null }> {
  const role = await loadRunner(session.workspace_id, { actorId: session.agent_actor_id });
  if (!role) throw new Stop("agent_disabled");
  const availability = await apiAvailability(role);
  if (!availability.ok) throw new Stop(availability.reason === "model_retired" ? "model_unavailable" : availability.reason);
  const actor: ActorCtx = await actorForRuntimeSession(session);
  const service = await loadService(session.workspace_id, role.api_credential_id!);
  return { role, model: session.model!, actor, client: protocolClient(service.protocol, service), prices: service.prices };
}
