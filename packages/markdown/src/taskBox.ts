// The checkbox a `{task}` line needs (docs/agents/decisions-ui.md 「永遠是成品：勾選框」): the server reads a
// task's done/open from the box, so a line that gets the task tag gets a box in the same edit. One rule for the
// editor (tag applied, typed `}`) and the server (a task ticked or timed in Tasks whose line has none yet).
//
//   text {task}        → - [ ] text {task}
//   - text / 1. text   → - [ ] text / 1. [ ] text   (indent and quote prefix stay)
//   heading, table, code, a line that already has a box, a paragraph of several lines
//   (its tag line is the last, a list item's the first: the tag would stop counting) → no edit.

import { blockTagSlot } from "./blocks.js";

const MARKER = /^(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const hasBox = (text: string): boolean => ["[ ]", "[x]", "[X]"].some((box) => text.startsWith(box));

/** The insertion that gives the block holding `offset` an unchecked box, or null when it takes none
 *  or has one. Apply as `markdown.slice(0, at) + insert + markdown.slice(at)`. */
export function taskBoxEdit(markdown: string, offset: number): { at: number; insert: string } | null {
  const slot = blockTagSlot(markdown, offset);
  if (!slot) return null;
  const lineStart = markdown.lastIndexOf("\n", slot.start - 1) + 1;
  const rest = markdown.slice(slot.start);
  if (slot.kind === "listItem") {
    const marker = MARKER.exec(rest);
    if (!marker) return null;
    const after = rest.slice(marker[0].length);
    return hasBox(after) ? null : { at: slot.start + marker[0].length, insert: "[ ] " };
  }
  if (slot.kind !== "paragraph") return null;
  if (lineStart !== slot.start || markdown.slice(slot.start, slot.end).trimEnd().includes("\n")) return null;
  return { at: slot.start, insert: "- [ ] " };
}

