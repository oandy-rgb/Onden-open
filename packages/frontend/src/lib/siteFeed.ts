// Shared plumbing for the published site's machine-readable endpoints
// (/site/feed.xml + /site/sitemap.xml): snapshot fetch, XML escaping, and
// the item summary. Mirrors the /api/site fetch the .astro pages do.
import { noteSummary } from "@onden/markdown";
import { byUpdatedDesc } from "./noteOrder";
import { siteRedirectsOf } from "./siteRedirects";
import type { PublishedNode } from "./publishedNode";

export type SiteMeta = {
  brand?: string;
  tagline?: string;
  description?: string;
  locale?: string;
  logo?: string;
  allow_indexing?: boolean;
  analytics_provider?: string;
  analytics_id?: string;
};

export type SiteSnapshot = {
  nodes: PublishedNode[];
  site: SiteMeta;
  /** Slugs of the tag pages (`/site/tag/<slug>/`) the design shows. */
  tagSlugs: string[];
  /** Each tag page by slug: its name and the ids of the notes on it (a tag's own feed lists those). */
  tagPages: Record<string, { name: string; ids: string[] }>;
  /** Old addresses of pages served now → their current one (`site_redirects`, GAP-240). */
  redirects: Array<{ from: string; to: string }>;
  /** The workspace clock the site's days are cut on (lib/localDate dateIdAt). */
  timeZone?: string;
  dayStartHour?: number;
};

const API_BASE =
  process.env.SSR_API_URL ?? import.meta.env.PUBLIC_API_BASE_URL ?? "http://localhost:8787";

/** Fetch the published snapshot; null when the API is unreachable or empty. */
export async function fetchSiteSnapshot(): Promise<SiteSnapshot | null> {
  try {
    const res = await fetch(`${API_BASE}/api/site`);
    if (!res.ok) return null;
    const snapshot = await res.json();
    const payload = (snapshot?.payload ?? {}) as Record<string, unknown>;
    const presentation = (payload.presentation ?? {}) as Record<string, unknown>;
    const frozen = ((presentation.design ?? {}) as { tag_pages?: Record<string, { slug?: string; name?: string; rows?: Array<{ id?: string }> }> }).tag_pages ?? {};
    const tagPages = Object.values(frozen).flatMap((page) =>
      typeof page.slug === "string" ? [[page.slug, { name: page.name ?? page.slug, ids: (page.rows ?? []).flatMap((r) => (typeof r.id === "string" ? [r.id] : [])) }] as const] : []);
    return {
      nodes: (payload.nodes ?? []) as PublishedNode[],
      site: (presentation.site ?? {}) as SiteMeta,
      timeZone: typeof presentation.time_zone === "string" ? presentation.time_zone : undefined,
      dayStartHour: typeof presentation.day_start_hour === "number" ? presentation.day_start_hour : undefined,
      tagSlugs: tagPages.map(([slug]) => slug),
      tagPages: Object.fromEntries(tagPages),
      redirects: [...siteRedirectsOf(payload.site_redirects)].map(([from, to]) => ({ from, to })),
    };
  } catch {
    return null;
  }
}

/** An RSS item's description: the note's one summary rule (D37,
 *  @onden/markdown noteSummary) — frontmatter `description:` first, never the
 *  frontmatter itself, never the title line again. */
export function feedSummary(node: Pick<PublishedNode, "markdown" | "title">): string {
  return noteSummary(node.markdown ?? "", { title: node.title, maxLen: 280 });
}

/** Published nodes newest-first by updated_at (missing dates sink to the end). */
export function sortByUpdatedDesc(nodes: PublishedNode[]): PublishedNode[] {
  return [...nodes].sort(byUpdatedDesc);
}

/** The server's answer to an anonymous HEAD for `/api/media/<id>`: its size when
 *  readers may fetch it, null when they may not (or the server is unreachable —
 *  then the file is left out of the feed rather than assumed public). The
 *  server's read gate (canReadMedia) stays the one judge; its HEAD answer opens
 *  no file (routes/media.ts). */
export async function headSiteMedia(id: string): Promise<{ length: number | null } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/media/${encodeURIComponent(id)}`, { method: "HEAD" });
    if (!res.ok) return null;
    const length = Number(res.headers.get("content-length"));
    return { length: Number.isFinite(length) && length > 0 ? length : null };
  } catch {
    return null;
  }
}
