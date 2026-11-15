// Actor types come from the `actors.type` DB column.
// Note: domain_events.actor_type uses a DIFFERENT vocabulary ('user', 'ai_agent', 'system').
// "system" is not a database value: it is the type of a background job's actor
// (spine/systemJobs.ts), made only inside the server. Audit records written
// beside someone else's operation (dispatcher, conflict notes) still pass
// 'system' to event() explicitly; test/guards/systemActor.guard.test.ts lists them.
export type ActorType = "human" | "agent" | "system";

export type TokenAccess = "read" | "write";

/** How an agent's edits to a note take effect. `suggest`: nothing is written;
 *  the edit is saved as a suggestion a person accepts (services/aiSuggestions.ts).
 *  `apply`: written directly, reviewed afterwards in the inbox (the behaviour of
 *  agents that existed before suggestions). Set on the agent (actors.write_mode),
 *  never by a request. */
export type WriteMode = "suggest" | "apply";

// Populated only when the actor was authenticated via a bearer token.
export type TokenScope = {
  tokenId: string;
  /** The tool surface (spine/toolScope.ts): null = unrestricted, [] = none.
   *  Set from `access` when the token is minted or its access changes. */
  allowedTools: string[] | null;
  /** read: the token only reads. write: it may also write, in the spaces its
   *  agent is an editor of (spine/spaceAccess.ts). Which spaces at all is
   *  the agent's own membership, and only those whose external_ai is on. */
  access: TokenAccess;
  /** The agent's own setting, read with the token (spine/currentActor.ts); mutate() enforces it. */
  writeMode: WriteMode;
  expiresAt: Date | null;
  /** The person who issued the token (agent_tokens.issued_by): whose own
   *  notes count as the token's own (skill notes). Null/absent for a token
   *  with no recorded issuer. */
  issuedBy?: string | null;
  /** Set for a session token (agent_tokens.session_id): the one agent session
   *  (services/agentSessions.ts) this token exists for. Null for a resident token. */
  sessionId?: string | null;
};

export interface ActorCtx {
  id: string;
  name: string;
  type: ActorType;
  tokenScope?: TokenScope;
}

// Map ActorCtx.type to the event() actor_type column.
//   human → "user"  (human actor)
//   agent → "ai_agent"  (any non-human actor)
//   system → "system"   (a background job, spine/systemJobs.ts)
export function eventActorType(t: ActorType): "user" | "ai_agent" | "system" {
  return t === "human" ? "user" : t === "system" ? "system" : "ai_agent";
}
