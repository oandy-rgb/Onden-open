// Test fixtures written in the OLD form (a block's id as a trailing `^id`) turned into the new model: the text without
// the marks, and the anchors that stood for them (the same conversion the migration job makes, @onden/markdown
// stripLegacyIds). So a test can still say "paragraph `claim` has id c1" in one readable line.

import { stripLegacyIds } from "@onden/markdown";
import { replaceAllAnchors, type NoteAnchor } from "../../lib/blockAnchorStore";

export type Anchored = { markdown: string; anchors: Array<{ id: string; from: number; to: number }> };

/** `legacy("claim ^c1\n\nother")` → `{ markdown: "claim\n\nother", anchors: [{ id: "c1", from: 0, to: 5 }] }`. */
export function anchored(legacy: string): Anchored {
  const out = stripLegacyIds(legacy);
  if ("refused" in out) throw new Error(`cannot convert ${JSON.stringify(legacy)}: ${out.refused}`);
  return { markdown: out.markdown, anchors: out.anchors.map((a) => ({ id: a.id, from: a.from, to: a.to })) };
}

/** Put the anchors of `legacy` text into the store as the server's valid anchors of note `noteId`; returns the new text. */
export function holdAnchored(noteId: string, legacy: string): string {
  const { markdown, anchors } = anchored(legacy);
  const rows: NoteAnchor[] = anchors.map((a) => ({
    anchor_id: a.id, note_id: noteId, from: a.from, to: a.to, status: "valid", candidate_from: null, candidate_to: null,
    quote: markdown.slice(a.from, a.to),
  }));
  replaceAllAnchors(rows, [noteId]);
  return markdown;
}

/** A note fixture whose `markdown` is written in the old form: the note with the marks cut out, its anchors held in the store. */
export function holdLegacyNote<T extends { id: string; markdown?: string }>(n: T): T {
  if (!n.markdown || !n.markdown.includes("^")) return n;
  return { ...n, markdown: holdAnchored(n.id, n.markdown) };
}
