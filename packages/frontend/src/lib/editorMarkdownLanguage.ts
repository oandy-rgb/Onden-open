// The editor's Markdown language and highlight style, in one place so the note editor and the
// two-version compare view (components/compare) draw the same text the same way.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { mathMarkdown, mathTag } from "./editorMathSyntax";
import { cjkEmphasis } from "./editorCjkEmphasis";

/** Markdown with the note's own syntax extensions (formulas, CJK emphasis). */
export const editorMarkdownLanguage = () => markdown({ base: markdownLanguage, extensions: [mathMarkdown, cjkEmphasis] });

// ── Syntax highlight ──────────────────────────────────────────────────────────

// Styled source (iA Writer / Bear style): the text takes its formatting as
// you type — headings at the preview's sizes, bold bold, links linked — while
// the Markdown marks (#, **, [ ](), >, -, `) stay in place, faded. Nothing is
// hidden or revealed as the caret moves, so lines never change length under
// you (Obsidian Live Preview's jumping) and IME composition is untouched.
// Heading sizes mirror .obsidian-preview h1–h3 (OverviewEditor.css).
const MARK = "color-mix(in srgb, var(--ac-muted) 55%, transparent)";
export const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.65em", fontWeight: "700", lineHeight: "1.4", color: "var(--ac-ink)" },
  { tag: t.heading2, fontSize: "1.3em",  fontWeight: "700", lineHeight: "1.4", color: "var(--ac-ink)" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "700", color: "var(--ac-ink)" },
  { tag: t.heading4, fontWeight: "700", color: "var(--ac-ink)" },
  { tag: t.strong,   fontWeight: "700", color: "var(--ac-ink)" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--ac-ink-2)" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--ac-muted)" },
  // Links are styled by lib/editorLinks (only what the preview renders as a
  // link — a lone [text] stays plain text); the URL behind a link steps back.
  { tag: t.url, color: MARK, fontSize: "0.92em" },
  // The chip's side room is a box-shadow, not padding: padding is paid once per span, and a span is cut in
  // pieces whenever a decoration lands inside it (the 「same word」 marks of a selection, find hits), which
  // widened the text by 6px a piece and re-wrapped lines the person was only selecting.
  { tag: t.monospace, fontFamily: "monospace", fontSize: "0.85em",
    color: "var(--ac-accent)",
    background: "color-mix(in srgb, var(--ac-accent) 8%, transparent)",
    borderRadius: "3px", padding: "1px 0",
    boxShadow: "-3px 0 0 0 color-mix(in srgb, var(--ac-accent) 8%, transparent), 3px 0 0 0 color-mix(in srgb, var(--ac-accent) 8%, transparent)" },
  // A formula's source (shown while the caret is in it, or before KaTeX loads).
  { tag: mathTag, color: "var(--ac-accent)" },
  { tag: t.quote, color: "var(--ac-ink-2)" },
  // List items are ordinary text; only their bullet / number is a mark.
  { tag: t.list, color: "inherit" },
  // The marks themselves: #, **, _, `, [ ] ( ), >, -, 1. — faded, not hidden.
  { tag: t.processingInstruction, color: MARK, fontWeight: "400", fontStyle: "normal" },
  { tag: t.meta, color: MARK },
  { tag: t.contentSeparator, color: MARK },
  { tag: t.labelName, color: "var(--ac-accent)" },
]);

