import { type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { parseCalloutMarker, type CalloutType } from "@onden/markdown";
import { composingSafeDecorations } from "./editorComposing";
import "../styles/calloutColors.css";

// `> [!note]` callouts in the editor: the lines of the block quote get the
// callout's side bar and tint, in the colour the reading view gives that type
// (styles/calloutColors.css, the type from @onden/markdown parseCalloutMarker).
// Only line styling is added — no text is replaced or hidden, so the title line
// (`> [!tip]- Title`) stays as written and the caret going in and out moves
// nothing. While an IME is composing the styling is held back
// (lib/editorComposing) and catches up when it ends.

export type CalloutLines = { from: number; to: number; type: CalloutType; first: boolean; last: boolean };

/** The lines of every callout in `from`..`to`, one entry per line. Pure over the state (tests read it). */
export function calloutLines(state: EditorView["state"], from: number, to: number): CalloutLines[] {
  const doc = state.doc;
  const out: CalloutLines[] = [];
  syntaxTree(state).iterate({
    from, to,
    enter: (node) => {
      if (node.name !== "Blockquote") return;
      const mark = node.node.getChild("QuoteMark");
      const head = doc.lineAt(node.from);
      if (!mark || mark.from < head.from || mark.to > head.to) return;
      const callout = parseCalloutMarker(doc.sliceString(mark.to, head.to).trimStart());
      if (!callout) return;
      const lastLine = doc.lineAt(node.to > node.from && doc.lineAt(node.to).from === node.to ? node.to - 1 : node.to);
      for (let n = head.number; n <= lastLine.number; n++) {
        const line = doc.line(n);
        out.push({ from: line.from, to: line.to, type: callout.type, first: n === head.number, last: n === lastLine.number });
      }
    },
  });
  return out;
}

function build(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const seen = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    for (const l of calloutLines(view.state, from, to)) {
      if (seen.has(l.from)) continue;
      seen.add(l.from);
      const cls = ["cm-callout", `callout-${l.type}`, l.first ? "cm-callout-first" : "", l.last ? "cm-callout-last" : ""].filter(Boolean).join(" ");
      ranges.push(Decoration.line({ class: cls }).range(l.from));
    }
  }
  return Decoration.set(ranges, true);
}

const theme = EditorView.baseTheme({
  ".cm-line.cm-callout": {
    // --callout comes from the type class (styles/calloutColors.css).
    background: "color-mix(in srgb, var(--callout) 8%, transparent)",
    boxShadow: "inset 3px 0 0 var(--callout)",
    paddingLeft: "10px",
  },
  ".cm-line.cm-callout-first": { borderTopRightRadius: "6px", fontWeight: "600" },
  ".cm-line.cm-callout-last": { borderBottomRightRadius: "6px" },
});

/** The callout styling for the note editor. */
export const editorCallouts: Extension = [composingSafeDecorations(build), theme];
