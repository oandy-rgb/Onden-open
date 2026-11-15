// What core asks of the review module (modules/review/seam.ts installs it):
// carry a card's schedule and reference from one place to another when its text moves
// (block ↔ child note, services/blockChildNote.ts), and know the word that makes a
// paragraph a card (services/blockNodes.ts). Core never imports a
// module (modules/README.md); with the module not loaded nothing is copied and
// the schedules stay where they were.

/** Where a card lives: a note or a block node (its schedules: `review_states`). */
export type ReviewTarget = { note: string } | { block: string };

export type ReviewSeam = {
  /** The words (lower case, written without `#`) that make a paragraph a review card when written in its `{…}`: the review
   *  module's own reserved words, whether or not the module is on, never resolved to a tag. A word is left out when the workspace
   *  has an ordinary tag of that name (its `{review}` stays that tag). The word written for a new card is the first one. */
  cardWords(workspaceId: string): Promise<readonly string[]>;
  /** Give these notes or paragraphs their own review reference. Nothing while the module is off here. Call in the writing transaction.
   *  `via: "word"` is the review word in a paragraph's `{…}`: the reference is remembered as made by the word, so it goes when the word
   *  does (`unmarkCardsWord`). `via: "restore"` is a note restored from a backup that made it a card: no tie to any text. */
  markCards(opts: { workspaceId: string; holders: ReadonlyArray<{ kind: "node" | "block"; id: string }>; actorId: string; via: "word" | "restore" }): Promise<void>;
  /** These paragraphs no longer carry the review word: those whose reference the word made stop being cards (the reference goes; every
   *  person's schedule stays, so the word coming back resumes it). References made another way stay. Call in the writing transaction. */
  unmarkCardsWord(opts: { holders: ReadonlyArray<{ kind: "block"; id: string }> }): Promise<void>;
  /** Copy every person's schedule on `from` to `to`, keeping the one that was
   *  reviewed last where `to` already has one. The source is left as it is, so
   *  undoing the move finds it. */
  copyProgress(workspaceId: string, from: ReviewTarget, to: ReviewTarget): Promise<void>;
};

let seam: ReviewSeam | null = null;

export function installReviewSeam(next: ReviewSeam): void {
  seam = next;
}

/** The installed behaviour; null when the review module is not loaded. */
export function reviewSeam(): ReviewSeam | null {
  return seam;
}
