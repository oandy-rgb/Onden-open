// The sidebar tree lists what people write, nested by the real parent/child
// relation and nothing else. Nodes the app makes on their behalf go where they
// belong instead of the top level (display only — no parent, placement or
// permission changes):
// - notes a module makes by itself (RSS sources and their saved articles,
//   FrontendModule.generatedSourceTypes) are read where that module shows
//   them (閱讀), so they leave the tree;
// - captures not filed yet (the inbox) are read on the inbox page. Filing one
//   under a note takes it out of the inbox, and it is a note of the tree like
//   any other;
// - each space's 任務 note (where that space's tasks with no day or note are
//   written, dayNotes.openTasksNote) is read on the 任務 page. It is picked by
//   its derived id (tasksNoteId of each space), never by title, so a note a
//   person named 任務 stays. Its children go with it, wherever it sits (top level or
//   under the diary parent). It is still found by search, [[任務]] and history.
// A whiteboard is a view of a note (docs/architecture/canvas-as-view.md), and
// its cards are not that note's children: a card never moves under the note
// whose board it is on, and a row the device still holds as node_type 'canvas'
// is listed like any note.

import type { ContentNode, Tag } from "./api";
import { tasksNoteId } from "./dayNode";
import { GENERATED_SOURCE_TYPES, isPendingCapture } from "../modules";

export type SidebarTidy = {
  /** Top-level notes that stay in the tree. */
  roots: ContentNode[];
  /** How many top-level items left the tree (the toggle's count). */
  hiddenCount: number;
};

/** The ids of the 任務 notes of `spaceIds` — the one judgment of "is this a
 *  task note" for the tree. No spaces (not loaded yet) = none, so they stay
 *  listed until the spaces are known. */
export function tasksNoteIdsOf(spaceIds: readonly string[]): ReadonlySet<string> {
  return new Set(spaceIds.map(tasksNoteId));
}

/** Top-level rows that stay in the tree. */
export function tidySidebarRoots(
  roots: ContentNode[], tags: readonly Tag[] = [], spaceIds: readonly string[] = [],
): SidebarTidy {
  const tasksIds = tasksNoteIdsOf(spaceIds);
  const kept = roots.filter((node) => !tasksIds.has(node.id)
    && !GENERATED_SOURCE_TYPES.has(node.source_type) && !isPendingCapture(node, tags));
  return { roots: kept, hiddenCount: roots.length - kept.length };
}

/** The tree's parent→children index without the 任務 notes (their own children
 *  are unreachable once they are gone, since nothing renders under them). */
export function withoutTasksNote(
  byParent: Map<string, ContentNode[]>, spaceIds: readonly string[],
): Map<string, ContentNode[]> {
  if (spaceIds.length === 0) return byParent;
  const ids = tasksNoteIdsOf(spaceIds);
  let out: Map<string, ContentNode[]> | null = null;
  for (const [parent, kids] of byParent) {
    if (!kids.some((k) => ids.has(k.id))) continue;
    out ??= new Map(byParent);
    out.set(parent, kids.filter((k) => !ids.has(k.id)));
  }
  return out ?? byParent;
}
