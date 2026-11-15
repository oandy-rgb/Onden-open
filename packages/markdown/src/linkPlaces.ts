// Where a page is mentioned: the sentence a `[[link]]` sits in, for "Linked from" on the published
// site. The reading of the text (blocks, plain words) is linkContext.ts.

import { parseEmbed, type EmbedRef } from "./embeds.js";
import { drawnWikilinks } from "./wikilinkSpans.js";
import { graphemes } from "./graphemes.js";
import { MARK_CLOSE, MARK_OPEN, blockText, blocksOf } from "./linkContext.js";

/** A run of the sentence; `mark` is the link's own words. */
export type ContextPiece = { text: string; mark: boolean };

/** Where a page is mentioned: a link inside a sentence, or an embed of a part of it. */
export type LinkPlace = { kind: "link"; pieces: ContextPiece[] } | { kind: "embed"; embed: EmbedRef };

export type LinkPlaceOptions = {
  isTarget: (body: string) => boolean;
  /** A link body the server turned from `![[body]]` into `[[body]]`. */
  isEmbed?: (body: string) => boolean;
  /** Most places returned (default 3). */
  max?: number;
};

export const CONTEXT_LENGTH = 80;

/** The marked text cut to CONTEXT_LENGTH around its first mark. */
function windowed(marked: string): ContextPiece[] {
  // The mark characters are controls: always a cluster of their own.
  const chars = graphemes(marked);
  const flags: boolean[] = [];
  const letters: string[] = [];
  let inMark = false;
  for (const ch of chars) {
    if (ch === MARK_OPEN) inMark = true;
    else if (ch === MARK_CLOSE) inMark = false;
    else { letters.push(ch); flags.push(inMark); }
  }
  const first = flags.indexOf(true);
  let lo = 0, hi = letters.length;
  if (letters.length > CONTEXT_LENGTH) {
    let last = first;
    while (last + 1 < flags.length && flags[last + 1]) last++;
    const centre = Math.floor((first + last) / 2);
    lo = Math.max(0, Math.min(centre - CONTEXT_LENGTH / 2, letters.length - CONTEXT_LENGTH));
    hi = Math.min(letters.length, lo + CONTEXT_LENGTH);
  }
  const pieces: ContextPiece[] = [];
  for (let i = lo; i < hi; i++) {
    const last = pieces[pieces.length - 1];
    if (last && last.mark === flags[i]) last.text += letters[i];
    else pieces.push({ text: letters[i]!, mark: flags[i]! });
  }
  if (lo > 0) pieces.unshift({ text: "…", mark: false });
  if (hi < letters.length) pieces.push({ text: "…", mark: false });
  return pieces;
}

/** Where `markdown` links to (or embeds) the page `isTarget` names, in reading
 *  order, at most `max` places. One place per sentence: every link to the page
 *  in it is marked. */
export function linkPlaces(markdown: string, { isTarget, isEmbed, max = 3 }: LinkPlaceOptions): LinkPlace[] {
  const all = drawnWikilinks(markdown);
  const links = all.filter((l) => isTarget(l.body));
  if (links.length === 0) return [];
  const places: LinkPlace[] = [];
  for (const block of blocksOf(markdown)) {
    const inBlock = links.filter((l) => l.start >= block.start && l.end <= block.end);
    if (inBlock.length === 0) continue;
    const embeds = inBlock.filter((l) => isEmbed?.(l.body));
    for (const e of embeds) places.push({ kind: "embed", embed: parseEmbed(e.body) });
    const plain = inBlock.filter((l) => !embeds.includes(l));
    if (plain.length > 0) {
      const pieces = windowed(blockText(markdown, block, all, (l) => plain.includes(l)));
      if (pieces.some((p) => p.mark)) places.push({ kind: "link", pieces });
    }
    if (places.length >= max) break;
  }
  return places.slice(0, max);
}
