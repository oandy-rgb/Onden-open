// Load the published snapshot for a /site page and shape it into page data.
// The last shaped copy is kept with the server's ETag and checked with
// If-None-Match, so a page of an unchanged site neither downloads nor parses
// the whole site again. The cache holds only the served site, which is public
// already; the server answers 304 only for the content it serves now, so a
// takedown reaches the very next page.
import { readSiteData, type SiteData, type SiteSnapshot } from "../../components/siteFrame";

const API_BASE = process.env.SSR_API_URL ?? import.meta.env.PUBLIC_API_BASE_URL ?? "http://localhost:8787";

export type SiteLoad =
  | { kind: "ok"; data: SiteData }
  | { kind: "error" };

export function createSiteLoader(fetchImpl: typeof fetch, apiBase: string): () => Promise<SiteLoad> {
  let kept: { etag: string; data: SiteData } | null = null;
  return async () => {
    try {
      const res = await fetchImpl(`${apiBase}/api/site`, kept ? { headers: { "If-None-Match": kept.etag } } : undefined);
      if (res.status === 304 && kept) return { kind: "ok", data: kept.data };
      if (res.ok) {
        const data = readSiteData((await res.json()) as SiteSnapshot);
        const etag = res.headers.get("ETag");
        kept = etag ? { etag, data } : null;
        return { kind: "ok", data };
      }
    } catch {
      // An unreachable or malformed API reads as "unavailable".
    }
    // Never answer from the kept copy when the server did not confirm it.
    kept = null;
    return { kind: "error" };
  };
}

export const loadSite = createSiteLoader((input, init) => fetch(input, init), API_BASE);
