// 摘錄 (excerpt): a passage of someone else's text, kept in a note with where it
// came from. RSS highlights write one today; PDF highlights will write the same
// (docs/architecture/excerpts.md). The format and the reading of it live here so
// the app, the server and every later source agree on one.
//
//     > the selected text
//     >
//     > — [Article title](https://original.url#:~:text=prefix-,the%20selected%20text,-suffix) · Feed name
//
// A plain Markdown blockquote whose last line is the linked source, identified by the paragraph anchor that starts
// at it (block_anchors: the text carries no id), so an embed of that anchor shows the quote with its source line
// and any Markdown reader shows it as a quote.
//
// Where the passage is in the original is the browser's own Text Fragment
// (WICG Text Fragments), written into the link: opening the link in an ordinary
// browser jumps to the passage. Its prefix / suffix are the W3C Web Annotation
// TextQuoteSelector's: `exact` is the quote itself, `prefix` / `suffix` the words
// just before / after it in the original, which tell apart a passage that occurs
// twice. Only a source WITH a link is an excerpt for the reader (parseExcerpts):
// without one there is nothing to find it by.
//
import { anchoredBlocks, blockSpans } from "./blocks.js";
import { hasLinkPath } from "./text.js";
import { embedMatches, type EmbedMatch } from "./embeds.js";
import { graphemes } from "./graphemes.js";

export type Excerpt = {
  /** The id of the anchor that starts at the quote. */
  id: string;
  /** The quoted text as selected; paragraphs are separated by a blank line. */
  exact: string;
  /** The words before / after it in the original ("" when unknown). */
  prefix: string;
  suffix: string;
  /** The original page, without the fragment. */
  url: string;
  title: string;
  /** The subscription's name ("" when none). */
  feed: string;
};

/** What a caller knows when it writes one. */
export type ExcerptSource = {
  title: string;
  /** Null: the quote is written with a plain source name and no link. */
  url: string | null;
  feed: string;
};

/** How many characters of context a prefix / suffix keeps. */
export const EXCERPT_CONTEXT_MAX = 32;
// A fragment names a long passage by its first and last words (the spec's
// `start,end` range); a short one whole.
const WHOLE_MAX = 80;
const EDGE = 40;

const TEXT_DIRECTIVE = "#:~:text=";

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

const words = new Intl.Segmenter(undefined, { granularity: "word" });

/** The first words of `text` that fit in `max` characters, cut between words
 *  (Chinese has none to cut at but the segmenter's own), without surrounding
 *  spaces. Nothing when even the first word is longer, unless `atLeastOne`. */
function headWords(text: string, max: number, atLeastOne = false): string {
  let out = "";
  for (const { segment } of words.segment(text)) {
    if (graphemes(out + segment).length > max && (out.trim() || !atLeastOne)) break;
    out += segment;
  }
  return out.trim();
}

/** The last words of `text` that fit in `max` characters (as headWords). */
function tailWords(text: string, max: number, atLeastOne = false): string {
  const segments = [...words.segment(text)].map((s) => s.segment);
  let out = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    if (graphemes(segments[i]! + out).length > max && (out.trim() || !atLeastOne)) break;
    out = segments[i]! + out;
  }
  return out.trim();
}

/** The text just before and after a selection, as `prefix` / `suffix`: spaces
 *  squashed, at most EXCERPT_CONTEXT_MAX characters each, whole words only (a
 *  Text Fragment's prefix starts, and its suffix ends, at a word boundary or the
 *  browser does not find the passage). `before` / `after` are the original's
 *  text on either side, within one paragraph. */
export function excerptContext(before: string, after: string): { prefix: string; suffix: string } {
  return { prefix: tailWords(squash(before), EXCERPT_CONTEXT_MAX), suffix: headWords(squash(after), EXCERPT_CONTEXT_MAX) };
}

// ── The source line ────────────────────────────────────────────────────────

const hex = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
/** A link destination Markdown reads whole: no spaces or parentheses. */
const linkUrl = (url: string) => url.replace(/[()\s]/g, hex);
const escapeLabel = (label: string) => label.replace(/([[\]\\])/g, "\\$1");

/** "— [title](url) · feed" (no link without a url, no feed without a name). */
export function sourceLine(source: ExcerptSource, untitled = "Untitled"): string {
  const title = source.title.trim() || untitled;
  const label = source.url ? `[${escapeLabel(title)}](${linkUrl(source.url)})` : title;
  return `— ${label}${source.feed.trim() ? ` · ${source.feed.trim()}` : ""}`;
}

// ── Text Fragment ──────────────────────────────────────────────────────────

/** A directive part, percent-encoded as the spec asks (`-`, `&` and `,` are
 *  its separators) and for a Markdown link (parentheses). */
const part = (text: string) => encodeURIComponent(text).replace(/[-()]/g, hex);

/** `#:~:text=prefix-,start[,end],-suffix` for a passage. */
function textFragment(exact: string, prefix: string, suffix: string): string {
  const lines = exact.split(/\n/).map(squash).filter(Boolean);
  if (lines.length === 0) return "";
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  const range = lines.length > 1 || graphemes(first).length > WHOLE_MAX;
  const parts = range ? [headWords(first, EDGE, true), tailWords(last, EDGE, true)] : [first];
  return TEXT_DIRECTIVE + [
    ...(prefix ? [`${part(prefix)}-`] : []),
    ...parts.map(part),
    ...(suffix ? [`-${part(suffix)}`] : []),
  ].join(",");
}

/** The context a fragment carries, as written by textFragment. */
function fragmentContext(directive: string): { prefix: string; suffix: string } {
  const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  const parts = directive.split("&")[0]!.split(",");
  const prefix = parts.length > 1 && parts[0]!.endsWith("-") ? decode(parts.shift()!.slice(0, -1)) : "";
  const suffix = parts.length > 1 && parts[parts.length - 1]!.startsWith("-") ? decode(parts.pop()!.slice(1)) : "";
  return { prefix, suffix };
}

// ── Writing ────────────────────────────────────────────────────────────────

/** The text as a Markdown blockquote, line by line. */
export function blockquote(text: string): string {
  return text.trim().split(/\r?\n/).map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">")).join("\n");
}

/** The excerpt as Markdown (see the file head); the caller gets it an anchor. */
export function excerptBlock(
  quote: { exact: string; prefix?: string; suffix?: string },
  source: ExcerptSource,
  untitled?: string,
): string {
  const page = source.url?.split("#")[0] ?? null;
  const located = page ? { ...source, url: `${page}${textFragment(quote.exact, quote.prefix ?? "", quote.suffix ?? "")}` } : source;
  return `${blockquote(quote.exact)}\n>\n> ${sourceLine(located, untitled)}`;
}

/** An excerpt as plain Markdown without its id: for a file that leaves the
 *  app, where the quote and its link must stand without the note they came from. */
export function excerptPlain(excerpt: Excerpt, untitled?: string): string {
  return `${blockquote(excerpt.exact)}\n>\n> ${sourceLine({
    title: excerpt.title, feed: excerpt.feed,
    url: `${excerpt.url}${textFragment(excerpt.exact, excerpt.prefix, excerpt.suffix)}`,
  }, untitled)}`;
}

// ── Reading ────────────────────────────────────────────────────────────────

const SOURCE_LINE = /^— \[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)(?: · (.+))?$/;
const QUOTE_MARK = /^[ \t]*>[ \t]?/;

/** Every excerpt in a note, in order. A quote that is not shaped like one
 *  (no anchor, no linked source line last) is just a quote and not listed. `anchors`: the note's anchors. */
export function parseExcerpts(markdown: string, anchors: ReadonlyArray<{ id: string; from: number; to: number }> = []): Excerpt[] {
  if (!markdown.includes("](") || anchors.length === 0) return [];
  const found: Excerpt[] = [];
  for (const anchor of anchoredBlocks(markdown, anchors)) {
    if (anchor.kind !== "quote") continue;
    const shaped = excerptShape(markdown.slice(anchor.start, anchor.end));
    if (shaped) found.push({ id: anchor.id, ...shaped });
  }
  return found;
}

/** What a quote block says when it is shaped like an excerpt (the quote, a blank line, a `— [title](url) · feed` line last). */
function excerptShape(block: string): Omit<Excerpt, "id"> | null {
  const lines = block.split("\n").map((line) => line.replace(QUOTE_MARK, ""));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const source = SOURCE_LINE.exec(lines.pop()?.trim() ?? "");
  if (!source || lines.pop()?.trim() !== "") return null; // the blank line between the quote and its source
  const exact = lines.join("\n").trim();
  if (!exact) return null;
  const at = source[2]!.indexOf(TEXT_DIRECTIVE);
  return {
    exact,
    ...(at < 0 ? { prefix: "", suffix: "" } : fragmentContext(source[2]!.slice(at + TEXT_DIRECTIVE.length))),
    url: at < 0 ? source[2]! : source[2]!.slice(0, at),
    title: source[1]!.replace(/\\([[\]\\])/g, "$1"),
    feed: source[3]?.trim() ?? "",
  };
}

/** Where each excerpt-shaped quote block of the note is (whether or not it has an anchor yet): the server gives
 *  those an anchor, so an excerpt is known by identity from the moment it is written. */
export function excerptBlockSpans(markdown: string): Array<{ from: number; to: number }> {
  if (!markdown.includes("](") || !/^[ \t]*>[ \t]*— \[/m.test(markdown)) return [];
  return blockSpans(markdown).filter((s) => s.kind === "quote" && excerptShape(markdown.slice(s.start, s.end)) !== null).map((s) => ({ from: s.start, to: s.end }));
}

/** Whether two passages of a page are the same one: the page without its
 *  fragment, the text with spaces squashed. */
export function sameExcerpt(a: { url: string; exact: string }, b: { url: string; exact: string }): boolean {
  const page = (url: string) => linkUrl(url.split("#")[0]!);
  return page(a.url) === page(b.url) && squash(a.exact) === squash(b.exact);
}

/** Every excerpt of `url`'s page a note holds. */
export function excerptsOfPage(markdown: string, url: string, anchors: ReadonlyArray<{ id: string; from: number; to: number }> = []): Excerpt[] {
  if (!markdown.includes(linkUrl(url.split("#")[0]!))) return []; // the cheap test first: most notes never saw the page
  return parseExcerpts(markdown, anchors).filter((e) => sameExcerpt(e, { url, exact: e.exact }));
}

// ── Leaving the app ────────────────────────────────────────────────────────

/** `markdown` with each `![[Note#^id]]` line that embeds an excerpt replaced by
 *  the excerpt itself (quote and source link). `bodyOf` gives the Markdown of
 *  the note an embed names — with the note's anchors, which is what finds the quote — or null when it is not available to this reader;
 *  an embed it cannot resolve, or whose block is not an excerpt, stays as
 *  written. Only an embed alone on its line is replaced. */
export function expandExcerptEmbeds(
  markdown: string,
  bodyOf: (embed: EmbedMatch) => string | { markdown: string; anchors: ReadonlyArray<{ id: string; from: number; to: number }>; id?: string } | null,
  untitled?: string,
): string {
  let out = "";
  let last = 0;
  for (const embed of embedMatches(markdown)) {
    // `![[Note#^id]]` names the excerpt by its id; `![[Note/words]]` by what the caller read it to be (`id` of bodyOf's answer).
    if (!embed.blockId && !hasLinkPath(embed.target)) continue;
    const lineStart = markdown.lastIndexOf("\n", embed.start - 1) + 1;
    const lineEnd = markdown.indexOf("\n", embed.end) < 0 ? markdown.length : markdown.indexOf("\n", embed.end);
    if (markdown.slice(lineStart, embed.start).trim() !== "" || markdown.slice(embed.end, lineEnd).trim() !== "") continue;
    const body = bodyOf(embed);
    // The note's anchors say which quote is which (a block's identity is not in its text).
    const wantedId = (typeof body === "object" && body !== null && body.id) || embed.blockId;
    const excerpt = body === null || !wantedId ? null
      : (typeof body === "string" ? parseExcerpts(body) : parseExcerpts(body.markdown, body.anchors)).find((e) => e.id === wantedId);
    if (!excerpt) continue;
    out += markdown.slice(last, lineStart) + excerptPlain(excerpt, untitled);
    last = lineEnd;
  }
  return last === 0 ? markdown : out + markdown.slice(last);
}
