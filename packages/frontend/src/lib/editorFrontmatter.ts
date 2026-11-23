import { EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { frontmatterEndLine, readFrontmatter } from "@onden/markdown";
import { t } from "./i18n";

// A note's YAML frontmatter (`---` … `---` from line 1) in the editor.
//
// Why: lang-markdown reads the closing `---` as a setext underline, so the
// YAML lines drew as a big H2 heading above the note's real text, and the
// values are already shown in the note's property strip. Collapsed, the block
// is ONE small muted button ("⚙ 設定：說明 · 結果"); pressing it (click,
// Enter, Space) or moving the caret into the block shows the raw YAML to edit.
// Expanded lines get `cm-frontmatter-line`, which cancels heading styling.
// Only a block that starts at line 1 counts: a `---` rule later in the note
// is left alone. Storage and parsing stay with @onden/markdown (frontmatter.ts).
//
//   extensions: [..., editorFrontmatter]

const MAX_SHOWN_KEYS = 4;

/** The frontmatter block's [from, to): from 0 to the end of the closing fence
 *  line (its newline excluded), or null when line 1 doesn't open one. */
export function frontmatterRange(doc: EditorState["doc"]): { from: number; to: number } | null {
  const end = frontmatterEndLine(doc.lines, (n) => doc.line(n).text);
  return end === null ? null : { from: 0, to: doc.line(end).to };
}

const expand = StateEffect.define<null>();

interface FrontmatterState { range: { from: number; to: number } | null; expanded: boolean; decorations: DecorationSet }

const USER_MOVES = ["select", "input", "delete", "undo", "redo", "move"];

/** The settings a skill note keeps in its frontmatter, named for a person. A key
 *  not listed here is the writer's own and is not echoed on the button (it is
 *  YAML; the raw text is one press away). */
function keyLabel(key: string): string | null {
  switch (key) {
    case "description": return t("what it does");
    case "output": return t("result");
    default: return null;
  }
}

function summary(text: string): string {
  const names = (readFrontmatter(text)?.entries ?? []).flatMap((e) => {
    const name = e.key ? keyLabel(e.key) : null;
    return name ? [name] : [];
  });
  if (!names.length) return t("Settings");
  const shown = names.slice(0, MAX_SHOWN_KEYS).join(" · ");
  return t("Settings: {keys}", { keys: names.length > MAX_SHOWN_KEYS ? `${shown} …` : shown });
}

class FrontmatterChip extends WidgetType {
  constructor(private readonly label: string, private readonly yamlFrom: number) { super(); }
  eq(other: FrontmatterChip) { return other.label === this.label && other.yamlFrom === this.yamlFrom; }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-frontmatter-chip tap-target";
    button.textContent = `⚙ ${this.label}`;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", `${this.label}. ${t("Show the raw settings to edit")}`);
    button.addEventListener("click", () => {
      view.dispatch({ effects: expand.of(null), selection: { anchor: this.yamlFrom } });
      view.focus();
    });
    return button;
  }
  // The button handles its own click and keys; the editor leaves them alone.
  ignoreEvent() { return true; }
}

function build(state: EditorState, range: { from: number; to: number } | null, expanded: boolean): DecorationSet {
  if (!range) return Decoration.none;
  if (expanded) {
    const lines: Range<Decoration>[] = [];
    for (let n = 1; n <= state.doc.lineAt(range.to).number; n++) {
      lines.push(Decoration.line({ class: "cm-frontmatter-line" }).range(state.doc.line(n).from));
    }
    return Decoration.set(lines);
  }
  const yamlFrom = state.doc.lines > 1 ? state.doc.line(2).from : range.to;
  const label = summary(state.doc.sliceString(range.from, range.to));
  return Decoration.set([Decoration.replace({ widget: new FrontmatterChip(label, yamlFrom) }).range(range.from, range.to)]);
}

const frontmatterField = StateField.define<FrontmatterState>({
  create(state) {
    const range = frontmatterRange(state.doc);
    return { range, expanded: false, decorations: build(state, range, false) };
  },
  update(value, tr) {
    const range = tr.docChanged ? frontmatterRange(tr.state.doc) : value.range;
    if (!range) return value.range ? { range, expanded: false, decorations: Decoration.none } : value;
    // Expanded while the caret is in the block, but only once the person put it
    // there (click, arrows, typing) or pressed the chip: a fresh note starts
    // with the caret at 0 and must open collapsed.
    const inside = tr.state.selection.ranges.some((r) => r.from <= range.to && r.to >= range.from);
    const asked = tr.effects.some((e) => e.is(expand))
      || ((tr.selection !== undefined || tr.docChanged) && USER_MOVES.some((e) => tr.isUserEvent(e)));
    const expanded = inside && (value.expanded || asked);
    if (!tr.docChanged && expanded === value.expanded && range === value.range) return value;
    return { range, expanded, decorations: build(tr.state, range, expanded) };
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

// A collapsed block is one button, so typing never lands on its `---` lines:
// text typed on line 1 or on the closing fence (a tap on
// the chip puts the caret there, on a phone too) would read `--- text`, no
// fence any more, and the whole block would turn into a heading. It goes on
// a line after the block instead.
//
// Only the person's own typing is moved. A change from elsewhere (synced from
// another device, AI, undo/redo) is no typing: it appends a YAML key as a pure
// insert at the closing fence's line start, which must stay where it is, and
// the filter must not rebuild the spec (that would drop its annotations,
// `ExternalSync` and `addToHistory(false)`, and echo the text back as an edit).
const keepFencesWhole = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent("input")) return tr;
  const field = tr.startState.field(frontmatterField, false);
  if (!field?.range || field.expanded) return tr;
  const { to } = field.range;
  const fences = [tr.startState.doc.line(1), tr.startState.doc.lineAt(to)];
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let caret: number | null = null;
  let moved = false;
  tr.changes.iterChanges((a, b, _c, _d, inserted) => {
    const text = inserted.toString();
    if (a === b && text !== "" && !text.startsWith("\n") && fences.some((line) => a >= line.from && a <= line.to)) {
      moved = true;
      changes.push({ from: to, to, insert: `\n${text}` });
      caret = to + 1 + text.length;
    } else changes.push({ from: a, to: b, insert: text });
  });
  if (!moved) return tr;
  return { changes, selection: caret === null || changes.length > 1 ? undefined : { anchor: caret }, effects: tr.effects, userEvent: "input", scrollIntoView: tr.scrollIntoView };
});

// The block is YAML, not a heading: cancel what the markdown highlighter gives
// the "setext heading" it misreads (size, weight, colour, heading line height).
const frontmatterTheme = EditorView.baseTheme({
  ".cm-frontmatter-chip": {
    font: "inherit", fontSize: "0.75em", lineHeight: "1.6", color: "var(--ac-muted)", opacity: "0.8",
    background: "transparent", border: "none", padding: "0 2px", cursor: "pointer", borderRadius: "4px",
  },
  ".cm-frontmatter-chip:hover, .cm-frontmatter-chip:focus-visible": { opacity: "1", textDecoration: "underline" },
  ".cm-frontmatter-line": { fontSize: "0.85em", lineHeight: "1.6", color: "var(--ac-muted)" },
  ".cm-frontmatter-line span": {
    fontSize: "1em !important", fontWeight: "400 !important", lineHeight: "inherit !important", color: "inherit !important",
    textDecoration: "none !important",
  },
});

/** Add to the editor's extensions. */
export const editorFrontmatter: Extension = [frontmatterField, keepFencesWhole, frontmatterTheme];
