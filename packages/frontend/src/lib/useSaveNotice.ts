import { useEffect, useState } from "react";
import type { SaveStatus } from "./appStore";

/** How long a note may stay unsaved/saving (online) before the editor says so. */
export const SLOW_SAVE_MS = 5000;

/** What the editor header shows about saving. "none" takes no space.
 *  - queued: offline, the edit is durable in the outbox but not on the server.
 *  - rejected: the server refused the save; the user can retry.
 *  - slow: unsaved/saving for over SLOW_SAVE_MS while online; clears on its own. */
export type SaveNotice = "none" | "queued" | "rejected" | "slow";

/** Quiet save feedback: routine autosave (unsaved → saving → saved) shows
 *  nothing; only a problem or a stall does. Autosave waits for a pause in
 *  typing, so the stall clock counts from the last edit (`edit` changes on
 *  every keystroke): typing on and on is not a stall. The timer also restarts
 *  when the note or the busy state changes, and is cleared on unmount. */
export function useSaveNotice(saveStatus: SaveStatus, online: boolean, noteId: string, edit: unknown): SaveNotice {
  const busy = (saveStatus === "unsaved" || saveStatus === "saving") && online;
  const [slowFor, setSlowFor] = useState<string | null>(null);
  useEffect(() => {
    setSlowFor(null);
    if (!busy) return;
    const timer = setTimeout(() => setSlowFor(noteId), SLOW_SAVE_MS);
    return () => clearTimeout(timer);
  }, [busy, noteId, edit]);
  if (saveStatus === "queued") return "queued";
  if (saveStatus === "rejected") return "rejected";
  // slowFor is compared with noteId so a note switch never shows the old note's stall.
  return busy && slowFor === noteId ? "slow" : "none";
}
