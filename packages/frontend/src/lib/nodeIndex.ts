// One id → node index per `nodes` array, kept in a WeakMap keyed by the array
// itself. Every write replaces the array (the store never mutates it), so an
// index cannot drift from its array; a DataCtx that tests give their own data
// gets its own index, and alternating between two arrays does not rebuild.
const indexes = new WeakMap<object, Map<string, { id: string }>>();

export function nodeIndexOf<N extends { id: string }>(nodes: N[]): Map<string, N> {
  let index = indexes.get(nodes) as Map<string, N> | undefined;
  if (!index) {
    index = new Map();
    // First row wins on a duplicate id, like `find`.
    for (const node of nodes) if (!index.has(node.id)) index.set(node.id, node);
    indexes.set(nodes, index);
  }
  return index;
}

/** One node by id out of `data.nodes` in O(1), or undefined. Use it for any AppData
 *  (the store's, a DataCtx's, a preview or a published-site snapshot); the store's own array has
 *  `getNode` / `useNode` in lib/appStore. Do not `data.nodes.find` by id. */
export function nodeOf<N extends { id: string }>(data: { nodes: N[] }, id: string | null | undefined): N | undefined {
  return id ? nodeIndexOf(data.nodes).get(id) : undefined;
}
