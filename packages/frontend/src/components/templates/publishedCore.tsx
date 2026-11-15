// Types and pure helpers the published pages (components/siteFrame, the feed)
// share: a published note's shape and the chrome/navigation facts.
import type { PublishedNode } from "../../lib/publishedNode";
export type { PublishedNode };
import { anchorHref, headingAnchors, linkSlug, mediaSrc } from "@onden/markdown";
import { documentBaseUrl } from "../../lib/documentAccess";
import { windowGlobal } from "../../lib/pageEnvironment";

export type PublishedEdge = {
  source_node_id: string;
  target_node_id: string;
  edge_type: "knowledge_link" | "suggested_link" | "nav_link";
};

export type SiteChrome = {
  brand?: string;
  tagline?: string;
  locale?: string;
  /** Optional brand-logo image URL shown in the nav instead of the brand text. */
  logo?: string;
  nav?: Array<string | { label: string; nodeId: string }>;
};

/** One line of a page's table of contents: a level-2 or -3 heading, its
 *  anchor id and the link to it — the id the renderer puts on the heading,
 *  as the sanitizer prefixes it. */
type TocEntry = { id: string; href: string; text: string; level: 2 | 3 };

/** The page's ## and ### headings (@onden/markdown headingAnchors: none in
 *  code, Unicode ids, duplicates numbered). Empty for a note over
 *  BLOCK_PARSE_MAX, where the headings are not read: no TOC is shown. */
export function extractTOC(markdown: string): TocEntry[] {
  return headingAnchors(markdown)
    .filter((a) => a.depth === 2 || a.depth === 3)
    .map((a) => ({ id: a.id, href: anchorHref(a.id), text: a.text, level: a.depth as 2 | 3 }));
}

export function resolveNavItem(
  item: string | { label: string; nodeId: string },
  nodes: PublishedNode[],
): { label: string; node: PublishedNode | null } {
  if (typeof item === "string") {
    const node =
      nodes.find((n) => n.title.trim().toLowerCase() === item.trim().toLowerCase()) ??
      // A nav label is plain text, not a link body: no `|` alias or `#` anchor.
      (item.trim() ? nodes.find((n) => n.slug === linkSlug(item)) : undefined) ??
      null;
    return { label: item, node };
  }
  const node = item.nodeId ? (nodes.find((n) => n.id === item.nodeId) ?? null) : null;
  const label = item.label || node?.title || "";
  return { label, node };
}

/** A media value on the published site (@onden/markdown mediaSrc). A
 *  self-contained bundle has its figures copied next to the page under
 *  media/<file> (backend pagesPush); they resolve against the page so they
 *  work under a Pages project subpath instead of hitting the origin's
 *  /api/media/* (which 404s on a static host). */
export function resolveMediaSrc(src: string): string {
  return mediaSrc(src, {
    apiBase: windowGlobal<string>("__API_BASE__") ?? "",
    bundle: documentBaseUrl(),
  });
}
