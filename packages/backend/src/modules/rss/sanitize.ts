// Feed-content sanitation — pure string functions, no DB, no fetch.
//
// Feed item bodies arrive as untrusted HTML. The stored markdown may carry
// inline HTML (the reader renders it through MarkdownRenderer's raw path,
// which ALSO runs rehype-sanitize — defense in depth), but we strip the
// actively dangerous constructs server-side so the stored body is never a
// payload: <script>/<style>/<iframe> blocks, HTML comments, on* attribute
// handlers and javascript: URLs. Same aggressive-regex posture as the SVG
// sanitizer in routes/media.ts — false positives lose decoration, false
// negatives execute code.

import { pickArticleHtml, type ExtractOptions } from "./articleExtract.js";
import { cutToUnits, decodeHtmlEntities, toEmbedUrl, urlScheme } from "@onden/markdown";

export function sanitizeFeedHtml(html: string): string {
  return keepVideoEmbeds(html)
    .replace(/<\s*(script|style|iframe|object|embed|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed)[^>]*\/\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript\s*:[^"']*\2/gi, "")
    .replace(/javascript\s*:/gi, "")
    .trim();
}

/** A YouTube / Vimeo player (<iframe>) would be stripped with every other
 *  iframe below: keep it as a bare link to the player instead. The reader
 *  and a saved note both show a bare YouTube/Vimeo link as the video
 *  (sandboxed, trusted hosts only — MarkdownRenderer); any other iframe
 *  still goes. */
function keepVideoEmbeds(html: string): string {
  return html.replace(/<\s*iframe\b([^>]*)>(?:[\s\S]*?<\s*\/\s*iframe\s*>)?/gi, (whole, attrs: string) => {
    const src = /(?<![-\w])(?:data-)?src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attrs);
    const embed = toEmbedUrl(decodeHtmlEntities(src?.[1] ?? src?.[2] ?? src?.[3] ?? ""));
    return embed ? `<p><a href="${embed}">${embed}</a></p>` : whole;
  });
}

// An attribute value: "double", 'single' or unquoted — minified pages
// (Docusaurus, Astro…) write `src=/assets/a.png` with no quotes at all.
const VALUE = `("([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`;

// "載入全文" — heuristic readability extraction without pulling jsdom/Readability as dependencies (same trade-off
// bookmark.ts documents for its OG-tag regexes; articleExtract.ts is the pure string scanner and the rules). A
// dependency would have to be pure JS, run in the browser build and fit the bundle guards — the scanner is ~300
// lines and the page furniture rules need site-specific class names no readability library knows either.
// Anything weirder yields a shorter article, which is still useful.
//   title     — the item's title: a heading that only repeats it is dropped.
//   floorText — what the reader already has (the feed's own text): the result is never shorter than it, unless the
//               page has nothing wider.
export function extractArticleHtml(html: string, pageUrl?: string, opts: ExtractOptions = {}): string {
  let body = pickArticleHtml(html, { ...opts, pageUrl });

  // Lazy-loaded images: promote data-src to src when the tag has no real src
  // (or only a placeholder) — the page's JS would have done this, but the
  // reader renders static HTML.
  body = body.replace(/<img\b[^>]*>/gi, (tag) => {
    const dataSrc = new RegExp(`\\bdata-(?:src|lazy-src|original)\\s*=\\s*${VALUE}`, "i").exec(tag);
    if (!dataSrc) return tag;
    const lazy = dataSrc[2] ?? dataSrc[3] ?? dataSrc[4] ?? "";
    // (?<![-\w]) — "data-src" must not read as "src" (a dash IS a \b).
    const src = new RegExp(`(?<![-\\w])src\\s*=\\s*${VALUE}`, "i").exec(tag);
    const current = src?.[2] ?? src?.[3] ?? src?.[4] ?? "";
    // A real src wins; a missing one — or a 1px/data-URI placeholder — loses.
    const placeholder = current === "" || current.startsWith("data:image/gif") || /1x1|blank|placeholder|spacer/i.test(current);
    if (!placeholder || !lazy) return tag;
    return src ? tag.replace(src[0], `src="${lazy}"`) : tag.replace(/<img\b/i, `<img src="${lazy}"`);
  });

  body = absolutizeUrls(body, pageUrl);

  return sanitizeFeedHtml(body);
}

/** Relative media/link URLs (`src`, `href`, `srcset`) resolved against the
 *  ARTICLE's address, not ours: rendered inside the reader they would load
 *  from Onden's own host and fail (a podcast's `<audio src="/assets/…mp3">`
 *  played 0:00). No `pageUrl` → unchanged. */
export function absolutizeUrls(body: string, pageUrl?: string | null): string {
  if (!pageUrl) return body;
  body = body.replace(
    new RegExp(`(?<![-\\w])(src|href)\\s*=\\s*${VALUE}`, "gi"),
    (whole, attr: string, _q: string, dq?: string, sq?: string, bare?: string) => {
      const value = dq ?? sq ?? bare ?? "";
      if (!value || value.startsWith("#") || urlScheme(value) !== undefined) return whole;
      try {
        return `${attr}="${new URL(value, pageUrl).href}"`;
      } catch {
        return whole;
      }
    },
  );
  // srcset carries comma-separated "url descriptor" pairs.
  return body.replace(new RegExp(`(?<![-\\w])srcset\\s*=\\s*${VALUE}`, "gi"), (whole, _q: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare ?? "";
    if (!value) return whole;
    const rewritten = value.split(",").map((part) => {
      const [u, ...desc] = part.trim().split(/\s+/);
      if (!u || urlScheme(u) !== undefined) return part.trim();
      try {
        return [new URL(u, pageUrl).href, ...desc].join(" ");
      } catch {
        return part.trim();
      }
    }).join(", ");
    return `srcset="${rewritten}"`;
  });
}

/** Plain-text preview of an HTML fragment (titles, sample lines). */
export function htmlToText(html: string, max = 300): string {
  const text = decodeHtmlEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return cutToUnits(text, max);
}
