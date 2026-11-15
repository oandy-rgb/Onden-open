// RSS 2.0 feed of one tag's published notes — what the tag page's 「只訂閱這個標籤」 links to.
// Same items as the site feed, narrowed to the notes on the tag page.
export const prerender = false;

import type { APIRoute } from "astro";
import { loadAllEnhancers } from "@onden/markdown";
import { fetchSiteSnapshot } from "../../../../lib/siteFeed";
import { feedResponse } from "../../_feedResponse";
import { publicOrigin } from "../../../../lib/siteOrigin";

export const GET: APIRoute = async ({ request, params }) => {
  const snapshot = await fetchSiteSnapshot();
  if (!snapshot) return new Response("Site unavailable", { status: 503 });
  let slug = params.slug ?? "";
  try { slug = decodeURIComponent(slug); } catch { /* keep the raw segment */ }
  const page = snapshot.tagPages[slug];
  if (!page) return new Response("Not found", { status: 404 });
  await loadAllEnhancers();
  const ids = new Set(page.ids);
  return feedResponse({
    snapshot, origin: publicOrigin(new URL(request.url)), nodes: snapshot.nodes.filter((n) => ids.has(n.id)),
    tag: { name: page.name, path: `/site/tag/${slug}/` },
  });
};
