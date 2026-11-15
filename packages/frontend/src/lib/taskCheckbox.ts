// GFM task-list helpers. The rendered checkbox (MarkdownRenderer's `input`
// component) is interactive: clicking it must flip the SOURCE markdown line
// from `[ ]` to `[x]` (or back) and save through the existing body-update path.
//
// We address checkboxes by their 0-based DOCUMENT ORDER index rather than by
// AST source position. react-markdown renders task checkboxes in document
// order, and `toggleTaskLine` scans the source for task lines in the same
// order, so the Nth rendered checkbox maps to the Nth task line — robust
// against upstream string transforms that don't add/remove task lines
// (frontmatter stripping, inline-wikilink substitution).

import { setTaskLine, taskAtLine, taskLines } from "./taskLines";

/**
 * Flip the checkbox state of the `index`-th (0-based, document order) task
 * item in `markdown` (lib/taskLines.ts: the same items the renderer shows as
 * checkboxes — code blocks skipped, block quotes included). Returns the new
 * markdown, or the original unchanged if `index` is out of range. Preserves
 * the indentation, quote and list marker and trailing text; only the single
 * char inside the brackets changes.
 */
export function toggleTaskLine(markdown: string, index: number): string {
  const task = index < 0 ? undefined : taskLines(markdown)[index];
  return task ? setTaskLine(markdown, task, !task.checked) : markdown;
}

/**
 * The one-character edit that flips the box on 0-based line `line` (the editor's
 * drawn checkbox): where the mark is and what replaces it, or null when that
 * line has no box. The same change `toggleTaskLine` makes, as an edit so undo
 * and the caret see one character change. A task line (`… {task}`) is flipped
 * the same way: the server reads done-ness from this box (blockNodes).
 */
export function taskToggleEdit(markdown: string, line: number): { from: number; to: number; insert: string } | null {
  const task = taskAtLine(markdown, line);
  return task ? { from: task.markOffset, to: task.markOffset + 1, insert: task.checked ? " " : "x" } : null;
}
