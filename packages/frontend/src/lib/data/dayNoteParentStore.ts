// Where new day notes go (the 日記 module's one setting): the id of the note
// they are started under, kept per account (lib/accountPrefStore, pref key
// "dayNoteParent") so it follows the person to every device. null is the
// personal space's top level. The id is not checked here: lib/data/dayNotes
// usableDayNoteParent treats a note that is gone, hidden or in another space
// as the top level, without clearing the choice.
//
// Lives in lib/data (not beside navLayoutStore) because dayNotes uses it.
//
// This used to be a plain local pref (PREFS.dayNoteParent, this device only):
// the factory's `legacy` moves a value still there into the account once.

import { createAccountPref } from "../accountPrefStore";
import { PREFS } from "../prefs";

/** A stored value read back, or null when it is not a note id. */
export function parseDayNoteParent(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

export const dayNoteParentPref = createAccountPref<string>({
  serverKey: "dayNoteParent",
  follows: "account", // where day notes go: about their notes, not the screen
  copy: PREFS.dayNoteParentCopy,
  parse: parseDayNoteParent,
  legacy: { pref: PREFS.dayNoteParent, parse: parseDayNoteParent },
});

export const dayNoteParentStore = dayNoteParentPref.store;

/** The parent note id and a way to change it (lib/syncedPrefStore useSyncedPref). */
export const useDayNoteParent = dayNoteParentPref.useValue;
