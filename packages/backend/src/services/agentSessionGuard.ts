// What a session token may do while its session runs, checked on every tool
// call (services/agentTools/registry.ts callTool). Kept small and free of the
// session service's imports: the registry loads it.
//
//   - the session must still be open (delivered / running) and before its
//     deadline — the token is revoked and expires with it, this is the second
//     line, and names the reason;
//   - at most SESSION_WRITE_LIMIT writes by the agent in the session's chain
//     (proposal §5.4: a runaway or injected run cannot rewrite the space);
//   - the call runs as part of the session's chain (registry wraps it in
//     runCascade with the root event as cause), so the inbox groups the
//     session's writes and one reject reverts them together.

import { q } from "../db.js";
import { AgentSessionError } from "./agentSessionError.js";
import { eventChain } from "./eventChain.js";
import { AUDIT_EVENT_TYPES } from "./inboxQueue.js";

export const SESSION_WRITE_LIMIT = 50;

/** The session's root event id, or an AgentSessionError when this call must
 *  not run. */
export async function sessionRootForCall(sessionId: string, workspaceId: string): Promise<string | undefined> {
  const row = (await q<{ status: string; root_event_id: string | null; expired: boolean }>(
    `SELECT status, root_event_id::text, deadline_at <= now() AS expired FROM agent_sessions WHERE id = $1`, [sessionId])).rows[0];
  if (!row || (row.status !== "delivered" && row.status !== "running")) {
    throw new AgentSessionError("session_ended", `session is ${row?.status ?? "gone"}`, 409);
  }
  if (row.expired) throw new AgentSessionError("session_ended", "session passed its deadline", 409);
  if (row.root_event_id) {
    const chain = (await eventChain(workspaceId, row.root_event_id)).map((e) => e.id);
    const writes = (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_events WHERE id = ANY($1::bigint[]) AND actor_type = 'ai_agent' AND event_type <> ALL($2::text[])`,
      [chain, AUDIT_EVENT_TYPES])).rows[0]!.n;
    if (writes >= SESSION_WRITE_LIMIT) {
      throw new AgentSessionError("session_write_limit", `a session may write at most ${SESSION_WRITE_LIMIT} times`, 429);
    }
  }
  return row.root_event_id ?? undefined;
}
