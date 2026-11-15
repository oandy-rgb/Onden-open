// How an AI role is executed (docs/architecture/proposals/ai-collaboration-2026-10-27.md §4.1).
//
// One role, two ways to run it. The runtime decides only WHO executes and what
// that costs; the tools (agentTools registry), the write path (spine/mutate) and
// the session log are the same for all three, so changing a role's runtime never
// changes what the role is allowed to do.
//
//   api           the server calls the model with the owner's own API key
//                 (services/agentRuntime/api). It can only PROPOSE changes.
//   mcp           the owner's own AI client connects with the role's token: opened by hand, or
//                 kept on some machine where it polls for queued sessions and claims them
//                 (routes/mcpSessions.ts). Either way Onden only waits for it.
import type { AgentRunner, AgentSession } from "../agentSessionStore.js";

export type RuntimeKind = "api" | "mcp";
export const RUNTIME_KINDS: readonly RuntimeKind[] = ["api", "mcp"];
export const isRuntimeKind = (value: unknown): value is RuntimeKind =>
  typeof value === "string" && (RUNTIME_KINDS as readonly string[]).includes(value);

/** Why a runtime cannot be used right now. Codes, not sentences: the UI turns
 *  them into one plain sentence each (lib/serverErrors.ts); they are never shown. */
export type UnavailableReason =
  | "no_secret_key"        // api: the server has no ONDEN_SECRET_KEY, so it cannot keep keys
  | "no_key"               // api: the workspace has no live API key at all
  | "key_unchosen"         // api: keys exist but this role has none chosen (or its key was revoked)
  | "no_model"             // api: no model chosen (there is no default)
  | "model_retired"        // api: the chosen model was retired — choose another
  | "cap_unanswered"       // api: monthly cap or "unlimited" was never chosen
  | "cap_reached"          // api: this month's token limit is used up
  | "external_ai_off"      // api: no space lets this role in with external AI on
  | "agent_disabled"       // the role's kill switch is off
  | "no_token";            // mcp: the role has no live token

export type Availability = { ok: true } | { ok: false; reason: UnavailableReason };

/** A role as the runtime layer sees it: the agent_runners row. */
export type AiRole = AgentRunner;

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  /** Can this role run this way now? Computed from facts, never a stored flag. */
  availability(role: AiRole): Promise<Availability>;
  /** Hand a persisted (queued) session over. Resolves when handed over, NOT when
   *  finished. Runs inside the transaction that created the session, so the hand-over
   *  commits or rolls back with it. */
  dispatch(session: AgentSession): Promise<void>;
}
