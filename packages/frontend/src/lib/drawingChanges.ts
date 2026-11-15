// "This note's handwriting changed": the one signal quoted areas of a drawing (`![[drawing|ink=…]]`,
// lib/embedDom) listen to, so they redraw. It is raised when a stroke, text box or picture is saved here
// (lib/data/inkWriter, pageLayerWriter) and when another device's change of them arrives by sync
// (announceDrawingChangesOf, from the sync engine). Every change also bumps a serial per note
// (drawingChangeSerial): readers that kept a copy of the drawing compare it, so however many embeds
// of one note redraw they share one read of the new value. No imports.

/** A counter per note and the listeners of its changes (one for each signal below). */
function signal() {
  const listeners = new Map<string, Set<() => void>>();
  const serials = new Map<string, number>();
  return {
    serial: (nodeId: string): number => serials.get(nodeId) ?? 0,
    raise(nodeId: string): void {
      serials.set(nodeId, (serials.get(nodeId) ?? 0) + 1);
      for (const listener of [...(listeners.get(nodeId) ?? [])]) listener();
    },
    on(nodeId: string, listener: () => void): () => void {
      const set = listeners.get(nodeId) ?? new Set();
      set.add(listener);
      listeners.set(nodeId, set);
      return () => { set.delete(listener); if (set.size === 0) listeners.delete(nodeId); };
    },
  };
}
const changes = signal();

/** How many times `nodeId`'s handwriting has changed since the page loaded; a copy read at another number is stale. */
export const drawingChangeSerial = (nodeId: string): number => changes.serial(nodeId);

/** Tell the pictures of `nodeId`'s handwriting that it changed. */
export const announceDrawingChange = (nodeId: string): void => changes.raise(nodeId);

/** Call `listener` on every change of `nodeId`'s handwriting; returns the unsubscribe. */
export const onDrawingChange = (nodeId: string, listener: () => void): (() => void) => changes.on(nodeId, listener);

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

// ── A version of the drawing was put back (History 「回到這個版本」) ───────────────────────────────────────────────
// A surface that shows the drawing must load it again: what it shows is the version from before, and its next stroke
// would be saved as "that version + the stroke", which differs from what the person sees (docs/research/scan-2026-11-14/09-ink-pdf.md M4).
// Separate from the change signal above: pictures redraw on every save, a surface reloads (and drops its undo history)
// only for this.
const restores = signal();

/** How many times a version of `nodeId`'s drawing was put back since the page loaded. */
export const drawingRestoreSerial = (nodeId: string): number => restores.serial(nodeId);

/** The server took a drawing of `nodeId` back to an earlier version (the local copy holds it now). */
export function announceDrawingRestored(nodeId: string): void {
  restores.raise(nodeId);
  announceDrawingChange(nodeId);
}

/** Call `listener` after every restore of `nodeId`'s drawing; returns the unsubscribe. */
export const onDrawingRestored = (nodeId: string, listener: () => void): (() => void) => restores.on(nodeId, listener);
