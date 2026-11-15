// A note's lifecycle actions, keyed by id (D18): delete, duplicate, promote
// (show a note hidden before only tags could be, D104), rename and move under
// a parent. Every surface — the right-click
// menu, the note header's ⋯ menu, the sidebar rows, the keyboard shortcuts,
// the board, a tag page — calls these, so each action looks the note up,
// clears the selection and words its toast the same way wherever it starts.
// The writes and their toasts are nodeMutations'; this layer adds the lookup
// and the selection rule.

import type { makeNodeMutations } from "./nodeMutations";
import type { DataCtx } from "./types";
import { noteLabel } from "../noteLabel";
import { neighborAfterDelete } from "../childOrder";
import { markBackNavigation } from "../pageScrollRestore";
import { nodeOf } from "../nodeIndex";
import { navigate } from "../historyIntent";

/** The focused note, as the actions need it. */
export type NodeSelection = {
  readonly selectedId: string | null;
  clear: () => void;
  /** Focus a note (a deleted page's neighbour; a refused delete puts the page back). */
  select: (id: string) => void;
  /** The phone shows the list and the note as separate screens: a deleted
   *  page returns to the list instead of opening a neighbour. */
  readonly listIsSeparateScreen: boolean;
};

type Mutations = Pick<ReturnType<typeof makeNodeMutations>,
  "deleteNode" | "duplicateNode" | "promoteNode" | "renameNode" | "assignToGroup">;

/** The focus moves a delete makes itself (the neighbour takes it, a refused delete gives it back) are not pages the
 *  user went to: replace, so Back never returns to the deleted note's address (hooks/useUrlLocation's table). */
const handOffFocus = (move: () => void): void => navigate(move, { history: "replace" });

export function makeNodeActions(ctx: Pick<DataCtx, "data">, mutations: Mutations, selection: NodeSelection) {
  const find = (id: string) => nodeOf(ctx.data, id);

  return {
    /** True once the delete was accepted or queued. A deleted note leaves the
     *  store at once, so it stops being the focused note at once too: the
     *  neighbour in the tree takes the focus (next sibling, previous, parent),
     *  so the tree stays where it was and notes can be deleted one after
     *  another. On a phone the list comes back at its remembered scroll.
     *  A refused delete gives the focus back, so the page the user is on stays.
     *  `fallbackTitle` names a row that is not in the note list (a tag page). */
    async delete(id: string, fallbackTitle?: string): Promise<boolean> {
      const node = find(id);
      const title = node ? noteLabel(node) : fallbackTitle;
      const wasFocused = selection.selectedId === id;
      let handoff: string | null = null;
      if (wasFocused) {
        handoff = selection.listIsSeparateScreen ? null : neighborAfterDelete(ctx.data.nodes, id);
        if (selection.listIsSeparateScreen) markBackNavigation();
        handOffFocus(() => { if (handoff) selection.select(handoff); else selection.clear(); });
      }
      const accepted = await mutations.deleteNode(id, title);
      // Only when the user has not moved elsewhere while the request ran.
      if (!accepted && wasFocused && selection.selectedId === handoff) handOffFocus(() => selection.select(id));
      return accepted;
    },
    async duplicate(id: string): Promise<void> {
      const node = find(id);
      if (node) await mutations.duplicateNode(node);
    },
    /** A note hidden before only tags could be hidden (D104) is shown in the
     *  list again. Notes can no longer be hidden. */
    async promote(id: string): Promise<void> {
      await mutations.promoteNode(id, find(id)?.title);
    },
    /** True once accepted or queued; false for an empty or refused title. */
    rename(id: string, title: string): Promise<boolean> {
      return mutations.renameNode(id, title);
    },
    /** Move a note under `parentId`, or to the top level with null. */
    assignToGroup(id: string, parentId: string | null): Promise<void> {
      return mutations.assignToGroup(id, parentId);
    },
  };
}
