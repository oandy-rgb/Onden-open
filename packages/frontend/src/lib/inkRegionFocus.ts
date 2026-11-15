// "Open the handwriting page at this region": a tap on a quoted region (`![[drawing|ink=…]]`,
// lib/embedDom) opens the source note through the app's normal navigation (so the back key
// returns to the note it was tapped in) and leaves the region here; the handwriting view that
// opens takes it once, scrolls to it and marks it for a moment. Held for a short time only: an
// open that never reaches a handwriting view (no permission, deleted) must not scroll some later
// visit to the same note.

import type { InkRegion } from "@onden/markdown/ink";

const HELD_MS = 15_000;
let held: { nodeId: string; region: InkRegion; at: number } | null = null;

const listeners = new Map<string, () => void>();

/** Ask for `region` of `nodeId`'s handwriting to be shown. A handwriting view of that note that is already open
 *  (a quote tapped inside the note itself) takes it at once; otherwise it waits for the view that opens. */
export function requestInkRegionFocus(nodeId: string, region: InkRegion): void {
  held = { nodeId, region, at: Date.now() };
  listeners.get(nodeId)?.();
}

/** The open handwriting view of `nodeId` hears requests as they come; returns the unsubscribe. */
export function onInkRegionFocus(nodeId: string, listener: () => void): () => void {
  listeners.set(nodeId, listener);
  return () => { if (listeners.get(nodeId) === listener) listeners.delete(nodeId); };
}

/** The region waiting for `nodeId`'s handwriting view, once; null when none (or it went stale). */
export function takeInkRegionFocus(nodeId: string): InkRegion | null {
  const mine = held && held.nodeId === nodeId && Date.now() - held.at < HELD_MS ? held.region : null;
  if (held && held.nodeId === nodeId) held = null;
  return mine;
}
