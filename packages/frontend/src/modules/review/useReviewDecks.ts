import { useLiveResource } from "./useLiveResource";

export type ReviewDeck = { node_id: string; title: string; due: number };

/** GET /api/review/decks — the notes hosting cards due now (a deck = a note
 *  with #review cards directly under it), for the home strip's "study this
 *  lecture" entries. Kept current like useReviewStats (useLiveResource). */
export function useReviewDecks(intervalMs = 60_000): { decks: ReviewDeck[]; refresh: () => Promise<void> } {
  const { value, refresh } = useLiveResource<{ decks: ReviewDeck[] }, ReviewDeck[]>("/api/review/decks", (raw) => raw.decks, EMPTY, intervalMs);
  return { decks: value, refresh };
}

const EMPTY: ReviewDeck[] = [];
