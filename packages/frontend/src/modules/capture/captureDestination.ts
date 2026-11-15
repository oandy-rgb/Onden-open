// Where a capture goes when the person names no place: set once in Settings,
// kept for the account (lib/accountPrefStore, pref key "captureDestination") so
// it follows them to every device. There is no hidden default that changes with
// the situation — not the note last chosen, not the note that happens to be
// open — so the person never has to guess where a thought will end up.
//
// Stored as one short word, or a note's id:
//   "inbox" (also when nothing is stored) · "today" · <note id>

import { createAccountPref } from "../../lib/accountPrefStore";
import { t } from "../../lib/i18n";
import { PREFS } from "../../lib/prefs";
import { displayTitle } from "../../lib/noteLabel";

export type CaptureDestination = { kind: "inbox" } | { kind: "today" } | { kind: "note"; noteId: string };

const INBOX: CaptureDestination = { kind: "inbox" };

/** A stored value read back, or null when it is not one. */
export function parseStoredDestination(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

export const captureDestinationPref = createAccountPref<string>({
  serverKey: "captureDestination",
  follows: "account", // where quick capture files notes: about their notes, not the screen
  copy: PREFS.captureDestinationCopy,
  parse: parseStoredDestination,
});

/** The stored word as a destination (nothing stored: the inbox). */
export function destinationOf(stored: string | null | undefined): CaptureDestination {
  if (!stored || stored === "inbox") return INBOX;
  if (stored === "today") return { kind: "today" };
  return { kind: "note", noteId: stored };
}

export function storedOf(destination: CaptureDestination): string {
  return destination.kind === "note" ? destination.noteId : destination.kind;
}

/** What the world allows right now. */
export type DestinationContext = {
  /** The journal module is on. */
  journalOn: boolean;
  /** The note exists and a new note may go under it (a tag, a trashed note or a
   *  note this person cannot edit cannot hold one). */
  noteCanHold: (noteId: string) => boolean;
};

/** The place a capture goes to now: the wanted one while it still works, else the
 *  inbox — a journal that is off, or a note that is gone, never refuses a capture. */
export function usableDestination(wanted: CaptureDestination, { journalOn, noteCanHold }: DestinationContext): CaptureDestination {
  if (wanted.kind === "today") return journalOn ? wanted : INBOX;
  if (wanted.kind === "note") return noteCanHold(wanted.noteId) ? wanted : INBOX;
  return wanted;
}

/** The destination in words: 收件匣 / 今天的日記 / the note's title (never an id). */
export function captureDestinationWords(destination: CaptureDestination, nodes: readonly { id: string; title: string }[]): string {
  if (destination.kind === "inbox") return t("Inbox");
  if (destination.kind === "today") return t("Today's journal");
  return displayTitle(nodes.find((n) => n.id === destination.noteId)?.title);
}
