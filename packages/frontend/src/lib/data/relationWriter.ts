import type { NodeEdge } from "../api";
import { upsertEdge, removeEdge } from "../localDb";
import { randomUUID } from "../uuid";
import { makeWriteLifecycle, reconcileFields } from "./writeLifecycle";
import type { DataCtx } from "./types";

export function makeRelationWriter(ctx: DataCtx) {
  const commit = makeWriteLifecycle(ctx);

  async function connect(sourceId: string, targetId: string, edgeType: NodeEdge["edge_type"]) {
    const id = randomUUID();
    const edge: NodeEdge = { id, source_node_id: sourceId, target_node_id: targetId, edge_type: edgeType, status: "active" };
    // The server stores a POSTed edge as origin "manual" (its column default);
    // the local row says so too, so lib/edgeRoles reads it as drawn by hand.
    ctx.setData((state) => ({ ...state, edges: [...state.edges, { ...edge, origin: "manual" }] }));
    let storedId = id;
    return commit<NodeEdge>(`edge:${id}`, { method: "POST", path: "/api/edges", body: JSON.stringify(edge), idemKey: id }, {
      mirror: async () => {
        const current = ctx.data.edges.find((row) => row.id === storedId);
        if (current) await upsertEdge(current);
        else await removeEdge(storedId);
      },
      accepted: async (saved) => {
        if (saved.status !== "synced" || !saved.value?.id) return;
        const server = saved.value;
        ctx.setData((state) => ({ ...state, edges: state.edges.filter((row) => row.id === id || row.id !== server.id).map((row) => row.id === id ? reconcileFields(row, edge, server) : row) }));
        storedId = server.id;
        if (storedId !== id) await removeEdge(id);
      },
      rejected: () => ctx.setData((state) => ({ ...state, edges: state.edges.filter((row) => row.id !== id) })),
    });
  }

  async function remove(id: string) {
    const previous = ctx.data.edges.find((edge) => edge.id === id);
    ctx.setData((state) => ({ ...state, edges: state.edges.filter((edge) => edge.id !== id) }));
    return commit(`edge:${id}`, { method: "DELETE", path: `/api/edges/${id}`, body: null }, {
      destructive: true,
      mirror: () => removeEdge(id),
      rejected: () => {
        if (previous) ctx.setData((state) => state.edges.some((edge) => edge.id === id) ? state : { ...state, edges: [...state.edges, previous] });
      },
    });
  }

  return { connect, remove };
}
