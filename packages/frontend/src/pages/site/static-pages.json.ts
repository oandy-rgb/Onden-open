// The list of pages the static copy saves (lib/siteStatic.ts sitePagePaths),
// read from the same snapshot the pages themselves render, with the site facts
// the copy's own files need: its canonical address, robots.txt, and the
// analytics host its CSP lets through.
export const prerender = false;

import type { APIRoute } from "astro";
import { fetchSiteSnapshot } from "../../lib/siteFeed";
import { publicOrigin } from "../../lib/siteOrigin";
import { sitePagePaths } from "../../lib/siteStatic";

export const GET: APIRoute = async ({ request }) => {
  const snapshot = await fetchSiteSnapshot();
  if (!snapshot) return new Response("Site unavailable", { status: 503 });
  return Response.json({
    pages: sitePagePaths(snapshot),
    // The tag pages' own feeds: files, not pages, so the copy saves them next to the site feed.
    // And the note graph (graph.json): the graph on an article page reads it from next to the site.
    feeds: [...snapshot.tagSlugs.map((slug) => `/site/tag/${slug}/feed.xml`), "/site/graph.json"],
    // Old addresses of renamed pages: the copy saves a page at each that sends the reader on (GAP-240).
    redirects: snapshot.redirects,
    origin: publicOrigin(new URL(request.url)),
    analytics: { provider: snapshot.site.analytics_provider, id: snapshot.site.analytics_id },
    allowIndexing: snapshot.site.allow_indexing !== false,
  });
};
