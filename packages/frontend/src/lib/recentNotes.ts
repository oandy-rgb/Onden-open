import type { ContentNode } from "./api";
import { byUpdatedDesc } from "./noteOrder";
import { listsAsNote } from "./nodeTags";

/** The notes touched most recently, newest first: what 「最近」 lists on the home
 *  strip and the phone notes home. node_type==="content" already excludes
 *  tag/class_tag/task nodes. Notes that CARRY a class_tag stay in: they are the
 *  coursework being organized, and dropping them made Recent emptier the more
 *  you organized. */
export function recentNotes(nodes: readonly ContentNode[], homeNodeId: string | null | undefined, limit: number): ContentNode[] {
  return nodes
    .filter((n) => listsAsNote(n) && n.id !== homeNodeId)
    .sort(byUpdatedDesc)
    .slice(0, limit);
}
