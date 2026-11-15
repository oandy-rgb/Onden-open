// Running one api session: our own tool loop over the MCP registry's tools, through a neutral
// format adapter (protocols/), one model turn at a time.
//
// startApiRun() is the outbox effect's perform. It CLAIMS the session exactly once
// (queued → running, one UPDATE) and then runs detached, so a long model run never
// holds the outbox drain. A retry of the effect finds the session no longer queued
// and does nothing; a process that dies mid-run leaves a `running` row that
// failInterruptedApiSessions() ends as failed(interrupted). Nothing is ever re-run
// automatically: that would pay twice for the same request (proposal §4.2).
//
// Every failure ends the session with a short code (agent_sessions.fail_code) and
// nothing from the provider's error text reaches the log, the session or the UI.
import { cutToUnits } from "@onden/markdown";
import { q } from "../../../db.js";
import { log } from "../../../logger.js";
import { credentialLive } from "../../aiCredentials.js";
import { AgentSessionError } from "../../agentSessionError.js";
import { endSession, loadRunner, loadSession, LOG_TEXT_MAX, type AgentSession } from "../../agentSessionStore.js";
import { renderSessionPrompt } from "../../agentSessionPrompt.js";
import { auditedToolArgs } from "../../agentTools/index.js";
import { deliverApiResult } from "./deliver.js";
import { actorForRuntimeSession } from "./actor.js";
import { MAX_OUTPUT_TOKENS, MAX_TURNS, monthTokensUsed } from "./limits.js";
import { markModelRetired } from "./models.js";
import { forgetLog, logLine, recordUsage } from "./usage.js";
import { runToolCall, toolSpecs } from "./tools.js";
import { ProtocolError, type Turn } from "./protocols/index.js";
import { finalText, promptTurns } from "./turns.js";
import { prepareApiRun, Stop } from "./prepare.js";
import { runSelectionAction } from "./selectionAction.js";
import { beginLive, endLive, pushPreview, pushStep, restartPreview } from "./liveRun.js";
import { chatNoteIds } from "../../panelChatPrompt.js";
import { readableTitles } from "../../agentSessionMemory.js";
import { getTool } from "../../agentTools/index.js";
import { aiReadable } from "../../harness/index.js";
import type { ActorCtx } from "../../../types.js";

/** The note or other object a tool call names (its first id argument), for the session log. */
const toolTargetId = (input: unknown): string => {
  const first = Object.values(auditedToolArgs(input).ids).find((v): v is string => typeof v === "string");
  return first ?? "";
};

/** Sessions this process is running. The sweep ends `running` api sessions that are not in it. */
const active = new Set<string>();

/** Take a queued api session and run it in the background. Resolves once claimed. */
export async function startApiRun(sessionId: string): Promise<void> {
  active.add(sessionId);
  let claimed: AgentSession | null = null;
  try {
    const moved = await q<{ id: string }>(
      `UPDATE agent_sessions SET status = 'running', attempt = attempt + 1, acked_at = now()
        WHERE id = $1 AND runtime = 'api' AND status = 'queued' AND deadline_at > now() RETURNING id::text`, [sessionId]);
    if (moved.rows[0]) claimed = await loadSession(sessionId);
  } finally {
    if (!claimed) active.delete(sessionId);
  }
  if (!claimed) return;
  void runClaimed(claimed).finally(() => { active.delete(sessionId); forgetLog(sessionId); });
}

/** Process start / periodic sweep: an api session still `running` that this process
 *  is not running died with its process. It is failed, not re-run. */
export async function failInterruptedApiSessions(): Promise<number> {
  const rows = await q<{ id: string; workspace_id: string }>(
    `SELECT id::text, workspace_id::text FROM agent_sessions WHERE runtime = 'api' AND status = 'running'`);
  let ended = 0;
  for (const row of rows.rows) {
    if (active.has(row.id)) continue;
    if (await endSession(row.workspace_id, row.id, "failed", { failCode: "interrupted" })) ended++;
  }
  return ended;
}

/** The failure code an error maps to. Codes only; the text is dropped. */
export function failCodeFor(error: unknown): string {
  if (error instanceof Stop) return error.code;
  if (error instanceof AgentSessionError) return error.code;
  if (error instanceof ProtocolError) return error.code;
  return "agent_error";
}

async function runClaimed(session: AgentSession): Promise<void> {
  try {
    const text = session.kind === "selection_action" ? await runSelectionAction(session) : await runToolLoop(session);
    const actor = await actorForRuntimeSession(session);
    await deliverApiResult(session, actor, text);
    await endSession(session.workspace_id, session.id, "completed");
  } catch (error) {
    const code = failCodeFor(error);
    if (code === "model_unavailable") await markModelRetired(session.agent_actor_id).catch(() => undefined);
    if (code === "agent_error") log.error("agent-runtime", "api session failed", { session: session.id, err: error instanceof Error ? error.name : "unknown" });
    await endSession(session.workspace_id, session.id, "failed", { failCode: code }).catch(() => undefined);
  } finally {
    endLive(session.id);
  }
}

/** Tell the person what the AI is about to do (in-memory only, never saved): the note's name only where they may read it. */
async function announce(session: AgentSession, actor: ActorCtx, tool: string, targetId: string): Promise<void> {
  const title = targetId ? (await readableTitles(actor, session.workspace_id, [targetId]).catch(() => new Map<string, string>())).get(targetId) ?? null : null;
  const access = getTool(tool)?.access;
  pushStep(session.id, { what: access === "write" ? "write" : /^(search|query)/i.test(tool) ? "search" : "read", title });
}

/** Between turns: is the session still wanted, the key still valid, the cap not passed? */
async function assertMayContinue(session: AgentSession): Promise<void> {
  const now = await loadSession(session.id);
  if (!now || now.status !== "running") throw new Stop("stopped");
  if (new Date(now.deadline_at) <= new Date()) throw new Stop("timed_out"); // same code expireOverdue writes
  const role = await loadRunner(session.workspace_id, { actorId: session.agent_actor_id });
  if (!role || !role.enabled) throw new Stop("agent_disabled");
  if (!role.api_credential_id || !(await credentialLive(session.workspace_id, role.api_credential_id))) throw new Stop("credential_revoked");
  if (role.api_cap_choice === "capped" && (await monthTokensUsed(role.actor_id)) >= (role.monthly_cap_tokens ?? 0)) throw new Stop("cap_reached");
}

async function runToolLoop(session: AgentSession): Promise<string> {
  const { role, model, actor, client, prices } = await prepareApiRun(session);

  let prompt;
  try {
    prompt = await renderSessionPrompt(session, actor);
  } catch {
    throw new Stop("cannot_read_note");
  }
  // An info-panel turn streams its answer and says what it is doing; the other sessions run silently.
  const panel = session.kind === "panel_chat";
  // Only notes that really went into the prompt count as read (the same gate the harness applies).
  const sent = panel ? (await aiReadable(session.workspace_id, actor)).allowed : null;
  for (const id of panel ? (await chatNoteIds(session)).filter((n) => sent!.has(n)) : [session.node_id]) await logLine(session.id, "read", { node_id: id });

  // The service's own web search runs only where the owner switched it on AND the format has one.
  const webSearch = role.api_web_search && client.supportsWebSearch;
  const tools = await toolSpecs(session.workspace_id);
  const turns: Turn[] = promptTurns(prompt.messages);
  const abort = panel ? beginLive(session.id) : new AbortController();

  try {
    for (let turnNumber = 1; ; turnNumber++) {
      const result = await client.turn(
        { model, system: prompt.system, turns, tools, maxOutputTokens: MAX_OUTPUT_TOKENS, webSearch },
        { signal: abort.signal, onText: panel ? (delta) => pushPreview(session.id, delta) : undefined });
      await recordUsage(session, prices, result.usage);
      for (const length of result.searchQueryLengths) {
        // The query is not logged: its length only (it can carry note text).
        await logLine(session.id, "search", { query_length: length });
        if (panel) pushStep(session.id, { what: "search", title: null });
      }
      if (result.stop !== "tool_use") {
        const text = finalText(result);
        await logLine(session.id, "message", { text: cutToUnits(text, LOG_TEXT_MAX) });
        return text;
      }
      if (turnNumber >= MAX_TURNS) throw new Stop("turn_limit");
      if (panel) restartPreview(session.id);
      turns.push({ role: "assistant", text: result.text, toolCalls: result.toolCalls, raw: result.raw });
      for (const call of result.toolCalls) {
        const target = toolTargetId(call.input);
        await logLine(session.id, "action", { tool: call.name, target_id: target });
        if (panel) await announce(session, actor, call.name, target);
      }
      await assertMayContinue(session);
      const results = [];
      for (const call of result.toolCalls) results.push(await runToolCall(call, actor, session.workspace_id));
      if (results.length > 0) turns.push({ role: "tool", results });
    }
  } catch (error) {
    abort.abort();
    throw error;
  }
}
