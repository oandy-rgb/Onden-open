// 「這段已刪除 · 救回」: a link or embed names a paragraph (by its anchor id) that
// its note no longer holds and no other note holds either. The anchor still says what the
// paragraph began with (`quote`), so the paragraph is looked up in the note's own history: the newest saved
// version that has those words, whole paragraph and all. It is put back beside the
// paragraph that used to precede it, as an ordinary edit of the note
// (noteWriter.patch: queued offline, a version in its history, and the toast's
// 「復原」 takes it back). No version holds it: the link just says it was deleted.
// Where it goes is read from that history version, not from the lost anchor's position (a lost anchor has none: backend mapping.ts NO_POSITION):
// walking back from the deleted paragraph, the first paragraph the note still has (found by its words) — it goes after that one;
// none before it: walking forward, the first one the note still has — it goes before that one; neither: the end.
// The text carries no id, so the server gives the put-back paragraph its anchor (and finds the old one again by its words).
//
// Read from this one note's own history — never a scan of other notes.

import { blockTagSlot, stripLineMarker } from "@onden/markdown";
import { withoutLineTrailers } from "@onden/markdown/block-id";
import { nodeNeedsBody } from "../api";
import { addToast, getNode } from "../appStore";
import { anchorSpansOf, anchorsOf, type AnchorSpan } from "../blockAnchorStore";
import { dataSync, noteWriter, reads } from "../data";
import { t } from "../i18n";

export type DeletedBlock = {
  /** The paragraph as it was written. */
  text: string;
  /** The anchor id of the nearest paragraph before it that the note still has: it goes after that one. */
  after: string | null;
  /** Only when no paragraph before it is left: the anchor id of the nearest one after it that the note still has; it goes before that one. Both null = the end. */
  before: string | null;
};

/** A paragraph's words as they are compared: line ends as `\n`, without the `{tags}` and ` ^id` that end a line and without the quote marks, heading
 *  hashes or list bullets that start one (an anchor's block may or may not include them, and the history version may differ in the tags). */
function wordsOf(text: string): string {
  return withoutLineTrailers(text.replace(/\r\n?/g, "\n")).split("\n").map(stripLineMarker).join("\n").trim();
}

/** `text`'s paragraphs (blank-line separated) with where each starts, in order. */
function paragraphsWithStart(text: string): Array<{ words: string; from: number }> {
  const out: Array<{ words: string; from: number }> = [];
  let at = 0;
  for (const chunk of text.split(/(\r?\n[ \t]*\r?\n)/)) {
    const words = /^\r?\n[ \t]*\r?\n$/.test(chunk) ? "" : wordsOf(chunk);
    if (words) out.push({ words, from: at });
    at += chunk.length;
  }
  return out;
}

/** The anchor, among `anchors` (read against `current`), whose words are `paragraph` or end it (`end`: the last item of a list) / start it (the first item).
 *  The longest wins; of equal ones (the same words written twice) the one standing in the same order among its twins as `paragraph` does in the history version
 *  (`twin`: how many paragraphs with the same words come before it there). */
function anchorReading(paragraph: string, twin: number, current: string, anchors: readonly AnchorSpan[], end: boolean): string | null {
  const reading = anchors.flatMap((a) => { const words = wordsOf(current.slice(a.from, a.to)); return words && (end ? paragraph.endsWith(words) : paragraph.startsWith(words)) ? [{ id: a.id, from: a.from, words }] : []; });
  const longest = Math.max(0, ...reading.map((r) => r.words.length));
  const tied = reading.filter((r) => r.words.length === longest).sort((x, y) => x.from - y.from);
  return tied.length === 0 ? null : tied[Math.min(twin, tied.length - 1)]!.id;
}

/** Where a paragraph that stood at [start, end) of `version` goes in `current`: after the nearest paragraph before it that the note still has,
 *  else before the nearest one after it that the note still has (each found by its words among `anchors`, read against `current`); both null = the end. */
function neighboursOf(version: string, start: number, end: number, current: string, anchors: readonly AnchorSpan[]): { after: string | null; before: string | null } {
  const all = paragraphsWithStart(version);
  const twinOf = (index: number) => all.slice(0, index).filter((p) => p.words === all[index]!.words).length;
  const firstAfter = all.findIndex((p) => p.from >= end);
  const insideRest = all.findIndex((p) => p.from >= start);
  const before = (insideRest < 0 ? all.length : insideRest) - 1;
  for (let i = before; i >= 0; i--) {
    const id = anchorReading(all[i]!.words, twinOf(i), current, anchors, true);
    if (id) return { after: id, before: null };
  }
  for (let i = firstAfter < 0 ? all.length : firstAfter; i < all.length; i++) {
    const id = anchorReading(all[i]!.words, twinOf(i), current, anchors, false);
    if (id) return { after: null, before: id };
  }
  return { after: null, before: null };
}

/** The newest of `versions` (newest first) that holds the words `quote`, as a block to put back into `current`; null when
 *  none does, `quote` is empty, or `current` already has that paragraph. `anchors`: the note's paragraphs, read against `current`,
 *  for finding the paragraph it followed. Pure. */
export function deletedBlockFrom(versions: ReadonlyArray<{ markdown: string }>, quote: string, current: string, anchors: readonly AnchorSpan[] = []): DeletedBlock | null {
  const words = quote.trim();
  if (!words || current.includes(words)) return null;
  for (const version of versions) {
    const at = version.markdown.indexOf(words);
    if (at === -1) continue;
    const slot = blockTagSlot(version.markdown, at);
    const text = slot ? version.markdown.slice(slot.start, slot.end) : words;
    return { text: text.trim() ? text : words, ...neighboursOf(version.markdown, slot ? slot.start : at, slot ? slot.end : at + words.length, current, anchors) };
  }
  return null;
}

/** `current` with the paragraph back in it: after the paragraph it followed, else before the one that came after it (`anchors`: the note's, read against `current`), else at the end. */
export function withBlockRestored(current: string, block: DeletedBlock, anchors: readonly AnchorSpan[] = []): string {
  if (current.includes(block.text)) return current;
  const after = block.after ? anchors.find((a) => a.id === block.after) : undefined;
  if (after) return `${current.slice(0, after.to)}\n\n${block.text}${current.slice(after.to)}`;
  const before = block.before ? anchors.find((a) => a.id === block.before) : undefined;
  if (before) return `${current.slice(0, before.from)}${block.text}\n\n${current.slice(before.from)}`;
  return `${current.replace(/\s+$/, "")}${current.trim() ? "\n\n" : ""}${block.text}\n`;
}

/** The note's text to write from: the whole body, fetched when the list holds only a summary. */
async function currentMarkdown(noteId: string): Promise<string | null> {
  const find = () => getNode(noteId);
  if (nodeNeedsBody(find())) await dataSync.hydrateNode(noteId);
  const node = find();
  return node && !node.deleted_at && !nodeNeedsBody(node) ? node.markdown : null;
}

/** Whether the note's history can give `blockId` back (so 「救回」 is worth showing). `current`
 *  is the note's text as the caller reads it. Offline or on any failure: null, "just deleted". */
export async function findDeletedBlock(noteId: string, blockId: string, current: string): Promise<DeletedBlock | null> {
  try {
    const held = anchorsOf(noteId);
    const gone = held.find((a) => a.anchor_id === blockId);
    if (!gone || gone.status === "valid" || !gone.quote) return null;
    return deletedBlockFrom(await reads.notes.rawVersions(noteId), gone.quote, current, anchorSpansOf(noteId, current));
  } catch { return null; }
}

/** Put `block` back into the note; says so, with 「復原」. False when it could not be written
 *  (the writer has already said why when the write was refused). */
export async function restoreDeletedBlock(noteId: string, block: DeletedBlock): Promise<boolean> {
  try {
    const before = await currentMarkdown(noteId);
    if (before === null) { addToast(t("Couldn't restore the paragraph"), "error"); return false; }
    const next = withBlockRestored(before, block, anchorSpansOf(noteId, before));
    if (next === before) { addToast(t("The paragraph was already put back"), "info"); return true; }
    await noteWriter.patch(noteId, { markdown: next }, { baseMarkdown: before });
    addToast(t("Restored the paragraph"), "success", {
      label: t("Undo"),
      onClick: () => {
        // Only while nothing else was written to the note since.
        const now = getNode(noteId)?.markdown;
        if (now !== next) { addToast(t("The note was edited since, so use the editor's undo"), "info"); return; }
        void noteWriter.patch(noteId, { markdown: before }, { baseMarkdown: next });
      },
    });
    return true;
  } catch {
    return false; // noteWriter has already reported a refused or failed write
  }
}

/** After a click on an old `[[Note#^id]]` opened `note` and the paragraph is gone: say so, with 「救回」
 *  when its history has it and `canEdit`. Quiet when the reader cannot tell more than "deleted". */
export async function offerDeletedBlock(note: { id: string }, blockId: string, current: string, canEdit: boolean): Promise<void> {
  const block = canEdit ? await findDeletedBlock(note.id, blockId, current) : null;
  addToast(t("This paragraph was deleted"), "info", block ? {
    label: t("Restore"),
    onClick: () => { void restoreDeletedBlock(note.id, block); },
  } : undefined);
}
