import { upsertManualGraphPosition } from "../manualGraphPositions";
import { makeWriteLifecycle } from "./writeLifecycle";
import { putGraphPosition } from "../localDb";
import type { DataCtx } from "./types";

/** Hand-placed node positions on the global graph (node_positions,
 * surface='graph'). The position shows at once so a drag does not snap back
 * while the PUT is in flight; a refused write puts the previous position back. */
export function makeGraphPositionWriter(ctx: DataCtx) {
  const commit = makeWriteLifecycle(ctx);

  function place(nodeId: string, x: number, y: number) {
    const previous = ctx.data.graph_positions?.find((p) => p.nodeId === nodeId);
    ctx.setData((state) => ({ ...state, graph_positions: upsertManualGraphPosition(state.graph_positions, nodeId, x, y) }));
    return commit(`position:${nodeId}`, {
      method: "PUT", path: `/api/nodes/${nodeId}/position`,
      body: JSON.stringify({ surface: "graph", x, y }),
    }, {
      // The store's current position into the local mirror, so a warm or
      // offline start keeps it (D98).
      mirror: () => {
        const current = ctx.data.graph_positions?.find((p) => p.nodeId === nodeId);
        return putGraphPosition(nodeId, current ? { x: current.x, y: current.y } : null);
      },
      rejected: () => ctx.setData((state) => ({
        ...state,
        graph_positions: previous
          ? upsertManualGraphPosition(state.graph_positions, nodeId, previous.x, previous.y)
          : (state.graph_positions ?? []).filter((p) => p.nodeId !== nodeId),
      })),
    });
  }

  return { place };
}
