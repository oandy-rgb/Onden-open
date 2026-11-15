import type { ContentNode } from "./api";
import { ancestorsOf, indexById } from "./treeWalk";
import { isNote } from "@onden/markdown/contract";

// Where a note sits in the note tree, shared by the desktop line above the title
// (components/NoteBreadcrumb) and the phone's top bar (components/PhoneNoteLocation),
// so both show the same path and fold a long one the same way.

/** More ancestors than this: the first and last stay, the middle collapse to "…". */
export const MAX_VISIBLE_ANCESTORS = 3;

/** The notes above `node`, root first and its parent last. Stops at a missing
 *  parent or a cycle. */
export function noteAncestors(node: ContentNode, nodes: readonly ContentNode[]): ContentNode[] {
  return ancestorsOf(indexById(nodes), node);
}

/** The space a note's path starts from, by the sidebar's rule: named only
 *  when the sidebar groups notes by space (more than one space has top-level
 *  notes), so a one-space workspace keeps a path of notes alone. */
export function pathSpace<S extends { id: string }>(node: ContentNode, nodes: readonly ContentNode[], spaces: readonly S[]): S | null {
  const space = spaces.find((s) => s.id === node.space_id);
  if (!space) return null;
  const withNotes = new Set(nodes.filter((n) => !n.parent_id && isNote(n) && n.space_id).map((n) => n.space_id));
  return withNotes.size > 1 ? space : null;
}

/** `shown` stays visible; `hidden` is the folded middle (empty for a short path). */
export function collapseAncestors(ancestors: readonly ContentNode[]): { shown: readonly ContentNode[]; hidden: readonly ContentNode[] } {
  if (ancestors.length <= MAX_VISIBLE_ANCESTORS) return { shown: ancestors, hidden: [] };
  return { shown: [ancestors[0], ancestors[ancestors.length - 1]], hidden: ancestors.slice(1, -1) };
}
