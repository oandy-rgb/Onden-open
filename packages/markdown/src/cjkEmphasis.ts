// `**「重點」**接著`, `這是**（注意）**字`, `**重點**。` — emphasis next to CJK
// punctuation. CommonMark decides whether a `**` can open or close from the
// characters beside it, and treats any punctuation as a reason to refuse
// unless a space or more punctuation is on the other side. Chinese is written
// without spaces, so `」**接` is "punctuation, then a letter": the closing
// `**` is refused and the note shows literal asterisks. The CJK-friendly rule
// lets a delimiter next to punctuation still open or close when a CJK
// character is on its other side.
//
// One rule for every reader of note text: the editor's live preview
// (frontend lib/editorCjkEmphasis.ts reads the same neighbours) and this
// plugin, which the preview pane, the published site and the exports run
// (index.ts, parsers.ts). test/properties/cjkEmphasis.property.test.ts holds
// the editor and this parser to the same spans.

import type { Processor } from "unified";
import { cjkFriendlyExtension } from "micromark-extension-cjk-friendly";
import {
  classifyCharacter, classifyPrecedingCharacter, isCjk, isCjkOrIvs, isNonCjkPunctuation, isSpaceOrPunctuation, isUnicodeWhitespace,
} from "micromark-extension-cjk-friendly-util";

/** remark plugin: the CJK-friendly flanking rule for `*` and `_` emphasis. */
export function remarkCjkEmphasis(this: Processor): void {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push(cjkFriendlyExtension());
}

/** Whether a run of `*` or `_` may open and/or close emphasis, by the
 *  CJK-friendly rule the plugin above gives the parser: the same answer from
 *  the characters around the run, for readers that parse by themselves (the
 *  editor's Lezer grammar, frontend lib/editorCjkEmphasis.ts).
 *
 *  `before` is the text just before the run (the last 4 UTF-16 units are
 *  enough), `after` the text just after it (2 units); "" at the start or end
 *  of the text. A `~` after the run counts as an attention marker, as it does
 *  while GFM strikethrough is parsed. */
export function cjkAttentionSides(before: string, after: string, marker: "*" | "_"): { open: boolean; close: boolean } {
  const previousCodes = [...before.slice(-4)];
  const previous = previousCodes.length ? previousCodes[previousCodes.length - 1]!.codePointAt(0)! : null;
  const twoPrevious = previousCodes.length > 1 ? previousCodes[previousCodes.length - 2]!.codePointAt(0)! : null;
  const next = after ? after.codePointAt(0)! : null;

  const beforeClass = classifyCharacter(previous as never);
  const beforePrimary = classifyPrecedingCharacter(beforeClass, () => twoPrevious as never, previous as never);
  const afterClass = classifyCharacter(next as never);

  const ASTERISK = 42, UNDERSCORE = 95, TILDE = 126;
  const isCoreMarker = (code: number | null) => code === ASTERISK || code === UNDERSCORE;
  const beforeNonCjkPunctuation = isNonCjkPunctuation(beforePrimary);
  const beforeSpaceOrNonCjkPunctuation = beforeNonCjkPunctuation || isUnicodeWhitespace(beforePrimary) || isCoreMarker(previous);
  const afterNonCjkPunctuation = isNonCjkPunctuation(afterClass);
  const afterSpaceOrNonCjkPunctuation = afterNonCjkPunctuation || isUnicodeWhitespace(afterClass) || isCoreMarker(next);

  const open = !afterSpaceOrNonCjkPunctuation
    || (afterNonCjkPunctuation && (beforeSpaceOrNonCjkPunctuation || isCjkOrIvs(beforePrimary)))
    || next === TILDE;
  const close = !beforeSpaceOrNonCjkPunctuation
    || (beforeNonCjkPunctuation && (afterSpaceOrNonCjkPunctuation || isCjk(afterClass)))
    || previous === TILDE;
  return marker === "*"
    ? { open, close }
    : { open: open && (isSpaceOrPunctuation(beforePrimary) || !close), close: close && (isSpaceOrPunctuation(afterClass) || !open) };
}
