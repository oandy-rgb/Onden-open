// Pure parts of the published site's search (components/siteFrame/SiteSearch.astro).
// The index is Pagefind's, made with the static copy and served from the same
// folder on the live site (`/site/search.idx/`, backend siteBundle.ts), so the
// box behaves the same on the live site, in a zip and on a static host.

/** The index folder as a URL with a trailing slash, from the href of the page's
 *  `<link rel="x-site-search">` (relative in a copy, absolute on the live site). */
export function indexFolder(linkHref: string): string {
  return linkHref.endsWith("/") ? linkHref : `${linkHref}/`;
}

/** The site's root, two folders above the index (`<root>/site/search.idx/`):
 *  a result's address is written from it, so a copy served under a Pages
 *  subpath links inside itself. */
export function siteRoot(folder: string): string {
  return new URL("../../", folder).href;
}

/** Where a result opens: Pagefind gives the page's address from the root
 *  (`/site/<slug>/`). */
export function hitHref(root: string, url: string): string {
  return new URL(url.replace(/^\/+/, ""), root).href;
}

export type ExcerptPart = { text: string; mark: boolean };

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/** Pagefind's excerpt (text with `<mark>` around the matches) as parts, so the
 *  box can build it with text nodes: nothing from a note is ever parsed as HTML. */
export function excerptParts(excerpt: string): ExcerptPart[] {
  const parts: ExcerptPart[] = [];
  let mark = false;
  for (const piece of excerpt.split(/(<\/?mark>)/)) {
    if (piece === "<mark>") mark = true;
    else if (piece === "</mark>") mark = false;
    else if (piece) parts.push({ text: piece.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e]!), mark });
  }
  return parts;
}

/** The excerpt with the typed text itself marked wherever it appears. Pagefind
 *  marks the words it matched, which for Chinese text can be single characters
 *  of a longer phrase; when the phrase the reader typed is in the excerpt it is
 *  what they expect to see marked. Otherwise Pagefind's marks stand. */
export function markTypedText(parts: ExcerptPart[], typed: string): ExcerptPart[] {
  const needle = typed.trim().toLowerCase();
  const text = parts.map((p) => p.text).join("");
  if (!needle || !text.toLowerCase().includes(needle)) return parts;
  const marked: ExcerptPart[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) marked.push({ text: text.slice(from, at), mark: false });
    marked.push({ text: text.slice(at, at + needle.length), mark: true });
    from = at + needle.length;
  }
  if (from < text.length) marked.push({ text: text.slice(from), mark: false });
  return marked;
}
