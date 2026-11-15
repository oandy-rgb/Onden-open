// The reply block an @ai session leaves in a note, and the anchor it takes. Apart from agentSessions.ts so that
// accepting a suggestion (aiSuggestions.ts, which agentSessions.ts imports) can give a reply that lands through a
// suggestion the same anchor as one written directly.

import { db } from "../dbKysely.js";
import type { AdoptAnchor } from "./blockAnchors/index.js";

/** The reply block's own anchor id: also what makes writing it idempotent. */
export const replyBlockId = (anchor: string, revision: number): string => `${anchor}r${revision > 1 ? revision : ""}`;

export function replyBlock(agentName: string, markdown: string): string {
  const stamp = new Date().toISOString().replace("T", " ").replace(/:\d\d\..*$/, "");
  return `> **${agentName}** · ${stamp} UTC\n${quotedLines(markdown)}`;
}

const quotedLines = (markdown: string): string => markdown.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">")).join("\n");

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The anchor the reply block takes when it is in `markdown` (a suggestion for it was accepted): the block whose
 *  words are the session's reply under any time stamp, once. null when the text has no such block or has two
 *  (never a guess), or when the session left no reply under a mention. */
export async function replyAnchorFor(workspaceId: string, sessionId: string, markdown: string): Promise<AdoptAnchor | null> {
  const session = await db.selectFrom("agent_sessions as s").leftJoin("actors as a", "a.id", "s.agent_actor_id")
    .select(["s.anchor_block_id", "s.revision", "s.reply_markdown", "a.name as agent_name"])
    .where("s.workspace_id", "=", workspaceId).where("s.id", "=", sessionId).executeTakeFirst();
  if (!session?.anchor_block_id || !session.reply_markdown) return null;
  const tail = quotedLines(session.reply_markdown);
  const pattern = new RegExp(`> \\*\\*${escapeRegExp(session.agent_name ?? "")}\\*\\* · \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC\\n${escapeRegExp(tail)}`, "g");
  const found = [...markdown.matchAll(pattern)];
  if (found.length !== 1) return null;
  return { anchorId: replyBlockId(session.anchor_block_id, session.revision), text: found[0]![0], at: found[0].index!, kind: "new" };
}
