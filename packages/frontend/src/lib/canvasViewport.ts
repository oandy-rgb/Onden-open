// P0-5 縮放定位: per-canvas viewport (zoom + pan) persistence.
//
// Restoring the camera on re-open used to race React Flow's own `fitView`
// (the <ReactFlow fitView> prop fires on init) via a bare 60ms setTimeout —
// whichever ran last won, so a switch-away/back could land on the fit instead
// of the saved viewport. The fix moves restore off the timer onto onInit and
// gates the auto-fit behind "no stash", so the two are mutually exclusive.
// This module holds the pure read/write/parse so it stays unit-testable.

import { SESSION_KEYS, readSession, writeSession } from "./sessionPrefs";

export type CanvasViewport = { x: number; y: number; zoom: number };

/** A stash is usable only when both pan and zoom are finite numbers. */
export function isValidViewport(v: unknown): v is CanvasViewport {
  if (!v || typeof v !== "object") return false;
  const c = v as Partial<CanvasViewport>;
  return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.zoom);
}

/** Read + parse the saved viewport for a canvas, or null if absent/invalid. */
export function readViewport(canvasId: string | null): CanvasViewport | null {
  if (!canvasId) return null;
  try {
    const raw = readSession(SESSION_KEYS.canvasViewport(canvasId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidViewport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the current viewport for a canvas. No-op on bad input/quota error. */
export function writeViewport(canvasId: string | null, vp: CanvasViewport | null | undefined): void {
  if (!canvasId || !isValidViewport(vp)) return;
  writeSession(SESSION_KEYS.canvasViewport(canvasId), JSON.stringify(vp)); // quota or disabled storage: not kept
}
