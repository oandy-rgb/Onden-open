// The history of ONE paragraph: every different wording it has had, found by
// walking the note's saved versions from now backwards and following the
// paragraph through each by position and likeness (alignParagraphs). Versions
// saved before migration 180 may carry a paragraph's ` ^id`, which pairs it
// exactly; later ones carry none (a paragraph's identity is its anchor, and a
// version does not record where the anchors were), so a paragraph rewritten
// past likeness in one save is not followed further back. Pure; the sheet
// (components/history/BlockHistorySheet) shows it and the editor swaps the text.

import { matchParagraphs, splitParagraphs, type Paragraph } from "@onden/markdown";
import { authorKindOf, type AuthorKind } from "./noteTimeline";

/** One row of `GET /api/nodes/:id/versions?raw=1`: the note as one save left it. */
export type BlockSourceVersion = {
  id: string;
  markdown: string;
  changed_at: string;
  actor_name: string | null;
  actor_type: string | null;
  /** The kind the server worked out ('session' for a temporary session, which has no name); an older server sends none. */
  actor_kind?: AuthorKind;
};

/** The server returns at most this many raw rows; with fewer, the oldest is the first save. */
export const RAW_VERSION_LIMIT = 50;

export type BlockVersion = {
  /** The paragraph's wording in this version (its trailing ` ^id` left out). */
  text: string;
  /** The save that first wrote this wording; null for an edit not saved yet. */
  versionId: string | null;
  changedAt: string | null;
  actorName: string | null;
  /** Who wrote it, as the history screens word it (historyAuthor). */
  actorKind: AuthorKind;
  /** The paragraph did not exist before this version. */
  created: boolean;
  /** The wording the note has now: the last entry, always. */
  current: boolean;
};

export type BlockTarget = {
  /** The note as it is now (the editor's text, saved or not). */
  markdown: string;
  /** Any offset inside the paragraph. */
  offset: number;
};

const lf = (s: string) => s.replace(/\r\n?/g, "\n");

/** The paragraph at `offset` (the last one starting at or before it), or its index -1. */
export function paragraphIndexAt(paragraphs: readonly Paragraph[], offset: number): number {
  let found = -1;
  for (let i = 0; i < paragraphs.length && paragraphs[i].start <= offset; i++) found = i;
  return found;
}

/** The text of the heading a paragraph sits under, or null above the first. */
export function headingAbove(markdown: string, offset: number): string | null {
  const paragraphs = splitParagraphs(lf(markdown));
  for (let i = paragraphIndexAt(paragraphs, offset) - 1; i >= 0; i--) {
    if (paragraphs[i].kind === "heading") return paragraphs[i].section;
  }
  return null;
}

/** Oldest wording first, the current one last. Versions are newest first, as
 *  the server sends them. Consecutive saves with the same wording are one
 *  entry, credited to the save that wrote it. The first entry is `created`
 *  when the paragraph cannot be found in an older save (or none is left). */
export function blockHistory(versions: readonly BlockSourceVersion[], target: BlockTarget): BlockVersion[] {
  // CRLF becomes LF before splitting, which moves every offset after it.
  const offset = target.offset - (target.markdown.slice(0, target.offset).match(/\r\n/g)?.length ?? 0);
  const now = splitParagraphs(lf(target.markdown));
  let tracked = paragraphIndexAt(now, offset);
  if (tracked < 0 || now[tracked].kind === "frontmatter") return [];

  // Newest first: [current, ...one per save the paragraph was found in].
  type Step = { text: string; version: BlockSourceVersion | null };
  const steps: Step[] = [{ text: now[tracked].body, version: null }];
  let newer: readonly Paragraph[] = now;
  let reachedStart = true;
  let lastMarkdown: string | null = null;
  let lastParagraphs: Paragraph[] = [];
  for (const version of versions) {
    if (version.markdown !== lastMarkdown) { lastMarkdown = version.markdown; lastParagraphs = splitParagraphs(lf(version.markdown)); }
    const match = matchParagraphs(lastParagraphs, newer)[tracked];
    if (match < 0) { reachedStart = false; break; }
    steps.push({ text: lastParagraphs[match].body, version });
    newer = lastParagraphs;
    tracked = match;
  }
  const created = !reachedStart || versions.length < RAW_VERSION_LIMIT;

  // Group runs of the same wording (steps are newest first) into entries.
  const entries: BlockVersion[] = [];
  for (let i = 0; i < steps.length;) {
    let j = i;
    while (j + 1 < steps.length && steps[j + 1].text === steps[i].text) j++;
    const author = steps.slice(i, j + 1).reverse().find((s) => s.version)?.version ?? null;
    entries.push({
      text: steps[i].text,
      versionId: author?.id ?? null,
      changedAt: author?.changed_at ?? null,
      actorName: author?.actor_name ?? null,
      actorKind: author ? authorKindOf(author) : "human",
      created: false,
      current: i === 0,
    });
    i = j + 1;
  }
  entries.reverse();
  entries[0].created = created;
  return entries;
}
