// The editor's side of 「這段的歷史」: while the sheet is open an older wording
// shows in the paragraph's place (pale yellow); the frame around the paragraph
// is lib/editorParagraphFrame's, the same as the other paragraph panels. Display only:
// the document is not touched until 「用這個版本」 writes through the editor's
// own save path. The range follows the document if a sync edits around it.

import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export type BlockPreview = { from: number; to: number; /** An older wording to show; null shows the current text. */ text: string | null };

export const setBlockPreview = StateEffect.define<BlockPreview | null>();

class OldWording extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: OldWording) { return other.text === this.text; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-block-history-old";
    el.textContent = this.text;
    return el;
  }
}

const field = StateField.define<{ preview: BlockPreview | null; deco: DecorationSet }>({
  create: () => ({ preview: null, deco: Decoration.none }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setBlockPreview)) continue;
      const preview = effect.value;
      if (!preview) return { preview: null, deco: Decoration.none };
      if (preview.text === null || preview.to <= preview.from) return { preview, deco: Decoration.none };
      const range: Range<Decoration> = Decoration.replace({ widget: new OldWording(preview.text) }).range(preview.from, preview.to);
      return { preview, deco: Decoration.set([range]) };
    }
    if (!tr.docChanged || !value.preview) return value;
    const from = tr.changes.mapPos(value.preview.from, -1);
    const to = tr.changes.mapPos(value.preview.to, 1);
    return { preview: { ...value.preview, from, to }, deco: value.deco.map(tr.changes) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Put into the editor's extensions. */
export const blockHistoryPreview = [field];

/** Where the previewed paragraph is now, or null when no preview is showing. */
export function blockPreviewRange(state: EditorState): { from: number; to: number } | null {
  const preview = state.field(field).preview;
  return preview && { from: preview.from, to: preview.to };
}
