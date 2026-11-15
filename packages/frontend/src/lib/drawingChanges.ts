// "This note's handwriting changed": the one signal quoted areas of a drawing (`![[drawing|ink=…]]`,
// lib/embedDom) listen to, so they redraw. It is raised when a stroke, text box or picture is saved here
// (lib/data/inkWriter, pageLayerWriter) and when another device's change of them arrives by sync
// (announceDrawingChangesOf, from the sync engine). Every change also bumps a serial per note
// (drawingChangeSerial): readers that kept a copy of the drawing compare it, so however many embeds
// of one note redraw they share one read of the new value. No imports.

const listeners = new Map<string, Set<() => void>>();
const serials = new Map<string, number>();

/** How many times `nodeId`'s handwriting has changed since the page loaded; a copy read at another number is stale. */
export const drawingChangeSerial = (nodeId: string): number => serials.get(nodeId) ?? 0;

/** Tell the pictures of `nodeId`'s handwriting that it changed. */
export function announceDrawingChange(nodeId: string): void {
  serials.set(nodeId, drawingChangeSerial(nodeId) + 1);
  for (const listener of [...(listeners.get(nodeId) ?? [])]) listener();
}

/** Call `listener` on every change of `nodeId`'s handwriting; returns the unsubscribe. */
export function onDrawingChange(nodeId: string, listener: () => void): () => void {
  const set = listeners.get(nodeId) ?? new Set();
  set.add(listener);
  listeners.set(nodeId, set);
  return () => { set.delete(listener); if (set.size === 0) listeners.delete(nodeId); };
}

/** A sync delta that arrived from the server (another device's edits): announce every drawing it touched — a drawing
 *  or page-layer attribute written. (A note row alone — a rename — is not a change of its drawing.) Drawings
 *  nobody quotes have no listener, so the cost is only for what is on the screen. */
export function announceDrawingChangesOf(delta: {
  attributes?: { upsert?: ReadonlyArray<{ node_id?: unknown; key?: unknown }> };
}): void {
  const ids = new Set<string>();
  for (const row of delta.attributes?.upsert ?? []) {
    if (row.key === "ink_data" || row.key === "page_text" || row.key === "page_images") ids.add(String(row.node_id));
  }
  for (const id of ids) announceDrawingChange(id);
}
