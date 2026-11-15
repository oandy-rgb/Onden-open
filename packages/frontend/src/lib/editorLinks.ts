import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Prec, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

// Link styling in the editor that matches what the preview will render.
//
// The markdown parser calls any `[text]` a Link (a CommonMark "shortcut
// reference"), but without a `[text]: url` definition the preview shows it as
// literal text, brackets included. Styling every parsed Link made `[note to
// self]` look clickable in the editor and then appear as plain brackets in the
// preview. So the highlight style leaves links alone and this plugin marks only
// what really renders as a link:
//   [text](url) and [text][ref]  → the text is a link (the url stays faded)
//   [[note]]                     → a wikilink: the title is a link, all four
//                                  brackets are marks
//   bare https://… URLs          → a link
//   [text] on its own            → ordinary text, brackets at full strength

export type LinkRange = { from: number; to: number; kind: "link" | "mark" | "literal" };

/** Ranges to decorate between `from` and `to`, in document order. Pure, so the
 *  rules above are testable without a view. */
export function linkRanges(state: EditorState, from = 0, to = state.doc.length): LinkRange[] {
  const out: LinkRange[] = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    from, to,
    enter: (node) => {
      if (node.name === "URL") {
        // A bare / autolinked URL is the link itself; a URL inside [text](…)
        // is its destination and keeps the faded url style.
        const parent = node.node.parent?.name;
        if (parent !== "Link" && parent !== "Image") out.push({ from: node.from, to: node.to, kind: "link" });
        return false;
      }
      if (node.name !== "Link") return;
      const children: { name: string; from: number; to: number }[] = [];
      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        children.push({ name: child.name, from: child.from, to: child.to });
      }
      const marks = children.filter((c) => c.name === "LinkMark");
      const textFrom = marks[0]?.to ?? node.from;
      const textTo = marks[1]?.from ?? node.to;
      const real = children.some((c) => c.name === "URL" || c.name === "LinkLabel");
      const before = node.from > 0 ? doc.sliceString(node.from - 1, node.from) : "";
      const after = doc.sliceString(node.to, node.to + 1);
      if (real) {
        if (textTo > textFrom) out.push({ from: textFrom, to: textTo, kind: "link" });
      } else if (before === "[" && after === "]") {
        out.push({ from: node.from - 1, to: node.from, kind: "mark" });
        if (textTo > textFrom) out.push({ from: textFrom, to: textTo, kind: "link" });
        out.push({ from: node.to, to: node.to + 1, kind: "mark" });
      } else {
        out.push({ from: node.from, to: node.to, kind: "literal" });
      }
      return false;
    },
  });
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

const DECO = {
  link: Decoration.mark({ class: "cm-md-link" }),
  mark: Decoration.mark({ class: "cm-md-mark" }),
  literal: Decoration.mark({ class: "cm-md-literal" }),
};

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (const r of linkRanges(view.state, from, to)) builder.add(r.from, r.to, DECO[r.kind]);
  }
  return builder.finish();
}

const plugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged
        || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = build(update.view);
    }
  }
}, { decorations: (v) => v.decorations });

const MARK = "color-mix(in srgb, var(--ac-muted) 55%, transparent)";

// High precedence: these marks wrap the syntax-highlight spans, so the rules
// can reach both the wrapper and anything highlighted inside it.
const theme = EditorView.theme({
  ".cm-md-link, .cm-md-link span": {
    color: "var(--ac-accent) !important",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in srgb, var(--ac-accent) 45%, transparent)",
    textUnderlineOffset: "3px",
  },
  ".cm-md-mark, .cm-md-mark span": { color: `${MARK} !important` },
  ".cm-md-literal, .cm-md-literal span": { color: "inherit !important", fontWeight: "inherit", fontSize: "inherit" },
});

export const editorLinks: Extension = [Prec.high(plugin), theme];
