// Where an api session's final text goes. It never goes into a note by itself:
//   mention           the reply waits on the session (reply_markdown); the person
//                     decides to insert it, which files ONE insert suggestion
//                     (agentSessions.insertReplyAsSuggestion) — same as any other
//                     suggest-mode agent's @ai reply.
//   selection_action  the new text replaces the selected text as ONE pending
//                     suggestion, made only now, after the whole stream arrived
//                     (selectionDelivery.ts, shared with the pull runtimes).
import type { ActorCtx } from "../../../types.js";
import { q } from "../../../db.js";
import type { AgentSession } from "../../agentSessionStore.js";
import { deliverSelectionResult } from "../../selectionDelivery.js";

export async function deliverApiResult(session: AgentSession, actor: ActorCtx, text: string): Promise<void> {
  if (session.kind === "selection_action") return deliverSelectionResult(session, actor, text);
  await q(`UPDATE agent_sessions SET reply_markdown = $2 WHERE id = $1`, [session.id, text]);
}
