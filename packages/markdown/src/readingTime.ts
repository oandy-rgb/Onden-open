// How many words a note has and how long it takes to read — the one rule the
// editor's readout, the published pages and their link previews show. Pure
// text in, numbers out. A CJK character (kana, `ー`, Han, Hangul) is one word;
// any other run of letters or digits is one word. Reading time: CJK at 400 a
// minute, every other word at 200, at least one minute. Code blocks are not
// prose and do not count; inline code, the words of a link and of a wikilink
// do; so do the words of a bare URL's neighbours, not the URL itself.

import { withoutFences } from "./fences.js";
import { stripFrontmatter } from "./frontmatter.js";
import { replaceWikilinks, wikilinkShown } from "./text.js";

// `ー` (the long-vowel mark) belongs to no script of its own but is part of a kana word.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]/gu;
const CJK_PER_MINUTE = 400;
const WORDS_PER_MINUTE = 200;

// The bracket, paren and tag runs are capped: a pasted run of `[` or `<` would
// otherwise rescan to the end from every opener (quadratic; the editor feeds
// whole drafts through here).
/** The text a reader reads: no frontmatter, no fenced code, images gone, links
 *  and wikilinks as their label, HTML tags dropped. */
function proseOf(markdown: string): string {
  const unfenced = withoutFences(stripFrontmatter(markdown), " ")
    .replace(/!\[[^\]]{0,200}\]\([^)]{0,500}\)/g, " ");
  return replaceWikilinks(unfenced, wikilinkShown)
    .replace(/\[([^\]]{0,200})\]\([^)]{0,500}\)/g, "$1")
    .replace(/<[^>\n]{1,500}>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

/** The words of `markdown`: each CJK character, plus each other run of letters or digits. */
function tally(markdown: string): { cjk: number; words: number } {
  const prose = proseOf(markdown);
  const cjk = prose.match(CJK)?.length ?? 0;
  const words = prose.replace(CJK, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { cjk, words };
}

/** How many words `markdown` has, as the editor's readout shows them; 0 for an empty page. */
export function countWords(markdown: string): number {
  const { cjk, words } = tally(markdown);
  return cjk + words;
}

/** Whole minutes to read `markdown` (see the rule above). */
export function readingMinutes(markdown: string): number {
  const { cjk, words } = tally(markdown);
  return Math.max(1, Math.round(cjk / CJK_PER_MINUTE + words / WORDS_PER_MINUTE));
}
