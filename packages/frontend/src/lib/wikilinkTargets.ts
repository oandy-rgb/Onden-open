// `[[Note#` and `[[Note#^` in the editor: after a note is named, the popup
// lists what inside it a link can point at — its headings and its paragraphs
// and list items (@onden/markdown listLinkTargets). This file is the pure
// part: reading the typed query, filtering the targets into popup rows and
// writing the chosen link (editorCompletion.ts applies a row: a heading as
// `[[Note#Heading]]`, a paragraph as the part link `[[Note/its words]]`, which the
// server then anchors — no id is ever written). Reading a note's text is
// hooks/useLinkTargets.ts.
//
//   [[Note#Heading]]       a heading (its text, as the renderer matches it)
//   [[Note#^…]]            what is typed to list paragraphs and list items instead of headings
//   [[#^…]], [[#Heading]]  the same note: the note part left out

import { normalizeText, type LinkTarget } from "@onden/markdown";
import { matchTitle } from "./noteSearch";

/** The most rows the popup lists for one note. */
export const LINK_TARGET_ROWS = 40;

/** What was typed after `[[`, once it names a note: the note, whether only
 *  blocks (`#^`) are wanted, and the text that filters the list. */
export type LinkTargetQuery<N> = { note: N; blocksOnly: boolean; filter: string; noteTyped: boolean };

/** Read `Note#…` / `Note#^…` / `#…` typed after `[[`. `resolve` finds the note
 *  a name titles (an empty name is the note being edited); null when the text
 *  before no `#` names a note — then the popup is the plain note list (a title
 *  that has a `#` in it still works). An alias (`|`) or a closed link is not
 *  this popup's. */
export function parseTargetQuery<N>(query: string, resolve: (name: string) => N | null): LinkTargetQuery<N> | null {
  if (query.includes("|") || query.includes("]")) return null;
  for (let hash = query.indexOf("#"); hash !== -1; hash = query.indexOf("#", hash + 1)) {
    const name = query.slice(0, hash);
    const note = resolve(name);
    if (note === null) continue;
    const rest = query.slice(hash + 1);
    const blocksOnly = rest.startsWith("^");
    return { note, blocksOnly, filter: blocksOnly ? rest.slice(1) : rest, noteTyped: name.trim() !== "" };
  }
  return null;
}

/** The note whose title is `name` (accents and case as the renderer compares
 *  link targets: NFC, case-insensitive); the first one when titles repeat.
 *  An empty name is `current`. */
export function resolveNoteByTitle<N extends { id: string; title: string }>(name: string, nodes: readonly N[], current: N | undefined): N | null {
  const wanted = normalizeText(name.trim()).toLowerCase();
  if (!wanted) return current ?? null;
  return nodes.find((n) => normalizeText(n.title.trim()).toLowerCase() === wanted) ?? null;
}

/** One popup row: a target of a note, with what applying it needs to know. */
export type LinkTargetRow = {
  __target: true;
  noteId: string;
  noteTitle: string;
  /** The note being edited: its text is the editor's. */
  sameNote: boolean;
  /** The link leaves the title out (`[[#^…]]`), as typed. */
  short: boolean;
  /** This person may edit the note. */
  writable: boolean;
  target: LinkTarget;
  /** Highlighted ranges in the row's label. */
  ranges: [number, number][];
};

/** A heading `[[Note#Heading]]` can name: its text has no character the link
 *  syntax would read differently (`#` starts a deeper heading, `|` an alias). */
function headingLinkable(text: string): boolean {
  return text !== "" && !/[#|[\]^]/.test(text);
}

/** The rows for `query` over a note's `targets`, in document order: headings
 *  and blocks, or only blocks after `#^`. A filter matches a contiguous piece
 *  of a heading or a block's text. */
export function targetRows(
  query: Pick<LinkTargetQuery<unknown>, "blocksOnly" | "filter" | "noteTyped">,
  targets: readonly LinkTarget[],
  note: { id: string; title: string; sameNote: boolean; writable: boolean },
): LinkTargetRow[] {
  const rows: LinkTargetRow[] = [];
  // A title with a `#` cannot lead a heading link (the link reads the first `#`).
  const headings = !query.blocksOnly && !note.title.includes("#");
  for (const target of targets) {
    if (target.kind === "heading" && !(headings && headingLinkable(target.text))) continue;
    const text = target.text;
    const label = target.kind === "heading" ? target.text : target.label;
    let ranges: [number, number][] = [];
    if (query.filter.trim()) {
      const inLabel = matchTitle(query.filter, label);
      const inText = matchTitle(query.filter, text);
      if (!inLabel?.contiguous && !inText?.contiguous) continue;
      if (inLabel?.contiguous) ranges = inLabel.ranges;
    }
    rows.push({
      __target: true, noteId: note.id, noteTitle: note.title, sameNote: note.sameNote,
      short: note.sameNote && !query.noteTyped, writable: note.writable, target, ranges,
    });
    if (rows.length >= LINK_TARGET_ROWS) break;
  }
  return rows;
}
