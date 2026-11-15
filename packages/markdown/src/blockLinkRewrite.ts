// The old part link `[[筆記#^id]]` ↔ the new one `[[筆記/段落開頭]]` (block-anchors-2026-11-01.md §0.5 item 4; batch 3 §11).
// Pure text: which link says what is the caller's (it knows the anchors, the notes and the bindings). The alias
// `|…` is kept, links in code stay, an embed stays an embed (blockChild.ts rewriteLinks).

import { rewriteLinks } from "./blockChild.js";
import { hasLinkPath } from "./text.js";

/** An old part link as written: the note it names ("" for `[[#^id]]`, the note it is written in), the anchor id, embed or not. */
export type OldPartLink = { embed: boolean; note: string; id: string };

/** The words a rewritten link carries after the `/`: the caller's words, without `#` or `^` (they would read as an
 *  anchor mark in the link's own text). */
export function oldPartLinkWords(words: string): string {
  return words.replace(/[#^]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The text with each old part link `decide` names written as `[[note/words]]` (`[[/words]]` for a link to the
 *  note it is written in). `decide` returns null to leave a link as it is (it is then the caller's to report). */
export function writePartLinks(
  markdown: string, decide: (link: OldPartLink) => { note: string; words: string } | null,
): { markdown: string; count: number } {
  return rewriteLinks(markdown, ({ embed, target, anchor }) => {
    if (anchor?.kind !== "block") return null;
    const next = decide({ embed, note: target, id: anchor.id });
    return next ? { target: next.note ? `${next.note}/${next.words}` : `/${next.words}`, anchor: null } : null;
  });
}

/** The old ids of the old part links in the text, in order (what `decide` of writePartLinks will be asked about). */
export function oldPartLinkIds(markdown: string): string[] {
  const ids: string[] = [];
  rewriteLinks(markdown, ({ anchor }) => { if (anchor?.kind === "block") ids.push(anchor.id); return null; });
  return ids.reverse(); // rewriteLinks reads from the end
}

/** The way back: each new part link `lookup` knows (its target as written → the note to name and the anchor id)
 *  written as `[[note#^id]]`, which the older app reads. Links that are not bound part links stay. */
export function restorePartLinks(
  markdown: string, lookup: (target: string) => { note: string; id: string } | null,
): { markdown: string; count: number } {
  return rewriteLinks(markdown, ({ target, anchor }) => {
    if (anchor || !hasLinkPath(target)) return null;
    const hit = lookup(target);
    return hit ? { target: hit.note, anchor: { kind: "block", id: hit.id } } : null;
  });
}
