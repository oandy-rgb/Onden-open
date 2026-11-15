// The one way a PERSON starts a one-shot AI session on a note: a selection action (「交給 AI」) or a question in
// the info panel's AI tab. What they share — the person must be a person, the request id makes a retry the same
// session, the note is locked, the role is on / theirs / allowed in the note's space, the way of running is
// chosen, the hourly limit holds, the row is inserted and handed to its runtime in the same transaction as the
// AGENT_SESSION_STARTED event — lives here. What differs (the text rules, the scope, the columns) is the caller's:
//
//   startAiSession(ws, { actor, agentActorId, nodeId, requestId, kind: "panel_chat", authorityOp: "read",
//                        prepare: (note) => checkedScope(…),
//                        insert: ({ role, note, runtime, model, eventId, prepared }) => q(`INSERT INTO agent_sessions …`) })
import { randomUUID } from "node:crypto";
import { isUuid } from "@onden/markdown";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { isPerson } from "../spine/authority.js";
import { mutate } from "../spine/mutate.js";
import { AgentSessionError } from "./agentSessionError.js";
import { agentCanWriteSpace, agentSessionsEnabled, loadRunner, mayDirect, runnerAvailable, type AgentRunner, type AgentSession } from "./agentSessions.js";
import { chooseRuntime, runtimeFor, type RuntimeKind } from "./agentRuntime/index.js";
import { liveNodeSql } from "../spine/nodeSql.js";

class ExistingRequest extends Error {
  constructor(readonly sessionId: string) { super("existing_request"); }
}

/** The checks that come before any text or note is looked at. */
export function assertPersonMayStart(actor: ActorCtx, requestId: string): void {
  if (!agentSessionsEnabled()) throw new AgentSessionError("sessions_off", "agent sessions are turned off on this server", 409);
  if (actor.type !== "human" || !isPerson(actor)) throw new AgentSessionError("human_required", "only a person can start an AI action", 403);
  if (!isUuid(requestId)) throw new AgentSessionError("invalid_log", "request_id must be a uuid", 400);
}

/** What differs between the callers' session rows. */
export type SessionRow = {
  /** The selected text, or the question. */
  prompt: string;
  /** A selection action's one-line instruction for this once. */
  leadIn?: string;
  skillNodeId?: string | null;
  skillRef?: string | null;
  /** The turn before this one in an info-panel conversation. */
  parentSessionId?: string | null;
  scopeNodeIds?: string[];
  scopeTagIds?: string[];
};

export async function startAiSession<P = undefined>(
  workspaceId: string,
  input: {
    actor: ActorCtx; agentActorId: string; nodeId: string; requestId: string; runtime?: RuntimeKind;
    kind: "selection_action" | "panel_chat";
    /** The authority the person needs on the note: editing it (a selection is replaced) or reading it (a question). */
    authorityOp: "read" | "write_node";
    /** Extra checks once the note is locked, before the role is looked at; what it returns goes to `row`. */
    prepare?: (note: { id: string; space_id: string; markdown: string }) => Promise<P>;
    /** The columns that are this caller's own. */
    row: (prepared: P) => Promise<SessionRow>;
  },
): Promise<{ sessionId: string; created: boolean }> {
  const { actor, requestId } = input;
  const existing = async () => (await q<{ id: string }>(
    `SELECT id::text FROM agent_sessions WHERE workspace_id = $1 AND initiator_id = $2 AND request_id = $3`, [workspaceId, actor.id, requestId])).rows[0];
  const again = await existing();
  if (again) return { sessionId: again.id, created: false };

  try {
    const session = await mutate({
      actor, workspaceId,
      authority: { kind: "node", nodeId: input.nodeId, op: input.authorityOp },
      event: {
        type: "AGENT_SESSION_STARTED", targetType: "agent_session", targetId: randomUUID(),
        payload: { node_id: input.nodeId, kind: input.kind },
        txMeta: { ui_context: input.kind === "selection_action" ? "agent.session.selection" : `agent.session.${input.kind}` },
      },
      apply: async ({ eventId }): Promise<AgentSession> => {
        const note = (await q<{ id: string; space_id: string; markdown: string }>(
          `SELECT id::text, space_id::text, markdown FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()} FOR UPDATE`, [workspaceId, input.nodeId])).rows[0];
        if (!note) throw new AgentSessionError("not_found", "note not found", 404);
        const prepared = await input.prepare?.(note) as P;
        const role = await loadRunner(workspaceId, { actorId: input.agentActorId });
        if (!role) throw new AgentSessionError("unknown_agent", "no such agent", 404);
        if (!runnerAvailable(role)) throw new AgentSessionError("agent_disabled", "this agent is switched off", 409);
        if (!(await mayDirect(actor, role.actor_id))) throw new AgentSessionError("not_agents_owner", "only the agent's owner can start it", 403);
        if (!(await agentCanWriteSpace(role.actor_id, note.space_id))) {
          throw new AgentSessionError("agent_cannot_write", "the agent cannot work in this note's space (membership, or the space keeps external AI out)", 422);
        }
        const { runtime, model } = await chooseRuntime(role, input.kind, input.runtime);
        const recent = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM agent_sessions WHERE agent_actor_id = $1 AND created_at > now() - interval '1 hour'`, [role.actor_id]);
        if (recent.rows[0]!.n >= role.max_per_hour) throw new AgentSessionError("agent_rate_limited", `reached ${role.max_per_hour} sessions in the last hour`, 429);
        const row = await input.row(prepared);
        // Both kinds only PROPOSE (write_mode 'suggest') and have no @mention to anchor to.
        const inserted = (await q<AgentSession>(
          `INSERT INTO agent_sessions AS s
             (workspace_id, agent_actor_id, initiator_id, node_id, space_id, anchor_block_id, prompt, lead_in, skill_node_id, skill_ref, parent_session_id,
              root_event_id, deadline_at, runtime, kind, model, write_mode, request_id, scope_node_ids, scope_tag_ids)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11::bigint, now() + make_interval(secs => $12), $13, $14, $15, 'suggest', $16, $17, $18)
           ON CONFLICT (workspace_id, initiator_id, request_id) WHERE request_id IS NOT NULL DO NOTHING
           RETURNING s.id::text, s.workspace_id::text, s.root_event_id::text`,
          [workspaceId, role.actor_id, actor.id, input.nodeId, note.space_id, row.prompt, row.leadIn ?? "", row.skillNodeId ?? null, row.skillRef ?? null,
            row.parentSessionId ?? null, eventId, role.timeout_seconds, runtime, input.kind, model, requestId, row.scopeNodeIds ?? [], row.scopeTagIds ?? []])).rows[0];
        if (!inserted) throw new ExistingRequest((await existing())!.id);
        await runtimeFor(runtime).dispatch(inserted);
        return inserted;
      },
    });
    return { sessionId: session.id, created: true };
  } catch (error) {
    if (error instanceof ExistingRequest) return { sessionId: error.sessionId, created: false };
    throw error;
  }
}
