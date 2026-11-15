// Pasting a part link written by 「複製段落連結」 (lib/editorParagraphActions copyBlockLink) into a note of Onden: the link goes
// in as the text it is, and the server is asked to anchor the paragraph and bind the pasted link to it
// (blockLinkWriter.bind), so the link follows the paragraph by identity from then on. Until then, and when the server
// cannot (offline, the paragraph changed), the link reads by its words — nothing is lost or changed.

import type { EditorView } from "@codemirror/view";
import { blockLinkWriter } from "../data";
import { copiedPartLinkOf } from "../copiedPartLink";

export type PasteContext = {
  /** The note this editor holds. */
  noteId: string | undefined;
  /** The editor still holds that note (it may have moved on by the time the server answers). */
  stillOn: (noteId: string) => EditorView | null;
};

/** Handle a paste of a link just copied from a paragraph: put it in over the selection and bind it. True when this was
 *  such a paste (the editor must not paste again); false for any other text. */
export function pasteBlockLink(view: EditorView, pasted: string, ctx: PasteContext): boolean {
  const copied = copiedPartLinkOf(pasted);
  if (!copied || !ctx.noteId) return false;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: copied.link }, selection: { anchor: from + copied.link.length }, userEvent: "input.paste" });
  const noteId = ctx.noteId;
  void blockLinkWriter.bind(noteId, copied.noteId, { at: copied.at, seenText: copied.seenText, suggestedText: copied.text }).then((bound) => {
    const written = bound && `[[${bound.link}]]`;
    if (!written || written === copied.link) return;
    // Another paragraph of this note already used those words: the text follows what the server settled on.
    const v = ctx.stillOn(noteId);
    const at = v?.state.doc.toString().indexOf(copied.link) ?? -1;
    if (v && at !== -1) v.dispatch({ changes: { from: at, to: at + copied.link.length, insert: written } });
  });
  return true;
}
