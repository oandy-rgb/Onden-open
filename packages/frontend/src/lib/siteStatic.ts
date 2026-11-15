// The static copy of the site (zip download, GitHub Pages): the backend asks
// this server for each page and saves the HTML it gets
// (backend modules/website/publishing/staticSite.ts). The page list lives here so the
// live pages and the copy cannot drift. The pages are the same in both: nothing
// is marked "static".

import type { SiteSnapshot } from "./siteFeed";

/** Every page of the site, as paths (`/site/`, `/site/<slug>/`,
 *  `/site/tag/<slug>/`) — the notes and tag pages the pages themselves serve. */
export function sitePagePaths(snapshot: Pick<SiteSnapshot, "nodes" | "tagSlugs">): string[] {
  return [
    "/site/",
    ...snapshot.nodes.map((n) => `/site/${n.slug}/`),
    ...snapshot.tagSlugs.map((slug) => `/site/tag/${slug}/`),
  ];
}
