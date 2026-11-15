// The note a typed name points at (quick capture's `[[name`, quick-add's `@name`):
// the one whose title is the name (any case), else the search's first plain
// note — only one the caller says may hold what is being written.

import { reads } from "./data";
import { listsAsNote } from "./nodeTags";

export async function noteNamed(name: string, canHold: (noteId: string) => boolean): Promise<{ id: string; title: string } | null> {
  try {
    const { rows } = await reads.notes.search(name);
    const usable = rows.filter((row) => listsAsNote(row) && canHold(row.id));
    return usable.find((row) => row.title.toLowerCase() === name.toLowerCase()) ?? usable[0] ?? null;
  } catch {
    return null;
  }
}
