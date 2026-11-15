// The runtime registry. Callers ask for a runtime by kind and never branch on it:
//
//   const runtime = runtimeFor(role.default_runtime);
//   const ok = await runtime.availability(role);   // { ok: false, reason } → say why
//   await runtime.dispatch(session);               // inside the transaction that made the session
import { AgentSessionError } from "../agentSessionError.js";
import { apiRuntime } from "./api/index.js";
import { mcpRuntime } from "./mcp.js";
import { RUNTIME_KINDS, type AgentRuntime, type AiRole, type Availability, type RuntimeKind } from "./types.js";

export type { AgentRuntime, AiRole, Availability, RuntimeKind, UnavailableReason } from "./types.js";
export { isRuntimeKind, RUNTIME_KINDS } from "./types.js";

const RUNTIMES: Record<RuntimeKind, AgentRuntime> = { api: apiRuntime, mcp: mcpRuntime };

export const runtimeFor = (kind: RuntimeKind): AgentRuntime => RUNTIMES[kind];

/** Every runtime's availability for a role. `api` is left OUT of the result unless
 *  the server holds ONDEN_SECRET_KEY and the role has a live key: with no way to
 *  run it, the choice does not exist (it is not shown greyed out). */
export async function runtimeAvailability(role: AiRole): Promise<Array<{ kind: RuntimeKind } & Availability>> {
  const rows = await Promise.all(RUNTIME_KINDS.map(async (kind) => ({ kind, ...(await RUNTIMES[kind].availability(role)) })));
  return rows.filter((row) => row.kind !== "api" || row.ok || !API_HIDDEN.has(row.reason));
}

/** Reasons that mean "API is not set up here at all". */
const API_HIDDEN: ReadonlySet<string> = new Set(["no_secret_key", "no_key"]);

/** Which runtime a NEW session of `role` uses, refused before anything is written
 *  when it cannot run. `wanted` is the way chosen for this one action (a selection
 *  action's 「這次用…」); without it the role's default. The api runtime is always
 *  checked; an mcp session queues as it always did (an AI client that is away finds it
 *  when it next comes), except that a `wanted` one must be available now (an mcp role
 *  with no live token has nobody to answer). The api model is snapshotted onto the session so a later
 *  model change does not rewrite what it ran on. */
export async function chooseRuntime(
  role: AiRole, kind: "mention" | "selection_action" | "panel_chat", wanted?: RuntimeKind,
): Promise<{ runtime: RuntimeKind; model: string | null }> {
  const runtime = wanted ?? role.default_runtime;
  if (runtime !== "api") {
    if (wanted) {
      const availability = await RUNTIMES[runtime].availability(role);
      if (!availability.ok) throw new AgentSessionError("runtime_unavailable", `this way of running cannot be used now (${availability.reason})`, 409);
    }
    return { runtime, model: null };
  }
  if (kind !== "selection_action" && role.api_small_actions_only) {
    throw new AgentSessionError("runtime_not_allowed", "this agent uses the API only for small actions on selected text", 409);
  }
  const availability = await RUNTIMES.api.availability(role);
  if (!availability.ok) throw new AgentSessionError("runtime_unavailable", `the API cannot run now (${availability.reason})`, 409);
  return { runtime: "api", model: role.api_model };
}

export { abortLive, followPreview } from "./api/liveRun.js";
export type { LiveEvent, LiveStep } from "./api/liveRun.js";
export { listModels, listModelsWithFormat, failInterruptedApiSessions } from "./api/index.js";
export type { ApiModel } from "./api/index.js";
export { monthTokensUsed } from "./api/limits.js";
export { detectProtocol, isProtocolId, protocolClient, ProtocolError } from "./api/protocols/index.js";
export type { ProtocolId, ProviderModel } from "./api/protocols/index.js";
