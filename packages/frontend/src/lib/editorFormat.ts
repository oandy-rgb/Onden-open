// Formatting edits on a CodeMirror view: the selection toolbar, the mobile
// formatting bar and keyboard commands all write Markdown through these.
// Each one dispatches a single change and leaves focus to the caller.

import type { Text } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";
import { checklistLine } from "@onden/markdown";

/** The inline marks the selection toolbars offer, in toolbar order. `label`
 *  is the button's (translated) name and the key in activeFormats. */
export const INLINE_WRAPS = [
  { label: "Bold", before: "**", after: "**" },
  { label: "Italic", before: "*", after: "*" },
  { label: "Strikethrough", before: "~~", after: "~~" },
  { label: "Underline", before: "<u>", after: "</u>" },
  { label: "Highlight", before: "<mark>", after: "</mark>" },
  { label: "Inline code", before: "`", after: "`" },
] as const;

/** The formatting keys every Markdown editor binds (MarkdownEditor and the
 *  board's CardNode), as CodeMirror key names → the INLINE_WRAPS mark they
 *  toggle. lib/shortcuts.ts RESERVED_CHORDS reserves the same chords. */
export const FORMAT_KEYS = [
  { key: "Mod-b", label: "Bold" },
  { key: "Mod-i", label: "Italic" },
  { key: "Mod-u", label: "Underline" },
] as const;

/** FORMAT_KEYS as CodeMirror bindings: each toggles its mark on the main
 *  selection through `apply` (toggleWrap plus whatever the editor does after
 *  a format edit — focus, closing its selection toolbar). */
export function formatKeyBindings(
  apply: (view: EditorView, from: number, to: number, before: string, after: string) => void,
): KeyBinding[] {
  return FORMAT_KEYS.map(({ key, label }) => {
    const mark = INLINE_WRAPS.find((w) => w.label === label)!;
    return { key, run: (view: EditorView) => {
      const { from, to } = view.state.selection.main;
      apply(view, from, to, mark.before, mark.after);
      return true;
    } };
  });
}

/** How [from, to) is wrapped in `before`/`after`: the selection includes the
 *  delimiters ("inside": "**bold**" selected), they sit just outside it
 *  ("outside": "bold" selected inside **bold**), or neither (null). A
 *  selection that merely starts and ends with the marks but holds a closing
 *  and then an opening mark ("**a** and **b**") is neither. */
/** Where `mark` stands in `text` as itself, not as part of a longer run of its
 *  character (`**` is not two italic `*`). */
function markAt(text: string, mark: string, from: number): number {
  for (let i = text.indexOf(mark, from); i !== -1; i = text.indexOf(mark, i + 1)) {
    if (text[i - 1] !== mark[0] && text[i + mark.length] !== mark[mark.length - 1]) return i;
  }
  return -1;
}

function wrapState(doc: Text, from: number, to: number, before: string, after: string): "inside" | "outside" | null {
  const sel = doc.sliceString(from, to);
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
    // "**a** and **b**" starts and ends with the marks but is two spans, not one.
    const inner = sel.slice(before.length, sel.length - after.length);
    const close = markAt(inner, after, 0);
    if (close === -1 || markAt(inner, before, close + after.length) === -1) return "inside";
  }
  const outerFrom = from - before.length;
  const outerTo = to + after.length;
  if (outerFrom >= 0 && outerTo <= doc.length
    && doc.sliceString(outerFrom, from) === before && doc.sliceString(to, outerTo) === after
    && starRunHolds(doc, from, to, before)) return "outside";
  return null;
}

/** Whether the `*` marks just outside [from, to) hold `mark` ("*" or "**") as itself: "**x**" has no italic in it, "***x***"
 *  has both. Other marks are not read out of a run of their own character. */
function starRunHolds(doc: Text, from: number, to: number, mark: string): boolean {
  if (mark !== "*" && mark !== "**") return true;
  let left = 0;
  while (from - left - 1 >= 0 && doc.sliceString(from - left - 1, from - left) === "*") left++;
  let right = 0;
  while (to + right < doc.length && doc.sliceString(to + right, to + right + 1) === "*") right++;
  const run = Math.min(left, right);
  return mark === "**" ? run >= 2 : run === 1 || run === 3;
}

/** Wrap [from, to) in `before`/`after`, or unwrap it when it is already
 *  wrapped (see wrapState). The wrapped text stays selected. */
export function toggleWrap(view: EditorView, from: number, to: number, before: string, after: string): void {
  const doc = view.state.doc;
  const sel = doc.sliceString(from, to);
  const state = wrapState(doc, from, to, before, after);
  if (state === "inside") {
    const inner = sel.slice(before.length, sel.length - after.length);
    view.dispatch({ changes: { from, to, insert: inner }, selection: { anchor: from, head: from + inner.length } });
    return;
  }
  if (state === "outside") {
    const outerFrom = from - before.length;
    view.dispatch({ changes: { from: outerFrom, to: to + after.length, insert: sel }, selection: { anchor: outerFrom, head: outerFrom + sel.length } });
    return;
  }
  view.dispatch({
    changes: { from, to, insert: before + sel + after },
    selection: { anchor: from + before.length, head: to + before.length },
  });
}

/** The formats a press would undo for the selection [from, to): the inline
 *  marks wrapping it (INLINE_WRAPS labels), "Heading 1".."Heading 3" for the
 *  line the selection ends on (where toggleHeading acts), and "Quote" when
 *  every selected line is quoted (toggleLinePrefix then strips the "> "). */
export function activeFormats(doc: Text, from: number, to: number, head: number): Set<string> {
  const on = new Set<string>();
  for (const w of INLINE_WRAPS) if (wrapState(doc, from, to, w.before, w.after)) on.add(w.label);
  // Bold's "**" also reads as italic's "*": italic counts on its own or as
  // part of "***", not as half of a bold mark.
  if (on.has("Bold") && !wrapState(doc, from, to, "***", "***")) on.delete("Italic");
  const line = doc.lineAt(head).text;
  const heading = /^(#{1,6})\s/.exec(line);
  if (heading && heading[1].length <= 3) on.add(`Heading ${heading[1].length}`);
  if (everyLineHas(doc, from, to, "> ")) on.add("Quote");
  return on;
}

/** Make the caret's line a heading of `level`, replacing any heading marks. */
export function setHeading(view: EditorView, level: number): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const old = /^#{1,6}\s/.exec(line.text)?.[0].length ?? 0;
  // Only the marks change, so a selection on the line stays where it was.
  view.dispatch({ changes: { from: line.from, to: line.from + old, insert: "#".repeat(level) + " " } });
}

/** Heading button press: the caret's line becomes a heading of `level`, or a
 *  plain paragraph when it already is one (the press undoes what
 *  activeFormats reports as "Heading N"). */
export function toggleHeading(view: EditorView, level: number): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const marks = /^(#{1,6})\s/.exec(line.text);
  if (marks && marks[1].length === level) {
    view.dispatch({ changes: { from: line.from, to: line.from + marks[0].length, insert: "" } });
    return;
  }
  setHeading(view, level);
}

/** The copy of `prefix` at the start of `text`, or null. A quote also matches
 *  ">" without the space; a numbered line matches any number ("2. "); a
 *  checklist matches a done task ("- [x] "); a task line does not count as a
 *  bullet ("- "), so pressing Bullet on a task adds a bullet instead of
 *  breaking it. */
function presentPrefix(text: string, prefix: string): string | null {
  if (prefix === "> ") return /^> ?/.exec(text)?.[0] ?? null;
  if (prefix === "1. ") return /^\d+\. /.exec(text)?.[0] ?? null;
  if (prefix === "- [ ] ") return checklistLine(text)?.prefix ?? null;
  if (prefix === "- " && checklistLine(text)) return null;
  return text.startsWith(prefix) ? prefix : null;
}

function everyLineHas(doc: Text, from: number, to: number, prefix: string): boolean {
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    if (presentPrefix(doc.line(n).text, prefix) === null) return false;
  }
  return true;
}

/** Block button press ("> ", "- ", "1. ", "- [ ] "): remove `prefix` from
 *  every selected line when they all have it, otherwise add it to each. */
export function toggleLinePrefix(view: EditorView, prefix: string): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  if (!everyLineHas(doc, from, to, prefix)) {
    prefixLines(view, prefix);
    return;
  }
  const changes: { from: number; to: number }[] = [];
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    const line = doc.line(n);
    changes.push({ from: line.from, to: line.from + presentPrefix(line.text, prefix)!.length });
  }
  view.dispatch({ changes });
}

/** Put `prefix` ("> ", "- ", "- [ ] ") in front of every selected line. */
export function prefixLines(view: EditorView, prefix: string): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const changes: { from: number; insert: string }[] = [];
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) changes.push({ from: doc.line(n).from, insert: prefix });
  view.dispatch({ changes });
}

/** Turn [from, to) into a Markdown link to `url`; the caret lands after it. */
export function insertLink(view: EditorView, from: number, to: number, url: string): void {
  const text = `[${view.state.doc.sliceString(from, to)}](${url})`;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
}

/** How many spaces Tab puts in front of a list line to make it a child of the item above: a bullet's content starts
 *  2 columns in, a number's at the width of "12. " (CommonMark reads less indent as a sibling). */
export function listIndentWidth(line: string): number {
  const numbered = /^\s*(\d+)[.)] /.exec(line);
  return numbered ? numbered[1].length + 2 : 2;
}
