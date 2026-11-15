// The whiteboard's "follow the sub-notes" tree (docs/architecture/canvas-as-view.md):
// the board's note is the root card and its sub-notes, then theirs, spread
// outward. Everything here is a pure function of the notes and the person's
// choices; nothing is stored, so the board follows the notes as they change.
//
// - what shows: `computeBoardTree` (levels, 8 children per note newest first,
//   a "+N" card for the rest, a total card budget filled level by level);
// - where it goes: `boardTreePositions` (lib/treeLayout's mind-map layout);
// - what a click on a branch changes: `toggleBranch`.

import type { ContentNode } from "./api";
import { byUpdatedDesc } from "./noteOrder";
import { layoutTree } from "./treeLayout";
import { EXPANDED_CARD_MAX_H } from "./cardDisplay";
import { isTag } from "@onden/markdown/contract";

/** Children shown under one note; "+N" opens this many more each time. */
export const TREE_CHILD_PAGE = 8;
/** Cards the tree draws in all (the "+N" cards count), so a phone stays smooth. */
export const TREE_CARD_BUDGET = { phone: 30, desktop: 100 } as const;
/** How many levels below the root show. */
export const TREE_DEPTHS = [1, 2, 3, "all"] as const;
export type TreeDepth = (typeof TREE_DEPTHS)[number];
export const DEFAULT_TREE_DEPTH: TreeDepth = 2;
/** Where the root card sits; the same margin as the tidy-up grid. */
const TREE_ORIGIN = 80;
/** A board remembers this many branch choices; the oldest go first. */
const MAX_BRANCH_CHOICES = 300;

/** Branches the person opened beyond the level setting, or closed within it. */
export type BranchChoices = { open: readonly string[]; closed: readonly string[] };

export type TreeNoteEntry = {
  kind: "note";
  id: string;
  /** Null for the root. */
  parentId: string | null;
  /** 0 for the root. */
  level: number;
  /** Sub-notes the person can see under it. */
  childCount: number;
  /** Its sub-notes are drawn under it (all of them, or a page and a "+N"). */
  expanded: boolean;
  /** Notes below it, all levels, while it is collapsed: what its badge says. */
  below: number;
};
export type TreeMoreEntry = {
  kind: "more";
  /** `moreCardId(parentId)`; never a note id. */
  id: string;
  parentId: string;
  /** Sub-notes of the parent that are not drawn yet. */
  remaining: number;
};
export type TreeEntry = TreeNoteEntry | TreeMoreEntry;

/** A "+N" card's id; the prefix keeps it from ever being a note id. */
const moreCardId = (parentId: string) => `more:${parentId}`;

/** The sub-notes the sidebar lists under a note (lib/childOrder's siblings,
 *  without the tags' own rows and hidden ones). */
function childIndex(nodes: readonly ContentNode[]): Map<string, ContentNode[]> {
  const index = new Map<string, ContentNode[]>();
  for (const node of nodes) {
    if (!node.parent_id || node.hidden || isTag(node)) continue;
    const list = index.get(node.parent_id);
    if (list) list.push(node); else index.set(node.parent_id, [node]);
  }
  return index;
}

/** Notes below `id` (not counting it), whatever a parent_id loop does. */
function countBelow(id: string, index: ReadonlyMap<string, readonly ContentNode[]>): number {
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    for (const child of index.get(stack.pop()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      stack.push(child.id);
    }
  }
  return seen.size - 1;
}

export type BoardTreeInput = {
  /** What the person can read; a sub-note they cannot read is simply absent. */
  nodes: readonly ContentNode[];
  rootId: string;
  depth: TreeDepth;
  choices: BranchChoices;
  /** Extra pages of sub-notes opened with "+N", by parent id. */
  extraPages?: ReadonlyMap<string, number>;
  /** The most cards to draw; the root always counts one. */
  budget: number;
};

/**
 * The cards of the tree, level by level (breadth first), root first. Under a
 * note come its first page of sub-notes, most recently changed first, then a
 * "+N" card when more remain. A note shows its sub-notes while it is within
 * `depth` levels of the root or the person opened it, unless they closed it.
 * When the budget runs out the rest of the level and everything after stays
 * collapsed, each branch with the count of what is below it.
 */
export function computeBoardTree({ nodes, rootId, depth, choices, extraPages, budget }: BoardTreeInput): TreeEntry[] {
  const root = nodes.find((node) => node.id === rootId);
  if (!root) return [];
  const index = childIndex(nodes);
  const open = new Set(choices.open);
  const closed = new Set(choices.closed);
  const levels = depth === "all" ? Infinity : depth;
  const entries: TreeEntry[] = [];
  const queue: TreeNoteEntry[] = [];
  const drawn = new Set<string>();
  const addNote = (id: string, parentId: string | null, level: number) => {
    const entry: TreeNoteEntry = { kind: "note", id, parentId, level, childCount: 0, expanded: false, below: 0 };
    drawn.add(id);
    entries.push(entry);
    queue.push(entry);
  };
  addNote(root.id, null, 0);
  for (let next = 0; next < queue.length; next++) {
    const entry = queue[next]!;
    // A parent_id loop must not draw a note twice.
    const children = (index.get(entry.id) ?? []).filter((child) => !drawn.has(child.id));
    entry.childCount = children.length;
    const wanted = children.length > 0 && !closed.has(entry.id) && (open.has(entry.id) || entry.level < levels);
    const room = budget - entries.length;
    if (wanted && room > 0) {
      const sorted = [...children].sort(byUpdatedDesc);
      const page = TREE_CHILD_PAGE * (1 + (extraPages?.get(entry.id) ?? 0));
      let shown = Math.min(sorted.length, page);
      // The "+N" card takes a slot too; when the budget cannot hold the page and it, shrink the page.
      if (shown + (shown < sorted.length ? 1 : 0) > room) shown = room - 1;
      for (const child of sorted.slice(0, shown)) addNote(child.id, entry.id, entry.level + 1);
      if (shown < sorted.length) entries.push({ kind: "more", id: moreCardId(entry.id), parentId: entry.id, remaining: sorted.length - shown });
      entry.expanded = true;
    }
    if (!entry.expanded && children.length > 0) entry.below = countBelow(entry.id, index);
  }
  return entries;
}

/** Vertical gap between the cards of a column (the tree grows to the right). */
export const TREE_ROW_GAP = 28;

/** Top-left of every card of the tree, root at the board's usual margin.
 *  `heightOf`: the height each card is drawn at (folded, expanded or the
 *  person's own), so rows follow the cards and never overlap. */
export function boardTreePositions(entries: readonly TreeEntry[], heightOf: (id: string) => number = () => EXPANDED_CARD_MAX_H): Map<string, { x: number; y: number }> {
  const childIds = new Map<string, string[]>();
  for (const entry of entries) {
    const { parentId } = entry;
    if (parentId === null) continue;
    const list = childIds.get(parentId);
    if (list) list.push(entry.id); else childIds.set(parentId, [entry.id]);
  }
  const root = entries[0];
  if (!root) return new Map();
  const placed = layoutTree(root.id, childIds, undefined, heightOf, TREE_ROW_GAP);
  return new Map([...placed].map(([id, { x, y }]) => [id, { x: Math.round(x) + TREE_ORIGIN, y: Math.round(y) + TREE_ORIGIN }]));
}

/** The choices after a click on a note's branch: collapse an open one, open a
 *  closed one. Only what the level setting would not already do is kept. */
export function toggleBranch(choices: BranchChoices, entry: Pick<TreeNoteEntry, "id" | "level" | "expanded">, depth: TreeDepth): BranchChoices {
  const within = entry.level < (depth === "all" ? Infinity : depth);
  const without = (ids: readonly string[]) => ids.filter((id) => id !== entry.id);
  const keep = (ids: readonly string[]) => ids.slice(-MAX_BRANCH_CHOICES);
  return entry.expanded
    ? { open: without(choices.open), closed: keep(within ? [...without(choices.closed), entry.id] : choices.closed) }
    : { open: keep(within ? choices.open : [...without(choices.open), entry.id]), closed: without(choices.closed) };
}

/** The notes from `rootId` down to `id`, following parent_id upward from `id`;
 *  `[rootId, id]` when `id` does not lead back to the root. The way back after
 *  centring the tree on `id`. */
export function pathFromRoot(nodes: readonly ContentNode[], rootId: string, id: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const up = [id];
  for (let at = byId.get(id)?.parent_id; at && !up.includes(at) && up.length < 100; at = byId.get(at)?.parent_id) {
    up.push(at);
    if (at === rootId) return up.reverse();
  }
  return id === rootId ? [rootId] : [rootId, id];
}
