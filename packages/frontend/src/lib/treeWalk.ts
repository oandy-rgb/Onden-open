// Walking the note tree and the tag tree by `parent_id`: ancestors, the subtree
// under a row, "is this under that". Both trees have the same shape, so the same
// walks serve both, with ONE rule for corrupt data: a parent chain that loops, or
// points at a row that is not in the list, simply ends there. Nothing here
// throws or spins; callers that need a walk do not write their own loop.

export type TreeRow = { id: string; parent_id?: string | null };

/** Index rows by id once; the walks below take it so a render pass that asks
 *  about many rows builds the lookup a single time. */
export function indexById<T extends TreeRow>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/** The rows above `from`, root first and its parent last (`from` itself is not
 *  included, and need not be in `byId`). */
export function ancestorsOf<T extends TreeRow>(byId: ReadonlyMap<string, T>, from: TreeRow): T[] {
  const path: T[] = [];
  const visited = new Set<string>([from.id]);
  let parentId = from.parent_id;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    path.unshift(parent);
    parentId = parent.parent_id;
  }
  return path;
}

/** Whether row `id` sits strictly under `ancestorId` (a row is not under itself). */
export function isUnder(byId: ReadonlyMap<string, TreeRow>, id: string, ancestorId: string): boolean {
  const from = byId.get(id);
  return !!from && ancestorsOf(byId, from).some((ancestor) => ancestor.id === ancestorId);
}

/** `rootId` and the id of every row under it. */
export function subtreeIdsOf(rows: readonly TreeRow[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parent_id) continue;
    const list = childrenOf.get(row.parent_id) ?? [];
    list.push(row.id);
    childrenOf.set(row.parent_id, list);
  }
  const found = new Set<string>([rootId]);
  const queue = [rootId];
  // An id is queued the first time it is seen, so a loop (A→B→A) ends the walk.
  for (let at = 0; at < queue.length; at++) {
    for (const id of childrenOf.get(queue[at]!) ?? []) {
      if (!found.has(id)) { found.add(id); queue.push(id); }
    }
  }
  return found;
}
