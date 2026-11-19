// The one owner of sessionStorage in the frontend: small per-tab memory (caret
// handoff, canvas view, a reload guard). Reads and writes never throw: a
// blocked or full store (private window, embeds) reads as missing, and a
// write says whether it landed for the few callers that must know.
//
// Keys live here so the writer and the reader of one value cannot drift apart.

export const SESSION_KEYS = {
  /** `{anchor, head}` of the caret last seen in a note (restored on return). */
  cursor: (nodeId: string) => `onden.cursor.${nodeId}`,
  /** One-shot jump target from a backlink or mention; the editor consumes it. */
  pendingCursor: (nodeId: string) => `onden.pendingCursor.${nodeId}`,
  canvasViewport: (canvasId: string) => `onden.canvasViewport.${canvasId}`,
  /** The mark that limits automatic reloads for a stale chunk to one. */
  chunkReload: "onden.chunkReload",
  /** How many notes' unsent text the last reload left in recovery. */
  reloadNotice: "onden.reloadNotice",
  /** The server build the person already reloaded for. */
  buildNotice: "onden.buildNotice",
  inviteToken: "onden.inviteToken",
  /** The one write a tab of the build before 2026-11-19 had on the wire, per account (that build sent saves without a
   *  queue row). Read once and removed after the upgrade (writeQueue.adoptUnconfirmedWrites); no build writes it now. */
  legacyWriteInFlight: "onden-write-in-flight",
} as const;

/** A temporary session (lib/temporaryStorage.ts) keeps even this per-tab memory out of the browser's own store, which a
 *  reload of the tab would otherwise carry over. */
let replacement: Storage | null = null;
export function replaceSessionStore(memory: Storage): void { replacement = memory; }

function store(): Storage | null {
  if (replacement) return replacement;
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

/** Whether this tab can keep per-tab memory at all. */
export function sessionAvailable(): boolean {
  try { return store() !== null && (store()!.getItem("onden.probe"), true); } catch { return false; }
}

export function readSession(key: string): string | null {
  try { return store()?.getItem(key) ?? null; } catch { return null; }
}

/** False when the value did not land (blocked, full, or no storage). */
export function writeSession(key: string, value: string): boolean {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch { return false; }
}

export function removeSession(key: string): void {
  try { store()?.removeItem(key); } catch { /* nothing to forget */ }
}
