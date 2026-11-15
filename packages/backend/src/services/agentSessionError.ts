// Kept apart from agentSessions.ts so the tool registry and the HTTP boundary can
// name the error without importing the session service (and its note writers).

/** A refusal with a stable machine code; the HTTP boundary (httpError.ts) maps it. */
export class AgentSessionError extends Error {
  constructor(
    public readonly code:
      | "sessions_off" | "human_required" | "not_found" | "mention_not_found" | "mention_ambiguous" | "unknown_agent"
      | "agent_disabled" | "agent_cannot_write" | "not_agents_owner" | "prompt_too_long" | "empty_prompt"
      | "skill_not_found" | "skill_ambiguous" | "session_open" | "agent_rate_limited" | "too_many_running" | "session_ended" | "not_claimable"
      | "forbidden" | "invalid_log" | "invalid_runner" | "handle_taken" | "reply_too_long" | "bad_status"
      | "session_write_limit" | "cannot_read_note" | "space_unavailable"
      | "secret_key_missing" | "invalid_credential" | "invalid_base_url" | "invalid_price" | "credential_rejected" | "service_unreachable" | "protocol_undetected" | "credential_unreadable" | "credential_revoked"
      | "runtime_unavailable" | "runtime_not_allowed" | "invalid_api_settings" | "model_unavailable" | "selection_changed" | "selection_not_found" | "selection_not_unique"
      | "scope_too_big" | "scope_other_space" | "chat_busy",
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 422 | 429,
  ) {
    super(message);
    this.name = "AgentSessionError";
  }
}

/** The refusal for a selection that is not in the note exactly once (`findSelection`). Before the model runs
 *  the person can still fix the selection (422); after the answer it is a conflict with what the note became (409).
 *  Gone after the answer is `selection_changed`: the text was there when it was sent. */
export function selectionError(found: "none" | "several", when: "start" | "delivery" = "delivery"): AgentSessionError {
  const status = when === "start" ? 422 : 409;
  if (found === "several") return new AgentSessionError("selection_not_unique", "the selected text appears more than once in the note", status);
  return when === "start"
    ? new AgentSessionError("selection_not_found", "the selected text is not in the saved note", status)
    : new AgentSessionError("selection_changed", "the selected text changed", status);
}
