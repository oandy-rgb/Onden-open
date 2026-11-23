// An AI role's way of running, for the owner's settings (proposal §3.1, §5.6).
//
//   roleRuntimes(ws, { actor })        every role with what each runtime can do now
//   setRoleRuntime(ws, id, input, …)   choose the runtime and, for the API, key + model + limits
//
//   setRoleReviewRule(ws, id, rule, …) "show me first" (suggest) or "edit directly" (apply)
//   touchRunnerSeen(actorId)           a client polled for queued sessions just now
//
// The runtime does not change what the role may do — only who executes it and who
// pays — so permissions and spaces stay where they were (spine/spaceAccess.ts).
// There is NO default model: the API needs one the owner picked from the key's list.
import type { ActorCtx, WriteMode } from "../types.js";
import { q } from "../db.js";
import { db } from "../dbKysely.js";
import { mutate } from "../spine/mutate.js";
import { AuthorityError, isWorkspaceOwner, requirePerson } from "../spine/authority.js";
import { AgentSessionError } from "./agentSessionError.js";
import { loadRunner, setRunnerEnabled, type AgentRunner } from "./agentSessions.js";
import { credentialLive } from "./aiCredentials.js";
import { secretKeyConfigured } from "./serverSecret.js";
import {
  isRuntimeKind, listModels, monthTokensUsed, runtimeAvailability,
  type ApiModel, type RuntimeKind, type UnavailableReason,
} from "./agentRuntime/index.js";

export type RoleRuntimes = {
  actor_id: string; handle: string; name: string; enabled: boolean;
  default_runtime: RuntimeKind;
  /** `last_seen_at`: mcp = the later of the last poll for queued sessions and the last call made with
   *  one of the role's keys, api = null. Facts for the settings page to word. */
  runtimes: Array<{ kind: RuntimeKind; available: boolean; unavailable_reason: UnavailableReason | null; last_seen_at: string | null }>;
  /** What the role's edits do: `suggest` = shown to the owner first, `apply` = written
   *  directly (undoable from history). `review_rule_locked`: runs through the API, where
   *  edits are always suggestions whatever this says (the rule still applies to its MCP keys). */
  review_rule: WriteMode; review_rule_locked: boolean;
  /** Per shared space; a space the role is not in is absent. */
  spaces: Record<string, "view" | "edit">;
  /** This UTC month. Tokens as the runtimes reported them; the money is only present
   *  when every API session ran on a key whose owner wrote prices for it. */
  usage_this_month: { input_tokens: number; output_tokens: number; cost_estimate_micro_usd: number | null };
  api: {
    model: string | null; model_retired: boolean; small_actions_only: boolean; web_search: boolean;
    credential_id: string | null; key_label: string | null; key_last4: string | null;
    cap: "capped" | "unlimited" | null; monthly_cap_tokens: number | null; used_this_month_tokens: number;
  } | null;
};

const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);
const latest = (a: Date | string | null, b: Date | string | null): Date | string | null => (!a ? b : !b ? a : new Date(a) >= new Date(b) ? a : b);

async function monthUsage(workspaceId: string) {
  const rows = (await q<{ agent_actor_id: string; input: number; output: number; api_sessions: number; api_unpriced: number; api_cost: number }>(
    `SELECT agent_actor_id::text, COALESCE(SUM(input_tokens), 0)::float8 AS input, COALESCE(SUM(output_tokens), 0)::float8 AS output,
            COUNT(*) FILTER (WHERE runtime = 'api')::int AS api_sessions,
            COUNT(*) FILTER (WHERE runtime = 'api' AND cost_estimate_micro_usd IS NULL)::int AS api_unpriced,
            COALESCE(SUM(cost_estimate_micro_usd) FILTER (WHERE runtime = 'api'), 0)::float8 AS api_cost
       FROM agent_sessions
      WHERE workspace_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      GROUP BY agent_actor_id`, [workspaceId])).rows;
  return new Map(rows.map((r) => [r.agent_actor_id, {
    input_tokens: r.input, output_tokens: r.output,
    cost_estimate_micro_usd: r.api_sessions > 0 && r.api_unpriced === 0 ? r.api_cost : null,
  }]));
}

export async function roleRuntimes(workspaceId: string, { actor }: { actor: ActorCtx }): Promise<RoleRuntimes[]> {
  requirePerson(actor, "ai_role");
  if (!(await isWorkspaceOwner(actor))) throw new AuthorityError("principal_admin", "only the workspace owner manages AI roles");
  const usage = await monthUsage(workspaceId);
  const memberships = (await q<{ actor_id: string; space_id: string; permission: "view" | "edit" }>(
    `SELECT m.actor_id::text, m.space_id::text, m.permission FROM space_members m JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
      WHERE s.workspace_id = $1 AND m.actor_id IN (SELECT actor_id FROM agent_runners WHERE workspace_id = $1)`, [workspaceId])).rows;
  const mcpSeen = new Map((await db.selectFrom("agent_tokens")
    .select(["actor_id", (eb) => eb.fn.max("last_used_at").as("seen")])
    .where("session_id", "is", null).where("revoked_at", "is", null).groupBy("actor_id").execute()).map((r) => [r.actor_id, r.seen]));
  const rows = (await q<{ actor_id: string; name: string; write_mode: WriteMode; credential_id: string | null; key_label: string | null; key_last4: string | null }>(
    `SELECT r.actor_id::text, a.name, a.write_mode, c.id::text AS credential_id, c.label AS key_label, c.secret_last4 AS key_last4
       FROM agent_runners r JOIN actors a ON a.id = r.actor_id
       LEFT JOIN ai_credentials c ON c.id = r.api_credential_id AND c.revoked_at IS NULL
      WHERE r.workspace_id = $1 ORDER BY r.handle`, [workspaceId])).rows;
  const out: RoleRuntimes[] = [];
  for (const row of rows) {
    const role = (await loadRunner(workspaceId, { actorId: row.actor_id }))!;
    const runtimes = (await runtimeAvailability(role)).map((r) => ({
      kind: r.kind, available: r.ok, unavailable_reason: r.ok ? null : r.reason,
      last_seen_at: r.kind === "mcp" ? iso(latest(role.runner_seen_at, mcpSeen.get(row.actor_id) ?? null)) : null,
    }));
    // The api section exists only where the api runtime does (a key and the server's secret).
    const apiShown = runtimes.some((r) => r.kind === "api");
    out.push({
      actor_id: role.actor_id, handle: role.handle, name: row.name, enabled: role.enabled,
      default_runtime: role.default_runtime, runtimes,
      review_rule: row.write_mode, review_rule_locked: role.default_runtime === "api",
      spaces: Object.fromEntries(memberships.filter((m) => m.actor_id === row.actor_id).map((m) => [m.space_id, m.permission])),
      usage_this_month: usage.get(row.actor_id) ?? { input_tokens: 0, output_tokens: 0, cost_estimate_micro_usd: null },
      api: apiShown ? {
        model: role.api_model, model_retired: role.api_model_retired_at !== null,
        small_actions_only: role.api_small_actions_only, web_search: role.api_web_search,
        credential_id: row.credential_id, key_label: row.key_label, key_last4: row.key_last4,
        cap: role.api_cap_choice, monthly_cap_tokens: role.monthly_cap_tokens,
        used_this_month_tokens: await monthTokensUsed(role.actor_id),
      } : null,
    });
  }
  return out;
}

export type RuntimeInput = {
  defaultRuntime?: RuntimeKind;
  api?: {
    credentialId?: string; model?: string;
    smallActionsOnly?: boolean; webSearch?: boolean;
    /** The first time the API is switched on the owner must answer this: a monthly
     *  cap in USD, or explicitly unlimited. */
    cap?: { kind: "unlimited" } | { kind: "capped"; tokens: number };
    /** The key's model list, when the caller already asked the service (before opening a transaction): then it is not
     *  asked again here. Only server code passes it; never taken from a request. */
    knownModels?: ApiModel[];
  };
};

const invalid = (message: string) => new AgentSessionError("invalid_api_settings", message, 422);

export async function setRoleRuntime(
  workspaceId: string, agentActorId: string, input: RuntimeInput, { actor }: { actor: ActorCtx },
): Promise<AgentRunner> {
  requirePerson(actor, "ai_role");
  if (!(await isWorkspaceOwner(actor))) throw new AuthorityError("principal_admin", "only the workspace owner manages AI roles");
  const role = await loadRunner(workspaceId, { actorId: agentActorId });
  if (!role) throw new AgentSessionError("unknown_agent", "this agent has no @handle yet", 404);
  if (input.defaultRuntime !== undefined && !isRuntimeKind(input.defaultRuntime)) throw invalid("unknown runtime");

  const api = input.api ?? {};
  const next = {
    runtime: input.defaultRuntime ?? role.default_runtime,
    credentialId: api.credentialId ?? role.api_credential_id,
    model: api.model ?? role.api_model,
    smallOnly: api.smallActionsOnly ?? role.api_small_actions_only,
    webSearch: api.webSearch ?? role.api_web_search,
    capChoice: api.cap ? api.cap.kind : role.api_cap_choice,
    capTokens: api.cap ? (api.cap.kind === "capped" ? Math.round(api.cap.tokens) : null) : role.monthly_cap_tokens,
  };
  if (api.cap?.kind === "capped" && !(api.cap.tokens >= 1 && api.cap.tokens <= 1e12)) throw invalid("the monthly limit must be a positive number of tokens");
  const modelChanged = api.model !== undefined && api.model !== role.api_model;
  const keyChanged = api.credentialId !== undefined && api.credentialId !== role.api_credential_id;

  if (next.runtime === "api") {
    if (!secretKeyConfigured()) {
      throw new AgentSessionError("runtime_unavailable", "the API cannot be used on this server yet", 409);
    }
    if (!next.credentialId || !(await credentialLive(workspaceId, next.credentialId))) throw invalid("choose an API key");
    if (!next.model) throw invalid("choose a model; there is no default");
    if (!next.capChoice) throw invalid("choose a monthly cap or unlimited");
    if (next.capChoice === "capped" && !next.capTokens) throw invalid("the monthly limit must be a positive number of tokens");
    if (modelChanged || keyChanged || input.defaultRuntime === "api") {
      // The model must exist for THIS key and not be retired: asked of the key, not of a list kept here.
      const models = api.knownModels ?? await listModels(workspaceId, next.credentialId).catch(() => {
        throw new AgentSessionError("model_unavailable", "the model list could not be read with this key", 409);
      });
      const found = models.find((m) => m.id === next.model);
      if (!found || found.lifecycle === "retired") throw new AgentSessionError("model_unavailable", "that model is not available for this key", 409);
    }
  } else if (next.credentialId && keyChanged && !(await credentialLive(workspaceId, next.credentialId))) {
    throw invalid("that API key is not available");
  }

  return mutate({
    actor, workspaceId,
    authority: { kind: "principal_admin" },
    event: {
      type: "AI_ROLE_RUNTIME_SET", targetType: "actor", targetId: agentActorId,
      // Settings only; never a key. The model id is the owner's own choice.
      payload: { default_runtime: next.runtime, api_model: next.model, api_small_actions_only: next.smallOnly, api_web_search: next.webSearch, api_cap: next.capChoice },
    },
    apply: async () => (await q<{ actor_id: string }>(
      `UPDATE agent_runners SET default_runtime = $3, api_credential_id = $4, api_model = $5,
              api_small_actions_only = $6, api_web_search = $7, api_cap_choice = $8, monthly_cap_tokens = $9,
              api_model_retired_at = CASE WHEN $10::boolean THEN NULL ELSE api_model_retired_at END
        WHERE workspace_id = $1 AND actor_id = $2 RETURNING actor_id::text`,
      [workspaceId, agentActorId, next.runtime, next.credentialId, next.model, next.smallOnly, next.webSearch,
        next.capChoice, next.capTokens, modelChanged])).rows[0] && (await loadRunner(workspaceId, { actorId: agentActorId }))!,
  });
}

const REVIEW_RULES: readonly WriteMode[] = ["suggest", "apply"];
export const isReviewRule = (value: unknown): value is WriteMode => REVIEW_RULES.includes(value as WriteMode);

/** How the role's edits take effect. The rule lives on the agent (actors.write_mode),
 *  where mutate() reads it for every token of the role; a role that runs through the API
 *  stays suggest-only whatever is stored (agentRuntime/api/actor.ts). Switching to `apply`
 *  changes nothing already suggested; what it writes later is undone from history. */
export async function setRoleReviewRule(
  workspaceId: string, agentActorId: string, rule: WriteMode, { actor }: { actor: ActorCtx },
): Promise<WriteMode> {
  requirePerson(actor, "ai_role");
  if (!isReviewRule(rule)) throw invalid("unknown review rule");
  return mutate({
    actor, workspaceId,
    authority: { kind: "principal_admin" },
    event: { type: "AI_ROLE_REVIEW_RULE_SET", targetType: "actor", targetId: agentActorId, payload: { review_rule: rule } },
    apply: async () => {
      const r = await q<{ write_mode: WriteMode }>(
        `UPDATE actors SET write_mode = $3 WHERE id = $2 AND workspace_id = $1 AND type = 'agent'
            AND EXISTS (SELECT 1 FROM agent_runners WHERE actor_id = $2) RETURNING write_mode`, [workspaceId, agentActorId, rule]);
      if (!r.rows[0]) throw new AgentSessionError("unknown_agent", "this agent has no @handle yet", 404);
      return r.rows[0].write_mode;
    },
  });
}

/** A client just polled for queued sessions. Diagnostic only (no event): part of the mcp runtime's "last seen". Written at most every 10 seconds per role. */
export async function touchRunnerSeen(agentActorId: string): Promise<void> {
  await q(`UPDATE agent_runners SET runner_seen_at = now()
            WHERE actor_id = $1 AND (runner_seen_at IS NULL OR runner_seen_at < now() - interval '10 seconds')`, [agentActorId]);
}

export type RolePatch = { reviewRule?: WriteMode; defaultRuntime?: RuntimeKind; enabled?: boolean };

/** The role-level switches the settings page flips one at a time. Every change is its
 *  own recorded event; what cannot be done (an API role without key and model) is
 *  refused before the first one is written. The API's own details stay in setRoleRuntime. */
export async function patchRole(
  workspaceId: string, agentActorId: string, patch: RolePatch, { actor }: { actor: ActorCtx },
): Promise<void> {
  requirePerson(actor, "ai_role");
  if (!(await isWorkspaceOwner(actor))) throw new AuthorityError("principal_admin", "only the workspace owner manages AI roles");
  if (!(await loadRunner(workspaceId, { actorId: agentActorId }))) throw new AgentSessionError("unknown_agent", "this agent has no @handle yet", 404);
  if (patch.defaultRuntime !== undefined) await setRoleRuntime(workspaceId, agentActorId, { defaultRuntime: patch.defaultRuntime }, { actor });
  if (patch.reviewRule !== undefined) await setRoleReviewRule(workspaceId, agentActorId, patch.reviewRule, { actor });
  if (patch.enabled !== undefined) await setRunnerEnabled(workspaceId, agentActorId, patch.enabled, { actor });
}
