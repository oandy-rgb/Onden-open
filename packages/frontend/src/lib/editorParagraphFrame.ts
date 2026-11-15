// A frame around the paragraph a panel or a one-press action works on, so the
// person can see WHICH paragraph. It is a decoration, never part of the note:
// the effects below carry no text change, so the editor's undo skips them and
// the saved note is untouched. The frame follows edits (positions map through
// them), so `frameRange` is also where an action reads the paragraph back.
//
//   framed   a panel (加標籤, 交給 AI, 這段的歷史) is open: stays until cleared;
//   flashed  a one-press action (複製段落連結, 變成子筆記) ran: fades by itself.

import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { blockTagSlot, blockTagSlotsIn } from "@onden/markdown";

export type ParagraphRange = { from: number; to: number };
type Frame = ParagraphRange & { mode: "open" | "flash" };

const setFrame = StateEffect.define<Frame | null>();

const FRAME_LINE = Decoration.line({ class: "cm-paragraph-frame" });
const FLASH_LINE = Decoration.line({ class: "cm-paragraph-frame cm-paragraph-frame--flash" });

const frameField = StateField.define<{ frame: Frame | null; lines: DecorationSet }>({
  create: () => ({ frame: null, lines: Decoration.none }),
  update(value, tr) {
    let { frame } = value;
    if (tr.docChanged && frame) {
      const from = tr.changes.mapPos(frame.from, 1);
      const to = Math.max(from, tr.changes.mapPos(frame.to, -1));
      frame = { ...frame, from, to };
    }
    for (const effect of tr.effects) if (effect.is(setFrame)) frame = effect.value;
    if (frame === value.frame) return value;
    if (!frame) return { frame: null, lines: Decoration.none };
    const deco = frame.mode === "flash" ? FLASH_LINE : FRAME_LINE;
    const first = tr.state.doc.lineAt(Math.min(frame.from, tr.state.doc.length)).number;
    const last = tr.state.doc.lineAt(Math.min(frame.to, tr.state.doc.length)).number;
    const ranges: Range<Decoration>[] = [];
    for (let n = first; n <= last; n++) ranges.push(deco.range(tr.state.doc.line(n).from));
    return { frame, lines: Decoration.set(ranges) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.lines),
});

const frameTheme = EditorView.baseTheme({
  ".cm-paragraph-frame": {
    background: "var(--ac-accent-soft)",
    boxShadow: "inset 2px 0 0 var(--ac-accent), inset -1px 0 0 var(--ac-accent)",
  },
  ".cm-paragraph-frame--flash": { animation: "cm-paragraph-flash 1s ease-out forwards" },
  "@keyframes cm-paragraph-flash": { from: { opacity: "1" }, "70%": { opacity: "1" }, to: { opacity: "0.15" } },
  "@media (prefers-reduced-motion: reduce)": { ".cm-paragraph-frame--flash": { animation: "none" } },
});

export const paragraphFrame: Extension = [frameField, frameTheme];

/** The whole paragraphs the text `[from, to]` touches (one paragraph for a caret), or null where there is none. */
export function paragraphRangeAt(view: EditorView, from: number, to = from): ParagraphRange | null {
  const doc = view.state.doc.toString();
  const slots = from === to ? [blockTagSlot(doc, from)].filter((slot) => slot !== null) : blockTagSlotsIn(doc, from, to);
  if (slots.length === 0) return null;
  return { from: Math.min(...slots.map((slot) => slot.start)), to: Math.max(...slots.map((slot) => slot.end)) };
}

/** Frame `range` until `clearParagraphFrame`. */
export function frameParagraph(view: EditorView, range: ParagraphRange): void {
  view.dispatch({ effects: setFrame.of({ ...range, mode: "open" }) });
}

export function clearParagraphFrame(view: EditorView): void {
  if (view.state.field(frameField, false)?.frame) view.dispatch({ effects: setFrame.of(null) });
}

/** The framed paragraph(s), where edits have moved them to; null when nothing is framed. */
export function frameRange(view: EditorView): ParagraphRange | null {
  const frame = view.state.field(frameField, false)?.frame;
  return frame ? { from: frame.from, to: frame.to } : null;
}

/** How long a one-press action's frame stays. */
export const FLASH_MS = 1000;

/** Frame `range` for about a second. A newer frame (a panel opening) replaces it; the timer then leaves that alone. */
export function flashParagraph(view: EditorView, range: ParagraphRange): void {
  const flash: Frame = { ...range, mode: "flash" };
  view.dispatch({ effects: setFrame.of(flash) });
  setTimeout(() => {
    const now = view.state.field(frameField, false)?.frame;
    if (now?.mode === "flash") view.dispatch({ effects: setFrame.of(null) });
  }, FLASH_MS);
}
