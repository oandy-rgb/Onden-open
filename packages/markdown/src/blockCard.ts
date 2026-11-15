// A review card made from a block node (docs/architecture/block-nodes.md,
// B3): `{複習}` on a block makes that block a card. Its two sides come from
// the block's own text, never a copy, so editing the note edits the card.
//
//   - a list item with nested items: the item's line asks, the nested
//     lines answer (RemNote / Logseq style);
//       - 二分搜尋的時間複雜度？ {複習}
//         - O(log n)
//   - ==cloze==: the marked words are hidden on the front, shown in bold on
//     the back;
//       二分搜尋的時間複雜度是 ==O(log n)== {複習}
//   - a heading: the heading asks, its section answers;
//   - anything else: the first line asks, the rest answers (maybe nothing).
//
// The `{…}` marker never shows on either side.

import { parseBlocks, type AnchorAt } from "./blocks.js";
import { stripLineMarker } from "./plainText.js";
import { blockText, blocksOf } from "./linkContext.js";
import { ellipsize } from "./graphemes.js";

export type BlockCardSides = { front: string; back: string };

const CLOZE = /==([^=\n]+)==/g;
/** What a hidden cloze shows on the front. */
export const CLOZE_GAP = "［⋯］";

/** The two sides of the block whose anchor is `ref` in `markdown`, or null when the note has no such block node.
 *  `anchors`: the note's valid anchors (a block's identity is not in its text). */
export function blockCardSides(markdown: string, ref: string, anchors: readonly AnchorAt[]): BlockCardSides | null {
  const block = parseBlocks(markdown, anchors).find((b) => b.ref === ref);
  if (!block) return null;
  // The block's text with its own markers cut out (offsets from the end, so
  // the earlier cut doesn't move the later one).
  const cuts = [block.marks.ref, block.marks.tags].filter((s): s is NonNullable<typeof s> => !!s)
    .sort((a, b) => b.from - a.from);
  let text = markdown;
  let end = block.end;
  for (const span of cuts) {
    if (span.from < block.start || span.to > end) continue;
    let from = span.from;
    while (from > block.start && text[from - 1] === " ") from--;
    text = text.slice(0, from) + text.slice(span.to);
    end -= span.to - from;
  }
  const scope = text.slice(block.start, end).replace(/\s+$/, "");
  const lines = scope.split("\n");
  const head = lines[0]!;
  const rest = dedent(lines.slice(1)).join("\n").trim();
  const firstLine = stripMarker(head);

  if (CLOZE.test(scope)) {
    CLOZE.lastIndex = 0;
    const plain = block.kind === "listItem" ? [firstLine, rest].filter(Boolean).join("\n") : stripMarker(scope);
    return { front: plain.replace(CLOZE, CLOZE_GAP), back: plain.replace(CLOZE, "**$1**") };
  }
  return { front: firstLine, back: rest };
}

/** A line without its list bullet, checkbox, heading hashes or quote marks. */
function stripMarker(line: string): string {
  return stripLineMarker(line)
    .replace(/\n[ \t]*>[ \t]?/g, "\n")
    .trim();
}

/** Lines with their shared leading indentation removed. */
function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(cut, l.match(/^[ \t]*/)![0].length)));
}

/** The paragraphs just before and just after a block card's own, as plain
 *  prose (shown with the answer, so a card is read in its place). Nested
 *  lines of the card itself are not "after". Null when the note has no such
 *  block node; a side with nothing there is null. */
export type BlockNeighbours = { before: string | null; after: string | null };
const NEIGHBOUR_MAX = 400;

export function blockNeighbours(markdown: string, ref: string, anchors: readonly AnchorAt[]): BlockNeighbours | null {
  const block = parseBlocks(markdown, anchors).find((b) => b.ref === ref);
  if (!block) return null;
  const spans = blocksOf(markdown);
  const prose = (span: { start: number; end: number } | undefined): string | null => {
    if (!span) return null;
    const text = blockText(markdown, span, [], () => false);
    return text ? ellipsize(text, NEIGHBOUR_MAX) : null;
  };
  return {
    before: prose(spans.filter((span) => span.end <= block.start).pop()),
    after: prose(spans.find((span) => span.start >= block.end)),
  };
}
