// Agent sessions: one durable, traceable run per @mention
// (docs/archive/architecture/agent-mentions-2026-10-22.md §1–2, §5).
//
//   startSession   a person sends a mention → one session (idempotent: same
//                  note + block + revision = same row); the AGENT_SESSION_STARTED
//                  event is the root of everything the session later writes.
//   markDelivered  the runner pulled it (queued → delivered).
//   appendEvent    the runner's progress log; kind "ack" → running.
//   finish         the runner's final answer: the SERVER writes the reply
//                  block under the mention (D4), or records the failure.
//   cancel         the person stops it.
//   expireOverdue  the sweep that fails what ran past its deadline.
//   setRunnerEnabled  the per-agent kill switch.
//
// Status contract (a status says what Onden knows, nothing more):
//   queued     persisted. NOT "a runner has it".
//   delivered  a runner token claimed it (pull). NOT "work started".
//   running    the runner acked it.
//   completed  the agent's output is handed over: the reply is IN THE NOTE
//              (reply_event_id set; status changes in the same transaction that
//              wrote it), or, for an agent set to suggest, kept on the session
//              (reply_markdown) for the person to insert as a suggestion
//              (insertReplyAsSuggestion). Never "the note was changed" by itself.
//   failed / cancelled  terminal, with fail_code for failed.
// Allowed moves: queued → delivered → running → completed; completed from
// delivered too (a runner may skip the ack); failed / cancelled from any
// open status. A terminal row never changes: every move is one guarded
// UPDATE … WHERE status = ANY(from), so a race between finish and cancel is
// decided by the database and the loser gets "session_ended".
//
// Events: AGENT_SESSION_STARTED (the person, through the spine) and
// AGENT_SESSION_ENDED (actor_type 'system': a server-detected fact — timeouts,
// kill switch — emitted for every end so the trail is uniform). The progress
// log (agent_session_events) is NOT a domain event stream: it never syncs and
// is never restored. The prompt text is not in either event (length only).

import { replyBlock, replyBlockId } from "./agentReplyBlock.js";
export { replyBlockId };
import { randomUUID } from "node:crypto";
import { AI_MENTION_ALIAS, findMentions, isMentionHandle, normalizeText, parseMention, type Mention, type MentionTarget, cutToUnits } from "@onden/markdown";
import { ensureBlockAnchor, noteAnchorRanges } from "./blockAnchors/index.js";
import { getWorkspaceId, q, withSavepoint, withTransaction } from "../db.js";
import type { ActorCtx } from "../types.js";
import { config } from "../config.js";
import { AuthorityError, isWorkspaceOwner, reviewAuthority } from "../spine/authority.js";
import { getTool } from "./agentTools/index.js";
import { readableTitles } from "./agentSessionMemory.js";
import { mutate, runCascade, UnauthorizedError } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { IdempotentReplay } from "../spine/idempotency.js";
import { createToken } from "./agentTokens.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { prompt as renderPrompt, skills as skillCatalogue } from "./harness/index.js";
import { ScopeError } from "../spine/toolScope.js";
import { NodeUpdateError, updateNode } from "./nodeUpdate.js";
import { eventChain } from "./eventChain.js";
import { canReadNode, readableNodeIdSet } from "./readPolicy.js";
import { eventAudience, eventVisible } from "./eventVisibility.js";
import { reviewEvents, type ReviewOutcome } from "./eventReview.js";
import { AUDIT_EVENT_TYPES } from "./inboxQueue.js";
import { AgentSessionError } from "./agentSessionError.js";
import { createSuggestions, rejectSuggestionItems } from "./aiSuggestions.js";
import { undoAgentRun } from "./history/index.js";
import { CodedStatusError } from "../statusError.js";
import { abortLive, chooseRuntime, endLive, ensureLive, pushPreview, pushStep, runtimeFor } from "./agentRuntime/index.js";
import { deliverSelectionResult } from "./selectionDelivery.js";

export { AgentSessionError };
import {
  sessionIsOpen, OPEN, SESSION_COLS, RUNNER_COLS, SESSION_STATUSES, LOG_TEXT_MAX, endSession, loadRunner, loadSession, runnerAvailable,
  type AgentRunner, type AgentSession,
} from "./agentSessionStore.js";
import { renderSessionPrompt } from "./agentSessionPrompt.js";
import type { SessionStatus } from "@onden/contract";
import { liveNodeSql } from "../spine/nodeSql.js";

export { SESSION_STATUSES, LOG_TEXT_MAX, endSession, loadRunner, loadSession, runnerAvailable, renderSessionPrompt };

/** End a session and close any in-memory SSE live preview channel for it (keeps agentSessionStore cycle-free). */
async function closeSession(...args: Parameters<typeof endSession>): ReturnType<typeof endSession> {
  const ended = await endSession(...args);
  if (ended) endLive(args[1]);
  return ended;
}
export type { AgentRunner, AgentSession };

export const PROMPT_MAX = 4_000;
export const REPLY_MAX = 20_000;
export const LOG_SEQ_MAX = 2_000;
const LOG_KINDS = ["ack", "thought", "action", "message", "error", "result"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

/** ONDEN_AGENT_SESSIONS=off turns the whole feature off (new sessions, claims). */
export function agentSessionsEnabled(): boolean {
  return !config.is("ONDEN_AGENT_SESSIONS", "off");
}
export function assertSessionsEnabled(): void {
  if (!agentSessionsEnabled()) throw new AgentSessionError("sessions_off", "agent sessions are turned off on this server", 409);
}

async function mustLoad(sessionId: string, forUpdate = false): Promise<AgentSession> {
  const session = await loadSession(sessionId, { forUpdate });
  if (!session) throw new AgentSessionError("not_found", "session not found", 404);
  return session;
}

// ── runner configuration and the kill switch ────────────────────────────────

/** Give an agent its @handle and limits (workspace owner only). The runner is
 *  created disabled: turning it on is setRunnerEnabled's explicit act. */
export async function configureRunner(
  workspaceId: string,
  agentActorId: string,
  config: { handle: string; maxConcurrent?: number; maxPerHour?: number; timeoutSeconds?: number },
  { actor }: { actor: ActorCtx },
): Promise<AgentRunner> {
  if (!isMentionHandle(config.handle)) {
    throw new AgentSessionError("invalid_runner", "handle: lower case letters, digits, _ or -, 1–32 characters, not a reserved word", 422);
  }
  const positive = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n > 0 && n <= 100_000);
  if (![config.maxConcurrent, config.maxPerHour, config.timeoutSeconds].every(positive)) {
    throw new AgentSessionError("invalid_runner", "limits must be positive integers", 422);
  }
  return mutate({
    actor, workspaceId,
    authority: { kind: "principal_admin" },
    event: { type: "AGENT_RUNNER_CONFIGURED", targetType: "actor", targetId: agentActorId, payload: { handle: config.handle } },
    apply: async () => {
      const agent = await q(`SELECT 1 FROM actors WHERE id = $1 AND workspace_id = $2 AND type = 'agent'`, [agentActorId, workspaceId]);
      if (agent.rows.length === 0) throw new AgentSessionError("invalid_runner", "not an agent of this workspace", 422);
      const clash = await q(`SELECT 1 FROM agent_runners WHERE workspace_id = $1 AND handle = $2 AND actor_id <> $3`, [workspaceId, config.handle, agentActorId]);
      if (clash.rows.length > 0) throw new AgentSessionError("handle_taken", "another agent already uses this handle", 409);
      const r = await q<AgentRunner>(
        `INSERT INTO agent_runners (actor_id, workspace_id, handle, max_concurrent, max_per_hour, timeout_seconds)
         VALUES ($1, $2, $3, COALESCE($4, 2), COALESCE($5, 30), COALESCE($6, 600))
         ON CONFLICT (actor_id) DO UPDATE SET handle = EXCLUDED.handle,
           max_concurrent = COALESCE($4, agent_runners.max_concurrent),
           max_per_hour = COALESCE($5, agent_runners.max_per_hour),
           timeout_seconds = COALESCE($6, agent_runners.timeout_seconds)
         RETURNING ${RUNNER_COLS}`,
        [agentActorId, workspaceId, config.handle, config.maxConcurrent ?? null, config.maxPerHour ?? null, config.timeoutSeconds ?? null],
      );
      return r.rows[0]!;
    },
  });
}

/** The per-agent kill switch. Disabling cancels every open session of the
 *  agent and revokes their tokens in the same transaction, so a running
 *  session's next call is a 401. Faster than revoking the resident token. */
export async function setRunnerEnabled(
  workspaceId: string,
  agentActorId: string,
  enabled: boolean,
  { actor }: { actor: ActorCtx },
): Promise<{ runner: AgentRunner; cancelled: number }> {
  return mutate({
    actor, workspaceId,
    authority: { kind: "principal_admin" },
    event: { type: "AGENT_RUNNER_TOGGLED", targetType: "actor", targetId: agentActorId, payload: { enabled } },
    apply: async () => {
      const r = await q<AgentRunner>(`UPDATE agent_runners SET enabled = $3 WHERE workspace_id = $1 AND actor_id = $2 RETURNING ${RUNNER_COLS}`,
        [workspaceId, agentActorId, enabled]);
      if (!r.rows[0]) throw new AgentSessionError("unknown_agent", "this agent has no @handle yet", 404);
      let cancelled = 0;
      if (!enabled) {
        const open = await q<{ id: string }>(
          `SELECT id::text FROM agent_sessions WHERE agent_actor_id = $1 AND status = ANY($2::text[]) ORDER BY created_at FOR UPDATE`,
          [agentActorId, OPEN]);
        for (const row of open.rows) {
          if (await closeSession(workspaceId, row.id, "cancelled", { failCode: "agent_disabled", endedBy: actor.id })) cancelled++;
        }
      }
      return { runner: r.rows[0], cancelled };
    },
  });
}

/** The agents with an @handle, for the owner's settings. */
export async function listRunners(workspaceId: string, { actor }: { actor: ActorCtx }): Promise<Array<AgentRunner & { name: string }>> {
  if (!(await isWorkspaceOwner(actor))) throw new AuthorityError("principal_admin", "only the workspace owner manages agent runners");
  return (await q<AgentRunner & { name: string }>(
    `SELECT r.*, a.name FROM (SELECT ${RUNNER_COLS} FROM agent_runners) r JOIN actors a ON a.id = r.actor_id::uuid
      WHERE r.workspace_id = $1 ORDER BY r.handle`, [workspaceId])).rows;
}

// ── ending a session (the one place status becomes terminal) ────────────────

/** Fail every open session past its deadline (queued ones nobody claimed too).
 *  Run by the sweep in index.ts. Returns how many it ended. */
export async function expireOverdue(): Promise<number> {
  const overdue = await q<{ id: string; workspace_id: string }>(
    `SELECT id::text, workspace_id::text FROM agent_sessions WHERE status = ANY($1::text[]) AND deadline_at < now()`, [OPEN]);
  let ended = 0;
  for (const row of overdue.rows) {
    if (await closeSession(row.workspace_id, row.id, "failed", { failCode: "timed_out" })) ended++;
  }
  return ended;
}

// ── starting a session ──────────────────────────────────────────────────────

/** Carries an existing session out of a rolled-back start attempt. */
class ExistingSession extends Error {
  constructor(readonly session: AgentSession) { super("existing_session"); }
}

/** Who may send to an agent: the workspace owner, or the person who issued the
 *  agent's resident token (the agent's owner — whose AI account the client
 *  spends, proposal §4.4). */
export async function mayDirect(initiator: ActorCtx, agentActorId: string): Promise<boolean> {
  if (await isWorkspaceOwner(initiator)) return true;
  const issued = await q(
    `SELECT 1 FROM agent_tokens WHERE actor_id = $1 AND issued_by = $2 AND session_id IS NULL AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
    [agentActorId, initiator.id]);
  return issued.rows.length > 0;
}

/** The agent can write in the note's space and that space lets external AI in:
 *  the same two facts a session token's reach rests on (spaceScope.ts). */
export async function agentCanWriteSpace(agentActorId: string, spaceId: string): Promise<boolean> {
  const r = await q(
    `SELECT 1 FROM space_members m JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
      WHERE m.actor_id = $1 AND m.space_id = $2 AND m.permission = 'edit'
        AND s.capabilities->>'external_ai' = 'true'`,
    [agentActorId, spaceId]);
  return r.rows.length > 0;
}

async function latestSession(workspaceId: string, nodeId: string, anchor: string): Promise<AgentSession | null> {
  return (await q<AgentSession>(
    `SELECT ${SESSION_COLS} FROM agent_sessions s
      WHERE s.workspace_id = $1 AND s.node_id = $2 AND s.anchor_block_id = $3 ORDER BY s.revision DESC LIMIT 1`,
    [workspaceId, nodeId, anchor])).rows[0] ?? null;
}

export type StartInput = {
  /** The person pressing send: a session cookie actor, never a token (D1). */
  actor: ActorCtx;
  nodeId: string;
  /** Which mention: its block's anchor id, or its block text while it has none. */
  target: MentionTarget;
  /** Send the same mention again: a new revision; open earlier ones are cancelled. */
  resend?: boolean;
};

/** Send a mention. One mention = one session: sending it again (double click,
 *  second device, a retry after a lost response) returns the existing session
 *  with created:false. The prompt is parsed HERE from the note as it is now,
 *  never taken from the client.
 *
 *  Refused before anything is written: not a person (human_required), the
 *  initiator may not write the note (AuthorityError), unknown / disabled /
 *  rate-limited agent, the agent cannot write the note's space, the initiator
 *  is not the agent's owner, prompt empty or over PROMPT_MAX, `/skill` that is
 *  none of the sender's own skill notes (skill_not_found) or several
 *  (skill_ambiguous: never guessed).
 *
 *  startSession(ws, { actor, nodeId, target: { blockId: "s7k2" } }) */
export async function startSession(workspaceId: string, input: StartInput): Promise<{ session: AgentSession; created: boolean }> {
  assertSessionsEnabled();
  const { actor, nodeId, target } = input;
  if (actor.type !== "human" || actor.tokenScope) {
    throw new AgentSessionError("human_required", "only a person can send a mention to an agent", 403);
  }
  try {
    const session = await mutate({
      actor, workspaceId,
      authority: { kind: "node", nodeId, op: "write_node" },
      event: {
        type: "AGENT_SESSION_STARTED", targetType: "agent_session", targetId: randomUUID(),
        payload: { node_id: nodeId },
        txMeta: { ui_context: "agent.session.start" },
      },
      apply: async ({ eventId }) => createSession(workspaceId, input, eventId),
    });
    return { session, created: true };
  } catch (error) {
    if (error instanceof ExistingSession) return { session: error.session, created: false };
    // The same Idempotency-Key committed before: that attempt made the session.
    if (error instanceof IdempotentReplay) {
      const existing = await sessionForTarget(workspaceId, nodeId, target);
      if (existing) return { session: existing, created: false };
    }
    throw error;
  }
}

async function sessionForTarget(workspaceId: string, nodeId: string, target: MentionTarget): Promise<AgentSession | null> {
  const note = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, nodeId])).rows[0];
  const mention = note ? parseMention(note.markdown, target, await noteAnchorRanges(workspaceId, nodeId)) : null;
  return mention && mention !== "ambiguous" && mention.blockId ? latestSession(workspaceId, nodeId, mention.blockId) : null;
}


/** `@agent /[[title]]` → the sender's own skill note with exactly that title
 *  (harness/noteSkills.ts decides which notes count: the sender's own, readable,
 *  in a space that lets external AI in). Two with one title are refused with
 *  their ids, never picked between. */
async function resolveMentionSkill(actor: ActorCtx, workspaceId: string, title: string): Promise<string> {
  const wanted = normalizeText(title);
  const hits = (await skillCatalogue(actor, workspaceId)).filter((skill) => skill.kind === "note" && normalizeText(skill.name) === wanted);
  if (hits.length === 0) throw new AgentSessionError("skill_not_found", `no skill note of yours is titled "${title}"`, 422);
  if (hits.length > 1) {
    throw new AgentSessionError("skill_ambiguous", `several skill notes are titled "${title}" (${hits.map((h) => h.id).join(", ")}); rename one`, 422);
  }
  return hits[0]!.id;
}

/** The write half of startSession; runs inside its mutate() (event lock held,
 *  actor re-read). Throws ExistingSession to discard its own STARTED event. */
async function createSession(workspaceId: string, input: StartInput, rootEventId: string): Promise<AgentSession> {
  const { actor, nodeId, target } = input;
  const note = (await q<{ id: string; space_id: string; markdown: string }>(
    `SELECT id::text, space_id::text, markdown FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()} FOR UPDATE`, [workspaceId, nodeId])).rows[0];
  if (!note) throw new AgentSessionError("not_found", "note not found", 404);

  const found = parseMention(note.markdown, target, await noteAnchorRanges(workspaceId, nodeId));
  if (found === "ambiguous") throw new AgentSessionError("mention_ambiguous", "several blocks read the same; give the block id", 409);
  if (!found) throw new AgentSessionError("mention_not_found", "no @mention at that place in the note", 404);
  const mention: Mention = found;

  const runner = await resolveMentionRunner(workspaceId, mention.handle, { actor, spaceId: note.space_id });
  if (!runner) throw new AgentSessionError("unknown_agent", `no agent answers to @${mention.handle}`, 404);
  if (!runnerAvailable(runner)) throw new AgentSessionError("agent_disabled", `@${mention.handle} is switched off`, 409);
  const skillNodeId = mention.skill ? await resolveMentionSkill(actor, workspaceId, mention.skill.title) : null;
  if (mention.prompt.length > PROMPT_MAX) throw new AgentSessionError("prompt_too_long", `the prompt is over ${PROMPT_MAX} characters`, 422);
  // A skill is itself the request ("@ai /[[摘要論文]]"); without one, the mention needs words.
  if (!mention.prompt && !mention.leadIn && !mention.skill) throw new AgentSessionError("empty_prompt", "write something after the @mention", 422);
  if (!(await mayDirect(actor, runner.actor_id))) {
    throw new AgentSessionError("not_agents_owner", "only the agent's owner can send it a mention", 403);
  }
  if (!(await agentCanWriteSpace(runner.actor_id, note.space_id))) {
    throw new AgentSessionError("agent_cannot_write", "the agent cannot write in this note's space (membership, or the space keeps external AI out)", 422);
  }

  const { runtime, model } = await chooseRuntime(runner, "mention");

  // One mention, one session: an existing block id with a session answers it.
  const prior = mention.blockId ? await latestSession(workspaceId, nodeId, mention.blockId) : null;
  if (prior && !input.resend) throw new ExistingSession(prior);
  const recent = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_sessions WHERE agent_actor_id = $1 AND created_at > now() - interval '1 hour'`, [runner.actor_id]);
  if (recent.rows[0]!.n >= runner.max_per_hour) {
    throw new AgentSessionError("agent_rate_limited", `@${mention.handle} reached ${runner.max_per_hour} sessions in the last hour`, 429);
  }

  // The mention needs an anchor to be found again; a plain paragraph has none, so sending makes one (the anchor table:
  // nothing is written into the note's text).
  const anchor = mention.blockId ?? await ensureBlockAnchor(workspaceId, nodeId, note.markdown, mention.blockStart, { actor });
  if (!anchor) throw new AgentSessionError("mention_not_found", "no paragraph to anchor the @mention to", 404);

  if (prior) {
    for (const open of (await q<{ id: string }>(
      `SELECT id::text FROM agent_sessions WHERE workspace_id = $1 AND node_id = $2 AND anchor_block_id = $3 AND status = ANY($4::text[]) FOR UPDATE`,
      [workspaceId, nodeId, anchor, OPEN])).rows) {
      await closeSession(workspaceId, open.id, "cancelled", { failCode: "superseded", endedBy: actor.id });
    }
  }
  const parent = (await q<{ id: string }>(
    `SELECT id::text FROM agent_sessions WHERE workspace_id = $1 AND node_id = $2 AND status = 'completed' ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, nodeId])).rows[0];

  const created = await q<AgentSession>(
    `INSERT INTO agent_sessions AS s
       (workspace_id, agent_actor_id, initiator_id, node_id, space_id, anchor_block_id, revision, parent_session_id,
        prompt, lead_in, skill_node_id, root_event_id, deadline_at, runtime, model, write_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::bigint, now() + make_interval(secs => $13), $14, $15, $16)
     RETURNING ${SESSION_COLS}`,
    [workspaceId, runner.actor_id, actor.id, nodeId, note.space_id, anchor, (prior?.revision ?? 0) + 1, parent?.id ?? null,
      mention.prompt, mention.leadIn, skillNodeId, rootEventId, runner.timeout_seconds,
      runtime, model, runtime === "api" ? "suggest" : "apply"]);
  // Hand it over inside this transaction: the hand-over commits or rolls back with the session.
  await runtimeFor(runtime).dispatch(created.rows[0]!);
  return created.rows[0]!;
}

// ── the runner's side ───────────────────────────────────────────────────────

/** The runner token must be the session's own (session token of this agent). */
function assertSessionActor(actor: ActorCtx, session: AgentSession): void {
  if (actor.id !== session.agent_actor_id || actor.tokenScope?.sessionId !== session.id) {
    throw new AgentSessionError("forbidden", "this token does not belong to this session", 403);
  }
}

/** queued → delivered, claimed by this resident runner token. A lost response
 *  can be retried by the SAME token while the session is still `delivered`
 *  (attempt increases; the caller revokes the previous session token). Null:
 *  already taken by someone else, or no longer open. */
export async function markDelivered(sessionId: string, runnerTokenId: string): Promise<AgentSession | null> {
  const r = await q<AgentSession>(
    `UPDATE agent_sessions s SET status = 'delivered', attempt = s.attempt + 1, claimed_by_token_id = $2,
            delivered_at = COALESCE(s.delivered_at, now())
      WHERE s.id = $1 AND s.deadline_at > now()
        AND (s.status = 'queued' OR (s.status = 'delivered' AND s.claimed_by_token_id = $2))
      RETURNING ${SESSION_COLS}`,
    [sessionId, runnerTokenId]);
  return r.rows[0] ?? null;
}

/** Append a progress line. Re-sending the same seq changes nothing. kind "ack"
 *  moves delivered → running. Texts are cut at LOG_TEXT_MAX. */
export async function appendEvent(
  sessionId: string,
  entry: { actor: ActorCtx; seq: number; kind: LogKind; text?: string; tool?: string; targetId?: string },
): Promise<{ status: SessionStatus; deduped: boolean }> {
  const session = await mustLoad(sessionId);
  assertSessionActor(entry.actor, session);
  if (!sessionIsOpen(session.status)) throw new AgentSessionError("session_ended", `session is ${session.status}`, 409);
  if (!Number.isInteger(entry.seq) || entry.seq < 0 || entry.seq > LOG_SEQ_MAX || !(LOG_KINDS as readonly string[]).includes(entry.kind)) {
    throw new AgentSessionError("invalid_log", "seq must be 0–2000 and kind a known kind", 400);
  }
  const body = entry.kind === "action"
    ? { tool: cutToUnits(entry.tool ?? "", 100), target_id: cutToUnits(entry.targetId ?? "", 100) }
    : { text: cutToUnits(entry.text ?? "", LOG_TEXT_MAX) };
  const inserted = await q(
    `INSERT INTO agent_session_events (session_id, seq, kind, body) VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id, seq) DO NOTHING RETURNING seq`,
    [sessionId, entry.seq, entry.kind, body]);
  let status = session.status;
  if (entry.kind === "ack") {
    const moved = await q<{ status: SessionStatus }>(
      `UPDATE agent_sessions SET status = 'running', acked_at = now() WHERE id = $1 AND status = 'delivered' RETURNING status`, [sessionId]);
    if (moved.rows[0]) status = "running";
    if (session.runtime === "mcp") ensureLive(sessionId);
  }
  const deduped = (inserted.rowCount ?? 0) === 0;
  if (!deduped && session.runtime === "mcp") {
    if (entry.kind === "action") {
      ensureLive(sessionId);
      const tool = cutToUnits(entry.tool ?? "", 100);
      const targetId = cutToUnits(entry.targetId ?? "", 100);
      const title = targetId ? (await readableTitles(entry.actor, session.workspace_id, [targetId]).catch(() => new Map<string, string>())).get(targetId) ?? null : null;
      const access = getTool(tool)?.access;
      pushStep(sessionId, { what: access === "write" ? "write" : /^(search|query)/i.test(tool) ? "search" : "read", title });
    } else if (entry.kind === "message" && entry.text) {
      ensureLive(sessionId);
      pushPreview(sessionId, cutToUnits(entry.text, LOG_TEXT_MAX));
    }
  }
  return { status, deduped };
}

export type SessionLogEntry = { seq: number; kind: LogKind; body: Record<string, unknown>; created_at: string };
export async function sessionLog(sessionId: string): Promise<SessionLogEntry[]> {
  return (await q<SessionLogEntry>(
    `SELECT seq, kind, body, created_at FROM agent_session_events WHERE session_id = $1 ORDER BY seq`, [sessionId])).rows;
}

const FAIL_CODE = /^[a-z][a-z0-9_]{0,39}$/;

export type FinishInput =
  | { actor: ActorCtx; status: "completed"; markdown: string }
  | { actor: ActorCtx; status: "failed"; failCode?: string };

export type FinishResult = { session: AgentSession; replayed: boolean };

/** The runner is done. completed: the SERVER writes `markdown` as a quoted
 *  reply under the mention (D4) — through updateNode, as the agent, with the
 *  session's root event as cause — and only then marks the session completed,
 *  in one transaction. Sent again after completing, it changes nothing
 *  (replayed: true); a reply block already in the note is never inserted
 *  twice. If the reply cannot be written because the note is gone or the
 *  agent lost write rights, the session ends failed(reply_rejected).
 *  A session whose agent did nothing but reply is marked reviewed so it does
 *  not fill the inbox; any other write of the session keeps the whole chain
 *  waiting for review, reply included. */
export async function finish(sessionId: string, input: FinishInput): Promise<FinishResult> {
  const probe = await mustLoad(sessionId);
  assertSessionActor(input.actor, probe);
  const { workspace_id: workspaceId } = probe;
  return withEventTransaction(workspaceId, async () => {
    const session = await mustLoad(sessionId, true);
    if (input.status === "completed" && session.status === "completed") return { session, replayed: true };
    if (!sessionIsOpen(session.status)) throw new AgentSessionError("session_ended", `session is ${session.status}`, 409);
    if (input.status === "failed") {
      const code = input.failCode && FAIL_CODE.test(input.failCode) ? input.failCode : "agent_error";
      return { session: (await closeSession(workspaceId, sessionId, "failed", { failCode: code }))!, replayed: false };
    }
    if (session.status === "queued") throw new AgentSessionError("not_claimable", "the session was never claimed", 409);
    const text = input.markdown.trim();
    if (!text) throw new AgentSessionError("invalid_log", "markdown is empty", 400);
    if (text.length > REPLY_MAX) throw new AgentSessionError("reply_too_long", `the reply is over ${REPLY_MAX} characters`, 422);

    // A selection action: the text replaces the selected text as one pending suggestion.
    if (session.kind === "selection_action") {
      try {
        await withSavepoint(() => deliverSelectionResult(session, input.actor, text));
      } catch (error) {
        if (!(error instanceof AgentSessionError)) throw error;
        return { session: (await closeSession(workspaceId, sessionId, "failed", { failCode: error.code }))!, replayed: false };
      }
      const done = await closeSession(workspaceId, sessionId, "completed");
      if (!done) throw new AgentSessionError("session_ended", "session ended while finishing", 409);
      return { session: done, replayed: false };
    }
    // An agent set to suggest never writes the note: the reply waits on the
    // session and the person decides whether it goes in (a suggestion). An answer in the
    // info panel always waits there, whatever the agent is set to: it was never an @mention reply.
    if (session.kind === "panel_chat" || input.actor.tokenScope?.writeMode === "suggest") {
      await q(`UPDATE agent_sessions SET reply_markdown = $2 WHERE id = $1`, [sessionId, text]);
      const done = await closeSession(workspaceId, sessionId, "completed");
      if (!done) throw new AgentSessionError("session_ended", "session ended while finishing", 409);
      return { session: { ...done, reply_markdown: text }, replayed: false };
    }
    let replyEventId: string | null;
    try {
      replyEventId = await withSavepoint(() => writeReply(session, input.actor, text));
    } catch (error) {
      const refused = error instanceof AuthorityError || error instanceof ScopeError || error instanceof UnauthorizedError
        || (error instanceof NodeUpdateError && error.status === 404);
      if (!refused) throw error;
      return { session: (await closeSession(workspaceId, sessionId, "failed", { failCode: "reply_rejected" }))!, replayed: false };
    }
    const done = await closeSession(workspaceId, sessionId, "completed", { replyEventId });
    if (!done) throw new AgentSessionError("session_ended", "session ended while finishing", 409);
    if (replyEventId) await approveIfReplyOnly(session, replyEventId);
    return { session: done, replayed: false };
  });
}

/** Whether the note already holds the reply block: the anchor `id` is a valid one of it. */
async function hasReplyAnchor(workspaceId: string, nodeId: string, id: string): Promise<boolean> {
  return (await noteAnchorRanges(workspaceId, nodeId)).some((a) => a.id === id);
}

/** The note with the reply block under the mention (at its block group's end), or at the note's end when the
 *  mention is gone; and where the block starts and what it says, for the anchor it takes. */
function withReplyBlock(
  noteMarkdown: string, session: AgentSession, anchor: string, agentName: string, markdown: string,
  anchors: ReadonlyArray<{ id: string; from: number }>,
): { markdown: string; block: string; at: number } {
  const block = replyBlock(agentName, markdown);
  const mention = parseMention(noteMarkdown, { blockId: anchor }, anchors);
  if (mention && mention !== "ambiguous") {
    const head = noteMarkdown.slice(0, mention.groupEnd) + "\n\n";
    return { markdown: head + block + noteMarkdown.slice(mention.groupEnd), block, at: head.length };
  }
  const head = noteMarkdown.replace(/\s+$/, "") + "\n\n";
  return { markdown: head + block + "\n", block, at: head.length };
}

/** Insert the reply under the mention (at its block group's end), or at the
 *  note's end when the mention is gone. Returns the NODE_UPDATED event id, or
 *  null when the reply block was already there. */
async function writeReply(session: AgentSession, actor: ActorCtx, markdown: string): Promise<string | null> {
  const { workspace_id: workspaceId, node_id: nodeId, anchor_block_id: anchor } = session;
  if (!anchor) throw new AgentSessionError("mention_not_found", "this session has no @mention to answer under", 404);
  const note = (await q<{ markdown: string }>(
    `SELECT markdown FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()} FOR UPDATE`, [workspaceId, nodeId])).rows[0];
  if (!note) throw new NodeUpdateError("node not found", 404);
  const id = replyBlockId(anchor, session.revision);
  if (await hasReplyAnchor(workspaceId, nodeId, id)) return null;

  const placed = withReplyBlock(note.markdown, session, anchor, actor.name, markdown, await noteAnchorRanges(workspaceId, nodeId));
  const body = placed.markdown;
  const authority = { kind: "node", nodeId, op: "write_node" } as const;
  const saved = await runCascade(
    { actor, workspaceId, authority, causeEventId: session.root_event_id ?? undefined },
    () => updateNode(workspaceId, nodeId, { markdown: body }, {
      actor, baseMarkdown: note.markdown, adoptAnchors: [{ anchorId: id, text: placed.block, at: placed.at, kind: "new" }],
      event: {
        uiContext: "agent.session.reply", txMeta: { session_id: session.id, token_id: actor.tokenScope?.tokenId },
        cascadeLabel: "agent.session.reply.cascade", backupPrefix: "NODE_UPDATED",
      },
    }),
  );
  return saved.eventId;
}

/** A person puts a suggest-mode agent's reply into the note: not a write but
 *  ONE suggestion (an insert under the mention) they then accept in the note.
 *  Only the sender or the owner, who can edit the note. Sent again it returns
 *  the same suggestion; a reply already in the note, or none kept, files nothing
 *  (suggestionId null).
 *
 *  insertReplyAsSuggestion(sessionId, { actor }) */
export async function insertReplyAsSuggestion(sessionId: string, { actor }: { actor: ActorCtx }): Promise<{ suggestionId: string | null }> {
  const session = await sessionView(sessionId, { actor });
  if (session.status !== "completed" || !session.reply_markdown) return { suggestionId: null };
  const workspaceId = session.workspace_id;
  const note = (await q<{ markdown: string }>(
    `SELECT markdown FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`, [workspaceId, session.node_id])).rows[0];
  if (!note) throw new AgentSessionError("not_found", "note not found", 404);
  if (!session.anchor_block_id) throw new AgentSessionError("mention_not_found", "this session has no @mention to answer under", 404);
  const id = replyBlockId(session.anchor_block_id, session.revision);
  if (await hasReplyAnchor(workspaceId, session.node_id, id)) return { suggestionId: null };
  const created = await createSuggestions(workspaceId, {
    actor,
    proposer: { agentActorId: session.agent_actor_id, sessionId: session.id },
    nodeId: session.node_id,
    proposedMarkdown: withReplyBlock(note.markdown, session, session.anchor_block_id, session.agent_name ?? "", session.reply_markdown,
      await noteAnchorRanges(workspaceId, session.node_id)).markdown,
  });
  return { suggestionId: created.suggestionId };
}

/** Reply-only session → reviewed (the person asked for this reply). Anything
 *  else the agent wrote in the session leaves the chain in the inbox. */
async function approveIfReplyOnly(session: AgentSession, replyEventId: string): Promise<void> {
  if (!session.root_event_id) return;
  const chain = (await eventChain(session.workspace_id, session.root_event_id)).map((e) => e.id);
  const others = await q(
    `SELECT 1 FROM domain_events e LEFT JOIN event_reviews r ON r.event_id = e.id
      WHERE e.id = ANY($1::bigint[]) AND e.id <> $2::bigint AND e.actor_type = 'ai_agent'
        AND e.event_type <> ALL($3::text[]) AND r.event_id IS NULL LIMIT 1`,
    [chain, replyEventId, AUDIT_EVENT_TYPES]);
  if (others.rows.length > 0) return;
  await q(
    `INSERT INTO event_reviews (event_id, workspace_id, decision, reviewed_by, note)
     VALUES ($1::bigint, $2, 'approved', $3, 'session_reply') ON CONFLICT (event_id) DO NOTHING`,
    [replyEventId, session.workspace_id, session.initiator_id]);
}


// ── the pull side: what a resident runner token sees and takes ──────────────

/** The resident token of the agent (not a session token). */
function assertRunnerActor(actor: ActorCtx): void {
  if (actor.type !== "agent" || !actor.tokenScope || actor.tokenScope.sessionId) {
    throw new AgentSessionError("forbidden", "only the agent's own (non-session) token can pull sessions", 403);
  }
}

export type PendingSession = {
  id: string; node_id: string; anchor_block_id: string; revision: number; status: SessionStatus;
  prompt_preview: string; created_at: string; deadline_at: string; attempt: number;
};

/** Sessions this runner token can take now: the agent's queued ones, plus ones
 *  this very token claimed but may not have heard back about (retry after a
 *  lost response). Only this agent's, only before their deadline. */
export async function pendingSessions(actor: ActorCtx): Promise<PendingSession[]> {
  assertRunnerActor(actor);
  const runner = await loadRunner(await getWorkspaceId(), { actorId: actor.id });
  if (!agentSessionsEnabled() || !runner || !runnerAvailable(runner)) return [];
  const r = await q<PendingSession & { prompt: string }>(
    `SELECT s.id::text, s.node_id::text, s.anchor_block_id, s.revision, s.status, s.prompt, s.created_at, s.deadline_at, s.attempt
       FROM agent_sessions s
      WHERE s.agent_actor_id = $1 AND s.deadline_at > now() AND s.runtime <> 'api'
        AND (s.status = 'queued' OR (s.status = 'delivered' AND s.claimed_by_token_id = $2))
      ORDER BY s.created_at LIMIT 20`,
    [actor.id, actor.tokenScope!.tokenId]);
  return r.rows.map(({ prompt, ...row }) => ({ ...row, prompt_preview: cutToUnits(prompt, 80) }));
}

export type ClaimPayload = {
  session: { id: string; node_id: string; anchor_block_id: string | null; revision: number; attempt: number; deadline_at: string };
  agent: { actor_id: string; handle: string; name: string };
  initiator: { actor_id: string };
  note: { id: string; space_id: string };
  prompt: string; lead_in: string;
  skill: { id: string } | null;
  /** What the model is asked, ready to run: the skill's system prompt and the
   *  note as data followed by the request. */
  rendered: { system: string; messages: Array<{ role: string; content: string }> };
  /** The session token, shown once: the only credential the run needs. */
  mcp: { path: string; token: string };
  callbacks: { events: string; finish: string };
};

/** Take a session: queued → delivered, mint the session token (one space — the
 *  note's —, the agent's tools, issued by the sender so it never reaches beyond
 *  the sender's spaces, expiring with the session) and render the prompt.
 *  A retry by the same runner token (the response was lost) revokes the earlier
 *  session token and mints a new one. Refused: someone else holds it, it is no
 *  longer open, the agent already has max_concurrent running (429, try later),
 *  or the note's space no longer lets the agent in — which ends the session
 *  failed(space_unavailable) rather than leaving it to time out.
 *
 *  claimSession(id, { actor })  // actor: the agent's resident token */
export async function claimSession(sessionId: string, { actor }: { actor: ActorCtx }): Promise<ClaimPayload> {
  assertSessionsEnabled();
  assertRunnerActor(actor);
  const session = await loadSession(sessionId);
  if (!session || session.agent_actor_id !== actor.id) throw new AgentSessionError("not_found", "session not found", 404);
  const workspaceId = session.workspace_id;
  const runner = await loadRunner(workspaceId, { actorId: actor.id });
  if (!runner || !runnerAvailable(runner)) throw new AgentSessionError("agent_disabled", "this agent is switched off", 409);
  if (!sessionIsOpen(session.status) || session.status === "running") {
    throw new AgentSessionError("not_claimable", `session is ${session.status}`, 409);
  }
  // An api session is run by the server itself (services/agentRuntime/api); no runner may take it.
  if (session.runtime === "api") throw new AgentSessionError("not_claimable", "this session runs on the server", 409);

  if (!(await agentCanWriteSpace(actor.id, session.space_id))) {
    await closeSession(workspaceId, sessionId, "failed", { failCode: "space_unavailable" });
    throw new AgentSessionError("space_unavailable", "the agent can no longer write in this note's space", 409);
  }
  const busy = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_sessions WHERE agent_actor_id = $1 AND status IN ('delivered','running') AND id <> $2`,
    [actor.id, sessionId]);
  if (busy.rows[0]!.n >= runner.max_concurrent) {
    throw new AgentSessionError("too_many_running", `${runner.max_concurrent} sessions are already running`, 429);
  }

  const taken = await withTransaction(async () => {
    const delivered = await markDelivered(sessionId, actor.tokenScope!.tokenId);
    if (!delivered) return null;
    await q(`UPDATE agent_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`, [sessionId]);
    const token = await createToken(actor.id, {
      name: `session ${sessionId}`,
      access: actor.tokenScope!.access, allowedTools: actor.tokenScope!.allowedTools,
      expiresAt: delivered.deadline_at, issuedBy: delivered.initiator_id, sessionId,
    });
    return { delivered, token };
  });
  if (!taken) throw new AgentSessionError("not_claimable", "someone else holds this session, or it is no longer open", 409);

  const { delivered, token } = taken;
  let rendered: ClaimPayload["rendered"];
  let skill: ClaimPayload["skill"] = null;
  try {
    const runnerActor = await resolveCurrentActor({ id: actor.id, tokenScope: { tokenId: token.id } }, workspaceId);
    rendered = await renderSessionPrompt(delivered, runnerActor);
    if (delivered.skill_node_id) skill = { id: delivered.skill_node_id };
  } catch (error) {
    // The note cannot be sent (unreadable, external AI off): say so now.
    await closeSession(workspaceId, sessionId, "failed", { failCode: "cannot_read_note" });
    throw new AgentSessionError("cannot_read_note", error instanceof Error ? error.message : "the note cannot be sent to the agent", 409);
  }
  return {
    session: { id: delivered.id, node_id: delivered.node_id, anchor_block_id: delivered.anchor_block_id, revision: delivered.revision, attempt: delivered.attempt, deadline_at: delivered.deadline_at },
    agent: { actor_id: actor.id, handle: runner.handle, name: actor.name },
    initiator: { actor_id: delivered.initiator_id },
    note: { id: delivered.node_id, space_id: delivered.space_id },
    prompt: delivered.prompt, lead_in: delivered.lead_in, skill, rendered,
    mcp: { path: "/api/mcp/protocol", token: token.plaintext },
    callbacks: { events: `/api/mcp/sessions/${sessionId}/events`, finish: `/api/mcp/sessions/${sessionId}/finish` },
  };
}

// ── the person's side ───────────────────────────────────────────────────────

/** Stop a session. The sender or the workspace owner may; cancelling twice is
 *  fine (changed:false). A session that already completed or failed answers
 *  session_ended: the cancel lost the race. */
export async function cancel(sessionId: string, { actor }: { actor: ActorCtx }): Promise<{ session: AgentSession; changed: boolean }> {
  if (actor.tokenScope) throw new AgentSessionError("human_required", "only a person can cancel a session", 403);
  const probe = await mustLoad(sessionId);
  // isWorkspaceOwner below asks about THIS deployment's workspace: a session of another workspace is not here, or its
  // owner's say would be that workspace's owner's (the event transaction below opens the SESSION's workspace).
  if (probe.workspace_id !== await getWorkspaceId()) throw new AgentSessionError("not_found", "session not found", 404);
  if (probe.initiator_id !== actor.id && !(await isWorkspaceOwner(actor))) {
    throw new AgentSessionError("forbidden", "only the sender or the owner can cancel this session", 403);
  }
  return withEventTransaction(probe.workspace_id, async () => {
    const session = await mustLoad(sessionId, true);
    if (session.status === "cancelled") return { session, changed: false };
    const ended = await closeSession(probe.workspace_id, sessionId, "cancelled", { failCode: "cancelled_by_user", endedBy: actor.id });
    if (!ended) throw new AgentSessionError("session_ended", `session is ${session.status}`, 409);
    abortLive(sessionId); // an api run in this process stops paying for the answer nobody wants
    return { session: ended, changed: true };
  });
}

// ── reading, listing, reverting (the person's side, continued) ──────────────

/** What a person sees of a session: the row, the agent's handle and its log.
 *  Only the sender or the workspace owner, and only while they can read the
 *  note (the prompt quotes it). Anyone else: not_found, never "forbidden". */
export type SessionView = AgentSession & { agent_handle: string | null; agent_name: string | null; log: SessionLogEntry[] };

export async function sessionView(sessionId: string, { actor }: { actor: ActorCtx }): Promise<SessionView> {
  const session = await loadSession(sessionId);
  const visible = !!session && !actor.tokenScope
    && (session.initiator_id === actor.id || await isWorkspaceOwner(actor))
    && await canReadNode(actor, session.node_id);
  if (!session || !visible) throw new AgentSessionError("not_found", "session not found", 404);
  const runner = await loadRunner(session.workspace_id, { actorId: session.agent_actor_id });
  const agentName = (await q<{ name: string }>(`SELECT name FROM actors WHERE id = $1`, [session.agent_actor_id])).rows[0]?.name ?? null;
  return { ...session, agent_handle: runner?.handle ?? null, agent_name: agentName, log: await sessionLog(sessionId) };
}

/** The newest session of each mention in a note that `actor` may see (the
 *  sender's own; the owner sees all), without logs: what the editor draws
 *  under each @mention when the note opens. */
export type SessionBrief = AgentSession & { agent_handle: string | null; agent_name: string | null };

export async function sessionsForNode(workspaceId: string, nodeId: string, { actor }: { actor: ActorCtx }): Promise<SessionBrief[]> {
  if (actor.tokenScope || !(await canReadNode(actor, nodeId))) throw new AgentSessionError("not_found", "note not found", 404);
  const owner = await isWorkspaceOwner(actor);
  const rows = await q<SessionBrief>(
    `SELECT DISTINCT ON (s.anchor_block_id) ${SESSION_COLS}, r.handle AS agent_handle, a.name AS agent_name
       FROM agent_sessions s
       LEFT JOIN agent_runners r ON r.actor_id = s.agent_actor_id
       LEFT JOIN actors a ON a.id = s.agent_actor_id
      WHERE s.workspace_id = $1 AND s.node_id = $2 AND ($3::boolean OR s.initiator_id = $4)
      ORDER BY s.anchor_block_id, s.revision DESC`, [workspaceId, nodeId, owner, actor.id]);
  return rows.rows;
}

export type Mentionable = { actor_id: string; handle: string; name: string; available: boolean; reason: "disabled" | "agent_cannot_write" | "not_agents_owner" | null };

/** Every agent with a handle, oldest agent first, each with why sending to it
 *  would not work now (the three checks startSession makes), null when it would. */
async function runnersFor(workspaceId: string, actor: ActorCtx, spaceId: string): Promise<Array<{ runner: AgentRunner; name: string; reason: Mentionable["reason"] }>> {
  const runners = await q<AgentRunner & { name: string }>(
    `SELECT r.*, a.name FROM (SELECT ${RUNNER_COLS} FROM agent_runners) r JOIN actors a ON a.id = r.actor_id::uuid
      WHERE r.workspace_id = $1 ORDER BY a.created_at, r.handle`, [workspaceId]);
  const out: Array<{ runner: AgentRunner; name: string; reason: Mentionable["reason"] }> = [];
  for (const runner of runners.rows) {
    const reason = !runnerAvailable(runner) || !agentSessionsEnabled() ? "disabled"
      : !(await agentCanWriteSpace(runner.actor_id, spaceId)) ? "agent_cannot_write"
      : !(await mayDirect(actor, runner.actor_id)) ? "not_agents_owner" : null;
    out.push({ runner, name: runner.name, reason });
  }
  return out;
}

/** The agent `@ai` stands for in this space: the oldest one this person can send
 *  to right now; when none can, the oldest at all, so the usual check names what
 *  is wrong (switched off, not in the space, not theirs). */
export const defaultAgentOf = <T extends { reason: Mentionable["reason"] }>(rows: T[]): T | null => rows.find((r) => r.reason === null) ?? rows[0] ?? null;

/** `@handle` → its agent. An agent that owns the handle `ai` wins over the alias. */
async function resolveMentionRunner(workspaceId: string, handle: string, { actor, spaceId }: { actor: ActorCtx; spaceId: string }): Promise<AgentRunner | null> {
  const named = await loadRunner(workspaceId, { handle });
  if (named || handle !== AI_MENTION_ALIAS) return named;
  return defaultAgentOf(await runnersFor(workspaceId, actor, spaceId))?.runner ?? null;
}

/** The agents `actor` could @mention in this note, each with whether sending
 *  would work now and, when not, why, so the editor can grey an entry out
 *  instead of failing on send. `defaultActorId` is the agent `@ai` means here
 *  (null when the space has no agent at all). */
export async function mentionablesFor(workspaceId: string, nodeId: string, { actor }: { actor: ActorCtx }): Promise<{ agents: Mentionable[]; defaultActorId: string | null }> {
  if (actor.tokenScope || !(await canReadNode(actor, nodeId))) throw new AgentSessionError("not_found", "note not found", 404);
  const note = (await q<{ space_id: string }>(`SELECT space_id::text FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`, [workspaceId, nodeId])).rows[0];
  if (!note) throw new AgentSessionError("not_found", "note not found", 404);
  const rows = await runnersFor(workspaceId, actor, note.space_id);
  const named = rows.find((r) => r.runner.handle === AI_MENTION_ALIAS);
  return {
    agents: rows.map((r) => ({ actor_id: r.runner.actor_id, handle: r.runner.handle, name: r.name, available: r.reason === null, reason: r.reason })),
    defaultActorId: (named ?? defaultAgentOf(rows))?.runner.actor_id ?? null,
  };
}

export type RevertResult = { reverted: number; skipped: Array<{ event_id: string; code: string; detail: string }> };

/** Undo everything a finished session did, newest first, in one transaction:
 *  the reply block and every other write of the agent in the session's chain
 *  (the inbox's group reject, which this is — reviewed or not). Each undo is the
 *  restore contract's: a note the person edited after the agent is NOT
 *  overwritten; that write is reported in `skipped` and stays. Needs the review
 *  authority (owner / reviewer) and an ended session: cancel a running one first.
 *  For an agent set to suggest it also turns down every place still pending and
 *  takes back the places already accepted (History's run undo: the same merge,
 *  a person's later edits stay). */
export async function revertSession(sessionId: string, { actor }: { actor: ActorCtx }): Promise<RevertResult> {
  const session = await sessionView(sessionId, { actor });
  if (actor.tokenScope || !(await reviewAuthority(actor))) {
    throw new AgentSessionError("forbidden", "only the workspace owner or a reviewer can revert an agent's changes", 403);
  }
  if (sessionIsOpen(session.status)) throw new AgentSessionError("session_open", "cancel the session before reverting it", 409);
  const written = await revertChainWrites(session, actor);
  const suggested = await revertSuggestions(session, actor);
  return { reverted: written.reverted + suggested.reverted, skipped: [...written.skipped, ...suggested.skipped] };
}

async function revertChainWrites(session: SessionView, actor: ActorCtx): Promise<RevertResult> {
  if (!session.root_event_id) return { reverted: 0, skipped: [] };
  const chain = (await eventChain(session.workspace_id, session.root_event_id)).map((e) => e.id);
  const written = await q<{ id: string; target_type: string; target_id: string; actor_id: string; payload: Record<string, unknown> | null; tx_meta: unknown }>(
    `SELECT id::text, target_type, target_id, actor_id, payload, tx_meta FROM domain_events
      WHERE id = ANY($1::bigint[]) AND actor_type = 'ai_agent' AND event_type <> ALL($2::text[]) ORDER BY domain_events.id`,
    [chain, AUDIT_EVENT_TYPES]);
  // The same visibility rule as the inbox: an event the person may not see is not theirs to undo.
  const audience = await eventAudience(actor, session.workspace_id, await readableNodeIdSet(actor, session.workspace_id));
  const members = written.rows.filter((e) => eventVisible(e, audience)).map((e) => e.id);
  if (members.length === 0) return { reverted: 0, skipped: [] };
  const outcomes: ReviewOutcome[] = await reviewEvents(actor, session.workspace_id, members, "reject", { group: { rootEventId: session.root_event_id } });
  return {
    reverted: outcomes.filter((o) => o.status === "decided").length,
    skipped: outcomes.flatMap((o) => (o.status === "restore_failed" ? [{ event_id: o.eventId, code: o.code, detail: o.detail }] : [])),
  };
}

/** The suggestions of this session: pending places rejected, accepted places taken back. */
async function revertSuggestions(session: SessionView, actor: ActorCtx): Promise<RevertResult> {
  const workspaceId = session.workspace_id;
  const pending = await q<{ id: string }>(
    `SELECT s.id::text FROM ai_edit_suggestions s
      WHERE s.session_id = $1 AND EXISTS (SELECT 1 FROM ai_edit_suggestion_items i WHERE i.suggestion_id = s.id AND i.status = 'pending')`,
    [session.id]);
  for (const row of pending.rows) {
    try {
      await rejectSuggestionItems(workspaceId, { actor, suggestionId: row.id, itemIds: "all" });
    } catch (error) {
      // A note this person cannot edit or see is not theirs to turn down.
      if (!(error instanceof AuthorityError || error instanceof ScopeError || (error instanceof CodedStatusError && error.status === 404))) throw error;
    }
  }
  const accepted = await q<{ id: string; target_id: string }>(
    `SELECT id::text, target_id FROM domain_events
      WHERE workspace_id = $1 AND event_type = 'NODE_UPDATED' AND tx_meta->'suggested_by'->>'session_id' = $2
        AND tx_meta->>'undoes_agent_run' IS NULL ORDER BY domain_events.id`, [workspaceId, session.id]);
  if (accepted.rows.length === 0) return { reverted: 0, skipped: [] };
  const nodeIds = [...new Set(accepted.rows.map((e) => e.target_id))];
  const outcome = await undoAgentRun(workspaceId, session.id, nodeIds, { actor });
  const lastEvent = new Map(accepted.rows.map((e) => [e.target_id, e.id]));
  return {
    reverted: outcome.undone.length,
    skipped: [...outcome.skipped, ...outcome.conflicts].map((nodeId) => ({
      event_id: lastEvent.get(nodeId)!, code: "state_conflict", detail: "the note was edited after the accepted suggestion; those edits were kept",
    })),
  };
}
