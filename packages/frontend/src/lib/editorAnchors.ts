// A paragraph's identity as the editor holds it. The text carries no id (段落錨點批 3): an anchor is a row on the server
// (lib/blockAnchorStore) with the place the server last measured. The editor keeps those places in its own state so that
// they move with every keystroke (the same mapPos the server's change log uses) and so that what needs a place in
// the text the person sees — the 「被引用」 numbers, the delete warning, the frame around a paragraph — reads it from here.
//
//   - `setEditorAnchors` replaces them: when a note opens and whenever the server's anchors change (MarkdownEditor);
//     only anchors whose words are where the server said are put in (blockAnchorStore.anchorSpansOf), so a place
//     measured on an older text never names the wrong paragraph;
//   - an anchor whose paragraph is deleted collapses to nothing and leaves the list;
//   - a paragraph cut in two (Enter) keeps its anchor on one half: the one with the `{…}`, else the first (業主 2026-11-08, the
//     rule is @onden/markdown splitAnchorSpan, which the server applies to the same edit);
//   - cut and paste inside one note carries the anchors of the cut paragraphs to where they are pasted (§5.2 of
//     docs/architecture/proposals/block-anchors-2026-11-01.md). A copy does not: the pasted paragraph is a new paragraph
//     and the server gives it its own anchor when it needs one. Another note never receives them.

import { EditorState, StateEffect, StateField, type Extension, type Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { splitAnchorSpan } from "@onden/markdown";
import type { AnchorSpan } from "./blockAnchorStore";

export const setEditorAnchors = StateEffect.define<readonly AnchorSpan[]>();

/** Anchors a paste put at a new place, in the document AFTER that transaction. */
const anchorsCarried = StateEffect.define<readonly AnchorSpan[]>();

/** `moved` (the anchor mapped over `tr`), narrowed to the half of a paragraph that `tr` cut in two which keeps its identity. */
function narrowedAfterCut(tr: Transaction, was: AnchorSpan, moved: AnchorSpan): AnchorSpan {
  if (!tr.changes.touchesRange(was.from, was.to) || moved.to <= moved.from) return moved;
  const cut = splitAnchorSpan(tr.startState.sliceDoc(was.from, was.to), tr.newDoc.sliceString(moved.from, moved.to));
  return cut ? { id: moved.id, from: moved.from + cut.from, to: moved.from + cut.to } : moved;
}

export const editorAnchorsField = StateField.define<readonly AnchorSpan[]>({
  create: () => [],
  update(anchors, tr) {
    let next = anchors;
    if (tr.docChanged && next.length > 0) {
      // from stays before text typed at the start, to moves after text typed at the end: the span grows with typing
      // in the paragraph and is empty only once all its text is gone.
      next = next
        .map((a) => narrowedAfterCut(tr, a, { id: a.id, from: tr.changes.mapPos(a.from, -1), to: tr.changes.mapPos(a.to, 1) }))
        .filter((a) => a.from < a.to);
    }
    for (const effect of tr.effects) {
      if (effect.is(setEditorAnchors)) next = effect.value;
      else if (effect.is(anchorsCarried)) {
        const ids = new Set(effect.value.map((a) => a.id));
        next = [...next.filter((a) => !ids.has(a.id)), ...effect.value];
      }
    }
    return next;
  },
});

/** The anchors the editor knows, at the places they are now. */
export const editorAnchorsOf = (state: EditorState): readonly AnchorSpan[] => state.field(editorAnchorsField, false) ?? [];

/** The anchor that starts the block at `start` (a paragraph, list item or heading), or null. A leading indent is not part of
 *  the block's start, so a start that differs only by blank space counts. */
export function anchorStartingAt(state: EditorState, start: number): AnchorSpan | null {
  for (const a of editorAnchorsOf(state)) {
    let at = a.from;
    while (at < state.doc.length && /[ \t]/.test(state.doc.sliceString(at, at + 1))) at++;
    if (at === start) return a;
  }
  return null;
}

// ── cut and paste ─────────────────────────────────────────────────────────────

/** What the last cut or copy of this tab put on the clipboard: its text, and for a cut the anchors that lay wholly
 *  inside it as offsets into that text. Kept in memory only (like lib/copiedPartLink): a paste elsewhere, or after a
 *  restart, finds nothing to carry and pastes plain text. */
type Taken = { text: string; noteId: string | undefined; carries: readonly { id: string; from: number; to: number }[] };
let latest: Taken | null = null;

/** Forget the last cut/copy (tests, and a note switch that must not carry across). */
export function forgetClipboardAnchors(): void { latest = null; }

function onCopyOrCut(event: ClipboardEvent, view: EditorView, noteId: string | undefined): void {
  const sel = view.state.selection;
  // CodeMirror copies a whole line for an empty selection and joins several ranges: neither is a paragraph we can follow.
  if (sel.ranges.length !== 1 || sel.main.empty) { latest = null; return; }
  const { from, to } = sel.main;
  const carries = event.type === "cut"
    ? editorAnchorsOf(view.state).filter((a) => a.from >= from && a.to <= to).map((a) => ({ id: a.id, from: a.from - from, to: a.to - from }))
    : [];
  latest = { text: view.state.sliceDoc(from, to), noteId, carries };
}

/** The pasted insertion of `tr` (one insertion, nothing else changed besides what it replaces), or null. */
function pasteOf(tr: Transaction): { at: number; text: string } | null {
  if (!tr.isUserEvent("input.paste")) return null;
  let found: { at: number; text: string } | null = null;
  let count = 0;
  tr.changes.iterChanges((_fa, _ta, fromB, _tb, inserted) => { count++; found = { at: fromB, text: inserted.toString() }; });
  return count === 1 ? found : null;
}

/** The anchors a paste of this transaction brings to its new place, or [] when it is not the paste of what this tab cut
 *  from this note. */
function carriedBy(tr: Transaction, noteId: string | undefined): readonly AnchorSpan[] {
  const taken = latest;
  const paste = pasteOf(tr);
  if (!taken || !paste || taken.carries.length === 0 || taken.noteId === undefined || taken.noteId !== noteId) return [];
  if (paste.text !== taken.text) return [];
  // A second paste of the same text is a copy of a paragraph that already has its anchor.
  const here = new Set(editorAnchorsOf(tr.startState).map((a) => a.id));
  if (taken.carries.some((c) => here.has(c.id))) return [];
  return taken.carries.map((c) => ({ id: c.id, from: paste.at + c.from, to: paste.at + c.to }));
}

/** The anchors every transaction of `update` carried (cut and paste), in the document after the update: what the change log
 *  hands the server with the save (lib/editorChangeLog). */
export function carriedInUpdate(update: ViewUpdate): AnchorSpan[] {
  let acc: AnchorSpan[] = [];
  for (const tr of update.transactions) {
    acc = acc
      .map((a) => ({ id: a.id, from: tr.changes.mapPos(a.from, -1), to: tr.changes.mapPos(a.to, 1) }))
      .filter((a) => a.from < a.to);
    for (const e of tr.effects) if (e.is(anchorsCarried)) acc.push(...e.value);
  }
  return acc;
}

/** The editor's anchor state plus the cut-and-paste carrying. `noteId` is read when asked: the editor moves from note to note. */
export function editorAnchors(noteId: () => string | undefined): Extension {
  return [
    editorAnchorsField,
    EditorView.domEventObservers({
      copy: (event, view) => onCopyOrCut(event, view, noteId()),
      cut: (event, view) => onCopyOrCut(event, view, noteId()),
    }),
    EditorState.transactionExtender.of((tr) => {
      const carried = carriedBy(tr, noteId());
      return carried.length > 0 ? { effects: anchorsCarried.of(carried) } : null;
    }),
  ];
}
