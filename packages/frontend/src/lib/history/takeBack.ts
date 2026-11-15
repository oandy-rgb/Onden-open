// "Take back just this paragraph": put one paragraph of an earlier version into
// the note as it is now, leaving every other edit alone.

import { alignParagraphs, splitParagraphs, type Paragraph } from "@onden/markdown";

export type TakeBackPlan =
  | { kind: "same"; text: string }
  /** The paragraph exists now with other text: `markdown` swaps only that one. */
  | { kind: "replace"; text: string; now: string; markdown: string }
  /** The paragraph is gone now: `markdown` puts it back at its relative place. */
  | { kind: "insert"; text: string; markdown: string }
  /** The version has no such paragraph. */
  | { kind: "missing" };

/** Plan taking paragraph `index` of `versionMarkdown` (as `splitParagraphs`
 *  numbers it) into `currentMarkdown`. Planned against whatever the note is at
 *  call time, so the same call is safe to repeat inside the save's edit step. */
export function planTakeBack(currentMarkdown: string, versionMarkdown: string, index: number): TakeBackPlan {
  const versionParagraphs = splitParagraphs(versionMarkdown);
  const wanted = versionParagraphs[index];
  if (!wanted) return { kind: "missing" };
  const alignment = alignParagraphs(splitParagraphs(currentMarkdown), versionParagraphs);
  const at = alignment.findIndex((row) => row.new === wanted);
  const row = alignment[at];
  if (row.kind === "same") return { kind: "same", text: wanted.text };
  if (row.kind === "changed") {
    const { old } = row;
    return {
      kind: "replace", text: wanted.text, now: old.text,
      markdown: currentMarkdown.slice(0, old.start) + wanted.text + currentMarkdown.slice(old.end),
    };
  }
  // Insert after the nearest earlier paragraph that still exists now, else before the first one.
  let anchorEnd: number | null = null;
  for (let k = at - 1; k >= 0; k--) {
    const before = alignment[k].old;
    if (before) { anchorEnd = before.end; break; }
  }
  const separator = (other: Paragraph) => other.kind === "listItem" && wanted.kind === "listItem" ? "\n" : "\n\n";
  if (anchorEnd !== null) {
    const previous = splitParagraphs(currentMarkdown).find((p) => p.end === anchorEnd)!;
    return { kind: "insert", text: wanted.text, markdown: currentMarkdown.slice(0, anchorEnd) + separator(previous) + wanted.text + currentMarkdown.slice(anchorEnd) };
  }
  const first = splitParagraphs(currentMarkdown)[0];
  if (!first) return { kind: "insert", text: wanted.text, markdown: wanted.text + (currentMarkdown.trim() ? "\n\n" + currentMarkdown : "\n") };
  return { kind: "insert", text: wanted.text, markdown: currentMarkdown.slice(0, first.start) + wanted.text + separator(first) + currentMarkdown.slice(first.start) };
}
