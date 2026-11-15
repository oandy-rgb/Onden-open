// The one pending 「these cards can't be seen by everyone on the board」 reminder, between the
// placement owner (hooks/useBoardWorkspace) and its screen (components/BoardCardAudienceConfirm).
// Kept apart from lib/boardCardAudience (which looks things up) so the workspace only loads that
// logic when a note is placed; this store is all the boot code needs to know when to show the screen.
import { useSyncExternalStore } from "react";
import type { ContentNode } from "./api";
import type { MovePreviewNumericEpoch, Space } from "./spaces";

export type AudienceChoice = "move" | "keep" | "cancel";

/** The cards waiting for the person's answer: one confirmation for all of them. */
export type CardAudienceReview = {
  to: Space;
  /** Notes that some people of the board cannot see, with where each lives now. */
  hidden: Array<{ node: ContentNode; from: string }>;
  /** What moving them all would change (merged over the notes). */
  preview: MovePreviewNumericEpoch;
  /** `moved`: how many of `hidden` are in the board's space now (only for "move"). */
  answer: (choice: AudienceChoice, moved?: number) => void;
};

let current: CardAudienceReview | null = null;
const listeners = new Set<() => void>();

export function publishCardAudienceReview(next: CardAudienceReview | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function useCardAudienceReview(): CardAudienceReview | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
}
