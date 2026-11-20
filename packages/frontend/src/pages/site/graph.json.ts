// The note graph of the published site (the notes on it and the links between them):
// what the graph on an article page draws. Read from the same served snapshot as the pages,
// so a note taken down is not in it; dynamic like the pages, and listed in the static copy
// (static-pages.json) so a copy has it too.
export const prerender = false;

import type { APIRoute } from "astro";
import { siteGraph } from "../../components/siteFrame";
import { loadSite } from "./_siteLoad";

export const GET: APIRoute = async () => {
  const loaded = await loadSite();
  if (loaded.kind !== "ok") return new Response("Site unavailable", { status: 503 });
  return Response.json(siteGraph(loaded.data));
};
