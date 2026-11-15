// Where a selection action's text goes: the selected text is replaced by it as ONE
// pending suggestion (aiSuggestions.createSuggestions), made only after the whole
// answer exists. One place for every runtime: the api run's end (agentRuntime/api/deliver)
// and a subscription / MCP runner's finish (agentSessions.finish) both call it.
import { findSelection } from "@onden/markdown";
import type { ActorCtx } from "../types.js";
import { q } from "../db.js";
import { AgentSessionError, selectionError } from "./agentSessionError.js";
import { loadSession, type AgentSession } from "./agentSessionStore.js";
import { createSuggestions } from "./aiSuggestions.js";
import { liveNodeSql } from "../spine/nodeSql.js";

export async function deliverSelectionResult(session: AgentSession, actor: ActorCtx, text: string): Promise<void> {
  // A cancelled (or otherwise ended) session leaves nothing behind. A cancel that comes
  // after this check lost the race: the suggestion is then a finished result like any other.
  const now = await loadSession(session.id);
  if (!now || (now.status !== "running" && now.status !== "delivered")) {
    throw new AgentSessionError("session_ended", `session is ${now?.status ?? "gone"}`, 409);
  }
  const note = (await q<{ markdown: string }>(
    `SELECT markdown FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`, [session.workspace_id, session.node_id])).rows[0];
  if (!note) throw new AgentSessionError("not_found", "note not found", 404);
  const found = findSelection(note.markdown, session.prompt);
  // The selection is no longer there as it was sent: nothing is proposed.
  if (found.found !== "one") throw selectionError(found.found);
  await createSuggestions(session.workspace_id, {
    actor, proposer: { agentActorId: session.agent_actor_id, sessionId: session.id }, nodeId: session.node_id,
    baseMarkdown: note.markdown,
    proposedMarkdown: note.markdown.slice(0, found.at) + text + note.markdown.slice(found.at + found.length),
  });
}
