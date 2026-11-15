import { type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { composingSafeDecorations } from "./editorComposing";
import { taskToggleEdit } from "./taskCheckbox";
import { t } from "./i18n";

// `- [ ]` / `- [x]` in the editor: the three characters of the box are drawn as
// a real checkbox, always — also while the caret is on the line (a box that
// turned back into `[ ]` under the caret would be the jump this editor avoids).
// The text is never changed and the line keeps its length: the box stands for
// exactly `[ ]`, so the arrow keys step over it and Backspace / Delete remove it
// as the three characters they are.
//
// A press flips the box through lib/taskCheckbox (the one place that flips a
// box; the preview uses it too): a one-character edit, undoable, saved like a
// typed one. A task line (`- [ ] buy milk {task}`) is the same edit — the
// server derives the task's done-state from the box. Where the note is
// read-only a box is shown and does nothing.
//
// Only what the preview draws as a box is drawn here: a box with nothing after
// it (`- [ ]`) is text, and a box in a code block is never one (the syntax
// tree has no TaskMarker there). While an IME is composing nothing is added,
// removed or replaced (lib/editorComposing); the boxes catch up when it ends.

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(other: CheckboxWidget) { return other.checked === this.checked; }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-task-box";
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    el.setAttribute("aria-label", this.checked ? t("Done") : t("Not done"));
    el.dataset.checked = String(this.checked);
    // The editor must not take a press on the box as a caret move or focus change.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => { e.preventDefault(); toggleBox(view, el); });
    return el;
  }
  ignoreEvent() { return true; }
}

function toggleBox(view: EditorView, el: HTMLElement): void {
  if (view.state.readOnly || view.composing) return;
  let pos: number;
  try { pos = view.posAtDOM(el); } catch { return; }
  const edit = taskToggleEdit(view.state.doc.toString(), view.state.doc.lineAt(pos).number - 1);
  if (edit) view.dispatch({ changes: edit, userEvent: "task.toggle" });
}

/** The boxes to draw in `from`..`to`: the `[ ]` / `[x]` of each task item that has text after it. Pure over the view (tests read it). */
export function checkboxRanges(view: Pick<EditorView, "state">, from: number, to: number): Array<{ from: number; to: number; checked: boolean }> {
  const out: Array<{ from: number; to: number; checked: boolean }> = [];
  const doc = view.state.doc;
  syntaxTree(view.state).iterate({
    from, to,
    enter: (node) => {
      if (node.name !== "TaskMarker") return;
      if (node.to - node.from !== 3) return;
      const line = doc.lineAt(node.from);
      if (doc.sliceString(node.to, line.to).trim() === "") return;
      out.push({ from: node.from, to: node.to, checked: /x/i.test(doc.sliceString(node.from, node.to)) });
    },
  });
  return out;
}

function build(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (const r of checkboxRanges(view, from, to)) {
      ranges.push(Decoration.replace({ widget: new CheckboxWidget(r.checked) }).range(r.from, r.to));
    }
  }
  return Decoration.set(ranges, true);
}

const theme = EditorView.baseTheme({
  // Three characters wide, like the `[ ]` it stands for.
  ".cm-task-box": {
    display: "inline-block", width: "3ch", textAlign: "center", verticalAlign: "baseline",
    cursor: "pointer", WebkitTapHighlightColor: "transparent",
  },
  ".cm-task-box::before": {
    content: '""', display: "inline-block", boxSizing: "border-box", width: "1.05em", height: "1.05em",
    border: "1.5px solid var(--ac-muted)", borderRadius: "3px", verticalAlign: "-0.15em",
    background: "transparent", textAlign: "center", lineHeight: "1", fontSize: "0.9em", color: "var(--ac-accent-ink)",
  },
  ".cm-task-box[data-checked='true']::before": {
    content: '"✓"', background: "var(--ac-accent)", borderColor: "var(--ac-accent)",
  },
});

/** The drawn checkbox for the note editor. */
export const editorCheckboxes: Extension = [
  composingSafeDecorations(build, (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none)),
  theme,
];
