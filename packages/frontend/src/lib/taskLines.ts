// GFM task-list items in a note's markdown, found once for everyone: the
// rendered checkbox click (lib/taskCheckbox.ts — the Nth rendered box is the
// Nth item here) and the editor's checkbox → task (MarkdownEditor: the item on the caret's line).
//
// They are found with the renderer's own parser (@onden/markdown parseGfmTree:
// remark-parse + remark-gfm, as MarkdownRenderer runs it), so "is this a checkbox?" has one answer:
// code blocks of any kind (fenced, indented, inside quotes or lists, a fence
// left open until its container ends), an empty `- [ ]` or `- [x]foo` (no
// box), block quotes and nested lists, CRLF line endings — whatever the
// renderer draws as a box is an item here, and nothing else.

import { parseGfmTree } from "@onden/markdown";
import { visit } from "unist-util-visit";
import type { ListItem } from "mdast";

export type TaskLine = {
  /** 0-based line number in the markdown. */
  line: number;
  checked: boolean;
  /** Offset of the mark character inside `[ ]` / `[x]`. */
  markOffset: number;
  /** The item's first-line text after the box, trimmed. */
  text: string;
};

const BOX_RE = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[( |x|X)\]/;

// The editor asks on every render, so the last answer is kept: a parse runs only when the text changed.
let cached: { markdown: string; lines: TaskLine[] } | null = null;

/** Every task-list item that renders as a checkbox, in document order. */
export function taskLines(markdown: string): TaskLine[] {
  if (cached?.markdown === markdown) return cached.lines;
  const lines = parseTaskLines(markdown);
  cached = { markdown, lines };
  return lines;
}

function parseTaskLines(markdown: string): TaskLine[] {
  const tree = parseGfmTree(markdown);
  const out: TaskLine[] = [];
  visit(tree, "listItem", (item: ListItem) => {
    if (typeof item.checked !== "boolean" || !item.position) return;
    const start = item.position.start.offset ?? 0;
    const box = BOX_RE.exec(markdown.slice(start));
    if (!box) return;
    const markOffset = start + box[0].length - 2;
    const lineEnd = markdown.indexOf("\n", markOffset);
    const text = markdown.slice(markOffset + 2, lineEnd < 0 ? undefined : lineEnd).trim();
    out.push({ line: item.position.start.line - 1, checked: item.checked, markOffset, text });
  });
  return out;
}

/** The item whose box is on 0-based line `line`, if that line has one. */
export function taskAtLine(markdown: string, line: number): TaskLine | undefined {
  return taskLines(markdown).find((task) => task.line === line);
}

/** The markdown with the given item's box set to `checked`. */
export function setTaskLine(markdown: string, task: Pick<TaskLine, "markOffset">, checked: boolean): string {
  return markdown.slice(0, task.markOffset) + (checked ? "x" : " ") + markdown.slice(task.markOffset + 1);
}
