import type { GraphPosition } from "./api";

// Pure helpers for the user's MANUAL node placements on the global graph surface
// (node_positions, surface='graph') — i.e. where someone hand-dragged a node to,
// NOT force-layout output. Kept separate from the React layout so the position
// logic is unit-testable without a DOM — the part that's verifiable before any
// live run.

export type XY = { x: number; y: number };

/** Apply an optimistic local position update to a graph_positions array
 *  (upsert by nodeId), returning a new array — for the drag-then-persist path
 *  so the canvas doesn't snap back while the PUT is in flight. */
export function upsertManualGraphPosition(
  positions: GraphPosition[] | undefined,
  nodeId: string,
  x: number,
  y: number,
): GraphPosition[] {
  const next = (positions ?? []).filter((p) => p.nodeId !== nodeId);
  next.push({ nodeId, x, y });
  return next;
}
