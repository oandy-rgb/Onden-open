// RSS 2.0 feed for the published site — newest 50 published notes, each with
// its full text (content:encoded) as the article page draws it.
// Dynamic (SSR) because the snapshot and the serving host are only known at
// request time; advertised from SiteHead via <link rel="alternate">.
export const prerender = false;

import type { APIRoute } from "astro";
import { loadAllEnhancers } from "@onden/markdown";
import { fetchSiteSnapshot } from "../../lib/siteFeed";
import { feedResponse } from "./_feedResponse";
import { publicOrigin } from "../../lib/siteOrigin";

export const GET: APIRoute = async ({ request }) => {
  const snapshot = await fetchSiteSnapshot();
  if (!snapshot) return new Response("Site unavailable", { status: 503 });
  await loadAllEnhancers(); // the note renderer's code colouring and math, loaded before a server render
  // The public address (APP_URL), not the proxied request's: the links must work for a reader.
  return feedResponse({ snapshot, origin: publicOrigin(new URL(request.url)), nodes: snapshot.nodes });
};
