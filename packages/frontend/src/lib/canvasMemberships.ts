import type { CanvasMembership } from "@onden/contract";

// "Appears on canvases" (D98): which boards each note is on. The server owns
// it (node_positions rows whose surface is a live canvas, read-filtered at
// both ends); the client holds a copy in the store (`data.canvas_memberships`)
// and in the local mirror, and keeps it current three ways:
//   • a bootstrap replaces the whole list;
//   • a sync delta re-ships the complete list for the nodes it ships
//     (`canvas_memberships.replace_for`, resolved into explicit deletes by
//     the worker's applySync) and drops whatever touches a deleted node;
//   • this device's own board changes apply at once (canvasWriter.change),
//     and are put back if the server refuses them.
// Every path goes through applyCanvasMembershipChange, so the store and the
// mirror apply the same rule.

export type CanvasMembershipKey = Pick<CanvasMembership, "canvas_id" | "node_id">;
/** Rows to add or replace, and rows to remove (by canvas + note). */
export type CanvasMembershipChange = { upsert: CanvasMembership[]; delete: CanvasMembershipKey[] };

const key = (m: CanvasMembershipKey) => `${m.canvas_id}\u0000${m.node_id}`;

/** `held` with `change` applied, minus every membership whose note or canvas
 *  is in `droppedNodeIds` (deleted or no longer readable). Returns `held`
 *  itself when nothing changed, so selectors keep their memo. */
export function applyCanvasMembershipChange(
  held: readonly CanvasMembership[] | undefined,
  change: CanvasMembershipChange | undefined,
  droppedNodeIds: ReadonlySet<string> = new Set(),
): CanvasMembership[] {
  const current = held ?? [];
  if ((!change || (change.upsert.length === 0 && change.delete.length === 0)) && droppedNodeIds.size === 0) {
    return current as CanvasMembership[];
  }
  const byKey = new Map(current.map((m) => [key(m), m]));
  let changed = false;
  for (const m of change?.delete ?? []) changed = byKey.delete(key(m)) || changed;
  for (const m of change?.upsert ?? []) {
    const previous = byKey.get(key(m));
    if (previous && previous.canvas_title === m.canvas_title) continue;
    byKey.set(key(m), { canvas_id: m.canvas_id, canvas_title: m.canvas_title, node_id: m.node_id });
    changed = true;
  }
  for (const [k, m] of byKey) {
    if (droppedNodeIds.has(m.node_id) || droppedNodeIds.has(m.canvas_id)) { byKey.delete(k); changed = true; }
  }
  return changed ? [...byKey.values()] : current as CanvasMembership[];
}

/** The membership change a board edit makes: `placed` notes join canvas
 *  `canvasId` (shown under `canvasTitle`), `removed` ones leave it. */
export function boardMembershipChange(
  canvasId: string, canvasTitle: string, placed: readonly string[], removed: readonly string[],
): CanvasMembershipChange {
  return {
    upsert: placed.map((node_id) => ({ canvas_id: canvasId, canvas_title: canvasTitle, node_id })),
    delete: removed.map((node_id) => ({ canvas_id: canvasId, node_id })),
  };
}
