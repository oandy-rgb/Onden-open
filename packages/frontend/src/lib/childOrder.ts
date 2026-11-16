import { compareChildren, sortChildren } from "@onden/markdown";
import { keysBetween } from "@onden/markdown/contract";
import type { ContentNode } from "./api";
import { isPinned } from "./noteMarks";
import { isTag } from "@onden/markdown/contract";

type Ordered = Pick<ContentNode, "order_key" | "order_stamp" | "created_at">;

// The order itself lives in @onden/markdown so the published site uses the
// same one; every surface that lists siblings (sidebar, canvas tree, local
// mirror boot, site) goes through it.
export { compareChildren, sortChildren };

type Sibling = Partial<Ordered> & { id: string };

/** The keys that put one parent's children in `orderedIds` order while changing as few rows as possible:
 *  id → new order_key, only for the rows that must change. `siblings` are the parent's children as stored now; an id in
 *  `orderedIds` that is not among them (a note moving in from another parent) always gets a key.
 *  `moved` names the row the person dragged: among equally small plans, the one that rekeys it wins.
 *
 *  Moving one row between two others is one key between its neighbours' keys (keyBetween), so it writes one row. The
 *  rows kept are the longest chain whose keys already rise strictly in the wanted order; each run of the others between
 *  two kept rows (or before the first, after the last) gets keysBetween those two. Rows with equal keys (two devices
 *  inserted at the same place) cannot both be kept: the plan separates them, once. */
export function planSiblingOrder(siblings: readonly Sibling[], orderedIds: readonly string[], moved?: string): Map<string, string> {
  const byId = new Map(siblings.map((s) => [s.id, s]));
  const n = orderedIds.length;
  const keyAt = (p: number): string | null => byId.get(orderedIds[p]!)?.order_key ?? null;
  const weight = (p: number) => (keyAt(p) === null ? 0 : orderedIds[p] === moved ? 1 : 2);
  // Heaviest chain of rows whose keys rise strictly.
  const best: number[] = new Array(n).fill(0);
  const from: number[] = new Array(n).fill(-1);
  let end = -1;
  for (let j = 0; j < n; j++) {
    if (!weight(j)) continue;
    best[j] = weight(j);
    for (let i = 0; i < j; i++) {
      if (weight(i) && keyAt(i)! < keyAt(j)! && best[i] + weight(j) > best[j]) { best[j] = best[i] + weight(j); from[j] = i; }
    }
    if (end < 0 || best[j] > best[end]) end = j;
  }
  const kept = new Set<number>();
  for (let p = end; p >= 0; p = from[p]!) kept.add(p);

  const changes = new Map<string, string>();
  let p = 0;
  while (p < n) {
    if (kept.has(p)) { p++; continue; }
    let q = p;
    while (q < n && !kept.has(q)) q++;
    const keys = keysBetween(p > 0 ? keyAt(p - 1) : null, q < n ? keyAt(q) : null, q - p);
    for (let k = p; k < q; k++) changes.set(orderedIds[k]!, keys[k - p]!);
    p = q;
  }
  return changes;
}

/** The note to open when `id` is deleted: the next sibling in the sidebar's
 *  natural order (pinned first), else the previous one, else the parent;
 *  null when none is left. */
export function neighborAfterDelete(
  nodes: readonly Pick<ContentNode, "id" | "parent_id" | "node_type" | "hidden" | "order_key" | "order_stamp" | "created_at" | "attrs">[],
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
