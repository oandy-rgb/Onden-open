// What the model is asked for a panel_chat turn (the info panel's 「AI」 tab), kept apart from
// panelChat.ts so agentSessionPrompt.ts can use it without a cycle through agentSessions.
//
//   [earlier question, earlier answer]* … then ONE user message: the notes as numbered data
//   (the open note first, then the notes and tags the person added) and the question in <request>.
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import type { AgentSession } from "./agentSessionStore.js";
import { prompt as renderPrompt, tagMemberNoteIds } from "./harness/index.js";
import { renderPreviousRuns } from "./agentSessionMemory.js";
import { noteFunctionWords, withNoteFunctions } from "./noteFunctionsPrompt.js";

/** Earlier answered turns the model is shown again. */
export const HISTORY_TURNS = 8;
/** The notes a turn reads in all (the harness takes the first 20 it may read). */
const NOTES_PER_TURN = 20;

export type ChatScope = { noteIds: string[]; tagIds: string[] };

/** The extra scope a panel_chat session was started with. */
export async function chatScopeOf(sessionId: string): Promise<ChatScope> {
  const row = (await q<{ scope_node_ids: string[]; scope_tag_ids: string[] }>(
    `SELECT scope_node_ids::text[] AS scope_node_ids, scope_tag_ids::text[] AS scope_tag_ids FROM agent_sessions WHERE id = $1`, [sessionId])).rows[0];
  return { noteIds: row?.scope_node_ids ?? [], tagIds: row?.scope_tag_ids ?? [] };
}

/** The earlier answered turns of this person's conversation about the note, oldest first. */
export async function earlierTurns(session: Pick<AgentSession, "workspace_id" | "node_id" | "initiator_id" | "created_at" | "id">): Promise<Array<{ question: string; answer: string }>> {
  const rows = (await q<{ prompt: string; reply_markdown: string }>(
    `SELECT prompt, reply_markdown FROM agent_sessions
      WHERE workspace_id = $1 AND node_id = $2 AND initiator_id = $3 AND kind = 'panel_chat' AND chat_cleared_at IS NULL
        AND status = 'completed' AND reply_markdown IS NOT NULL AND id <> $4 AND created_at < $5
      ORDER BY created_at DESC, id LIMIT ${HISTORY_TURNS}`,
    [session.workspace_id, session.node_id, session.initiator_id, session.id, session.created_at])).rows;
  return rows.reverse().map((r) => ({ question: r.prompt, answer: r.reply_markdown }));
}

/** The notes of a turn, in the order the model reads them: the open note, the added notes, the added tags' notes. */
export async function chatNoteIds(session: Pick<AgentSession, "id" | "workspace_id" | "node_id">): Promise<string[]> {
  const scope = await chatScopeOf(session.id);
  const ids = new Set<string>();
  const add = (list: readonly string[]) => { for (const id of list) if (ids.size < NOTES_PER_TURN) ids.add(id); };
  add([session.node_id, ...scope.noteIds]);
  // A tag's notes only while there is room: a full turn asks for no more.
  for (const tagId of scope.tagIds) if (ids.size < NOTES_PER_TURN) add(await tagMemberNoteIds(session.workspace_id, tagId));
  return [...ids];
}


export async function renderPanelChatPrompt(
  session: Pick<AgentSession, "id" | "workspace_id" | "node_id" | "initiator_id" | "created_at" | "prompt">,
  sessionActor: ActorCtx,
): Promise<{ system: string; messages: Array<{ role: "user" | "assistant"; content: string }> }> {
  const base = await renderPrompt({
    actor: sessionActor, workspaceId: session.workspace_id, skill: "panelChat",
    scope: { kind: "nodes", ids: await chatNoteIds(session) },
  });
  const history = await earlierTurns(session);
  const previousRuns = await renderPreviousRuns(sessionActor, session.workspace_id, session.node_id);
  const notes = base.messages.map((m) => m.content).join("\n\n");
  const request = [notes, previousRuns, `<request>\n${session.prompt}\n</request>`].filter(Boolean).join("\n\n===\n\n");
  return {
    system: withNoteFunctions(base.system, await noteFunctionWords(session.workspace_id)),
    messages: [
      ...history.flatMap((turn) => [
        { role: "user" as const, content: `<request>\n${turn.question}\n</request>` },
        { role: "assistant" as const, content: turn.answer },
      ]),
      { role: "user", content: request },
    ],
  };
}
