import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { KATEX_OPTIONS } from "@onden/markdown";

// Live preview of `$…$` and `$$…$$` in the editor (grammar: editorMathSyntax).
// Like the other live-preview pieces (editorEmbeds, editorLinks), the text is
// never changed: while the caret or a selection is away from a formula it is
// drawn as KaTeX, and the moment the caret touches it — including the edges,
// so typing the closing `$` keeps the source in view — the source is back.
//
//   - KaTeX loads on first use (as for the preview, @onden/markdown/lazy);
//     until it arrives the widget shows the source, then renders in place;
//   - a formula KaTeX rejects keeps its source, in the error style, and the
//     message as its tooltip; rendering never throws into the editor;
//   - a tap or click on a drawn formula puts the caret inside it, so a phone
//     can edit it with one tap;
//   - what is drawn is only what the published page draws as math
//     (remark-math, the same KATEX_OPTIONS); empty formulas and formulas
//     inside list items / quotes (where the lines carry a prefix) stay text.

export type MathRange = {
  from: number;
  to: number;
  display: boolean;
  /** The TeX KaTeX gets: delimiters (and a block's fences) removed. */
  source: string;
};

/** The TeX of an inline formula's text: delimiters removed and, like
 *  micromark, one space on each side dropped when both are there. */
export function inlineMathSource(text: string, openLength: number): string {
  const body = text.slice(openLength, text.length - openLength);
  const pad = (c: string) => c === " " || c === "\n";
  return body.length > 2 && pad(body[0]) && pad(body[body.length - 1]) && body.trim() !== ""
    ? body.slice(1, -1) : body;
}

/** Formulas to draw as KaTeX: every math node the caret / selection does not
 *  touch. Pure over the state (tests read it). */
export function mathRanges(state: EditorState): MathRange[] {
  const doc = state.doc;
  const out: MathRange[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "InlineMath" && node.name !== "BlockMath") return;
      const block = node.name === "BlockMath";
      const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
      // A block replaces whole lines; one that carries a container prefix
      // (`> `, `- `) cannot, so it stays source.
      if (block && doc.sliceString(first.from, node.from).trim() !== "") return false;
      const from = block ? first.from : node.from;
      const to = block ? last.to : node.to;
      for (const r of state.selection.ranges) {
        if (r.from <= to && r.to >= from) return false;
      }
      let source: string;
      if (block) {
        const marks = node.node.getChildren("BlockMathMark");
        const bodyFrom = first.to + 1;
        const bodyTo = marks.length > 1 ? marks[marks.length - 1].from : node.to;
        source = bodyTo > bodyFrom ? doc.sliceString(bodyFrom, bodyTo) : "";
        if (marks.length > 1) source = source.replace(/\s+$/, "");
      } else {
        const open = node.node.firstChild?.to ? node.node.firstChild.to - node.from : 1;
        source = inlineMathSource(doc.sliceString(node.from, node.to), open);
      }
      if (source.trim() !== "") out.push({ from, to, display: block, source });
      return false;
    },
  });
  return out;
}

type Katex = typeof import("katex").default;
let katex: Katex | null = null;
let katexLoading: Promise<Katex | null> | null = null;

/** KaTeX, loaded once. Resolves null when the chunk cannot load (offline
 *  before first use): formulas then simply stay source. */
function loadKatex(): Promise<Katex | null> {
  katexLoading ??= import("katex")
    .then((m) => (katex = m.default))
    .catch((error) => {
      console.warn("Editor: could not load KaTeX", error);
      katexLoading = null;
      return null;
    });
  return katexLoading;
}

function paint(el: HTMLElement, range: Pick<MathRange, "display" | "source">, k: Katex): void {
  try {
    el.innerHTML = k.renderToString(range.source, { ...KATEX_OPTIONS, displayMode: range.display, throwOnError: true, output: "html" });
    el.classList.remove("cm-math-pending", "cm-math-error");
    el.removeAttribute("title");
  } catch (error) {
    el.textContent = range.display ? `$$\n${range.source}\n$$` : `$${range.source}$`;
    el.classList.remove("cm-math-pending");
    el.classList.add("cm-math-error");
    el.title = error instanceof Error ? error.message.replace(/^KaTeX parse error: /, "") : "";
  }
}

class MathWidget extends WidgetType {
  constructor(readonly range: Pick<MathRange, "display" | "source">, readonly open: number) { super(); }
  eq(other: MathWidget) { return other.range.source === this.range.source && other.range.display === this.range.display; }
  get estimatedHeight() { return this.range.display ? 48 : -1; }
  toDOM(view: EditorView) {
    const el: HTMLElement = document.createElement(this.range.display ? "div" : "span");
    el.className = `cm-math ${this.range.display ? "cm-math-block" : "cm-math-inline"} cm-math-pending`;
    el.setAttribute("role", "math");
    el.setAttribute("aria-label", this.range.source);
    el.textContent = this.range.display ? this.range.source : `$${this.range.source}$`;
    if (katex) paint(el, this.range, katex);
    else void loadKatex().then((k) => { if (k) paint(el, this.range, k); });
    // A tap / click goes into the formula: first line below the fence for a
    // block, just inside the opening `$` for an inline one.
    el.addEventListener("mousedown", (event: MouseEvent) => {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const start = view.posAtDOM(el);
      const doc = view.state.doc;
      const caret = this.range.display
        ? Math.min(doc.lineAt(start).to + 1, doc.length)
        : start + this.open;
      view.dispatch({ selection: { anchor: caret }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }
  // The widget's own mousedown handler places the caret; nothing else from it
  // should reach the editor's selection logic.
  ignoreEvent() { return true; }
}

function build(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = mathRanges(state).map((r) => {
    const open = r.display ? 0 : openingLength(state, r.from);
    return Decoration.replace({ widget: new MathWidget(r, open), block: r.display }).range(r.from, r.to);
  });
  return Decoration.set(ranges, true);
}

function openingLength(state: EditorState, from: number): number {
  let n = 0;
  while (state.doc.sliceString(from + n, from + n + 1) === "$") n++;
  return Math.max(n, 1);
}

const theme = EditorView.baseTheme({
  ".cm-math": { cursor: "text" },
  ".cm-math-block": { display: "block", textAlign: "center", padding: "6px 0", overflowX: "auto", overflowY: "hidden" },
  ".cm-math-pending": { fontFamily: "monospace", fontSize: "0.9em", opacity: "0.7", whiteSpace: "pre-wrap" },
  ".cm-math-error": {
    fontFamily: "monospace", fontSize: "0.9em", whiteSpace: "pre-wrap",
    color: "var(--ac-danger)",
    textDecoration: "underline wavy", textDecorationThickness: "1px", textUnderlineOffset: "3px",
    opacity: "0.85",
  },
});

/** Math live preview for the note editor. */
export const editorMath: Extension = [
  StateField.define<DecorationSet>({
    create: build,
    update(deco, tr) {
      if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state);
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  }),
  theme,
];
