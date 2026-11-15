// `[[A#^id]]` when A has no block `^id`: the same id elsewhere in what the
// reader can see (a paragraph moved to a child note, cut and pasted into
// another note, imported from outside). The ONE rule for which note that is;
// the app (via the server's block-ref lookup), the published site and the
// editor all pick through here, so none writes its own fallback.
//
// Order: A itself first (the caller checks A's anchors with noteHasBlock); only
// then the other notes holding that id. A `^id` is unique in a note, not
// across notes, so several may hold it: the ones under A win, then the ones
// in A's space, and what is still not ONE note counts as not found — a guess
// would open the wrong note.
//
// This file is only the test the app's editor runs on every note (noteHasBlock); the choice itself
// (chooseBlockHome) and the published site's use of it (servedBlockPage) are in blockHome.ts, so the
// editor's code does not carry them.

/** Whether the note holds a block with anchor `id` (what a link reaches). `anchorIds`: the ids of the note's valid
 *  anchors (block_anchors) — a block's identity is not in its text. */
export function noteHasBlock(anchorIds: Iterable<string>, id: string): boolean {
  for (const have of anchorIds) if (have === id) return true;
  return false;
}
