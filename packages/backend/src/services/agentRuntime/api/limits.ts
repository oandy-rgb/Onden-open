// What the api runtime may spend, and when it can run at all (proposal §3.1, §7.3).
import { q } from "../../../db.js";
import { anyLiveCredential, credentialLive } from "../../aiCredentials.js";
import { secretKeyConfigured } from "../../serverSecret.js";
import type { AiRole, Availability } from "../types.js";

/** Model turns one session may take (each turn is one paid call). */
export const MAX_TURNS = 12;
/** Cap on one model reply, in tokens. */
export const MAX_OUTPUT_TOKENS = 16_000;

/** Tokens (in + out) used by this role's api sessions since the start of the current UTC month. The monthly limit is counted in tokens. */
export async function monthTokensUsed(agentActorId: string): Promise<number> {
  const r = await q<{ spent: number }>(
    `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::float8 AS spent FROM agent_sessions
      WHERE agent_actor_id = $1 AND runtime = 'api' AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [agentActorId]);
  return r.rows[0]!.spent;
}

/** A space where the role is an editor and external AI is allowed in. */
async function reachesAnySpace(agentActorId: string): Promise<boolean> {
  return (await q(
    `SELECT 1 FROM space_members m JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
      WHERE m.actor_id = $1 AND m.permission = 'edit' AND s.capabilities->>'external_ai' = 'true' LIMIT 1`,
    [agentActorId])).rows.length > 0;
}

/** Can this role run through the API now? Facts, in the order an owner fixes them. */
export async function apiAvailability(role: AiRole): Promise<Availability> {
  const no = (reason: Extract<Availability, { ok: false }>["reason"]): Availability => ({ ok: false, reason });
  if (!secretKeyConfigured()) return no("no_secret_key");
  if (!role.api_credential_id || !(await credentialLive(role.workspace_id, role.api_credential_id))) {
    // A key the owner added but has not chosen here yet is a step to take, not "no API":
    // only a workspace with no live key at all hides the API (agentRuntime API_HIDDEN).
    return no((await anyLiveCredential(role.workspace_id)) ? "key_unchosen" : "no_key");
  }
  if (!role.enabled) return no("agent_disabled");
  if (!role.api_model) return no("no_model");
  if (role.api_model_retired_at) return no("model_retired");
  if (!role.api_cap_choice) return no("cap_unanswered");
  if (role.api_cap_choice === "capped") {
    if ((await monthTokensUsed(role.actor_id)) >= (role.monthly_cap_tokens ?? 0)) return no("cap_reached");
  }
  if (!(await reachesAnySpace(role.actor_id))) return no("external_ai_off");
  return { ok: true };
}
