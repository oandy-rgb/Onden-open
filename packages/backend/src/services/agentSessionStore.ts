// The data shape of an agent session and the few operations everything else builds on:
// reading a session or its role, and ending a session. Kept apart from agentSessions.ts
// (which starts, claims and finishes sessions) so the runtimes in services/agentRuntime,
// which agentSessions starts, can use them without importing agentSessions back.
import { cutToUnits, isUuid } from "@onden/markdown";
import { event, q } from "../db.js";
import { AgentSessionError } from "./agentSessionError.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import type { SessionStatus } from "@onden/contract";

export const SESSION_STATUSES = ["queued", "delivered", "running", "completed", "failed", "cancelled"] as const satisfies readonly SessionStatus[];
export const OPEN: readonly SessionStatus[] = ["queued", "delivered", "running"];
export const sessionIsOpen = (status: SessionStatus) => OPEN.includes(status);

export const LOG_TEXT_MAX = 2_048;

export type AgentSession = {
  id: string; workspace_id: string; agent_actor_id: string; initiator_id: string;
  node_id: string; space_id: string;
  /** Null for a selection action: it has no @mention to anchor to. */
  anchor_block_id: string | null; revision: number;
  parent_session_id: string | null; prompt: string; lead_in: string; skill_node_id: string | null;
  status: SessionStatus; fail_code: string | null;
  root_event_id: string | null; reply_event_id: string | null;
  /** A suggest-mode agent's reply, not yet in the note (null: written into the note, or no reply). */
  reply_markdown: string | null;
  attempt: number; claimed_by_token_id: string | null;
  /** How it runs and what it may write (services/agentRuntime). write_mode is
   *  fixed by the database for an API session: always 'suggest'. */
  runtime: "api" | "mcp"; kind: "mention" | "selection_action" | "panel_chat";
  model: string | null; skill_ref: string | null; write_mode: "suggest" | "apply";
  turns: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_estimate_micro_usd: number | null;
  created_at: string; delivered_at: string | null; acked_at: string | null; finished_at: string | null; deadline_at: string;
};
export const SESSION_COLS = `s.id::text, s.workspace_id::text, s.agent_actor_id::text, s.initiator_id::text, s.node_id::text,
  s.space_id::text, s.anchor_block_id, s.revision, s.parent_session_id::text, s.prompt, s.lead_in, s.skill_node_id::text,
  s.status, s.fail_code, s.root_event_id::text, s.reply_event_id::text, s.reply_markdown, s.attempt, s.claimed_by_token_id::text,
  s.runtime, s.kind, s.model, s.skill_ref, s.write_mode, s.turns, s.input_tokens::int, s.output_tokens::int, s.cache_read_tokens::int,
  s.cost_estimate_micro_usd::bigint::float8 AS cost_estimate_micro_usd,
  s.created_at, s.delivered_at, s.acked_at, s.finished_at, s.deadline_at`;

export type AgentRunner = {
  actor_id: string; workspace_id: string; handle: string; enabled: boolean; paused_until: string | null;
  max_concurrent: number; max_per_hour: number; timeout_seconds: number;
  /** The role's way of running (services/agentRuntime) and its API settings.
   *  There is no default model: api_model is whatever the owner chose. */
  default_runtime: "api" | "mcp";
  api_credential_id: string | null; api_model: string | null; api_model_retired_at: string | null;
  api_small_actions_only: boolean; api_web_search: boolean;
  api_cap_choice: "capped" | "unlimited" | null; monthly_cap_tokens: number | null;
  /** The last time a client polled for queued sessions (routes/mcpSessions.ts); null = never. Folded into the mcp runtime's last_seen_at. */
  runner_seen_at: Date | null;
};
export const RUNNER_COLS = `actor_id::text, workspace_id::text, handle, enabled, paused_until, max_concurrent, max_per_hour, timeout_seconds,
  default_runtime, api_credential_id::text, api_model, api_model_retired_at, api_small_actions_only, api_web_search, api_cap_choice,
  monthly_cap_tokens::bigint::float8 AS monthly_cap_tokens, runner_seen_at`;

export async function loadSession(sessionId: string, opts: { forUpdate?: boolean } = {}): Promise<AgentSession | null> {
  if (!isUuid(sessionId)) return null;
  const r = await q<AgentSession>(
    `SELECT ${SESSION_COLS} FROM agent_sessions s WHERE s.id = $1${opts.forUpdate ? " FOR UPDATE" : ""}`, [sessionId]);
  return r.rows[0] ?? null;
}

export async function loadRunner(workspaceId: string, by: { handle: string } | { actorId: string }): Promise<AgentRunner | null> {
  const r = "handle" in by
    ? await q<AgentRunner>(`SELECT ${RUNNER_COLS} FROM agent_runners WHERE workspace_id = $1 AND handle = $2`, [workspaceId, by.handle])
    : await q<AgentRunner>(`SELECT ${RUNNER_COLS} FROM agent_runners WHERE workspace_id = $1 AND actor_id = $2`, [workspaceId, by.actorId]);
  return r.rows[0] ?? null;
}

export const runnerAvailable = (runner: AgentRunner): boolean =>
  runner.enabled && !(runner.paused_until && new Date(runner.paused_until).getTime() > Date.now());

const END_FROM: Record<"completed" | "failed" | "cancelled", readonly SessionStatus[]> = {
  completed: ["delivered", "running"],
  failed: OPEN,
  cancelled: OPEN,
};

/** Move an open session to a terminal status, revoke its tokens and record
 *  AGENT_SESSION_ENDED, in the caller's transaction (it opens one if none).
 *  Null when the row was not in an allowed status — someone else ended it. */
export async function endSession(
  workspaceId: string,
  sessionId: string,
  to: "completed" | "failed" | "cancelled",
  opts: { failCode?: string | null; replyEventId?: string | null; endedBy?: string } = {},
): Promise<AgentSession | null> {
  return withEventTransaction(workspaceId, async () => {
    const r = await q<AgentSession>(
      `UPDATE agent_sessions s SET status = $2, fail_code = $3, reply_event_id = COALESCE($4::bigint, s.reply_event_id), finished_at = now()
        WHERE s.id = $1 AND s.status = ANY($5::text[])
        RETURNING ${SESSION_COLS}`,
      [sessionId, to, to === "failed" || to === "cancelled" ? opts.failCode ?? null : null, opts.replyEventId ?? null, END_FROM[to]],
    );
    const session = r.rows[0];
    if (!session) return null;
    await q(`UPDATE agent_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`, [sessionId]);
    const actions = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM agent_session_events WHERE session_id = $1 AND kind = 'action'`, [sessionId])).rows[0]!.n;
    await event(
      workspaceId, "AGENT_SESSION_ENDED", "agent_session", sessionId,
      {
        status: to, fail_code: session.fail_code, node_id: session.node_id, tool_actions: actions,
        wall_seconds: Math.round((new Date(session.finished_at!).getTime() - new Date(session.created_at).getTime()) / 1000),
        ...(opts.endedBy ? { ended_by: opts.endedBy } : {}),
      },
      "system", session.agent_actor_id, { triggeredBy: session.root_event_id ?? undefined },
    );
    return session;
  });
}

/** The skill the AI chose for itself in a session (the loadSkill tool): kept
 *  for the suggestion card's header. A session that was given a named skill
 *  keeps none; the latest choice stands. Bookkeeping like the log, no event. */
export async function recordPickedSkill(
  sessionId: string, workspaceId: string, skill: { id: string; name: string }, reason: string | null,
): Promise<void> {
  await q(
    `UPDATE agent_sessions SET picked_skill_ref = $2, picked_skill_name = $3, picked_skill_reason = $4
      WHERE id = $1 AND workspace_id = $5 AND skill_node_id IS NULL`,
    [sessionId, skill.id, cutToUnits(skill.name, 60), reason ? cutToUnits(reason.replace(/\s+/g, " ").trim(), 200) : null, workspaceId]);
}
