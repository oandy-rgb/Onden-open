// "This browser had notes before": the trial version keeps the notes only in this browser, and the browser can lose
// them without telling anyone (the person clears one kind of site data, a clean-up takes the file space). The page then
// opens on the packaged sample notes and nothing says what happened.
//
// A small mark is kept in two places that are not the notes' place (localStorage and IndexedDB; the notes are in OPFS or
// an IndexedDB database of their own). When the worker starts from the packaged database although a mark exists, the notes
// went away: the person is told once and pointed at the restore.
//
// What this does NOT see: clearing ALL site data (the marks go with the notes), a different browser or profile, Safari's
// 7-day clean-up (it takes everything), a private window. "Start over" forgets the marks, because it is the person's choice.

import { PREFS, getPref, removePref, setPref } from "./prefs";

// The mark in IndexedDB is the existence of a database with this name; nothing is stored in it.
const MARK_DB = "onden-trial-mark";

/** Makes the database if it is not there. */
function createMarkDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MARK_DB);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
}

/** Opening a database that is not there would make it: the upgrade that announces this is aborted, which leaves nothing behind. */
function markDbExists(): Promise<boolean> {
  return new Promise((resolve) => {
    const request = indexedDB.open(MARK_DB);
    let missing = false;
    request.onupgradeneeded = () => { missing = true; request.transaction?.abort(); };
    request.onsuccess = () => { request.result.close(); resolve(!missing); };
    request.onerror = () => resolve(false);
  });
}

/** A saved copy of the notes exists in this browser now. Cheap to call again; a failure of either place is not an error. */
export async function markNotesKept(): Promise<void> {
  if (getPref(PREFS.trialHadNotes) !== "1") setPref(PREFS.trialHadNotes, "1");
  try { if (typeof indexedDB !== "undefined") await createMarkDb(); } catch { /* the other mark is still there */ }
}

/** The worker started from the packaged database: was there a saved copy before (either mark says yes)? */
export async function notesWereLost(): Promise<boolean> {
  if (getPref(PREFS.trialHadNotes) === "1") return true;
  try { return typeof indexedDB !== "undefined" && await markDbExists(); } catch { return false; }
}

/** "Start over" is the person erasing the notes: nothing was lost, so nothing is reported next time. */
export async function forgetNotesMark(): Promise<void> {
  removePref(PREFS.trialHadNotes);
  try { if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase(MARK_DB); } catch { /* deletePageDatabases takes it too */ }
}
