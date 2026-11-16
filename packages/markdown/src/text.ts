// The grammar of note text that the app, the server and the published site
// must read the same way: [[wikilinks]], #hashtags, and which note a link
// names. Before this module the scanner was copied into the backend and the
// app ("must find exactly the same links"), the hashtag pattern lived in five
// files and the app resolved links with its own slug rule.
//
// Every scan is linear: a regex like /\[\[([^\]]+)\]\]/g re-reads to the end
// of the text from every `[[` of a run, so one pasted body of `[[[[…` froze
// the tab for seconds (backend test/bodyParsersLinear.test.ts times them).

import { parseInkRegion } from "./inkRegion.js";
import { nodeRefId } from "./nodeRef.js";
import { linkSlug } from "./slug.js";
import { normalizeText, WORD_CHARS } from "./word.js";

/** One `[[…]]` in a text: its span and the body between the brackets. */
export type WikilinkMatch = { start: number; end: number; body: string };

/** Every `[[…]]` in the RAW text — inside inline code, code fences and `$math$`
 *  too, where the renderer draws plain text (drawnWikilinks is the parser's
 *  answer). Use it where missing a link is worse than finding an extra one
 *  (backlink edges, redaction, rewriting); not to decide what the page shows.
 *  Exactly as /\[\[([^\]\n]+)\]\]/g finds them (a link never spans a line), in linear time;
 *  `accept` narrows the body as a stricter regex would (a refused start is
 *  retried one character later, as the regex engine does). From each `[[` the
 *  body runs to the first `]` and is a link only if `]]` follows; that first
 *  `]` is found once and shared by the starts before it. */
export function scanWikilinks(
  text: string, accept: (body: string, start: number) => boolean = () => true,
): WikilinkMatch[] {
  const out: WikilinkMatch[] = [];
  let close = -1; // the first "]" at or after the current start's body
  let newline = -2; // the first line break at or after it, likewise shared (-2: not looked up, -1: none)
  let i = text.indexOf("[[");
  while (i !== -1) {
    if (close < i + 2) close = text.indexOf("]", i + 2);
    if (close === -1) break; // no "]" after: no further link
    if (newline !== -1 && newline < i + 2) newline = text.indexOf("\n", i + 2);
    // A link never spans a line (as in Obsidian): an unclosed `![[a.png` must
    // not swallow the next line's `![[b.png]]`.
    const sameLine = newline === -1 || newline > close;
    const body = text.slice(i + 2, close);
    if (close > i + 2 && sameLine && text[close + 1] === "]" && accept(body, i)) {
      out.push({ start: i, end: close + 2, body });
      i = text.indexOf("[[", close + 2);
    } else {
      i = text.indexOf("[[", i + 1);
    }
  }
  return out;
}

/** The link when the WHOLE of `text` is one `[[target]]` or `[[target|alias]]`
 *  (no text around it, not even blanks: trim first), else null. `body` is
 *  what is between the brackets, `target` its part before the `|` alias, `alias`
 *  the rest (null without a `|`). The same links scanWikilinks finds, in
 *  O(length). Not for `![[embeds]]` (strip the `!` first) or a half-typed
 *  `[[xx` (editorCompletion.ts). */
export function soleWikilink(text: string): { body: string; target: string; alias: string | null } | null {
  if (text.length < 5 || !text.startsWith("[[") || !text.endsWith("]]")) return null;
  const body = text.slice(2, -2);
  if (body.includes("]") || body.includes("\n")) return null;
  return { body, ...splitWikilink(body) };
}

/** The bodies of the text's `[[…]]` links. */
export function wikilinkBodies(text: string): string[] {
  return scanWikilinks(text).map((m) => m.body);
}

/** Replace each accepted `[[…]]` with `replace(body)`. */
export function replaceWikilinks(
  text: string, replace: (body: string, full: string) => string,
  accept?: (body: string, start: number) => boolean,
): string {
  let out = "", last = 0;
  for (const m of scanWikilinks(text, accept)) {
    out += text.slice(last, m.start) + replace(m.body, text.slice(m.start, m.end));
    last = m.end;
  }
  return out + text.slice(last);
}

/** A link body as `target` and the `alias` after its first `|` (null when
 *  there is no `|`). */
export function splitWikilink(body: string): { target: string; alias: string | null } {
  const bar = body.indexOf("|");
  if (bar === -1) return { target: body, alias: null };
  const target = body.slice(0, bar), alias = body.slice(bar + 1);
  // `![[note|ink=頁@x,y,w,h]]` quotes an area of a handwriting page (inkRegion.ts): that part is no label,
  // so every plain-text reading (summaries, snippets, backlink context) shows the note's name instead — or, for
  // a note named by id, which has no words, a pencil mark (no language of its own).
  if (!parseInkRegion(alias)) return { target, alias };
  return { target, alias: nodeRefId(target) ? INK_REGION_PLAIN_NAME : null };
}

/** What a quoted area of a note named by id reads as in plain text. */
export const INK_REGION_PLAIN_NAME = "✎";

/** What a reader sees of a link body: its alias after the first `|`, else the
 *  whole body. */
export function wikilinkShown(body: string): string {
  if (body.indexOf("|") === -1) return body;
  const { target, alias } = splitWikilink(body);
  return alias ?? target;
}

/** The page a link body names: the part before its `|` alias and `#`
 *  heading/block anchor, trimmed (Obsidian semantics), in NFC (word.ts), so a
 *  link typed on one system names the title imported from another. "" for a
 *  same-page anchor such as `[[#heading]]`. */
export function wikilinkTarget(body: string): string {
  return normalizeText(body.split("|")[0]!.split("#")[0]!.trim());
}

/** A title or alias as a link target is compared with it: trimmed, NFC,
 *  lower-cased. A title stored before D58 may be NFD; it still matches. */
export function linkNameKey(name: string): string {
  return normalizeText(name.trim()).toLowerCase();
}

/** An Obsidian Excalidraw file's name ends in `.excalidraw` (the file is
 *  `name.excalidraw.md`); Obsidian links it as `[[name.excalidraw]]`. */
const EXCALIDRAW_SUFFIX = /\.excalidraw$/i;

/** The names a link target may name a note by: the target itself, and for an
 *  Obsidian Excalidraw link (`name.excalidraw`) also `name` — the title the
 *  drawing import gives the note (its `aliases` keep the old name too, but a
 *  note renamed or imported without that alias still resolves). The server's
 *  edges (backend utils.extractWikilinks) read links through this too. */
export function wikilinkNames(target: string): string[] {
  const bare = target.replace(EXCALIDRAW_SUFFIX, "").trim();
  return bare && bare !== target ? [target, bare] : [target];
}

/** Whether a link body names this note: its title (case-insensitive), its
 *  slug, or one of its aliases — what the server's wikilink edges match.
 *  `[[name.excalidraw]]` also names a note titled `name` (wikilinkNames). */
export function linkNamesNote(
  body: string, note: { title: string; slug?: string | null; aliases?: readonly string[] },
): boolean {
  const target = wikilinkTarget(body).toLowerCase();
  if (!target) return false;
  const title = linkNameKey(note.title);
  const aliases = (note.aliases ?? []).map(linkNameKey);
  return wikilinkNames(target).some((name) => title === name
    || (note.slug != null && note.slug === linkSlug(name))
    || aliases.includes(name));
}

/** One character of a tag name: a letter, mark or digit of any script
 *  (word.ts), `_` or `-`. */
export const TAG_NAME_CHAR = `[${WORD_CHARS}_-]`;

/** Hashtags in text. Group 1 = the boundary (line start or whitespace),
 *  group 2 = the name without `#`. A `#word` in a note's text is not tag
 *  membership (T10): this grammar serves presentation, the editor's `#`
 *  suggestions and paragraph block tags, not "which notes carry tag X". Global: use it with matchAll/replace only (both reset
 *  lastIndex), never with .test/.exec. */
export const HASHTAG_RE = new RegExp(String.raw`(^|\s)#(${TAG_NAME_CHAR}+)`, "gu");

// What one entry between the commas of a block's `{…}` may be: a tag name — the characters of a #hashtag, and between
// them spaces and `/ . + &` — or `key: value` of the same characters. Anything else (`;`, brackets, quotes, operators)
// is program text.
const TAG_ENTRY = new RegExp(String.raw`^${TAG_NAME_CHAR}(?:${TAG_NAME_CHAR}|[ /.+&])*(?::[ ]*(?:${TAG_NAME_CHAR}|[ /.+&])*)?$`, "u");

/** The ONE rule for what a `{…}` at a line's end must hold to be a block's tags and not text: nothing but tag entries
 *  between its commas (`inner` is what is between the braces). `{ indent(); ECHO; }` ending a line of program text
 *  pasted as a paragraph is text. blocks.ts (tagBraces) and every cheap string test that drops a trailing `{…}` from
 *  shown text ask this. */
export function isTagList(inner: string): boolean {
  return inner.split(",").every((entry) => entry.trim() === "" || TAG_ENTRY.test(entry.trim()));
}

/** Whether `target` (the part of a link before `|`) can be a path into a note: it has a `/` that is not escaped as part of a name. */
export function hasLinkPath(target: string): boolean {
  return target.includes("/") && !target.includes("://");
}
