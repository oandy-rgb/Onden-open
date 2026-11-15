import { useSyncExternalStore } from "react";

// Where a brand-new workspace lands. Seeding the example notes (hooks/useFirstRunSeeding) and
// choosing the landing note (hooks/useLandingNote) are two hooks that run on the same first
// load; this is the one fact they share: 「the examples are being written / were written, and
// this is the welcome note」. Landing waits while it is "seeding", then opens that note ONCE;
// every later launch follows the person's 「打開時」 setting.

type FirstRunLanding = { phase: "idle" | "seeding" | "done"; welcomeNoteId: string | null };

let state: FirstRunLanding = { phase: "idle", welcomeNoteId: null };
const listeners = new Set<() => void>();
function set(next: FirstRunLanding) { state = next; listeners.forEach((listener) => listener()); }

/** Seeding began (claimed before its first write, so landing never races it). */
export function beginFirstRunLanding(): void { set({ phase: "seeding", welcomeNoteId: null }); }
/** Seeding ended; `welcomeNoteId` is the first example note, or null when none was written. */
export function finishFirstRunLanding(welcomeNoteId: string | null): void { set({ phase: "done", welcomeNoteId }); }
/** Landing used (or skipped) it: later changes to the note set never land here again. */
export function consumeFirstRunLanding(): void { set({ phase: "idle", welcomeNoteId: null }); }

export function useFirstRunLanding(): FirstRunLanding {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
}

// The browser app's first open made Chinese sample notes, so the welcome card is not offered in full but still asks
// for the interface language once. Memory only: after a reload the card is simply not shown again.
let samplesMade = false;
export function markSampleNotesMade(): void { samplesMade = true; }
export function sampleNotesWereMade(): boolean { return samplesMade; }
