// The editor's one-time nudge for a `#word` typed in a note's body.
//
// A `#word` in the body is text, not a tag (lib/hashtags): to tag a paragraph
// the note says `{word}` at the block's end (docs/architecture/block-nodes.md).
// When someone types `#word` and a space, the editor offers to rewrite it that
// way. This module only reads and rewrites text; hooks/useHintOnce decides
// whether the offer is made at all (once per account).

import { addBlockTag, blockTagSlot, TAG_NAME_CHAR } from "@onden/markdown";

export type HashtagScopeHint = {
  /** The tag name as typed, without the `#`. */
  name: string;
  /** The `#name` range in the body: [from, to). */
  from: number;
  to: number;
};

const TYPED_HASHTAG = new RegExp(String.raw`(^|\s)#(${TAG_NAME_CHAR}+)$`, "u");

/** The `#word` just finished (a space, tab or newline typed right after it)
 *  at `caret`, when it looks like a tag aimed at a paragraph: not a heading
 *  (`# Title` has its space first), not an issue number (`#12`), not in code
 *  or a formula (`inLiteral`, given the position of its `#`), a table or the front matter, and not an anchor (`page#frag`,
 *  which has no space before the `#`). */
export function hashtagScopeHintAt(doc: string, caret: number, inLiteral: (pos: number) => boolean = () => false): HashtagScopeHint | null {
  if (caret < 2 || !/[ \t\n]/.test(doc[caret - 1]!)) return null;
  const before = doc.slice(0, caret - 1);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  const m = TYPED_HASHTAG.exec(line);
  if (!m) return null;
  const name = m[2]!;
  if (/^\d+$/.test(name)) return null;
  const from = lineStart + m.index + m[1]!.length;
  // Code and formulas: the editor's one judgment (lib/editorCompletion popupBlockedAt).
  if (inLiteral(from + 1)) return null;
  if (!blockTagSlot(doc, from)) return null;
  return { name, from, to: from + 1 + name.length };
}

/** `doc` with the hinted `#word` taken out and `{word}` written where the
 *  block's tags go (addBlockTag: its last line, before any hidden id). A block
 *  that is nothing but the `#word` gets `{word}` in its place. */
export function hashtagToScope(doc: string, hint: HashtagScopeHint): string {
  // Take the space before it too, so no double space is left behind.
  const gap = doc[hint.from - 1] === " " && /[\s]|^$/.test(doc[hint.to] ?? "") ? 1 : 0;
  const without = doc.slice(0, hint.from - gap) + doc.slice(hint.to);
  const at = hint.from - gap;
  for (const offset of [at, at - 1]) {
    if (offset < 0 || offset > without.length) continue;
    const tagged = addBlockTag(without, offset, hint.name);
    if (tagged !== null) return tagged;
  }
  return doc.slice(0, hint.from) + `{${hint.name}}` + doc.slice(hint.to);
}
