// Markdown as the words a reader sees, on one line — the one place that strips
// Markdown syntax for a summary, a list label, a block title or a "linked from"
// sentence. Before this, nine copies each stripped a different set: a summary
// deleted the underscores inside `snake_case_name`, a list label kept link
// URLs, a backlink context ate `[!info]`. They differ now only in what they
// keep (summary.ts, linkContext.ts, blockChild.ts say so), not in how syntax
// is read.
//
// The reading-view's own tree stays with the renderer; this is the cheap
// string pass for text that is shown small and for every note a list shows, so
// every step is linear on a pathological body (summary.test, bodyParsersLinear).

import { withoutLineTrailers } from "./blockId.js";
import { replaceWikilinks, splitWikilink } from "./text.js";

/** The characters that can open a list-ish or quote-ish line before its words. */
const LINE_MARKER = /^[ \t>]*(?:#{1,6}(?:[ \t]+|$))?(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[[ xX]\](?:[ \t]+|$))?)?/;

/** How many characters of `line` are its quote marks, heading hashes, list
 *  bullet or number and task box — what to blank or drop to get to its words. */
export function lineMarkerLength(line: string): number {
  return LINE_MARKER.exec(line)![0].length;
}

const CHECKLIST_LINE = /^(\s*[-*+]\s+\[([ xX])\]\s)(.*)$/;

/** A line of a checklist (`- [ ] buy`, `* [x] done`): the text up to and
 *  including the box and the space after it (`prefix`), whether it is ticked,
 *  and the words after it. Null for any other line (a plain bullet, or a task
 *  line a number leads). The editor's line-edit operations use it; what a note
 *  has as tasks is taskParse / the renderer's own tree. */
export function checklistLine(line: string): { prefix: string; checked: boolean; text: string } | null {
  const m = CHECKLIST_LINE.exec(line);
  return m ? { prefix: m[1]!, checked: m[2] !== " ", text: m[3]! } : null;
}

/** `line` without the quote marks, heading hashes, list bullet or number and
 *  task box in front of its words (`> - [ ] buy` → `buy`). */
export function stripLineMarker(line: string): string {
  return line.slice(lineMarkerLength(line));
}

/** What a wikilink shows when it has no alias: its page, without a ^block
 *  anchor, a heading's `#` read as " › ". */
export function wikilinkLabel(body: string): string {
  const { target, alias } = splitWikilink(body);
  return (alias ?? target.replace(/#\^[^\s\]|]*$/, "").replace(/#/g, " › ")).replace(/[\u0001\u0002]/g, "");
}

/** Inline markup down to the words a reader sees: images dropped, links and
 *  `[[wikilinks]]` as their label, footnote marks and HTML tags dropped,
 *  emphasis, strikethrough and code marks removed — an underscore inside a word
 *  (`snake_case`) stays. Whitespace is left alone for the caller to collapse. */
export function plainInline(text: string, labelOf: (body: string) => string = wikilinkLabel): string {
  const imageless = replaceInlineLinks(text, "![", 0, () => " ");
  const labelled = replaceWikilinks(imageless, labelOf);
  return replaceInlineLinks(labelled, "[", 1, (label) => label)
    .replace(/\[\^[^\]\n]{0,200}\]/g, "")
    .replace(/<\/?[A-Za-z][^>\n]{0,500}>/g, "")
    .replace(/[*~`]+/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "");
}

/** Replace `![label](url)` (opener "![") or `[label](url)` (opener "[")
 *  with `replace(label)`, as the regex `<opener>([^\]]{min,500})\]\([^)]{0,2000}\)`
 *  would, leftmost first. A regex retried at every opener and rescanned up to
 *  2000 characters before failing: linear, but ~10 µs a character on a body of
 *  unclosed links, for every note /api/bootstrap lists. The next `]` and `)`
 *  are found once and reused while the scan moves past them. */
function replaceInlineLinks(text: string, opener: "![" | "[", minLabel: number, replace: (label: string) => string): string {
  const MAX_LABEL = 500, MAX_URL = 2000;
  let out = "", from = 0, i = text.indexOf(opener);
  let closeBracket = -1, closeParen = -1;
  while (i !== -1) {
    const labelStart = i + opener.length;
    if (closeBracket < labelStart) closeBracket = text.indexOf("]", labelStart);
    if (closeBracket === -1) break;                    // no `]` left: nothing further can match
    const labelLength = closeBracket - labelStart;
    if (labelLength >= minLabel && labelLength <= MAX_LABEL && text[closeBracket + 1] === "(") {
      const urlStart = closeBracket + 2;
      if (closeParen < urlStart) closeParen = text.indexOf(")", urlStart);
      if (closeParen === -1) break;                    // no `)` left: nothing further can match
      if (closeParen - urlStart <= MAX_URL) {
        out += text.slice(from, i) + replace(text.slice(labelStart, closeBracket));
        from = closeParen + 1;
        i = text.indexOf(opener, from);
        continue;
      }
    }
    i = text.indexOf(opener, i + 1);
  }
  return out + text.slice(from);
}

/** A window of raw Markdown with one span marked (a link, a mention) as the
 *  words a reader sees: the text on each side with its syntax removed (heading
 *  hashes, list and task marks, `{tag}`, `^id`, emphasis, links), the span as
 *  its label (`[[Note|alias]]` → `alias`), whitespace collapsed. `range` is the
 *  span in the returned text. `startsAtLine`: the window opens at a line start,
 *  so its first line's marker is syntax too. */
export function plainAroundSpan(
  raw: string, spanStart: number, spanEnd: number, startsAtLine = true,
  /** What a `[[link]]` reads as (its body): the app passes the reading of a part link (「筆記 › 開頭」). */
  labelOf: (body: string) => string = wikilinkLabel,
): { text: string; range: [number, number] } {
  // The line the span sits in is cut mid-line on one side: its end (before the span) is no line end.
  const side = (part: string, firstLineStarts: boolean, lastLineEnds: boolean) => {
    const lines = part.split("\n");
    return plainInline(lines.map((line, i) => {
      const words = i > 0 || firstLineStarts ? stripLineMarker(line) : line;
      return i < lines.length - 1 || lastLineEnds ? withoutLineTrailers(words) : words;
    }).join("\n"), labelOf).replace(/\s+/g, " ");
  };
  const span = raw.slice(spanStart, spanEnd);
  const label = span.startsWith("[[") && span.endsWith("]]") ? labelOf(span.slice(2, -2)) : span;
  const before = side(raw.slice(0, spanStart), startsAtLine, false).trimStart();
  const after = side(raw.slice(spanEnd), false, true).trimEnd();
  return { text: before + label + after, range: [before.length, before.length + label.length] };
}
