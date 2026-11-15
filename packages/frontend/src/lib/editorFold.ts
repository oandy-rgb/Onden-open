import { Annotation, type AnnotationType, EditorState, RangeSetBuilder, type Extension, type StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  codeFolding, ensureSyntaxTree, foldEffect, foldState, foldable, foldedRanges, syntaxTree, unfoldEffect,
} from "@codemirror/language";
import { t } from "./i18n";
import { frontmatterRange } from "./editorFrontmatter";
import { isCoarsePointer } from "./mediaQuery";

// 依標題收起：a heading's whole section (down to the next heading of the same
// or a higher level) folds into one 「…」 chip. Display only — the folded text
// stays in the document, so saving and merging never see a fold.
//
// The fold ranges come from @codemirror/lang-markdown (it reads the syntax
// tree, so a `#` inside a code block is not a heading). What this file adds:
//   • the arrow after the last word of each heading line (a ::after on the line,
//     hit-tested in mousedown, so no widget touches the text or an IME);
//   • folds open themselves when the caret goes in (CodeMirror), and on
//     `revealFolded` (search hits, jumps to a paragraph or heading);
//   • which folds a note had, as marks that survive edits elsewhere
//     (`foldMarks` / `applyFoldMarks`; the device-local store is editorFoldStore).
//
//   extensions: [..., headingFolding(saveMarks)]

/** A folded heading, named by its text and which of the same-text headings it is. */
export type FoldMark = { text: string; nth: number };

/** Transactions that restore folds are not the person folding: not saved. */
const restoring = Annotation.define<boolean>();

type HeadingLine = { from: number; to: number; text: string };

/** The note's ATX/setext heading lines (first line of each), in order; the
 *  frontmatter block, which lang-markdown reads as a setext heading, is not one. */
export function headingLines(state: EditorState, upto = state.doc.length): HeadingLine[] {
  const fm = frontmatterRange(state.doc);
  const found: HeadingLine[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: upto,
    enter: (node) => {
      if (!/^(?:ATXHeading|SetextHeading)[1-6]$/.test(node.name)) return;
      if (fm && node.from <= fm.to) return false;
      const line = state.doc.lineAt(node.from);
      found.push({ from: line.from, to: line.to, text: line.text.trim() });
      return false;
    },
  });
  return found;
}

function markOf(heading: HeadingLine, seen: Map<string, number>): FoldMark {
  const nth = seen.get(heading.text) ?? 0;
  seen.set(heading.text, nth + 1);
  return { text: heading.text, nth };
}

function foldedStarts(state: EditorState): Set<number> {
  const starts = new Set<number>();
  foldedRanges(state).between(0, state.doc.length, (from) => { starts.add(from); });
  return starts;
}

/** The headings that are folded now. */
export function foldMarks(state: EditorState): FoldMark[] {
  const starts = foldedStarts(state);
  if (!starts.size) return [];
  const seen = new Map<string, number>();
  const marks: FoldMark[] = [];
  for (const h of headingLines(state)) {
    const mark = markOf(h, seen);
    const range = starts.has(h.to) ? foldable(state, h.from, h.to) : null;
    if (range) marks.push(mark);
  }
  return marks;
}

function foldRangeEffects(state: EditorState, marks: readonly FoldMark[]): StateEffect<{ from: number; to: number }>[] {
  const wanted = new Set(marks.map((m) => `${m.nth}\u0000${m.text}`));
  const seen = new Map<string, number>();
  const effects: StateEffect<{ from: number; to: number }>[] = [];
  for (const h of headingLines(state)) {
    const mark = markOf(h, seen);
    if (!wanted.has(`${mark.nth}\u0000${mark.text}`)) continue;
    const range = foldable(state, h.from, h.to);
    if (range) effects.push(foldEffect.of(range));
  }
  return effects;
}

function unfoldEffects(state: EditorState): StateEffect<{ from: number; to: number }>[] {
  const effects: StateEffect<{ from: number; to: number }>[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => { effects.push(unfoldEffect.of({ from, to })); });
  return effects;
}

/** Make exactly these headings folded (a note opened, or another note's text
 *  put in the editor). A mark whose heading is gone or has no section is dropped. */
export function applyFoldMarks(view: EditorView, marks: readonly FoldMark[]): void {
  ensureSyntaxTree(view.state, view.state.doc.length, 100);
  const effects = [...unfoldEffects(view.state), ...foldRangeEffects(view.state, marks)];
  if (effects.length) view.dispatch({ effects, annotations: restoring.of(true) });
}

/** 「全部收起」: fold every heading that has a section. */
export function foldAllHeadings(view: EditorView): boolean {
  ensureSyntaxTree(view.state, view.state.doc.length, 100);
  const ranges: { from: number; to: number }[] = [];
  const done = foldedStarts(view.state);
  for (const h of headingLines(view.state)) {
    const range = done.has(h.to) ? null : foldable(view.state, h.from, h.to);
    if (range) ranges.push(range);
  }
  if (!ranges.length) return true;
  // A caret inside a new fold would unfold it again at once: bring it to the outermost heading's end.
  const head = view.state.selection.main.head;
  const hiding = ranges.filter((r) => head > r.from && head <= r.to);
  const anchor = hiding.length ? Math.min(...hiding.map((r) => r.from)) : null;
  view.dispatch({ effects: ranges.map((r) => foldEffect.of(r)), selection: anchor === null ? undefined : { anchor } });
  return true;
}

/** 「全部展開」. */
export function unfoldAllHeadings(view: EditorView): boolean {
  const effects = unfoldEffects(view.state);
  if (effects.length) view.dispatch({ effects });
  return true;
}

/** Unfold whatever hides `pos` (a search hit or a jump target), without moving the caret. */
export function revealFolded(view: EditorView, pos: number): void {
  const effects: StateEffect<{ from: number; to: number }>[] = [];
  foldedRanges(view.state).between(pos, pos, (from, to) => {
    if (from < pos && pos <= to) effects.push(unfoldEffect.of({ from, to }));
  });
  if (effects.length) view.dispatch({ effects });
}

/** The heading whose section holds `pos` (the nearest one above, with a section that reaches it), as its line. */
function headingAt(state: EditorState, pos: number): HeadingLine | null {
  let found: HeadingLine | null = null;
  for (const h of headingLines(state)) {
    if (h.from > pos) break;
    const range = foldable(state, h.from, h.to);
    if (pos <= h.to || (range && pos <= range.to)) found = h;
  }
  return found;
}

/** Fold (`folded` false) or unfold (true) the section of the heading the caret is on or under;
 *  headings only: no paragraphs, code or tables. False when there is nothing to change. */
function setHeadingFoldAtCaret(view: EditorView, folded: boolean): boolean {
  const h = headingAt(view.state, view.state.selection.main.head);
  if (!h || foldedStarts(view.state).has(h.to) !== folded) return false;
  toggleHeadingFold(view, h.from);
  return true;
}

/** Ctrl+Alt is how AltGr keyboards (German, Polish, Nordic…) type `[` and `]`, so no binding here may use
 *  Ctrl+Alt: CodeMirror's own foldKeymap does, and would fold the note instead of typing the bracket.
 *  Folding all headings is the command palette's 「全部收起標題」. */
export const headingFoldKeymap = [
  { key: "Ctrl-Shift-[", mac: "Cmd-Alt-[", run: (view: EditorView) => setHeadingFoldAtCaret(view, false) },
  { key: "Ctrl-Shift-]", mac: "Cmd-Alt-]", run: (view: EditorView) => setHeadingFoldAtCaret(view, true) },
];

/** Fold the heading on the line starting at `lineFrom`, or unfold it if it is folded. */
export function toggleHeadingFold(view: EditorView, lineFrom: number): void {
  const line = view.state.doc.lineAt(lineFrom);
  let open: { from: number; to: number } | null = null;
  foldedRanges(view.state).between(line.to, line.to, (from, to) => { if (from === line.to) open = { from, to }; });
  if (open) { view.dispatch({ effects: unfoldEffect.of(open) }); return; }
  const range = foldable(view.state, line.from, line.to);
  if (!range) return;
  const head = view.state.selection.main.head;
  // A caret inside the section would unfold it again at once: bring it to the heading.
  const selection = head > range.from && head <= range.to ? { anchor: range.from } : undefined;
  view.dispatch({ effects: foldEffect.of(range), selection });
}

// ── The arrow ───────────────────────────────────────────────────────────────

/** Whether a press at (x, y) is on the arrow drawn after the last word of the heading line `lineEl`
 *  (editorTools.css `.cm-fold-head::after`). A pseudo-element has no box of its own to hit, so
 *  this measures where the text ends. */
export function onFoldArrow(lineEl: HTMLElement, x: number, y: number): boolean {
  const range = document.createRange();
  range.selectNodeContents(lineEl);
  const rects = range.getClientRects();
  const end = rects.length ? rects[rects.length - 1] : null; // the last row of the line, after a folded chip too
  if (!end) return false;
  // The ::after is 0.35em + 1.6em of the arrow's own size (0.8em of the line's), or 44px on a touch screen.
  const fontSize = (parseFloat(getComputedStyle(lineEl).fontSize) || 16) * 0.8;
  const reach = fontSize * 0.35 + (isCoarsePointer() ? 44 : fontSize * 1.6);
  return x >= end.right && x <= end.right + reach && y >= end.top && y <= end.bottom;
}

function arrowDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const starts = foldedStarts(view.state);
  const fm = frontmatterRange(view.state.doc);
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (node) => {
        if (!/^(?:ATXHeading|SetextHeading)[1-6]$/.test(node.name)) return;
        if (fm && node.from <= fm.to) return false;
        const line = view.state.doc.lineAt(node.from);
        if (line.from <= last) return false;
        if (foldable(view.state, line.from, line.to)) {
          last = line.from;
          builder.add(line.from, line.from, Decoration.line({
            class: starts.has(line.to) ? "cm-fold-head cm-fold-closed" : "cm-fold-head cm-fold-open",
          }));
        }
        return false;
      },
    });
  }
  return builder.finish();
}

const arrows = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = arrowDecorations(view); }
  update(update: ViewUpdate) {
    if (update.view.composing) {
      // Rebuilding mid-composition could touch the line being typed; positions follow the edit meanwhile.
      this.decorations = this.decorations.map(update.changes);
      return;
    }
    if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)
      || update.startState.field(foldState, false) !== update.state.field(foldState, false)) {
      this.decorations = arrowDecorations(update.view);
    }
  }
}, {
  decorations: (plugin) => plugin.decorations,
  eventHandlers: {
    mousedown(event, view) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("cm-fold-head") || event.button !== 0) return false;
      if (!onFoldArrow(target, event.clientX, event.clientY)) return false;
      event.preventDefault();
      toggleHeadingFold(view, view.posAtDOM(target));
      return true;
    },
  },
});

/** The 「…」 chip where a section is folded: tap it to unfold. */
function placeholder(_view: EditorView, onclick: (event: Event) => void): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "cm-foldPlaceholder tap-target";
  chip.textContent = "…";
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-label", t("Show the folded section"));
  chip.addEventListener("click", onclick);
  return chip;
}

/** `save` gets the note's fold marks after the person folds or unfolds.
 *  Transactions carrying `ignore` (the host putting another text in) are not the person folding. */
export function headingFolding(save: (marks: FoldMark[]) => void, ignore: AnnotationType<unknown>): Extension {
  return [
    codeFolding({ placeholderDOM: placeholder }),
    arrows,
    keymap.of(headingFoldKeymap),
    // CodeMirror opens a fold only when the caret HEAD is strictly inside it; a
    // selection that ends exactly at the fold's end (a search hit on the
    // section's last word) or starts inside it would stay hidden.
    EditorState.transactionExtender.of((tr) => {
      if (!tr.selection || tr.docChanged) return null;
      const ends = tr.selection.ranges.flatMap((r) => [r.from, r.to]);
      const effects: StateEffect<{ from: number; to: number }>[] = [];
      foldedRanges(tr.startState).between(0, tr.startState.doc.length, (from, to) => {
        if (ends.some((pos) => from < pos && pos <= to)) effects.push(unfoldEffect.of({ from, to }));
      });
      return effects.length ? { effects } : null;
    }),
    EditorView.updateListener.of((update) => {
      if (update.transactions.some((tr) => tr.annotation(restoring) || tr.annotation(ignore))) return;
      const before = update.startState.field(foldState, false);
      const after = update.state.field(foldState, false);
      if (before === after) return;
      const touched = update.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));
      const count = (s: EditorState) => foldedStarts(s).size;
      if (touched || count(update.startState) !== count(update.state)) save(foldMarks(update.state));
    }),
  ];
}
