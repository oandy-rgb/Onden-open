// Quick-add's 「放在」: which space a new task goes to when nothing else says.
// The sheet shows the choice only with two or more writable spaces (the same
// list the create menu offers: lib/newNoteTarget writableSpaces); with one,
// nothing is asked and the task goes where it always did.

import { getPref, PREFS, removePref, setPref } from "../../lib/prefs";
import { writableSpaces } from "../../lib/newNoteTarget";
import type { Space } from "../../lib/spaces";

/** The space to start on, in order: the space of the note that is open (when
 *  the person can write there), the space chosen last time, the personal space.
 *  Null when there is nothing to choose (fewer than two writable spaces). */
export function defaultTaskSpace(
  spaces: readonly Space[], openNoteSpaceId: string | null | undefined, lastSpaceId: string | null,
): Space | null {
  const writable = writableSpaces(spaces);
  if (writable.length < 2) return null;
  const pick = (id: string | null | undefined) => (id ? writable.find((s) => s.id === id) : undefined);
  return pick(openNoteSpaceId) ?? pick(lastSpaceId) ?? writable.find((s) => s.kind === "personal") ?? writable[0]!;
}

export function lastTaskSpaceId(): string | null {
  return getPref(PREFS.quickAddTaskSpace) || null;
}

export function rememberTaskSpace(spaceId: string): void {
  if (spaceId) setPref(PREFS.quickAddTaskSpace, spaceId); else removePref(PREFS.quickAddTaskSpace);
}
