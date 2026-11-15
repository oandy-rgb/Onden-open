import type { ContentNode } from "../../lib/api";
import { isBrowserOnline } from "../../lib/browserNetwork";
import { reads } from "../../lib/data";

// What the note's own review command offers depends on whether the note is a card itself. The server knows
// (`GET /api/review/cards/:nodeId`); this keeps the answer for the notes already asked about, so a menu may ask freely.
// A menu asks `available` each time it opens, so an answer that arrives later shows from the next opening; the note's header
// (NoteCardPrefetch) asks as soon as the note is selected, so it is normally there before the menu is.

const known = new Map<string, boolean>();
const asking = new Set<string>();

/** Whether the server said this note is a card; `undefined` until it has answered (it is asked about in the background). */
export function noteIsReviewCard(noteId: string): boolean | undefined {
  const answer = known.get(noteId);
  if (answer === undefined && !asking.has(noteId) && isBrowserOnline()) void ask(noteId);
  return answer;
}

/** Record what a change just made the note (or what the server answered). */
export function rememberNoteReviewCard(noteId: string, isCard: boolean): void {
  if (known.get(noteId) === isCard) return;
  known.set(noteId, isCard);
}

async function ask(noteId: string): Promise<void> {
  asking.add(noteId);
  try {
    const answer = await reads.modules.review.resource<{ card: boolean }>(`/api/review/cards/${noteId}`);
    rememberNoteReviewCard(noteId, answer.card);
  } catch {
    // Unknown stays unknown: the "make a card" command shows, and the server decides when it is run.
  } finally {
    asking.delete(noteId);
  }
}

// Not translated on purpose: the same words the server reads as a paragraph's review word, inside a `{…}`.
const REVIEW_WORD_IN_BRACES = /\{[^{}\n]*(?:review|複習)[^{}\n]*\}/i;

/** Whether the note's own review has anything to offer: notes under it, it is a card itself, or a paragraph of it carries the review
 *  word in its `{…}` (those paragraphs are cards, possibly stopped ones the queue no longer shows). */
export function noteHasReviewCards(node: ContentNode, body: string, childCount: number): boolean {
  if (childCount > 0 || noteIsReviewCard(node.id) === true) return true;
  return REVIEW_WORD_IN_BRACES.test(body);
}
