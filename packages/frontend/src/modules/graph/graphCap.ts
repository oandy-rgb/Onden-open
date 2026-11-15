// Node-count cap + level-of-detail helper for the all-cards force graph.
//
// react-force-graph runs a d3 force simulation on every node + link each tick;
// past a few hundred nodes the main thread stalls (freeze risk). We cap how
// many nodes are handed to the engine and surface a "showing N of M" notice so
// the truncation is honest rather than silent. The cap is deterministic
// (stable slice) so the view doesn't reshuffle between renders, and it always
// keeps the currently-selected node so three-view selection sync never points
// at an absent node.

export const GRAPH_NODE_CAP = 400;

export type CapResult<T> = {
  /** The capped subset handed to the renderer. */
  shown: T[];
  /** Total candidate count before the cap (post visibility-filter). */
  total: number;
  /** True when the cap actually dropped nodes. */
  capped: boolean;
};

/**
 * Cap a list of nodes to at most `cap`, always retaining the node matching
 * `keepId` (if present). Order of the kept nodes is otherwise preserved so the
 * layout stays stable across renders.
 */
export function capGraphNodes<T extends { id: string }>(
  nodes: T[],
  cap: number = GRAPH_NODE_CAP,
  keepId?: string | null,
): CapResult<T> {
  const total = nodes.length;
  if (total <= cap) {
    return { shown: nodes, total, capped: false };
  }

  const shown = nodes.slice(0, cap);
  // Guarantee the selected node survives the cap even if it sat past the slice.
  if (keepId && !shown.some((n) => n.id === keepId)) {
    const sel = nodes.find((n) => n.id === keepId);
    if (sel) {
      // Drop the last slot to make room, keeping length == cap.
      shown[shown.length - 1] = sel;
    }
  }
  return { shown, total, capped: true };
}
