import { compareChildren, sortChildren } from "@onden/markdown";
import type { ContentNode } from "./api";
import { isPinned } from "./noteMarks";
import { isTag } from "@onden/markdown/contract";

type Ordered = Pick<ContentNode, "sort_order" | "created_at">;

// The order itself lives in @onden/markdown so the published site uses the
// same one; every surface that lists siblings (sidebar, canvas tree, local
// mirror boot, site) goes through it.
export { compareChildren, sortChildren };

type Sibling = Ordered & { id: string };

/** The room left between rows a reorder writes anyway, so a later move into
 *  that stretch finds a free value and writes one row. */
const SORT_GAP = 1024;

/** The sort_order values that put one parent's children in `orderedIds`
 *  order while changing as few rows as possible: id → new sort_order, only for
 *  the rows whose value must change. `siblings` are the parent's children as
 *  stored now; an id in `orderedIds` that is not among them (a note moving in
 *  from another parent, passed in `incoming` so its creation time counts)
 *  always gets a value. `moved` names the row the person dragged: among
 *  equally small plans, the one that renumbers it wins.
 *
 *  Order is (sort_order, created_at), so each row needs a sort_order one above
 *  the row before it, or an equal one when it was created later. Rows i < j
 *  can both stay exactly when s[j] − s[i] covers the rises needed between
 *  them, so the rows kept are the heaviest chain whose s[p] − rises-before-p
 *  never decreases; the rows between two kept ones share the spare room, and
 *  rows before the first or after the last kept one are SORT_GAP apart.
 *
 *  Legacy siblings that all share one value (new notes default to 0) cost
 *  the shorter side of the drop point once; the rows written then are spaced,
 *  so later moves among them write one row. */
export function planSiblingOrder(siblings: readonly Sibling[], orderedIds: readonly string[], moved?: string, incoming: readonly Sibling[] = []): Map<string, number> {
  const byId = new Map(siblings.map((s) => [s.id, s]));
  const created = new Map([...incoming, ...siblings].map((s) => [s.id, s.created_at]));
  const rows = orderedIds.map((id) => byId.get(id));
  const n = rows.length;
  // need[p]: the sort_order rise required from the first row to row p.
  const need: number[] = [];
  for (let p = 0; p < n; p++) {
    const prev = created.get(orderedIds[p - 1]), cur = created.get(orderedIds[p]);
    need.push(p === 0 ? 0 : need[p - 1] + (prev && cur && prev < cur ? 0 : 1));
  }
  const value = (p: number) => rows[p]?.sort_order ?? 0;
  const key = (p: number) => value(p) - need[p];
  const weight = (p: number) => (!rows[p] ? 0 : orderedIds[p] === moved ? 1 : 2);
  // Heaviest non-decreasing chain of key() over the rows that may stay.
  const best: number[] = new Array(n).fill(0);
  const from: number[] = new Array(n).fill(-1);
  let end = -1;
  for (let j = 0; j < n; j++) {
    if (!weight(j)) continue;
    best[j] = weight(j);
    for (let i = 0; i < j; i++) {
      if (weight(i) && key(i) <= key(j) && best[i] + weight(j) > best[j]) { best[j] = best[i] + weight(j); from[j] = i; }
    }
    if (end < 0 || best[j] > best[end]) end = j;
  }
  const kept: number[] = [];
  for (let p = end; p >= 0; p = from[p]) kept.unshift(p);

  const next: number[] = new Array(n);
  if (kept.length === 0) {
    for (let p = 0; p < n; p++) next[p] = need[p];
  } else {
    const first = kept[0], last = kept[kept.length - 1];
    for (let p = 0; p < first; p++) next[p] = value(first) - (need[first] - need[p]) - SORT_GAP * (first - p);
    kept.forEach((i, k) => {
      next[i] = value(i);
      const j = kept[k + 1];
      if (j === undefined) return;
      const spare = value(j) - value(i) - (need[j] - need[i]);
      for (let p = i + 1; p < j; p++) next[p] = value(i) + (need[p] - need[i]) + Math.floor((spare * (p - i)) / (j - i));
    });
    for (let p = last + 1; p < n; p++) next[p] = value(last) + (need[p] - need[last]) + SORT_GAP * (p - last);
  }
  const changes = new Map<string, number>();
  for (let p = 0; p < n; p++) {
    if (!rows[p] || value(p) !== next[p]) changes.set(orderedIds[p], next[p]);
  }
  return changes;
}

/** The note to open when `id` is deleted: the next sibling in the sidebar's
 *  natural order (pinned first), else the previous one, else the parent;
 *  null when none is left. */
export function neighborAfterDelete(
  nodes: readonly Pick<ContentNode, "id" | "parent_id" | "node_type" | "hidden" | "sort_order" | "created_at" | "attrs">[],
  id: string,
): string | null {
  const gone = nodes.find((node) => node.id === id);
  if (!gone) return null;
  const parentId = gone.parent_id ?? null;
  const siblings = nodes
    .filter((node) => (node.parent_id ?? null) === parentId && !isTag(node) && !node.hidden)
    .sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || compareChildren(a, b));
  const at = siblings.findIndex((node) => node.id === id);
  const near = siblings[at + 1] ?? siblings[at - 1];
  if (near) return near.id;
  const parent = parentId ? nodes.find((node) => node.id === parentId) : undefined;
  return parent && !isTag(parent) ? parent.id : null;
}
