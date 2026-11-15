// The note's edit ⇄ preview switch. The wide screen's 編輯｜並排｜預覽 icons (NOTE_MODES), the phone ⋯
// menu and the click-to-edit in the preview all take it from here, so the modes, the target
// and "which notes have a preview" live in one place.

export type NoteView = "edit" | "preview";

/** The view the switch leads to from `view`. */
export function otherView(view: NoteView): NoteView {
  return view === "edit" ? "preview" : "edit";
}

/** How a wide screen shows the note's text, one of three (HackMD's Edit｜Both｜View):
 *  the editor, the rendered page, or both — the editor left, the rendered page right. */
export type NoteMode = "edit" | "preview" | "split";

/** The three in the switch's order (編輯｜並排｜預覽), with their i18n keys. */
export const NOTE_MODES: readonly { mode: NoteMode; label: string }[] = [
  { mode: "edit", label: "Edit" },
  { mode: "split", label: "Side by side" },
  { mode: "preview", label: "Preview" },
];

/** The mode the note is in: the preview wins; side by side is editing with the split on. */
export function noteMode(view: NoteView, split: boolean): NoteMode {
  return view === "preview" ? "preview" : split ? "split" : "edit";
}

/** PDF and handwriting notes replace the Markdown editor and preview wholesale. */
export function previewAvailable(surface: { pdfUrl: string | null; inkActive: boolean }): boolean {
  return !surface.pdfUrl && !surface.inkActive;
}

/**
 * Where in the Markdown source a click in the rendered preview landed, as a
 * character offset, or null when it cannot be told. The browser gives the text
 * node and offset under the pointer; the source is searched for that text
 * (rendered text drops markup, so the match is the closest one, not exact).
 */
export function sourceOffsetFromPreviewText(source: string, text: string, offsetInText: number): number | null {
  const needle = text.trim();
  if (!needle) return null;
  const lead = text.length - text.trimStart().length;
  const within = Math.min(Math.max(offsetInText - lead, 0), needle.length);
  const at = source.indexOf(needle);
  if (at < 0) return null;
  return at + within;
}
