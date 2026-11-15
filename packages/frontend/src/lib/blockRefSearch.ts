// `((` in the editor: one search box over the paragraphs and headings of every
// note the reader can see (docs/architecture/block-nodes.md).
//
// It does not scan note bodies. The note index answers first — the server's
// full-text search, or this device's own index when offline (reads.notes.search,
// the same call the command palette makes) — and only those few candidate notes
// are cut into paragraphs (@onden/markdown listLinkTargets, the parser the
// `[[Note#` list uses) and filtered. A keystroke costs one index query plus the
// notes it names, not the whole workspace; the parsed notes are kept, so typing
// on re-reads nothing.
//
// The rows are the `[[Note#` list's own (lib/wikilinkTargets LinkTargetRow), so
// choosing one writes the same link by the same path (editorCompletion
// applyLinkTarget): a part link `[[Note/words]]` the server anchors; nothing is written into the note.

import { listLinkTargets, type LinkTarget } from "@onden/markdown";
import { anchorSpansOf } from "./blockAnchorStore";
import { matchTitle } from "./noteSearch";
import { targetRows, type LinkTargetRow } from "./wikilinkTargets";
import type { RecentBlock } from "./recentBlocksStore";

/** A row of the `((` list (or the `[[` list's 「最近存的段落」): where it comes from. */
export type BlockRefRow = LinkTargetRow & {
  origin: "recent" | "found";
  /** What the row shows: the words around the match (or the start of the
   *  paragraph), with the match's ranges inside it. */
  snippet: { text: string; ranges: [number, number][] };
};

export const isBlockRefRow = (item: unknown): item is BlockRefRow => typeof item === "object" && item !== null && "origin" in item && "__target" in item;

/** The most rows the `((` list shows. */
export const BLOCK_REF_ROWS = 20;
/** How many notes the index may name before they are cut into paragraphs. */
export const BLOCK_REF_NOTES = 12;
/** How many 「最近存的段落」 the plain `[[` list adds above the notes. */
export const RECENT_ROWS_IN_WIKILINK = 4;

export type NoteForRefs = { id: string; title: string; sameNote: boolean; writable: boolean };

/** The rows of one note's `targets` that `filter` finds (all of them when it
 *  is empty), tagged with where they come from. */
export function blockRefRows(filter: string, targets: readonly LinkTarget[], note: NoteForRefs, origin: BlockRefRow["origin"]): BlockRefRow[] {
  // A `((` link always names its note (`[[Note/words]]`), even inside that note.
  return targetRows({ blocksOnly: false, filter, noteTyped: true }, targets, note)
    .map((row) => ({ ...row, origin, snippet: snippetOf(row.target, filter) }));
}

const SNIPPET_BEFORE = 24;
const SNIPPET_LENGTH = 90;

/** The words of `target` around where `filter` matches, cut to a line's worth. */
function snippetOf(target: LinkTarget, filter: string): BlockRefRow["snippet"] {
  const text = target.kind === "heading" ? target.text : target.text.replace(/\s+/g, " ");
  const hit = filter.trim() ? matchTitle(filter, text) : null;
  const first = hit?.ranges[0]?.[0] ?? 0;
  let from = first > SNIPPET_BEFORE ? first - SNIPPET_BEFORE : 0;
  // Start on a word, not in the middle of one (text with no spaces is cut where it falls).
  if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space !== -1 && space < first) from = space + 1;
  }
  const to = Math.min(text.length, from + SNIPPET_LENGTH);
  const lead = from > 0 ? "…" : "";
  const ranges = (hit?.ranges ?? []).flatMap(([a, b]): [number, number][] => {
    const start = Math.max(a, from), end = Math.min(b, to);
    return start < end ? [[start - from + lead.length, end - from + lead.length]] : [];
  });
  return { text: `${lead}${text.slice(from, to)}${to < text.length ? "…" : ""}`, ranges };
}

/** 「最近存的段落」 as rows, newest first: each entry becomes the paragraph that
 *  still has its anchor; an entry whose note or paragraph is gone (or not
 *  readable: `read` answers null) is left out. `filter` narrows them like a search. */
export function recentRows(
  recent: readonly RecentBlock[],
  read: (noteId: string) => { note: NoteForRefs; targets: readonly LinkTarget[] } | null,
  filter: string,
): BlockRefRow[] {
  const rows: BlockRefRow[] = [];
  for (const entry of recent) {
    const found = read(entry.note);
    // A paragraph that had no anchor when its link was copied is found by what it says (it may have one by now).
    const pending = entry.pending;
    const target = found?.targets.find((t) => t.kind === "block" && t.ref === entry.ref)
      ?? (pending ? found?.targets.find((t) => t.kind === "block" && t.blockKind === pending.blockKind && t.text === pending.text) : undefined);
    if (!found || !target) continue;
    rows.push(...blockRefRows(filter, [target], found.note, "recent"));
  }
  return rows;
}

/** Rows found by search, without the ones already listed as recent. */
export function withoutListed(rows: readonly BlockRefRow[], listed: readonly BlockRefRow[]): BlockRefRow[] {
  const key = (row: BlockRefRow) => `${row.noteId}:${row.target.kind === "block" ? row.target.ref ?? `@${row.target.start}` : `#${row.target.start}`}`;
  const seen = new Set(listed.map(key));
  return rows.filter((row) => !seen.has(key(row)));
}

/** A note's paragraphs, cut once per text: the same text is not parsed twice. */
export function createTargetCache(max = 64) {
  const kept = new Map<string, { body: string; targets: LinkTarget[] }>();
  return (id: string, body: string): LinkTarget[] => {
    const hit = kept.get(id);
    if (hit && hit.body === body) return hit.targets;
    const targets = listLinkTargets(body, anchorSpansOf(id, body));
    kept.delete(id);
    kept.set(id, { body, targets });
    if (kept.size > max) kept.delete(kept.keys().next().value!);
    return targets;
  };
}

export type BlockRefSources = {
  /** The notes the index names for `query`, best first (reads.notes.search). */
  search: (query: string, signal?: AbortSignal) => Promise<ReadonlyArray<{ id: string }>>;
  /** The note as the reader can see it, or null (gone, or not visible). */
  note: (id: string) => NoteForRefs | null;
  /** The note's text for reading, or null when none can answer (reads.notes.body). */
  body: (id: string) => Promise<string | null>;
  targets: (id: string, body: string) => LinkTarget[];
  /** The note being edited: its text is the editor's own, and it is searched
   *  even when the index has not caught up with the last words typed. */
  current: { id: string; text: () => string } | null;
};

/** The paragraphs and headings that contain `query`, from the notes the index
 *  names (at most BLOCK_REF_NOTES, the open note first), at most BLOCK_REF_ROWS. */
export async function findBlockRefs(query: string, src: BlockRefSources, signal?: AbortSignal): Promise<BlockRefRow[]> {
  const filter = query.trim();
  if (!filter) return [];
  const named = (await src.search(filter, signal)).map((hit) => hit.id);
  const ids = [...new Set([...(src.current ? [src.current.id] : []), ...named])].slice(0, BLOCK_REF_NOTES);
  // Texts are read together; cutting them into paragraphs (the costly part, on
  // this thread) goes note by note in the index's order and stops once the list
  // is full or the words changed, so a long list never parses notes it will not show.
  const texts = await Promise.all(ids.map(async (id) => src.current?.id === id ? src.current.text() : src.body(id)));
  const rows: BlockRefRow[] = [];
  for (const [i, id] of ids.entries()) {
    const note = src.note(id), text = texts[i];
    if (signal?.aborted || rows.length >= BLOCK_REF_ROWS) break;
    if (!note || text === null || text === undefined) continue;
    rows.push(...blockRefRows(filter, src.targets(id, text), note, "found"));
  }
  return rows.slice(0, BLOCK_REF_ROWS);
}