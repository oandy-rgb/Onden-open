// Tree layout helper shared by Canvas's "Auto-arrange as tree" action.
//
// Computes (x, y) positions for a content-node parent_id subtree as a
// horizontal mindmap. Pure function — given the same inputs returns the
// same positions. The caller decides what to do with the positions; for
// the canvas action we overwrite canvas.data.nodes[].x/y. Adopted from
// the now-deleted MindmapView; lives here so it can be invoked from the
// canvas surface without resurrecting the standalone view.
//
// Convention follows Heptabase + Miro + Mindvas: layout is one-shot
// on user demand. After auto-arrange the user can drag freely and the
// result sticks; tapping the action again wipes manual positions and
// recomputes from scratch.

import type { ContentNode } from "./api";
import { compareChildren } from "./childOrder";

const NODE_W = 280;
const NODE_H = 200;
const COL_GAP = 80;
const ROW_GAP = 60;

type LayoutAcc = {
  /** Height of one row: what a card takes, so rows sit as close as the cards allow. */
  heightOf: (id: string) => number;
  /** Vertical gap between rows. */
  rowGap: number;
  positions: Map<string, { x: number; y: number }>;
  edges: Array<{ from: string; to: string }>;
};

function layoutSubtree(
  id: string,
  depth: number,
  topY: number,
  childrenByParent: ReadonlyMap<string, readonly string[]>,
  collapsed: ReadonlySet<string>,
  acc: LayoutAcc,
): { centerY: number; bottomY: number } {
  const children = collapsed.has(id) ? [] : (childrenByParent.get(id) ?? []);
  const x = depth * (NODE_W + COL_GAP);
  const rowGap = acc.rowGap;

  const nodeH = acc.heightOf(id);
  if (children.length === 0) {
    acc.positions.set(id, { x, y: topY });
    return { centerY: topY + nodeH / 2, bottomY: topY + nodeH };
  }

  let cursorY = topY;
  let firstCenter = 0;
  let lastCenter = 0;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const result = layoutSubtree(child, depth + 1, cursorY, childrenByParent, collapsed, acc);
    if (i === 0) firstCenter = result.centerY;
    if (i === children.length - 1) lastCenter = result.centerY;
    acc.edges.push({ from: id, to: child });
    cursorY = result.bottomY + rowGap;
  }
  const childrenSpanCenter = (firstCenter + lastCenter) / 2;
  // A card taller than its children's span would start above its own row: keep it inside.
  const myY = Math.max(topY, childrenSpanCenter - nodeH / 2);
  acc.positions.set(id, { x, y: myY });
  const bottom = Math.max(cursorY - rowGap, myY + nodeH);
  return { centerY: myY + nodeH / 2, bottomY: bottom };
}

/** Positions for a tree whose children are already chosen and ordered:
 *  `childIds` maps a parent to the ids drawn under it, in drawing order. The
 *  board's "follow the sub-notes" tree (lib/boardTree) lays out through this.
 *  `nodeHeight` may differ per card (a folded card is shorter than an expanded one). */
export function layoutTree(
  rootId: string,
  childIds: ReadonlyMap<string, readonly string[]>,
  collapsed: ReadonlySet<string> = new Set(),
  nodeHeight: number | ((id: string) => number) = NODE_H,
  rowGap: number = ROW_GAP,
): Map<string, { x: number; y: number }> {
  const acc: LayoutAcc = { heightOf: typeof nodeHeight === "number" ? () => nodeHeight : nodeHeight, rowGap, positions: new Map(), edges: [] };
  layoutSubtree(rootId, 0, 0, childIds, collapsed, acc);
  return acc.positions;
}

export function computeTreeLayout(
  rootId: string,
  allNodes: ContentNode[],
  collapsed: Set<string> = new Set(),
): Map<string, { x: number; y: number }> {
  const childrenByParent = new Map<string, ContentNode[]>();
  for (const n of allNodes) {
    if (n.hidden) continue;
    if ((n.class_tag_ids?.length ?? 0) > 0) continue;
    if (!n.parent_id) continue;
    const arr = childrenByParent.get(n.parent_id) ?? [];
    arr.push(n);
    childrenByParent.set(n.parent_id, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort(compareChildren);
  }
  const ids = new Map([...childrenByParent].map(([parent, children]) => [parent, children.map((child) => child.id)]));
  return layoutTree(rootId, ids, collapsed);
}
