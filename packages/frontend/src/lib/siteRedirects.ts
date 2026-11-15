// The served site's old addresses (`site_redirects` in /api/site, GAP-240):
// a renamed note's or tag's earlier address and where that page is now. The
// server keeps only pages still on the site (backend publishing/siteRedirects.ts).
// Read by the pages (siteModel), the feeds and the static copy's page list.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The served `site_redirects` as `from → to`, malformed entries left out. */
export function siteRedirectsOf(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (isObj(entry) && typeof entry.from === "string" && typeof entry.to === "string" && entry.from.startsWith("/site/") && entry.to.startsWith("/site/")) {
      out.set(entry.from, entry.to);
    }
  }
  return out;
}

/** Where an old address now is, for a page this site does not have: the
 *  current address, percent-encoded for a Location header (slugs keep CJK
 *  characters), or null. `path` is the decoded `/site/<slug>/` or `/site/tag/<slug>/`. */
export function movedTo(redirects: ReadonlyMap<string, string>, path: string): string | null {
  const to = redirects.get(path.endsWith("/") ? path : `${path}/`);
  return to ? to.split("/").map(encodeURIComponent).join("/") : null;
}
