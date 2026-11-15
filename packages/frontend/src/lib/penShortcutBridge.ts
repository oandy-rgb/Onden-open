// Entry point for a native shell (Android / iOS wrapper, not built yet) to
// report a pen shortcut the web cannot see: the S Pen button via the Samsung
// SDK, Apple Pencil double-tap / squeeze via UIPencilInteraction.
//
//   window.ondenPenShortcut("apple-pencil-double-tap")
//   window.dispatchEvent(new CustomEvent("onden:pen-shortcut", { detail: { source: "s-pen-button" } }))
//
// Both do the same thing. The page's ink host that is on screen handles it by
// switching pen ↔ eraser (usePenShortcutTool); the event is cancelable and the
// first host that takes it calls preventDefault, so two hosts never both toggle.
// With no shell nothing calls this and nothing listens for anything else.

export const PEN_SHORTCUT_EVENT = "onden:pen-shortcut";

export type PenShortcutSource = "s-pen-button" | "apple-pencil-double-tap" | "apple-pencil-squeeze";

declare global {
  interface Window {
    /** For a native shell: report a pen shortcut. Returns whether an ink host took it. */
    ondenPenShortcut?: (source?: PenShortcutSource) => boolean;
  }
}

/** Report a pen shortcut. True when an ink host switched the tool. */
export function emitPenShortcut(source?: PenShortcutSource): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent(PEN_SHORTCUT_EVENT, { detail: { source }, cancelable: true });
  // dispatchEvent is false when a host called preventDefault = took it.
  return !window.dispatchEvent(event);
}

/** Install `window.ondenPenShortcut` once at startup. */
export function installPenShortcutBridge(): void {
  if (typeof window === "undefined") return;
  window.ondenPenShortcut = emitPenShortcut;
}

/** Listen as an ink host; `handle` returns true when it took the shortcut. */
export function onPenShortcutEvent(handle: () => boolean): () => void {
  const listener = (e: Event) => {
    if (e.defaultPrevented) return;
    if (handle()) e.preventDefault();
  };
  window.addEventListener(PEN_SHORTCUT_EVENT, listener);
  return () => window.removeEventListener(PEN_SHORTCUT_EVENT, listener);
}
