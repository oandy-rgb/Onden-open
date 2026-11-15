// A web page's own metadata (title, description, og:image), read from one
// SSRF-hardened fetch. Used by the bookmark route (routes/bookmark.ts) to fill
// a bookmark note and to tell quick capture a shared link's title.
//
// HTML parsing is regex — Cheerio / linkedom would be cleaner but pull extra
// dependencies for a route that only needs `<title>` and a few meta tags. The
// regex covers double-quoted, single-quoted, and reversed attribute order,
// which is what real-world OG tags look like.

import { decodeHtmlEntities, cutToUnits } from "@onden/markdown";
import { safeFetch } from "./safeFetch.js";

function extractMeta(html: string, property: string): string | null {
  // Match both <meta property="og:title" content="..."> and
  // <meta content="..." property="og:title"> orderings.
  const forward = new RegExp(
    `<meta\\s+[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`,
    "i",
  );
  const reverse = new RegExp(
    `<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`,
    "i",
  );
  const m = html.match(forward) ?? html.match(reverse);
  return m ? m[1].trim() : null;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}

/** What a fetched page says about itself: its og:title or <title>, else the
 *  fallback; its description and og:image when it has them. Pure (tested in
 *  test/pageMeta.test.ts). */
export function pageMetaFromHtml(html: string, fallbackTitle: string): { title: string; description: string; imageUrl: string | null } {
  const og = extractMeta(html, "og:title");
  const raw = extractTitle(html);
  const title = decodeHtmlEntities(cutToUnits(og ?? raw ?? fallbackTitle, 200));
  const ogDesc = extractMeta(html, "og:description");
  const metaDesc = extractMeta(html, "description");
  const description = decodeHtmlEntities(cutToUnits(ogDesc ?? metaDesc ?? "", 500));
  return { title, description, imageUrl: extractMeta(html, "og:image") };
}

/** Fetch a page once and read its metadata; null when it cannot be read. */
export async function fetchPageMeta(url: string, fallbackTitle: string) {
  try {
    // SSRF-hardened (audit #2): user-supplied url, server-side fetch.
    const res = await safeFetch(url, {
      headers: { "User-Agent": "Onden/1.0 (bookmark fetcher)" },
      timeoutMs: 8_000,
      maxBytes: 2 * 1024 * 1024,
    });
    if (res.status >= 200 && res.status < 300) return pageMetaFromHtml(res.text, fallbackTitle);
  } catch {
    // Best effort — the caller falls back to the URL's host name.
  }
  return null;
}
