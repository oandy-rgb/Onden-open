// The note size caps behind REST (depth audit D67). DraftNode refused an
// over-size note at the HTTP edge only, so an importer or a module could store
// one the next edit then refused forever (a 2.1M-character Obsidian file
// imported, then every save was a 400). createNote and applyBodyChange call
// assertNoteSize, so no path stores a note REST would refuse.
//
// Refuse or shorten: a body is never cut (that would lose text), so an
// over-size body is refused here and skipped as `too_large` by the importers.
// A title the caller typed is refused too; a title derived from content (a
// heading, a file name, a feed item, a page title, a CSV cell) is shortened by
// its caller with clampNoteTitle before it gets here.

import { NODE_MARKDOWN_MAX, NODE_TITLE_MAX, noteSizeProblem } from "@onden/markdown";

/** A note over a size cap. Answers 400 at the HTTP boundary (httpError.ts),
 *  the same status DraftNode gives the same input. */
export class NoteSizeError extends Error {
  readonly status = 400 as const;
  constructor(readonly code: "too_large" | "title_too_long" | "contains_nul" | "invalid_text") {
    super(code === "too_large"
      ? `note body exceeds ${NODE_MARKDOWN_MAX} characters`
      : code === "contains_nul" ? "note text contains a NUL character"
      : code === "invalid_text" ? "note text contains a lone surrogate"
      : `note title exceeds ${NODE_TITLE_MAX} characters`);
  }
}

/** Throw NoteSizeError when `note` breaks a cap. */
export function assertNoteSize(note: { title?: string | null; markdown?: string | null }): void {
  const problem = noteSizeProblem(note);
  if (problem) throw new NoteSizeError(problem);
}
