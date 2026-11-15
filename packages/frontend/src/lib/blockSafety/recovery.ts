// 「這段已刪除 · 救回」: a link or embed names a paragraph (by its anchor id) that
// its note no longer holds and no other note holds either. The anchor still says what the
// paragraph began with (`quote`), so the paragraph is looked up in the note's own history: the newest saved
// version that has those words, whole paragraph and all. It is put back beside the
// paragraph that used to precede it, as an ordinary edit of the note
// (noteWriter.patch: queued offline, a version in its history, and the toast's
// 「復原」 takes it back). No version holds it: the link just says it was deleted.
// The text carries no id, so the server gives the put-back paragraph its anchor (and finds the old one again by its words).
//
// Read from this one note's own history — never a scan of other notes.

import { blockTagSlot } from "@onden/markdown";
import { nodeNeedsBody } from "../api";
import { addToast, getNode } from "../appStore";
import { anchorSpansOf, anchorsOf, type AnchorSpan } from "../blockAnchorStore";
import { dataSync, noteWriter, reads } from "../data";
import { t } from "../i18n";

export type DeletedBlock = {
  /** The paragraph as it was written. */
  text: string;
  /** The anchor id of the nearest paragraph before it that the note still has; null = put it at the end. */
  after: string | null;
};

/** The newest of `versions` (newest first) that holds the words `quote`, as a block to put back into `current`; null when
 *  none does, `quote` is empty, or `current` already has that paragraph. `after`: the anchor of the paragraph it followed. Pure. */
export function deletedBlockFrom(versions: ReadonlyArray<{ markdown: string }>, quote: string, current: string, after: string | null = null): DeletedBlock | null {
  const words = quote.trim();
  if (!words || current.includes(words)) return null;
  for (const version of versions) {
    const at = version.markdown.indexOf(words);
    if (at === -1) continue;
    const slot = blockTagSlot(version.markdown, at);
    const text = slot ? version.markdown.slice(slot.start, slot.end) : words;
    return { text: text.trim() ? text : words, after };
  }
  return null;
}

/** `current` with the paragraph back in it: after the paragraph it followed (`anchors`: the note's, read against `current`), else at the end. */
export function withBlockRestored(current: string, block: DeletedBlock, anchors: readonly AnchorSpan[] = []): string {
  if (current.includes(block.text)) return current;
  const after = block.after ? anchors.find((a) => a.id === block.after) : undefined;
  if (after) return `${current.slice(0, after.to)}\n\n${block.text}${current.slice(after.to)}`;
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
    const here = anchorSpansOf(noteId, current);
    // The nearest paragraph before it that is still in the note.
    const before = here.filter((a) => a.to <= gone.from).sort((x, y) => y.to - x.to)[0];
    return deletedBlockFrom(await reads.notes.rawVersions(noteId), gone.quote, current, before?.id ?? null);
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
