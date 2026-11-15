// Who may be a node's parent, and where a note may be pinned: the one client
// rule (depth audit D101). Every surface that puts a note under another asks
// here, so none of them offers a place the server then refuses (offline: the
// write is acked, then refused on replay):
//   • the Move to… picker and the Parent field — ParentCombobox (placementCandidates);
//   • the sidebar drag's drop target — hooks/useSidebarDrag.ts (canPlaceUnder);
//   • the pin picker — ContextMenu → ParentCombobox "pin" (placementCandidates, pin);
//   • a board's parent arrow — hooks/useBoardWorkspace.ts (placementRefusal);
//   • quick capture's target — modules/capture/QuickCapture.tsx (canPlaceUnder).
// test/placementCallers.test.ts keeps those files asking here.
//
// A move (a new parent_id) follows the server's reparent and create rules
// (services/nodeTree.ts assertReparent, services/noteCreate.ts), and a
// refusal here is the server's code for it, so it reads the same words
// (lib/serverErrors.ts):
//   • parent_not_found      — the parent is trashed (or not there);
//   • parent_kind_mismatch  — the tag tree and the note tree are separate: a
//                             tag's parent is a tag, a note's is not a tag
//                             (services/parentKind.ts);
//   • parent_cycle          — the node itself, or one of its descendants;
//   • parent_in_other_space — a note and its parent share a space (moving
//                             spaces is the space chip's job); tags are global;
//   • forbidden             — the person cannot edit the parent
//                             (lib/capabilities.ts canEdit).
// What the client does not know (spaces not loaded, a note without a space,
// nodes not given) is not refused here; the server still decides.
//
// A pin (`{ pin: true }`, a note_pointers row, services/pointers.ts) is a
// second place to SHOW the note; the note itself stays where it is. So a pin
// may sit in another space or under the note's own descendant, but it needs
// a parent note: under a tag (not in the notes tree) or at the top level
// (OverviewSidebar renders pointers only under a parent row) it would never
// be shown. The server refuses a pin under a tag (parent_kind_mismatch) and
// under the note itself (400); this rule also refuses the top level.

import type { ContentNode } from "../api";
import { indexById, isUnder } from "../treeWalk";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

/** A candidate parent. Only `node_type` is required; a missing `id` or
 *  `space_id` skips the checks that need it. */
type Placeable = Pick<ContentNode, "node_type"> & Partial<Pick<ContentNode, "id" | "space_id">> & { deleted_at?: string | null };

/** What is being placed: a node (moved, or pinned), or a new one —
 *  `{ isTag: true }` for a new tag, `{ isTag: false, space_id }` for a new
 *  note. Omitted: a new note. */
export type PlacementChild =
  | (Pick<ContentNode, "id" | "node_type"> & Partial<Pick<ContentNode, "space_id">>)
  | { isTag: boolean; space_id?: string | null };

export type PlacementContext = {
  /** The nodes to walk for descendants (each with its parent_id). Without
   *  them a descendant is not caught; the node itself always is. */
  nodes?: readonly Pick<ContentNode, "id" | "parent_id">[];
  /** lib/capabilities.ts canEdit. Without it, editing the parent is not
   *  checked (the server still is). */
  canEdit?: (node: Pick<ContentNode, "space_id" | "node_type">) => boolean;
  /** The place is a pin of `child` (note_pointers), not its parent. */
  pin?: boolean;
};

export type PlacementRefusal = "parent_not_found" | "parent_kind_mismatch" | "parent_cycle" | "parent_in_other_space" | "forbidden";

type Child = { id?: string; isTag: boolean; space_id?: string | null };

function normalise(child: PlacementChild | undefined): Child {
  if (!child) return { isTag: false };
  if ("node_type" in child) return { id: child.id, isTag: child.node_type === TAG_NODE_TYPE, space_id: child.space_id };
  // `=== true`: a stand-in node with no node_type (an RSS article that is not
  // a note yet) is a note.
  return { isTag: child.isTag === true, space_id: child.space_id };
}

/** The rule for one live candidate; `isBelow(id)`: is `id` under the child. */
function judge(parent: Placeable, child: Child, ctx: PlacementContext, isBelow: (id: string) => boolean): PlacementRefusal | null {
  if (parent.deleted_at) return "parent_not_found";
  if ((parent.node_type === TAG_NODE_TYPE) !== child.isTag) return "parent_kind_mismatch";
  if (child.id && parent.id === child.id) return "parent_cycle";
  if (!ctx.pin) {
    if (child.id && parent.id && isBelow(parent.id)) return "parent_cycle";
    // Tags are global: a tag move keeps no space.
    if (!child.isTag && child.space_id && parent.space_id && child.space_id !== parent.space_id) return "parent_in_other_space";
  }
  if (ctx.canEdit && !ctx.canEdit(parent)) return "forbidden";
  return null;
}

/** Why `child` may not go under `parent` (or, with `pin`, be pinned under
 *  it) — the server's code for it — or null when it may. The top level
 *  (`parent` null) is always a place for a move and never one for a pin
 *  ("parent_not_found"). */
export function placementRefusal(parent: Placeable | null | undefined, child?: PlacementChild, ctx: PlacementContext = {}): PlacementRefusal | null {
  if (!parent) return ctx.pin ? "parent_not_found" : null;
  const c = normalise(child);
  // Is `startId` under the child? Walk up from it (safe on a cycle in the data).
  const isBelow = (startId: string): boolean => {
    if (!c.id || !ctx.nodes) return false;
    return isUnder(indexById(ctx.nodes), startId, c.id);
  };
  return judge(parent, c, ctx, isBelow);
}

/** Whether `child` (a new note by default) may go under `parent`.
 *
 *    canPlaceUnder(focused)                                    // a new note
 *    canPlaceUnder(target, dragged, { nodes, canEdit })        // a move
 *    canPlaceUnder(tag, { isTag: true })                       // a new tag */
export function canPlaceUnder(parent: Placeable | null | undefined, child?: PlacementChild, ctx: PlacementContext = {}): boolean {
  return placementRefusal(parent, child, ctx) === null;
}

/** The nodes in `nodes` that `child` may go under (or, with `pin`, be pinned
 *  under), in the order given: one subtree walk, not one per candidate. The
 *  top level is the caller's to offer.
 *
 *    placementCandidates(note, overviewNodes, { canEdit })
 *    placementCandidates(note, overviewNodes, { canEdit, pin: true }) */
export function placementCandidates<N extends Placeable & Pick<ContentNode, "id" | "parent_id">>(
  child: PlacementChild | undefined, nodes: readonly N[], ctx: Omit<PlacementContext, "nodes"> = {},
): N[] {
  const c = normalise(child);
  const below = new Set<string>();
  if (c.id && !ctx.pin) {
    const children = new Map<string, string[]>();
    for (const n of nodes) {
      if (!n.parent_id) continue;
      const list = children.get(n.parent_id);
      if (list) list.push(n.id); else children.set(n.parent_id, [n.id]);
    }
    const queue = [c.id];
    for (let i = 0; i < queue.length; i++) {
      for (const id of children.get(queue[i]!) ?? []) {
        if (id !== c.id && !below.has(id)) { below.add(id); queue.push(id); }
      }
    }
  }
  return nodes.filter((n) => judge(n, c, ctx, (id) => below.has(id)) === null);
}
