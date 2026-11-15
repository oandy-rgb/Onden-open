// The info panel's 「AI」 tab (proposal 2026-10-27 §5.3): a conversation about ONE note.
//
// A turn is one agent session of kind 'panel_chat'; the conversation is that person's
// panel_chat sessions on the note, oldest first (no conversation table). The session
// is the same one an @mention or a selection action makes: same role and runtime
// rules, same tools, same cost log, same session token — and the same limit: it only
// PROPOSES (write_mode 'suggest'), so an edit the AI wants becomes a pending suggestion
// and its answer waits on the session (reply_markdown) until the person puts it in the note.
//
//   startPanelChat(ws, { actor, agentActorId, nodeId, text, scope, requestId, runtime })
//   panelChatThread(ws, nodeId, { actor })   → the turns, with sources and suggestion counts
//   panelChatRoles(ws, nodeId, { actor })    → who can answer and how (the same roles 「交給 AI」 lists)
//   clearPanelChat(ws, nodeId, { actor })    → 「清除這段對話」 (the sessions stay, for cost and history)
import { BLOCK_ID, isUuid, splitWikilink, wikilinkBodies, wikilinkTarget } from "@onden/markdown";
import { noteHoldsBlock } from "./blockRefLookup.js";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { AgentSessionError } from "./agentSessionError.js";
import { mentionablesFor, type AgentSession } from "./agentSessions.js";
import { assertPersonMayStart, startAiSession } from "./aiSessionStart.js";
import { OPEN } from "./agentSessionStore.js";
import type { RuntimeKind } from "./agentRuntime/index.js";
import { canReadNode, canSeeTag, readableScopeSql } from "./readPolicy.js";
import { handToAiRoles, type HandToAiRole } from "./handToAi.js";
import { sessionSteps, UNREADABLE_NOTE_TITLE } from "./agentSessionMemory.js";
import { listTools } from "./agentTools/index.js";
import type { ChatScope } from "./panelChatPrompt.js";
import type { ChatSource, ChatTurn } from "@onden/contract";
import { liveNodeSql } from "../spine/nodeSql.js";

export const CHAT_TEXT_MAX = 2_000;
/** Extra notes and tags a question may bring in (the current note is always in). */
export const CHAT_SCOPE_MAX = 8;
/** Turns the thread shows. */
export const THREAD_TURNS = 100;


/** Who can answer in this note's panel, and the ways each can run. A reader may ask
 *  (an edit it asks for is a suggestion that only an editor can accept). */
export async function panelChatRoles(workspaceId: string, nodeId: string, { actor }: { actor: ActorCtx }): Promise<{ roles: HandToAiRole[] }> {
  const { agents } = await mentionablesFor(workspaceId, nodeId, { actor }); // 404 for a note they cannot read
  return { roles: await handToAiRoles(workspaceId, agents) };
}

/** The extra notes and tags a question brings in, each one the asker may read, notes only from the
 *  current note's space (a session token reaches one space). Tags are checked by canSeeTag. */
async function checkedScope(workspaceId: string, actor: ActorCtx, note: { id: string; space_id: string }, scope: Partial<ChatScope>): Promise<ChatScope> {
  const noteIds = [...new Set(scope.noteIds ?? [])].filter((id) => id !== note.id);
  const tagIds = [...new Set(scope.tagIds ?? [])];
  if (noteIds.length + tagIds.length > CHAT_SCOPE_MAX) throw new AgentSessionError("scope_too_big", `at most ${CHAT_SCOPE_MAX} notes or tags can be added`, 422);
  if (![...noteIds, ...tagIds].every(isUuid)) throw new AgentSessionError("invalid_log", "scope ids must be uuids", 400);
  for (const id of noteIds) {
    if (!(await canReadNode(actor, id))) throw new AgentSessionError("not_found", "a note in the scope cannot be read", 404);
  }
  if (noteIds.length > 0) {
    const same = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND space_id = $3 AND ${liveNodeSql()}`,
      [workspaceId, noteIds, note.space_id]);
    if (same.rows[0]!.n !== noteIds.length) throw new AgentSessionError("scope_other_space", "the AI works in one space at a time: add notes from this note's space", 422);
  }
  for (const id of tagIds) {
    if (!(await canSeeTag(actor, id))) throw new AgentSessionError("not_found", "a tag in the scope cannot be read", 404);
  }
  return { noteIds, tagIds };
}

/** The last turn of this person's conversation about the note (the new turn follows it). */
async function lastTurnId(workspaceId: string, nodeId: string, actorId: string): Promise<string | null> {
  return (await q<{ id: string }>(
    `SELECT id::text FROM agent_sessions
      WHERE workspace_id = $1 AND node_id = $2 AND initiator_id = $3 AND kind = 'panel_chat' AND chat_cleared_at IS NULL
      ORDER BY created_at DESC, id LIMIT 1`, [workspaceId, nodeId, actorId])).rows[0]?.id ?? null;
}

export async function startPanelChat(
  workspaceId: string,
  input: { actor: ActorCtx; agentActorId: string; nodeId: string; text: string; scope?: Partial<ChatScope>; requestId: string; runtime?: RuntimeKind },
): Promise<{ sessionId: string; created: boolean }> {
  const { actor } = input;
  assertPersonMayStart(actor, input.requestId);
  const text = input.text.trim();
  if (!text || text.length > CHAT_TEXT_MAX) throw new AgentSessionError("prompt_too_long", `the question must be 1–${CHAT_TEXT_MAX} characters`, 422);

  return startAiSession(workspaceId, {
    actor, agentActorId: input.agentActorId, nodeId: input.nodeId, requestId: input.requestId, runtime: input.runtime,
    kind: "panel_chat", authorityOp: "read",
    prepare: (note) => checkedScope(workspaceId, actor, note, input.scope ?? {}),
    row: async (scope) => ({
      prompt: text, parentSessionId: await lastTurnId(workspaceId, input.nodeId, actor.id), scopeNodeIds: scope.noteIds, scopeTagIds: scope.tagIds,
    }),
  });
}


const READ_TOOLS = (): Set<string> => new Set(listTools().filter((tool) => tool.access === "read").map((tool) => tool.name));

/** `[[Title#^id]]` links in an answer, by title. Only a reading of what the AI wrote: the caller keeps
 *  a link only when the note really is one the session read and really has that paragraph id. */
export function answerLinks(reply: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const body of wikilinkBodies(reply)) {
    const title = wikilinkTarget(body);
    if (!title) continue;
    const id = splitWikilink(body).target.split("#^")[1]?.trim() ?? "";
    const block = BLOCK_ID.test(id) ? id : null;
    if (!out.has(title) || (block && !out.get(title))) out.set(title, block);
  }
  return out;
}

export async function panelChatThread(workspaceId: string, nodeId: string, { actor }: { actor: ActorCtx }): Promise<{ turns: ChatTurn[] }> {
  if (actor.tokenScope || !(await canReadNode(actor, nodeId))) throw new AgentSessionError("not_found", "note not found", 404);
  const rows = (await q<Pick<AgentSession, "id" | "prompt" | "status" | "fail_code" | "reply_markdown" | "runtime" | "created_at"> & { agent_name: string | null; scope_node_ids: string[]; scope_tag_ids: string[] }>(
    `SELECT * FROM (
        SELECT s.id::text, s.prompt, s.status, s.fail_code, s.reply_markdown, s.runtime, s.created_at, a.name AS agent_name,
               s.scope_node_ids::text[] AS scope_node_ids, s.scope_tag_ids::text[] AS scope_tag_ids
          FROM agent_sessions s LEFT JOIN actors a ON a.id = s.agent_actor_id
         WHERE s.workspace_id = $1 AND s.node_id = $2 AND s.initiator_id = $3 AND s.kind = 'panel_chat' AND s.chat_cleared_at IS NULL
         ORDER BY s.created_at DESC, s.id DESC LIMIT ${THREAD_TURNS}) t
      ORDER BY created_at, id`, [workspaceId, nodeId, actor.id])).rows;
  if (rows.length === 0) return { turns: [] };
  const ids = rows.map((r) => r.id);

  // Titles of the added notes and tags, only the ones the reader may still see.
  const addedNotes = [...new Set(rows.flatMap((r) => r.scope_node_ids))];
  const noteParams: unknown[] = [workspaceId, addedNotes];
  const noteScope = readableScopeSql(actor, "n", noteParams);
  const noteTitles = new Map((await q<{ id: string; title: string }>(
    `SELECT n.id::text, n.title FROM content_nodes n WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[]) AND ${liveNodeSql("n")} AND ${noteScope}`, noteParams)).rows.map((r) => [r.id, r.title]));
  const addedTags = [...new Set(rows.flatMap((r) => r.scope_tag_ids))];
  const tagNames = new Map<string, string>();
  for (const id of addedTags) {
    if (!(await canSeeTag(actor, id))) continue;
    const name = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1 AND workspace_id = $2 AND ${liveNodeSql()}`, [id, workspaceId])).rows[0]?.title;
    if (name) tagNames.set(id, name);
  }

  // Sources: the notes the log says the session read, named only where the reader may read them.
  const reading = READ_TOOLS();
  const steps = await sessionSteps(actor, workspaceId, ids, ["read", "action"]);
  const readNotes = new Map<string, Array<{ node_id: string; title: string }>>();
  const allRead = new Set<string>();
  for (const id of ids) {
    const seen = new Map<string, string>();
    for (const step of steps.get(id) ?? []) {
      if (!step.target_id || step.target_title === null || step.target_title === UNREADABLE_NOTE_TITLE) continue;
      if (step.kind === "action" && !(step.tool && reading.has(step.tool))) continue;
      seen.set(step.target_id, step.target_title);
      allRead.add(step.target_id);
    }
    readNotes.set(id, [...seen].map(([node_id, title]) => ({ node_id, title })));
  }
  const bodies = new Map<string, string>();
  if (allRead.size > 0) {
    const params: unknown[] = [workspaceId, [...allRead]];
    const scope = readableScopeSql(actor, "n", params);
    for (const r of (await q<{ id: string; markdown: string }>(
      `SELECT n.id::text, n.markdown FROM content_nodes n WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[]) AND ${liveNodeSql("n")} AND ${scope}`, params)).rows) {
      bodies.set(r.id, r.markdown);
    }
  }

  const counts = await q<{ session_id: string; status: string; n: number }>(
    `SELECT es.session_id::text, i.status, count(*)::int AS n
       FROM ai_edit_suggestions es JOIN ai_edit_suggestion_items i ON i.suggestion_id = es.id
      WHERE es.session_id = ANY($1::uuid[]) AND i.status IN ('accepted', 'rejected', 'pending') GROUP BY es.session_id, i.status`, [ids]);
  const pendingItems = await q<{ session_id: string; suggestion_id: string; id: string }>(
    `SELECT es.session_id::text, es.id::text AS suggestion_id, i.id::text FROM ai_edit_suggestions es JOIN ai_edit_suggestion_items i ON i.suggestion_id = es.id
      WHERE es.session_id = ANY($1::uuid[]) AND i.status = 'pending' ORDER BY es.created_at, i.seq`, [ids]);

  return {
    turns: await Promise.all(rows.map(async (r): Promise<ChatTurn> => {
      const links = r.reply_markdown ? answerLinks(r.reply_markdown) : new Map<string, string | null>();
      const sources = await Promise.all((readNotes.get(r.id) ?? []).map(async (s): Promise<ChatSource> => {
        const block = links.get(s.title) ?? null;
        const real = block !== null && await noteHoldsBlock(workspaceId, s.node_id, block);
        return { node_id: s.node_id, title: s.title, block_id: real ? block : null };
      }));
      const c = { pending: 0, accepted: 0, rejected: 0 };
      for (const row of counts.rows) if (row.session_id === r.id) c[row.status as keyof typeof c] = row.n;
      return {
        session_id: r.id, text: r.prompt, status: r.status, fail_code: r.fail_code, reply: r.reply_markdown, runtime: r.runtime,
        agent_name: r.agent_name, created_at: r.created_at,
        scope: {
          notes: r.scope_node_ids.flatMap((id) => (noteTitles.has(id) ? [{ id, title: noteTitles.get(id)! }] : [])),
          tags: r.scope_tag_ids.flatMap((id) => (tagNames.has(id) ? [{ id, name: tagNames.get(id)! }] : [])),
        },
        sources, suggestions: c,
        pending: pendingItems.rows.filter((p) => p.session_id === r.id).map((p) => ({ suggestion_id: p.suggestion_id, item_id: p.id })),
      };
    })),
  };
}

/** 「清除這段對話」: the next question starts a new conversation. The sessions are kept (cost, history),
 *  only hidden from the panel and from the model. Refused while an answer is still being written. */
export async function clearPanelChat(workspaceId: string, nodeId: string, { actor }: { actor: ActorCtx }): Promise<{ cleared: number }> {
  if (actor.tokenScope || !(await canReadNode(actor, nodeId))) throw new AgentSessionError("not_found", "note not found", 404);
  const open = await q(
    `SELECT 1 FROM agent_sessions WHERE workspace_id = $1 AND node_id = $2 AND initiator_id = $3 AND kind = 'panel_chat' AND chat_cleared_at IS NULL AND status = ANY($4::text[]) LIMIT 1`,
    [workspaceId, nodeId, actor.id, OPEN]);
  if (open.rows.length > 0) throw new AgentSessionError("chat_busy", "an answer is still being written: stop it first", 409);
  const done = await q(
    `UPDATE agent_sessions SET chat_cleared_at = now()
      WHERE workspace_id = $1 AND node_id = $2 AND initiator_id = $3 AND kind = 'panel_chat' AND chat_cleared_at IS NULL`,
    [workspaceId, nodeId, actor.id]);
  return { cleared: done.rowCount ?? 0 };
}

