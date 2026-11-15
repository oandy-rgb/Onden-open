import { dayNoteDate, parseExcerpts, type Excerpt } from "@onden/markdown";
import { addDays } from "../../lib/localDate";
import { anchorSpansOf } from "../../lib/blockAnchorStore";
import { isNote } from "@onden/markdown/contract";

// 「這週讀到的」: the excerpts taken from feeds in the notes of this week.
//
// An excerpt carries no time of its own (docs/architecture/excerpts.md), so a
// note counts by when it was written: a day note by its day, any other note by
// its last edit. A note edited this week can therefore bring along an older
// excerpt; the card is a prompt to write, not a ledger. Only excerpts that
// name a feed count (an excerpt from the reader, not from elsewhere).

/** The Monday of the week containing `today` (date ids). */
export function weekStartId(today: string): string {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(today, -((day + 6) % 7));
}

export type WeekExcerpt = { noteId: string; noteTitle: string; excerpt: Excerpt };

type NoteLike = { id: string; title?: string; slug?: string; hidden?: boolean; node_type?: string; deleted_at?: string | null; markdown?: string | null; updated_at?: string | null };

/** The live notes of this week (a day note by its day, another by its last edit), newest first, each with the day it counts for. */
export function notesOfThisWeek<T extends NoteLike>(notes: readonly T[], today: string, dayOf: (iso: string) => string): Array<{ note: T; at: string }> {
  const start = weekStartId(today);
  const found: Array<{ note: T; at: string }> = [];
  for (const note of notes) {
    if (!isNote(note) || note.deleted_at) continue;
    const at = dayNoteDate(note) ?? (note.updated_at ? dayOf(note.updated_at) : null);
    if (at && at >= start && at <= today) found.push({ note, at });
  }
  return found.sort((a, b) => b.at.localeCompare(a.at));
}

/** The week's excerpts from feeds, newest note first. `bodyOf` is a note's text (the store's, or one fetched for a slim row); none = the note is skipped. */
export function excerptsThisWeek(notes: readonly NoteLike[], today: string, dayOf: (iso: string) => string, bodyOf: (note: NoteLike) => string | null | undefined = (n) => n.markdown, anchorsOf: (noteId: string, body: string) => ReturnType<typeof anchorSpansOf> = anchorSpansOf): WeekExcerpt[] {
  const found: WeekExcerpt[] = [];
  for (const { note } of notesOfThisWeek(notes, today, dayOf)) {
    const body = bodyOf(note);
    if (!body) continue;
    for (const excerpt of parseExcerpts(body, anchorsOf(note.id, body))) {
      if (excerpt.feed) found.push({ noteId: note.id, noteTitle: note.title ?? "", excerpt });
    }
  }
  return found;
}
